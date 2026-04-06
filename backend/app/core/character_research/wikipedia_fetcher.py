import httpx
import asyncio
from typing import Optional

WIKI_SEARCH_URL = "https://en.wikipedia.org/w/api.php"
WIKI_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"
WIKI_CONTENT_URL = "https://en.wikipedia.org/w/api.php"

HEADERS = {"User-Agent": "WhatIfSabha/1.0 (literary analysis tool; educational use)"}


async def fetch_wikipedia(character_name: str, story_title: str) -> Optional[dict]:
    """
    Search Wikipedia for a character and return structured data.
    Returns None gracefully if character not found (e.g. original stories).
    """
    async with httpx.AsyncClient(headers=HEADERS, timeout=10.0) as client:
        # Step 1: Search for the best matching article
        page_title = await _search_best_match(client, character_name, story_title)
        if not page_title:
            return None

        # Step 2: Fetch summary + full extract in parallel
        summary, full_text = await asyncio.gather(
            _fetch_summary(client, page_title),
            _fetch_full_extract(client, page_title),
        )

        if not summary:
            return None

        return {
            "found": True,
            "page_title": page_title,
            "summary": summary.get("extract", ""),
            "description": summary.get("description", ""),
            "full_extract": _extract_relevant_sections(full_text),
        }


async def _search_best_match(client: httpx.AsyncClient, character_name: str, story_title: str) -> Optional[str]:
    """Find the best Wikipedia article title for this character."""
    queries = [
        f"{character_name} {story_title}",
        f"{character_name} character",
        character_name,
    ]

    for query in queries:
        try:
            resp = await client.get(WIKI_SEARCH_URL, params={
                "action": "opensearch",
                "search": query,
                "limit": 3,
                "namespace": 0,
                "format": "json",
            })
            data = resp.json()
            titles = data[1] if len(data) > 1 else []

            # Find a title that contains the character name
            for title in titles:
                if character_name.lower() in title.lower():
                    return title

            if titles:
                return titles[0]

        except Exception:
            continue

    return None


async def _fetch_summary(client: httpx.AsyncClient, page_title: str) -> Optional[dict]:
    try:
        resp = await client.get(
            WIKI_SUMMARY_URL.format(title=page_title.replace(" ", "_"))
        )
        if resp.status_code == 200:
            return resp.json()
    except Exception:
        pass
    return None


async def _fetch_full_extract(client: httpx.AsyncClient, page_title: str) -> str:
    try:
        resp = await client.get(WIKI_CONTENT_URL, params={
            "action": "query",
            "titles": page_title,
            "prop": "extracts",
            "exintro": False,
            "explaintext": True,
            "exsectionformat": "plain",
            "format": "json",
        })
        data = resp.json()
        pages = data.get("query", {}).get("pages", {})
        for page in pages.values():
            return page.get("extract", "")
    except Exception:
        pass
    return ""


def _extract_relevant_sections(full_text: str) -> str:
    """
    Extract sections most relevant to character analysis.
    Filters out plot summaries to focus on analysis/criticism.
    """
    if not full_text:
        return ""

    relevant_keywords = [
        "character", "analysis", "criticism", "portrayal", "interpretation",
        "perspective", "motivation", "role", "significance", "legacy",
        "controversy", "debate", "scholarly", "cultural", "historical",
        "identity", "personality", "moral", "ethics", "dharma", "loyalty"
    ]

    lines = full_text.split("\n")
    relevant_lines = []
    capture = False

    for line in lines:
        line_lower = line.lower()
        # Start capturing if section heading matches
        if any(kw in line_lower for kw in relevant_keywords) and len(line) < 80:
            capture = True
        if capture:
            relevant_lines.append(line)
        # Stop after 800 words of relevant content
        if len(" ".join(relevant_lines).split()) > 800:
            break

    result = "\n".join(relevant_lines).strip()
    return result if result else full_text[:2000]
