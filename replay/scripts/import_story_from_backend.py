"""Import a full story + cast + fair-witness + portraits from a running WhatIfSabha
backend into the replay demo JSON + public folder.

Usage:
  # Pick story by title (case-insensitive substring match, newest first if multiple):
  python replay/scripts/import_story_from_backend.py --title "Animal Farm"

  # Or pick by exact id:
  python replay/scripts/import_story_from_backend.py --story-id <uuid>

  # Custom backend URL (default http://localhost:8001):
  python replay/scripts/import_story_from_backend.py --backend http://localhost:8001 --title "Animal Farm"

  # Keep hand-authored Q&A, only refresh everything else (default):
  python replay/scripts/import_story_from_backend.py --title "Animal Farm"

  # Wipe Q&A too (you'll need to re-author or re-record):
  python replay/scripts/import_story_from_backend.py --title "Animal Farm" --reset-qa

Writes:
  replay/public/story.json       — overview + synopsis + timeline + themes + word count
  replay/public/characters.json  — cast with fair_witness, phases, traits, motivations, fears, internal_voice
  replay/public/portraits/*.jpg  — downloaded character portrait files
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from urllib.parse import quote

REPO_ROOT = Path(__file__).resolve().parents[2]
STORY_JSON    = REPO_ROOT / "replay" / "public" / "story.json"
CHARS_JSON    = REPO_ROOT / "replay" / "public" / "characters.json"
PORTRAIT_DIR  = REPO_ROOT / "replay" / "public" / "portraits"


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def get(backend: str, path: str) -> dict | list | None:
    """GET a JSON resource from the backend. Returns None on 404."""
    url = backend.rstrip("/") + path
    req = Request(url, headers={"Accept": "application/json"})
    try:
        with urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except HTTPError as e:
        if e.code == 404:
            return None
        raise
    except URLError as e:
        print(f"[ERROR] cannot reach {url}: {e}")
        sys.exit(2)


def download_portrait(backend: str, portrait_path: str, char_slug: str) -> str | None:
    """Download a portrait file and store it at public/portraits/{slug}.{ext}.
    Returns the path to use in JSON (relative to site root, e.g. '/portraits/napoleon.jpg').
    """
    if not portrait_path:
        return None

    # Portrait paths in the DB look like '/portraits/<filename>.<ext>'
    url = backend.rstrip("/") + portrait_path
    ext = Path(portrait_path).suffix or ".jpg"
    PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
    dest = PORTRAIT_DIR / f"{char_slug}{ext}"
    try:
        with urlopen(url, timeout=30) as r:
            dest.write_bytes(r.read())
    except (HTTPError, URLError) as e:
        print(f"[WARN] failed to download portrait for {char_slug} from {url}: {e}")
        return None
    return f"/portraits/{char_slug}{ext}"


def pick_story(backend: str, title: str | None, story_id: str | None) -> dict:
    if story_id:
        s = get(backend, f"/stories/{story_id}")
        if not s:
            print(f"[ERROR] no story with id {story_id}")
            sys.exit(2)
        return s

    stories = get(backend, "/stories") or []
    if not isinstance(stories, list):
        print(f"[ERROR] /stories did not return a list: {stories}")
        sys.exit(2)
    if not stories:
        print("[ERROR] no stories on the backend. Upload Animal Farm via the app first.")
        sys.exit(2)

    if title:
        needle = title.lower().strip()
        matches = [s for s in stories if needle in (s.get("title") or "").lower()]
        if not matches:
            print(f"[ERROR] no story with title containing '{title}'")
            print("Available titles:")
            for s in stories:
                print(f"  - {s.get('title')!r}  ({s.get('id')})")
            sys.exit(2)
        return matches[0]  # already sorted newest first by the backend
    return stories[0]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--backend", default="http://localhost:8001", help="Backend base URL")
    p.add_argument("--story-id", help="Exact story UUID")
    p.add_argument("--title", help="Substring match on title")
    p.add_argument("--reset-qa", action="store_true", help="Wipe existing Q&A arrays (default: preserve them)")
    args = p.parse_args()

    if not args.story_id and not args.title:
        args.title = "Animal Farm"

    print(f"[import] Backend: {args.backend}")
    print(f"[import] Looking for story...")
    story_meta = pick_story(args.backend, args.title, args.story_id)
    sid = story_meta["id"]
    print(f"[import] Selected: {story_meta['title']} ({sid})")

    # 1) Overview (rich analysis)
    overview = get(args.backend, f"/stories/{sid}/overview") or {}

    # 2) Characters list (with portraits)
    cast = get(args.backend, f"/stories/{sid}/characters") or []
    if not isinstance(cast, list):
        print(f"[WARN] /characters returned non-list: {cast}")
        cast = []

    # 3) Load existing Q&A to preserve unless --reset-qa
    existing_qa: dict[str, list] = {}
    if not args.reset_qa and CHARS_JSON.exists():
        try:
            old = json.loads(CHARS_JSON.read_text())
            for slug, entry in old.items():
                if isinstance(entry, dict) and entry.get("qa"):
                    existing_qa[slug] = entry["qa"]
        except Exception as e:
            print(f"[WARN] could not parse existing characters.json for Q&A carry-over: {e}")

    existing_story_qa: list = []
    if not args.reset_qa and STORY_JSON.exists():
        try:
            existing_story_qa = json.loads(STORY_JSON.read_text()).get("qa", [])
        except Exception:
            pass

    # 4) Fetch + enrich each character (Boru is the moderator — not a book character, not listed)
    characters_out: dict[str, dict] = {}

    for c in cast:
        name = c.get("name") or ""
        if not name:
            continue
        slug = slugify(name)

        # Fetch detailed view — this carries fair_witness, phases, timeline_phases, knowledge_events
        encoded_name = quote(name, safe="")
        detail = get(args.backend, f"/stories/{sid}/characters/{encoded_name}") or c

        portrait_url = None
        if detail.get("portrait"):
            portrait_url = download_portrait(args.backend, detail["portrait"], slug)

        # Pull fair_witness out so the page can render it directly
        fw = detail.get("fair_witness")

        # Personality traits live in phases[0].personality_traits in the backend.
        # Collapse to the current (first) phase for a simple flat view.
        phases = detail.get("phases") or []
        first_phase = phases[0] if phases else {}
        traits       = first_phase.get("personality_traits") or detail.get("personality_traits") or []
        motivations  = first_phase.get("motivations")         or detail.get("motivations")        or []
        fears        = first_phase.get("fears")               or detail.get("fears")              or []
        internal     = first_phase.get("internal_voice")      or detail.get("internal_voice")     or ""

        entry = {
            "slug": slug,
            "name": name,
            "role": detail.get("role") or "minor",
            "description": detail.get("description") or "",
            "importance": detail.get("importance"),
            "portrait_url": portrait_url,
            "aliases": detail.get("aliases") or [],
            "personality_traits": traits,
            "motivations": motivations,
            "fears": fears,
            "internal_voice": internal,
            "fair_witness": fw,
            "phases": phases,
            "timeline_phases": detail.get("timeline_phases") or [],
            "knowledge_events": detail.get("knowledge_events") or [],
            "timeline_metadata": detail.get("timeline_metadata"),
            "qa": existing_qa.get(slug, []),
        }
        characters_out[slug] = entry
        print(f"[import] {name:25s} role={entry['role']:12s} portrait={'yes' if portrait_url else 'no'} phases={len(phases)} fw={'yes' if fw else 'no'}")

    # 5) Rewrite story.json — preserve hand-authored timeline if present (it's not from the backend)
    existing_story: dict = {}
    if STORY_JSON.exists():
        try:
            existing_story = json.loads(STORY_JSON.read_text())
        except Exception:
            pass

    story_out = {
        "slug": slugify(story_meta.get("title", "")),
        "title": story_meta.get("title") or "",
        "author": story_meta.get("author") or "",
        "tagline": f"A bundled demo of WhatIfSabha running on {story_meta.get('title')}.",
        "demo_divergence": existing_story.get("demo_divergence", ""),
        "themes": story_meta.get("themes") or existing_story.get("themes") or [],
        "word_count": story_meta.get("word_count") or existing_story.get("word_count"),
        "synopsis": story_meta.get("summary") or existing_story.get("synopsis") or "",
        "timeline": existing_story.get("timeline", []),  # human-curated; preserved
        "overview": overview,                            # backend's rich analysis, full payload
        "qa": existing_story_qa,
    }

    STORY_JSON.write_text(json.dumps(story_out, indent=2, ensure_ascii=False))
    CHARS_JSON.write_text(json.dumps(characters_out, indent=2, ensure_ascii=False))

    print()
    print(f"[import] Wrote {STORY_JSON}")
    print(f"[import] Wrote {CHARS_JSON} ({len(characters_out)} characters)")
    print(f"[import] Portraits saved to {PORTRAIT_DIR}")
    print()
    print("Done. Rebuild the demo:")
    print("  cd replay && npm run build")


if __name__ == "__main__":
    main()
