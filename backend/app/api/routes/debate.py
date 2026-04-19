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


def _trim_to_complete_sentence(text: str) -> str:
    """Trim text to the last complete sentence — prevents mid-word cutoffs from token limits."""
    text = text.rstrip()
    if not text:
        return text
    # Already ends cleanly
    if text[-1] in '.!?"\u201d':
        return text
    # Find the last sentence-ending punctuation
    for i in range(len(text) - 1, max(len(text) - 200, -1), -1):
        if text[i] in '.!?':
            # Make sure it's not mid-abbreviation (e.g. "Mr.")
            if i + 1 < len(text) and text[i + 1] == ' ':
                return text[:i + 1]
            elif i == len(text) - 1:
                return text
    # No sentence end found — try em dash or ellipsis as natural break
    for end in [' —', '—', '...', '\n']:
        pos = text.rfind(end)
        if pos > len(text) // 2:
            return text[:pos].rstrip()
    # Last resort — return as-is rather than losing everything
    return text


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


def _is_addressing_boru(entry: dict) -> bool:
    """True only when a transcript entry EXPLICITLY addresses Boru.

    Prevents respond_to_character from firing whenever a character happens
    to mention Boru in passing — the sabha is meant to be a debate between
    characters, not a Q&A with the host.
    """
    targets = entry.get("target_characters") or []
    if "Boru" in targets or entry.get("target_character") == "Boru":
        return True
    msg = entry.get("message", "")
    # @Boru word-boundary, case-insensitive
    return bool(re.search(r"@boru\b", msg, re.IGNORECASE))


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


def _observer_topic_relevant(observer: dict, transcript: list) -> bool:
    """Check if recent transcript mentions keywords from observer's background."""
    # Keywords from observer name + era + background fields
    raw = " ".join(str(v) for v in observer.values() if isinstance(v, str))
    # Extract significant words (length 4+, lowercase)
    keywords = set(w.lower() for w in re.findall(r"\b\w{4,}\b", raw))
    # Exclude very generic words
    STOPWORDS = {"observer", "world", "that", "this", "with", "from", "have", "been", "were"}
    keywords -= STOPWORDS
    if not keywords:
        return False

    # Concatenate last 3-5 turns' messages
    recent_text = " ".join(
        str(e.get("message", ""))
        for e in transcript[-5:]
        if not e.get("isOrchestrator")
    ).lower()

    # Match if any keyword appears in recent text
    return any(kw in recent_text for kw in keywords)


