from typing import List, Optional
import re
from app.config import get_analysis_llm


def compute_drama_score(debate_history: list) -> float:
    """
    Heuristic drama score based on debate content.
    High drama: contradictions, direct address, emotional language.
    Low drama: repetition, agreement, short responses.
    """
    if len(debate_history) < 2:
        return 0.5

    recent = debate_history[-6:]
    score = 0.5

    speakers = [e["character"] for e in recent]
    unique_speakers = len(set(speakers))
    score += min(unique_speakers * 0.05, 0.2)

    last_messages = [e["message"].lower() for e in recent]
    direct_address_words = ["you", "your", "said", "told", "lied", "betrayed", "knew"]
    for msg in last_messages:
        if any(word in msg for word in direct_address_words):
            score += 0.05

    contradiction_words = ["no,", "wrong", "that's not", "never", "impossible", "disagree"]
    for msg in last_messages:
        if any(word in msg for word in contradiction_words):
            score += 0.08

    if len(speakers) >= 2 and speakers[-1] == speakers[-2]:
        score -= 0.15

    return min(max(score, 0.0), 1.0)


def _detect_question_target(message: str, char_names: list, last_speaker: str) -> Optional[str]:
    """
    If the message contains a question directed at a specific character, return their name.
    Looks for patterns like "Boxer, do you..." or "What say you, Snowball?" near a "?".
    """
    if "?" not in message:
        return None

    msg_lower = message.lower()
    # Find sentences containing "?"
    question_sentences = [s for s in re.split(r"[.!]", message) if "?" in s]

    for sentence in question_sentences:
        sent_lower = sentence.lower()
        for name in char_names:
            if name == last_speaker:
                continue
            if name.lower() in sent_lower:
                return name

    return None


def _score_candidates(
    debate_history: list,
    char_names: list,
    characters: list,
    last_speaker: str,
    last_message: str,
    last_entry: dict = None,
) -> dict:
    """
    Compute a priority score for each candidate speaker.

    Rewards:
    +3.0  was asked a direct question by last speaker
    +2.0  was addressed by name in last message (non-question)
    +1.0  per round of silence (recency reward — the longer they've been quiet, the more they deserve a turn)
    +0.5  has relevant motivations/traits matching last message keywords

    Penalties:
    -inf  is last speaker (no back-to-back, except for very dramatic moments)
    -1.0  per appearance in last 3 turns (recency penalty)
    """
    # Build recency: turns since each character last spoke
    last_spoke_at = {name: -1 for name in char_names}
    for i, entry in enumerate(debate_history):
        if entry["character"] in last_spoke_at:
            last_spoke_at[entry["character"]] = i

    total_turns = len(debate_history)

    # Build motivation keywords per character for relevance scoring
    char_traits = {}
    for c in characters:
        phases = c.get("phases", [])
        phase = phases[-1] if phases else {}
        traits = phase.get("personality_traits", []) + phase.get("motivations", []) + phase.get("fears", [])
        char_traits[c["name"]] = " ".join(traits).lower()

    scores = {}
    msg_lower = last_message.lower()
    question_target = _detect_question_target(last_message, char_names, last_speaker)

    # Also check target_characters from the last entry (multi-target support)
    last_targets = set()
    if isinstance(last_entry.get("target_characters"), list):
        last_targets = set(last_entry["target_characters"])

    # Boru's authority: if the MOST RECENT entry is from Boru and names a character,
    # that character MUST speak next (Boru's word is law in the Sabha)
    boru_called = set()
    if debate_history and debate_history[-1].get("isOrchestrator"):
        boru_msg = debate_history[-1].get("message", "").lower()
        for cn in char_names:
            if cn.lower() in boru_msg:
                boru_called.add(cn)

    # Count appearances in recent turns for recency penalty
    recent_turns = [e["character"] for e in debate_history[-4:]]

    for name in char_names:
        if name == last_speaker:
            scores[name] = -999  # cannot speak back-to-back
            continue

        score = 0.0

        # Recency reward: turns of silence → more pressure to speak
        # Scales with debate length so silent characters dominate in long debates.
        if last_spoke_at[name] == -1:
            score += min(3.0 + total_turns * 0.25, 12.0)
        else:
            turns_silent = total_turns - last_spoke_at[name]
            score += min(turns_silent * 0.4, 3.0)

        # Recency penalty for dominating recent turns
        recent_count = recent_turns.count(name)
        score -= recent_count * 1.0

        # Boru called this character by name — absolute priority (Boru's word is law)
        if name in boru_called:
            score += 15.0

        # Direct question reward — VERY strong, overrides almost everything
        elif question_target == name:
            score += 8.0

        # Named as a target by the speaker — strong signal (must respond)
        elif name in last_targets:
            score += 6.0

        # Named in message (addressed) — moderate signal
        elif name.lower() in msg_lower:
            score += 4.0

        # Relevance reward — does character have something to say about this topic?
        traits_text = char_traits.get(name, "")
        if traits_text:
            last_words = set(re.findall(r"\b\w{4,}\b", msg_lower))
            trait_words = set(re.findall(r"\b\w{4,}\b", traits_text))
            overlap = len(last_words & trait_words)
            score += min(overlap * 0.15, 0.5)

        scores[name] = score

    return scores


