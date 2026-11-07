"""#15: the committed jury snapshot restores the DEV results and carries no secret."""
import json
from pathlib import Path

import pytest

SNAPSHOT = Path(__file__).resolve().parents[3] / "data" / "snapshot" / "cqa-snapshot.json"
needs = pytest.mark.skipif(not SNAPSHOT.is_file(), reason="no committed snapshot")


@needs
def test_committed_snapshot_has_every_dev_result_and_no_signed_url():
    text = SNAPSHOT.read_text(encoding="utf-8")
    assert "sig=" not in text and '"audio_url"' not in text
    doc = json.loads(text)
    assert len(doc["conversations"]) == 65 and len(doc["evaluations"]) == 65 and len(doc["judgments"]) == 520
    statuses = {json.loads(e["json"])["status"] if isinstance(e.get("json"), str) else e.get("status")
                for e in doc["evaluations"]}
    assert statuses == {"done"}


@needs
def test_committed_snapshot_restores_into_an_empty_database():
    from app.checklists import seed_into_db
    from app.db import migrate
    from app import store
    from app.snapshot import import_snapshot

    migrate()
    seed_into_db()
    assert import_snapshot(SNAPSHOT) > 0
    assert len(store.list_conversations(group_id="DEV")) == 65
    assert len(store.list_evaluations("official-chat", 1, group_id="DEV")) == 65