def _should_observer_speak(
    round_number: int,
    last_observer_round: int,
    drama_score: float,
    transcript: list,
    observer: dict,
    introduced: set[str],
) -> tuple[bool, str]:
    """Decide if an observer should speak this turn.

    Returns (should_speak, mode) where mode is:
      "intro"   — first appearance, needs Boru's observer_intro first
      "organic" — subsequent appearance, observer speaks directly without intro
      ""        — don't speak this turn
    """
    # Cooldown: at least 5 turns since any observer spoke
    if round_number - last_observer_round < 5:
        return (False, "")

    obs_name = observer.get("name", "")
    relevant = _observer_topic_relevant(observer, transcript)

    # First appearance — Boru introduces
    if obs_name not in introduced:
        # Trigger on either:
        #   - moderate drama (0.45+) AND topic relevance, OR
        #   - round 6-9 as guaranteed early intro window
        if drama_score >= 0.45 and relevant:
            return (True, "intro")
        if 6 <= round_number <= 9:
            return (True, "intro")
        return (False, "")

    # Subsequent appearance — organic, no Boru intro, needs stronger triggers
    if drama_score < 0.6:
        return (False, "")
    if not relevant:
        return (False, "")
    return (True, "organic")


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
    # Organic observer state
    introduced_observers: set[str] = set()  # observer names Boru has formally introduced
    last_observer_round: int = -999          # round of last observer turn (any kind)

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
    phase_started_round = 0

    # Once set, no further chat-channel SSE events (character/observer/
    # orchestrator) should be yielded or appended to the transcript. The
    # debate is closed; only the narrator summary channel and debate_end
    # meta event are allowed through after this flag flips.
    sabha_closed: bool = False

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
    repetition_counts: dict[str, int] = {}   # {character: strike_count}
    correction_hints: dict[str, str] = {}    # {character: hint for next turn}

    is_first_round = True
    previous_phase = None

    # Boru authority state (Task 4b)
    pending_invitee: str | None = None   # character Boru just named; cleared when they speak
    # Secondary invitee — used when Boru names TWO characters (e.g.
    # force_confrontation / dispute_callout). After the primary invitee
    # speaks, this gets promoted to primary so both disputants get the mic.
    pending_invitee_secondary: str | None = None
    window_turn_count: int = 0           # character turns since Boru last spoke
    last_force_confrontation_round: int = -999   # global cooldown for force_confrontation events

    # Pair cooldown after break_duel / pair_duel rotation — prevents immediate
    # re-engagement. When a duel between two characters is broken, block that
    # exact pair from the character-question enforcement path for N rounds so
    # they can't simply re-duel two turns later.
    last_broken_pair: tuple[str, str] | None = None
    last_broken_pair_round: int = -999

    # Background ledger update tasks — flushed before any orchestrator message
    # generation / ledger-reading call so Boru sees an up-to-date ledger while
    # the turn loop otherwise runs without blocking on the ledger LLM call.
    pending_ledger_tasks: list[asyncio.Task] = []

    # ── Resolution-round state ──
    # Before letting the debate end with a pile of unanswered questions, we
    # allow Boru to force-ask the top-priority open questions and let the
    # normal turn loop force the target to answer. This caps how many such
    # forced rounds we run so it can't loop forever on impossible questions.
    RESOLUTION_QUESTION_CAP = 3   # trigger if more than this many open Qs remain
    MAX_RESOLUTION_ROUNDS = 4     # force up to this many answers before closing
    resolution_rounds_used: int = 0

    async def _flush_pending_ledger() -> None:
        """Wait for in-flight ledger updates to finish, then clear the list.

        Called right before any code path that reads the ledger (Boru
        orchestrator messages, should_end_debate, decide_phase_transition, and
        at debate end) so those readers see fully-applied updates.
        """
        if not pending_ledger_tasks:
            return
        await asyncio.gather(*pending_ledger_tasks, return_exceptions=True)
        pending_ledger_tasks.clear()

    async def _generate_boru_message_safely(*args, **kwargs):
        """Flush pending ledger tasks before asking Boru to speak so his
        prompt sees an up-to-date ledger."""
        await _flush_pending_ledger()
        return await generate_orchestrator_message(*args, **kwargs)

    async def _should_run_resolution() -> bool:
        """Return True if we should fire a resolution round instead of closing.

        Resolution kicks in when the debate is about to end but the ledger
        still carries more than RESOLUTION_QUESTION_CAP open questions that
        are directed to a participating character (i.e. actually resolvable).
        Caps at MAX_RESOLUTION_ROUNDS to prevent infinite loops on questions
        a character simply refuses/cannot answer.
        """
        if resolution_rounds_used >= MAX_RESOLUTION_ROUNDS:
            return False
        await _flush_pending_ledger()
        # Only count open questions with at least one valid participating target
        cast_names = {c["name"] for c in characters}
        open_count = sum(
            1 for q in ledger.open_questions
            if not q.get("_resolution_attempted")
            and any(d in cast_names for d in (q.get("directed_to") or []))
        )
        return open_count > RESOLUTION_QUESTION_CAP

    async def _prepare_resolution_question() -> dict | None:
        """Pick the top-priority open question and generate Boru's forced_question
        message for it. Does NOT yield SSE or append to transcript — the caller
        does that inline so yields happen from the outer async generator.

        Returns a dict with keys: message, target, intended_speaker, question_obj
        — or None if no suitable question could be forced.
        """
        cast_names = {c["name"] for c in characters}

        def _q_pri(q):
            if q.get("_resolution_attempted"):
                return -10   # lowest priority — don't re-pick
            directed = q.get("directed_to") or []
            has_valid_target = any(d in cast_names for d in directed)
            is_boru_asked = q.get("asked_by") == "Boru"
            return (2 if has_valid_target else 0) + (1 if is_boru_asked else 0)

        open_qs = list(ledger.open_questions)
        top = sorted(open_qs, key=_q_pri, reverse=True)
        for q in top:
            if q.get("_resolution_attempted"):
                continue
            target = next(
                (d for d in (q.get("directed_to") or []) if d in cast_names),
                None,
            )
            if not target:
                continue
            forced_msg, intended = await _generate_boru_message_safely(
                ledger, "closing", transcript, characters, story.title or "",
                event_type="forced_question",
                context={"target": target, "question": q.get("question", "")},
            )
            if not forced_msg:
                q["_resolution_attempted"] = True
                continue
            return {
                "message": forced_msg,
                "target": target,
                "intended_speaker": intended or target,
                "question_obj": q,
            }
        return None

    try:
        # ── Main debate loop — heuristic-driven, Boru intervenes only when needed ──
        while round_number < max_rounds:
            # Belt-and-braces: if the sabha was closed mid-loop (e.g. via user_stop),
            # bail out immediately so no further chat events get emitted.
            if sabha_closed:
                break
            # Per-iteration state init — ensures pivot blocks don't NameError on first iter
            next_speaker_name = None
            character = None
            forced = False
            second_speaker_name = None

            # ── 1. Stop signal ──
            if _stop_signals.pop(debate_id, False):
                stop_summary, intended = await _generate_boru_message_safely(
                    ledger, "closing", transcript, characters, story.title or "",
                    event_type="closing_summary",
                )
                if not stop_summary:
                    stop_summary = "The Sabha is concluded. What was said here will not be forgotten."
                yield sse("orchestrator", {"message": stop_summary, "phase": "closing", "event": "user_stop", "target": "all", "intended_speaker": intended})
                transcript.append({
                    "character": "Boru", "message": stop_summary, "round": round_number,
                    "phase": "closing", "isOrchestrator": True, "orchestratorEvent": "closing_summary",
                    "intended_speaker": intended,
                })
                # HARD STOP: this IS the closing summary for the user_stop path.
                # Prevent the post-loop closing_summary block from firing a second
                # Boru closing, and prevent any further chat-channel events below.
                sabha_closed = True
                break

            # Retire disputes that have gone stale — keeps ledger context fresh
            if round_number > 0 and round_number % 5 == 0:
                retired_count = ledger.retire_stale_disputes(round_number, stale_threshold=10)
                if retired_count:
                    logger.info(f"[DISPUTE] retired {retired_count} stale disputes at round {round_number}")

            # ── 2. End condition (check every 4th turn, or always in closing phase) ──
            if (current_phase == "closing" or round_number % 4 == 0) and round_number > 0:
                await _flush_pending_ledger()
                if await should_end_debate(ledger, current_phase, transcript, characters):
                    # Before ending: if there are too many unanswered questions,
                    # force Boru to ask the top-priority one and let the next
                    # turn resolve it. Cap prevents infinite loops.
                    if await _should_run_resolution():
                        rq = await _prepare_resolution_question()
                        if rq:
                            yield sse("orchestrator", {
                                "message": rq["message"],
                                "phase": "closing",
                                "event": "forced_question",
                                "target": rq["target"],
                                "intended_speaker": rq["intended_speaker"],
                                "resolution_round": True,
                            })
                            transcript.append({
                                "character": "Boru",
                                "message": rq["message"],
                                "round": round_number,
                                "phase": "closing",
                                "isOrchestrator": True,
                                "orchestratorEvent": "forced_question",
                                "intended_speaker": rq["intended_speaker"],
                                "resolution_round": True,
                            })
                            pending_invitee = rq["intended_speaker"]
                            resolution_rounds_used += 1
                            logger.info(
                                f"[RESOLUTION] round {resolution_rounds_used}/{MAX_RESOLUTION_ROUNDS} "
                                f"— forcing {rq['intended_speaker']} to answer"
                            )
                            # Fall through to enforcement gate so target speaks this turn.
                        else:
                            break
                    else:
                        break

            # ── 3. Phase transition (check every 3rd turn — phases last 5-8 turns) ──
            # Phase transitions should not override a pending invitee (observer/character
            # questions, Boru invitations) — let the invitee speak first, then transition
            # fires on a later cycle. Otherwise the phase-transition message's vocative
            # ("Snowball, …") parses back into pending_invitee and steals the floor from
            # whoever was already invited (e.g. Napoleon).
            if not pending_invitee and not is_first_round and round_number % 3 == 0:
                await _flush_pending_ledger()
                new_phase = await decide_phase_transition(
                    ledger, current_phase, transcript, characters,
                    phase_started_round=phase_started_round,
                    round_number=round_number,
                )
                if new_phase:
                    transition_msg, intended = await _generate_boru_message_safely(
                        ledger, new_phase, transcript, characters, story.title or "",
                        event_type="phase_transition",
                        context={"from_phase": current_phase, "to_phase": new_phase},
                    )
                    if transition_msg:
                        yield sse("orchestrator", {"message": transition_msg, "phase": new_phase, "event": "phase_transition", "target": "all", "intended_speaker": intended})
                        transcript.append({
                            "character": "Boru", "message": transition_msg, "round": round_number,
                            "phase": new_phase, "isOrchestrator": True, "orchestratorEvent": "phase_transition",
                            "intended_speaker": intended,
                        })
                        if intended:
                            pending_invitee = intended
                            # Pivot this turn's speaker to the invitee so Boru's word takes effect
                            # immediately, not on the next cycle.
                            if intended != next_speaker_name:
                                candidate = next((c for c in characters if c["name"] == intended), None)
                                if candidate:
                                    next_speaker_name = intended
                                    character = candidate
                                    forced = True
                                    # Clear second_speaker — we're now on Boru's floor
                                    second_speaker_name = None
                    previous_phase = current_phase
                    current_phase = new_phase
                    phase_started_round = round_number
                    if current_phase == "closing":
                        await _flush_pending_ledger()
                        if await should_end_debate(ledger, current_phase, transcript, characters):
                            # Resolution round before closing — see section 2 above.
                            if await _should_run_resolution():
                                rq = await _prepare_resolution_question()
                                if rq:
                                    yield sse("orchestrator", {
                                        "message": rq["message"],
                                        "phase": "closing",
                                        "event": "forced_question",
                                        "target": rq["target"],
                                        "intended_speaker": rq["intended_speaker"],
                                        "resolution_round": True,
                                    })
                                    transcript.append({
                                        "character": "Boru",
                                        "message": rq["message"],
                                        "round": round_number,
                                        "phase": "closing",
                                        "isOrchestrator": True,
                                        "orchestratorEvent": "forced_question",
                                        "intended_speaker": rq["intended_speaker"],
                                        "resolution_round": True,
                                    })
                                    pending_invitee = rq["intended_speaker"]
                                    resolution_rounds_used += 1
                                    logger.info(
                                        f"[RESOLUTION] round {resolution_rounds_used}/{MAX_RESOLUTION_ROUNDS} "
                                        f"— forcing {rq['intended_speaker']} to answer"
                                    )
                                    # Fall through to enforcement gate so target speaks this turn.
                                else:
                                    break
                            else:
                                break

            # ── ENFORCEMENT: if Boru has a pending invitation, that character MUST speak next ──
            next_speaker_name = None
            forced = False
            scores: dict[str, float] = {}
            if pending_invitee:
                next_speaker_name = pending_invitee
                forced = True
                character = next((c for c in characters if c["name"] == pending_invitee), None)
                if character is None:
                    # Invitee not in cast (shouldn't happen) — fall through to normal pick
                    pending_invitee = None
                    forced = False
                    next_speaker_name = None
                else:
                    # Compute scores only for diagnostics; nothing uses them while forced
                    scores = {n: (99.0 if n == next_speaker_name else 0.0)
                              for n in [c["name"] for c in characters]}

            if not pending_invitee:
                # ── 4. Pick speaker (HEURISTIC — 0 LLM calls) ──
                next_speaker_name, forced, scores = pick_next_speaker_with_scores(
                    transcript, characters, current_phase, round_number,
                )

            # Detect back-and-forth duels — if same 2 characters talked for 3+ turns, break it up
            duel_detected = False
            last_two: set[str] = set()
            if not forced:
                recent_speakers = [e["character"] for e in transcript[-6:]
                                   if not e.get("isOrchestrator") and not e.get("isReaction")
                                   and not e.get("isStageDirection") and not e.get("isObserver")]
                if len(recent_speakers) >= 4:
                    last_two = set(recent_speakers[-4:])
                    if len(last_two) <= 2 and next_speaker_name in last_two:
                        duel_detected = True
                        # Pick the best scorer EXCLUDING the two duelists
                        alt_scores = {k: v for k, v in scores.items() if k not in last_two and v > -100}
                        if alt_scores:
                            next_speaker_name = max(alt_scores, key=lambda k: alt_scores[k])

            # (Bug G fix: removed dual-speaker second_speaker_name selection — the
            # re-entry/enforcement/dispute logic rotates speakers well enough, and
            # the dual-turn path caused back-to-back repetition.)

            character = next((c for c in characters if c["name"] == next_speaker_name), None)
            if not character:
                break

            # ── 5. Boru speaks ONLY when needed ──
            boru_spoke_this_turn = False

            if not forced:
                # Boru breaks up duels with a witty interjection
                if duel_detected:
                    duel_msg, intended = await _generate_boru_message_safely(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="break_duel",
                        context={
                            "duelers": list(last_two),
                            "next_speaker": next_speaker_name,
                        },
                    )
                    if duel_msg:
                        yield sse("orchestrator", {"message": duel_msg, "phase": current_phase, "event": "break_duel", "target": next_speaker_name, "intended_speaker": intended})
                        transcript.append({
                            "character": "Boru", "message": duel_msg, "round": round_number,
                            "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "break_duel",
                            "intended_speaker": intended,
                        })
                        # Record the broken pair so they can't immediately re-duel
                        # via the character-question enforcement path.
                        if len(last_two) == 2:
                            _pair_list = sorted(last_two)
                            last_broken_pair = (_pair_list[0], _pair_list[1])
                            last_broken_pair_round = round_number
                        if intended:
                            pending_invitee = intended
                            # Pivot this turn's speaker to the invitee so Boru's word takes effect
                            # immediately, not on the next cycle.
                            if intended != next_speaker_name:
                                candidate = next((c for c in characters if c["name"] == intended), None)
                                if candidate:
                                    next_speaker_name = intended
                                    character = candidate
                                    forced = True
                                    # Clear second_speaker — we're now on Boru's floor
                                    second_speaker_name = None
                        boru_spoke_this_turn = True

                # ── 5b. Dispute escalation — Boru forces confrontation on long-unresolved disputes ──
                if not boru_spoke_this_turn and round_number > 6:
                    escalated = ledger.get_escalated_disputes(round_number)

                    # Compute silent ratio — rotation outranks dispute escalation when
                    # most of the cast hasn't spoken yet.
                    _speaker_turn_counts = {
                        c["name"]: sum(
                            1 for e in transcript
                            if e.get("character") == c["name"] and not e.get("isOrchestrator")
                        )
                        for c in characters
                    }
                    _silent = [n for n, t in _speaker_turn_counts.items() if t == 0]
                    _silent_ratio = len(_silent) / max(1, len(characters))

                    if escalated["tier3"] and _silent_ratio < 0.5:
                        # Global cooldown — don't fire force_confrontation more than once per N turns
                        from app.core.agents.sabha_orchestrator import DISPUTE_GLOBAL_COOLDOWN_TURNS
                        if round_number - last_force_confrontation_round < DISPUTE_GLOBAL_COOLDOWN_TURNS:
                            pass  # skip — still cooling down from previous force_confrontation
                        else:
                            # Tier 3: FORCE confrontation — override speakers
                            dispute = escalated["tier3"][0]
                            char_a = dispute["claim_a"]["character"]
                            char_b = dispute["claim_b"]["character"]
                            # Override next speaker to be one of the dispute parties
                            if next_speaker_name not in (char_a, char_b):
                                next_speaker_name = char_a
                                character = next((c for c in characters if c["name"] == next_speaker_name), character)
                            # (Bug G fix: removed second_speaker_name assignment. The opposing
                            # dispute party will be the natural next speaker via Boru's invitation
                            # / enforcement on the following turn.)
                            confront_msg, intended = await _generate_boru_message_safely(
                                ledger, current_phase, transcript, characters, story.title or "",
                                event_type="force_confrontation",
                                context={"char_a": char_a, "char_b": char_b,
                                         "claim_a": dispute["claim_a"]["claim"][:120],
                                         "claim_b": dispute["claim_b"]["claim"][:120],
                                         "turns": dispute["turns_unresolved"]},
                            )
                            if confront_msg:
                                # Validate: did the LLM actually address the intended dispute pair?
                                # If not, treat this as an invite_speaker event with the vocative target.
                                message_mentions_both = (
                                    char_a.lower() in confront_msg.lower() and char_b.lower() in confront_msg.lower()
                                )
                                effective_targets = [char_a, char_b]
                                effective_event = "force_confrontation"

                                if not message_mentions_both and intended:
                                    # LLM went off-script; re-tag as invite_speaker targeting the parsed vocative
                                    effective_targets = [intended]
                                    effective_event = "invite_speaker"
                                    logger.info(
                                        f"[FORCE] LLM skipped dispute {char_a} vs {char_b}, message addresses "
                                        f"{intended} instead — re-tagging as invite_speaker"
                                    )

                                yield sse("orchestrator", {
                                    "message": confront_msg,
                                    "phase": current_phase,
                                    "event": effective_event,
                                    "target": effective_targets[0] if effective_targets else "all",
                                    "target_characters": effective_targets,
                                    "intended_speaker": intended,
                                })
                                transcript.append({
                                    "character": "Boru",
                                    "message": confront_msg,
                                    "round": round_number,
                                    "phase": current_phase,
                                    "isOrchestrator": True,
                                    "orchestratorEvent": effective_event,
                                    "intended_speaker": intended,
                                    "target_characters": effective_targets,
                                })
                                if intended:
                                    pending_invitee = intended
                                    # If Boru's confrontation names a SECOND disputant,
                                    # queue them to speak right after the primary. This
                                    # guarantees both sides of the dispute get the mic.
                                    if intended == char_a and char_b != char_a:
                                        pending_invitee_secondary = char_b
                                    elif intended == char_b and char_a != char_b:
                                        pending_invitee_secondary = char_a
                                    # Pivot this turn's speaker to the invitee so Boru's word takes effect
                                    # immediately, not on the next cycle.
                                    if intended != next_speaker_name:
                                        candidate = next((c for c in characters if c["name"] == intended), None)
                                        if candidate:
                                            next_speaker_name = intended
                                            character = candidate
                                            forced = True
                                            # Clear second_speaker — we're now on Boru's floor
                                            second_speaker_name = None
                                boru_spoke_this_turn = True
                            # Increment OUTSIDE the `if confront_msg:` branch so the
                            # dispute retires after 2 fires even if message generation
                            # returned empty — prevents infinite-retry loops.
                            dispute["_last_escalation_turn"] = round_number
                            last_force_confrontation_round = round_number
                            dispute["_force_count"] = dispute.get("_force_count", 0) + 1
                            logger.info(
                                f"[FORCE] dispute {dispute.get('id')} fired, "
                                f"count={dispute['_force_count']}"
                            )
                            # Retire the dispute after 2 fires — no further escalation, and remove from
                            # "unresolved" pool so the ledger context stops surfacing it every turn.
                            if dispute["_force_count"] >= 2:
                                dispute["status"] = "resolved_by_escalation"
                                logger.info(
                                    f"[DISPUTE] {dispute.get('id', '?')} retired as resolved_by_escalation "
                                    f"after {dispute['_force_count']} escalations"
                                )

                    elif escalated["tier2"] and _silent_ratio < 0.5:
                        # Tier 2: Boru calls it out
                        dispute = escalated["tier2"][0]
                        callout_char_a = dispute["claim_a"]["character"]
                        callout_char_b = dispute["claim_b"]["character"]
                        callout_msg, intended = await _generate_boru_message_safely(
                            ledger, current_phase, transcript, characters, story.title or "",
                            event_type="dispute_callout",
                            context={"char_a": callout_char_a,
                                     "char_b": callout_char_b,
                                     "claim_a": dispute["claim_a"]["claim"][:120],
                                     "claim_b": dispute["claim_b"]["claim"][:120],
                                     "turns": dispute["turns_unresolved"]},
                        )
                        if callout_msg:
                            # Validate: did the LLM actually address the intended dispute pair?
                            # If not, treat this as an invite_speaker event with the vocative target.
                            callout_mentions_both = (
                                callout_char_a.lower() in callout_msg.lower()
                                and callout_char_b.lower() in callout_msg.lower()
                            )
                            effective_targets = [callout_char_a, callout_char_b]
                            effective_event = "dispute_callout"

                            if not callout_mentions_both and intended:
                                # LLM went off-script; re-tag as invite_speaker targeting the parsed vocative
                                effective_targets = [intended]
                                effective_event = "invite_speaker"
                                logger.info(
                                    f"[CALLOUT] LLM skipped dispute {callout_char_a} vs {callout_char_b}, "
                                    f"message addresses {intended} instead — re-tagging as invite_speaker"
                                )

                            yield sse("orchestrator", {
                                "message": callout_msg,
                                "phase": current_phase,
                                "event": effective_event,
                                "target": effective_targets[0] if effective_targets else "all",
                                "target_characters": effective_targets,
                                "intended_speaker": intended,
                            })
                            transcript.append({
                                "character": "Boru",
                                "message": callout_msg,
                                "round": round_number,
                                "phase": current_phase,
                                "isOrchestrator": True,
                                "orchestratorEvent": effective_event,
                                "intended_speaker": intended,
                                "target_characters": effective_targets,
                            })
                            if intended:
                                pending_invitee = intended
                                # Queue the other disputant to speak after the primary —
                                # both sides of the dispute should respond when Boru calls
                                # it out.
                                if intended == callout_char_a and callout_char_b != callout_char_a:
                                    pending_invitee_secondary = callout_char_b
                                elif intended == callout_char_b and callout_char_a != callout_char_b:
                                    pending_invitee_secondary = callout_char_a
                                # Pivot this turn's speaker to the invitee so Boru's word takes effect
                                # immediately, not on the next cycle.
                                if intended != next_speaker_name:
                                    candidate = next((c for c in characters if c["name"] == intended), None)
                                    if candidate:
                                        next_speaker_name = intended
                                        character = candidate
                                        forced = True
                                        # Clear second_speaker — we're now on Boru's floor
                                        second_speaker_name = None
                            boru_spoke_this_turn = True
                        dispute["_last_escalation_turn"] = round_number

            if is_first_round:
                # Grand opening — introduce himself + topic
                opening_msg, intended = await _generate_boru_message_safely(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="opening_with_invite",
                    context={"speakers": char_names, "divergence": debate.divergence_description},
                )
                if opening_msg:
                    yield sse("orchestrator", {"message": opening_msg, "phase": current_phase, "event": "opening", "target": "all", "intended_speaker": intended})
                    transcript.append({
                        "character": "Boru", "message": opening_msg, "round": round_number,
                        "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "opening_with_invite",
                        "intended_speaker": intended,
                    })
                    if intended:
                        pending_invitee = intended
                        # Pivot this turn's speaker to the invitee so Boru's word takes effect
                        # immediately, not on the next cycle.
                        if intended != next_speaker_name:
                            candidate = next((c for c in characters if c["name"] == intended), None)
                            if candidate:
                                next_speaker_name = intended
                                character = candidate
                                forced = True
                                # Clear second_speaker — we're now on Boru's floor
                                second_speaker_name = None
                    boru_spoke_this_turn = True
                is_first_round = False

            # ── Pair-duel detection: if the last 5 character turns are all by the same
            # 2 characters, treat it as a duel and force Boru to re-enter regardless of
            # drama. Rotates in a silent voice to break the ping-pong.
            recent_char_turns = [
                e["character"] for e in transcript[-8:]
                if not e.get("isOrchestrator")
                and not e.get("isObserver")
                and not e.get("isReaction")
            ]
            same_pair_duel = False
            if len(recent_char_turns) >= 5:
                last_five = recent_char_turns[-5:]
                unique = set(last_five)
                if len(unique) <= 2:
                    same_pair_duel = True

            if same_pair_duel and not forced and not boru_spoke_this_turn:
                from app.core.agents.reentry_logic import select_boru_intent
                _speaker_diversity = {
                    c["name"]: sum(
                        1 for e in transcript
                        if e.get("character") == c["name"] and not e.get("isOrchestrator")
                    )
                    for c in characters
                }
                _intent, _ctx = select_boru_intent(
                    reason="pair_duel",
                    tier3_dispute=None,
                    phase_change=None,
                    open_questions=[],
                    speaker_diversity=_speaker_diversity,
                )
                pair_duel_target = _ctx.get("speaker")
                if pair_duel_target and pair_duel_target not in recent_char_turns[-5:]:
                    pair_duel_msg, intended = await _generate_boru_message_safely(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="invite_speaker",
                        context={
                            "speaker": pair_duel_target,
                            "directive": _ctx.get("directive",
                                "two speakers have been locked in exchange — bring a fresh voice on the issue they've been circling"),
                        },
                    )
                    if pair_duel_msg:
                        yield sse("orchestrator", {
                            "message": pair_duel_msg,
                            "phase": current_phase,
                            "event": "invite_speaker",
                            "target": pair_duel_target,
                            "target_characters": [pair_duel_target],
                            "intended_speaker": intended,
                            "_rotation": True,
                        })
                        transcript.append({
                            "character": "Boru", "message": pair_duel_msg, "round": round_number,
                            "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "invite_speaker",
                            "intended_speaker": intended,
                            "target_characters": [pair_duel_target],
                            "_rotation": True,
                            "_pair_duel": True,
                        })
                        logger.info(
                            f"[PAIR_DUEL] last 5 turns by {set(recent_char_turns[-5:])} — "
                            f"invited {pair_duel_target}"
                        )
                        # Record the broken pair so they can't immediately re-duel
                        # via the character-question enforcement path.
                        if len(unique) == 2:
                            _pair_list = sorted(unique)
                            last_broken_pair = (_pair_list[0], _pair_list[1])
                            last_broken_pair_round = round_number
                        if intended:
                            pending_invitee = intended
                            if intended != next_speaker_name:
                                candidate = next((c for c in characters if c["name"] == intended), None)
                                if candidate:
                                    next_speaker_name = intended
                                    character = candidate
                                    forced = True
                                    second_speaker_name = None
                        boru_spoke_this_turn = True

            # ── Silent-character rotation: if voices are being left out, Boru pulls them in ──
            if not forced and not boru_spoke_this_turn and round_number >= 5:
                speaker_turn_counts = {
                    c["name"]: sum(
                        1 for e in transcript
                        if e.get("character") == c["name"] and not e.get("isOrchestrator")
                    )
                    for c in characters
                }
                silent = [n for n, t in speaker_turn_counts.items() if t == 0]
                # Fire when >=40% of the cast is silent OR at least 3 silent characters exist.
                # In large casts (15+ silent of 19), this triggers aggressively; in small casts
                # (2 of 3 silent), the ratio check still fires. Avoids the "only 1 silent left"
                # edge where a single straggler keeps triggering.
                silent_ratio = len(silent) / max(1, len(characters))
                if silent_ratio >= 0.4 or len(silent) >= 3:
                    # Cooldown: don't rotate two turns in a row.
                    # Widened window to 6 and loosened to any _rotation marker,
                    # letting the trigger condition itself be more assertive.
                    recent_orch = [e for e in transcript[-6:] if e.get("isOrchestrator")]
                    recent_rotation = any(
                        e.get("_rotation") is True
                        for e in recent_orch
                    )
                    if not recent_rotation:
                        # Pick the silent character at the lowest index of the characters list
                        # (stable, deterministic — matches how the picker scores ties today)
                        rotate_target = next((c["name"] for c in characters if c["name"] in silent), None)
                        if rotate_target:
                            rotation_msg, intended = await _generate_boru_message_safely(
                                ledger, current_phase, transcript, characters, story.title or "",
                                event_type="invite_speaker",
                                context={
                                    "speaker": rotate_target,
                                    "directive": (
                                        f"{rotate_target} hasn't spoken yet — bring them into the "
                                        f"debate with a sharp question rooted in what's been argued."
                                    ),
                                },
                            )
                            if rotation_msg:
                                yield sse("orchestrator", {
                                    "message": rotation_msg,
                                    "phase": current_phase,
                                    "event": "invite_speaker",
                                    "target": intended or rotate_target,
                                    "intended_speaker": intended or rotate_target,
                                    "_rotation": True,
                                })
                                transcript.append({
                                    "character": "Boru",
                                    "message": rotation_msg,
                                    "round": round_number,
                                    "phase": current_phase,
                                    "isOrchestrator": True,
                                    "orchestratorEvent": "invite_speaker",
                                    "intended_speaker": intended or rotate_target,
                                    "_rotation": True,
                                })
                                boru_spoke_this_turn = True
                                if intended or rotate_target:
                                    pending_invitee = intended or rotate_target
                                    # Pivot this turn to the rotated character
                                    if pending_invitee != next_speaker_name:
                                        candidate = next((c for c in characters if c["name"] == pending_invitee), None)
                                        if candidate:
                                            next_speaker_name = pending_invitee
                                            character = candidate
                                            forced = True
                                            second_speaker_name = None

            if not forced and not boru_spoke_this_turn:
                # Stall detection: if all scores are flat, Boru intervenes (skip if duel already handled)
                valid_scores = [v for v in scores.values() if v > -100]
                is_stalling = valid_scores and max(valid_scores) < 1.0 and round_number > len(characters)
                if is_stalling:
                    # Pick a forced question from the ledger or redirect
                    await _flush_pending_ledger()
                    open_qs = ledger.open_questions[:1]
                    if open_qs:
                        forced_msg, intended = await _generate_boru_message_safely(
                            ledger, current_phase, transcript, characters, story.title or "",
                            event_type="forced_question",
                            context={"target": next_speaker_name, "question": open_qs[0]["question"]},
                        )
                        if forced_msg:
                            yield sse("orchestrator", {"message": forced_msg, "phase": current_phase, "event": "forced_question", "target": next_speaker_name, "intended_speaker": intended})
                            transcript.append({
                                "character": "Boru", "message": forced_msg, "round": round_number,
                                "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "forced_question",
                                "intended_speaker": intended,
                            })
                            if intended:
                                pending_invitee = intended
                                # Pivot this turn's speaker to the invitee so Boru's word takes effect
                                # immediately, not on the next cycle.
                                if intended != next_speaker_name:
                                    candidate = next((c for c in characters if c["name"] == intended), None)
                                    if candidate:
                                        next_speaker_name = intended
                                        character = candidate
                                        forced = True
                                        # Clear second_speaker — we're now on Boru's floor
                                        second_speaker_name = None
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
                    correction_hint=correction_hints.pop(next_speaker_name, None),
                    exploration_hint=exploration_hint,
                    memory_context=memory_context,
                    observer_challenge=observer_challenge,
                    pending_questions=_pqs,
                    ledger=ledger,
                    current_phase=current_phase,
                    round_number=round_number,
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

                # Trim to last complete sentence — prevents mid-word cutoffs
                full_response = _trim_to_complete_sentence(full_response)

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

            # ── 7. Judge (awaited) + Ledger (fire-and-track) ──
            # Judge result is needed immediately for target resolution / SSE.
            # Ledger update runs in background; it's flushed before Boru next
            # reads the ledger (any orchestrator message / phase decision / end
            # check). This removes the per-turn ~2-5s ledger LLM wait.
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

            # Fire ledger update in background — don't block the turn loop.
            if round_number % 2 == 0:
                _ledger_task = asyncio.create_task(
                    update_ledger(
                        ledger, next_speaker_name, full_response, transcript,
                        observer_names=obs_names, round_number=round_number,
                    )
                )
                pending_ledger_tasks.append(_ledger_task)

            judge_result = await _run_judge()
            ledger_update = None

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

            # If this character was just forced to respond to a Boru invitation
            # (pending_invitee was set for them and they're now speaking), inject Boru
            # into target_characters so the interaction graph draws a response arrow to him.
            # This runs BEFORE pending_invitee is cleared later in the cycle.
            responded_to_boru = False
            if forced and next_speaker_name == pending_invitee:
                responded_to_boru = True
                if "Boru" not in target_chars:
                    target_chars = list(target_chars) + ["Boru"]

            yield sse("character_end", {
                "character": next_speaker_name,
                "message": full_response,
                "round": round_number,
                "judge_score": judge_result.get("score", 7),
                "target_characters": target_chars,
                "emotion": judge_result.get("dominant_emotion", "neutral"),
                "responded_to_boru": responded_to_boru,
            })

            transcript.append({
                "character": next_speaker_name,
                "message": full_response,
                "round": round_number,
                "phase": current_phase,
                "target_characters": target_chars,
                "emotion": judge_result.get("dominant_emotion", "neutral"),
                "responded_to_boru": responded_to_boru,
            })

            # Clear pending invitee if satisfied. If a secondary invitee is
            # queued (force_confrontation / dispute_callout named two
            # disputants), promote them to primary so they speak next before
            # normal rotation resumes.
            if pending_invitee and pending_invitee == next_speaker_name:
                if pending_invitee_secondary:
                    pending_invitee = pending_invitee_secondary
                    pending_invitee_secondary = None
                    # Don't reset window_turn_count — we're still on Boru's floor.
                    logger.info(
                        f"[PENDING] primary satisfied; promoting secondary={pending_invitee}"
                    )
                else:
                    pending_invitee = None
                    window_turn_count = 0
            else:
                window_turn_count += 1

            # ── Character-to-character question enforcement ──
            # If the character just asked a directed question (has targets +
            # speech_act "question"), the target MUST answer next. Only sets
            # pending_invitee if nothing's already queued (respect Boru's
            # existing queue and force_confrontation's A-then-B chain).
            if not pending_invitee and not pending_invitee_secondary:
                from app.core.agents.speech_act import classify_speech_act, extract_question_target
                effective_targets = target_chars  # emitted targets from SSE payload
                if effective_targets:
                    act = classify_speech_act(full_response, effective_targets)
                    if act == "question":
                        # Use weighted vocative scoring — @Name or Name, in the question
                        # sentence beats first-in-list.
                        q_target = extract_question_target(full_response, effective_targets)
                        # Fall back to first non-Boru target if parser returns None
                        if q_target is None or q_target == "Boru" or not any(c["name"] == q_target for c in characters):
                            q_target = next(
                                (t for t in effective_targets
                                 if t and t != "Boru" and any(c["name"] == t for c in characters)),
                                None,
                            )
                        # Pair cooldown: if q_target is in the recently-broken pair AND
                        # the asker is also in that pair, block the enforcement so the
                        # pair doesn't immediately re-duel after Boru broke them up.
                        if (
                            q_target
                            and last_broken_pair
                            and round_number - last_broken_pair_round < 6
                            and q_target in last_broken_pair
                            and next_speaker_name in last_broken_pair
                        ):
                            logger.info(
                                f"[PAIR-COOLDOWN] Blocking {next_speaker_name}->{q_target} re-engagement "
                                f"(pair broken at round {last_broken_pair_round}, current {round_number})"
                            )
                            q_target = None   # skip enforcement, let picker find someone else
                        if q_target:
                            pending_invitee = q_target
                            logger.info(
                                f"[Q-ENFORCE] {next_speaker_name} asked {q_target} — pending_invitee set"
                            )

            # Save to character soul memory (tracked, not fire-and-forget)
            _track_task(debate_id, save_debate_turn(
                story_id=debate.story_id,
                character_name=next_speaker_name,
                message=full_response,
                debate_id=debate_id,
                round_number=round_number,
                divergence=debate.divergence_description,
            ))

            # ── 9. Heuristic repetition check (0 LLM calls) — escalating warnings ──
            is_repeating = ledger.is_response_repeating(next_speaker_name, full_response, transcript[:-1])
            if is_repeating:
                # Track repeat offenders
                repetition_counts[next_speaker_name] = repetition_counts.get(next_speaker_name, 0) + 1
                strike = repetition_counts[next_speaker_name]

                callout_msg, intended = await _generate_boru_message_safely(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="call_out_repetition",
                    context={
                        "speaker": next_speaker_name,
                        "strike": strike,
                    },
                )
                if callout_msg:
                    yield sse("orchestrator", {"message": callout_msg, "phase": current_phase, "event": "call_out_repetition", "target": next_speaker_name, "intended_speaker": intended})
                    transcript.append({
                        "character": "Boru", "message": callout_msg,
                        "round": round_number, "phase": current_phase,
                        "isOrchestrator": True, "orchestratorEvent": "call_out_repetition",
                        "intended_speaker": intended,
                    })
                    if intended:
                        pending_invitee = intended
                        # Pivot this turn's speaker to the invitee so Boru's word takes effect
                        # immediately, not on the next cycle. (Character already spoke this cycle,
                        # so this mainly clears any queued second speaker.)
                        if intended != next_speaker_name:
                            candidate = next((c for c in characters if c["name"] == intended), None)
                            if candidate:
                                next_speaker_name = intended
                                character = candidate
                                forced = True
                                # Clear second_speaker — we're now on Boru's floor
                                second_speaker_name = None

                # Store correction hint — injected into this character's NEXT turn
                correction_hints[next_speaker_name] = (
                    f"WARNING: Boru just called you out for repeating yourself (strike {strike}). "
                    f"You MUST say something completely NEW. If you repeat the same idea even slightly, "
                    f"you will be silenced. Change your angle entirely — attack a different character, "
                    f"raise a new consequence, confess something you've been hiding, or flip your position."
                )

            # ── 10. Boru replies — heuristic-only detection ──
            # Since ledger runs in the background now, the LLM-derived
            # `addresses_boru` / `boru_question` fields are no longer available
            # synchronously. Fall back to the heuristic _extract_boru_question
            # + _is_addressing_boru pair (same fallback the original code used
            # when the LLM didn't detect it).
            boru_question = _extract_boru_question(full_response)

            # Emit a best-effort ledger snapshot every other turn so the
            # frontend keeps updating. Snapshot reflects the state BEFORE this
            # turn's ledger update lands — the delta arrives on a later turn,
            # which matches the previous "update_ledger every 2nd turn"
            # cadence that already produced sparse updates.
            if round_number % 2 == 0:
                yield sse("ledger_update", {
                    "open_questions": ledger.open_questions[:10],
                    "resolved_questions": ledger.resolved_questions[-6:],
                    "claims": ledger.claims[-12:],
                    "positions": ledger.character_positions,
                    "progress": ledger.progress_summary,
                    "phase": current_phase,
                })

            # Boru responds ONLY if the character EXPLICITLY addressed Boru —
            # via target_characters/target_character OR an @Boru mention. A mere
            # rhetorical mention of "Boru" in the response is not enough: the
            # sabha is a debate between characters, not a Q&A with the host.
            last_turn_entry = transcript[-1] if transcript else {}
            if boru_question and _is_addressing_boru(last_turn_entry):
                boru_reply, intended = await _generate_boru_message_safely(
                    ledger, current_phase, transcript, characters, story.title or "",
                    event_type="respond_to_character",
                    context={"speaker": next_speaker_name, "question": boru_question},
                )
                if boru_reply:
                    yield sse("orchestrator", {"message": boru_reply, "phase": current_phase, "event": "respond_to_character", "target": next_speaker_name, "intended_speaker": intended})
                    transcript.append({
                        "character": "Boru", "message": boru_reply,
                        "round": round_number, "phase": current_phase,
                        "isOrchestrator": True, "orchestratorEvent": "respond_to_character",
                        "intended_speaker": intended,
                    })
                    if intended:
                        pending_invitee = intended
                        # Pivot this turn's speaker to the invitee so Boru's word takes effect
                        # immediately, not on the next cycle. (Character already spoke this cycle,
                        # so this mainly clears any queued second speaker.)
                        if intended != next_speaker_name:
                            candidate = next((c for c in characters if c["name"] == intended), None)
                            if candidate:
                                next_speaker_name = intended
                                character = candidate
                                forced = True
                                # Clear second_speaker — we're now on Boru's floor
                                second_speaker_name = None

            # ── 11. (Reactions removed — they cluttered the debate without adding to the what-if discussion) ──

            # ── 12. World observer — organic appearance ──
            # Boru introduces each observer on first appearance; afterwards they
            # chime in organically when drama is high, topic matches their
            # background, cooldown has elapsed, and nothing is pending.
            observer = None
            observer_mode = ""
            if (not forced and not pending_invitee and not boru_spoke_this_turn
                    and active_observers):
                drama = orch_drama_score(transcript)
                for _candidate_obs in active_observers:
                    should, mode = _should_observer_speak(
                        round_number, last_observer_round, drama,
                        transcript, _candidate_obs, introduced_observers,
                    )
                    if should:
                        observer = _candidate_obs
                        observer_mode = mode
                        break

            if observer is not None:
                # First appearance: Boru formally introduces the observer.
                if observer_mode == "intro":
                    obs_intro, intended = await _generate_boru_message_safely(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="observer_intro",
                        context={"observer_name": observer["name"], "is_returning": False},
                    )
                    if obs_intro:
                        yield sse("orchestrator", {"message": obs_intro, "phase": current_phase, "event": "observer_intro", "target": observer["name"], "intended_speaker": intended})
                        # Record Boru's intro in the transcript so downstream logic sees it —
                        # and so the observer's turn (emitted immediately below) is clearly
                        # linked to Boru's invitation rather than a random character turn.
                        transcript.append({
                            "character": "Boru", "message": obs_intro, "round": round_number,
                            "phase": current_phase, "isOrchestrator": True,
                            "orchestratorEvent": "observer_intro",
                            "intended_speaker": observer["name"],
                        })
                        introduced_observers.add(observer["name"])
                        boru_spoke_this_turn = True

                # Emit the observer's turn immediately in the SAME loop iteration
                # (both for intro and organic modes).
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
                        transcript.append({
                            "character": observer["name"], "message": obs_response,
                            "round": round_number, "phase": current_phase,
                            "isObserver": True, "observerEra": observer.get("era", ""),
                        })

                        # ── Observer question target enforcement ──
                        # Observer messages use "→ Target: question?" format.
                        # Force the target to respond next cycle.
                        if not pending_invitee and not pending_invitee_secondary:
                            # Match "→ Name: ..." or "-> Name: ..." (unicode arrow or ASCII)
                            m = re.search(r"[→>]\s*([A-Z][A-Za-z.\s'-]*?)\s*[:?]", obs_response)
                            if m:
                                candidate = m.group(1).strip().rstrip(".,;")
                                # Validate it's a participating character
                                if any(c["name"] == candidate for c in characters):
                                    pending_invitee = candidate
                                    logger.info(
                                        f"[Q-ENFORCE] Observer {observer['name']} asked {candidate} — pending_invitee set"
                                    )

                        # Boru defends the Sabha — if observer is dismissive or mocking, fire back
                        dismissive_signals = ["naive", "naivety", "laughable", "absurd", "pathetic",
                            "foolish", "amusing", "quaint", "primitive", "savage", "uncivilized",
                            "beneath", "incompetent", "hopeless", "deluded", "children", "playing"]
                        obs_lower = obs_response.lower()
                        is_dismissive = sum(1 for w in dismissive_signals if w in obs_lower) >= 2
                        if is_dismissive:
                            boru_defense, intended = await _generate_boru_message_safely(
                                ledger, current_phase, transcript, characters, story.title or "",
                                event_type="defend_sabha",
                                context={
                                    "observer_name": observer["name"],
                                    "observer_era": observer.get("era", "unknown era"),
                                    "observer_message": obs_response[:200],
                                    "observer_blindspot": observer.get("blindspot", ""),
                                },
                            )
                            if boru_defense:
                                yield sse("orchestrator", {"message": boru_defense, "phase": current_phase, "event": "defend_sabha", "target": observer["name"], "intended_speaker": intended})
                                transcript.append({
                                    "character": "Boru", "message": boru_defense,
                                    "round": round_number, "phase": current_phase,
                                    "isOrchestrator": True, "orchestratorEvent": "defend_sabha",
                                    "intended_speaker": intended,
                                })
                                if intended:
                                    pending_invitee = intended
                                    # Pivot this turn's speaker to the invitee so Boru's word takes effect
                                    # immediately, not on the next cycle. (Character already spoke this cycle,
                                    # so this mainly clears any queued second speaker.)
                                    if intended != next_speaker_name:
                                        candidate = next((c for c in characters if c["name"] == intended), None)
                                        if candidate:
                                            next_speaker_name = intended
                                            character = candidate
                                            forced = True
                                            # Clear second_speaker — we're now on Boru's floor
                                            second_speaker_name = None

                        last_observer_at = len(transcript)
                        last_observer_round = round_number
                except Exception as obs_exc:
                    logger.warning(f"Observer failed (non-fatal): {obs_exc}")
                    last_observer_at = len(transcript)  # reset timer even on failure
                    last_observer_round = round_number

            # ── 12b. (Bug G fix: removed dual-speaker consumer block — caused
            # back-to-back repetition when second speaker was the same as or adjacent
            # to the primary speaker.) ──

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

                    boru_response, intended = await _generate_boru_message_safely(
                        ledger, current_phase, transcript, characters, story.title or "",
                        event_type="audience_question",
                        context={"audience_name": audience_name, "audience_message": audience_text, "directed_to": directed_to or ""},
                    )
                    if boru_response:
                        yield sse("orchestrator", {"message": boru_response, "phase": current_phase, "event": "audience_question", "target": directed_to or "all", "intended_speaker": intended})
                        transcript.append({
                            "character": "Boru", "message": boru_response, "round": round_number,
                            "phase": current_phase, "isOrchestrator": True, "orchestratorEvent": "audience_question",
                            "intended_speaker": intended,
                        })
                        if intended:
                            pending_invitee = intended
                            # Pivot this turn's speaker to the invitee so Boru's word takes effect
                            # immediately, not on the next cycle. (Character already spoke this cycle,
                            # so this mainly clears any queued second speaker.)
                            if intended != next_speaker_name:
                                candidate = next((c for c in characters if c["name"] == intended), None)
                                if candidate:
                                    next_speaker_name = intended
                                    character = candidate
                                    forced = True
                                    # Clear second_speaker — we're now on Boru's floor
                                    second_speaker_name = None

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

        # ── Closing summary from Boru — with structured verdict ──
        # Flush before reading the ledger for the verdict, so no late updates
        # are lost from the closing context.
        # Skip this block entirely if the sabha was already closed earlier
        # (e.g. user_stop path already emitted a closing summary).
        if not sabha_closed:
            await _flush_pending_ledger()
            verdict = ledger.generate_closing_verdict()
            closing_msg, intended = await _generate_boru_message_safely(
                ledger, current_phase, transcript, characters, story.title or "",
                event_type="closing_summary",
                context=verdict,
            )
            if closing_msg:
                yield sse("orchestrator", {"message": closing_msg, "phase": "closing", "event": "closing_summary", "target": "all", "intended_speaker": intended})
                transcript.append({
                    "character": "Boru",
                    "message": closing_msg,
                    "round": round_number,
                    "phase": "closing",
                    "isOrchestrator": True,
                    "orchestratorEvent": "closing_summary",
                    "intended_speaker": intended,
                })
            # HARD STOP: once closing_summary has been emitted, no further chat
            # events (character / observer / orchestrator) may be yielded or
            # appended to the transcript. Narrator summary streaming below
            # flows to a separate summary channel (not the transcript) and is
            # allowed to continue.
            sabha_closed = True

        # Synthesize debate summary first
        debate_summary = ""
        try:
            # Make sure any in-flight ledger updates are applied before the
            # narrator reads `ledger` for the closing summary.
            await _flush_pending_ledger()
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
        # Final flush — any in-flight ledger updates must complete before we
        # snapshot the ledger into the DB, otherwise the saved state can lag
        # behind the transcript by one or two turns.
        await _flush_pending_ledger()
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
            db_debate.alternate_ending = debate_summary or alternate_ending or db_debate.alternate_ending
            db_debate.alternate_timeline = alternate_timeline or db_debate.alternate_timeline
            if alternate_world_state:
                db_debate.alternate_world_state = alternate_world_state
            # Save ledger snapshot for replay
            db_debate.ledger_snapshot = {
                "positions": ledger.character_positions,
                "claims": ledger.claims[-20:],
                "open_questions": ledger.open_questions,
                "resolved_questions": ledger.resolved_questions,
                "disputes": ledger.disputes,
                "progress": ledger.progress_summary or "",
            }
            db_debate.status = "completed" if alternate_ending else "interrupted"
            db_debate.round_count = round_number
            db_debate.transcript = transcript  # save final transcript too
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


