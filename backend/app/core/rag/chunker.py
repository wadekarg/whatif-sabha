from typing import List
import re


def chunk_text(full_text: str, chunk_size: int = 1000, overlap: int = 150) -> List[dict]:
    """
    Split story text into overlapping chunks tagged with position metadata.
    Used for long stories that don't fit in context window.
    """
    words = full_text.split()
    total_words = len(words)
    chunks = []
    start = 0
    chunk_index = 0

    while start < total_words:
        end = min(start + chunk_size, total_words)
        chunk_words = words[start:end]
        chunk_text = " ".join(chunk_words)

        timeline_position = start / total_words

        chunks.append({
            "chunk_id": f"chunk_{chunk_index}",
            "text": chunk_text,
            "word_start": start,
            "word_end": end,
            "timeline_position": round(timeline_position, 4),
            "word_count": len(chunk_words),
        })

        start += chunk_size - overlap
        chunk_index += 1

    return chunks


def chunk_by_chapter(full_text: str) -> List[dict]:
    """
    Split by chapter markers when available — more semantically meaningful.
    Falls back to word-based chunking if no chapters detected.
    """
    chapter_pattern = re.compile(
        r"(chapter\s+\w+|chapter\s+\d+|part\s+\w+|\bchapter\b)",
        re.IGNORECASE
    )

    splits = chapter_pattern.split(full_text)

    if len(splits) <= 2:
        # No chapter structure found
        return chunk_text(full_text)

    chapters = []
    total_words = len(full_text.split())
    word_cursor = 0

    for i in range(1, len(splits), 2):
        heading = splits[i].strip()
        body = splits[i + 1].strip() if i + 1 < len(splits) else ""
        content = f"{heading}\n\n{body}"
        chapter_words = len(content.split())

        chapters.append({
            "chunk_id": f"chapter_{len(chapters)}",
            "text": content,
            "chapter_heading": heading,
            "word_start": word_cursor,
            "word_end": word_cursor + chapter_words,
            "timeline_position": round(word_cursor / total_words, 4),
            "word_count": chapter_words,
        })

        word_cursor += chapter_words

    return chapters
