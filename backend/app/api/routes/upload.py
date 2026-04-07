import os
import uuid
import asyncio
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, BackgroundTasks, Depends
import copy
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from app.db.database import get_db
from app.models.story import Story
from app.config import get_settings
from app.core.pdf_extractor import extract_text, needs_chunking
from app.core.story_analyzer import analyze_story, generate_world_observers
from app.core.lightrag_analyzer import build_causal_graph
from app.core.rag.chunker import chunk_by_chapter
from app.core.rag.embedder import embed_chunks
from app.core.character_research.researcher import research_all_characters

router = APIRouter(prefix="/upload", tags=["upload"])


@router.post("")
async def upload_story(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    settings = get_settings()

    if not file.filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    story_id = str(uuid.uuid4())
    upload_dir = Path(settings.UPLOAD_DIR)
    upload_dir.mkdir(parents=True, exist_ok=True)

    pdf_path = str(upload_dir / f"{story_id}.pdf")
    content = await file.read()

    max_bytes = settings.MAX_UPLOAD_SIZE_MB * 1024 * 1024
    if len(content) > max_bytes:
        raise HTTPException(status_code=400, detail=f"File exceeds {settings.MAX_UPLOAD_SIZE_MB}MB limit.")

    with open(pdf_path, "wb") as f:
        f.write(content)

    story = Story(id=story_id, pdf_path=pdf_path, status="uploaded")
    db.add(story)
    await db.commit()

    background_tasks.add_task(_analyze_story_background, story_id, pdf_path)

    return {"story_id": story_id, "status": "uploaded", "message": "Analysis started in background."}


def _push_log(story, message: str):
    """Append a progress message to story.progress_log in the current session."""
    entries = list(story.progress_log or [])
    entries.append({"msg": message})
    story.progress_log = entries
    flag_modified(story, "progress_log")


async def _analyze_story_background(story_id: str, pdf_path: str):
    """Extract text, analyze story, build RAG index. Runs in background."""
    from app.db.database import get_session_maker

    session_maker = get_session_maker()

    # Callback for researcher — opens its own session so it's concurrency-safe
    async def char_log(message: str):
        async with session_maker() as log_db:
            s = (await log_db.execute(select(Story).where(Story.id == story_id))).scalar_one_or_none()
            if s:
                _push_log(s, message)
                await log_db.commit()

    async with session_maker() as db:
        result = await db.execute(select(Story).where(Story.id == story_id))
        story = result.scalar_one_or_none()
        if not story:
            return

        try:
            story.status = "analyzing"
            story.progress_log = []
            _push_log(story, "📄 Extracting text from PDF...")
            await db.commit()

            # Step 1: Extract text
            extracted = extract_text(pdf_path)
            story.full_text = extracted["full_text"]
            story.word_count = extracted["word_count"]
            pages = extracted.get("page_count", "?")
            words = f"{int(extracted['word_count']):,}"
            _push_log(story, f"📄 Extracted {pages} pages · {words} words")
            await db.commit()

            _push_log(story, "🔬 Sending full text to Gemini for analysis...")
            await db.commit()

            # Step 2: Analyze story
            analysis = await analyze_story(extracted["full_text"])
            story.analysis = analysis
            story.title = analysis.get("title")
            story.author = analysis.get("author")
            story.summary = analysis.get("summary")
            story.themes = analysis.get("themes", [])

            chars = analysis.get("characters", [])
            phases = analysis.get("timeline_phases", [])
            div_pts = analysis.get("potential_divergence_points", [])
            char_names = [c["name"] for c in chars[:6]]
            name_str = ", ".join(char_names) + ("…" if len(chars) > 6 else "")

            title_line = story.title or "Unknown title"
            if story.author:
                title_line += f" by {story.author}"
            _push_log(story, f"📖 Story identified: {title_line}")
            _push_log(story, f"🎭 {len(chars)} characters found: {name_str}")
            if phases:
                _push_log(story, f"📅 {len(phases)} story phases mapped")
            if div_pts:
                _push_log(story, f"⚡ {len(div_pts)} divergence points identified")
            await db.commit()

            # Generate world observer personas (historically-situated external voices)
            _push_log(story, "🌍 Generating world observer perspectives...")
            await db.commit()
            observers = await generate_world_observers(
                title=analysis.get("title", "Unknown"),
                summary=analysis.get("summary", ""),
                themes=analysis.get("themes", []),
            )
            if observers:
                analysis["world_observers"] = observers
                story.analysis = analysis
                flag_modified(story, "analysis")
                _push_log(story, f"🌍 {len(observers)} world observer perspectives generated")
            await db.commit()

            # Build narrative causal graph (LightRAG) — optional, feature-flagged
            settings_obj = get_settings()
            if getattr(settings_obj, 'ENABLE_LIGHTRAG', False):
                _push_log(story, "🕸️ Building narrative causal graph (LightRAG)...")
                await db.commit()
                causal_graph = await build_causal_graph(extracted["full_text"], story_id)
                if causal_graph:
                    analysis["causal_graph"] = causal_graph
                    story.analysis = analysis
                    flag_modified(story, "analysis")
                    _push_log(story, "🕸️ Narrative causal graph complete")
                    await db.commit()

            # Step 3: Character research
            story.status = "researching"
            _push_log(story, f"🔍 Starting deep research on {len(chars)} characters (2 at a time)...")
            await db.commit()

            enriched_characters = await research_all_characters(
                characters=chars,
                story_title=analysis.get("title", "Unknown"),
                log_fn=char_log,
            )
            updated_analysis = copy.deepcopy(analysis)
            updated_analysis["characters"] = enriched_characters
            story.analysis = updated_analysis
            flag_modified(story, "analysis")
            await db.commit()

            # Step 4: Build RAG index
            _push_log(story, "🏗️ Building semantic search index...")
            await db.commit()
            chunks = chunk_by_chapter(extracted["full_text"])
            embed_chunks(story_id, chunks)
            _push_log(story, f"🏗️ Indexed {len(chunks)} text chunks")

            _push_log(story, f"✅ Done! {len(enriched_characters)} characters fully researched")
            story.status = "ready"
            await db.commit()

        except Exception as e:
            story.status = "error"
            story.error_message = str(e)
            await db.commit()
            raise