def pick_next_speaker(
    debate_history: list,
    characters: list,
    current_phase: str,
    round_number: int,
) -> str:
    """Reward-shaped speaker selection."""
    name, _forced, _scores = pick_next_speaker_with_scores(
        debate_history, characters, current_phase, round_number
    )
    return name


def pick_next_speaker_with_scores(
    debate_history: list,
    characters: list,
    current_phase: str,
    round_number: int,
) -> tuple[str, bool, dict]:
    """Heuristic speaker selection — returns (chosen_speaker, forced, all_scores).

    When the most-recent orchestrator turn has an ``intended_speaker`` field,
    that speaker is returned immediately with ``forced=True`` — all other
    scoring is skipped. This is how Boru's direct invitations become law.

    Otherwise the normal scoring runs as before, and ``forced=False``.
    """
    char_names = [c["name"] for c in characters]

    if not debate_history:
        scores = {n: (3.0 if i == 0 else 0.0) for i, n in enumerate(char_names)}
        return char_names[0], False, scores

    # ── Forced-speaker short-circuit ──
    last_entry = debate_history[-1]
    if last_entry.get("isOrchestrator"):
        intended = last_entry.get("intended_speaker")
        if intended and intended in char_names:
            # Boru's word is law — score dict still returned for diagnostics
            flat_scores = {n: (99.0 if n == intended else 0.0) for n in char_names}
            return intended, True, flat_scores

    # ── Normal scoring path ──
    # Find last REAL speaker (skip Boru/observers/reactions for scoring)
    for entry in reversed(debate_history):
        if (not entry.get("isOrchestrator") and not entry.get("isObserver")
                and not entry.get("isReaction") and not entry.get("isStageDirection")
                and not entry.get("isAudience")):
            last_entry = entry
            break

    last_speaker = last_entry["character"]
    last_message = last_entry["message"]

    scores = _score_candidates(
        debate_history, char_names, characters, last_speaker, last_message, last_entry
    )

    best = max(scores, key=lambda n: scores[n])
    return best, False, scores


def should_synthesize(
    debate_history: list,
    characters: list,
    max_rounds: int = 20,
) -> bool:
    """Decide if the debate has reached enough depth to synthesize the ending."""
    if len(debate_history) < len(characters) * 2:
        return False
    if len(debate_history) >= max_rounds:
        return True

    char_names = set(c["name"] for c in characters)
    spoken = {}
    for entry in debate_history:
        spoken[entry["character"]] = spoken.get(entry["character"], 0) + 1

    all_spoke_twice = all(spoken.get(n, 0) >= 2 for n in char_names)
    drama = compute_drama_score(debate_history)

    return all_spoke_twice and drama < 0.45


def determine_debate_phase(round_number: int, total_characters: int) -> str:
    if round_number < total_characters:
        return "opening"
    return "discussion"
