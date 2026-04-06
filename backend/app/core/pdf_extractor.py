import pdfplumber
import re
from pathlib import Path


def extract_text(pdf_path: str) -> dict:
    """
    Extract clean text from a PDF file.
    Returns text, word count, and page count.
    """
    path = Path(pdf_path)
    if not path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    pages_text = []

    with pdfplumber.open(pdf_path) as pdf:
        page_count = len(pdf.pages)
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                pages_text.append(text)

    full_text = "\n\n".join(pages_text)
    full_text = _clean_text(full_text)
    word_count = len(full_text.split())

    return {
        "full_text": full_text,
        "word_count": word_count,
        "page_count": page_count,
    }


def _clean_text(text: str) -> str:
    # Remove excessive whitespace
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r" {2,}", " ", text)
    # Remove page numbers (common pattern)
    text = re.sub(r"\n\d+\n", "\n", text)
    return text.strip()


def needs_chunking(word_count: int, threshold: int = 80_000) -> bool:
    """Stories above threshold need RAG chunking instead of full-context analysis."""
    return word_count > threshold
