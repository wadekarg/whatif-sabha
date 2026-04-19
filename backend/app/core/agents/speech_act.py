"""Pure heuristic for classifying a character turn's speech act.

Used downstream by the frontend graph to color edges (question vs response vs statement)
and by the orchestrator's dispute tracking.
"""
from __future__ import annotations
import re


def classify_speech_act(
    message: str,
    target_characters: list[str],
) -> str:
    """Return one of "question", "response", "statement".

    Rules:
    - No targets → "statement" (broad talk, no one in particular).
    - Has targets + message contains a real question directed at one of them → "question".
    - Has targets but no directed question → "response".

    A "real question" means: there is a '?' in the message AND the text around
    the '?' mentions one of the targets (or uses "you"/"your"/"you're" forms
    since targets are typically second-person).
    """
    if not target_characters or not message.strip():
        return "statement"

    if "?" not in message:
        return "response"

    # Split into sentences around '?'; check the sentences that END with ?
    # to see if they mention any target or second-person pronoun.
    question_sentences = _extract_question_sentences(message)
    target_set = {t.lower() for t in target_characters}

    for sent in question_sentences:
        sent_lower = sent.lower()
        # Does the sentence name a target explicitly?
        if any(t in sent_lower for t in target_set):
            return "question"
        # Second-person addressing counts as a question to the target (characters
        # typically use "you" to address whoever their @target is)
        if re.search(r"\b(you|your|you're|yours)\b", sent_lower):
            return "question"

    # Has '?' but rhetorical — no target is addressed in the question sentence.
    return "response"


def extract_question_target(
    message: str,
    target_characters: list[str],
) -> str | None:
    """Return the character the question is DIRECTED AT.

    Finds all question sentences (ending in '?'), then for each, looks for the
    target character mentioned most strongly (vocative > @mention > plain mention).

    Returns None if no question, or no target can be identified.
    """
    if not message or not target_characters:
        return None

    question_sentences = _extract_question_sentences(message)
    if not question_sentences:
        return None

    # Score each candidate target per question sentence.
    # Priority: @Name (+10), vocative Name (+8), name in sentence (+2).
    best: tuple[int, str] | None = None
    for sent in question_sentences:
        sent_lower = sent.lower()
        for target in target_characters:
            t_lower = target.lower()
            if t_lower not in sent_lower:
                continue
            score = 2  # baseline mention
            # @Target → strong signal
            if re.search(r"@" + re.escape(t_lower) + r"\b", sent_lower):
                score = max(score, 10)
            # Name, (vocative with comma)
            if re.search(r"\b" + re.escape(t_lower) + r"\s*,", sent_lower):
                score = max(score, 8)
            # Name? (vocative followed by ?)
            if re.search(r"\b" + re.escape(t_lower) + r"\s*\?", sent_lower):
                score = max(score, 8)
            if best is None or score > best[0]:
                best = (score, target)

    return best[1] if best else None


def _extract_question_sentences(message: str) -> list[str]:
    """Return the sentences that END with a '?'.

    Splits on sentence-ending punctuation then filters to questions.
    """
    # Split around ., !, ? but keep the punctuation attached to the preceding chunk
    parts = re.split(r"(?<=[.!?])\s+", message)
    return [p for p in parts if p.strip().endswith("?")]
