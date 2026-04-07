"""
LightRAG-powered narrative causal graph builder.

Runs after Gemini story analysis to extract a proper causal knowledge graph
from the story text. Stores the result in story.analysis["causal_graph"].

LightRAG was designed for literary texts (demo uses Dickens) and outperforms
Microsoft GraphRAG on domain accuracy for fiction.
"""

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

LIGHTRAG_AVAILABLE = False
try:
    import lightrag  # noqa
    LIGHTRAG_AVAILABLE = True
except ImportError:
    pass


async def build_causal_graph(story_text: str, story_id: str) -> dict:
    """
    Use LightRAG to extract the causal knowledge graph from story text.
    Returns a dict with causal_chains, key_entities, and faction_map.
    Falls back to empty dict if LightRAG is not available.
    """
    if not LIGHTRAG_AVAILABLE:
        logger.info("lightrag-hku not installed — causal graph skipped")
        return {}

    from app.config import _key, get_settings

    groq_key = _key("GROQ_API_KEY")
    gemini_key = _key("GEMINI_API_KEY")

    if not groq_key and not gemini_key:
        logger.info("No LLM key for LightRAG — causal graph skipped")
        return {}

    working_dir = Path(f"./lightrag_data/{story_id}")
    working_dir.mkdir(parents=True, exist_ok=True)

    try:
        from lightrag import LightRAG, QueryParam
        from lightrag.utils import EmbeddingFunc
        import numpy as np

        # Use sentence-transformers for embeddings (already in requirements)
        from sentence_transformers import SentenceTransformer
        _embed_model = SentenceTransformer("all-MiniLM-L6-v2")

        async def embedding_func(texts: list[str]) -> np.ndarray:
            embeddings = _embed_model.encode(texts, convert_to_numpy=True)
            return embeddings

        # Use Groq for LLM (fast, free, OpenAI-compatible)
        async def llm_func(prompt: str, **kwargs) -> str:
            import httpx
            headers = {
                "Authorization": f"Bearer {groq_key or gemini_key}",
                "Content-Type": "application/json",
            }
            base_url = "https://api.groq.com/openai/v1" if groq_key else "https://generativelanguage.googleapis.com"
            payload = {
                "model": "llama-3.1-8b-instant",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1024,
            }
            async with httpx.AsyncClient(timeout=60) as client:
                r = await client.post(f"{base_url}/chat/completions", json=payload, headers=headers)
                r.raise_for_status()
                return r.json()["choices"][0]["message"]["content"]

        rag = LightRAG(
            working_dir=str(working_dir),
            llm_model_func=llm_func,
            embedding_func=EmbeddingFunc(
                embedding_dim=384,
                max_token_size=512,
                func=embedding_func,
            ),
        )

        # Truncate very long texts — LightRAG works best on focused excerpts
        text_for_graph = story_text[:80_000]
        await rag.ainsert(text_for_graph)

        # Extract causal chains
        causal_text = await rag.aquery(
            "List the key causal chains in this story: what events, decisions, or character actions caused other events? "
            "Format each as: [CAUSE] → [EFFECT]. Focus on pivotal moments that drove the plot.",
            param=QueryParam(mode="global"),
        )

        # Extract faction/community structure
        faction_text = await rag.aquery(
            "What are the main factions, groups, or power structures in this story? "
            "Who leads each faction and what do they want?",
            param=QueryParam(mode="global"),
        )

        # Extract hidden tensions
        tension_text = await rag.aquery(
            "What are the unresolved tensions, contradictions, and hidden conflicts in this story? "
            "What would have to change for the story to end differently?",
            param=QueryParam(mode="local"),
        )

        logger.info(f"LightRAG causal graph built for story {story_id[:8]}")
        return {
            "causal_chains": causal_text,
            "faction_map": faction_text,
            "hidden_tensions": tension_text,
        }

    except Exception as e:
        logger.warning(f"LightRAG causal graph failed (non-fatal): {e}")
        return {}
