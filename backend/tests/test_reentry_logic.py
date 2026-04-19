"""Unit tests for drama-aware Boru re-entry logic."""
import pytest

from app.core.agents.reentry_logic import (
    should_boru_reenter,
    select_boru_intent,
)


# ── should_boru_reenter ────────────────────────────────────────────

def test_reenter_tier3_dispute_after_minimum_window():
    """Tier-3 dispute fires only after invitee has had at least 2 turns."""
    ok, reason = should_boru_reenter(
        window_turn_count=2, drama_score=0.8,
        tier3_dispute=True, phase_change_due=False,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is True
    assert reason == "tier3_dispute"


def test_tier3_dispute_blocked_before_minimum_window():
    """Tier-3 dispute should NOT override invitee's first follow-up."""
    ok, reason = should_boru_reenter(
        window_turn_count=1, drama_score=0.8,
        tier3_dispute=True, phase_change_due=False,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is False


def test_reenter_hard_ceiling():
    """At 8 turns without Boru, he always intervenes regardless of drama."""
    ok, reason = should_boru_reenter(
        window_turn_count=8, drama_score=0.9,
        tier3_dispute=False, phase_change_due=False,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is True
    assert reason == "hard_ceiling"


def test_no_reenter_below_cap_with_high_drama():
    """Below 6 turns with high drama, the window runs freely."""
    ok, reason = should_boru_reenter(
        window_turn_count=5, drama_score=0.75,
        tier3_dispute=False, phase_change_due=False,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is False


def test_reenter_default_cap_with_low_drama():
    """At 6 turns with drama below 0.6, Boru steps in."""
    ok, reason = should_boru_reenter(
        window_turn_count=6, drama_score=0.4,
        tier3_dispute=False, phase_change_due=False,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is True
    assert reason == "default_cap_low_drama"


def test_extended_window_when_drama_high_at_cap():
    """At 6 turns with drama >= 0.6, the window extends."""
    ok, reason = should_boru_reenter(
        window_turn_count=6, drama_score=0.7,
        tier3_dispute=False, phase_change_due=False,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is False


def test_stall_on_low_drama():
    """drama < 0.3 triggers stall re-entry regardless of turn count."""
    ok, reason = should_boru_reenter(
        window_turn_count=2, drama_score=0.2,
        tier3_dispute=False, phase_change_due=False,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is True
    assert reason == "stall"


def test_stall_on_flat_scores():
    """max(scores) < 1.0 triggers stall re-entry."""
    ok, reason = should_boru_reenter(
        window_turn_count=3, drama_score=0.7,
        tier3_dispute=False, phase_change_due=False,
        scores={"A": 0.5, "B": 0.3},
    )
    assert ok is True
    assert reason == "stall"


def test_phase_transition_lowest_priority():
    """Phase transition fires only when nothing else does."""
    ok, reason = should_boru_reenter(
        window_turn_count=3, drama_score=0.7,
        tier3_dispute=False, phase_change_due=True,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is True
    assert reason == "phase_transition"


def test_tier3_preempts_phase():
    """Priority: tier3 > hard_ceiling > default_cap > stall > phase."""
    ok, reason = should_boru_reenter(
        window_turn_count=2, drama_score=0.8,
        tier3_dispute=True, phase_change_due=True,
        scores={"A": 5.0, "B": 4.0},
    )
    assert ok is True
    assert reason == "tier3_dispute"


# ── select_boru_intent ────────────────────────────────────────────

def test_intent_tier3_dispute_picks_force_confrontation():
    intent, ctx = select_boru_intent(
        reason="tier3_dispute",
        tier3_dispute={"claim_a": {"character": "Napoleon", "claim": "X"},
                       "claim_b": {"character": "Squealer", "claim": "Y"},
                       "turns_unresolved": 5},
        phase_change=None,
        open_questions=[],
        speaker_diversity={"Napoleon": 5, "Squealer": 4, "Boxer": 0},
    )
    assert intent == "force_confrontation"
    assert ctx["char_a"] == "Napoleon"
    assert ctx["char_b"] == "Squealer"


def test_intent_phase_change_picks_phase_transition():
    intent, ctx = select_boru_intent(
        reason="phase_transition",
        tier3_dispute=None,
        phase_change={"from_phase": "opening", "to_phase": "cross_examination"},
        open_questions=[],
        speaker_diversity={"Napoleon": 2, "Squealer": 2},
    )
    assert intent == "phase_transition"
    assert ctx["from_phase"] == "opening"
    assert ctx["to_phase"] == "cross_examination"


def test_intent_stall_with_open_question_picks_forced_question():
    intent, ctx = select_boru_intent(
        reason="stall",
        tier3_dispute=None,
        phase_change=None,
        open_questions=[{"question": "Who benefits from the lie?",
                         "directed_to": ["Squealer"]}],
        speaker_diversity={"Napoleon": 3, "Squealer": 2, "Boxer": 1},
    )
    assert intent == "forced_question"
    assert ctx["target"] == "Squealer"
    assert "Who benefits" in ctx["question"]


def test_intent_rotate_voice_when_diversity_low():
    """When a few speakers dominate, pick the most silent to rotate in."""
    intent, ctx = select_boru_intent(
        reason="default_cap_low_drama",
        tier3_dispute=None,
        phase_change=None,
        open_questions=[],
        speaker_diversity={"Napoleon": 5, "Squealer": 4, "Boxer": 0, "Muriel": 0},
    )
    assert intent == "invite_speaker"
    assert ctx["speaker"] in ("Boxer", "Muriel")


def test_intent_rotate_prefers_silent_then_least_recent():
    """When one character is truly silent, pick them."""
    intent, ctx = select_boru_intent(
        reason="hard_ceiling",
        tier3_dispute=None,
        phase_change=None,
        open_questions=[],
        speaker_diversity={"Napoleon": 5, "Squealer": 4, "Muriel": 0},
    )
    assert intent == "invite_speaker"
    assert ctx["speaker"] == "Muriel"
