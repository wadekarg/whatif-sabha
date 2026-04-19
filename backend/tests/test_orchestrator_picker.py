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


def test_silent_character_beats_targeted_character_in_long_debate():
    """At turn 20+, a never-spoken character should score higher than a @-targeted one."""
    from app.core.agents.orchestrator import _score_candidates

    chars = [
        {"name": "Napoleon", "role": "antagonist",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
        {"name": "Squealer", "role": "supporting",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
        {"name": "Boxer", "role": "supporting",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
        {"name": "Bluebell", "role": "supporting",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
    ]
    # 20 turns: Napoleon/Squealer dominate, Bluebell never speaks, Boxer spoke
    # recently (so his silence reward is small) and is now being @-targeted.
    # The test asserts Bluebell (pure silence +8) beats Boxer (small silence + target +6).
    history = []
    for i in range(18):
        history.append({
            "character": "Napoleon" if i % 2 == 0 else "Squealer",
            "message": f"Turn {i}.",
            "round": i, "phase": "opening",
        })
    history.append({"character": "Boxer", "message": "I am here.", "round": 18, "phase": "opening"})
    history.append({
        "character": "Napoleon", "message": "Boxer is the obvious choice.",
        "round": 19, "phase": "opening", "target_characters": ["Boxer"],
    })
    last_entry = history[-1]
    last_speaker = last_entry["character"]

    scores = _score_candidates(
        history, ["Napoleon", "Squealer", "Boxer", "Bluebell"],
        chars, last_speaker, last_entry["message"], last_entry,
    )

    # Bluebell (never spoke, 20 turns elapsed) should beat Boxer (targeted)
    assert scores["Bluebell"] > scores["Boxer"], (
        f"Bluebell={scores['Bluebell']}, Boxer={scores['Boxer']} — silent should dominate"
    )


def test_silent_character_reward_capped_at_12():
    """The silence reward maxes out at +12 even in very long debates."""
    from app.core.agents.orchestrator import _score_candidates

    chars = [
        {"name": "Napoleon", "role": "antagonist",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
        {"name": "Bluebell", "role": "supporting",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
    ]
    # 100 turns of Napoleon
    history = [
        {"character": "Napoleon", "message": f"Turn {i}", "round": i, "phase": "opening"}
        for i in range(100)
    ]
    scores = _score_candidates(
        history, ["Napoleon", "Bluebell"], chars,
        "Napoleon", history[-1]["message"], history[-1],
    )
    # Bluebell's score = silence reward (capped at 12) minus any recency penalty (0 here).
    # Relevance reward is also capped at 0.5. So max achievable ~12.5.
    assert 10 <= scores["Bluebell"] <= 13


def test_silent_reward_scales_linearly_for_short_debates():
    """At turn 4, silence reward is 3 + 4*0.25 = 4.0."""
    from app.core.agents.orchestrator import _score_candidates

    chars = [
        {"name": "Napoleon", "role": "antagonist",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
        {"name": "Bluebell", "role": "supporting",
         "phases": [{"personality_traits": [], "motivations": [], "fears": []}]},
    ]
    history = [
        {"character": "Napoleon", "message": f"Turn {i}", "round": i, "phase": "opening"}
        for i in range(4)
    ]
    scores = _score_candidates(
        history, ["Napoleon", "Bluebell"], chars,
        "Napoleon", history[-1]["message"], history[-1],
    )
    # At turn 4, silent reward = 3 + 4*0.25 = 4.0
    assert abs(scores["Bluebell"] - 4.0) < 0.5
