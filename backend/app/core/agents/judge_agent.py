import json
import re
from app.config import get_judge_llm


async def judge_response(
    character_name: str,
    character_description: str,
    personality_traits: list,
    response_text: str,
) -> dict:
    """
    Evaluate whether a character's response is faithful to their established character.
    Returns score (1-10) and feedback.
    """
    llm = get_judge_llm()

    prompt = f"""You are evaluating character fidelity in a story debate.

CHARACTER: {character_name}
DESCRIPTION: {character_description}
PERSONALITY TRAITS: {', '.join(personality_traits)}

RESPONSE TO EVALUATE:
"{response_text}"

Score this response from 1-10 on how well it matches the character's established personality.
10 = perfectly in character
1 = completely out of character

Return JSON only:
{{
  "score": <number 1-10>,
  "in_character": <true/false>,
  "feedback": "<one sentence explaining the score>",
  "issue": "<specific out-of-character element if score < 6, else null>"
}}"""

    result = await llm.ainvoke(prompt)
    raw = result.content
    if isinstance(raw, list):
        raw = "".join(
            part.get("text", "") if isinstance(part, dict) else str(part)
            for part in raw
        )
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\n?", "", raw)
    raw = re.sub(r"\n?```$", "", raw)

    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # If parsing fails, accept the response
        return {"score": 7, "in_character": True, "feedback": "Parse error, accepted.", "issue": None}


async def should_regenerate(judge_result: dict, threshold: int = 5) -> bool:
    """Regenerate the response if score is below threshold."""
    return judge_result.get("score", 10) < threshold
