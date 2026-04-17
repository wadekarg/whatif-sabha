import json
import uuid
import asyncio
import random
import logging
import re

logger = logging.getLogger(__name__)
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel, Field
from typing import Optional

# Shared audience message queues per debate — {debate_id: asyncio.Queue}
_audience_queues: dict[str, asyncio.Queue] = {}
_stop_signals: dict[str, bool] = {}  # {debate_id: True} to signal debate should stop
_bg_tasks: dict[str, list[asyncio.Task]] = {}  # track background tasks per debate


def _track_task(debate_id: str, coro):
    """Create a background task with error logging (not fire-and-forget)."""
    async def _safe():
        try:
            await coro
        except Exception as e:
            logger.error(f"Background task failed for debate {debate_id}: {e}")
    task = asyncio.create_task(_safe())
    _bg_tasks.setdefault(debate_id, []).append(task)

from app.db.database import get_db
from app.models.story import Story
from app.models.debate import Debate
from app.core.agents.character_agent import character_respond_stream, character_continue_stream
from app.core.agents.orchestrator import _detect_question_target
from app.core.agents.judge_agent import judge_response, should_regenerate
from app.core.agents.narrator_agent import synthesize_ending_stream, synthesize_debate_summary_stream, generate_alternate_timeline
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
    decide_phase_transition, should_end_debate,
    compute_drama_score as orch_drama_score, PHASES, PHASE_CONFIG,
    generate_reactions, generate_stage_direction,
    should_generate_reactions, should_add_stage_direction,
)
from app.core.agents.orchestrator import pick_next_speaker_with_scores
from app.config import get_model_pool, assign_models_to_characters, _is_rate_limit
from app.db.database import get_session_maker

router = APIRouter(prefix="/debates", tags=["debates"])


def _resolve_targets(
    speaker_name: str,
    full_response: str,
    char_names: list[str],
    transcript: list[dict],
    ledger=None,
    observer_challenge: dict | None = None,
    was_invited_by_boru: bool = False,
    judge_targets: list[str] | None = None,
) -> list[str]:
    """
    Target resolution for the interaction graph — extracts ALL targets.

    Priority:
    1. Judge's addressed_targets (LLM-analyzed, all targets)
    2. Observer challenge → add observer
    3. Heuristic: ALL character names mentioned in response text
    4. Fallback → ["Boru"] if no targets found
    """
    targets = set()
    
    # 1. Judge already analyzed the response — trust its targets if valid
    if judge_targets:
        for t in judge_targets:
            if t in char_names and t != speaker_name:
                targets.add(t)
    
    # 2. Responding to an observer challenge
    if observer_challenge:
        targets.add(observer_challenge.get("observer_name", "Boru"))
    
    # 3. Heuristic: ALL character names mentioned (excluding self and Boru)
    # Scan entire response for mentions with case-insensitive matching
    resp_lower = full_response.lower()
    for cn in char_names:
        if cn == speaker_name or cn.lower() == "boru":
            continue
        if cn.lower() in resp_lower:
            targets.add(cn)
    
    # 4. If still empty, walk back transcript for last real character speaker
    if not targets:
        for entry in reversed(transcript):
            if entry.get("isReaction") or entry.get("isStageDirection") or entry.get("isOrchestrator"):
                continue
            if entry.get("isObserver"):
                targets.add(entry["character"])
                break
            if (not entry.get("isAudience") and entry["character"] != speaker_name):
                targets.add(entry["character"])
                break
    
    # 5. Absolute fallback if absolutely nothing found
    if not targets:
        targets.add("Boru")
    
    return list(targets)


