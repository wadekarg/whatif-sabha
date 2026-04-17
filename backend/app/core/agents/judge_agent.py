import json
import re
from app.config import get_judge_fallbacks, _is_rate_limit


async def _invoke_judge(prompt: str) -> str:
    """Try each judge model in priority order; fall back on rate-limit errors."""
    fallbacks = get_judge_fallbacks()
    if not fallbacks:
        raise ValueError("No judge LLM available — check your Groq API key.")
    last_exc = None
    for llm, label in fallbacks:
        try:
            result = await llm.ainvoke(prompt)
            raw = result.content
            if isinstance(raw, list):
                raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
            return raw.strip()
        except Exception as e:
            if _is_rate_limit(e):
                last_exc = e
                continue  # try next model
            raise  # unexpected error — don't swallow
    raise last_exc


async def judge_response(
    character_name: str,
    character_description: str,
    personality_traits: list,
    response_text: str,
    previous_message: str = "",
    previous_speaker: str = "",
    was_directly_addressed: bool = False,
) -> dict:
    """
    Evaluate a character's response for:
    1. Character fidelity — did they speak as themselves?
    2. Completeness — were they under burden to explain and did they?
    """
    context_block = ""
    if previous_speaker and previous_message:
        addressed_note = " They were spoken to directly." if was_directly_addressed else ""
        context_block = f"""
WHAT TRIGGERED THIS RESPONSE:
{previous_speaker} said: "{previous_message[:300]}"{"..." if len(previous_message) > 300 else ""}{addressed_note}
"""

    prompt = f"""You are evaluating a character's response in a live story debate.

CHARACTER: {character_name}
DESCRIPTION: {character_description}
PERSONALITY TRAITS: {', '.join(personality_traits)}
{context_block}
RESPONSE TO EVALUATE:
"{response_text}"

Evaluate THREE things:

1. CHARACTER FIDELITY (score 1–10):
   Does this response match who this character genuinely is?
   10 = perfectly in character. 1 = completely wrong voice/behaviour.

2. COMPLETENESS — needs_continuation:
   Was this character under real burden to explain or defend themselves,
   and did they leave that burden genuinely unmet?

   Grant needs_continuation = true ONLY when ALL of these are true:
   - They were directly accused, questioned, or cornered about something significant
   - Their response deflected, was cut short, or left the core accusation unanswered
   - They clearly have more they NEED to say — not just more they could say
   - A short response IS complete if it's appropriately terse — do not penalise brevity

3. WHO IS THIS CHARACTER ADDRESSING?
   Read the response carefully. Identify ALL characters being addressed.
   Look for: direct name mentions, @ mentions, "you" directed at someone, questions asked to someone specific.
   Return a list of all addressed characters, ordered by prominence (primary first).
   If addressing multiple people, include them all: ["Boxer", "Napoleon"]
   If making a general statement to no one specific, use empty list: []

Return JSON only:
{{
  "score": <1-10>,
  "in_character": <true/false>,
  "feedback": "<one sentence>",
  "issue": "<specific out-of-character element if score < 6, else null>",
  "needs_continuation": <true/false>,
  "continuation_reason": "<one sentence on what burden is unmet, or null>",
  "dominant_emotion": "<one of: anger, cold_fury, contempt, grief, desperation, pride, guilt, shame, defiance, bitterness, jealousy, longing, righteous_indignation, humiliation, weariness, hope, betrayal, neutral>",
  "addressed_targets": ["<character names addressed, or [] if none>"],
  "primary_target": "<first address target (for backward compat), or null>"
}}"""

    raw = await _invoke_judge(prompt)
    raw = re.sub(r"^```(?:json)?\n?", "", raw)
    raw = re.sub(r"\n?```$", "", raw)

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"score": 7, "in_character": True, "feedback": "Parse error, accepted.", "issue": None, "needs_continuation": False, "continuation_reason": None, "dominant_emotion": "neutral", "addressed_targets": [], "primary_target": None}


async def should_regenerate(judge_result: dict, threshold: int = 5) -> bool:
    return judge_result.get("score", 10) < threshold
