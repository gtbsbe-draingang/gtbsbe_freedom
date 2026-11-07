"""The results snapshot and keyless mode (Task 13, issue #15).

Stream C's evaluator is replaced by tests.app.fakes.FakeEvaluator (no network, no Claude API). The
fake answers with the T2 pattern (total 84.17 on the official checklist). Every signed URL in
these tests is fake (`sig=FAKE`).

`source` is a database with the six DEV dialogues (the voice call has a signed audio link), the
official checklist and one weight-only copy of it, both applied to every dialogue. `fresh` starts
the app on a second, empty database, which is what a jury machine has.
"""

import json
import re
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import jobs, store
from app.db import connect, migrate
from app.models import Appeal, ChecklistVersion, Evaluation, StepAnswer
from app.settings import get_settings
from app.snapshot import (
    NOT_EXPORTED,
    SNAPSHOT,
    TABLES,
    SnapshotError,
    assert_no_signed_urls,
    export_snapshot,
    import_snapshot,
    row_count,
)
from app.transcript import normalize_record
from tests.app.fakes import OFFICIAL, FakeEvaluator, dev_records, ensure_official, load_dev_subset
from tests.app.helpers import criterion, decide, file, save_copy

MakeClient = Callable[..., TestClient]
KEY = {"ANTHROPIC_API_KEY": "test-key"}
CHAT = "DEV:p1-ru-001"
VOICE = "DEV:p4-ru-001"
AUDIO_URL = "https://audio.example.invalid/p4-ru-001.mp3?sig=FAKE"
T2 = {
    "c01": "yes",
    "c02": "na",
    "c03": "na",
    "c04": StepAnswer(step=15),
    "c05": "yes",
    "c06": StepAnswer(step=7),
    "c07": "na",
    "c08": "no",
}


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "RETRY_DELAY_SECONDS", 0)


@pytest.fixture
def fake() -> Iterator[FakeEvaluator]:
    evaluator = FakeEvaluator()
    evaluator.answers = dict(T2)
    jobs.set_evaluator(evaluator)
    yield evaluator
    jobs.reset_evaluator()


# --- helpers -------------------------------------------------------------------------------


def run(client: TestClient, version: ChecklistVersion, conversations: list[str], **extra) -> dict:
    """Start a job and wait for it; returns the finished job."""
    body = {
        "conversations": conversations,
        "checklist_id": version.checklist_id,
        "version": version.version,
        "role": "controller",
        **extra,
    }
    r = client.post("/api/evaluations", json=body)
    assert r.status_code == 201, r.text
    client.portal.call(jobs.wait_for_job, r.json()["id"])
    return client.get(f"/api/jobs/{r.json()['id']}").json()


