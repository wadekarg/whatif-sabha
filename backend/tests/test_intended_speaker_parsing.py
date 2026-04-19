"""Tests for parsing the intended speaker from an orchestrator message."""
from app.core.agents.sabha_orchestrator import (
    extract_first_cast_name,
    intended_speaker_from_result,
)


CAST = ["Napoleon", "Squealer", "Boxer", "Old Major", "Mr. Jones", "Mrs. Jones",
        "Snowball", "The Cat"]


# ── extract_first_cast_name ──────────────────────────────────────────

def test_extract_single_name():
    assert extract_first_cast_name("Napoleon, answer this.", CAST) == "Napoleon"


def test_vocative_wins_over_possessive_or_mention():
    """Vocative address (name followed by comma) beats plain/possessive mention.

    Under the new weighted scorer: "Squealer," is a vocative (+10) while
    "Napoleon and" is just a plain mention (+1). Squealer wins.
    """
    assert extract_first_cast_name(
        "Napoleon and Squealer, settle this now.", CAST
    ) == "Squealer"


def test_extract_multi_word_name():
    assert extract_first_cast_name("I'd like Old Major to speak.", CAST) == "Old Major"


def test_extract_multi_word_name_prefers_longer_match():
    """Old Major should match as a whole, not 'Old' + something else.
    The key test: the message contains 'Old Major' — we must not match just 'Old'."""
    assert extract_first_cast_name(
        "I'd like Old Major to speak about this.",
        ["Old", "Old Major"],   # both in cast
    ) == "Old Major"


def test_extract_case_insensitive():
    assert extract_first_cast_name("snowball, respond.", CAST) == "Snowball"


def test_extract_word_boundary_only():
    """Don't match 'cat' inside 'catalog' or 'napoleon' inside 'napoleonic'."""
    assert extract_first_cast_name(
        "The catalog shows napoleonic tendencies.",
        ["Cat", "Napoleon"],
    ) is None


def test_extract_no_match_returns_none():
    assert extract_first_cast_name("A broad welcome to all assembled.", CAST) is None


def test_extract_handles_punctuation():
    assert extract_first_cast_name("Napoleon! Speak now.", CAST) == "Napoleon"
    assert extract_first_cast_name("Why is it, Boxer, that you stay silent?", CAST) == "Boxer"


def test_extract_mr_jones_not_matched_as_jones_inside_larger_word():
    assert extract_first_cast_name(
        "Mr. Jones, speak.", ["Jones", "Mr. Jones"],
    ) == "Mr. Jones"


def test_extract_empty_cast_returns_none():
    assert extract_first_cast_name("Napoleon, answer.", []) is None


def test_extract_empty_message_returns_none():
    assert extract_first_cast_name("", CAST) is None


def test_vocative_beats_possessive():
    """'Napoleon's X is weak, Snowball, tell me your view' → Snowball (vocative)."""
    cast = ["Napoleon", "Snowball"]
    assert extract_first_cast_name(
        "Napoleon's claim is weak, Snowball, tell me your view.",
        cast,
    ) == "Snowball"


def test_prepositional_target_beats_possessive():
    """'Napoleon's plan raises a question for Mrs. Jones' → Mrs. Jones."""
    cast = ["Napoleon", "Mrs. Jones"]
    assert extract_first_cast_name(
        "Napoleon's plan raises a question for Mrs. Jones.",
        cast,
    ) == "Mrs. Jones"


def test_vocative_at_start_wins():
    """'Mrs. Jones, as one who has seen...' → Mrs. Jones (vocative + start position)."""
    cast = ["Napoleon", "Mrs. Jones"]
    assert extract_first_cast_name(
        "Mrs. Jones, as one who has seen the farm, what do you make of Napoleon's plan?",
        cast,
    ) == "Mrs. Jones"


def test_multiple_vocatives_first_wins():
    """Two vocatives — earliest position wins among equal-score candidates."""
    cast = ["Napoleon", "Snowball"]
    assert extract_first_cast_name(
        "Napoleon, and also Snowball, what do you say?",
        cast,
    ) == "Napoleon"


def test_prepositional_after_said():
    """'Hunger reveals loyalty, Napoleon said; Mrs. Jones, does that mean...' → Mrs. Jones.

    'Napoleon said' is not a vocative; 'Mrs. Jones,' is. Mrs. Jones wins."""
    cast = ["Napoleon", "Mrs. Jones"]
    assert extract_first_cast_name(
        "Hunger reveals loyalty, Napoleon said; Mrs. Jones, does that mean...",
        cast,
    ) == "Mrs. Jones"


def test_pure_possessive_still_picks_that_name_if_alone():
    """When the message only mentions someone possessively, that's still the best match."""
    cast = ["Napoleon", "Snowball"]
    assert extract_first_cast_name(
        "Napoleon's claim about hunger is interesting.",
        cast,
    ) == "Napoleon"


def test_plain_mention_no_punctuation():
    """'I'll let Napoleon speak next' — no vocative, but 'let Napoleon' suggests prepositional — Napoleon."""
    cast = ["Napoleon"]
    assert extract_first_cast_name(
        "I'll let Napoleon speak next.",
        cast,
    ) == "Napoleon"


# ── intended_speaker_from_result ──────────────────────────────────────

def test_broadcast_events_always_return_none():
    """Even if message names a character, broadcast events don't enforce."""
    for ev in ["opening_with_invite", "phase_transition", "phase_intro",
               "observer_intro", "summon_observer", "closing_summary"]:
        assert intended_speaker_from_result(
            event_type=ev,
            context={},
            message="Napoleon, speak now.",
            cast_names=CAST,
        ) is None, f"{ev} should return None"


def test_context_target_wins_over_message_parse():
    """When context has an explicit target, use it — don't re-parse."""
    result = intended_speaker_from_result(
        event_type="forced_question",
        context={"target": "Boxer", "question": "why?"},
        message="Napoleon is the key here, Boxer must answer.",
        cast_names=CAST,
    )
    assert result == "Boxer"


def test_falls_back_to_message_parse_when_context_has_no_target():
    """respond_to_character has no target in context — parse the message."""
    result = intended_speaker_from_result(
        event_type="respond_to_character",
        context={"speaker": "Napoleon", "question": "who rules?"},
        message="That's a clever question. I'd like to ask Snowball to answer it.",
        cast_names=CAST,
    )
    assert result == "Snowball"


def test_dispute_callout_parses_vocative_disputant():
    """dispute_callout has no explicit target in intended_speaker_for, so it
    falls back to the weighted message parser. Under the new rules, the
    vocative (name immediately before the comma) wins: in
    "Napoleon and Mr. Jones, settle this now." — "Mr. Jones," is the
    vocative (+10) while "Napoleon and" is a plain mention (+1).
    """
    result = intended_speaker_from_result(
        event_type="dispute_callout",
        context={"char_a": "Napoleon", "char_b": "Mr. Jones"},
        message="Napoleon and Mr. Jones, settle this now.",
        cast_names=CAST,
    )
    assert result == "Mr. Jones"


def test_context_target_not_in_cast_falls_through_to_message():
    """If context says 'Snowball' but Snowball isn't in cast, try message."""
    result = intended_speaker_from_result(
        event_type="forced_question",
        context={"target": "Ghost"},   # not in cast
        message="Boxer, answer this instead.",
        cast_names=CAST,
    )
    assert result == "Boxer"


def test_no_match_anywhere_returns_none():
    result = intended_speaker_from_result(
        event_type="respond_to_character",
        context={"speaker": "Napoleon"},
        message="A broad philosophical reflection on power.",
        cast_names=CAST,
    )
    assert result is None
