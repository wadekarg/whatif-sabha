"""
Character Portrait Generator — uses Pollinations.ai (free, no API key needed)

Generates storybook-style portraits for each character based on their
description, role, and personality. Runs in parallel for all characters.
"""

import asyncio
import aiohttp
import logging
import os
import hashlib
from urllib.parse import quote
from typing import Optional

logger = logging.getLogger(__name__)

POLLINATIONS_URL = "https://image.pollinations.ai/prompt/{prompt}?width={width}&height={height}&nologo=true&seed={seed}"

# Portrait directory
PORTRAIT_DIR = "./uploads/portraits"


def _ensure_portrait_dir():
    os.makedirs(PORTRAIT_DIR, exist_ok=True)


def _portrait_path(story_id: str, character_name: str) -> str:
    """Generate a safe filename for the portrait."""
    safe_name = hashlib.md5(f"{story_id}_{character_name}".encode()).hexdigest()[:12]
    return os.path.join(PORTRAIT_DIR, f"{safe_name}.jpg")


def get_portrait_url(story_id: str, character_name: str) -> Optional[str]:
    """Get the portrait URL if it exists, else None."""
    path = _portrait_path(story_id, character_name)
    if os.path.exists(path):
        return f"/portraits/{os.path.basename(path)}"
    return None


def _build_prompt(character: dict, story_title: str) -> str:
    """Build an image generation prompt from character data."""
    name = character.get("name", "Unknown")
    role = character.get("role", "character")
    description = character.get("description", "")

    # Get personality traits from latest phase
    phases = character.get("phases", [])
    traits = []
    if phases:
        last_phase = phases[-1] if phases else {}
        traits = last_phase.get("personality_traits", [])[:3]

    # Build a rich but concise prompt
    trait_str = ", ".join(traits) if traits else ""

    prompt = (
        f"Portrait of {name}, a {role} from \"{story_title}\". "
        f"{description[:150]}. "
        f"{'Personality: ' + trait_str + '. ' if trait_str else ''}"
        f"Style: Painted storybook illustration, expressive face, warm muted tones, "
        f"detailed character portrait, no text or words, square composition, "
        f"soft lighting, book illustration aesthetic."
    )
    return prompt


async def generate_single_portrait(
    character: dict,
    story_id: str,
    story_title: str,
    session: aiohttp.ClientSession,
    width: int = 384,
    height: int = 384,
) -> Optional[str]:
    """
    Generate a portrait for a single character.
    Returns the local file path, or None on failure.
    """
    name = character.get("name", "Unknown")
    path = _portrait_path(story_id, name)

    # Skip if already exists
    if os.path.exists(path) and os.path.getsize(path) > 1000:
        logger.info(f"Portrait exists for {name}, skipping")
        return path

    prompt = _build_prompt(character, story_title)
    # Deterministic seed from character name for consistency
    seed = int(hashlib.md5(f"{story_id}_{name}".encode()).hexdigest()[:8], 16) % 100000

    url = POLLINATIONS_URL.format(
        prompt=quote(prompt),
        width=width,
        height=height,
        seed=seed,
    )

    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=45)) as resp:
            if resp.status == 200:
                data = await resp.read()
                if len(data) > 1000:  # sanity check — not an error page
                    with open(path, "wb") as f:
                        f.write(data)
                    logger.info(f"Portrait generated for {name} ({len(data)} bytes)")
                    return path
                else:
                    logger.warning(f"Portrait too small for {name} ({len(data)} bytes)")
            else:
                logger.warning(f"Portrait failed for {name}: HTTP {resp.status}")
    except asyncio.TimeoutError:
        logger.warning(f"Portrait timeout for {name}")
    except Exception as e:
        logger.warning(f"Portrait error for {name}: {e}")

    return None


async def generate_all_portraits(
    characters: list[dict],
    story_id: str,
    story_title: str,
    log_fn=None,
    max_concurrent: int = 4,
) -> dict[str, str]:
    """
    Generate portraits for all characters in parallel.
    Returns: {character_name: portrait_file_path}
    """
    _ensure_portrait_dir()

    if log_fn:
        await log_fn(f"🎨 Generating portraits for {len(characters)} characters...")

    results = {}
    semaphore = asyncio.Semaphore(max_concurrent)

    async with aiohttp.ClientSession() as session:
        async def _generate_bounded(char: dict):
            async with semaphore:
                path = await generate_single_portrait(char, story_id, story_title, session)
                if path:
                    results[char["name"]] = path
                    if log_fn:
                        await log_fn(f"🎨 Portrait ready: {char['name']}")

        await asyncio.gather(*[_generate_bounded(c) for c in characters])

    if log_fn:
        await log_fn(f"🎨 {len(results)}/{len(characters)} portraits generated")

    return results


async def generate_boru_portrait(story_id: str = "global") -> Optional[str]:
    """Generate Boru the Elephant's portrait (the Sabha Speaker)."""
    _ensure_portrait_dir()

    boru_char = {
        "name": "Boru",
        "role": "Speaker of the Sabha",
        "description": (
            "A wise, ancient elephant of immense age and dignity. "
            "He presides over debates with sharp wit and gentle authority. "
            "His eyes are deep and knowing, with a hint of mischief."
        ),
        "phases": [{"personality_traits": ["wise", "witty", "authoritative"]}],
    }

    async with aiohttp.ClientSession() as session:
        return await generate_single_portrait(
            boru_char, story_id, "WhatIfSabha", session,
            width=384, height=384,
        )
