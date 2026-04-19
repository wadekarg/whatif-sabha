"""Tests for dispute retirement and dedup."""
from app.core.agents.sabha_orchestrator import ArgumentLedger


def test_find_existing_dispute_matches_pair_order_independent():
    ledger = ArgumentLedger("div", ["A", "B", "C"])
    ledger.disputes.append({
        "id": 1, "status": "unresolved", "turns_unresolved": 3,
        "claim_a": {"character": "A", "claim": "x"},
        "claim_b": {"character": "B", "claim": "y"},
    })
    # A-B and B-A both match
    assert ledger._find_existing_dispute("A", "B") is not None
    assert ledger._find_existing_dispute("B", "A") is not None
    # Different pair doesn't match
    assert ledger._find_existing_dispute("A", "C") is None


def test_find_existing_dispute_skips_resolved():
    ledger = ArgumentLedger("div", ["A", "B"])
    ledger.disputes.append({
        "id": 1, "status": "resolved_by_escalation", "turns_unresolved": 7,
        "claim_a": {"character": "A", "claim": "x"},
        "claim_b": {"character": "B", "claim": "y"},
    })
    assert ledger._find_existing_dispute("A", "B") is None


def test_find_existing_dispute_empty_ledger():
    ledger = ArgumentLedger("div", ["A", "B"])
    assert ledger._find_existing_dispute("A", "B") is None


def test_retire_stale_disputes():
    from app.core.agents.sabha_orchestrator import ArgumentLedger
    ledger = ArgumentLedger("div", ["A", "B"])
    ledger.disputes.append({
        "id": 1, "status": "unresolved",
        "turns_unresolved": 6,
        "_last_escalation_turn": 5,
        "claim_a": {"character": "A", "claim": "x"},
        "claim_b": {"character": "B", "claim": "y"},
    })
    # At round 15, last touched was round 5 → 10 turns stale
    retired = ledger.retire_stale_disputes(current_round=15, stale_threshold=10)
    assert retired == 1
    assert ledger.disputes[0]["status"] == "resolved_stale"


def test_retire_stale_disputes_skips_fresh():
    from app.core.agents.sabha_orchestrator import ArgumentLedger
    ledger = ArgumentLedger("div", ["A", "B"])
    ledger.disputes.append({
        "id": 1, "status": "unresolved",
        "turns_unresolved": 3,
        "_last_escalation_turn": 10,
        "claim_a": {"character": "A", "claim": "x"},
        "claim_b": {"character": "B", "claim": "y"},
    })
    # At round 15, last touched was round 10 → only 5 turns stale (under threshold)
    retired = ledger.retire_stale_disputes(current_round=15, stale_threshold=10)
    assert retired == 0
    assert ledger.disputes[0]["status"] == "unresolved"


def test_retire_stale_disputes_skips_young():
    """A dispute with low turns_unresolved shouldn't be retired even if stale —
    it may have just been created and hasn't had a chance to be surfaced."""
    from app.core.agents.sabha_orchestrator import ArgumentLedger
    ledger = ArgumentLedger("div", ["A", "B"])
    ledger.disputes.append({
        "id": 1, "status": "unresolved",
        "turns_unresolved": 2,   # young
        "_last_escalation_turn": 0,
        "claim_a": {"character": "A", "claim": "x"},
        "claim_b": {"character": "B", "claim": "y"},
    })
    retired = ledger.retire_stale_disputes(current_round=15, stale_threshold=10)
    assert retired == 0
