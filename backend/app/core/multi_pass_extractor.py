"""
Dynamic multi-pass story extractor.

Automatically scales extraction depth based on story size:

  SMALL  (< 60K words)  → 1 pass: full text → Gemini → complete JSON
  MEDIUM (60K–400K)     → 2 passes: chunk extract → RAG enrich per character
  LARGE  (> 400K words) → 3 passes: chunk extract → alias merge → RAG enrich

Pass 1 is always exhaustive — every chunk is seen at least once.
Pass 2+ are RAG-powered — targeted retrieval per character.
ChromaDB index is built before enrichment and shared with debate-time retrieval.
"""

import asyncio
import json
import logging
import re
from typing import Callable

logger = logging.getLogger(__name__)

# Thresholds (words, not tokens — multiply by ~1.3 for rough token estimate)
# Single-pass is only viable for very short texts (short stories, novellas < 10K words)
# Even Animal Farm (30K) hits Gemini output token ceiling with the full ANALYSIS_PROMPT
SMALL_STORY_THRESHOLD  = 10_000   # < 10K words → single pass
LARGE_STORY_THRESHOLD  = 400_000  # > 400K words → three passes

# Chunk size for Pass 1 extraction (words). Targets ~12K tokens per LLM call.
EXTRACTION_CHUNK_WORDS = 9_000

# Max chunks to process in parallel (avoid rate limits)
EXTRACTION_CONCURRENCY = 6
ENRICHMENT_CONCURRENCY = 4


# ── Strategy selector ────────────────────────────────────────────────────────

def determine_strategy(word_count: int) -> dict:
    """
    Return the extraction strategy for a story of this size.
    'passes' is the number of LLM passes needed beyond chunking+embedding.
    """
    if word_count < SMALL_STORY_THRESHOLD:
        return {
            "name": "single_pass",
            "passes": 1,
            "description": f"Small story ({word_count:,} words) — full text in one Gemini call",
        }
    elif word_count < LARGE_STORY_THRESHOLD:
        return {
            "name": "two_pass",
            "passes": 2,
            "description": f"Medium story ({word_count:,} words) — chunk extraction + RAG enrichment",
        }
    else:
        return {
            "name": "three_pass",
            "passes": 3,
            "description": f"Large story ({word_count:,} words) — chunk extraction + alias merge + RAG enrichment",
        }


# ── Pass 1: Per-chunk character name extraction ───────────────────────────────

CHUNK_EXTRACT_PROMPT = """You are analyzing a passage from a story to find its CAST — people who are actually present and active in the narrative.

List ONLY named characters who, in this passage, do AT LEAST ONE of the following:
  - speak (have dialogue, direct or reported)
  - perform an action in the scene
  - are directly addressed or interact with another character who is present
  - are described as physically present in the scene

DO NOT list names that are merely:
  - mentioned as classical, mythological, historical, or literary allusions (e.g. a character saying "like Caesar did" — Caesar is NOT a character unless Caesar is actually in the scene)
  - referenced in dedications, prefaces, footnotes, editorial notes, title pages, or author bios
  - invoked as metaphors, comparisons, or rhetorical references
  - personifications of abstract concepts (Fortune, Death, Love, etc.) unless they actually appear and act
  - names in lists, catalogs, genealogies, or cast-of-characters pages where they do nothing
  - generic roles with no name (First Soldier, A Messenger, Gentleman) — skip unless they clearly have a distinct arc

When uncertain whether a name is a real cast member versus an allusion, LEAVE IT OUT. It is far better to miss a minor character than to include a mythological reference.

Return a JSON array of objects:
[
  {{"name": "Character Name", "role": "protagonist|antagonist|supporting|minor", "brief": "one sentence about what they do in this passage"}}
]

If no qualifying characters appear, return an empty array: []
Return ONLY valid JSON. No markdown."""


# Generic / narrative-role names that are almost always noise — filter even if LLM includes them
GENERIC_NAME_BLOCKLIST = {
    "king", "queen", "prince", "princess", "lord", "lady", "duke", "duchess",
    "gentleman", "gentlewoman", "messenger", "servant", "soldier", "attendant",
    "player", "player king", "player queen", "prologue", "chorus", "narrator",
    "first", "second", "third", "boy", "girl", "man", "woman",
    "fortune", "death", "love", "fate", "time", "nature",
}


