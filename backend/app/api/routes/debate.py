import json
import uuid
import asyncio
import random
import logging

logger = logging.getLogger(__name__)
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

# Shared audience message queues per debate — {debate_id: asyncio.Queue}
_audience_queues: dict[str, asyncio.Queue] = {}

from app.db.database import get_db
from app.models.story import Story
from app.models.debate import Debate
from app.core.agents.character_agent import character_respond_stream, character_continue_stream
from app.core.agents.orchestrator import _detect_question_target
from app.core.agents.judge_agent import judge_response, should_regenerate
from app.core.agents.narrator_agent import synthesize_ending_stream, generate_alternate_timeline
from app.core.memory import recall_memories, save_debate_turn
from app.core.agents.world_observer_agent import (
    _select_observers,
    observer_respond_stream,
    should_invite_observer,
    _extract_question_target,
)
from app.core.agents.power_interrogator import (
    should_interrogate,
    interrogator_stream,
    extract_interrogation_target,
)
from app.core.agents.character_evolution import (
    evolve_characters_after_debate,
    get_objective_hint,
)
from app.core.agents.sabha_orchestrator import (
    ArgumentLedger, generate_orchestrator_message, update_ledger,
    decide_phase_transition, pick_next_speakers, should_end_debate,
    compute_drama_score as orch_drama_score, PHASES, PHASE_CONFIG,
    generate_reactions, generate_stage_direction,
    should_generate_reactions, should_add_stage_direction,
)
from app.config import get_model_pool, assign_models_to_characters, _is_rate_limit
from app.db.database import get_session_maker

router = APIRouter(prefix="/debates", tags=["debates"])


class DebateStartRequest(BaseModel):
    story_id: str
    divergence_description: str
    character_names: Optional[list[str]] = None  # None = use all characters
    max_rounds: int = 20
    character_exploration: Optional[dict[str, float]] = None  # {name: 0.0–1.0}, default 0.10


@router.post("")
async def start_debate(req: DebateStartRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Story).where(Story.id == req.story_id))
    story = result.scalar_one_or_none()

    if not story or story.status != "ready":
        raise HTTPException(status_code=400, detail="Story not ready for debate.")

    all_characters = story.analysis.get("characters", [])

    if req.character_names:
        characters = [
            c for c in all_characters
            if c["name"] in req.character_names
        ]
    else:
        characters = all_characters

    if len(characters) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 characters to debate.")

    # Clamp exploration rates to [0.0, 1.0] and default missing characters to 0.10
    exploration_map = {}
    for c in characters:
        name = c["name"]
        raw = (req.character_exploration or {}).get(name, 0.10)
        exploration_map[name] = max(0.0, min(1.0, float(raw)))

    debate = Debate(
        id=str(uuid.uuid4()),
        story_id=req.story_id,
        divergence_description=req.divergence_description,
        participating_characters=[c["name"] for c in characters],
        transcript=[],
        status="pending",
        character_exploration=exploration_map,
    )
    db.add(debate)
    await db.commit()

    return {
        "debate_id": debate.id,
        "characters": [c["name"] for c in characters],
        "status": "pending",
    }


class AudienceMessage(BaseModel):
    name: str  # audience member's chosen name
    message: str  # their question or comment
    directed_to: Optional[str] = None  # optional: specific character they're addressing


@router.post("/{debate_id}/audience")
async def audience_interjection(debate_id: str, body: AudienceMessage):
    """
    User sends a question/comment into a running debate.
    Boru will acknowledge it and route it to the right character(s).
    """
    if debate_id not in _audience_queues:
        _audience_queues[debate_id] = asyncio.Queue()

    await _audience_queues[debate_id].put({
        "name": body.name.strip() or "Someone in the audience",
        "message": body.message.strip(),
        "directed_to": body.directed_to,
    })
    return {"ok": True, "queued": True}