def _extract_boru_question(full_response: str) -> str | None:
    """Detect a direct Boru question from a character response."""
    if not full_response or "boru" not in full_response.lower():
        return None
    if "?" not in full_response:
        return None

    # Prefer explicit @Boru mentions
    m = re.search(r"@Boru\b", full_response, re.IGNORECASE)
    if m:
        rest = full_response[m.end():]
        q = re.search(r"[^?]*\?", rest)
        if q:
            return q.group(0).strip()

    # Prefer a sentence containing Boru / moderator / Speaker
    for sentence in re.split(r"(?<=[.?!])\s+", full_response):
        if re.search(r"\b(Boru|Speaker|moderator|elephant)\b", sentence, re.IGNORECASE) and "?" in sentence:
            return sentence.strip()

    # Fallback to the first question in the response
    first_q = re.search(r"[^?]*\?", full_response)
    return first_q.group(0).strip() if first_q else None


class DebateStartRequest(BaseModel):
    story_id: str = Field(..., min_length=1)
    divergence_description: str = Field(..., min_length=5, max_length=2000)
    character_names: Optional[list[str]] = None  # None = use all characters
    max_rounds: int = Field(default=20, ge=5, le=100)
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
    name: str = Field(..., min_length=1, max_length=100)
    message: str = Field(..., min_length=1, max_length=1000)
    directed_to: Optional[str] = Field(default=None, max_length=100)


@router.post("/{debate_id}/audience")
async def audience_interjection(debate_id: str, body: AudienceMessage):
    """
    User sends a question/comment into a running debate.
    Boru will acknowledge it and route it to the right character(s).
    """
    if debate_id not in _audience_queues:
        _audience_queues[debate_id] = asyncio.Queue(maxsize=50)

    if _audience_queues[debate_id].full():
        raise HTTPException(status_code=429, detail="Too many queued messages. Please wait.")

    await _audience_queues[debate_id].put({
        "name": body.name.strip() or "Someone in the audience",
        "message": body.message.strip(),
        "directed_to": body.directed_to,
    })
    return {"ok": True, "queued": True}


@router.post("/{debate_id}/stop")
async def stop_debate(debate_id: str):
    """Signal a running debate to stop after the current turn."""
    _stop_signals[debate_id] = True
    return {"ok": True, "message": "Debate will stop after current turn"}


