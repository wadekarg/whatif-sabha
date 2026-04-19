"""
Text-to-Speech engine for WhatIfSabha debates.
Uses Edge TTS (Microsoft) — completely free, 300+ voices, no API key needed.

Each character gets a unique voice profile: base voice + rate/pitch/volume tweaks.
Voice is assigned during character extraction based on role, gender, and personality.
"""

import asyncio
import hashlib
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# ── Voice profiles: (voice_id, rate, pitch, volume) ──

# Male voices — all American English
MALE_VOICES = [
    # (voice_id, description)
    ("en-US-ChristopherNeural", "steady authoritative"),
    ("en-US-GuyNeural", "warm natural"),
    ("en-US-RogerNeural", "deep resonant"),
    ("en-US-EricNeural", "young energetic"),
    ("en-US-BrianNeural", "neutral clear"),
    ("en-US-BrianMultilingualNeural", "smooth versatile"),
    ("en-US-AndrewMultilingualNeural", "articulate"),
    ("en-US-SteffanNeural", "formal composed"),
]

FEMALE_VOICES = [
    ("en-US-JennyNeural", "friendly warm"),
    ("en-US-AriaNeural", "expressive dynamic"),
    ("en-US-EmmaNeural", "clear articulate"),
    ("en-US-EmmaMultilingualNeural", "versatile clear"),
    ("en-US-MichelleNeural", "steady composed"),
    ("en-US-AvaNeural", "young bright"),
    ("en-US-AvaMultilingualNeural", "versatile young"),
    ("en-US-AnaNeural", "soft gentle"),
]

# ── Multi-dimensional voice profiling ──
# Each trait keyword maps to 3 dimensions: (energy, authority, presence)
#   energy    → rate:   negative = slower, positive = faster
#   authority → pitch:  negative = higher, positive = deeper
#   presence  → volume: negative = quieter, positive = louder
#
# Values are -10 to +10 per dimension.

