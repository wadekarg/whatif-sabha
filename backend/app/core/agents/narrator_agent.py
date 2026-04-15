import json
import re
from app.config import get_narrator_fallbacks, get_analysis_llm, _is_rate_limit


async def synthesize_ending(
    story_title: str,
    original_summary: str,
    divergence_description: str,
    debate_transcript: list,
) -> str:
    """
    Read the full debate and synthesize a coherent alternate ending as prose.
    """
    llm = get_narrator_llm()

    transcript_text = "\n".join(
        f"{entry['character']}: {entry['message']}"
        for entry in debate_transcript
    )

    prompt = f"""You are the narrator of "{story_title}".

ORIGINAL STORY SUMMARY:
{original_summary}

THE ALTERNATE SCENARIO BEING EXPLORED:
{divergence_description}

THE CHARACTERS DEBATED AND REACHED THESE CONCLUSIONS:
{transcript_text}

Now write the alternate ending as a rich, detailed story passage (900-1200 words).

REQUIREMENTS:
- Write in the same tone and style as the original story — match its voice exactly
- Begin from the moment of divergence and trace consequences forward in time
- Show what each major character specifically argued for and how that shaped the outcome
- Include at least 3 concrete events or turning points that follow from this alternate scenario
- Show how relationships between characters change — who gains, who loses, who is transformed
- Let the world feel different: what is life like now, for those who remain?
- End with a closing image or moment that carries the weight of what was changed
- Write as narrative prose with scenes, not as a list or dialogue transcript

THE ALTERNATE ENDING:"""

    response = await llm.ainvoke(prompt)
    return response.content.strip()


async def synthesize_ending_stream(
    story_title: str,
    original_summary: str,
    divergence_description: str,
    debate_transcript: list,
    ledger=None,
):
    """Stream the alternate ending token by token, with model fallbacks."""
    # Build debate insights — what the characters revealed about themselves
    # that should shape the alternate ending
    char_entries = [
        e for e in debate_transcript
        if not e.get("isOrchestrator") and not e.get("isReaction")
        and not e.get("isStageDirection") and not e.get("isAudience")
    ]

    # Extract the most powerful character moments (last 20 entries)
    character_voices = ""
    for entry in char_entries[-20:]:
        msg = entry["message"][:250].strip()
        if msg:
            character_voices += f"  {entry['character']}: \"{msg}\"\n"

    # Extract character positions from ledger if available
    positions_text = ""
    if ledger and ledger.character_positions:
        positions_text = "\n".join(
            f"  {name}: {pos}" for name, pos in ledger.character_positions.items()
        )

    prompt = f"""You are the author of "{story_title}". You are writing an alternate version of your own story.

THE ORIGINAL STORY:
{original_summary}

THE MOMENT EVERYTHING CHANGES:
{divergence_description}

During a debate, your characters revealed who they truly are — their fears, desires, contradictions, and hidden truths. Use these revelations as the raw material for your alternate ending:

WHAT YOUR CHARACTERS REVEALED:
{character_voices}
{f"WHERE EACH CHARACTER STANDS:{chr(10)}{positions_text}" if positions_text else ""}

Now write the ALTERNATE ENDING — the story of what happens in this changed world.

CRITICAL: You are NOT retelling the debate. The debate was characters ARGUING about what would happen.
Now YOU, the author, show what ACTUALLY happens. Write the events, the scenes, the consequences.
The characters don't know they were in a debate. They are living this alternate life.

RULES:
- Start at the divergence moment. Show the scene — a specific place, time, sensory detail.
- Write EVENTS that happen, not characters discussing what might happen.
  BAD: "Snowball stood and said 'I would have built a windmill that...'"
  GOOD: "By autumn, the windmill stood half-finished. Snowball paced the foundation each morning..."
- Show time passing — days, seasons, years. The story spans the whole alternate timeline.
- Every character's fate must follow from the divergence. Use their hidden motivations from the debate to drive their choices, but show it through ACTION, not speech.
- Include at least 3 turning points where things shift in unexpected ways.
- End with a single powerful closing image — a moment frozen in time that captures what this world became.
- 900-1200 words. Pure narrative prose. No headers, no lists, no meta-commentary.

THE ALTERNATE ENDING:"""

    fallbacks = get_narrator_fallbacks(temperature=0.75)
    if not fallbacks:
        raise ValueError("No narrator LLM available — check your Groq API key.")

    last_exc = None
    for llm, label in fallbacks:
        try:
            async for chunk in llm.astream(prompt):
                if chunk.content:
                    yield chunk.content
            return  # success — done
        except Exception as e:
            if _is_rate_limit(e):
                last_exc = e
                continue  # try next model
            raise
    raise last_exc