def dry_run(client: TestClient, version: ChecklistVersion, conversations: list[str]) -> dict:
    body = {
        "conversations": conversations,
        "checklist_id": version.checklist_id,
        "version": version.version,
        "dry_run": True,
    }
    r = client.post("/api/evaluations", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def heavier_c01(copied: dict) -> None:
    criterion(copied, "c01")["weight"] = 20


class Source:
    def __init__(self, client: TestClient, official: ChecklistVersion, copy: ChecklistVersion, ids: list[str]):
        self.client = client
        self.official = official
        self.copy = copy
        self.ids = ids


@pytest.fixture
def source(make_client: MakeClient, fake: FakeEvaluator) -> Source:
    client = make_client(**KEY)
    ids = load_dev_subset()
    record = next(r for r in dev_records() if r["conversation_id"] == "p4-ru-001")
    voice, url = normalize_record({**record, "audio_url": AUDIO_URL}, "DEV")
    store.upsert_conversation(voice, url)
    official = ensure_official()
    assert run(client, official, ids)["status"] == "done"
    copy = save_copy(client, official, heavier_c01)
    assert run(client, copy, ids)["status"] == "done"  # weights only: every judgment is reused
    assert fake.calls == 48
    return Source(client, official, copy, ids)


@pytest.fixture
def fresh(make_client: MakeClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Callable[..., TestClient]:
    """Start the app on a new, empty database (migrated and seeded, like a first start), with or
    without a model key."""
    made = []

    def factory(*, key: bool = False) -> TestClient:
        if key:
            monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        else:
            monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        made.append(1)
        client = make_client(DB_PATH=str(tmp_path / f"fresh-{len(made)}.db"))
        assert store.list_conversations() == []
        return client

    return factory


def totals(version: tuple[str, int]) -> dict[str, tuple]:
    return {
        ev.conversation: (ev.original_total, ev.final_total)
        for ev in store.list_evaluations(*version)
    }


def rows(sql: str, *args) -> list[tuple]:
    conn = connect()
    try:
        return [tuple(row) for row in conn.execute(sql, args).fetchall()]
    finally:
        conn.close()


def write_doc(path: Path, doc) -> Path:
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return path


def exported(source: Source, tmp_path: Path) -> tuple[Path, dict]:
    path = tmp_path / "snapshot.json"
    return path, export_snapshot(path)


# --- the brief's tests ---------------------------------------------------------------------


def test_snapshot_round_trip(source: Source, fresh, tmp_path: Path) -> None:
    path, document = exported(source, tmp_path)
    copy_key = (source.copy.checklist_id, 1)
    before_totals = (totals(OFFICIAL), totals(copy_key))
    before_queue = {q["id"]: q["final"] for q in source.client.get("/api/conversations").json()}
    assert len(before_queue) == 6 and all(final is not None for final in before_queue.values())

    client = fresh()
    count = import_snapshot(path)
    assert count == row_count(document) - 1  # the seeded official checklist is not inserted again

    assert (totals(OFFICIAL), totals(copy_key)) == before_totals
    assert len(totals(OFFICIAL)) == 6
    assert {q["id"]: q["final"] for q in client.get("/api/conversations").json()} == before_queue
    assert len(store.find_evaluations()) == 12

    voice = client.get(f"/api/conversations/{VOICE}").json()
    assert voice["audio"] is None
    assert voice["audio_unavailable_reason"] == "needs_import"
    chat = client.get(f"/api/conversations/{CHAT}").json()
    assert chat["audio"] is None
    assert chat["audio_unavailable_reason"] == "none"  # a chat never had audio
    assert store.get_audio_url(VOICE) is None


def test_snapshot_has_no_signed_urls(source: Source, tmp_path: Path) -> None:
    assert store.get_audio_url(VOICE) == AUDIO_URL  # the source does hold a signed link
    path, _ = exported(source, tmp_path)
    text = path.read_text(encoding="utf-8")
    assert "sig=" not in text.lower()
    assert "audio_url" not in text
    assert "FAKE" not in text


def test_export_refuses_signed_text(source: Source, tmp_path: Path) -> None:
    conv = store.get_conversation(CHAT)
    first = conv.transcript[0].model_copy(update={"text": "see https://files.example.invalid/a?sig=abc"})
    store.upsert_conversation(conv.model_copy(update={"transcript": [first, *conv.transcript[1:]]}), None)

    target = tmp_path / "out" / "snapshot.json"
    target.parent.mkdir()
    target.write_text("OLD", encoding="utf-8")
    with pytest.raises(ValueError):
        export_snapshot(target)
    assert target.read_text(encoding="utf-8") == "OLD"  # nothing was written
    assert [p.name for p in target.parent.iterdir()] == ["snapshot.json"]  # and no temp file is left

    fresh_target = tmp_path / "never.json"
    with pytest.raises(ValueError):
        export_snapshot(fresh_target)
    assert not fresh_target.exists()


def test_keyless_reapply_from_snapshot(source: Source, fresh, fake: FakeEvaluator, tmp_path: Path) -> None:
    path, _ = exported(source, tmp_path)
    client = fresh(key=False)
    import_snapshot(path)
    assert not get_settings().model_key_configured

    fake.calls = 0
    assert dry_run(client, source.official, source.ids) == {"total": 6, "model_calls": 0, "reused": 48}
    job = run(client, source.official, source.ids)  # reuse mode is the default
    assert job["status"] == "done"
    assert (job["total"], job["done"], job["failed"]) == (6, 6, 0)
    assert fake.calls == 0
    assert len(store.find_evaluations(checklist_id=source.official.checklist_id)) == 12  # 6 old + 6 new
    assert totals(OFFICIAL) == {c: (Decimal("84.17"), Decimal("84.17")) for c in source.ids}


def test_keyless_new_criterion_409(source: Source, fresh, fake: FakeEvaluator, tmp_path: Path) -> None:
    path, _ = exported(source, tmp_path)
    client = fresh(key=False)
    import_snapshot(path)

    def replace_c06(copied: dict) -> None:
        criterion(copied, "c06").update(id="c06b", title="Скорость", wording="Оцените скорость.")

    replaced = save_copy(client, source.official, replace_c06)
    fake.calls = 0
    body = {
        "conversations": source.ids,
        "checklist_id": replaced.checklist_id,
        "version": replaced.version,
        "role": "controller",
    }
    r = client.post("/api/evaluations", json=body)
    assert r.status_code == 409
    assert r.json()["error"] == "model_key_missing"
    assert fake.calls == 0
    assert store.list_jobs() == []
    # the estimate still answers, and says what is missing
    assert dry_run(client, replaced, source.ids) == {"total": 6, "model_calls": 6, "reused": 42}


def test_appeal_keyless_from_snapshot(source: Source, fresh, tmp_path: Path) -> None:
    path, _ = exported(source, tmp_path)
    client = fresh(key=False)
    import_snapshot(path)
    evaluation = next(ev for ev in store.list_evaluations(*OFFICIAL) if ev.conversation == CHAT)

    appeal = file(client, evaluation.id, "c04")
    assert appeal["status"] == "open"
    assert appeal["second_opinion_status"] == "unavailable"  # no key: no second opinion
    assert client.get(f"/api/conversations/{CHAT}").json()["status"] == "disputed"

    decided = decide(client, appeal["id"], answer={"step": 20})
    assert decided["original_total"] == 84.17
    assert decided["final_total"] == 92.5
    assert client.get(f"/api/conversations/{CHAT}").json()["status"] == "evaluated"


# --- the format ----------------------------------------------------------------------------


def test_export_format(source: Source, tmp_path: Path) -> None:
    path, document = exported(source, tmp_path)
    text = path.read_text(encoding="utf-8")
    assert text == json.dumps(document, sort_keys=True, ensure_ascii=False, indent=1) + "\n"
    assert json.loads(text) == document
    assert set(document) == {"format", "conversations", "checklists", "evaluations", "appeals", "judgments", "jobs"}
    assert document["format"] == 1
    assert document["jobs"] == []
    assert document["appeals"] == []
    assert (len(document["conversations"]), len(document["evaluations"])) == (6, 12)
    assert len(document["checklists"]) == rows("SELECT COUNT(*) FROM checklist_versions")[0][0]
    assert len(document["judgments"]) == 48
    assert re.search("[\u0400-\u04ff]", text) and "\\u04" not in text  # Cyrillic stays readable
    assert text.startswith('{\n "appeals"')  # sorted keys, indent of one space


def test_export_is_deterministic(source: Source, tmp_path: Path) -> None:
    first, _ = exported(source, tmp_path / "one")
    second, _ = exported(source, tmp_path / "two")
    assert first.read_bytes() == second.read_bytes()


def test_export_has_no_temp_files_and_creates_the_folder(source: Source, tmp_path: Path) -> None:
    target = tmp_path / "data" / "snapshot" / "cqa-snapshot.json"
    export_snapshot(target)
    assert [p.name for p in target.parent.iterdir()] == ["cqa-snapshot.json"]


def test_a_failed_write_keeps_the_old_file_and_leaves_no_temp_file(
    source: Source, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "out" / "snapshot.json"
    target.parent.mkdir()
    target.write_text("OLD", encoding="utf-8")

    def broken(src, dst):
        raise OSError("disk gone")

    with monkeypatch.context() as patched:
        patched.setattr("app.snapshot.os.replace", broken)
        with pytest.raises(OSError):
            export_snapshot(target)
    assert target.read_text(encoding="utf-8") == "OLD"
    assert [p.name for p in target.parent.iterdir()] == ["snapshot.json"]


def test_only_done_evaluations_are_exported(source: Source, fake: FakeEvaluator, tmp_path: Path) -> None:
    fake.fail_for = {CHAT}
    job = run(source.client, source.official, source.ids, mode="full")
    assert job["failed"] == 1
    stored = store.find_evaluations()
    assert any(ev.status == "failed" for ev in stored)

    _, document = exported(source, tmp_path)
    done = [ev for ev in stored if ev.status == "done"]
    assert len(document["evaluations"]) == len(done) < len(stored)
    assert {row["evaluation"]["status"] for row in document["evaluations"]} == {"done"}
    assert {row["status"] for row in document["evaluations"]} == {"done"}


def test_every_stored_column_is_exported_or_deliberately_left_out() -> None:
    migrate()
    conn = connect()
    try:
        for table in TABLES:
            stored = {row["name"] for row in conn.execute(f"PRAGMA table_info({table.table})")}
            exported_columns = {*table.columns, table.json_column, *NOT_EXPORTED.get(table.table, ())}
            assert stored == exported_columns, table.table
    finally:
        conn.close()
    assert NOT_EXPORTED == {"conversations": ("audio_url",)}


def test_the_snapshot_lives_in_the_repo() -> None:
    assert SNAPSHOT.parts[-3:] == ("data", "snapshot", "cqa-snapshot.json")
    assert (SNAPSHOT.parents[2] / "backend" / "app" / "snapshot.py").is_file()


@pytest.mark.parametrize("text", ["sig=abc", "SIG=abc", "?x=1&Sig=2", '{"audio_url": null}', "an audio_url here"])
def test_assert_no_signed_urls_refuses(text: str) -> None:
    with pytest.raises(ValueError) as caught:
        assert_no_signed_urls(text)
    assert text not in str(caught.value)  # the message never repeats the text


@pytest.mark.parametrize("text", ["", "design=1 and assign=2", "Здравствуйте, чем помочь?", "signature"])
def test_assert_no_signed_urls_accepts_clean_text(text: str) -> None:
    assert_no_signed_urls(text)


# --- import --------------------------------------------------------------------------------


def test_import_skips_checklist_versions_that_exist(source: Source, fresh, tmp_path: Path) -> None:
    path, document = exported(source, tmp_path)
    fresh()
    seeded = rows("SELECT * FROM checklist_versions ORDER BY rowid")
    seeded_ids = [v.checklist_id for v, _ in store.list_checklists()]
    assert source.official.checklist_id in seeded_ids

    import_snapshot(path)
    assert rows("SELECT * FROM checklist_versions ORDER BY rowid")[: len(seeded)] == seeded  # untouched
    assert [v.checklist_id for v, _ in store.list_checklists()] == [*seeded_ids, source.copy.checklist_id]
    assert len(document["checklists"]) == len(seeded) + 1  # the snapshot holds the official one too
    copy = store.get_checklist_version(source.copy.checklist_id, 1)
    assert copy is not None
    assert (copy.locked, copy.created_at, copy.criteria) == (
        source.copy.locked, source.copy.created_at, source.copy.criteria,
    )  # fmt: skip


def test_import_restores_every_row_as_it_was(source: Source, fresh, tmp_path: Path) -> None:
    selects = {
        "chats": "SELECT * FROM conversations WHERE channel = 'agent chat' ORDER BY id",
        "voice calls": (
            "SELECT id, group_id, conversation_id, channel, language, transcript_hash, created_at, updated_at "
            "FROM conversations WHERE channel = 'voice call' ORDER BY id"
        ),
        "evaluations": "SELECT * FROM evaluations ORDER BY id",
        "judgments": "SELECT * FROM judgments ORDER BY reuse_key",
    }
    path, _ = exported(source, tmp_path)
    before = {name: rows(sql) for name, sql in selects.items()}
    assert all(before.values())
    fresh()
    import_snapshot(path)
    assert {name: rows(sql) for name, sql in selects.items()} == before


def test_a_voice_call_gets_its_audio_back_with_the_organisers_link(source: Source, fresh, tmp_path: Path) -> None:
    path, _ = exported(source, tmp_path)
    fresh()
    import_snapshot(path)
    record = next(r for r in dev_records() if r["conversation_id"] == "p4-ru-001")
    voice, url = normalize_record({**record, "audio_url": AUDIO_URL}, "DEV")
    assert store.upsert_conversation(voice, url) == "unchanged"  # same transcript, the link is new
    restored = store.get_conversation(VOICE)
    assert restored is not None
    assert restored.audio == f"conversations/{VOICE}/audio"
    assert restored.audio_unavailable_reason is None
    assert store.get_audio_url(VOICE) == AUDIO_URL


def test_appeals_and_decisions_survive_and_carry_forward(source: Source, fresh, tmp_path: Path) -> None:
    evaluation = next(ev for ev in store.list_evaluations(*OFFICIAL) if ev.conversation == CHAT)
    decided = file(source.client, evaluation.id, "c04")
    decide(source.client, decided["id"], answer={"step": 20})
    still_open = file(source.client, evaluation.id, "c05")
    appeal_columns = "SELECT id, fingerprint, transcript_hash, status, created_at, decided_at FROM appeals ORDER BY id"
    original = [a.model_dump_json() for a in store.list_appeals()]
    columns = rows(appeal_columns)
    assert source.client.get(f"/api/conversations/{CHAT}").json()["status"] == "disputed"
    path, document = exported(source, tmp_path)
    assert len(document["appeals"]) == 2

    client = fresh(key=False)
    import_snapshot(path)
    assert [a.model_dump_json() for a in store.list_appeals()] == original
    assert rows(appeal_columns) == columns
    assert client.get(f"/api/conversations/{CHAT}").json()["status"] == "disputed"
    restored = store.get_evaluation(evaluation.id)
    assert restored is not None and restored.final_total == Decimal("92.5")

    # a later evaluation of the same transcript takes the decision over (it matches on the columns)
    job = run(client, source.official, [CHAT])
    assert job["status"] == "done"
    newest = client.get(f"/api/evaluations/{job['items'][0]['evaluation_id']}").json()
    c04 = next(r for r in newest["results"] if r["criterion_id"] == "c04")
    assert c04["final_answer"] == {"step": 20}
    assert c04["carried_decision"]["appeal_id"] == decided["id"]
    assert newest["final_total"] == 92.5

    # and the open appeal can still be decided
    decide(client, still_open["id"], outcome="confirmed")
    assert client.get(f"/api/appeals/{still_open['id']}").json()["status"] == "decided"


def test_jobs_are_not_part_of_the_snapshot(source: Source, fresh, tmp_path: Path) -> None:
    assert len(store.list_jobs()) == 2
    path, _ = exported(source, tmp_path)
    fresh()
    import_snapshot(path)
    assert store.list_jobs() == []


def _occupy_with_a_conversation() -> None:
    load_dev_subset()


def _occupy_with_an_evaluation() -> None:
    store.insert_evaluation(
        Evaluation(
            id="e1", created_at=datetime(2026, 11, 7, tzinfo=UTC), conversation="DEV:x",
            checklist_id="official-chat", version=1, status="queued",
        )  # fmt: skip
    )


def _occupy_with_an_appeal() -> None:
    appeal = Appeal(
        id="a1", created_at=datetime(2026, 11, 7, tzinfo=UTC), evaluation_id="e1", conversation="DEV:x",
        criterion_id="c01", comment="x", role="controller", status="open", second_opinion=None,
        second_opinion_status="unavailable", decision=None,
    )  # fmt: skip
    store.insert_appeal(appeal, fingerprint="f", transcript_hash="h")


@pytest.mark.parametrize(
    "occupy",
    [_occupy_with_a_conversation, _occupy_with_an_evaluation, _occupy_with_an_appeal],
    ids=["conversations", "evaluations", "appeals"],
)
def test_import_only_into_an_empty_database(source: Source, fresh, tmp_path: Path, occupy) -> None:
    path, _ = exported(source, tmp_path)
    fresh()
    occupy()

    def stored() -> dict[str, list[tuple]]:
        return {t.table: rows(f"SELECT * FROM {t.table} ORDER BY rowid") for t in TABLES}

    before = stored()
    with pytest.raises(ValueError, match="empty"):
        import_snapshot(path)
    assert stored() == before


def test_a_second_import_is_refused(source: Source, fresh, tmp_path: Path) -> None:
    path, _ = exported(source, tmp_path)
    fresh()
    import_snapshot(path)
    with pytest.raises(ValueError, match="empty"):
        import_snapshot(path)
    assert len(store.list_conversations()) == 6
    assert len(store.find_evaluations()) == 12


def test_a_failed_import_stores_nothing(source: Source, fresh, tmp_path: Path) -> None:
    evaluation = next(ev for ev in store.list_evaluations(*OFFICIAL) if ev.conversation == CHAT)
    file(source.client, evaluation.id, "c04")
    _, document = exported(source, tmp_path)
    document["appeals"].append(dict(document["appeals"][0]))  # the same appeal twice: the last insert fails
    broken = write_doc(tmp_path / "broken.json", document)

    fresh()
    with pytest.raises(SnapshotError):
        import_snapshot(broken)
    # the checklist copy, the conversations and the evaluations were written first, and rolled back
    assert store.get_checklist_version(source.copy.checklist_id, 1) is None
    assert store.list_conversations() == []
    assert rows("SELECT COUNT(*) FROM evaluations") == [(0,)]
    assert rows("SELECT COUNT(*) FROM judgments") == [(0,)]


def _drop(document: dict, key: str) -> dict:
    return {k: v for k, v in document.items() if k != key}


def _without_the_first_conversation(document: dict) -> dict:
    gone = document["evaluations"][0]["conversation"]
    return {**document, "conversations": [c for c in document["conversations"] if c["id"] != gone]}


def _with_an_orphan_appeal(document: dict) -> dict:
    appeal = {
        "id": "a1", "created_at": "2026-11-07T10:00:00.000000+00:00", "evaluation_id": "no-such-evaluation",
        "conversation": CHAT, "criterion_id": "c01", "comment": "x", "role": "controller", "status": "open",
        "second_opinion": None, "second_opinion_status": "unavailable", "decision": None,
    }  # fmt: skip
    row = {
        "id": "a1", "evaluation_id": "no-such-evaluation", "conversation": CHAT, "criterion_id": "c01",
        "fingerprint": "f", "transcript_hash": "h", "status": "open", "created_at": appeal["created_at"],
        "decided_at": None, "appeal": appeal,
    }  # fmt: skip
    return {**document, "appeals": [row]}


BAD_SNAPSHOTS: dict[str, Callable[[dict], object]] = {
    "wrong format": lambda d: {**d, "format": 2},
    "no format": lambda d: _drop(d, "format"),
    "no conversations": lambda d: _drop(d, "conversations"),
    "judgments not a list": lambda d: {**d, "judgments": {}},
    "a row without a column": lambda d: {**d, "evaluations": [_drop(d["evaluations"][0], "status")]},
    "a row without its json": lambda d: {**d, "evaluations": [_drop(d["evaluations"][0], "evaluation")]},
    "an invalid evaluation": lambda d: {**d, "evaluations": [{**d["evaluations"][0], "evaluation": {"id": 1}}]},
    "an evaluation without its conversation": _without_the_first_conversation,
    "an appeal without its evaluation": _with_an_orphan_appeal,
    "not an object": lambda d: [d],
}


@pytest.mark.parametrize("name", list(BAD_SNAPSHOTS))
def test_a_bad_snapshot_is_refused_and_stores_nothing(source: Source, fresh, tmp_path: Path, name: str) -> None:
    _, document = exported(source, tmp_path)
    path = write_doc(tmp_path / "bad.json", BAD_SNAPSHOTS[name](document))
    fresh()
    with pytest.raises(SnapshotError):
        import_snapshot(path)
    assert store.list_conversations() == []
    assert store.find_evaluations() == []


def test_garbage_and_missing_files_are_refused(fresh, tmp_path: Path) -> None:
    fresh()
    path = tmp_path / "garbage.json"
    path.write_text("{not json", encoding="utf-8")
    with pytest.raises(SnapshotError):
        import_snapshot(path)
    with pytest.raises(FileNotFoundError):
        import_snapshot(tmp_path / "missing.json")


def test_import_refuses_a_snapshot_with_a_signed_url(source: Source, fresh, tmp_path: Path) -> None:
    _, document = exported(source, tmp_path)
    document["conversations"][0]["conversation"]["transcript"][0]["text"] = "https://x.example.invalid/?sig=abc"
    path = write_doc(tmp_path / "signed.json", document)
    fresh()
    with pytest.raises(ValueError) as caught:
        import_snapshot(path)
    assert "abc" not in str(caught.value)
    assert store.list_conversations() == []


def test_an_error_message_never_repeats_the_data(source: Source, fresh, tmp_path: Path) -> None:
    _, document = exported(source, tmp_path)
    document["conversations"][0]["conversation"]["channel"] = "carrier pigeon SECRETVALUE"
    path = write_doc(tmp_path / "bad.json", document)
    fresh()
    with pytest.raises(SnapshotError) as caught:
        import_snapshot(path)
    assert "SECRETVALUE" not in str(caught.value)
    assert "channel" in str(caught.value)
