"""Tests for the forced-speaker path in the orchestrator picker."""
from app.core.agents.orchestrator import pick_next_speaker_with_scores


CHARS = [
    {"name": "Napoleon", "role": "antagonist",
     "phases": [{"personality_traits": ["commanding"], "motivations": [], "fears": []}]},
    {"name": "Squealer", "role": "supporting",
     "phases": [{"personality_traits": ["manipulative"], "motivations": [], "fears": []}]},
    {"name": "Boxer",    "role": "supporting",
     "phases": [{"personality_traits": ["loyal"], "motivations": [], "fears": []}]},
]


def test_intended_speaker_wins_over_all_scoring():
    """If Boru's last turn names Boxer via intended_speaker, Boxer is forced."""
    transcript = [
        {"character": "Napoleon", "message": "I dominated that.", "round": 0, "phase": "opening"},
        {"character": "Squealer", "message": "Yes, comrade.",     "round": 0, "phase": "opening"},
        {"character": "Boru",     "message": "A question for the room.", "round": 1,
         "phase": "opening", "isOrchestrator": True, "intended_speaker": "Boxer"},
    ]
    name, forced, scores = pick_next_speaker_with_scores(
        transcript, CHARS, current_phase="opening", round_number=1,
    )
    assert name == "Boxer"
    assert forced is True


def test_no_forced_when_orchestrator_has_no_intended_speaker():
    """Orchestrator turns without intended_speaker fall back to normal scoring."""
    transcript = [
        {"character": "Napoleon", "message": "I dominated that.", "round": 0, "phase": "opening"},
        {"character": "Squealer", "message": "Yes, comrade.",     "round": 0, "phase": "opening"},
        {"character": "Boru",     "message": "A broad observation.", "round": 1,
         "phase": "opening", "isOrchestrator": True, "intended_speaker": None},
    ]
    name, forced, scores = pick_next_speaker_with_scores(
        transcript, CHARS, current_phase="opening", round_number=1,
    )
    assert forced is False
    # Fallback scoring picks someone who isn't Squealer (she's last speaker)
    assert name != "Squealer"


def test_legacy_transcript_without_intended_speaker_field_still_works():
    """Old debates have orchestrator entries without the new field. No crashes."""
    transcript = [
        {"character": "Napoleon", "message": "Hello", "round": 0, "phase": "opening"},
        {"character": "Boru",     "message": "Phase transition...", "round": 1,
         "phase": "opening", "isOrchestrator": True},  # no intended_speaker key
    ]
    name, forced, scores = pick_next_speaker_with_scores(
        transcript, CHARS, current_phase="opening", round_number=1,
    )
    assert forced is False
    assert name in [c["name"] for c in CHARS]


def test_forced_speaker_returned_even_if_would_be_last_speaker():
    """If Boru calls the same character who just spoke, forced still wins."""
    transcript = [
        {"character": "Napoleon", "message": "I spoke.", "round": 0, "phase": "opening"},
        {"character": "Boru",     "message": "Napoleon, one more thing.", "round": 1,
         "phase": "opening", "isOrchestrator": True, "intended_speaker": "Napoleon"},
    ]
    name, forced, scores = pick_next_speaker_with_scores(
        transcript, CHARS, current_phase="opening", round_number=1,
    )
    assert name == "Napoleon"
    assert forced is True


def test_empty_transcript_no_forced():
    """Empty transcript — no forced speaker."""
    name, forced, scores = pick_next_speaker_with_scores(
        [], CHARS, current_phase="opening", round_number=0,
    )
    assert forced is False