@router.get("/{debate_id}/tts/{turn_index}")
async def get_turn_audio(debate_id: str, turn_index: int, db: AsyncSession = Depends(get_db)):
    """Generate TTS audio for a specific debate turn. Returns MP3."""
    from app.core.tts import generate_speech, assign_voices_to_cast, BORU_VOICE

    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")

    transcript = debate.transcript or []
    if turn_index < 0 or turn_index >= len(transcript):
        raise HTTPException(status_code=404, detail="Turn not found.")

    entry = transcript[turn_index]
    text = entry.get("message", "")
    if not text:
        raise HTTPException(status_code=400, detail="Empty message.")

    character_name = entry.get("character", "")

    story_result = await db.execute(select(Story).where(Story.id == debate.story_id))
    story = story_result.scalar_one_or_none()
    characters = story.analysis.get("characters", []) if story and story.analysis else []

    voice_assignments = assign_voices_to_cast(characters)

    if entry.get("isOrchestrator") or character_name == "Boru":
        voice = BORU_VOICE
    else:
        voice = voice_assignments.get(character_name, BORU_VOICE)

    emotion = entry.get("emotion", "neutral")
    cache_key = f"{debate_id}_{turn_index}"
    audio_bytes = await generate_speech(text, voice, emotion=emotion, cache_key=cache_key)

    if not audio_bytes:
        raise HTTPException(status_code=500, detail="TTS generation failed.")

    from starlette.responses import Response
    return Response(
        content=audio_bytes,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "public, max-age=86400",
            "Content-Disposition": f"inline; filename=turn_{turn_index}.mp3",
        },
    )


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=5000)
    character_name: str = Field(..., min_length=1)
    emotion: str = Field(default="neutral")
    is_orchestrator: bool = Field(default=False)