TRAIT_DIMENSIONS: dict[str, tuple[int, int, int]] = {
    # ── Power & Command ──
    "commanding":     (-6, +8, +8),    # slow, deep, loud
    "authoritarian":  (-7, +8, +9),    # slower, deeper, very loud
    "dictator":       (-7, +9, +9),
    "tyrant":         (-6, +8, +8),
    "ruthless":       (-4, +6, +7),
    "domineering":    (-5, +7, +7),
    "intimidating":   (-5, +7, +8),
    "powerful":       (-4, +6, +6),
    "leader":         (-3, +4, +5),
    "regal":          (-5, +5, +4),
    "dignified":      (-4, +4, +3),
    "proud":          (-3, +4, +4),

    # ── Cunning & Manipulation ──
    "cunning":        (+3, +2, -2),    # quicker, slightly deep, not loud
    "manipulative":   (+4, +1, -1),    # smooth and quick
    "scheming":       (+3, +2, -2),
    "sycophant":      (+6, -4, -3),    # fast, high/subservient, quiet
    "bootlicking":    (+7, -5, -4),    # very fast, high, very quiet
    "propaganda":     (+5, +1, +3),    # fast, smooth, projects
    "persuasive":     (+2, +1, +3),
    "deceptive":      (+3, +2, -1),
    "sly":            (+3, +2, -3),    # quick, slightly deep, quiet
    "treacherous":    (+2, +3, -1),
    "conniving":      (+4, +2, -2),
    "smooth":         (+1, +1, +1),
    "silver-tongued":  (+3, +1, +2),

    # ── Aggression & Anger ──
    "aggressive":     (+4, +4, +8),    # faster, deeper, very loud
    "fierce":         (+3, +5, +7),
    "violent":        (+5, +4, +8),
    "hot-tempered":   (+6, +2, +7),
    "brutal":         (-2, +6, +8),    # slow but forceful
    "savage":         (+3, +5, +7),
    "vengeful":       (-2, +4, +5),
    "wrathful":       (+3, +5, +8),

    # ── Calm & Composed ──
    "calm":           (-5, +2, -3),    # slow, slightly deep, quiet
    "composed":       (-4, +3, -1),
    "stoic":          (-6, +4, -3),    # very still, deep, quiet
    "serene":         (-5, +1, -4),
    "patient":        (-4, +1, -2),
    "measured":       (-4, +3, -1),
    "collected":      (-3, +2, -1),
    "zen":            (-6, +1, -5),
    "tranquil":       (-5, +0, -4),
    "unflappable":    (-4, +3, -2),

    # ── Wisdom & Intelligence ──
    "wise":           (-6, +5, +2),    # slow, deep, slightly louder
    "sage":           (-7, +6, +2),
    "intellectual":   (-3, +2, -1),
    "scholarly":      (-3, +1, -2),
    "thoughtful":     (-4, +2, -1),
    "philosophical":  (-4, +3, +0),
    "strategic":      (-3, +3, +0),
    "perceptive":     (-2, +2, -1),
    "clever":         (+2, +1, +0),
    "smart":          (+1, +1, +0),
    "brilliant":      (+1, +2, +1),
    "visionary":      (-3, +3, +3),

    # ── Nervousness & Anxiety ──
    "nervous":        (+8, -4, +2),    # very fast, higher, slightly loud
    "anxious":        (+7, -3, +1),
    "paranoid":       (+6, -3, +3),
    "timid":          (+3, -4, -6),    # faster, higher, very quiet
    "fearful":        (+5, -4, -3),
    "cowardly":       (+6, -5, -5),    # fast, high, quiet
    "jittery":        (+8, -3, +1),
    "insecure":       (+4, -3, -4),
    "stuttering":     (+2, -2, -3),

    # ── Warmth & Nurturing ──
    "gentle":         (-4, -1, -3),    # slow, slightly higher, soft
    "kind":           (-3, -1, -2),
    "nurturing":      (-4, -1, -2),
    "motherly":       (-4, -1, -1),
    "caring":         (-3, -1, -2),
    "compassionate":  (-3, -1, -1),
    "tender":         (-5, -2, -4),
    "warm":           (-3, -1, -1),
    "loving":         (-3, -2, -2),
    "empathetic":     (-3, -1, -2),
    "protective":     (-2, +2, +3),    # slightly deeper, louder

    # ── Bitterness & Cynicism ──
    "bitter":         (-3, +3, +2),    # slow, dark, slightly louder
    "cynical":        (-2, +3, -1),    # slightly slow, deep, normal vol
    "jaded":          (-4, +3, -2),
    "world-weary":    (-5, +3, -3),
    "resentful":      (-2, +3, +3),
    "sardonic":       (-1, +2, +0),
    "sarcastic":      (+2, +2, +1),
    "disillusioned":  (-4, +2, -2),
    "pessimistic":    (-3, +2, -2),
    "melancholy":     (-5, +1, -4),    # slow, flat, very quiet

    # ── Energy & Youth ──
    "energetic":      (+6, -2, +3),    # fast, slightly higher, louder
    "enthusiastic":   (+5, -2, +4),
    "young":          (+4, -3, +1),
    "youthful":       (+4, -3, +1),
    "vivacious":      (+5, -2, +3),
    "lively":         (+5, -1, +3),
    "playful":        (+4, -2, +2),
    "spirited":       (+4, -1, +3),
    "impulsive":      (+6, -1, +4),
    "reckless":       (+5, +0, +5),

    # ── Laziness & Indolence ──
    "lazy":           (-8, -1, -5),    # very slow, normal pitch, very quiet
    "indolent":       (-7, -1, -4),
    "apathetic":      (-6, +0, -5),
    "lethargic":      (-8, +0, -4),
    "idle":           (-6, -1, -4),
    "self-serving":   (-2, +0, -2),
    "aloof":          (-3, +1, -3),    # slow, slightly deep, quiet

    # ── Loyalty & Devotion ──
    "loyal":          (-2, +2, +2),    # steady, slightly deep, clear
    "devoted":        (-2, +1, +2),
    "faithful":       (-2, +1, +1),
    "obedient":       (-1, -2, -2),    # neutral rate, higher, quieter
    "dutiful":        (-2, +1, +0),
    "hardworking":    (-3, +2, +1),    # steady workhorse

    # ── Innocence & Naivety ──
    "innocent":       (+2, -4, -2),    # slightly faster, higher, softer
    "naive":          (+3, -3, -1),
    "trusting":       (+1, -2, -1),
    "simple":         (-1, -2, -2),
    "foolish":        (+3, -3, +1),
    "gullible":       (+2, -3, -1),
    "pure":           (-1, -3, -3),

    # ── Defiance & Rebellion ──
    "defiant":        (+3, +3, +7),    # faster, deeper, very loud
    "rebellious":     (+4, +2, +6),
    "stubborn":       (-2, +3, +5),    # slow, deep, loud
    "determined":     (-1, +3, +4),
    "resolute":       (-2, +3, +3),
    "unyielding":     (-3, +4, +4),

    # ── Grief & Sadness ──
    "grieving":       (-6, -1, -5),    # very slow, slightly higher, very quiet
    "sorrowful":      (-5, -1, -4),
    "mournful":       (-6, +0, -5),
    "weeping":        (-4, -2, -3),
    "broken":         (-6, -1, -6),
    "despairing":     (-4, +0, -4),
    "resigned":       (-5, +1, -4),

    # ── Grandeur & Theatricality ──
    "theatrical":     (+2, +2, +6),    # slightly fast, deep, very loud
    "dramatic":       (+1, +2, +5),
    "pompous":        (-4, +4, +6),    # slow, deep, loud
    "bombastic":      (+2, +3, +7),
    "grandiose":      (-3, +4, +6),

    # ── Roles (as descriptors) ──
    "protagonist":    (-2, +1, +3),
    "antagonist":     (-5, +5, +6),
    "supporting":     (+0, +0, +0),
    "mentor":         (-6, +5, +2),
    "comic":          (+5, -2, +3),
}

