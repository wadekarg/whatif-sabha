import asyncio
from typing import List, Optional, Callable

from app.core.character_research.wikipedia_fetcher import fetch_wikipedia
from app.core.character_research.web_scraper import search_character_analysis
from app.core.character_research.perspective_agents import get_all_perspectives
from app.core.character_research.bias_reconciler import reconcile_perspectives


async def research_character(character: dict, story_title: str, log_fn: Optional[Callable] = None) -> dict:
    """
    Full research pipeline for a single character.
    Hard timeout of 180 seconds — returns partial results if slower.
    """
    try:
        return await asyncio.wait_for(
            _research_character_inner(character, story_title, log_fn=log_fn),
            timeout=180.0,
        )
    except asyncio.TimeoutError:
        msg = f"⚠️ {character['name']}: research timed out — continuing without Fair Witness"
        print(msg)
        if log_fn:
            try:
                await log_fn(msg)
            except Exception:
                pass
        return {**character, "fair_witness": None, "research_sources": {"timeout": True}}
    except Exception as e:
        msg = f"⚠️ {character['name']}: research failed — {type(e).__name__}"
        print(msg)
        if log_fn:
            try:
                await log_fn(msg)
            except Exception:
                pass
        return {**character, "fair_witness": None, "research_sources": {}}


async def _research_character_inner(character: dict, story_title: str, log_fn: Optional[Callable] = None) -> dict:
    name = character["name"]
    print(f"  Researching: {name}")
    if log_fn:
        await log_fn(f"🔍 Researching {name}...")

    # Phase 1: Parallel research — Wikipedia + web, each with their own timeout
    wiki_task = asyncio.wait_for(fetch_wikipedia(name, story_title), timeout=12.0)
    web_task  = asyncio.wait_for(search_character_analysis(name, story_title), timeout=25.0)

    wiki_data, web_data = await asyncio.gather(wiki_task, web_task, return_exceptions=True)

    if isinstance(wiki_data, Exception):
        print(f"    Wikipedia failed for {name}: {type(wiki_data).__name__}")
        wiki_data = None
    if isinstance(web_data, Exception):
        print(f"    Web failed for {name}: {type(web_data).__name__}")
        web_data = []

    if log_fn:
        if wiki_data and wiki_data.get("found"):
            await log_fn(f"  📚 {name}: Wikipedia — {wiki_data.get('page_title', 'found')}")
        else:
            await log_fn(f"  📚 {name}: No Wikipedia article found")
        web_count = len(web_data) if isinstance(web_data, list) else 0
        if web_count:
            await log_fn(f"  🌐 {name}: {web_count} web source{'s' if web_count != 1 else ''} found")

    external_context = _build_external_context(wiki_data, web_data)

    if log_fn:
        await log_fn(f"  🤖 {name}: Getting perspectives from Gemini · Groq · Cerebras · NVIDIA...")

    # Phase 2: LLM perspectives — each has 30s internal timeout, 60s outer budget
    perspectives = await asyncio.wait_for(
        get_all_perspectives(character, story_title, external_context),
        timeout=60.0,
    )

    models_used = list(perspectives.keys())
    if log_fn:
        await log_fn(f"  🤖 {name}: {len(models_used)} perspectives received ({', '.join(models_used)})")
        await log_fn(f"  ✨ {name}: Synthesising Fair Witness profile...")

    # Phase 3: Synthesis — 75s to cover multi-provider fallback (25s × up to 3 tries)
    fair_witness = await asyncio.wait_for(
        reconcile_perspectives(
            character=character,
            story_title=story_title,
            wikipedia_data=wiki_data,
            web_analysis=web_data if isinstance(web_data, list) else [],
            llm_perspectives=perspectives,
        ),
        timeout=75.0,
    )

    fair_role = fair_witness.get("fair_role", "")
    print(f"  Done: {name} — fair_role: {fair_role}")
    if log_fn:
        await log_fn(f"  ✅ {name}: Fair Witness complete — {fair_role}")

    return {
        **character,
        "fair_witness": fair_witness,
        "research_sources": {
            "wikipedia_found": bool(wiki_data and wiki_data.get("found")),
            "web_sources_found": len(web_data) if isinstance(web_data, list) else 0,
            "llm_perspectives": models_used,
        },
    }


def _qualifies_for_fair_witness(character: dict) -> bool:
    """
    Fair Witness research is expensive (Wikipedia + web + 4 LLMs + synthesis).
    Only run it on characters that genuinely matter. Skip:
      - importance < 0.3 (enrichment-derived)
      - mention_count present and < 5 (Pass 1 signal)
      - role == "minor" AND importance < 0.5
    """
    importance = character.get("importance")
    if isinstance(importance, (int, float)) and importance < 0.3:
        return False

    mention_count = character.get("mention_count")
    if isinstance(mention_count, int) and 0 < mention_count < 5:
        return False

    role = (character.get("role") or "").lower()
    if role == "minor":
        imp = importance if isinstance(importance, (int, float)) else 0.0
        if imp < 0.5:
            return False

    return True


async def research_all_characters(
    characters: List[dict],
    story_title: str,
    max_concurrent: int = 2,
    log_fn: Optional[Callable] = None,
) -> List[dict]:
    """
    Research all characters with controlled concurrency.
    max_concurrent=2 avoids hammering APIs simultaneously.

    Skips Fair Witness for low-signal characters — they keep their enrichment
    profile but get fair_witness=None. This avoids burning 60+s per classical
    allusion or bit-part that slipped through Pass 1.
    """
    semaphore = asyncio.Semaphore(max_concurrent)

    # Partition: qualifying characters get full research, others pass through
    qualifying = []
    skipped = []
    for char in characters:
        if _qualifies_for_fair_witness(char):
            qualifying.append(char)
        else:
            skipped.append(char)

    if log_fn and skipped:
        preview = ", ".join(c["name"] for c in skipped[:8]) + ("…" if len(skipped) > 8 else "")
        await log_fn(
            f"⏭️ Skipping Fair Witness for {len(skipped)} low-signal character"
            f"{'s' if len(skipped) != 1 else ''} ({preview})"
        )

    async def research_with_semaphore(character):
        async with semaphore:
            try:
                return await research_character(character, story_title, log_fn=log_fn)
            except Exception as e:
                print(f"  Research failed for {character['name']}: {e}")
                return {**character, "fair_witness": None, "research_sources": {}}

    tasks = [research_with_semaphore(char) for char in qualifying]
    researched = await asyncio.gather(*tasks)

    # Skipped characters get a passthrough with fair_witness=None
    passthrough = [
        {**char, "fair_witness": None, "research_sources": {"skipped": "low_signal"}}
        for char in skipped
    ]

    # Preserve original ordering
    by_name = {c["name"]: c for c in list(researched) + passthrough}
    return [by_name[c["name"]] for c in characters if c["name"] in by_name]


def _build_external_context(wiki_data: dict | None, web_data: list) -> str:
    """Combine external sources into a single context string for LLM perspectives."""
    parts = []

    if wiki_data and wiki_data.get("found"):
        summary = wiki_data.get("summary", "")
        extract = wiki_data.get("full_extract", "")
        if summary:
            parts.append(f"Wikipedia: {summary[:600]}")
        if extract:
            parts.append(f"Wikipedia Analysis Sections: {extract[:600]}")

    if isinstance(web_data, list):
        for i, source in enumerate(web_data[:2]):
            content = source.get("content", "")[:400]
            if content:
                parts.append(f"Web Source {i+1} ({source.get('title', '')}): {content}")

    return "\n\n".join(parts) if parts else ""