@router.get("/{debate_id}/stream")
async def stream_debate(debate_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()

    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")

    story_result = await db.execute(select(Story).where(Story.id == debate.story_id))
    story = story_result.scalar_one_or_none()

    return StreamingResponse(
        _run_debate_stream(debate_id, debate, story),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def _run_debate_stream(debate_id: str, debate: Debate, story: Story):
    """Core debate loop — orchestrator-driven, streams SSE events to the frontend."""
    session_maker = get_session_maker()

    all_characters = story.analysis.get("characters", [])
    participating = set(debate.participating_characters)
    characters = [c for c in all_characters if c["name"] in participating]
    char_names = [c["name"] for c in characters]

    exploration_rates: dict[str, float] = debate.character_exploration or {}

    # Build model pool for parallel execution
    model_pool = get_model_pool()
    model_assignments = assign_models_to_characters(characters, model_pool) if model_pool else {}

    # World observers
    all_observers = story.analysis.get("world_observers", [])
    active_observers = _select_observers(all_observers, debate.divergence_description, num_active=4)
    last_observer_at: int = 0
    pending_observer_question: dict | None = None

    transcript = list(debate.transcript or [])
    round_number = len(transcript)
    max_rounds = max(len(characters) * 6, 35)

    # Pre-initialize synthesis variables (used in finally block even if debate ends early)
    alternate_ending = ""
    alternate_timeline = []
    alternate_world_state = {}

    # ── Initialize the Sutradhar (orchestrator) ──
    ledger = ArgumentLedger(debate.divergence_description, char_names)
    current_phase = "opening"

    def sse(event_type: str, data: dict) -> str:
        return f"data: {json.dumps({'type': event_type, **data})}\n\n"

    yield sse("debate_start", {
        "debate_id": debate_id,
        "characters": char_names,
        "divergence": debate.divergence_description,
    })

    async with session_maker() as db:
        db_debate = (await db.execute(
            select(Debate).where(Debate.id == debate_id)
        )).scalar_one()
        db_debate.status = "running"
        await db.commit()

    consecutive_errors = 0

    try:
        # (No separate opening — Boru's first round_intro serves as the opening)

        # ── Main debate loop — orchestrator-driven ──
        while round_number < max_rounds:
            # Check if debate should end
            if await should_end_debate(ledger, current_phase, transcript, characters):
                break

            # Check phase transition
            new_phase = await decide_phase_transition(ledger, current_phase, transcript, characters)
            if new_phase:
                transition_msg = await generate_orchestrator_message(
                    ledger, new_phase, transcript, characters, story.title or "",
                    event_type="phase_transition",
                    context={"from_phase": current_phase, "to_phase": new_phase},
                )
                if transition_msg:
                    yield sse("orchestrator", {"message": transition_msg, "phase": new_phase, "event": "phase_transition"})
                    transcript.append({
                        "character": "Boru",
                        "message": transition_msg,
                        "round": round_number,
                        "phase": new_phase,
                        "isOrchestrator": True,
                    })
                current_phase = new_phase

                # If we've entered closing and all have spoken, break after this round
                if current_phase == "closing" and await should_end_debate(ledger, current_phase, transcript, characters):
                    break

            # ── Orchestrator picks who speaks next and why ──
            last_speaker = ""
            for e in reversed(transcript):
                if not e.get("isOrchestrator") and not e.get("isObserver"):
                    last_speaker = e["character"]
                    break

            # ── Boru decides who speaks (1 or many) ──
            round_decision = await pick_next_speakers(
                ledger, current_phase, transcript, characters, last_speaker,
            )
            speakers_list = round_decision["speakers"]
            is_parallel = round_decision.get("is_parallel", False) and len(speakers_list) > 1
            boru_intro = round_decision.get("boru_intro", "")

            # Boru's round introduction
            if boru_intro:
                yield sse("orchestrator", {"message": boru_intro, "phase": current_phase, "event": "round_intro"})
                transcript.append({
                    "character": "Boru", "message": boru_intro,
                    "round": round_number, "phase": current_phase, "isOrchestrator": True,
                })

            # ── Helper: generate one character's response ──
            async def _run_one_speaker(speaker_info: dict) -> dict | None:
                next_speaker_name = speaker_info["speaker"]
                directive = speaker_info.get("directive", "")
                character = next((c for c in characters if c["name"] == next_speaker_name), None)
                if not character:
                    return None

                phases_list = character.get("phases", [])
                phase_state = phases_list[-1] if phases_list else {}

                # Exploration hint
                exploration_hint = None
                char_exploration_rate = exploration_rates.get(next_speaker_name, 0.10)
                if character.get("hidden_dimensions") and random.random() < char_exploration_rate:
                    exploration_hint = random.choice(character["hidden_dimensions"])
                elif objective_hint := get_objective_hint(character):
                    if random.random() < 0.25:
                        exploration_hint = objective_hint

                # Observer challenge
                nonlocal pending_observer_question
                observer_challenge = None
                if pending_observer_question and pending_observer_question["character"] == next_speaker_name:
                    observer_challenge = pending_observer_question
                    pending_observer_question = None

                # Memory recall
                memory_context = []
                if transcript:
                    last_msg = transcript[-1].get("message", "")
                    memory_query = f"{(debate.divergence_description or '')[:120]} {last_msg[:120]}"
                    memory_context = await recall_memories(
                        story_id=debate.story_id,
                        character_name=next_speaker_name,
                        query=memory_query,
                    )

                # Generate response (non-streaming for parallel)
                full_response = ""
                judge_result = {"score": 7, "issue": None, "dominant_emotion": "neutral"}
                try:
                    async for token in character_respond_stream(
                        character=character, phase=phase_state,
                        divergence=debate.divergence_description,
                        debate_history=transcript, story_title=story.title or "",
                        correction_hint=None, exploration_hint=exploration_hint,
                        memory_context=memory_context, observer_challenge=observer_challenge,
                    ):
                        full_response += token

                    traits = phase_state.get("personality_traits", [])
                    last_entry = transcript[-1] if transcript else {}
                    try:
                        judge_result = await judge_response(
                            character_name=next_speaker_name,
                            character_description=character.get("description", ""),
                            personality_traits=traits,
                            response_text=full_response,
                            previous_message=last_entry.get("message", ""),
                            previous_speaker=last_entry.get("character", ""),
                            was_directly_addressed=last_entry.get("target_character") == next_speaker_name,
                        )
                    except Exception:
                        judge_result = {"score": 7, "in_character": True, "feedback": "", "issue": None, "needs_continuation": False, "dominant_emotion": "neutral"}
                except Exception as e:
                    if _is_rate_limit(e):
                        # Retry once after backoff
                        await asyncio.sleep(8)
                        try:
                            full_response = ""
                            async for token in character_respond_stream(
                                character=character, phase=phase_state,
                                divergence=debate.divergence_description,
                                debate_history=transcript, story_title=story.title or "",
                                correction_hint=None, exploration_hint=exploration_hint,
                                memory_context=memory_context, observer_challenge=observer_challenge,
                            ):
                                full_response += token
                        except Exception:
                            return None
                    else:
                        logger.warning(f"Parallel speaker {next_speaker_name} failed: {e}")
                        return None

                if not full_response:
                    return None

                target_char = _detect_question_target(full_response, char_names, next_speaker_name)
                if not target_char and transcript:
                    for e in reversed(transcript):
                        if not e.get("isOrchestrator") and e["character"] != next_speaker_name:
                            target_char = e["character"]
                            break

                return {
                    "character": next_speaker_name,
                    "message": full_response,
                    "target_character": target_char,
                    "judge_result": judge_result,
                    "directive": directive,
                    "is_exploration": exploration_hint is not None,
                }

            # ── Execute: parallel or sequential ──
            if is_parallel and len(speakers_list) > 1:
                # Fire all speakers simultaneously
                results = await asyncio.gather(
                    *[_run_one_speaker(s) for s in speakers_list],
                    return_exceptions=True,
                )
                # Stream results one by one (already generated)
                for res in results:
                    if isinstance(res, Exception) or res is None:
                        continue
                    name = res["character"]
                    # Boru introduces each (brief, since boru_intro already set the scene)
                    directive = res.get("directive", "")
                    if directive:
                        invite_msg = await generate_orchestrator_message(
                            ledger, current_phase, transcript, characters, story.title or "",
                            event_type="invite_speaker",
                            context={"speaker": name, "directive": directive},
                        )
                        if invite_msg:
                            yield sse("orchestrator", {"message": invite_msg, "phase": current_phase, "event": "invite_speaker", "target": name})
                            transcript.append({"character": "Boru", "message": invite_msg, "round": round_number, "phase": current_phase, "isOrchestrator": True})

                    # Stream the pre-generated response token by token (fast, ~50ms)
                    yield sse("character_start", {"character": name, "round": round_number, "phase": current_phase, "drama_score": orch_drama_score(transcript)})
                    for i in range(0, len(res["message"]), 12):
                        yield sse("token", {"character": name, "text": res["message"][i:i+12]})
                        await asyncio.sleep(0.02)

                    yield sse("character_end", {
                        "character": name, "message": res["message"], "round": round_number,
                        "judge_score": res["judge_result"].get("score", 7),
                        "target_character": res.get("target_character"),
                        "emotion": res["judge_result"].get("dominant_emotion", "neutral"),
                    })
                    transcript.append({
                        "character": name, "message": res["message"], "round": round_number,
                        "phase": current_phase, "target_character": res.get("target_character"),
                        "emotion": res["judge_result"].get("dominant_emotion", "neutral"),
                    })
                    # Memory save
                    asyncio.create_task(save_debate_turn(
                        story_id=debate.story_id, character_name=name,
                        message=res["message"], debate_id=debate_id,
                        round_number=round_number, divergence=debate.divergence_description,
                    ))
                    # Ledger update
                    obs_names = [o["name"] for o in active_observers] if active_observers else []
                    await update_ledger(ledger, name, res["message"], transcript, observer_names=obs_names)

                # Stream ledger after parallel round completes
                yield sse("ledger_update", {
                    "open_questions": ledger.open_questions[:10],
                    "claims": [c for c in ledger.claims if c["status"] != "resolved"][-8:],
                    "positions": ledger.character_positions,
                    "progress": ledger.progress_summary,
                    "resolved_count": len(ledger.resolved_questions),
                })

            else:
                # Sequential — single speaker with live streaming
                speaker_info = speakers_list[0]
                next_speaker_name = speaker_info["speaker"]
                directive = speaker_info.get("directive", "")

                character = next((c for c in characters if c["name"] == next_speaker_name), None)
                if not character:
                    break

                # Boru introduces — skip if boru_intro already named this speaker
                if not boru_intro:
                    invite_msg = await generate_orchestrator_message(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="invite_speaker",
                        context={"speaker": next_speaker_name, "directive": directive},
                    )
                    if invite_msg:
                        yield sse("orchestrator", {"message": invite_msg, "phase": current_phase, "event": "invite_speaker", "target": next_speaker_name})
                        transcript.append({"character": "Boru", "message": invite_msg, "round": round_number, "phase": current_phase, "isOrchestrator": True})

            if not is_parallel:
                phases = character.get("phases", [])
                phase_state = phases[-1] if phases else {}

                yield sse("character_start", {
                    "character": next_speaker_name,
                    "round": round_number,
                    "phase": current_phase,
                    "drama_score": orch_drama_score(transcript),
                })

                full_response = ""
                attempt = 0
                max_attempts = 2
                judge_result = {"score": 7, "issue": None}
                correction_hint = None

                # Exploration hint
                exploration_hint = None
                char_exploration_rate = exploration_rates.get(next_speaker_name, 0.10)
                if character.get("hidden_dimensions") and random.random() < char_exploration_rate:
                    exploration_hint = random.choice(character["hidden_dimensions"])
                    yield sse("exploration", {
                        "character": next_speaker_name,
                        "hint": exploration_hint,
                        "rate": char_exploration_rate,
                    })
                elif objective_hint := get_objective_hint(character):
                    if random.random() < 0.25:
                        exploration_hint = objective_hint

                # Observer challenge
                observer_challenge = None
                if pending_observer_question and pending_observer_question["character"] == next_speaker_name:
                    observer_challenge = pending_observer_question
                    pending_observer_question = None
                    yield sse("observer_challenge", {
                        "character": next_speaker_name,
                        "observer_name": observer_challenge["observer_name"],
                        "question": observer_challenge["question"],
                    })

                # Memory recall
                memory_context = []
                if transcript:
                    last_msg = transcript[-1].get("message", "")
                    memory_query = f"{(debate.divergence_description or '')[:120]} {last_msg[:120]}"
                    memory_context = await recall_memories(
                        story_id=debate.story_id,
                        character_name=next_speaker_name,
                        query=memory_query,
                    )
                    if memory_context:
                        yield sse("memory_recalled", {"character": next_speaker_name, "count": len(memory_context)})

                # ── Character responds ──
                try:
                    while attempt < max_attempts:
                        full_response = ""
                        async for token in character_respond_stream(
                            character=character,
                            phase=phase_state,
                            divergence=debate.divergence_description,
                            debate_history=transcript,
                            story_title=story.title or "",
                            correction_hint=correction_hint,
                            exploration_hint=exploration_hint,
                            memory_context=memory_context,
                            observer_challenge=observer_challenge,
                        ):
                            full_response += token
                            yield sse("token", {"character": next_speaker_name, "text": token})

                        traits = phase_state.get("personality_traits", [])
                        last_entry = transcript[-1] if transcript else {}
                        try:
                            judge_result = await judge_response(
                                character_name=next_speaker_name,
                                character_description=character.get("description", ""),
                                personality_traits=traits,
                                response_text=full_response,
                                previous_message=last_entry.get("message", ""),
                                previous_speaker=last_entry.get("character", ""),
                                was_directly_addressed=last_entry.get("target_character") == next_speaker_name,
                            )
                        except Exception:
                            judge_result = {"score": 7, "in_character": True, "feedback": "", "issue": None, "needs_continuation": False, "continuation_reason": None, "dominant_emotion": "neutral"}

                        if not await should_regenerate(judge_result):
                            break

                        attempt += 1
                        correction_hint = judge_result.get("issue") or judge_result.get("feedback")
                        yield sse("regenerating", {"character": next_speaker_name, "reason": correction_hint or "out of character"})

                    # Continuation
                    drama_score = orch_drama_score(transcript)
                    continuation_threshold = 0.4 if current_phase == "reckoning" else 0.55
                    if judge_result.get("needs_continuation") and drama_score >= continuation_threshold:
                        continuation_reason = judge_result.get("continuation_reason") or "unfinished thought"
                        yield sse("continuation_granted", {"character": next_speaker_name, "reason": continuation_reason})
                        async for token in character_continue_stream(
                            character=character, phase=phase_state,
                            divergence=debate.divergence_description,
                            debate_history=transcript, story_title=story.title or "",
                            previous_response=full_response,
                            continuation_reason=continuation_reason,
                            exploration_hint=exploration_hint,
                        ):
                            full_response += token
                            yield sse("token", {"character": next_speaker_name, "text": token})

                except Exception as e:
                    if _is_rate_limit(e):
                        yield sse("turn_error", {"character": next_speaker_name, "reason": "rate limited — retrying..."})
                        await asyncio.sleep(8)
                        continue
                    consecutive_errors += 1
                    yield sse("turn_error", {"character": next_speaker_name, "reason": str(e)[:120]})
                    if consecutive_errors >= 5:
                        break
                    await asyncio.sleep(2)
                    round_number += 1
                    continue

                consecutive_errors = 0

                if not full_response:
                    round_number += 1
                    continue

                target_char = _detect_question_target(full_response, char_names, next_speaker_name)
                if not target_char and transcript:
                    for e in reversed(transcript):
                        if not e.get("isOrchestrator") and e["character"] != next_speaker_name:
                            target_char = e["character"]
                            break

                yield sse("character_end", {
                    "character": next_speaker_name,
                    "message": full_response,
                    "round": round_number,
                    "judge_score": judge_result.get("score", 7),
                    "target_character": target_char,
                    "emotion": judge_result.get("dominant_emotion", "neutral"),
                })

                transcript.append({
                    "character": next_speaker_name,
                    "message": full_response,
                    "round": round_number,
                    "phase": current_phase,
                    "target_character": target_char,
                    "emotion": judge_result.get("dominant_emotion", "neutral"),
                })

                # Save to character soul memory
                asyncio.create_task(save_debate_turn(
                    story_id=debate.story_id,
                    character_name=next_speaker_name,
                    message=full_response,
                    debate_id=debate_id,
                    round_number=round_number,
                    divergence=debate.divergence_description,
                ))

            # ── Emotional reactions from other characters ──
            # Get last speaker from transcript (works for both parallel and sequential)
            last_char_entry = None
            for _e in reversed(transcript):
                if not _e.get("isOrchestrator") and not _e.get("isObserver") and not _e.get("isReaction") and not _e.get("isStageDirection") and not _e.get("isAudience"):
                    last_char_entry = _e
                    break
            drama = orch_drama_score(transcript)
            if last_char_entry and should_generate_reactions(transcript, drama):
                reactions = await generate_reactions(
                    last_char_entry["character"], last_char_entry["message"], characters, transcript, ledger,
                )
                if reactions:
                    yield sse("reactions", {"reactions": reactions, "after": last_char_entry["character"]})
                    # Add to transcript as atmospheric entries
                    for r in reactions:
                        transcript.append({
                            "character": r["character"],
                            "message": r["reaction"],
                            "round": round_number,
                            "phase": current_phase,
                            "isReaction": True,
                        })

            # ── Stage direction if the moment demands it ──
            stage_event = should_add_stage_direction(transcript, current_phase, drama)
            if stage_event:
                last_char = transcript[-1]["character"] if transcript else ""
                stage_text = await generate_stage_direction(
                    stage_event, characters, transcript, ledger, story.title or "",
                    context={"character": last_char},
                )
                if stage_text:
                    yield sse("stage_direction", {"text": stage_text, "event": stage_event})
                    transcript.append({
                        "character": "Narrator",
                        "message": stage_text,
                        "round": round_number,
                        "phase": current_phase,
                        "isStageDirection": True,
                    })
                    # Dramatic pause after intense moments
                    if stage_event in ("tension_rising", "confrontation", "breakthrough"):
                        await asyncio.sleep(2)

            if not is_parallel:
                # ── Orchestrator updates the argument ledger (sequential path) ──
                obs_names = [o["name"] for o in active_observers] if active_observers else []
                ledger_update = await update_ledger(ledger, next_speaker_name, full_response, transcript, observer_names=obs_names)

                # Stream ledger state to frontend
                yield sse("ledger_update", {
                    "open_questions": ledger.open_questions[:10],
                    "claims": [c for c in ledger.claims if c["status"] != "resolved"][-8:],
                    "positions": ledger.character_positions,
                    "progress": ledger.progress_summary,
                    "resolved_count": len(ledger.resolved_questions),
                })

                # If repetition detected, orchestrator calls it out
                if ledger_update.get("is_repetition"):
                    callout_msg = await generate_orchestrator_message(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="call_out_repetition",
                        context={"speaker": next_speaker_name},
                    )
                    if callout_msg:
                        yield sse("orchestrator", {"message": callout_msg, "phase": current_phase, "event": "call_out_repetition"})
                        transcript.append({
                            "character": "Boru",
                            "message": callout_msg,
                            "round": round_number,
                            "phase": current_phase,
                            "isOrchestrator": True,
                        })

                # If character addressed Boru directly — Boru responds
                if ledger_update.get("addresses_boru") and ledger_update.get("boru_question"):
                    boru_reply = await generate_orchestrator_message(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="respond_to_character",
                        context={"speaker": next_speaker_name, "question": ledger_update["boru_question"]},
                    )
                    if boru_reply:
                        yield sse("orchestrator", {"message": boru_reply, "phase": current_phase, "event": "respond_to_character"})
                        transcript.append({
                            "character": "Boru", "message": boru_reply,
                            "round": round_number, "phase": current_phase, "isOrchestrator": True,
                        })

                # If character requested an observer — Boru summons one
                if ledger_update.get("wants_observer") and active_observers:
                    reason = ledger_update.get("wanted_observer_reason", "")
                    # Pick the most relevant observer based on the reason
                    import random as _rnd
                    observer = _rnd.choice(active_observers)
                    summon_msg = await generate_orchestrator_message(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="summon_observer",
                        context={"requester": next_speaker_name, "reason": reason},
                    )
                    if summon_msg:
                        yield sse("orchestrator", {"message": summon_msg, "phase": current_phase, "event": "summon_observer"})
                        transcript.append({
                            "character": "Boru", "message": summon_msg,
                            "round": round_number, "phase": current_phase, "isOrchestrator": True,
                        })
                    # Trigger observer response
                    obs_response = ""
                    try:
                        yield sse("observer_start", {
                            "observer_id": observer["id"], "observer_name": observer["name"],
                            "era": observer.get("era", ""),
                        })
                        _asked_qs = [q["question"] for q in ledger.open_questions] + [q["question"] for q in ledger.resolved_questions]
                        async for token in observer_respond_stream(
                            observer=observer, story_title=story.title or "",
                            divergence=debate.divergence_description,
                            debate_history=transcript, characters=char_names,
                            already_asked=_asked_qs,
                        ):
                            obs_response += token
                            yield sse("observer_token", {"observer_id": observer["id"], "observer_name": observer["name"], "text": token})
                        if obs_response:
                            q_target, q_text = _extract_question_target(obs_response, char_names)
                            if q_target and q_text:
                                pending_observer_question = {"character": q_target, "question": q_text, "observer_name": observer["name"]}
                                ledger.add_question(q_text, observer["name"], [q_target])
                            yield sse("observer_end", {
                                "observer_id": observer["id"], "observer_name": observer["name"],
                                "era": observer.get("era", ""), "message": obs_response, "question_target": q_target,
                            })
                            last_observer_at = len(transcript)
                    except Exception as obs_exc:
                        logger.warning(f"Summoned observer failed (non-fatal): {obs_exc}")

                # Check for stalled open questions — force them after 4 turns unanswered
                for q in list(ledger.open_questions):
                    turns_since = round_number - q.get("_asked_at", round_number)
                    if turns_since >= 4 and q["status"] == "unanswered":
                        targets = q.get("directed_to", [])
                        if targets:
                            forced_msg = await generate_orchestrator_message(
                                ledger, current_phase, transcript, characters, story.title or "",
                                event_type="forced_question",
                                context={"target": targets[0], "question": q["question"]},
                            )
                            if forced_msg:
                                yield sse("orchestrator", {"message": forced_msg, "phase": current_phase, "event": "forced_question", "target": targets[0]})
                                transcript.append({
                                    "character": "Boru",
                                    "message": forced_msg,
                                    "round": round_number,
                                    "phase": current_phase,
                                    "isOrchestrator": True,
                                })
                            q["_asked_at"] = round_number  # reset so we don't spam

                # Persist to DB
                async with session_maker() as db:
                    db_debate = (await db.execute(
                        select(Debate).where(Debate.id == debate_id)
                    )).scalar_one()
                    db_debate.transcript = transcript
                    db_debate.round_count = round_number
                    await db.commit()

                round_number += 1

            # World observer — every 5 character turns
            if active_observers and should_invite_observer(transcript, last_observer_at, observer_interval=5):
                observer = random.choice(active_observers)
                # Orchestrator introduces observer
                obs_intro = await generate_orchestrator_message(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="observer_intro",
                    context={"observer_name": observer["name"]},
                )
                if obs_intro:
                    yield sse("orchestrator", {"message": obs_intro, "phase": current_phase, "event": "observer_intro"})

                obs_response = ""
                try:
                    yield sse("observer_start", {
                        "observer_id": observer["id"],
                        "observer_name": observer["name"],
                        "era": observer.get("era", ""),
                    })
                    async for token in observer_respond_stream(
                        observer=observer,
                        story_title=story.title or "",
                        divergence=debate.divergence_description,
                        debate_history=transcript,
                        characters=char_names,
                    ):
                        obs_response += token
                        yield sse("observer_token", {
                            "observer_id": observer["id"],
                            "observer_name": observer["name"],
                            "text": token,
                        })
                    if obs_response:
                        q_target, q_text = _extract_question_target(obs_response, char_names)
                        if q_target and q_text:
                            pending_observer_question = {
                                "character": q_target,
                                "question": q_text,
                                "observer_name": observer["name"],
                            }
                            # Also add to ledger
                            ledger.add_question(q_text, observer["name"], [q_target])
                        yield sse("observer_end", {
                            "observer_id": observer["id"],
                            "observer_name": observer["name"],
                            "era": observer.get("era", ""),
                            "message": obs_response,
                            "question_target": q_target,
                        })
                        last_observer_at = len(transcript)
                except Exception as obs_exc:
                    logger.warning(f"Observer failed (non-fatal): {obs_exc}")

            # ── Check for audience messages ──
            queue = _audience_queues.get(debate_id)
            if queue:
                while not queue.empty():
                    try:
                        audience_msg = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break

                    audience_name = audience_msg["name"]
                    audience_text = audience_msg["message"]
                    directed_to = audience_msg.get("directed_to")

                    # Add to transcript as audience entry
                    yield sse("audience", {
                        "name": audience_name,
                        "message": audience_text,
                        "directed_to": directed_to,
                    })
                    transcript.append({
                        "character": audience_name,
                        "message": audience_text,
                        "round": round_number,
                        "phase": current_phase,
                        "isAudience": True,
                    })

                    # Boru acknowledges and routes
                    boru_response = await generate_orchestrator_message(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="audience_question",
                        context={
                            "audience_name": audience_name,
                            "audience_message": audience_text,
                            "directed_to": directed_to or "",
                        },
                    )
                    if boru_response:
                        yield sse("orchestrator", {
                            "message": boru_response,
                            "phase": current_phase,
                            "event": "audience_question",
                        })
                        transcript.append({
                            "character": "Boru",
                            "message": boru_response,
                            "round": round_number,
                            "phase": current_phase,
                            "isOrchestrator": True,
                        })

                    # Add to ledger as a question
                    targets = [directed_to] if directed_to else char_names[:3]
                    ledger.add_question(audience_text, audience_name, targets)

            await asyncio.sleep(0.3)

        # Clean up audience queue
        _audience_queues.pop(debate_id, None)

        # ── Closing summary from Boru ──
        closing_msg = await generate_orchestrator_message(
            ledger, current_phase, transcript, characters, story.title or "",
            event_type="closing_summary",
        )
        if closing_msg:
            yield sse("orchestrator", {"message": closing_msg, "phase": "closing", "event": "closing_summary"})
            transcript.append({
                "character": "Boru",
                "message": closing_msg,
                "round": round_number,
                "phase": "closing",
                "isOrchestrator": True,
            })

        # Synthesize alternate ending
        yield sse("synthesis_start", {"message": "Characters have spoken. Writing the alternate ending..."})

        alternate_timeline = []
        try:
            async for token in synthesize_ending_stream(
                story_title=story.title or "the story",
                original_summary=story.summary or "",
                divergence_description=debate.divergence_description,
                debate_transcript=transcript,
            ):
                alternate_ending += token
                yield sse("ending_token", {"text": token})
        except Exception as e:
            alternate_ending = f"[The narrator could not write the ending: {str(e)[:120]}]"
            yield sse("ending_token", {"text": alternate_ending})

        # Generate structured timeline from the completed prose
        if alternate_ending and not alternate_ending.startswith("["):
            try:
                alternate_timeline = await generate_alternate_timeline(
                    story_title=story.title or "the story",
                    divergence_description=debate.divergence_description,
                    alternate_ending=alternate_ending,
                )
            except Exception:
                alternate_timeline = []

        # Build the alternate world state — needed for Oracle mode
        alternate_world_state = {}
        if alternate_ending and not alternate_ending.startswith("["):
            try:
                from app.core.agents.oracle_agent import build_alternate_world_state
                alternate_world_state = await build_alternate_world_state(
                    story_title=story.title or "the story",
                    original_summary=story.summary or "",
                    divergence=debate.divergence_description,
                    transcript=transcript,
                    alternate_ending=alternate_ending,
                )
            except Exception:
                alternate_world_state = {}

        yield sse("debate_end", {
            "debate_id": debate_id,
            "alternate_ending": alternate_ending,
            "alternate_timeline": alternate_timeline,
            "total_rounds": round_number,
            "oracle_ready": bool(alternate_world_state),
        })

        # Character evolution — run in background after debate ends (non-blocking)
        asyncio.create_task(evolve_characters_after_debate(
            story_id=debate.story_id,
            debate_id=debate_id,
            transcript=transcript,
            characters=characters,
            divergence=debate.divergence_description,
        ))

    finally:
        # Always persist final state — even if client disconnects mid-stream
        async with session_maker() as db:
            db_debate = (await db.execute(
                select(Debate).where(Debate.id == debate_id)
            )).scalar_one()
            db_debate.alternate_ending = alternate_ending or db_debate.alternate_ending
            db_debate.alternate_timeline = alternate_timeline or db_debate.alternate_timeline
            if alternate_world_state:
                db_debate.alternate_world_state = alternate_world_state
            db_debate.status = "completed" if alternate_ending else "interrupted"
            db_debate.round_count = round_number
            await db.commit()


class OracleRequest(BaseModel):
    character_name: str
    question: str
    history: list[dict] = []


@router.get("/{debate_id}/oracle")
async def get_oracle_state(debate_id: str, db: AsyncSession = Depends(get_db)):
    """Return the alternate world state — which characters are queryable and what changed."""
    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")
    if not debate.alternate_world_state:
        raise HTTPException(status_code=404, detail="Oracle not ready — debate may still be running or world state not generated.")
    return {
        "debate_id": debate_id,
        "divergence": debate.divergence_description,
        "world_state": debate.alternate_world_state,
        "queryable_characters": list(debate.alternate_world_state.get("characters", {}).keys()),
    }


@router.post("/{debate_id}/oracle/stream")
async def oracle_stream(
    debate_id: str, body: OracleRequest, db: AsyncSession = Depends(get_db)
):
    """
    Stream a character's response from within the alternate world (Oracle mode).
    Characters answer questions as if they LIVE in the alternate timeline.
    """
    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")
    if not debate.alternate_world_state:
        raise HTTPException(status_code=400, detail="Oracle not available — alternate world state not built.")

    story_result = await db.execute(select(Story).where(Story.id == debate.story_id))
    story = story_result.scalar_one_or_none()

    all_characters = story.analysis.get("characters", []) if story else []
    character_data = next(
        (c for c in all_characters if c["name"].lower() == body.character_name.lower()),
        {"name": body.character_name, "description": ""},
    )

    from app.core.agents.oracle_agent import oracle_respond_stream

    async def generate():
        try:
            async for token in oracle_respond_stream(
                character_name=body.character_name,
                character_data=character_data,
                alternate_world_state=debate.alternate_world_state,
                divergence=debate.divergence_description,
                story_title=story.title if story else "",
                question=body.question,
                chat_history=body.history,
            ):
                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"
        except Exception as e:
            logger.warning(f"Oracle stream error for {body.character_name}: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': 'The oracle could not reach this character right now.'})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    from fastapi.responses import StreamingResponse as SR
    return SR(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class DebateChatRequest(BaseModel):
    question: str
    history: list[dict] = []

@router.post("/{debate_id}/chat")
async def chat_about_debate(
    debate_id: str, body: DebateChatRequest, db: AsyncSession = Depends(get_db)
):
    from langchain_core.messages import SystemMessage, HumanMessage, AIMessage
    from app.config import get_analysis_llm

    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")

    story_result = await db.execute(select(Story).where(Story.id == debate.story_id))
    story = story_result.scalar_one_or_none()

    transcript = debate.transcript or []
    transcript_text = "\n".join(
        f"[Round {e.get('round',0)}] {e['character']}: {e['message']}"
        for e in transcript
    )

    system_prompt = f"""You are Boru — the wise elephant, Speaker of the WhatIfSabha. You are answering questions from the audience about a debate on "{story.title if story else 'the story'}".

WHO YOU ARE:
- An ancient, wise elephant who presides over debates with wit and warmth
- You have a long memory and deep knowledge of the story and its characters
- You speak with measured gravitas but can be witty, dry, and occasionally playful
- You address the questioner directly and personally
- You reference specific moments from the debate when relevant

THE DIVERGENCE SCENARIO:
"{debate.divergence_description}"

DEBATE TRANSCRIPT SO FAR:
{transcript_text or "The debate has not started yet."}

HOW TO ANSWER:
- Speak as Boru — in first person, with personality
- If asked about what happened: explain clearly, reference specific quotes from the transcript
- If asked about motivations: draw on your deep knowledge of the characters
- If asked about what will happen next: speculate wisely, but acknowledge uncertainty
- If asked something off-topic: gently redirect with humor ("An interesting question, but this elephant has a debate to run...")
- Keep answers concise but rich — 2-4 sentences unless the question demands depth
- Occasionally reference your elephant nature: memory, patience, size, wisdom"""

    messages = [SystemMessage(content=system_prompt)]
    for turn in body.history[-8:]:
        if turn.get("role") == "user":
            messages.append(HumanMessage(content=turn["content"]))
        elif turn.get("role") == "assistant":
            messages.append(AIMessage(content=turn["content"]))
    messages.append(HumanMessage(content=body.question.strip()))

    from app.config import invoke_analysis_with_fallback
    answer = await invoke_analysis_with_fallback(messages)
    if not answer:
        answer = "This elephant's thoughts are momentarily elsewhere. Try asking again."
    return {"answer": answer}


@router.delete("/{debate_id}")
async def delete_debate(debate_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")
    await db.delete(debate)
    await db.commit()
    return {"ok": True}


@router.get("/{debate_id}")
async def get_debate(debate_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()

    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")

    return {
        "id": debate.id,
        "story_id": debate.story_id,
        "divergence_description": debate.divergence_description,
        "participating_characters": debate.participating_characters,
        "transcript": debate.transcript,
        "alternate_ending": debate.alternate_ending,
        "alternate_timeline": debate.alternate_timeline or [],
        "status": debate.status,
        "round_count": debate.round_count,
    }
