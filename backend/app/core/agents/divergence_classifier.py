"""Classify a what-if divergence into a structured world_state.

Runs once at debate start. Produces a small JSON describing which characters
are dead/empowered/weakened in the alt-history, plus a one-line anchor that
Boru uses in his opening narration. Character agents read their own status
so that (e.g.) a character killed in the divergence speaks from recollection
instead of planning "next winter".
"""
import json
import re
import logging

from langchain_core.messages import HumanMessage

from app.config import get_analysis_llm

logger = logging.getLogger(__name__)


_EMPTY_STATE = {
    "dead": [],
    "empowered": [],
    "weakened": [],
    "anchor": "",
}


def _extract_json(text: str) -> dict | None:
    text = (text or "").strip()
    # Strip common fencing
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    # Take the first {...} block
    m = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


def _sanitize(raw: dict, char_names: list[str]) -> dict:
    """Keep only names that are actually in the cast; normalize fields."""
    cast = {n.lower(): n for n in char_names}

    def _match(names):
        out = []
        for name in (names or []):
            if not isinstance(name, str):
                continue
            canonical = cast.get(name.strip().lower())
            if canonical and canonical not in out:
                out.append(canonical)
        return out

    anchor = str(raw.get("anchor") or "").strip()
    if len(anchor) > 220:
        anchor = anchor[:217].rstrip() + "…"

    return {
        "dead": _match(raw.get("dead")),
        "empowered": _match(raw.get("empowered")),
        "weakened": _match(raw.get("weakened")),
        "anchor": anchor,
    }


async def classify_divergence_world_state(
    story_title: str,
    divergence: str,
    char_names: list[str],
) -> dict:
    """Return {dead, empowered, weakened, anchor}. Empty lists on failure."""
    if not divergence or not char_names:
        return dict(_EMPTY_STATE)

    prompt = f"""You are classifying the initial world state implied by a what-if divergence for a story debate.

STORY: "{story_title}"
CAST: {', '.join(char_names)}
DIVERGENCE: "{divergence}"

Read the divergence literally. If the scenario says a character is killed, they are dead.
If it says a character takes power, they are empowered. If it says they are
exiled / deposed / broken, they are weakened.

Return STRICT JSON only (no prose, no markdown) with these keys:
{{
  "dead": [names killed or removed by the divergence],
  "empowered": [names who gain power or control],
  "weakened": [names who lose power, are exiled, or neutralized],
  "anchor": "one short sentence (<= 20 words) stating the resulting situation the Sabha is discussing"
}}

Rules:
- Only use names from the CAST list above. Case-sensitive.
- If the divergence does not clearly imply any state change for someone, omit them.
- Do NOT invent outcomes the divergence doesn't state.
- The anchor sentence must be plain, factual, present-tense. No questions, no commentary.

Examples:

DIVERGENCE: "What if Snowball comes back with his own dogs and kills Napoleon?"
→ {{"dead": ["Napoleon"], "empowered": ["Snowball"], "weakened": [], "anchor": "Napoleon lies dead. Snowball holds the farm with outside dogs at his side."}}

DIVERGENCE: "What if Boxer refuses to go to the knacker's van?"
→ {{"dead": [], "empowered": [], "weakened": ["Napoleon"], "anchor": "Boxer is alive and has defied the pigs' betrayal."}}

DIVERGENCE: "What if Old Major lived ten more years?"
→ {{"dead": [], "empowered": ["Old Major"], "weakened": [], "anchor": "Old Major is still alive and still teaching."}}

Now produce the JSON for the current divergence.
"""

    try:
        llm = get_analysis_llm()
        raw = await llm.ainvoke([HumanMessage(content=prompt)])
        parsed = _extract_json(raw.content)
        if not parsed:
            logger.warning("divergence classifier: could not parse JSON, falling back to empty state")
            return dict(_EMPTY_STATE)
        return _sanitize(parsed, char_names)
    except Exception as e:
        logger.warning(f"divergence classifier failed: {e}")
        return dict(_EMPTY_STATE)


def status_for(character_name: str, world_state: dict | None) -> str | None:
    """Return 'dead' / 'empowered' / 'weakened' / None for this character."""
    if not world_state:
        return None
    name = character_name
    if name in (world_state.get("dead") or []):
        return "dead"
    if name in (world_state.get("empowered") or []):
        return "empowered"
    if name in (world_state.get("weakened") or []):
        return "weakened"
    return None
