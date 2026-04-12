import json
import logging
from fastapi import APIRouter, HTTPException, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.database import get_db
from app.models.story import Story

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/stories", tags=["characters"])


@router.get("/{story_id}/characters")
async def list_characters(story_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story or not story.analysis:
        raise HTTPException(status_code=404, detail="Story analysis not ready.")

    characters = story.analysis.get("characters", [])

    # Return summary list (no full phase data)
    return [
        {
            "name": c["name"],
            "role": c.get("role"),
            "description": c.get("description"),
            "importance": c.get("importance", 0.5),
            "portrait": c.get("portrait"),
        }
        for c in characters
    ]


@router.get("/{story_id}/characters/{character_name}")
async def get_character(
    story_id: str, character_name: str, db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story or not story.analysis:
        raise HTTPException(status_code=404, detail="Story analysis not ready.")

    characters = story.analysis.get("characters", [])
    character = next(
        (c for c in characters if c["name"].lower() == character_name.lower()), None
    )

    if not character:
        raise HTTPException(status_code=404, detail="Character not found.")

    # Include timeline phases and knowledge events for this character
    knowledge_events = [
        e
        for e in story.analysis.get("knowledge_events", [])
        if e["character"].lower() == character_name.lower()
    ]

    timeline_phases = story.analysis.get("timeline_phases", [])
    timeline_metadata = story.analysis.get("timeline_metadata", None)

    return {**character, "knowledge_events": knowledge_events, "timeline_phases": timeline_phases, "timeline_metadata": timeline_metadata}


@router.get("/{story_id}/graph")
async def get_relationship_graph(story_id: str, db: AsyncSession = Depends(get_db)):
    """Return nodes and edges for the character relationship graph."""
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story or not story.analysis:
        raise HTTPException(status_code=404, detail="Story analysis not ready.")

    characters = story.analysis.get("characters", [])
    relationships = story.analysis.get("relationships", [])

    nodes = [
        {
            "id": c["name"],
            "name": c["name"],
            "role": c.get("role", "supporting"),
            "importance": c.get("importance", 0.5),
            "description": c.get("description", ""),
            "portrait": c.get("portrait"),
        }
        for c in characters
    ]

    edges = [
        {
            "source": r["from"],
            "target": r["to"],
            "type": r.get("type", "neutral"),
            "description": r.get("description", ""),
            "strength": r.get("strength", 0.5),
        }
        for r in relationships
    ]

    return {"nodes": nodes, "edges": edges}


class CharacterChatRequest(BaseModel):
    question: str
    history: list[dict] = []


@router.post("/{story_id}/characters/{character_name}/chat/stream")
async def character_chat_stream(
    story_id: str,
    character_name: str,
    body: CharacterChatRequest,
    db: AsyncSession = Depends(get_db),
):
    """Stream a character's response to a direct question, speaking from inside their story."""
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story or not story.analysis:
        raise HTTPException(status_code=404, detail="Story analysis not ready.")

    characters = story.analysis.get("characters", [])
    character = next(
        (c for c in characters if c["name"].lower() == character_name.lower()), None
    )
    if not character:
        raise HTTPException(status_code=404, detail="Character not found.")

    from app.core.agents.character_chat_agent import character_chat_stream as _chat_stream

    async def generate():
        try:
            async for token in _chat_stream(
                character=character,
                story_title=story.title or "the story",
                story_id=story_id,
                question=body.question,
                chat_history=body.history,
            ):
                yield f"data: {json.dumps({'type': 'token', 'text': token})}\n\n"
        except Exception as e:
            logger.warning(f"Character chat error for {character_name}: {e}")
            yield f"data: {json.dumps({'type': 'error', 'message': 'Could not reach this character right now.'})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