@router.post("/{debate_id}/tts")
async def generate_tts_audio(debate_id: str, body: TTSRequest, db: AsyncSession = Depends(get_db)):
    """Generate TTS audio for given text + character. Works during live debates (no DB transcript lookup)."""
    from app.core.tts import generate_speech, assign_voices_to_cast, BORU_VOICE, _clean_text_for_speech
    import hashlib

    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")

    story_result = await db.execute(select(Story).where(Story.id == debate.story_id))
    story = story_result.scalar_one_or_none()
    characters = story.analysis.get("characters", []) if story and story.analysis else []

    voice_assignments = assign_voices_to_cast(characters)

    if body.is_orchestrator or body.character_name == "Boru":
        voice = BORU_VOICE
    else:
        voice = voice_assignments.get(body.character_name, BORU_VOICE)

    # Cache key based on text hash (deterministic for same content)
    text_hash = hashlib.md5(body.text[:200].encode()).hexdigest()[:12]
    cache_key = f"{debate_id}_{body.character_name}_{text_hash}"

    audio_bytes = await generate_speech(body.text, voice, emotion=body.emotion, cache_key=cache_key)

    if not audio_bytes:
        raise HTTPException(status_code=500, detail="TTS generation failed.")

    from starlette.responses import Response
    return Response(
        content=audio_bytes,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "public, max-age=86400",
        },
    )