# Emotion-based voice modifiers — applied per-turn on top of character's base voice
EMOTION_MODIFIERS: dict[str, tuple[str, str, str]] = {
    # emotion: (rate_adjust, pitch_adjust, volume_adjust)
    "anger":                ("+8%",  "+3Hz",  "+15%"),    # faster, higher, louder
    "cold_fury":            ("-12%", "-6Hz",  "+5%"),     # very slow, deep, controlled
    "contempt":             ("-5%",  "+2Hz",  "+0%"),     # slow, slightly higher
    "grief":                ("-15%", "-4Hz",  "-10%"),    # slow, lower, quieter
    "desperation":          ("+12%", "+4Hz",  "+10%"),    # fast, higher, louder
    "pride":                ("-8%",  "-2Hz",  "+10%"),    # slow, authoritative
    "guilt":                ("-5%",  "-2Hz",  "-10%"),    # slow, quiet
    "shame":                ("-10%", "-3Hz",  "-15%"),    # very quiet, slow
    "defiance":             ("+5%",  "+2Hz",  "+15%"),    # strong, loud
    "bitterness":           ("-5%",  "-2Hz",  "+0%"),     # slow, dark
    "jealousy":             ("+5%",  "+3Hz",  "+5%"),     # tense, higher
    "longing":              ("-10%", "-3Hz",  "-5%"),     # slow, soft
    "righteous_indignation": ("+5%", "+3Hz",  "+15%"),    # loud, passionate
    "humiliation":          ("+8%",  "+4Hz",  "+10%"),    # fast, strained
    "weariness":            ("-12%", "-4Hz",  "-10%"),    # slow, tired, quiet
    "hope":                 ("-5%",  "+2Hz",  "-5%"),     # gentle, slightly higher
    "betrayal":             ("-8%",  "-2Hz",  "+5%"),     # slow, intense
    "indignation":          ("+5%",  "+3Hz",  "+15%"),    # same as righteous
    "neutral":              ("+0%",  "+0Hz",  "+0%"),
}


# Pronunciation map — word → phonetic respelling that Edge TTS pronounces correctly.
# The display text (transcript) is unchanged; only the TTS audio input gets the swap.
PRONUNCIATION_MAP = {
    # "sabha" is often read with a short final 'a' by English TTS.
    # "sabhaa" forces the elongated vowel that matches the actual Sanskrit-origin pronunciation.
    r"\bsabha\b":  "sabhaa",
    r"\bSabha\b":  "Sabhaa",
    r"\bSABHA\b":  "SABHAA",
}


