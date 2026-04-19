"""Tests for the intended_speaker extraction in generate_orchestrator_message."""
import pytest

from app.core.agents.sabha_orchestrator import (
    generate_orchestrator_message,
    intended_speaker_for,
)


pytestmark = pytest.mark.asyncio


CHARS = [
    {"name": "Napoleon", "role": "antagonist"},
    {"name": "Squealer", "role": "supporting"},
    {"name": "Boxer",    "role": "supporting"},
]


# ── intended_speaker_for — pure helper, no LLM ────────────────────

def test_intended_speaker_invite_speaker():
    assert intended_speaker_for("invite_speaker", {"speaker": "Boxer"}) == "Boxer"


def test_intended_speaker_forced_question():
    assert intended_speaker_for("forced_question", {"target": "Napoleon"}) == "Napoleon"


def test_intended_speaker_break_duel():
    assert intended_speaker_for("break_duel", {"next_speaker": "Muriel"}) == "Muriel"


def test_intended_speaker_force_confrontation():
    assert intended_speaker_for(
        "force_confrontation",
        {"char_a": "Napoleon", "char_b": "Squealer"},
    ) == "Napoleon"


def test_intended_speaker_broadcast_events_return_none():
    """These events target 'all' or no one — no single invitee."""
    for event_type in (
        "opening_with_invite",
        "phase_intro",
        "phase_transition",
        "dispute_callout",
        "observer_intro",
        "summon_observer",
        "closing_summary",
        "redirect",
    ):
        assert intended_speaker_for(event_type, {}) is None, f"{event_type} should be None"


def test_intended_speaker_unknown_event_returns_none():
    assert intended_speaker_for("some_new_future_event", {}) is None


# ── generate_orchestrator_message returns tuple ────────────────────

async def test_generate_returns_tuple_with_intended_speaker(monkeypatch):
    """Call with invite_speaker event — returns (text, 'Boxer')."""
    async def fake_invoke(_msgs):
        return "Boxer, you have the floor."

    monkeypatch.setattr(
        "app.core.agents.sabha_orchestrator._invoke_with_fallback",
        fake_invoke,
    )

    # Minimal fake ledger
    class _Ledger:
        def to_context(self): return ""
        open_questions = []
        divergence = "what-if"

    msg, invitee = await generate_orchestrator_message(
        ledger=_Ledger(),
        current_phase="opening",
        transcript=[],
        characters=CHARS,
        story_title="Animal Farm",
        event_type="invite_speaker",
        context={"speaker": "Boxer", "directive": "share your view"},
    )
    assert isinstance(msg, str)
    assert msg
    assert invitee == "Boxer"


async def test_generate_returns_none_invitee_for_broadcast(monkeypatch):
    async def fake_invoke(_msgs):
        return "Moving into cross-examination."

    monkeypatch.setattr(
        "app.core.agents.sabha_orchestrator._invoke_with_fallback",
        fake_invoke,
    )

    class _Ledger:
        def to_context(self): return ""
        open_questions = []
        divergence = "what-if"

    msg, invitee = await generate_orchestrator_message(
        ledger=_Ledger(),
        current_phase="cross_examination",
        transcript=[],
        characters=CHARS,
        story_title="Animal Farm",
        event_type="phase_transition",
        context={"from_phase": "opening", "to_phase": "cross_examination"},
    )
    assert invitee is None