async def synthesize_debate_summary_stream(
    story_title: str,
    divergence_description: str,
    debate_transcript: list,
    ledger=None,
):
    """Stream a structured summary of the debate — what was argued, who said what, key moments."""
    char_entries = [
        e for e in debate_transcript
        if not e.get("isOrchestrator") and not e.get("isReaction")
        and not e.get("isStageDirection") and not e.get("isAudience")
    ]

    # Character voices — sample across the debate (beginning, middle, end)
    total = len(char_entries)
    sample_indices = set()
    if total <= 20:
        sample_indices = set(range(total))
    else:
        # First 5, middle 5, last 10
        sample_indices = set(range(5)) | set(range(total // 2 - 2, total // 2 + 3)) | set(range(total - 10, total))
    sampled = [char_entries[i] for i in sorted(sample_indices) if i < total]

    character_voices = "\n".join(
        f"  {entry['character']}: \"{entry['message'][:200].strip()}\""
        for entry in sampled
    )

    positions_text = ""
    if ledger and ledger.character_positions:
        positions_text = "\nFINAL POSITIONS:\n" + "\n".join(
            f"  {name}: {pos}" for name, pos in ledger.character_positions.items()
        )

    prompt = f"""You are summarizing a WhatIfSabha debate about "{story_title}".

THE QUESTION DEBATED:
"{divergence_description}"

KEY MOMENTS FROM THE DEBATE ({len(char_entries)} total exchanges):
{character_voices}
{positions_text}

Write a compelling summary of this debate (400-600 words). Structure it as:

1. THE QUESTION — What was at stake? Why does this what-if matter?
2. THE ARGUMENTS — Who argued what? What were the strongest positions? Where did characters clash most fiercely?
3. KEY MOMENTS — The 2-3 most powerful exchanges. Quote brief fragments that capture the intensity. (Use "..." to abbreviate.)
4. WHAT EMERGED — What truth or insight surfaced that nobody expected? What remains unresolved?

Write with energy and voice — this should read like a journalist covering a heated parliamentary debate, not like a dry transcript. Name the characters. Show the tension. Make the reader feel they missed something extraordinary.

THE DEBATE SUMMARY:"""

    fallbacks = get_narrator_fallbacks(temperature=0.6)
    if not fallbacks:
        raise ValueError("No narrator LLM available.")

    last_exc = None
    for llm, label in fallbacks:
        try:
            async for chunk in llm.astream(prompt):
                if chunk.content:
                    yield chunk.content
            return
        except Exception as e:
            if _is_rate_limit(e):
                last_exc = e
                continue
            raise
    if last_exc:
        raise last_exc


async def generate_alternate_timeline(
    story_title: str,
    divergence_description: str,
    alternate_ending: str,
) -> list:
    """
    Extract a structured timeline of key events from the alternate ending.
    Returns a list of event dicts: {label, description, characters, type}
    type: "divergence" | "turning_point" | "consequence" | "resolution"
    """
    llm = get_analysis_llm()

    prompt = f"""You are analyzing the alternate ending of "{story_title}".

THE WHAT-IF SCENARIO (divergence point):
{divergence_description}

THE ALTERNATE ENDING THAT WAS WRITTEN:
{alternate_ending}

Extract the 4-7 most important events that happen in this alternate timeline, starting from the divergence point.
Return ONLY valid JSON — a list of event objects:

[
  {{
    "label": "Short event title (3-6 words)",
    "description": "One sentence describing what happens and why it matters",
    "characters": ["Name1", "Name2"],
    "type": "divergence"
  }},
  {{
    "label": "...",
    "description": "...",
    "characters": ["..."],
    "type": "turning_point"
  }}
]

Types: "divergence" (the what-if moment, always first), "turning_point" (major shift), "consequence" (result of earlier events), "resolution" (how things end).
Be specific to THIS story. First event must be the divergence itself."""

    response = await llm.ainvoke(prompt)
    raw = response.content
    if isinstance(raw, list):
        raw = "".join(part.get("text", "") if isinstance(part, dict) else str(part) for part in raw)

    raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
    raw = re.sub(r"\n?```$", "", raw.strip())

    try:
        events = json.loads(raw)
        return events if isinstance(events, list) else []
    except json.JSONDecodeError:
        return []
