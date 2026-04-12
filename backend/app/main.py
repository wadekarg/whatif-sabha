from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.db.database import init_db
from app.api.routes import upload, story, characters, debate, settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    # Initialize character soul memory — graceful if not configured or times out
    try:
        import asyncio
        from app.core.memory import init_memory
        await asyncio.wait_for(init_memory(), timeout=10)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning(f"Memory init skipped: {e}")
    yield


app = FastAPI(
    title="WhatIfSabha API",
    description="Multi-agent story alternate ending engine",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router)
app.include_router(story.router)
app.include_router(characters.router)
app.include_router(debate.router)
app.include_router(settings.router)


# Serve character portraits as static files
from fastapi.staticfiles import StaticFiles
import os
os.makedirs("./uploads/portraits", exist_ok=True)
app.mount("/portraits", StaticFiles(directory="./uploads/portraits"), name="portraits")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "WhatIfSabha"}
