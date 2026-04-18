"""Export one completed WhatIfSabha debate to a self-contained JSON bundle.

Usage:
  python replay/scripts/export_debate.py --debate-id <uuid>
  python replay/scripts/export_debate.py --latest

Writes replay/public/debates/<debate-id>.json (relative to repo root).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DB = REPO_ROOT / "backend" / "whatif_sabha.db"
OUTPUT_DIR = REPO_ROOT / "replay" / "public" / "debates"
PORTRAIT_DIR = REPO_ROOT / "replay" / "public" / "portraits"

DISCLAIMER = (
    "This is an AI-generated alternate-ending exploration. All dialogue is "
    "synthetic and does not appear in the source work."
)

CHAR_PALETTE = [
    "#c07820", "#3b82f6", "#10b981", "#a855f7",
    "#ec4899", "#06b6d4", "#f97316", "#ef4444",
]


def _load(cursor: sqlite3.Cursor, sql: str, params: tuple) -> dict | None:
    cursor.execute(sql, params)
    row = cursor.fetchone()
    if not row:
        return None
    return {d[0]: row[i] for i, d in enumerate(cursor.description)}


def _parse_json(value: Any, default: Any) -> Any:
    if value is None or value == "":
        return default
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except (json.JSONDecodeError, TypeError):
        return default


def build_replay_json(db_path: Path, debate_id: str) -> dict:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()
        debate = _load(cur, "SELECT * FROM debates WHERE id = ?", (debate_id,))
        if not debate:
            raise ValueError(f"debate id {debate_id!r} not found in {db_path}")
        story = _load(cur, "SELECT * FROM stories WHERE id = ?", (debate["story_id"],))
        if not story:
            raise ValueError(f"story id {debate['story_id']!r} not found")

        analysis = _parse_json(story.get("analysis"), {})
        all_chars = analysis.get("characters", [])
        participating = _parse_json(debate.get("participating_characters"), [])
        participating_set = set(participating) if participating else None

        # Build character list — filter to participants, add colors + portraits
        chars_out = []
        for idx, ch in enumerate(all_chars):
            name = ch.get("name", "")
            if participating_set is not None and name not in participating_set:
                continue
            chars_out.append({
                "name": name,
                "role": ch.get("role", ""),
                "short_description": (ch.get("description") or "")[:200],
                "portrait_url": f"/portraits/{_safe_name(name)}.png",
                "color": CHAR_PALETTE[idx % len(CHAR_PALETTE)],
            })

        # Always include Boru (orchestrator) if he appears in transcript
        transcript = _parse_json(debate.get("transcript"), [])
        if any(t.get("character") == "Boru" for t in transcript):
            if not any(c["name"] == "Boru" for c in chars_out):
                chars_out.insert(0, {
                    "name": "Boru",
                    "role": "orchestrator",
                    "short_description": "Your wise and witty elephant host.",
                    "portrait_url": "/portraits/boru.png",
                    "color": "#c07820",
                })

        return {
            "version": "1",
            "debate_id": debate_id,
            "exported_at": _now_iso(),
            "disclaimer": DISCLAIMER,
            "story": {
                "title": story.get("title", ""),
                "author": story.get("author", ""),
                "summary": story.get("summary", "") or "",
                "divergence": debate.get("divergence_description", "") or "",
            },
            "characters": chars_out,
            "transcript": transcript,
            "alternate_ending": debate.get("alternate_ending", "") or "",
            "alternate_timeline": _parse_json(debate.get("alternate_timeline"), []),
        }
    finally:
        conn.close()


def _safe_name(name: str) -> str:
    return "".join(c if c.isalnum() else "_" for c in name.lower()).strip("_")


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _copy_portraits(chars: list[dict], source_dir: Path) -> None:
    PORTRAIT_DIR.mkdir(parents=True, exist_ok=True)
    for ch in chars:
        target = PORTRAIT_DIR / Path(ch["portrait_url"]).name
        candidate = source_dir / target.name
        if candidate.exists() and not target.exists():
            shutil.copy2(candidate, target)


def _find_latest_completed(db_path: Path) -> str | None:
    conn = sqlite3.connect(str(db_path))
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT id FROM debates WHERE transcript IS NOT NULL "
            "ORDER BY round_count DESC, completed_at DESC LIMIT 1"
        )
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Export one debate to JSON for the replay site.")
    ap.add_argument("--debate-id", help="Specific debate UUID to export")
    ap.add_argument("--latest", action="store_true",
                    help="Export the debate with the most turns")
    ap.add_argument("--db", default=str(DEFAULT_DB), help="SQLite DB path")
    ap.add_argument("--portraits-from",
                    default=str(REPO_ROOT / "backend" / "uploads" / "portraits"),
                    help="Source directory for character portrait images")
    args = ap.parse_args(argv)

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"error: db not found at {db_path}", file=sys.stderr)
        return 2

    debate_id = args.debate_id
    if args.latest or not debate_id:
        debate_id = _find_latest_completed(db_path)
        if not debate_id:
            print("error: no debates found", file=sys.stderr)
            return 2

    data = build_replay_json(db_path, debate_id)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / f"{debate_id}.json"
    out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))
    _copy_portraits(data["characters"], Path(args.portraits_from))

    print(f"wrote {out_path} ({len(data['transcript'])} turns, "
          f"{len(data['characters'])} characters)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
