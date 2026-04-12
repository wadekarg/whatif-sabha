from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from langchain_core.messages import SystemMessage, HumanMessage
from app.db.database import get_db
from app.models.story import Story
from app.models.debate import Debate
from app.config import get_analysis_llm

router = APIRouter(prefix="/stories", tags=["stories"])


class ChatRequest(BaseModel):
    question: str
    history: list[dict] = []


@router.get("")
async def list_stories(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Story).where(Story.status == "ready").order_by(Story.created_at.desc())
    )
    stories = result.scalars().all()
    return [
        {
            "id": s.id,
            "title": s.title,
            "author": s.author,
            "summary": s.summary,
            "themes": s.themes,
            "word_count": s.word_count,
            "created_at": s.created_at,
        }
        for s in stories
    ]


@router.delete("/{story_id}")
async def delete_story(story_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()
    if not story:
        raise HTTPException(status_code=404, detail="Story not found.")

    pdf_path = story.pdf_path

    # Delete story + all debates (cascade="all, delete-orphan" handles debates)
    await db.delete(story)
    await db.commit()

    # Clean up PDF file
    if pdf_path:
        import os
        try:
            if os.path.exists(pdf_path):
                os.remove(pdf_path)
        except Exception:
            pass

    # Clean up ChromaDB embeddings
    try:
        from app.core.rag.embedder import get_chroma_client
        client = get_chroma_client()
        collection_name = f"story_{story_id}"
        client.delete_collection(collection_name)
    except Exception:
        pass

    return {"ok": True}


@router.get("/{story_id}")
async def get_story(story_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story:
        raise HTTPException(status_code=404, detail="Story not found.")

    return {
        "id": story.id,
        "title": story.title,
        "author": story.author,
        "summary": story.summary,
        "themes": story.themes,
        "word_count": story.word_count,
        "status": story.status,
        "error_message": story.error_message,
        "created_at": story.created_at,
    }


@router.get("/{story_id}/status")
async def get_story_status(story_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story:
        raise HTTPException(status_code=404, detail="Story not found.")

    status_messages = {
        "uploaded": "Extracting text from PDF...",
        "analyzing": "Analyzing story structure, characters, and events...",
        "researching": "Researching characters — Wikipedia, web analysis, and multi-LLM perspectives...",
        "ready": "Ready",
        "error": story.error_message or "An error occurred.",
    }
    return {
        "story_id": story_id,
        "status": story.status,
        "status_message": status_messages.get(story.status, story.status),
        "error": story.error_message,
        "progress_log": story.progress_log or [],
    }


@router.get("/{story_id}/debates")
async def list_debates(story_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Debate)
        .where(Debate.story_id == story_id)
        .order_by(Debate.created_at.desc())
    )
    debates = result.scalars().all()
    return [
        {
            "id": d.id,
            "divergence_description": d.divergence_description,
            "status": d.status,
            "round_count": d.round_count,
            "participating_characters": d.participating_characters,
            "has_ending": bool(d.alternate_ending),
            "created_at": d.created_at,
        }
        for d in debates
    ]


@router.get("/{story_id}/divergence-points")
async def get_divergence_points(story_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story or not story.analysis:
        raise HTTPException(status_code=404, detail="Story analysis not ready.")

    return story.analysis.get("potential_divergence_points", [])


@router.get("/{story_id}/overview")
async def get_story_overview(story_id: str, db: AsyncSession = Depends(get_db)):
    """Full orchestrator view: timeline, character arcs, relationships, divergence points."""
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story or not story.analysis:
        raise HTTPException(status_code=404, detail="Story analysis not ready.")

    analysis = story.analysis
    characters = analysis.get("characters", [])
    relationships = analysis.get("relationships", [])
    knowledge_events = analysis.get("knowledge_events", [])
    divergence_points = analysis.get("potential_divergence_points", [])

    # Build character arc summaries
    character_arcs = []
    for c in characters:
        phases = c.get("phases", [])
        arc = {
            "name": c["name"],
            "role": c.get("role", "supporting"),
            "importance": c.get("importance", 0.5),
            "description": c.get("description", ""),
            "phase_count": len(phases),
            "phases": [
                {
                    "phase_id": p.get("phase_id", f"phase_{i+1}"),
                    "emotional_state": p.get("emotional_state", ""),
                    "motivations": p.get("motivations", [])[:2],
                }
                for i, p in enumerate(phases)
            ],
        }
        character_arcs.append(arc)

    # Sort arcs by importance desc
    character_arcs.sort(key=lambda c: c["importance"], reverse=True)

    timeline_phases = analysis.get("timeline_phases", [])
    key_events = analysis.get("key_events", [])

    return {
        "knowledge_events": knowledge_events,
        "character_arcs": character_arcs,
        "relationships": relationships,
        "divergence_points": divergence_points,
        "timeline_phases": timeline_phases,
        "key_events": key_events,
    }


@router.post("/{story_id}/chat")
async def chat_about_story(
    story_id: str, body: ChatRequest, db: AsyncSession = Depends(get_db)
):
    result = await db.execute(select(Story).where(Story.id == story_id))
    story = result.scalar_one_or_none()

    if not story or not story.analysis:
        raise HTTPException(status_code=404, detail="Story analysis not ready.")

    question = body.question.strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is required.")

    analysis = story.analysis
    characters = analysis.get("characters", [])
    char_lines = "\n".join(
        f"- {c['name']} ({c.get('role', 'supporting')}): {c.get('description', '')}"
        for c in characters[:20]
    )
    relationships = analysis.get("relationships", [])
    rel_lines = "\n".join(
        f"- {r['from']} → {r['to']}: {r.get('type', 'neutral')} — {r.get('description', '')}"
        for r in relationships[:25]
    )
    divergence_points = analysis.get("potential_divergence_points", [])
    div_lines = "\n".join(
        f"- {d.get('description', '')}" for d in divergence_points[:6]
    )
    knowledge_events = analysis.get("knowledge_events", [])
    event_lines = "\n".join(
        f"- [{e.get('character', '?')}] {e.get('event', '')}"
        for e in knowledge_events[:20]
    )

    system_prompt = f"""You are an expert literary analyst and story guide for "{story.title}"{f' by {story.author}' if story.author else ''}.

SUMMARY:
{story.summary or 'Not available'}

THEMES: {', '.join(story.themes or [])}

CHARACTERS:
{char_lines}

KEY RELATIONSHIPS:
{rel_lines}

KEY EVENTS & REVELATIONS:
{event_lines}

POTENTIAL WHAT-IF DIVERGENCE POINTS:
{div_lines}

Answer questions about this story clearly and insightfully. Be concise but thorough.
When asked about characters, use their traits, motivations and relationships.
When asked about what-if scenarios, reason from the characters' true natures.
Never fabricate events not implied by the analysis above."""

    # Build message list including prior turns
    messages: list = [SystemMessage(content=system_prompt)]
    for turn in body.history[-10:]:  # keep last 10 turns for context
        if turn.get("role") == "user":
            messages.append(HumanMessage(content=turn["content"]))
        elif turn.get("role") == "assistant":
            from langchain_core.messages import AIMessage
            messages.append(AIMessage(content=turn["content"]))
    messages.append(HumanMessage(content=question))

    llm = get_analysis_llm()
    response = await llm.ainvoke(messages)
    content = response.content
    if isinstance(content, list):
        answer = " ".join(block.get("text", "") if isinstance(block, dict) else str(block) for block in content)
    else:
        answer = str(content)
    return {"answer": answer}
