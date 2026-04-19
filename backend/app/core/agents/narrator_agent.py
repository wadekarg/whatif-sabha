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
    """Stream a detailed debate report — who said what, how they clashed, what was resolved, what the future holds."""
    char_entries = [
        e for e in debate_transcript
        if not e.get("isOrchestrator") and not e.get("isReaction")
        and not e.get("isStageDirection") and not e.get("isAudience")
    ]

    # Broad sampling — first 6, every 2nd from middle, last 8
    total = len(char_entries)
    if total <= 30:
        sample_indices = set(range(total))
    else:
        mid_start, mid_end = 6, total - 8
        mid_indices = set(range(mid_start, mid_end, 2))
        sample_indices = set(range(6)) | mid_indices | set(range(total - 8, total))
    sampled = [char_entries[i] for i in sorted(sample_indices) if i < total]

    # 350 chars per message — enough to preserve the best lines
    character_voices = "\n".join(
        f"  [{i+1}/{total}] {entry['character']}: \"{entry['message'][:350].strip()}\""
        for i, entry in enumerate(sampled)
    )

    # Ledger data — claims, positions, questions
    ledger_text = ""
    if ledger:
        parts = []
        if ledger.character_positions:
            parts.append("FINAL POSITIONS:\n" + "\n".join(
                f"  {name}: {pos}" for name, pos in ledger.character_positions.items()
            ))
        if ledger.claims:
            parts.append("KEY CLAIMS MADE:\n" + "\n".join(
                f"  - {c.get('speaker', '?')}: {c.get('claim', '')[:150]}" for c in ledger.claims[-10:]
            ))
        resolved = ledger.resolved_questions[-5:] if ledger.resolved_questions else []
        open_qs = ledger.open_questions[:5] if ledger.open_questions else []
        if resolved:
            parts.append("QUESTIONS ANSWERED:\n" + "\n".join(
                f"  - \"{q.get('question', '')[:120]}\" (asked by {q.get('asked_by', '?')})" for q in resolved
            ))
        if open_qs:
            parts.append("QUESTIONS LEFT UNANSWERED:\n" + "\n".join(
                f"  - \"{q.get('question', '')[:120]}\" (asked by {q.get('asked_by', '?')})" for q in open_qs
            ))
        if ledger.disputes:
            unresolved_d = [d for d in ledger.disputes if d["status"] == "unresolved"]
            resolved_d = [d for d in ledger.disputes if d["status"] != "unresolved"]
            parts.append(f"DISPUTES: {len(ledger.disputes)} total — {len(resolved_d)} resolved, {len(unresolved_d)} unresolved")
            if unresolved_d:
                parts.append("UNRESOLVED DISPUTES:\n" + "\n".join(
                    f"  - {d['claim_a']['character']} vs {d['claim_b']['character']}: "
                    f"\"{d['claim_a']['claim'][:100]}\" vs \"{d['claim_b']['claim'][:100]}\""
                    for d in unresolved_d[:4]
                ))
        if ledger.progress_summary:
            parts.append(f"DEBATE ARC: {ledger.progress_summary}")
        ledger_text = "\n\n".join(parts)

    prompt = f"""You are writing a detailed report of a WhatIfSabha debate about "{story_title}".

THE QUESTION DEBATED:
"{divergence_description}"

THE FULL DEBATE ({total} character exchanges, sampled below):
{character_voices}

{ledger_text}

Write a DETAILED debate report (800-1200 words). Use this structure:

### The Question
What was at stake? Why does this what-if matter for these characters? Set the scene in 2-3 sentences.

### Opening Salvos
Who spoke first? What positions were staked out immediately? What surprised everyone? Name the characters, quote their sharpest lines (use "..." to abbreviate). Show the reader the first clash.

### The Central Fight
What was the debate's core tension? Who was on which side? Describe the 2-3 fiercest exchanges — not just what was argued, but HOW they fought. Who landed the hardest blow? Who cracked first? Quote the lines that made the room go quiet.

### The Turning Point
Was there a moment where something shifted — a confession, an admission, an unexpected alliance? Describe it in detail. What did it change about the rest of the debate?

### Questions Asked and Answered
List the major questions that were posed during the debate and who answered them. Be specific — name the asker, the answerer, and what the answer was.

### Questions Left Unanswered
What challenges went unmet? What warnings were ignored? These are the cracks in the debate — name them honestly.

### What the Future Looks Like
Based on everything that was argued — if this what-if came true, what would the world actually look like? Not utopia, not dystopia — the messy, specific, human (or animal) reality. What would the first year look like? The first crisis? Who would thrive, who would struggle? What new dangers would emerge that nobody in the debate foresaw?

WRITING STYLE:
- Write like a war correspondent who was IN the room, not a professor reading a transcript.
- Quote the characters directly — their best lines are the proof.
- Name every character you mention. No "one character said" — say WHO.
- Show the tension between speakers. The reader should feel the heat.
- Don't sanitize. If someone said something brutal, report it.
- The final section (the future) should feel vivid and real — specific days, specific choices, specific consequences.

THE DEBATE REPORT:"""

    fallbacks = get_narrator_fallbacks(temperature=0.7)
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
