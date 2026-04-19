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
