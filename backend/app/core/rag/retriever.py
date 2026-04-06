from typing import List, Optional
from app.core.rag.embedder import get_embedding_model, get_or_create_collection


def retrieve_chunks(
    story_id: str,
    query: str,
    n_results: int = 5,
    max_timeline_position: Optional[float] = None,
) -> List[dict]:
    """
    Retrieve relevant story chunks for a query.
    Optionally filter to only chunks up to a timeline position
    (e.g. to get context available to a character at a given point).
    """
    model = get_embedding_model()
    collection = get_or_create_collection(story_id)

    query_embedding = model.encode([query]).tolist()

    where_filter = None
    if max_timeline_position is not None:
        where_filter = {"timeline_position": {"$lte": max_timeline_position}}

    results = collection.query(
        query_embeddings=query_embedding,
        n_results=n_results,
        where=where_filter,
        include=["documents", "metadatas", "distances"],
    )

    chunks = []
    for i, doc in enumerate(results["documents"][0]):
        chunks.append({
            "text": doc,
            "timeline_position": results["metadatas"][0][i]["timeline_position"],
            "relevance_score": 1 - results["distances"][0][i],
        })

    return chunks


def retrieve_character_context(
    story_id: str,
    character_name: str,
    timeline_position: float,
    n_results: int = 8,
) -> List[dict]:
    """Retrieve story passages most relevant to a character up to a timeline position."""
    return retrieve_chunks(
        story_id=story_id,
        query=f"{character_name} actions motivations thoughts feelings",
        n_results=n_results,
        max_timeline_position=timeline_position,
    )
