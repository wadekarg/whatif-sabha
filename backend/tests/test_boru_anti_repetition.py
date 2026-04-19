"""Tests for Boru anti-repetition opener extraction."""
from app.core.agents.sabha_orchestrator import _extract_recent_boru_openers


def test_empty_transcript_returns_empty_list():
    assert _extract_recent_boru_openers([]) == []


def test_no_orchestrator_turns_returns_empty():
    tx = [{"character": "Napoleon", "message": "I am the leader.", "isOrchestrator": False}]
    assert _extract_recent_boru_openers(tx) == []


def test_extracts_first_6_words():
    tx = [{
        "character": "Boru",
        "message": "Napoleon and Mr. Jones, settle this once and for all right now please.",
        "isOrchestrator": True,
    }]
    result = _extract_recent_boru_openers(tx)
    assert len(result) == 1
    assert result[0] == "Napoleon and Mr. Jones, settle this"


def test_limits_to_recent_N():
    tx = [
        {"character": "Boru", "message": f"Boru turn number {i} with some words", "isOrchestrator": True}
        for i in range(10)
    ]
    result = _extract_recent_boru_openers(tx, limit=3)
    assert len(result) == 3


def test_most_recent_first():
    tx = [
        {"character": "Boru", "message": "First message here alpha beta", "isOrchestrator": True},
        {"character": "Boru", "message": "Second message here gamma delta", "isOrchestrator": True},
        {"character": "Boru", "message": "Third message here epsilon zeta", "isOrchestrator": True},
    ]
    result = _extract_recent_boru_openers(tx, limit=3)
    assert result[0].startswith("Third message")
    assert result[1].startswith("Second message")
    assert result[2].startswith("First message")


def test_skips_short_messages():
    tx = [
        {"character": "Boru", "message": "ok", "isOrchestrator": True},
        {"character": "Boru", "message": "Napoleon and Mr. Jones debated intensely", "isOrchestrator": True},
    ]
    result = _extract_recent_boru_openers(tx)
    assert len(result) == 1
    assert "Napoleon" in result[0]


def test_skips_non_orchestrator_turns():
    tx = [
        {"character": "Boru", "message": "Boru speaks here at length please", "isOrchestrator": True},
        {"character": "Napoleon", "message": "Napoleon speaks here at length please", "isOrchestrator": False},
        {"character": "Boru", "message": "Second Boru opener here with words", "isOrchestrator": True},
    ]
    result = _extract_recent_boru_openers(tx)
    assert len(result) == 2
    # Verify neither matches Napoleon's content
    assert all("Napoleon speaks" not in o for o in result)