async def _extract_names_from_chunk(chunk: dict, llm) -> list[dict]:
    """Extract character names from a single chunk. Returns list of {name, role, brief}."""
    from langchain_core.messages import HumanMessage
    try:
        prompt = CHUNK_EXTRACT_PROMPT + f"\n\nPASSAGE:\n{chunk['text'][:8000]}"
        response = await llm.ainvoke([HumanMessage(content=prompt)])
        raw = response.content
        if isinstance(raw, list):
            raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        result = json.loads(raw)
        return result if isinstance(result, list) else []
    except Exception as e:
        logger.warning(f"Chunk extraction failed for {chunk.get('chunk_id')}: {e}")
        return []


def _count_mentions(name: str, full_text: str) -> int:
    """Count case-insensitive word-boundary mentions of a name in the full text."""
    if not name or not full_text:
        return 0
    pattern = r"\b" + re.escape(name) + r"\b"
    return len(re.findall(pattern, full_text, flags=re.IGNORECASE))


async def extract_all_character_names(
    chunks: list[dict],
    llm,
    log_fn: Callable = None,
    full_text: str = "",
) -> list[dict]:
    """
    Pass 1: run extraction on all chunks in parallel batches.
    Returns deduplicated list of {name, role, brief, chunk_hits, mention_count}.

    Filters out probable noise:
      - names appearing in only 1 chunk AND fewer than 3 total mentions (allusions)
      - generic role words (King, Queen, Messenger, Fortune, etc.)
    """
    semaphore = asyncio.Semaphore(EXTRACTION_CONCURRENCY)

    async def bounded_extract(chunk):
        async with semaphore:
            return await _extract_names_from_chunk(chunk, llm)

    if log_fn:
        await log_fn(f"🔍 Pass 1: scanning {len(chunks)} chunks for characters...")

    results = await asyncio.gather(*[bounded_extract(c) for c in chunks])

    # Merge, dedupe, and track how many distinct chunks each character appears in.
    role_priority = {"protagonist": 4, "antagonist": 3, "supporting": 2, "minor": 1}
    seen: dict[str, dict] = {}
    for chunk_idx, chunk_result in enumerate(results):
        for char in chunk_result:
            name = char.get("name", "").strip()
            if not name:
                continue
            key = name.lower()
            if key not in seen:
                entry = dict(char)
                entry["name"] = name
                entry["chunk_hits"] = {chunk_idx}
                seen[key] = entry
            else:
                seen[key]["chunk_hits"].add(chunk_idx)
                existing_priority = role_priority.get(seen[key].get("role", "minor"), 1)
                new_priority = role_priority.get(char.get("role", "minor"), 1)
                if new_priority > existing_priority:
                    seen[key]["role"] = char["role"]

    raw_count = len(seen)

    # Filter: blocklist + low-signal names (1 chunk hit AND < 3 total mentions in full text)
    filtered: list[dict] = []
    rejected: list[str] = []
    for key, entry in seen.items():
        name = entry["name"]
        chunk_hits = len(entry.pop("chunk_hits", set()))
        mention_count = _count_mentions(name, full_text) if full_text else chunk_hits
        entry["mention_count"] = mention_count

        if name.strip().lower() in GENERIC_NAME_BLOCKLIST:
            rejected.append(f"{name} (generic)")
            continue
        if chunk_hits <= 1 and mention_count < 3:
            rejected.append(f"{name} (chunk_hits={chunk_hits}, mentions={mention_count})")
            continue

        filtered.append(entry)

    if log_fn:
        if rejected:
            preview = ", ".join(rejected[:8]) + ("…" if len(rejected) > 8 else "")
            await log_fn(f"🧹 Pass 1 filter: dropped {len(rejected)} low-signal names ({preview})")
        await log_fn(f"🔍 Pass 1 complete: {len(filtered)} unique characters (from {raw_count} raw)")

    return filtered