def _apply_pronunciation_fixes(text: str) -> str:
    """Replace specific words with phonetic respellings for TTS only."""
    for pattern, replacement in PRONUNCIATION_MAP.items():
        text = re.sub(pattern, replacement, text)
    return text


def _clean_text_for_speech(text: str) -> str:
    """
    Clean text so TTS reads it like a human:
    - Strip @targets, markdown, asterisks
    - Add pauses at paragraph breaks and dramatic punctuation
    - Clean up artifacts
    - Apply pronunciation fixes (e.g. 'sabha' → 'sabhaa')
    """
    # Remove @CharacterName lines (target declarations)
    text = re.sub(r'^@\w[\w\s]*\n?', '', text, flags=re.MULTILINE)
    # Remove inline @mentions at start of sentences
    text = re.sub(r'@(\w+)', r'\1', text)

    # Pronunciation fixes — keep transcript text unchanged, only affect TTS audio
    text = _apply_pronunciation_fixes(text)

    # Strip markdown
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)  # **bold**
    text = re.sub(r'\*(.+?)\*', r'\1', text)        # *italic*
    text = re.sub(r'_(.+?)_', r'\1', text)           # _italic_
    text = re.sub(r'#{1,6}\s*', '', text)             # ### headers
    text = re.sub(r'`(.+?)`', r'\1', text)            # `code`
    text = re.sub(r'\[(.+?)\]\(.+?\)', r'\1', text)   # [links](url)

    # Add pauses: paragraph breaks → long pause
    text = re.sub(r'\n\n+', '. ... ', text)
    # Single newlines → short pause
    text = re.sub(r'\n', '. ', text)

    # Dramatic punctuation → add pauses
    # "..." and "—" get a beat
    text = re.sub(r'\.\.\.', ', ,', text)          # ellipsis → pause
    text = re.sub(r'\s*—\s*', ', , ', text)         # em dash → pause
    text = re.sub(r'\s*–\s*', ', ', text)           # en dash → short pause

    # Clean up multiple spaces/periods
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r'[,.]\s*[,.]\s*[,.]', ', ,', text)  # normalize multiple pauses

    return text.strip()


def apply_emotion(voice_profile: dict, emotion: str) -> dict:
    """
    Apply emotion modifiers to a voice profile.
    Returns a new profile with adjusted rate/pitch/volume.
    """
    mods = EMOTION_MODIFIERS.get(emotion, EMOTION_MODIFIERS["neutral"])
    if mods == ("+0%", "+0Hz", "+0%"):
        return voice_profile

    return {
        "voice": voice_profile["voice"],
        "rate": _clamp_pct(_combine_pct(voice_profile.get("rate", "+0%"), mods[0]), -12, 20),
        "pitch": _combine_hz(voice_profile.get("pitch", "+0Hz"), mods[1]),
        "volume": _clamp_pct(_combine_pct(voice_profile.get("volume", "+0%"), mods[2]), -10, 20),
    }


# Boru always gets this voice — warm, clear, authoritative
BORU_VOICE = {
    "voice": "en-US-AndrewNeural",
    "rate": "-5%",
    "pitch": "-3Hz",
    "volume": "+5%",
}

# Audio cache directory
AUDIO_DIR = Path("./uploads/tts_cache")


def _collect_character_text(character: dict) -> str:
    """Gather all text about a character for personality analysis."""
    parts = []
    parts.append(character.get("description", ""))
    parts.append(character.get("role", ""))

    # Phase data — traits, motivations, fears, internal voice
    phases = character.get("phases", [])
    if phases:
        p = phases[0] if isinstance(phases, list) else phases
        for field in ["personality_traits", "motivations", "fears"]:
            val = p.get(field, [])
            if isinstance(val, list):
                parts.extend(str(v) for v in val)
            elif val:
                parts.append(str(val))
        parts.append(p.get("internal_voice", ""))

    # Top-level traits
    top_traits = character.get("personality_traits", [])
    if isinstance(top_traits, list):
        parts.extend(str(t) for t in top_traits)

    # Fair witness data — rich personality insight
    fw = character.get("fair_witness", {})
    if fw:
        for field in ["consensus_view", "hidden_motivations", "speaks_as",
                       "narrative_bias", "charitable_reading"]:
            parts.append(str(fw.get(field, "")))
        fw_traits = fw.get("fair_personality_traits", [])
        if isinstance(fw_traits, list):
            parts.extend(str(t) for t in fw_traits)

    return " ".join(p for p in parts if p).lower()


