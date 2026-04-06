import json
import uuid
import asyncio
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional

from app.db.database import get_db
from app.models.story import Story
from app.models.debate import Debate
from app.core.agents.character_agent import character_respond_stream
from app.core.agents.orchestrator import (
    pick_next_speaker,
    should_synthesize,
    determine_debate_phase,
    compute_drama_score,
    _detect_question_target,
)
from app.core.agents.judge_agent import judge_response, should_regenerate
from app.core.agents.narrator_agent import synthesize_ending_stream

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

            while attempt < max_attempts:
                full_response = ""
                async for token in character_respond_stream(
                    character=character,
                    phase=phase_state,
                    divergence=debate.divergence_description,
                    debate_history=transcript,
                    story_title=story.title or "",
                    correction_hint=correction_hint,
                ):
                    full_response += token
                    yield sse("token", {"character": next_speaker_name, "text": token})

                traits = phase_state.get("personality_traits", [])
                judge_result = await judge_response(
                    character_name=next_speaker_name,
                    character_description=character.get("description", ""),
                    personality_traits=traits,
                    response_text=full_response,
                )

                if not await should_regenerate(judge_result):
                    break

                attempt += 1
                correction_hint = judge_result.get("issue") or judge_result.get("feedback")
                yield sse("regenerating", {
                    "character": next_speaker_name,
                    "reason": correction_hint or "out of character",
                })

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
            })

            transcript.append({
                "character": next_speaker_name,
                "message": full_response,
                "round": round_number,
                "phase": phase,
                "target_character": target_char,
            })

            async with session_maker() as db:
                db_debate = (await db.execute(
                    select(Debate).where(Debate.id == debate_id)
                )).scalar_one()
                db_debate.transcript = transcript
                db_debate.round_count = round_number
                await db.commit()

            round_number += 1
            await asyncio.sleep(0.3)

        # Synthesize alternate ending
        yield sse("synthesis_start", {"message": "Characters have spoken. Writing the alternate ending..."})

        async for token in synthesize_ending_stream(
            story_title=story.title or "the story",
            original_summary=story.summary or "",
            divergence_description=debate.divergence_description,
            debate_transcript=transcript,
        ):
            alternate_ending += token
            yield sse("ending_token", {"text": token})

        yield sse("debate_end", {
            "debate_id": debate_id,
            "alternate_ending": alternate_ending,
            "total_rounds": round_number,
        })

    finally:
        # Always persist final state — even if client disconnects mid-stream
        async with session_maker() as db:
            db_debate = (await db.execute(
                select(Debate).where(Debate.id == debate_id)
            )).scalar_one()
            db_debate.alternate_ending = alternate_ending or db_debate.alternate_ending
            db_debate.status = "completed" if alternate_ending else "interrupted"
            db_debate.round_count = round_number
            await db.commit()


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
        "status": debate.status,
        "round_count": debate.round_count,
    }
