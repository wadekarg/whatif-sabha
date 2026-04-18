import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from export_debate import build_replay_json


def _fake_db(tmp_path: Path) -> Path:
    db = tmp_path / "w.db"
    conn = sqlite3.connect(db)
    conn.executescript("""
      CREATE TABLE stories (
        id TEXT PRIMARY KEY, title TEXT, author TEXT, summary TEXT,
        themes TEXT, pdf_path TEXT, full_text TEXT, word_count INTEGER,
        analysis TEXT, status TEXT, error_message TEXT,
        created_at TEXT, updated_at TEXT, progress_log TEXT
      );
      CREATE TABLE debates (
        id TEXT PRIMARY KEY, story_id TEXT, divergence_description TEXT,
        divergence_timeline_position TEXT, participating_characters TEXT,
        transcript TEXT, alternate_ending TEXT, status TEXT,
        round_count INTEGER, created_at TEXT, completed_at TEXT,
        alternate_timeline TEXT, alternate_world_state TEXT,
        character_exploration TEXT, ledger_snapshot TEXT
      );
    """)
    analysis = json.dumps({
        "characters": [
            {"name": "Napoleon", "role": "antagonist", "description": "A pig."},
            {"name": "Snowball",  "role": "protagonist", "description": "Another pig."},
        ]
    })
    transcript = json.dumps([
        {"character": "Boru", "message": "Welcome.", "round": 0,
         "phase": "opening", "isOrchestrator": True,
         "orchestratorEvent": "opening_with_invite"},
        {"character": "Napoleon", "message": "I disagree.", "round": 0,
         "phase": "opening", "target_character": "Boru", "emotion": "contempt"},
    ])
    conn.execute("INSERT INTO stories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("s1","Animal Farm","Orwell","Summary","themes","","",100,
                  analysis,"done",None,"2026-01-01","2026-01-02","[]"))
    conn.execute("INSERT INTO debates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                 ("d1","s1","What if Snowball returned?","end",
                  json.dumps(["Napoleon","Snowball"]), transcript,
                  "The pigs fall.", "completed", 1,
                  "2026-01-01","2026-01-02","[]","{}","{}","{}"))
    conn.commit()
    conn.close()
    return db


def test_build_replay_json_shape(tmp_path):
    db = _fake_db(tmp_path)
    data = build_replay_json(db_path=db, debate_id="d1")

    assert data["version"] == "1"
    assert data["debate_id"] == "d1"
    assert data["story"]["title"] == "Animal Farm"
    assert data["story"]["divergence"] == "What if Snowball returned?"
    # Napoleon + Snowball (from analysis, filtered by participants) + Boru
    # (auto-inserted because he appears in the transcript as orchestrator)
    names = [c["name"] for c in data["characters"]]
    assert set(names) == {"Boru", "Napoleon", "Snowball"}
    assert names[0] == "Boru"  # orchestrator is inserted at index 0
    assert len(data["transcript"]) == 2
    assert data["transcript"][0]["isOrchestrator"] is True
    assert data["transcript"][1]["emotion"] == "contempt"
    assert data["alternate_ending"] == "The pigs fall."
    assert "disclaimer" in data
    assert "AI-generated" in data["disclaimer"]


def test_missing_debate_raises(tmp_path):
    db = _fake_db(tmp_path)
    import pytest
    with pytest.raises(ValueError, match="not found"):
        build_replay_json(db_path=db, debate_id="nope")
