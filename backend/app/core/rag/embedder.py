# Fix for systems with sqlite3 < 3.35.0 (ChromaDB requirement)
import sys
try:
    __import__("pysqlite3")
    sys.modules["sqlite3"] = sys.modules.pop("pysqlite3")
except ImportError:
    pass

import chromadb
from chromadb.config import Settings
from sentence_transformers import SentenceTransformer
from typing import List
import os

_model = None
_client = None


def get_embedding_model():
    global _model
    if _model is None:
        _model = SentenceTransformer("all-MiniLM-L6-v2")
    return _model


def get_chroma_client():
    global _client
    if _client is None:
        _client = chromadb.PersistentClient(
            path="./chroma_db",
            settings=Settings(anonymized_telemetry=False),
        )
    return _client


def get_or_create_collection(story_id: str):
    client = get_chroma_client()
    collection_name = f"story_{story_id}"
    return client.get_or_create_collection(
        name=collection_name,
        metadata={"hnsw:space": "cosine"},
    )


def embed_chunks(story_id: str, chunks: List[dict]) -> None:
    """Embed story chunks and store in ChromaDB."""
    model = get_embedding_model()
    collection = get_or_create_collection(story_id)

    texts = [c["text"] for c in chunks]
    embeddings = model.encode(texts, show_progress_bar=False).tolist()

    collection.add(
        ids=[c["chunk_id"] for c in chunks],
        embeddings=embeddings,
        documents=texts,
        metadatas=[
            {
                "timeline_position": c["timeline_position"],
                "word_start": c["word_start"],
                "word_end": c["word_end"],
            }
            for c in chunks
        ],
    )


def delete_story_embeddings(story_id: str) -> None:
    client = get_chroma_client()
    collection_name = f"story_{story_id}"
    try:
        client.delete_collection(collection_name)
    except Exception:
        pass
