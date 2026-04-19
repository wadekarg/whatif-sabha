"""Pure re-entry trigger and intent selection — no side effects, no I/O.

Used by the debate turn loop to decide when Boru should intervene during
a DIALOGUE_WINDOW and what he should do when he does.
"""
from __future__ import annotations


# Re-entry trigger thresholds (tuned in the design spec)
MIN_INVITEE_TURNS_BEFORE_DISPUTE = 2    # tier-3 can't fire until invitee had follow-up
HARD_CEILING_TURNS = 8                   # no matter what, Boru speaks by this turn
DEFAULT_CAP_TURNS = 6                    # intervene at this many turns if drama cools
DRAMA_COOLED_THRESHOLD = 0.6             # below this, window doesn't extend
STALL_DRAMA_THRESHOLD = 0.3              # below this, stall
STALL_MAX_SCORE_THRESHOLD = 1.0          # below this, stall


def should_boru_reenter(
    window_turn_count: int,
    drama_score: float,
    tier3_dispute: bool,
    phase_change_due: bool,
    scores: dict,
) -> tuple[bool, str]:
    """Decide whether Boru should re-enter the debate.

    Returns (True/False, reason). Triggers are priority-ordered:
      1. tier3_dispute   — but only after invitee's first follow-up
      2. hard_ceiling    — 8 turns unconditionally
      3. default_cap_low_drama — 6 turns with drama below 0.6
      4. stall           — drama collapses or no one wants the floor
      5. phase_transition — lowest priority, only when quiet
    """
    if tier3_dispute and window_turn_count >= MIN_INVITEE_TURNS_BEFORE_DISPUTE:
        return True, "tier3_dispute"

    if window_turn_count >= HARD_CEILING_TURNS:
        return True, "hard_ceiling"

    if window_turn_count >= DEFAULT_CAP_TURNS and drama_score < DRAMA_COOLED_THRESHOLD:
        return True, "default_cap_low_drama"

    max_score = max(scores.values()) if scores else 0.0
    if drama_score < STALL_DRAMA_THRESHOLD or max_score < STALL_MAX_SCORE_THRESHOLD:
        return True, "stall"

    if phase_change_due:
        return True, "phase_transition"

    return False, ""


def select_boru_intent(
    reason: str,
    tier3_dispute: dict | None,
    phase_change: dict | None,
    open_questions: list[dict],
    speaker_diversity: dict[str, int],
) -> tuple[str, dict]:
    """Pick the event_type and context for Boru's next orchestrator message.

    Priority (first match wins):
      force_confrontation  when a tier-3 dispute is pending
      phase_transition     when a phase boundary is due
      forced_question      when there's a specific open question to force
      invite_speaker       default — rotate a fresh voice in

    Returns (event_type, context_dict) — shaped for generate_orchestrator_message.
    """
    if reason == "pair_duel":
        # Rotate in a silent voice — the same two characters need a break
        target = _pick_most_silent(speaker_diversity)
        return "invite_speaker", {
            "speaker": target,
            "directive": "two speakers have been locked in exchange — bring a fresh voice on the issue they've been circling",
        }

    if reason == "tier3_dispute" and tier3_dispute:
        return "force_confrontation", {
            "char_a": tier3_dispute["claim_a"]["character"],
            "char_b": tier3_dispute["claim_b"]["character"],
            "claim_a": tier3_dispute["claim_a"]["claim"],
            "claim_b": tier3_dispute["claim_b"]["claim"],
            "turns": tier3_dispute.get("turns_unresolved", 0),
        }

    if reason == "phase_transition" and phase_change:
        return "phase_transition", {
            "from_phase": phase_change["from_phase"],
            "to_phase": phase_change["to_phase"],
        }

    if open_questions:
        q = open_questions[0]
        targets = q.get("directed_to") or []
        target = targets[0] if targets else _pick_most_silent(speaker_diversity)
        return "forced_question", {
            "target": target,
            "question": q["question"],
        }

    # Default: rotate a fresh voice
    target = _pick_most_silent(speaker_diversity)
    return "invite_speaker", {
        "speaker": target,
        "directive": "bring in a fresh voice on what's been debated",
    }


def _pick_most_silent(speaker_diversity: dict[str, int]) -> str:
    """Return the character with the fewest turns taken so far."""
    if not speaker_diversity:
        return ""
    return min(speaker_diversity.items(), key=lambda kv: kv[1])[0]