@router.post("/{debate_id}/generate-ending")
async def generate_ending_for_debate(debate_id: str, db: AsyncSession = Depends(get_db)):
    """Generate an alternate ending for a debate that was interrupted before completion."""
    from app.core.agents.narrator_agent import synthesize_ending_stream, generate_alternate_timeline
    from app.core.agents.sabha_orchestrator import ArgumentLedger

    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")
    if debate.alternate_ending:
        return {"ok": True, "message": "Ending already exists.", "alternate_ending": debate.alternate_ending}

    story_result = await db.execute(select(Story).where(Story.id == debate.story_id))
    story = story_result.scalar_one_or_none()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found.")

    transcript = debate.transcript or []
    if len(transcript) < 4:
        raise HTTPException(status_code=400, detail="Not enough transcript to generate an ending.")

    # Build a minimal ledger from the transcript
    char_names = debate.participating_characters or []
    ledger = ArgumentLedger(debate.divergence_description or "", char_names)

    alternate_ending = ""
    try:
        async for token in synthesize_ending_stream(
            story_title=story.title or "the story",
            original_summary=story.summary or "",
            divergence_description=debate.divergence_description or "",
            debate_transcript=transcript,
            ledger=ledger,
        ):
            alternate_ending += token
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate ending: {str(e)[:200]}")

    # Generate timeline
    alternate_timeline = []
    if alternate_ending:
        try:
            alternate_timeline = await generate_alternate_timeline(
                story_title=story.title or "the story",
                divergence_description=debate.divergence_description or "",
                alternate_ending=alternate_ending,
            )
        except Exception:
            pass

    # Save
    debate.alternate_ending = alternate_ending
    debate.alternate_timeline = alternate_timeline
    debate.status = "completed"
    await db.commit()

    return {"ok": True, "alternate_ending": alternate_ending, "alternate_timeline": alternate_timeline}


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

    is_first_round = True
    previous_phase = None

    try:
        # ── Main debate loop — heuristic-driven, Boru intervenes only when needed ──
        while round_number < max_rounds:
            # ── 1. Stop signal ──
            if _stop_signals.pop(debate_id, False):
                stop_summary = await generate_orchestrator_message(
                    ledger, "closing", transcript, characters, story.title or "",
                    event_type="closing_summary",
                )
                if not stop_summary:
                    stop_summary = "The Sabha is concluded. What was said here will not be forgotten."
                yield sse("orchestrator", {"message": stop_summary, "phase": "closing", "event": "user_stop", "target": "all"})
                transcript.append({"character": "Boru", "message": stop_summary, "round": round_number, "phase": "closing", "isOrchestrator": True, "orchestratorEvent": "closing_summary"})
                break

            # ── 2. End condition (check every 4th turn, or always in closing phase) ──
            if (current_phase == "closing" or round_number % 4 == 0) and round_number > 0:
                if await should_end_debate(ledger, current_phase, transcript, characters):
                    break

            # ── 3. Phase transition (check every 3rd turn — phases last 5-8 turns) ──
            if not is_first_round and round_number % 3 == 0:
                new_phase = await decide_phase_transition(ledger, current_phase, transcript, characters)
                if new_phase:
                    transition_msg = await generate_orchestrator_message(
                        ledger, new_phase, transcript, characters, story.title or "",
                        event_type="phase_transition",
                        context={"from_phase": current_phase, "to_phase": new_phase},
                    )
                    if transition_msg:
                        yield sse("orchestrator", {"message": transition_msg, "phase": new_phase, "event": "phase_transition", "target": "all"})
                        transcript.append({"character": "Boru", "message": transition_msg, "round": round_number, "phase": new_phase, "isOrchestrator": True, "orchestratorEvent": "phase_transition"})
                    previous_phase = current_phase
                    current_phase = new_phase
                    if current_phase == "closing" and await should_end_debate(ledger, current_phase, transcript, characters):
                        break

            # ── 4. Pick speaker (HEURISTIC — 0 LLM calls) ──
            next_speaker_name, scores = pick_next_speaker_with_scores(
                transcript, characters, current_phase, round_number,
            )

            character = next((c for c in characters if c["name"] == next_speaker_name), None)
            if not character:
                break

            # ── 5. Boru speaks ONLY when needed ──
            boru_spoke_this_turn = False
            if is_first_round:
                # Grand opening — introduce himself + topic
                opening_msg = await generate_orchestrator_message(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="opening_with_invite",
                    context={"speakers": char_names, "divergence": debate.divergence_description},
                )
                if opening_msg:
                    yield sse("orchestrator", {"message": opening_msg, "phase": current_phase, "event": "opening", "target": "all"})
                    transcript.append({"character": "Boru", "message": opening_msg, "round": round_number, "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "opening_with_invite"})
                    boru_spoke_this_turn = True
                is_first_round = False
            else:
                # Stall detection: if all scores are flat, Boru intervenes
                valid_scores = [v for v in scores.values() if v > -100]
                is_stalling = max(valid_scores) < 1.0 and round_number > len(characters)
                if is_stalling:
                    # Pick a forced question from the ledger or redirect
                    open_qs = ledger.open_questions[:1]
                    if open_qs:
                        forced_msg = await generate_orchestrator_message(
                            ledger, current_phase, transcript, characters, story.title or "",
                            event_type="forced_question",
                            context={"target": next_speaker_name, "question": open_qs[0]["question"]},
                        )
                        if forced_msg:
                            yield sse("orchestrator", {"message": forced_msg, "phase": current_phase, "event": "forced_question", "target": next_speaker_name})
                            transcript.append({"character": "Boru", "message": forced_msg, "round": round_number, "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "forced_question"})
                            boru_spoke_this_turn = True

            # ── 6. Character speaks (1 LLM call — live streaming) ──
            phases_list = character.get("phases", [])
            phase_state = phases_list[-1] if phases_list else {}

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

            try:
                full_response = ""
                raw_buffer = ""  # buffer until we extract @target from first line
                self_declared_target = None
                first_line_extracted = False
                _pqs = [q for q in ledger.open_questions
                        if next_speaker_name in q.get("directed_to", [])
                        and q.get("_times_injected", 0) < 2]
                for q in _pqs:
                    q["_times_injected"] = q.get("_times_injected", 0) + 1
                async for token in character_respond_stream(
                    character=character,
                    phase=phase_state,
                    divergence=debate.divergence_description,
                    debate_history=transcript,
                    story_title=story.title or "",
                    correction_hint=None,
                    exploration_hint=exploration_hint,
                    memory_context=memory_context,
                    observer_challenge=observer_challenge,
                    pending_questions=_pqs,
                    debate_progress=ledger.progress_summary if ledger.progress_summary else None,
                ):
                    if not first_line_extracted:
                        # Buffer tokens until we find the first newline
                        raw_buffer += token
                        if "\n" in raw_buffer:
                            first_line, remainder = raw_buffer.split("\n", 1)
                            first_line = first_line.strip()
                            # Extract @target if present
                            if first_line.startswith("@"):
                                target_name = first_line[1:].strip().rstrip(".,!?:;")
                                # Validate against known characters + Boru
                                if target_name in char_names or target_name == "Boru":
                                    self_declared_target = target_name
                                # Don't include the @line in the response
                                full_response += remainder
                                if remainder:
                                    yield sse("token", {"character": next_speaker_name, "text": remainder})
                            else:
                                # No @target — stream the whole buffer
                                full_response += raw_buffer
                                yield sse("token", {"character": next_speaker_name, "text": raw_buffer})
                            first_line_extracted = True
                    else:
                        full_response += token
                        yield sse("token", {"character": next_speaker_name, "text": token})

                # Handle case where streaming ended without a newline (very short response)
                if not first_line_extracted and raw_buffer:
                    # Check if the whole response is just an @target with no body
                    stripped = raw_buffer.strip()
                    if stripped.startswith("@") and "\n" not in stripped:
                        # Just a target line with no content — treat as empty
                        target_name = stripped[1:].strip().rstrip(".,!?:;")
                        if target_name in char_names or target_name == "Boru":
                            self_declared_target = target_name
                    else:
                        full_response += raw_buffer
                        yield sse("token", {"character": next_speaker_name, "text": raw_buffer})

                # Strip any remaining @target prefix that leaked into full_response
                full_response = full_response.lstrip()
                if full_response.startswith("@"):
                    first_nl = full_response.find("\n")
                    if first_nl != -1 and first_nl < 40:
                        full_response = full_response[first_nl+1:].lstrip()

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

            # ── 7. Judge + Ledger in PARALLEL (biggest speed win) ──
            # These are independent: judge scores quality, ledger tracks arguments.
            # Running them together cuts the gap between speakers by ~50%.
            traits = phase_state.get("personality_traits", [])
            last_entry = transcript[-1] if transcript else {}
            obs_names = [o["name"] for o in active_observers] if active_observers else []

            async def _run_judge():
                try:
                    return await judge_response(
                        character_name=next_speaker_name,
                        character_description=character.get("description", ""),
                        personality_traits=traits,
                        response_text=full_response,
                        previous_message=last_entry.get("message", ""),
                        previous_speaker=last_entry.get("character", ""),
                        was_directly_addressed=last_entry.get("target_character") == next_speaker_name,
                    )
                except Exception:
                    return {"score": 7, "in_character": True, "feedback": "", "issue": None, "needs_continuation": False, "continuation_reason": None, "dominant_emotion": "neutral"}

            async def _run_ledger():
                if round_number % 2 == 0:
                    return await update_ledger(ledger, next_speaker_name, full_response, transcript, observer_names=obs_names)
                return None

            judge_result, ledger_update = await asyncio.gather(_run_judge(), _run_ledger())

            # ── 8. Target resolution + emit character_end ──
            judge_addressed = judge_result.get("addressed_targets", [])
            target_chars = _resolve_targets(
                speaker_name=next_speaker_name,
                full_response=full_response,
                char_names=char_names,
                transcript=transcript,
                ledger=ledger,
                observer_challenge=observer_challenge,
                was_invited_by_boru=boru_spoke_this_turn,
                judge_targets=judge_addressed,
            )
            if self_declared_target and self_declared_target != next_speaker_name:
                if self_declared_target in target_chars:
                    target_chars.remove(self_declared_target)
                target_chars.insert(0, self_declared_target)
            logger.info(f"[TARGETS] {next_speaker_name} → {target_chars} (self_declared={self_declared_target}, judge={judge_addressed})")

            yield sse("character_end", {
                "character": next_speaker_name,
                "message": full_response,
                "round": round_number,
                "judge_score": judge_result.get("score", 7),
                "target_characters": target_chars,
                "emotion": judge_result.get("dominant_emotion", "neutral"),
            })

            transcript.append({
                "character": next_speaker_name,
                "message": full_response,
                "round": round_number,
                "phase": current_phase,
                "target_characters": target_chars,
                "emotion": judge_result.get("dominant_emotion", "neutral"),
            })

            # Save to character soul memory (tracked, not fire-and-forget)
            _track_task(debate_id, save_debate_turn(
                story_id=debate.story_id,
                character_name=next_speaker_name,
                message=full_response,
                debate_id=debate_id,
                round_number=round_number,
                divergence=debate.divergence_description,
            ))

            # ── 9. Heuristic repetition check (0 LLM calls) ──
            is_repeating = ledger.is_response_repeating(next_speaker_name, full_response, transcript[:-1])
            if is_repeating:
                callout_msg = await generate_orchestrator_message(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="call_out_repetition",
                    context={"speaker": next_speaker_name},
                )
                if callout_msg:
                    yield sse("orchestrator", {"message": callout_msg, "phase": current_phase, "event": "call_out_repetition", "target": next_speaker_name})
                    transcript.append({
                        "character": "Boru", "message": callout_msg,
                        "round": round_number, "phase": current_phase,
                        "isOrchestrator": True, "orchestratorEvent": "call_out_repetition",
                    })

            # ── 10. Process ledger result + Boru replies ──
            # Boru responds if character asked a direct question
            boru_question = _extract_boru_question(full_response)

            if ledger_update:
                # Ledger ran this turn — check if it detected a Boru question too
                if not ledger_update.get("addresses_boru") and not ledger_update.get("boru_question"):
                    if boru_question:
                        ledger_update["addresses_boru"] = True
                        ledger_update["boru_question"] = boru_question

                yield sse("ledger_update", {
                    "open_questions": ledger.open_questions[:10],
                    "resolved_questions": ledger.resolved_questions[-6:],
                    "claims": ledger.claims[-12:],
                    "positions": ledger.character_positions,
                    "progress": ledger.progress_summary,
                    "phase": current_phase,
                })

                # If character addressed Boru directly — Boru responds
                if ledger_update.get("addresses_boru") and ledger_update.get("boru_question"):
                    boru_question = ledger_update["boru_question"]

            # Boru responds if character asked a direct question (regardless of ledger turn)
            if boru_question:
                boru_reply = await generate_orchestrator_message(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="respond_to_character",
                    context={"speaker": next_speaker_name, "question": boru_question},
                )
                if boru_reply:
                    yield sse("orchestrator", {"message": boru_reply, "phase": current_phase, "event": "respond_to_character", "target": next_speaker_name})
                    transcript.append({
                        "character": "Boru", "message": boru_reply,
                        "round": round_number, "phase": current_phase,
                        "isOrchestrator": True, "orchestratorEvent": "respond_to_character",
                    })

            # ── 11. (Reactions removed — they cluttered the debate without adding to the what-if discussion) ──

            # ── 12. World observer — every 5 character turns ──
            if active_observers and should_invite_observer(transcript, last_observer_at, observer_interval=5):
                observer = random.choice(active_observers)
                obs_has_spoken = any(
                    e.get("isObserver") and e["character"] == observer["name"]
                    for e in transcript
                )
                obs_intro = await generate_orchestrator_message(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="observer_intro",
                    context={"observer_name": observer["name"], "is_returning": obs_has_spoken},
                )
                if obs_intro:
                    yield sse("orchestrator", {"message": obs_intro, "phase": current_phase, "event": "observer_intro", "target": observer["name"]})

                obs_response = ""
                try:
                    yield sse("observer_start", {
                        "observer_id": observer["id"],
                        "observer_name": observer["name"],
                        "era": observer.get("era", ""),
                    })
                    _asked_qs = [q["question"] for q in ledger.open_questions] + [q["question"] for q in ledger.resolved_questions]
                    async for token in observer_respond_stream(
                        observer=observer,
                        story_title=story.title or "",
                        divergence=debate.divergence_description,
                        debate_history=transcript,
                        characters=char_names,
                        already_asked=_asked_qs,
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

            # ── 13. Audience messages ──
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

                    yield sse("audience", {"name": audience_name, "message": audience_text, "directed_to": directed_to})
                    transcript.append({"character": audience_name, "message": audience_text, "round": round_number, "phase": current_phase, "isAudience": True})

                    boru_response = await generate_orchestrator_message(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="audience_question",
                        context={"audience_name": audience_name, "audience_message": audience_text, "directed_to": directed_to or ""},
                    )
                    if boru_response:
                        yield sse("orchestrator", {"message": boru_response, "phase": current_phase, "event": "audience_question", "target": directed_to or "all"})
                        transcript.append({"character": "Boru", "message": boru_response, "round": round_number, "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "audience_question"})

                    targets = [directed_to] if directed_to else char_names[:3]
                    ledger.add_question(audience_text, audience_name, targets)

            # ── 14. DB persist ──
            async with session_maker() as db:
                db_debate = (await db.execute(
                    select(Debate).where(Debate.id == debate_id)
                )).scalar_one()
                db_debate.transcript = transcript
                db_debate.round_count = round_number
                await db.commit()

            round_number += 1
            await asyncio.sleep(0.3)

        # Clean up audience queue
        _audience_queues.pop(debate_id, None)

        # ── Closing summary from Boru ──
        closing_msg = await generate_orchestrator_message(
            ledger, current_phase, transcript, characters, story.title or "",
            event_type="closing_summary",
        )
        if closing_msg:
            yield sse("orchestrator", {"message": closing_msg, "phase": "closing", "event": "closing_summary", "target": "all"})
            transcript.append({
                "character": "Boru",
                "message": closing_msg,
                "round": round_number,
                "phase": "closing",
                "isOrchestrator": True,
                "orchestratorEvent": "closing_summary",
            })

        # Synthesize debate summary first
        debate_summary = ""
        try:
            yield sse("summary_start", {"message": "Summarizing the debate..."})
            async for token in synthesize_debate_summary_stream(
                story_title=story.title or "the story",
                divergence_description=debate.divergence_description,
                debate_transcript=transcript,
                ledger=ledger,
            ):
                debate_summary += token
                yield sse("summary_token", {"text": token})
        except Exception as e:
            debate_summary = ""
            logger.warning(f"Debate summary failed (non-fatal): {e}")

        # Alternate ending + timeline + oracle removed — summary is the conclusion
        alternate_timeline = []
        alternate_world_state = {}

        yield sse("debate_end", {
            "debate_id": debate_id,
            "alternate_ending": alternate_ending,
            "debate_summary": debate_summary,
            "alternate_timeline": alternate_timeline,
            "total_rounds": round_number,
            "oracle_ready": bool(alternate_world_state),
        })

        # Character evolution — run in background after debate ends (tracked)
        _track_task(debate_id, evolve_characters_after_debate(
            story_id=debate.story_id,
            debate_id=debate_id,
            transcript=transcript,
            characters=characters,
            divergence=debate.divergence_description,
        ))

    finally:
        # Await any remaining background tasks before final persist
        tasks = _bg_tasks.pop(debate_id, [])
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        _audience_queues.pop(debate_id, None)
        _stop_signals.pop(debate_id, None)

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
    character_name: str = Field(..., min_length=1, max_length=200)
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[dict] = Field(default=[], max_length=50)


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
