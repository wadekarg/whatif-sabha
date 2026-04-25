"""Pre-render per-turn TTS audio for a bundled debate so the static demo
deployment can play voices without needing the backend.

Reads `replay/public/debates/<debate-id>.json`, generates an MP3 per
transcript turn (and one for the alternate-ending summary), and writes to
`replay/public/audio/<debate-id>/turn-<idx>.mp3` plus `summary.mp3`.

Usage:
  python replay/scripts/generate_demo_audio.py                    # picks the only / latest debate JSON
  python replay/scripts/generate_demo_audio.py 8654df3d-...       # specific debate id
  python replay/scripts/generate_demo_audio.py --reset             # delete existing files first
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
# Make the backend package importable so we can reuse the existing TTS pipeline
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.core.tts import generate_speech, assign_voices_to_cast, BORU_VOICE  # noqa: E402


async def render_one(text: str, voice: dict, emotion: str, dest: Path) -> int:
    """Generate a single MP3. Returns size in bytes (0 on failure or empty)."""
    if not (text or "").strip():
        return 0
    try:
        audio_bytes = await generate_speech(text, voice, emotion=emotion or "neutral")
    except Exception as e:
        print(f"  ! TTS failed: {e}")
        return 0
    if not audio_bytes:
        return 0
    dest.write_bytes(audio_bytes)
    return len(audio_bytes)


async def main(debate_id: str | None, reset: bool) -> int:
    debates_dir = REPO_ROOT / "replay" / "public" / "debates"
    audio_root  = REPO_ROOT / "replay" / "public" / "audio"

    if not debate_id:
        files = sorted(debates_dir.glob("*.json"))
        if not files:
            print("error: no debate JSON found in replay/public/debates/")
            return 2
        # If multiple, pick the largest (most-turns-likely)
        debate_path = max(files, key=lambda p: p.stat().st_size)
        debate_id = debate_path.stem
        print(f"[audio] picked latest debate: {debate_id}")
    else:
        debate_path = debates_dir / f"{debate_id}.json"

    if not debate_path.exists():
        print(f"error: debate not found at {debate_path}")
        return 2

    data = json.loads(debate_path.read_text())
    transcript = data.get("transcript") or []
    summary    = data.get("alternate_ending") or ""

    audio_dir = audio_root / debate_id
    if reset and audio_dir.exists():
        for f in audio_dir.glob("*.mp3"):
            f.unlink()
        print(f"[audio] reset: cleared {audio_dir}")
    audio_dir.mkdir(parents=True, exist_ok=True)

    # Voice assignment — assign_voices_to_cast reads the `description` field;
    # the bundled JSON uses `short_description` for character entries, so map it.
    chars = data.get("characters") or []
    chars_with_desc = [
        {**c, "description": c.get("short_description") or c.get("description") or ""}
        for c in chars
    ]
    voice_assignments = assign_voices_to_cast(chars_with_desc)

    print(f"[audio] {len(transcript)} turns to render → {audio_dir}")

    total_bytes = 0
    rendered = 0
    skipped  = 0
    failed   = 0
    for idx, turn in enumerate(transcript):
        # Skip non-spoken entries
        if turn.get("isReaction") or turn.get("isStageDirection"):
            continue
        text = turn.get("message") or ""
        if not text.strip():
            continue

        speaker = turn.get("character") or "Boru"
        emotion = turn.get("emotion") or "neutral"
        out_file = audio_dir / f"turn-{idx}.mp3"

        if out_file.exists() and not reset:
            skipped += 1
            print(f"  [{idx:3d}] {speaker[:24]:24s} cached")
            continue

        voice = voice_assignments.get(speaker, BORU_VOICE)
        size = await render_one(text, voice, emotion, out_file)
        if size:
            rendered += 1
            total_bytes += size
            print(f"  [{idx:3d}] {speaker[:24]:24s} {size//1024:>4d} KB  ({emotion})")
        else:
            failed += 1
            print(f"  [{idx:3d}] {speaker[:24]:24s} FAILED")

    # Summary — Boru reads it
    if summary.strip():
        out_file = audio_dir / "summary.mp3"
        if out_file.exists() and not reset:
            print("  summary                  cached")
        else:
            size = await render_one(summary, BORU_VOICE, "neutral", out_file)
            if size:
                rendered += 1
                total_bytes += size
                print(f"  summary                  {size//1024:>4d} KB")
            else:
                failed += 1

    print()
    print(f"[audio] rendered {rendered}, cached {skipped}, failed {failed}")
    print(f"[audio] total: {total_bytes / (1024*1024):.2f} MB in {audio_dir}")
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("debate_id", nargs="?", help="debate UUID (default: pick latest)")
    ap.add_argument("--reset", action="store_true", help="delete existing audio first")
    args = ap.parse_args()
    sys.exit(asyncio.run(main(args.debate_id, args.reset)) or 0)
