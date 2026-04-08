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
):
    """Stream the alternate ending token by token, with model fallbacks."""
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

Write the alternate ending as a rich, detailed story passage (900-1200 words).

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

    fallbacks = get_narrator_fallbacks(temperature=0.6)
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
