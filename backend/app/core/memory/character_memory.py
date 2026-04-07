"""
Character Soul — Graphiti-powered temporal memory for debate characters.

Each character in each story gets a persistent knowledge graph that accumulates
across ALL debates ever run about them. Napoleon 'remembers' being called a
hypocrite last month. Boxer 'remembers' the moment he admitted his fear aloud.

Unlike a flat message history, Graphiti builds a temporal knowledge graph:
- Facts are extracted from debate turns (entities, relationships, positions)
- Each fact has a valid_from timestamp
- When Napoleon contradicts himself, the old fact is invalidated — not erased
- Search retrieves semantically relevant memories, not just recent ones

This gives characters genuine psychological depth across time.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Module-level singleton
_client: Optional[object] = None
_ready: bool = False


async def init_memory() -> None:
    """
    Initialize Graphiti at app startup.
    Safe to call multiple times. Fails silently if Neo4j not configured.
    """
    global _client, _ready

    try:
        from graphiti_core import Graphiti
        from graphiti_core.llm_client.openai_client import OpenAIClient
        from graphiti_core.llm_client.config import LLMConfig
    except ImportError:
        logger.info("graphiti-core not installed — character memory disabled. Run: pip install graphiti-core")
        return

    from app.config import get_settings, _key

    s = get_settings()
    neo4j_uri: Optional[str] = getattr(s, "NEO4J_URI", None)
    neo4j_user: str = getattr(s, "NEO4J_USER", "neo4j")
    neo4j_password: Optional[str] = getattr(s, "NEO4J_PASSWORD", None)

    if not neo4j_uri or not neo4j_password:
        logger.info("NEO4J_URI / NEO4J_PASSWORD not set — character memory disabled")
        return

    groq_key = _key("GROQ_API_KEY")
    if not groq_key:
        logger.info("GROQ_API_KEY not set — character memory disabled")
        return

    try:
        # Use Groq's llama-3.1-8b-instant for entity extraction (fast, free, OpenAI-compatible)
        llm_client = OpenAIClient(
            config=LLMConfig(
                api_key=groq_key,
                model="llama-3.1-8b-instant",
                base_url="https://api.groq.com/openai/v1",
            )
        )

        graphiti = Graphiti(
            uri=neo4j_uri,
            user=neo4j_user,
            password=neo4j_password,
            llm_client=llm_client,
        )
        await graphiti.build_indices_and_constraints()

        _client = graphiti
        _ready = True
        logger.info("✓ Character soul memory (Graphiti + Neo4j) initialized")

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

    Graphiti will extract entities and facts from the episode body —
    e.g., "Napoleon believes equality is a means to power" becomes a
    node+edge in the graph, queryable by future debates.
    """
    if not _ready or not _client:
        return

    try:
        from graphiti_core.nodes import EpisodeType

        # Framing the episode body so entity extraction captures character positions
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

    Uses Graphiti's hybrid search (semantic + graph traversal + temporal recency)
    to surface memories that matter RIGHT NOW — not just recent ones.

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
            # Graphiti returns EntityEdge objects with a .fact attribute
            fact = getattr(r, "fact", None) or getattr(r, "name", None) or str(r)
            if fact and isinstance(fact, str) and len(fact.strip()) > 10:
                facts.append(fact.strip())

        return facts[:limit]

    except Exception as e:
        logger.debug(f"Memory recall skipped (non-fatal): {e}")
        return []


def is_ready() -> bool:
    """Check if character memory is available."""
    return _ready