@router.get("/{debate_id}/voices")
async def get_debate_voices(debate_id: str, db: AsyncSession = Depends(get_db)):
    """Return voice assignments for all characters in a debate."""
    from app.core.tts import assign_voices_to_cast

    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")

    story_result = await db.execute(select(Story).where(Story.id == debate.story_id))
    story = story_result.scalar_one_or_none()
    characters = story.analysis.get("characters", []) if story and story.analysis else []

    return assign_voices_to_cast(characters)


@router.get("/{debate_id}/tts/summary")
async def get_summary_audio(debate_id: str, db: AsyncSession = Depends(get_db)):
    """Generate TTS audio for the debate summary. Returns MP3."""
    from app.core.tts import generate_speech, BORU_VOICE

    result = await db.execute(select(Debate).where(Debate.id == debate_id))
    debate = result.scalar_one_or_none()
    if not debate:
        raise HTTPException(status_code=404, detail="Debate not found.")

    # The summary is stored in alternate_ending field (or we reconstruct from transcript)
    summary = debate.alternate_ending or ""
    if not summary:
        raise HTTPException(status_code=404, detail="No summary available.")

    cache_key = f"{debate_id}_summary"
    # Summary is read by Boru's voice — he's the narrator
    audio_bytes = await generate_speech(summary, BORU_VOICE, emotion="neutral", cache_key=cache_key)

    if not audio_bytes:
        raise HTTPException(status_code=500, detail="TTS generation failed.")

    from starlette.responses import Response
    return Response(
        content=audio_bytes,
        media_type="audio/mpeg",
        headers={
            "Cache-Control": "public, max-age=86400",
            "Content-Disposition": f"inline; filename=summary.mp3",
        },
    )


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
        "ledger_snapshot": debate.ledger_snapshot,
    }
