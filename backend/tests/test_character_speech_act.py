"""Tests for speech-act classifier."""
import pytest

from app.core.agents.speech_act import classify_speech_act


# ── No target → statement ─────────────────────────────────────────
def test_no_target_is_statement():
    assert classify_speech_act("I think all revolutions fail.", []) == "statement"


def test_no_target_with_question_mark_still_statement():
    """Rhetorical question with no target isn't 'asking' anyone."""
    assert classify_speech_act("Who can trust pigs?", []) == "statement"


# ── Real questions directed at a named target ─────────────────────
def test_question_naming_target():
    assert classify_speech_act(
        "Napoleon, what did you do with the milk?",
        ["Napoleon"],
    ) == "question"


def test_question_with_you_pronoun_targeting():
    """Characters often use 'you' to address their @target."""
    assert classify_speech_act(
        "Napoleon is a tyrant. And you know it, don't you?",
        ["Napoleon"],
    ) == "question"


def test_multiple_targets_asked_together():
    assert classify_speech_act(
        "Napoleon and Squealer, will you ever stop lying?",
        ["Napoleon", "Squealer"],
    ) == "question"


# ── Responses (has target but not a real question) ─────────────────
def test_statement_with_target_is_response():
    assert classify_speech_act(
        "Napoleon, you are wrong about everything.",
        ["Napoleon"],
    ) == "response"


def test_rhetorical_question_without_target_name_is_response():
    """A question mark, but no target name or 'you' in the question itself
    → rhetorical → response."""
    assert classify_speech_act(
        "Napoleon, look at what's happening. Can the winter even be stopped?",
        ["Napoleon"],
    ) == "response"


def test_response_when_target_not_in_question_sentence():
    """Target is in the message but not in the sentence with '?' → rhetorical."""
    msg = "Listen to me. Is this really what we fought for? Napoleon, answer me!"
    # The question "Is this really what we fought for?" doesn't name Napoleon or use "you".
    # The sentence naming Napoleon ends in "!", not "?".
    assert classify_speech_act(msg, ["Napoleon"]) == "response"


# ── Edge cases ─────────────────────────────────────────────────────
def test_empty_message_is_statement():
    assert classify_speech_act("", ["Napoleon"]) == "statement"


def test_single_word_question():
    assert classify_speech_act("Why?", ["Napoleon"]) == "response"  # no named target, no 'you'