# ── Pass 2 (large stories only): Alias resolution ─────────────────────────────

ALIAS_MERGE_PROMPT = """You are resolving character aliases in a story.

The following characters were extracted from the text. Some may be the same person
referred to by different names (e.g. "Arjuna" and "Partha" are the same character).

CHARACTER LIST:
{character_list}

STORY TITLE: {title}

Return a JSON array where each entry is a group of aliases for the same character:
[
  {{
    "canonical_name": "The most common/primary name",
    "aliases": ["OtherName1", "OtherName2"],
    "role": "protagonist|antagonist|supporting|minor"
  }}
]

If a character has no aliases, still include them with an empty aliases list.
Return ONLY valid JSON. No markdown."""


def _dedupe_characters(characters: list[dict]) -> list[dict]:
    """Case-insensitive dedupe by name, merging aliases and preserving highest-priority role."""
    role_priority = {"protagonist": 4, "antagonist": 3, "supporting": 2, "minor": 1}
    seen: dict[str, dict] = {}
    order: list[str] = []
    for c in characters:
        name = (c.get("name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key not in seen:
            entry = dict(c)
            entry["name"] = name
            entry["aliases"] = list(dict.fromkeys(entry.get("aliases") or []))
            seen[key] = entry
            order.append(key)
        else:
            existing = seen[key]
            # Merge aliases
            merged_aliases = list(dict.fromkeys(
                (existing.get("aliases") or []) + (c.get("aliases") or [])
            ))
            existing["aliases"] = merged_aliases
            # Upgrade role
            ep = role_priority.get(existing.get("role", "minor"), 1)
            np = role_priority.get(c.get("role", "minor"), 1)
            if np > ep:
                existing["role"] = c["role"]
            # Prefer longer brief
            if len(c.get("brief") or "") > len(existing.get("brief") or ""):
                existing["brief"] = c["brief"]
            # Keep max mention_count
            existing["mention_count"] = max(
                existing.get("mention_count", 0) or 0,
                c.get("mention_count", 0) or 0,
            )
    return [seen[k] for k in order]


async def resolve_aliases(
    characters: list[dict],
    title: str,
    llm=None,
    log_fn: Callable = None,
) -> list[dict]:
    """
    Pass 2 (large stories): merge alias names into canonical characters.
    e.g. Arjuna/Partha/Dhananjaya → one character with aliases list.

    Uses invoke_analysis_with_fallback so Gemini rate limits don't kill the stage.
    Always returns a deduped list, even on failure.
    """
    if log_fn:
        await log_fn(f"🔗 Pass 2: resolving aliases across {len(characters)} names...")

    from langchain_core.messages import HumanMessage
    from app.config import invoke_analysis_with_fallback

    char_lines = "\n".join(f"- {c['name']} ({c.get('role','?')}): {c.get('brief','')}" for c in characters)
    prompt = ALIAS_MERGE_PROMPT.format(character_list=char_lines, title=title)

    raw = ""
    try:
        raw = await asyncio.wait_for(
            invoke_analysis_with_fallback([HumanMessage(content=prompt)]),
            timeout=60.0,
        )
    except asyncio.TimeoutError:
        logger.warning("Alias resolution timed out across all providers")
    except Exception as e:
        logger.warning(f"Alias resolution errored: {e!r}")

    if not raw:
        if log_fn:
            await log_fn(f"⚠️ Alias resolution failed — deduping {len(characters)} names by exact match")
        return _dedupe_characters(characters)

    try:
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        merged = json.loads(raw)
        assert isinstance(merged, list)

        # Build a lookup from original characters so we preserve mention counts/briefs
        by_name = {c["name"].lower(): c for c in characters}

        result = []
        for entry in merged:
            canonical = (entry.get("canonical_name") or "").strip()
            if not canonical:
                continue
            aliases = [a for a in (entry.get("aliases") or []) if a and a.lower() != canonical.lower()]
            # Pull mention_count from canonical or best-matching alias
            cand_keys = [canonical.lower()] + [a.lower() for a in aliases]
            source = next((by_name[k] for k in cand_keys if k in by_name), None)
            mention_count = max(
                [by_name[k].get("mention_count", 0) or 0 for k in cand_keys if k in by_name] or [0]
            )
            result.append({
                "name": canonical,
                "role": entry.get("role", source.get("role", "supporting") if source else "supporting"),
                "aliases": aliases,
                "brief": (source.get("brief", "") if source else ""),
                "mention_count": mention_count,
            })

        result = _dedupe_characters(result)
        if log_fn:
            await log_fn(f"🔗 Pass 2 complete: {len(result)} canonical characters (aliases resolved)")
        return result

    except Exception as e:
        logger.warning(f"Alias resolution parse failed: {e!r} — deduping by exact match")
        if log_fn:
            await log_fn(f"⚠️ Alias resolution parse failed — deduping {len(characters)} names by exact match")
        return _dedupe_characters(characters)


# ── Final pass: Per-character RAG enrichment ─────────────────────────────────

CHARACTER_ENRICH_PROMPT = """You are building a detailed character profile for a story.

CHARACTER: {name}
STORY TITLE: {title}
ROLE: {role}
ALIASES (other names this character is known by): {aliases}

STORY TIMELINE PHASES:
{timeline_phases_text}

RELEVANT PASSAGES FROM THE STORY:
{passages}

Build a complete character profile. For "phases", create one entry per timeline phase above — using the exact same phase_id. Each phase should capture how this character's emotional state, motivations, and fears evolve through that part of the story. If the character barely appears in a phase, still include it with what can be inferred.

Return a JSON object:
{{
  "name": "{name}",
  "role": "{role}",
  "description": "2-3 sentence description of who this character is",
  "importance": 0.0-1.0,
  "aliases": {aliases_json},
  "hidden_dimensions": [
    "A plausible but unconfirmed inner truth — something the text strongly implies but never states",
    "A secret belief, doubt, or fear they would never publicly admit",
    "Something they carry that shapes everything they do",
    "A surprising sympathy or vulnerability that contradicts their public face",
    "A private desire or dream no one in the story knows about"
  ],
  "phases": [
    {{
      "phase_id": "exact_phase_id_from_timeline",
      "personality_traits": ["trait1", "trait2", "trait3"],
      "knowledge_state": {{}},
      "motivations": ["their driving motivation in this phase"],
      "fears": ["their fear in this phase"],
      "emotional_state": "their specific emotional state during this phase of the story",
      "internal_voice": "how they think and speak — their distinctive voice",
      "relationships": {{
        "OtherCharacter": {{
          "type": "ally|rival|friend|enemy|neutral|exploits|fears",
          "trust": 0.5,
          "description": "nature of relationship"
        }}
      }}
    }}
  ]
}}

Be specific to what the passages reveal. Ensure phases reflect genuine change across the story arc, not the same state repeated.
Return ONLY valid JSON. No markdown."""


ENRICHMENT_TIMEOUT = 60.0  # seconds per character enrichment call


async def _enrich_character(
    char: dict,
    story_id: str,
    title: str,
    llm,
    timeline_phases: list = None,
    n_chunks: int = 8,
    fallback_llm=None,
) -> dict:
    """
    Final pass: retrieve relevant passages for this character from ChromaDB,
    then build full profile via LLM.
    """
    from app.core.rag.retriever import retrieve_chunks
    from langchain_core.messages import HumanMessage

    name = char["name"]
    aliases = char.get("aliases", [])

    # Build a rich query — include aliases so embeddings retrieve alias-mentions too
    alias_str = " ".join(aliases) if aliases else ""
    query = f"{name} {alias_str} character motivations fears relationships actions"

    try:
        chunks = retrieve_chunks(story_id, query, n_results=n_chunks)
        passages = "\n\n---\n\n".join(c["text"] for c in chunks) if chunks else "(no passages found)"
    except Exception:
        passages = "(retrieval unavailable)"

    aliases_json = json.dumps(aliases)

    # Build timeline phases text for the prompt
    phases = timeline_phases or []
    if phases:
        timeline_phases_text = "\n".join(
            f"- phase_id: \"{p.get('phase_id', f'phase_{i+1}')}\" | {p.get('name', '')} | {p.get('description', '')}"
            for i, p in enumerate(phases)
        )
    else:
        timeline_phases_text = "No timeline phases available — use a single phase_id: \"main\""

    prompt = CHARACTER_ENRICH_PROMPT.format(
        name=name,
        title=title,
        role=char.get("role", "supporting"),
        aliases=", ".join(aliases) if aliases else "none",
        aliases_json=aliases_json,
        timeline_phases_text=timeline_phases_text,
        passages=passages[:12000],  # cap at ~12K chars
    )

    async def _call(target_llm):
        response = await asyncio.wait_for(
            target_llm.ainvoke([HumanMessage(content=prompt)]),
            timeout=ENRICHMENT_TIMEOUT,
        )
        raw_ = response.content
        if isinstance(raw_, list):
            raw_ = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw_)
        raw_ = re.sub(r"^```(?:json)?\n?", "", raw_.strip())
        raw_ = re.sub(r"\n?```$", "", raw_.strip())
        return json.loads(raw_)

    try:
        return await _call(llm)
    except (asyncio.TimeoutError, Exception) as e:
        logger.warning(f"Primary enrichment failed for {name}: {e!r} — trying fallback")
        if fallback_llm is not None and fallback_llm is not llm:
            try:
                return await _call(fallback_llm)
            except Exception as e2:
                logger.warning(f"Fallback enrichment failed for {name}: {e2!r} — using minimal profile")
        else:
            logger.warning(f"Enrichment failed for {name}: {e!r} — using minimal profile")
        fallback_phases = [
            {
                "phase_id": p.get("phase_id", f"phase_{i+1}"),
                "personality_traits": [],
                "knowledge_state": {},
                "motivations": [],
                "fears": [],
                "emotional_state": "unknown",
                "internal_voice": f"Speaks as {name}.",
                "relationships": {},
            }
            for i, p in enumerate(timeline_phases or [])
        ] or [{
            "phase_id": "main",
            "personality_traits": [],
            "knowledge_state": {},
            "motivations": [],
            "fears": [],
            "emotional_state": "unknown",
            "internal_voice": f"Speaks as {name}.",
            "relationships": {},
        }]
        return {
            "name": name,
            "role": char.get("role", "supporting"),
            "description": char.get("brief", f"{name} is a character in {title}."),
            "importance": 0.3,
            "aliases": aliases,
            "hidden_dimensions": [],
            "phases": fallback_phases,
        }


async def enrich_all_characters(
    characters: list[dict],
    story_id: str,
    title: str,
    llm,
    log_fn: Callable = None,
    timeline_phases: list = None,
    fallback_llm=None,
) -> list[dict]:
    """
    Final pass: enrich all characters in parallel using RAG retrieval.
    """
    semaphore = asyncio.Semaphore(ENRICHMENT_CONCURRENCY)

    async def bounded_enrich(char):
        async with semaphore:
            result = await _enrich_character(
                char, story_id, title, llm,
                timeline_phases=timeline_phases,
                fallback_llm=fallback_llm,
            )
            if log_fn:
                await log_fn(f"✅ Enriched: {char['name']}")
            return result

    if log_fn:
        await log_fn(f"🧬 Final pass: enriching {len(characters)} characters via RAG...")

    enriched = await asyncio.gather(*[bounded_enrich(c) for c in characters])

    if log_fn:
        await log_fn(f"🧬 Enrichment complete: {len(enriched)} characters fully profiled")

    return list(enriched)


# ── Orchestrator ──────────────────────────────────────────────────────────────

async def multi_pass_extract(
    full_text: str,
    story_id: str,
    title: str,
    word_count: int,
    log_fn: Callable = None,
    existing_characters: list[dict] | None = None,
    timeline_phases: list | None = None,
) -> list[dict]:
    """
    Main entry point. Determines strategy based on word count and runs the
    appropriate number of passes. Returns enriched character list.

    Always builds ChromaDB index first (used by enrichment + debate retrieval).
    """
    from app.core.rag.chunker import chunk_by_chapter, chunk_text
    from app.core.rag.embedder import embed_chunks
    from app.config import get_analysis_llm, _make_nvidia_llm
    from app.config import get_settings

    strategy = determine_strategy(word_count)

    if log_fn:
        await log_fn(f"📐 Strategy: {strategy['description']}")

    # ── Step 0: Chunk + embed into ChromaDB (all strategies) ──────────────────
    if log_fn:
        await log_fn("🏗️ Building semantic search index (ChromaDB)...")

    chunks = chunk_by_chapter(full_text)
    # If chapters are very large, sub-chunk them
    final_chunks = []
    for ch in chunks:
        if ch["word_count"] > EXTRACTION_CHUNK_WORDS * 1.5:
            sub = chunk_text(ch["text"], chunk_size=EXTRACTION_CHUNK_WORDS, overlap=200)
            for i, s in enumerate(sub):
                s["chunk_id"] = f"{ch['chunk_id']}_sub{i}"
                s["timeline_position"] = ch["timeline_position"] + (i / max(len(sub), 1)) * 0.01
            final_chunks.extend(sub)
        else:
            final_chunks.append(ch)

    embed_chunks(story_id, final_chunks)

    if log_fn:
        await log_fn(f"🏗️ Indexed {len(final_chunks)} chunks into ChromaDB")

    # ── Strategy: single pass (small story) ───────────────────────────────────
    if strategy["name"] == "single_pass":
        # Characters already extracted in upload.py via analyze_story — reuse them
        if existing_characters is not None:
            if log_fn:
                await log_fn(f"✅ Single pass: reusing {len(existing_characters)} characters from structure analysis")
            return existing_characters
        # Fallback: extract fresh if not provided
        if log_fn:
            await log_fn("🔬 Single pass: sending full text to Gemini for analysis...")
        from app.core.story_analyzer import analyze_story
        analysis = await analyze_story(full_text)
        return analysis.get("characters", [])

    # ── Pass 1: Extract character names from every chunk ──────────────────────
    # Use a fast model for extraction — NVIDIA or Gemini Flash
    s = get_settings()
    extract_llm = _make_nvidia_llm("meta/llama-3.3-70b-instruct", temperature=0.1)
    if extract_llm is None:
        extract_llm = get_analysis_llm()

    raw_characters = await extract_all_character_names(
        final_chunks, extract_llm, log_fn, full_text=full_text,
    )

    # ── Pass 2: Alias resolution (all multi-pass stories) ─────────────────────
    # Runs for both two_pass and three_pass — catches duplicates like Napoleon/Comrade Napoleon
    raw_characters = await resolve_aliases(raw_characters, title, llm=None, log_fn=log_fn)

    # Safety dedupe in case alias resolution is skipped or returns dupes
    raw_characters = _dedupe_characters(raw_characters)

    # ── Final pass: Per-character RAG enrichment ──────────────────────────────
    # Use NVIDIA for enrichment — parallel calls, good at character profiles.
    # Fall back to a smaller/faster NVIDIA model, then Gemini, when the 253B model
    # times out or rate-limits (it often does on free tier).
    enrich_llm = _make_nvidia_llm("nvidia/llama-3.1-nemotron-ultra-253b-v1", temperature=0.2)
    enrich_fallback = _make_nvidia_llm("meta/llama-3.3-70b-instruct", temperature=0.2)
    if enrich_llm is None:
        enrich_llm = enrich_fallback or get_analysis_llm()
        enrich_fallback = get_analysis_llm() if enrich_fallback is None else enrich_fallback
    elif enrich_fallback is None:
        enrich_fallback = get_analysis_llm()

    enriched = await enrich_all_characters(
        raw_characters, story_id, title, enrich_llm, log_fn,
        timeline_phases=timeline_phases,
        fallback_llm=enrich_fallback,
    )

    # Final safety dedupe — enrichment may emit a different "name" field than input
    # (e.g. LLM normalizes "Ophelia." to "Ophelia"), reintroducing duplicates.
    before = len(enriched)
    enriched = _dedupe_characters(enriched)
    if log_fn and len(enriched) < before:
        await log_fn(f"🧹 Final dedupe: collapsed {before - len(enriched)} duplicate(s)")

    return enriched
