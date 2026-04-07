import json
import uuid
import asyncio
import random
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from app.db.database import get_db
from app.models.story import Story
from app.models.debate import Debate
from app.core.agents.character_agent import character_respond_stream, character_continue_stream
from app.core.agents.orchestrator import (
    pick_next_speaker,
    should_synthesize,
    determine_debate_phase,
    compute_drama_score,
    _detect_question_target,
)
from app.core.agents.judge_agent import judge_response, should_regenerate
from app.core.agents.narrator_agent import synthesize_ending_stream, generate_alternate_timeline
from app.core.memory import recall_memories, save_debate_turn
from app.core.agents.world_observer_agent import (
    _select_observers,
    observer_respond_stream,
    should_invite_observer,
)

router = APIRouter(prefix="/debates", tags=["debates"])


class DebateStartRequest(BaseModel):
    story_id: str
    divergence_description: str
    character_names: Optional[list[str]] = None  # None = use all characters
    max_rounds: int = 20


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
        # Use characters with importance > 0.5 — keep core cast, avoid 10+ character debates
        characters = [c for c in all_characters if c.get("importance", 0) > 0.5]

    if len(characters) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 characters to debate.")

    debate = Debate(
        id=str(uuid.uuid4()),
        story_id=req.story_id,
        divergence_description=req.divergence_description,
        participating_characters=[c["name"] for c in characters],
        transcript=[],
        status="pending",
    )
    db.add(debate)
    await db.commit()

    return {
        "debate_id": debate.id,
        "characters": [c["name"] for c in characters],
        "status": "pending",
    }


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
    """Core debate loop — streams SSE events to the frontend."""
    from app.db.database import get_session_maker

    session_maker = get_session_maker()

    all_characters = story.analysis.get("characters", [])
    participating = set(debate.participating_characters)
    characters = [c for c in all_characters if c["name"] in participating]

    # World observers — select 4 most relevant to this divergence question
    all_observers = story.analysis.get("world_observers", [])
    active_observers = _select_observers(all_observers, debate.divergence_description, num_active=4)
    last_observer_at: int = 0  # transcript index when an observer last spoke

    transcript = list(debate.transcript or [])
    round_number = len(transcript)
    max_rounds = max(len(characters) * 3, 20)

    def sse(event_type: str, data: dict) -> str:
        return f"data: {json.dumps({'type': event_type, **data})}\n\n"

    yield sse("debate_start", {
        "debate_id": debate_id,
        "characters": [c["name"] for c in characters],
        "divergence": debate.divergence_description,
    })

    async with session_maker() as db:
        db_debate = (await db.execute(
            select(Debate).where(Debate.id == debate_id)
        )).scalar_one()
        db_debate.status = "running"
        await db.commit()

    alternate_ending = ""
    consecutive_errors = 0

    try:
        while not should_synthesize(transcript, characters, max_rounds):
            phase = determine_debate_phase(round_number, len(characters))
            next_speaker_name = pick_next_speaker(transcript, characters, phase, round_number)

            character = next((c for c in characters if c["name"] == next_speaker_name), None)
            if not character:
                break

            phases = character.get("phases", [])
            phase_state = phases[-1] if phases else {}

            yield sse("character_start", {
                "character": next_speaker_name,
                "round": round_number,
                "phase": phase,
                "drama_score": compute_drama_score(transcript),
            })

            full_response = ""
            attempt = 0
            max_attempts = 2
            judge_result = {"score": 7, "issue": None}
            correction_hint = None

            # 10% exploration: inject a hidden dimension so character reveals something unexpected
            exploration_hint = None
            if character.get("hidden_dimensions") and random.random() < 0.10:
                exploration_hint = random.choice(character["hidden_dimensions"])
                yield sse("exploration", {
                    "character": next_speaker_name,
                    "hint": exploration_hint,
                })

            # Recall relevant memories from previous debates (character soul)
            memory_context = []
            if transcript:
                last_msg = transcript[-1].get("message", "")
                memory_query = f"{debate.divergence_description[:120]} {last_msg[:120]}"
                memory_context = await recall_memories(
                    story_id=debate.story_id,
                    character_name=next_speaker_name,
                    query=memory_query,
                )
                if memory_context:
                    yield sse("memory_recalled", {
                        "character": next_speaker_name,
                        "count": len(memory_context),
                    })

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
                        # Judge unavailable — accept the response as-is
                        judge_result = {"score": 7, "in_character": True, "feedback": "", "issue": None, "needs_continuation": False, "continuation_reason": None, "dominant_emotion": "neutral"}

                    if not await should_regenerate(judge_result):
                        break

                    attempt += 1
                    correction_hint = judge_result.get("issue") or judge_result.get("feedback")
                    yield sse("regenerating", {
                        "character": next_speaker_name,
                        "reason": correction_hint or "out of character",
                    })

                # Continuation — judge grants more space when burden is unmet
                drama_score = compute_drama_score(transcript)
                continuation_threshold = 0.4 if phase == "climax" else 0.55
                if judge_result.get("needs_continuation") and drama_score >= continuation_threshold:
                    continuation_reason = judge_result.get("continuation_reason") or "unfinished thought"
                    yield sse("continuation_granted", {
                        "character": next_speaker_name,
                        "reason": continuation_reason,
                    })
                    async for token in character_continue_stream(
                        character=character,
                        phase=phase_state,
                        divergence=debate.divergence_description,
                        debate_history=transcript,
                        story_title=story.title or "",
                        previous_response=full_response,
                        continuation_reason=continuation_reason,
                        exploration_hint=exploration_hint,
                    ):
                        full_response += token
                        yield sse("token", {"character": next_speaker_name, "text": token})

            except Exception as e:
                # LLM call failed — skip this turn and keep going
                consecutive_errors += 1
                yield sse("turn_error", {
                    "character": next_speaker_name,
                    "reason": str(e)[:120],
                })
                if consecutive_errors >= 3:
                    break
                await asyncio.sleep(1)
                round_number += 1
                continue

            consecutive_errors = 0  # reset on success

            if not full_response:
                round_number += 1
                continue

            char_names = [c["name"] for c in characters]
            target_char = _detect_question_target(full_response, char_names, next_speaker_name)
            # If no question target, fall back to previous speaker
            if not target_char and transcript:
                target_char = transcript[-1]["character"]

            yield sse("character_end", {
                "character": next_speaker_name,
                "message": full_response,
                "judge_score": judge_result.get("score", 7),
                "target_character": target_char,
                "emotion": judge_result.get("dominant_emotion", "neutral"),
            })

            transcript.append({
                "character": next_speaker_name,
                "message": full_response,
                "round": round_number,
                "phase": phase,
                "target_character": target_char,
                "emotion": judge_result.get("dominant_emotion", "neutral"),
            })

            # Save this turn to character's persistent soul memory (async, non-blocking)
            asyncio.create_task(save_debate_turn(
                story_id=debate.story_id,
                character_name=next_speaker_name,
                message=full_response,
                debate_id=debate_id,
                round_number=round_number,
                divergence=debate.divergence_description,
            ))

            async with session_maker() as db:
                db_debate = (await db.execute(
                    select(Debate).where(Debate.id == debate_id)
                )).scalar_one()
                db_debate.transcript = transcript
                db_debate.round_count = round_number
                await db.commit()

            round_number += 1

            # World observer reaction — every 4 character turns, invite 1 observer
            if active_observers and should_invite_observer(transcript, last_observer_at, observer_interval=4):
                import random as _rnd
                observer = _rnd.choice(active_observers)
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
                    ):
                        obs_response += token
                        yield sse("observer_token", {
                            "observer_id": observer["id"],
                            "observer_name": observer["name"],
                            "text": token,
                        })
                    if obs_response:
                        yield sse("observer_end", {
                            "observer_id": observer["id"],
                            "observer_name": observer["name"],
                            "era": observer.get("era", ""),
                            "message": obs_response,
                        })
                        last_observer_at = len(transcript)
                except Exception as obs_exc:
                    import logging as _log
                    _log.getLogger(__name__).warning(f"Observer failed (non-fatal): {obs_exc}")

            await asyncio.sleep(0.3)

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

    system_prompt = f"""You are the Orchestrator of a WhatIfSabha debate about "{story.title if story else 'the story'}".

THE DIVERGENCE SCENARIO:
"{debate.divergence_description}"

DEBATE TRANSCRIPT SO FAR:
{transcript_text or "The debate has not started yet."}

You have full knowledge of this story and its characters. Answer questions about:
- What is happening in this debate
- Why characters said what they said
- What might happen next
- The themes and tensions emerging
- How this divergence changes the story

Be insightful, analytical, and concise."""

    messages = [SystemMessage(content=system_prompt)]
    for turn in body.history[-8:]:
        if turn.get("role") == "user":
            messages.append(HumanMessage(content=turn["content"]))
        elif turn.get("role") == "assistant":
            messages.append(AIMessage(content=turn["content"]))
    messages.append(HumanMessage(content=body.question.strip()))

    llm = get_analysis_llm()
    response = await llm.ainvoke(messages)
    content = response.content
    if isinstance(content, list):
        answer = " ".join(block.get("text", "") if isinstance(block, dict) else str(block) for block in content)
    else:
        answer = str(content)
    return {"answer": answer}


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