def _score_voice_dimensions(character: dict) -> tuple[float, float, float]:
    """
    Score a character on 3 voice dimensions by matching their full personality
    text against the TRAIT_DIMENSIONS database.

    Returns: (energy, authority, presence) — each roughly -30 to +30
      energy    → rate:   negative = slower, positive = faster
      authority → pitch:  positive = deeper, negative = higher
      presence  → volume: positive = louder, negative = quieter
    """
    text = _collect_character_text(character)

    energy = 0.0
    authority = 0.0
    presence = 0.0
    matches = 0

    for keyword, (e, a, p) in TRAIT_DIMENSIONS.items():
        # Count occurrences with word boundaries
        count = len(re.findall(r'\b' + re.escape(keyword) + r'\b', text))
        if count > 0:
            # Diminishing returns — first match counts full, subsequent less
            weight = min(count, 3)
            energy += e * weight
            authority += a * weight
            presence += p * weight
            matches += weight

    # Normalize — average across matches, but keep magnitude
    if matches > 0:
        scale = min(matches, 8) / 8  # more matches = more confident = stronger effect
        energy = (energy / matches) * scale * 8
        authority = (authority / matches) * scale * 8
        presence = (presence / matches) * scale * 8

    return (energy, authority, presence)


def assign_voice(character: dict, existing_assignments: dict) -> dict:
    """
    Assign a unique voice profile using multi-dimensional personality scoring.
    Scans ALL character data (description, traits, motivations, fears, fair witness)
    and scores across energy/authority/presence dimensions.
    Returns: {voice, rate, pitch, volume}
    """
    name = character.get("name", "")

    if name.lower() == "boru":
        return BORU_VOICE

    # ── Voice selection ──
    gender = _guess_gender(character)
    voice_pool = FEMALE_VOICES if gender == "female" else MALE_VOICES
    voice_pool = [v for v in voice_pool if v[0] != BORU_VOICE["voice"]]

    used_voices = {v["voice"] for v in existing_assignments.values()}
    available = [v for v in voice_pool if v[0] not in used_voices]
    if not available:
        available = voice_pool

    name_hash = int(hashlib.md5(name.encode()).hexdigest(), 16)
    voice_id, _ = available[name_hash % len(available)]

    # ── Dimensional scoring ──
    energy, authority, presence = _score_voice_dimensions(character)

    # If scoring found nothing (sparse data), use role-based defaults
    # Every character gets at least a "normal person" baseline — never 0/0/0 (sounds robotic)
    if abs(energy) < 1 and abs(authority) < 1 and abs(presence) < 1:
        role = character.get("role", "")
        role_defaults = {
            "protagonist": (+2, +2, +3),    # slightly energetic, confident
            "antagonist":  (-3, +5, +5),     # slow, deep, loud
            "supporting":  (+3, +1, +1),     # natural pace
            "minor":       (+4, -1, +0),     # slightly faster (less important = quicker)
            "mentor":      (-2, +4, +2),     # measured, deep
        }
        energy, authority, presence = role_defaults.get(role, (+3, +0, +1))  # default: normal conversational

    # Clamp to safe ranges — nothing too slow or too quiet
    rate_pct = int(max(-10, min(20, energy)))
    pitch_hz = int(max(-10, min(12, authority)))
    vol_pct = int(max(-8, min(15, presence)))

    logger.info(
        f"[VOICE] {name}: gender={gender} energy={energy:.1f} authority={authority:.1f} "
        f"presence={presence:.1f} → rate={rate_pct:+d}% pitch={pitch_hz:+d}Hz vol={vol_pct:+d}%"
    )

    return {
        "voice": voice_id,
        "rate": f"{rate_pct:+d}%",
        "pitch": f"{pitch_hz:+d}Hz",
        "volume": f"{vol_pct:+d}%",
    }


