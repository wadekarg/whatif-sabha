from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.db.database import get_db
from app.models.story import Story

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
