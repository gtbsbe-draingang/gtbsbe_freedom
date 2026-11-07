"""#25: the team interpretations are official-chat v2; v1 stays exactly as published."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
V1 = ROOT / "checklists" / "official-chat-v1.json"
V2 = ROOT / "checklists" / "official-chat-v2.json"
TEAM = {"c01", "c03", "c06", "c07"}


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_v1_has_no_team_guidance():
    assert all(c["guidance"] is None for c in read(V1)["criteria"])


def test_v2_is_v1_plus_team_guidance_only():
    v1, v2 = read(V1), read(V2)
    assert (v1["version"], v2["version"]) == (1, 2) and v2["locked"] is True
    for a, b in zip(v1["criteria"], v2["criteria"]):
        if a["id"] in TEAM:
            assert b["guidance"].startswith("Уточнение команды: ")
        else:
            assert b["guidance"] is None
        assert {**b, "guidance": None} == a
    assert {k: v for k, v in v2.items() if k not in ("version", "criteria")} ==         {k: v for k, v in v1.items() if k not in ("version", "criteria")}


def test_references_follow_v2():
    labels = read(ROOT / "data" / "reference" / "dev_labels.json")
    assert (labels["checklist_id"], labels["version"]) == ("official-chat", 2)


def test_upgrade_keeps_stored_v1_and_adds_v2():
    """A database seeded before #25 keeps v1 as it was; startup adds v2 next to it."""
    from app import checklists, db, store

    db.migrate()
    old = checklists.load_checklist_file(V1)
    store.save_checklist_version(old)
    checklists.seed_into_db()
    checklists.seed_into_db()  # repeat startup is safe
    v1 = store.get_checklist_version("official-chat", 1)
    v2 = store.get_checklist_version("official-chat", 2)
    assert [c.fingerprint for c in v1.criteria] == [c.fingerprint for c in old.criteria]
    assert all(c.guidance is None for c in v1.criteria)
    assert v2 is not None and {c.id for c in v2.criteria if c.guidance} == TEAM
    for a, b in zip(v1.criteria, v2.criteria):
        # changed criteria get new fingerprints (no reuse of v1 judgments); the rest can be reused
        assert (a.fingerprint != b.fingerprint) == (a.id in TEAM)