def _guess_gender(character: dict) -> str:
    """Guess character gender from name, description, fair witness data, and internal voice."""
    # Check explicit field
    if character.get("gender"):
        return character["gender"].lower()

    name = character.get("name", "").strip()
    name_lower = name.lower()

    # ── Strong name signals (highest priority) ──
    if name_lower.startswith("mrs") or name_lower.startswith("mrs."):
        return "female"
    if name_lower.startswith("mr ") or name_lower.startswith("mr."):
        return "male"

    # Known female names (literature, mythology, common)
    KNOWN_FEMALE = {
        "mollie", "molly", "clover", "jessie", "bluebell", "muriel", "minimus",
        "ophelia", "gertrude", "juliet", "desdemona", "portia", "cordelia", "lady macbeth",
        "sita", "draupadi", "kunti", "gandhari", "subhadra", "shakuntala", "savitri",
        "elizabeth", "jane", "emma", "catherine", "mary", "margaret", "anne", "alice",
        "hester", "scarlett", "daisy", "jo", "meg", "beth", "amy",
    }
    KNOWN_MALE = {
        "napoleon", "snowball", "squealer", "boxer", "benjamin", "moses", "jones", "pilkington", "frederick",
        "hamlet", "claudius", "horatio", "laertes", "polonius", "macbeth",
        "arjuna", "bhima", "yudhishthira", "duryodhana", "karna", "krishna", "rama", "ravana",
        "romeo", "othello", "prospero", "lear", "shylock",
        "gatsby", "atticus", "heathcliff", "darcy", "rochester",
    }

    first_name = name_lower.split()[0] if name_lower else ""
    full_name_lower = name_lower.replace(" ", "")

    if first_name in KNOWN_FEMALE or name_lower in KNOWN_FEMALE:
        return "female"
    if first_name in KNOWN_MALE or name_lower in KNOWN_MALE:
        return "male"

    # ── Description analysis (fallback) ──
    texts = [character.get("description", "")]
    fw = character.get("fair_witness", {})
    if fw:
        texts.append(fw.get("consensus_view", ""))
        texts.append(fw.get("speaks_as", ""))
    phases = character.get("phases", [])
    if phases:
        p = phases[0] if isinstance(phases, list) else phases
        texts.append(p.get("internal_voice", ""))

    full_text = " ".join(str(t) for t in texts if t).lower()

    # Strong female indicators (less ambiguous than pronouns)
    female_strong = [r"\bmother\b", r"\bmare\b", r"\bsow\b", r"\bqueen\b",
                     r"\bprincess\b", r"\bwoman\b", r"\bfemale\b", r"\bwife\b",
                     r"\bdaughter\b", r"\bsister\b", r"\blady\b", r"\bmatriarch\b",
                     r"\bhen\b", r"\bfilly\b", r"\bdoe\b", r"\bewe\b"]
    male_strong = [r"\bboar\b", r"\bstallion\b", r"\bking\b", r"\bprince\b",
                   r"\bfather\b", r"\bhusband\b", r"\bson\b", r"\bbrother\b",
                   r"\blord\b", r"\bpatriarch\b", r"\bram\b", r"\bbull\b", r"\bcock\b"]

    female_score = sum(len(re.findall(p, full_text)) for p in female_strong)
    male_score = sum(len(re.findall(p, full_text)) for p in male_strong)

    # Pronouns as weak signal (only if no strong signals found)
    if female_score == 0 and male_score == 0:
        female_score = len(re.findall(r"\bshe\b", full_text)) + len(re.findall(r"\bherself\b", full_text))
        male_score = len(re.findall(r"\bhe\b", full_text)) + len(re.findall(r"\bhimself\b", full_text))

    if female_score > male_score:
        return "female"
    if male_score > female_score:
        return "male"

    # Default to male (most literary characters skew male historically)
    return "male"


