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

CHUNK_EXTRACT_PROMPT = """You are analyzing a passage from a story.

List EVERY named character who appears or is mentioned in this passage.
Include even characters mentioned briefly in a single sentence.

Return a JSON array of objects:
[
  {{"name": "Character Name", "role": "protagonist|antagonist|supporting|minor", "brief": "one sentence about them"}}
]

If no named characters appear, return an empty array: []
Return ONLY valid JSON. No markdown."""


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


async def extract_all_character_names(
    chunks: list[dict],
    llm,
    log_fn: Callable = None,
) -> list[dict]:
    """
    Pass 1: run extraction on all chunks in parallel batches.
    Returns deduplicated list of {name, role, brief}.
    """
    semaphore = asyncio.Semaphore(EXTRACTION_CONCURRENCY)

    async def bounded_extract(chunk):
        async with semaphore:
            return await _extract_names_from_chunk(chunk, llm)

    if log_fn:
        await log_fn(f"🔍 Pass 1: scanning {len(chunks)} chunks for characters...")

    results = await asyncio.gather(*[bounded_extract(c) for c in chunks])

    # Merge and deduplicate by name (case-insensitive)
    seen: dict[str, dict] = {}
    for chunk_result in results:
        for char in chunk_result:
            name = char.get("name", "").strip()
            if not name:
                continue
            key = name.lower()
            if key not in seen:
                seen[key] = char
            else:
                # Upgrade role if we see a more important one
                role_priority = {"protagonist": 4, "antagonist": 3, "supporting": 2, "minor": 1}
                existing_priority = role_priority.get(seen[key].get("role", "minor"), 1)
                new_priority = role_priority.get(char.get("role", "minor"), 1)
                if new_priority > existing_priority:
                    seen[key]["role"] = char["role"]

    characters = list(seen.values())
    if log_fn:
        await log_fn(f"🔍 Pass 1 complete: {len(characters)} unique characters found")

    return characters


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


async def resolve_aliases(
    characters: list[dict],
    title: str,
    llm,
    log_fn: Callable = None,
) -> list[dict]:
    """
    Pass 2 (large stories): merge alias names into canonical characters.
    e.g. Arjuna/Partha/Dhananjaya → one character with aliases list.
    """
    if log_fn:
        await log_fn(f"🔗 Pass 2: resolving aliases across {len(characters)} names...")

    from langchain_core.messages import HumanMessage
    char_lines = "\n".join(f"- {c['name']} ({c.get('role','?')}): {c.get('brief','')}" for c in characters)
    prompt = ALIAS_MERGE_PROMPT.format(character_list=char_lines, title=title)

    try:
        response = await llm.ainvoke([HumanMessage(content=prompt)])
        raw = response.content
        if isinstance(raw, list):
            raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        merged = json.loads(raw)

        # Rebuild as flat character list using canonical names
        result = []
        for entry in merged:
            result.append({
                "name": entry["canonical_name"],
                "role": entry.get("role", "supporting"),
                "aliases": entry.get("aliases", []),
                "brief": next(
                    (c.get("brief", "") for c in characters
                     if c["name"].lower() == entry["canonical_name"].lower()),
                    ""
                ),
            })

        if log_fn:
            await log_fn(f"🔗 Pass 2 complete: {len(result)} canonical characters (aliases resolved)")
        return result

    except Exception as e:
        logger.warning(f"Alias resolution failed: {e} — using unmerged list")
        if log_fn:
            await log_fn(f"⚠️ Alias resolution failed — continuing with {len(characters)} names")
        return characters


# ── Final pass: Per-character RAG enrichment ─────────────────────────────────

CHARACTER_ENRICH_PROMPT = """You are building a detailed character profile for a story.

CHARACTER: {name}
STORY TITLE: {title}
ROLE: {role}
ALIASES (other names this character is known by): {aliases}

RELEVANT PASSAGES FROM THE STORY:
{passages}

Build a complete character profile. Return a JSON object:
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
      "phase_id": "main",
      "personality_traits": ["trait1", "trait2", "trait3"],
      "knowledge_state": {{}},
      "motivations": ["motivation1", "motivation2"],
      "fears": ["fear1"],
      "emotional_state": "their emotional state through the story",
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

Be specific to what the passages reveal. If passages are sparse, extrapolate from what little we know.
Return ONLY valid JSON. No markdown."""


async def _enrich_character(
    char: dict,
    story_id: str,
    title: str,
    llm,
    n_chunks: int = 8,
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
    prompt = CHARACTER_ENRICH_PROMPT.format(
        name=name,
        title=title,
        role=char.get("role", "supporting"),
        aliases=", ".join(aliases) if aliases else "none",
        aliases_json=aliases_json,
        passages=passages[:12000],  # cap at ~12K chars
    )

    try:
        response = await llm.ainvoke([HumanMessage(content=prompt)])
        raw = response.content
        if isinstance(raw, list):
            raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        enriched = json.loads(raw)
        return enriched
    except Exception as e:
        logger.warning(f"Enrichment failed for {name}: {e} — using minimal profile")
        return {
            "name": name,
            "role": char.get("role", "supporting"),
            "description": char.get("brief", f"{name} is a character in {title}."),
            "importance": 0.3,
            "aliases": aliases,
            "hidden_dimensions": [],
            "phases": [{
                "phase_id": "main",
                "personality_traits": [],
                "knowledge_state": {},
                "motivations": [],
                "fears": [],
                "emotional_state": "unknown",
                "internal_voice": f"Speaks as {name}.",
                "relationships": {},
            }],
        }


async def enrich_all_characters(
    characters: list[dict],
    story_id: str,
    title: str,
    llm,
    log_fn: Callable = None,
) -> list[dict]:
    """
    Final pass: enrich all characters in parallel using RAG retrieval.
    """
    semaphore = asyncio.Semaphore(ENRICHMENT_CONCURRENCY)

    async def bounded_enrich(char):
        async with semaphore:
            result = await _enrich_character(char, story_id, title, llm)
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

    raw_characters = await extract_all_character_names(final_chunks, extract_llm, log_fn)

    # ── Pass 2: Alias resolution (all multi-pass stories) ─────────────────────
    # Runs for both two_pass and three_pass — catches duplicates like Napoleon/Comrade Napoleon
    alias_llm = get_analysis_llm()  # Gemini — better at cross-cultural aliases
    raw_characters = await resolve_aliases(raw_characters, title, alias_llm, log_fn)

    # ── Final pass: Per-character RAG enrichment ──────────────────────────────
    # Use NVIDIA for enrichment — parallel calls, good at character profiles
    enrich_llm = _make_nvidia_llm("nvidia/llama-3.1-nemotron-ultra-253b-v1", temperature=0.2)
    if enrich_llm is None:
        enrich_llm = get_analysis_llm()

    enriched = await enrich_all_characters(raw_characters, story_id, title, enrich_llm, log_fn)

    return enriched
