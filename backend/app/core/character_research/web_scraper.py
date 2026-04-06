"""
Web scraper for character research.
Uses async httpx throughout — no blocking executor calls that starve the event loop.
DuckDuckGo search via their HTML interface (no API key, fully async).
"""
import httpx
import asyncio
import re
import urllib.parse
from typing import List, Optional
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
}

BLOCKED_DOMAINS = ["youtube.com", "amazon.com", "reddit.com", "pinterest.com", "twitter.com"]
PREFERRED_DOMAINS = [
    "sparknotes.com", "cliffsnotes.com", "litcharts.com", "gradesaver.com",
    "britannica.com", "worldhistory.org", "thehindu.com", "scroll.in",
    "academia.edu", "jstor.org", "enotes.com",
]


async def search_character_analysis(character_name: str, story_title: str) -> List[dict]:
    """
    Search for literary analysis of a character using DuckDuckGo HTML (fully async).
    Returns list of {url, title, content} dicts.
    """
    queries = [
        f"{character_name} {story_title} character analysis",
        f"{character_name} {story_title} alternative perspective",
    ]

    all_links = []
    seen_urls = set()

    async with httpx.AsyncClient(headers=HEADERS, timeout=8.0, follow_redirects=True) as client:
        for query in queries:
            if len(all_links) >= 4:
                break
            try:
                links = await _ddg_search_async(client, query)
                for link in links:
                    url = link.get("url", "")
                    if url and url not in seen_urls and not _is_blocked(url):
                        seen_urls.add(url)
                        all_links.append(link)
            except Exception:
                continue

        # Prioritize preferred domains
        all_links.sort(key=lambda r: 0 if any(d in r.get("url", "") for d in PREFERRED_DOMAINS) else 1)

        # Scrape top 2 pages
        scraped = []
        for link in all_links[:2]:
            try:
                result = await _scrape_page(client, link["url"], link.get("title", ""))
                if result:
                    scraped.append(result)
            except Exception:
                continue

    return scraped


async def _ddg_search_async(client: httpx.AsyncClient, query: str) -> List[dict]:
    """Query DuckDuckGo HTML endpoint asynchronously."""
    encoded = urllib.parse.quote_plus(query)
    url = f"https://html.duckduckgo.com/html/?q={encoded}"

    try:
        resp = await client.get(url, headers={**HEADERS, "Accept": "text/html"})
        if resp.status_code != 200:
            return []

        soup = BeautifulSoup(resp.text, "lxml")
        results = []

        for result in soup.select(".result")[:8]:
            title_el = result.select_one(".result__title a")
            snippet_el = result.select_one(".result__snippet")

            if not title_el:
                continue

            href = title_el.get("href", "")
            # DDG uses redirect URLs, extract actual URL
            if "uddg=" in href:
                import urllib.parse as up
                parsed = up.parse_qs(up.urlparse(href).query)
                href = parsed.get("uddg", [href])[0]
                href = urllib.parse.unquote(href)

            results.append({
                "url": href,
                "title": title_el.get_text(strip=True),
                "snippet": snippet_el.get_text(strip=True) if snippet_el else "",
            })

        return results
    except Exception:
        return []


async def _scrape_page(client: httpx.AsyncClient, url: str, title: str) -> Optional[dict]:
    """Fetch and extract clean text from a page."""
    try:
        resp = await client.get(url, timeout=5.0)
        if resp.status_code != 200:
            return None

        soup = BeautifulSoup(resp.text, "lxml")

        # Remove noise
        for tag in soup(["script", "style", "nav", "header", "footer",
                          "aside", "form", "iframe"]):
            tag.decompose()

        # Find main content
        content = ""
        for selector in ["article", "main", ".content", ".article-body",
                          "#content", ".post-content", "div.entry-content", "body"]:
            el = soup.select_one(selector)
            if el:
                content = el.get_text(separator=" ", strip=True)
                break

        content = re.sub(r"\s+", " ", content).strip()

        if len(content) < 200:
            return None

        return {"url": url, "title": title, "content": content[:2500]}

    except Exception:
        return None


def _is_blocked(url: str) -> bool:
    return any(domain in url for domain in BLOCKED_DOMAINS)
