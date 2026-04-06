from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.db.database import init_db
from app.api.routes import upload, story, characters, debate


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
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


@app.get("/health")
async def health():
    return {"status": "ok", "service": "WhatIfSabha"}
