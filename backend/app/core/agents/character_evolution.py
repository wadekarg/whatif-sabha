"""
Character Evolution — RL-inspired objective drift.

After every debate, we run a "goal inference" pass over the transcript to infer
what each character was actually optimizing for — not what they said, but what
their behavior reveals.

This produces an objective_vector per character:
  {
    "power":        0.8,   # how much they fight to control outcomes
    "validation":   0.3,   # how much they need to be agreed with
    "legacy":       0.6,   # how much they care about being remembered
    "safety":       0.2,   # how much they protect what they love
    "coherence":    0.5,   # how much they resist contradicting past self
    "recognition":  0.7,   # how much they need to be seen for who they are
  }

These weights drift slowly across debates. Over 3-5 debates, characters become
more themselves — or crack under accumulated pressure.

The drift also updates hidden_dimensions — the character's unspoken truths —
as new dimensions are inferred from debate behavior.

This is stored in soul memory (Graphiti) so it persists across debates.
Characters accumulate a genuine psychological history.
"""

import json
import logging
import re
import asyncio
from typing import Callable

logger = logging.getLogger(__name__)

OBJECTIVE_AXES = ["power", "validation", "legacy", "safety", "coherence", "recognition"]

EVOLUTION_PROMPT = """You are analyzing how a character behaved in a debate to infer their TRUE objectives.

CHARACTER: {name}
DEBATE TOPIC: {divergence}

THEIR TURNS IN THIS DEBATE:
{character_turns}

WHAT OTHERS SAID TO THEM / ABOUT THEM:
{other_turns}

Analyze their behavior carefully. Characters often say one thing but act toward a different goal.

Return a JSON object:
{{
  "objective_vector": {{
    "power": 0.0-1.0,
    "validation": 0.0-1.0,
    "legacy": 0.0-1.0,
    "safety": 0.0-1.0,
    "coherence": 0.0-1.0,
    "recognition": 0.0-1.0
  }},
  "dominant_objective": "power|validation|legacy|safety|coherence|recognition",
  "objective_drift_reason": "one sentence: what in this debate revealed this?",
  "new_hidden_dimension": "a new unspoken truth this debate revealed about them, or null if nothing new emerged",
  "crack_point": "if they showed any sign of self-doubt or contradiction with their stated position, describe it. null if none.",
  "policy_success": true/false
}}

Definitions:
- power: fights to control the outcome, directs others, resists being told what to do
- validation: needs agreement, gets defensive when challenged, softens when praised
- legacy: references history, cares about being remembered, wants to matter
- safety: protects specific people/things, avoids risks, deflects when core attachments threatened
- coherence: repeats past positions, gets upset at contradictions, highly consistent
- recognition: wants to be seen for who they truly are, not how others label them

Return ONLY valid JSON. No markdown."""


DRIFT_RATE = 0.15  # How fast objective vector shifts per debate (0.0 = frozen, 1.0 = instant)


def _blend_vectors(old: dict, new: dict, rate: float = DRIFT_RATE) -> dict:
    """Slowly drift old vector toward new inferred vector."""
    result = {}
    for axis in OBJECTIVE_AXES:
        old_val = old.get(axis, 0.5)
        new_val = new.get(axis, 0.5)
        result[axis] = round(old_val + rate * (new_val - old_val), 3)
    return result


async def infer_character_objectives(
    character_name: str,
    transcript: list[dict],
    divergence: str,
    llm,
) -> dict | None:
    """
    Run goal inference on a character's behavior in this debate.
    Returns inferred objective_vector + metadata, or None on failure.
    """
    from langchain_core.messages import HumanMessage

    char_turns = [
        f"[Round {e.get('round', '?')}] {e['message']}"
        for e in transcript
        if e.get("character") == character_name
    ]
    other_turns = [
        f"{e['character']}: {e['message'][:200]}"
        for e in transcript
        if e.get("character") != character_name and not e.get("isObserver")
    ]

    if not char_turns:
        return None

    prompt = EVOLUTION_PROMPT.format(
        name=character_name,
        divergence=divergence[:200],
        character_turns="\n\n".join(char_turns[-8:]),   # last 8 turns
        other_turns="\n\n".join(other_turns[-10:]),
    )

    try:
        response = await llm.ainvoke([HumanMessage(content=prompt)])
        raw = response.content
        if isinstance(raw, list):
            raw = "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in raw)
        raw = re.sub(r"^```(?:json)?\n?", "", raw.strip())
        raw = re.sub(r"\n?```$", "", raw.strip())
        return json.loads(raw)
    except Exception as e:
        logger.warning(f"Evolution inference failed for {character_name}: {e}")
        return None