def _detect_villain(character: dict) -> bool:
    """Detect if a character is a villain/antagonist from role, description, and fair witness data."""
    role = character.get("role", "").lower()
    if role == "antagonist":
        return True

    # Check fair witness narrative_bias — villains often have "portrayed unfairly" markers
    fw = character.get("fair_witness", {})
    bias = str(fw.get("narrative_bias", "")).lower()
    if any(w in bias for w in ["villain", "tyrant", "oppressor", "cruel", "corrupt"]):
        return True

    # Check description for villain signals
    desc = character.get("description", "").lower()
    villain_signals = ["tyrant", "dictator", "ruthless", "cruel", "oppressor", "manipulat",
                       "corrupt", "treacherous", "despot", "authoritarian", "propaganda"]
    return sum(1 for s in villain_signals if s in desc) >= 2


def _clamp_pct(val: str, lo: int, hi: int) -> str:
    """Clamp a percentage string like '-15%' to the range [lo, hi]."""
    v = int(val.replace("%", "").replace("+", ""))
    return f"{max(lo, min(hi, v)):+d}%"


def _combine_pct(a: str, b: str) -> str:
    """Combine two percentage adjustments like '-5%' and '+3%'."""
    va = int(a.replace("%", "").replace("+", ""))
    vb = int(b.replace("%", "").replace("+", ""))
    total = va + vb
    total = max(-30, min(30, total))  # clamp
    return f"{total:+d}%"


def _combine_hz(a: str, b: str) -> str:
    """Combine two Hz adjustments like '-5Hz' and '+3Hz'."""
    va = int(a.replace("Hz", "").replace("+", ""))
    vb = int(b.replace("Hz", "").replace("+", ""))
    total = va + vb
    total = max(-20, min(20, total))  # clamp
    return f"{total:+d}Hz"


def assign_voices_to_cast(characters: list[dict]) -> dict[str, dict]:
    """
    Assign unique voices to all characters in a story.
    Returns: {character_name: {voice, rate, pitch, volume}}
    """
    assignments = {}
    for char in characters:
        name = char.get("name", "")
        assignments[name] = assign_voice(char, assignments)

    # Always add Boru
    if "Boru" not in assignments:
        assignments["Boru"] = BORU_VOICE

    return assignments


async def generate_speech(
    text: str,
    voice_profile: dict,
    emotion: str = "neutral",
    cache_key: str = None,
) -> bytes:
    """
    Generate MP3 audio for text using the given voice profile.
    Cleans markdown/@targets, applies emotion modifiers, adds natural pauses.
    Returns raw MP3 bytes. Uses file cache to avoid regenerating.
    """
    import edge_tts

    # Cache check
    if cache_key:
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        cache_path = AUDIO_DIR / f"{cache_key}.mp3"
        if cache_path.exists():
            return cache_path.read_bytes()

    # Clean text for natural speech
    clean = _clean_text_for_speech(text)
    if not clean:
        return b""

    # Apply emotion modifiers
    profile = apply_emotion(voice_profile, emotion)

    comm = edge_tts.Communicate(
        clean,
        profile["voice"],
        rate=profile.get("rate", "+0%"),
        pitch=profile.get("pitch", "+0Hz"),
        volume=profile.get("volume", "+0%"),
    )

    # Collect audio chunks
    audio_data = bytearray()
    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            audio_data.extend(chunk["data"])

    audio_bytes = bytes(audio_data)

    # Cache for reuse
    if cache_key and audio_bytes:
        AUDIO_DIR.mkdir(parents=True, exist_ok=True)
        cache_path = AUDIO_DIR / f"{cache_key}.mp3"
        cache_path.write_bytes(audio_bytes)

    return audio_bytes


async def generate_speech_stream(text: str, voice_profile: dict):
    """
    Stream MP3 audio chunks for text. Yields raw bytes as they arrive.
    """
    import edge_tts

    # Apply pronunciation fixes so the audio pronounces 'sabha' as 'sabhaa', etc.
    text = _apply_pronunciation_fixes(text)

    comm = edge_tts.Communicate(
        text,
        voice_profile["voice"],
        rate=voice_profile.get("rate", "+0%"),
        pitch=voice_profile.get("pitch", "+0Hz"),
        volume=voice_profile.get("volume", "+0%"),
    )

    async for chunk in comm.stream():
        if chunk["type"] == "audio":
            yield chunk["data"]
