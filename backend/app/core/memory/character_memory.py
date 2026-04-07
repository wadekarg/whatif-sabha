"""
Character Soul — Graphiti-powered temporal memory for debate characters.

Each character in each story gets a persistent knowledge graph that accumulates
across ALL debates ever run about them. Napoleon 'remembers' being called a
hypocrite last month. Boxer 'remembers' the moment he admitted his fear aloud.

Uses Kuzu — an embedded graph DB (like SQLite but for graphs). Zero setup:
no server, no Docker, no Java. Data stored in ./kuzu_graph/ directory.

Graphiti builds a temporal knowledge graph on top of Kuzu:
- Facts are extracted from debate turns (entities, relationships, positions)
- Each fact has a valid_from timestamp
- When Napoleon contradicts himself, the old fact is invalidated — not erased
- Search retrieves semantically relevant memories, not just recent ones

This gives characters genuine psychological depth across time.
"""

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_client: Optional[object] = None
_ready: bool = False


async def init_memory() -> None:
    """
    Initialize Graphiti with Kuzu embedded graph DB at app startup.
    No server needed — Kuzu stores data in ./kuzu_graph/ like SQLite.
    Fails silently so the app works even if memory init fails.
    """
    global _client, _ready

    try:
        from graphiti_core import Graphiti
        from graphiti_core.driver.kuzu_driver import KuzuDriver
        from graphiti_core.llm_client.openai_client import OpenAIClient
        from graphiti_core.llm_client.config import LLMConfig
        from graphiti_core.embedder.gemini import GeminiEmbedder, GeminiEmbedderConfig
        from graphiti_core.cross_encoder.gemini_reranker_client import GeminiRerankerClient
    except ImportError as e:
        logger.info(f"graphiti-core[kuzu] not installed — character memory disabled: {e}")
        return

    from app.config import _key

    groq_key = _key("GROQ_API_KEY")
    gemini_key = _key("GEMINI_API_KEY")

    if not groq_key:
        logger.info("GROQ_API_KEY not set — character memory disabled")
        return
    if not gemini_key:
        logger.info("GEMINI_API_KEY not set — character memory disabled")
        return

    try:
        # Kuzu DB stored on disk — persists across restarts, zero server setup
        graph_driver = KuzuDriver(db="./character_souls.kuzu")

        # Groq llama-3.1-8b-instant for entity/fact extraction (fast, free)
        llm_client = OpenAIClient(
            config=LLMConfig(
                api_key=groq_key,
                model="llama-3.1-8b-instant",
                base_url="https://api.groq.com/openai/v1",
            )
        )

        # Gemini text-embedding-004 for semantic memory search (free with Gemini key)
        embedder = GeminiEmbedder(
            config=GeminiEmbedderConfig(api_key=gemini_key)
        )

        # Use Gemini reranker to avoid OpenAI key requirement
        cross_encoder = GeminiRerankerClient(
            config=LLMConfig(api_key=gemini_key)
        )

        graphiti = Graphiti(
            uri="",         # not used with custom graph_driver
            user="",
            password="",
            llm_client=llm_client,
            embedder=embedder,
            graph_driver=graph_driver,
            cross_encoder=cross_encoder,
        )
        await graphiti.build_indices_and_constraints()

        _client = graphiti
        _ready = True
        logger.info("✓ Character soul memory (Graphiti + Kuzu) initialized — data at ./character_souls.kuzu")

    except Exception as e:
        logger.warning(f"Character memory init failed (non-fatal) — debates work without it: {e}")


def _group_id(story_id: str, character_name: str) -> str:
    """Each character in each story gets an isolated memory namespace."""
    safe_name = character_name.lower().replace(" ", "_").replace("'", "")
    return f"{story_id}:{safe_name}"


async def save_debate_turn(
    story_id: str,
    character_name: str,
    message: str,
    debate_id: str,
    round_number: int,
    divergence: str = "",
) -> None:
    """
    Persist a character's debate turn to their temporal knowledge graph.

    Graphiti extracts entities and facts from the episode body —
    e.g., "Napoleon believes equality is a means to power" becomes a
    typed edge in the graph, queryable by future debates.
    """
    if not _ready or not _client:
        return

    try:
        from graphiti_core.nodes import EpisodeType

        episode_body = (
            f"Debate topic: '{divergence[:150]}'\n"
            f"{character_name} argues: {message}"
        )

        await _client.add_episode(
            name=f"d{debate_id[:6]}_r{round_number}_{character_name[:10].replace(' ', '')}",
            episode_body=episode_body,
            source=EpisodeType.message,
            source_description="WhatIfSabha — alternate reality debate",
            reference_time=datetime.now(timezone.utc),
            group_id=_group_id(story_id, character_name),
        )

    except Exception as e:
        logger.debug(f"Memory save skipped (non-fatal): {e}")


async def recall_memories(
    story_id: str,
    character_name: str,
    query: str,
    limit: int = 4,
) -> list[str]:
    """
    Retrieve the most relevant memories for a character at this debate moment.
    Uses Graphiti's hybrid search: semantic + graph traversal + temporal recency.
    Returns plain-text facts ready to inject into the character's context.
    """
    if not _ready or not _client:
        return []

    try:
        results = await _client.search(
            query=query,
            group_ids=[_group_id(story_id, character_name)],
            num_results=limit,
        )

        facts = []
        for r in results:
            fact = getattr(r, "fact", None) or getattr(r, "name", None) or str(r)
            if fact and isinstance(fact, str) and len(fact.strip()) > 10:
                facts.append(fact.strip())

        return facts[:limit]

    except Exception as e:
        logger.debug(f"Memory recall skipped (non-fatal): {e}")
        return []


def is_ready() -> bool:
    return _ready