async def evolve_characters_after_debate(
    story_id: str,
    debate_id: str,
    transcript: list[dict],
    characters: list[dict],
    divergence: str,
    log_fn: Callable | None = None,
) -> dict[str, dict]:
    """
    Run evolution pass after a debate completes.
    Saves objective drift to both soul memory AND story.analysis in DB
    so characters carry their evolved state into the next debate.
    Runs in background — non-blocking for the debate stream.
    """
    from app.config import _make_nvidia_llm, get_analysis_llm

    llm = _make_nvidia_llm("meta/llama-3.3-70b-instruct", temperature=0.1)
    if llm is None:
        llm = get_analysis_llm()

    semaphore = asyncio.Semaphore(3)
    results = {}

    async def evolve_one(char: dict):
        name = char["name"]
        async with semaphore:
            inferred = await infer_character_objectives(name, transcript, divergence, llm)
            if not inferred:
                return

            new_vec = inferred.get("objective_vector", {})
            old_vec = char.get("objective_vector", {a: 0.5 for a in OBJECTIVE_AXES})
            drifted = _blend_vectors(old_vec, new_vec)

            # Accumulate new hidden dimension if one emerged
            new_dim = inferred.get("new_hidden_dimension")
            updated_dims = list(char.get("hidden_dimensions") or [])
            if new_dim and new_dim not in updated_dims:
                updated_dims.append(new_dim)

            evolution_record = {
                "debate_id": debate_id,
                "objective_vector": drifted,
                "dominant_objective": inferred.get("dominant_objective"),
                "drift_reason": inferred.get("objective_drift_reason"),
                "new_hidden_dimension": new_dim,
                "crack_point": inferred.get("crack_point"),
                "policy_success": inferred.get("policy_success"),
            }
            results[name] = evolution_record

            # Write drifted vector + new hidden dimensions back to story DB
            # so the character dict is live for the next debate
            await _persist_evolution_to_db(
                story_id=story_id,
                character_name=name,
                objective_vector=drifted,
                hidden_dimensions=updated_dims,
            )

            # Also save to Graphiti soul memory for semantic recall
            await _save_evolution_to_memory(
                story_id=story_id,
                character_name=name,
                evolution=evolution_record,
                divergence=divergence,
            )

            if log_fn:
                dominant = inferred.get("dominant_objective", "?")
                crack = inferred.get("crack_point")
                msg = f"🧬 {name} — dominant drive: {dominant}"
                if crack:
                    msg += f" · crack: {crack[:60]}..."
                await log_fn(msg)

    await asyncio.gather(*[evolve_one(c) for c in characters])
    return results


async def _persist_evolution_to_db(
    story_id: str,
    character_name: str,
    objective_vector: dict,
    hidden_dimensions: list[str],
) -> None:
    """
    Write evolved objective_vector and hidden_dimensions back into
    story.analysis["characters"] in the DB so it's live for the next debate.
    """
    try:
        from app.db.database import get_session_maker
        from app.models.story import Story
        from sqlalchemy import select
        from sqlalchemy.orm.attributes import flag_modified
        import copy

        session_maker = get_session_maker()
        async with session_maker() as db:
            story = (await db.execute(
                select(Story).where(Story.id == story_id)
            )).scalar_one_or_none()
            if not story or not story.analysis:
                return

            analysis = copy.deepcopy(story.analysis)
            characters = analysis.get("characters", [])
            for char in characters:
                if char.get("name") == character_name:
                    char["objective_vector"] = objective_vector
                    char["hidden_dimensions"] = hidden_dimensions
                    break

            story.analysis = analysis
            flag_modified(story, "analysis")
            await db.commit()

    except Exception as e:
        logger.warning(f"Evolution DB persist failed for {character_name} (non-fatal): {e}")


async def _save_evolution_to_memory(
    story_id: str,
    character_name: str,
    evolution: dict,
    divergence: str,
) -> None:
    """Persist evolution record to Graphiti soul memory."""
    from app.core.memory import save_debate_turn

    dominant = evolution.get("dominant_objective", "unknown")
    drift = evolution.get("drift_reason", "")
    crack = evolution.get("crack_point")
    new_dim = evolution.get("new_hidden_dimension")

    episode = f"[CHARACTER EVOLUTION]\n"
    episode += f"Dominant objective revealed: {dominant}\n"
    if drift:
        episode += f"Why: {drift}\n"
    if crack:
        episode += f"Crack point: {crack}\n"
    if new_dim:
        episode += f"New hidden truth: {new_dim}\n"
    vec = evolution.get("objective_vector", {})
    if vec:
        top = sorted(vec.items(), key=lambda x: x[1], reverse=True)[:3]
        episode += f"Objective weights: {', '.join(f'{k}={v}' for k, v in top)}"

    try:
        await save_debate_turn(
            story_id=story_id,
            character_name=character_name,
            message=episode,
            debate_id=evolution.get("debate_id", "evolution"),
            round_number=0,
            divergence=divergence,
        )
    except Exception as e:
        logger.debug(f"Evolution memory save failed (non-fatal): {e}")


def get_objective_hint(character: dict) -> str | None:
    """
    Generate an exploration hint from a character's evolved objective vector.
    Used during debates to surface their true drive naturally.
    """
    vec = character.get("objective_vector")
    if not vec:
        return None

    top_axis = max(vec, key=vec.get)
    top_val = vec[top_axis]

    if top_val < 0.6:
        return None  # Not strong enough to surface

    hints = {
        "power": "You are acutely aware — in a way you'd never admit — that what you actually want is to be in control. Not right. Not fair. In control.",
        "validation": "Beneath everything you say, what you most need is for someone in this room to agree with you. To confirm you are not wrong.",
        "legacy": "You are aware, somewhere deep, that this debate will be remembered. What matters to you is what history will say about your position here.",
        "safety": "What drives you most is protecting something — or someone — that you have never named aloud in this debate.",
        "recognition": "More than winning, you want to be seen for who you actually are — not the role you play, not the label they give you.",
        "coherence": "You feel a quiet dread of contradicting what you have said before. Your consistency is your identity. Losing it would be losing yourself.",
    }
    return hints.get(top_axis)
