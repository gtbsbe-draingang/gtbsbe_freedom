"""The results snapshot and keyless mode (Task 13, issue #15).

Stream C's evaluator is replaced by tests.app.fakes.FakeEvaluator (no network, no Claude API). The
fake answers with the T2 pattern (total 84.17 on the official checklist). Every signed URL in
these tests is fake (`sig=FAKE`).

`source` is a database with the six DEV dialogues (the voice call has a signed audio link), the
official checklist and one weight-only copy of it, both applied to every dialogue. `fresh` starts
the app on a second, empty database, which is what a jury machine has.
"""

import dataclasses
import json
import logging
import re
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import checklists, db, jobs, snapshot as snapshots, store
from app.checklists import criterion_fingerprint
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
from tests.app.helpers import changed_official_seed, criterion, decide, file, save_copy

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


def seed_from(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    """Make `path` the only seed file: the one `seed_into_db` loads and the export compares against."""
    monkeypatch.setattr(checklists, "OFFICIAL_SEED", path)
    monkeypatch.setattr(checklists, "CALLS_SEED", path.parent / "no-calls-seed.json")


def alter_stored(version: tuple[str, int], change: Callable[[dict], None], *, refingerprint: bool) -> None:
    """Edit a stored checklist version in place, as an older database might hold it. With
    `refingerprint` the fingerprints are recomputed to match (an older, consistent version);
    without, they stay as they were (a hand-edited row)."""
    conn = connect()
    try:
        where = "WHERE checklist_id = ? AND version = ?"
        data = json.loads(conn.execute(f"SELECT json FROM checklist_versions {where}", version).fetchone()["json"])
        change(data)
        if refingerprint:
            for c in data["criteria"]:
                c["fingerprint"] = criterion_fingerprint(c)
        conn.execute(
            f"UPDATE checklist_versions SET json = ? {where}", (json.dumps(data, ensure_ascii=False), *version)
        )
        conn.commit()
    finally:
        conn.close()


def with_guidance(data: dict) -> None:
    data["criteria"][0]["guidance"] = "Changed after the database was seeded."


def with_new_title(data: dict) -> None:
    data["criteria"][1]["title"] += " (new)"


def with_swapped_criteria(data: dict) -> None:
    data["criteria"][0], data["criteria"][1] = data["criteria"][1], data["criteria"][0]


def with_heavier_c01(data: dict) -> None:
    data["criteria"][0]["weight"] = 20  # a weight is not part of the fingerprint


def with_new_name(data: dict) -> None:
    data["name"] += " (new)"


def with_new_section_title(data: dict) -> None:
    data["sections"][0]["title"] += " (new)"


def with_swapped_sections(data: dict) -> None:
    data["sections"][0], data["sections"][1] = data["sections"][1], data["sections"][0]


def with_unlocked(data: dict) -> None:
    data["locked"] = False


def with_based_on(data: dict) -> None:
    data["based_on"] = {"checklist_id": "somewhere-else", "version": 3}


def with_new_scale_label(data: dict) -> None:
    data["criteria"][3]["scale_steps"][0]["label"] += " (new)"


def with_new_na_rule(data: dict) -> None:
    data["criteria"][1]["na_condition"] += " (new)"


def with_other_criterion_order(data: dict) -> None:
    data["criteria"][0]["order"] = 99


def with_other_section_for_c01(data: dict) -> None:
    data["criteria"][0]["section_id"] = "safety"


# Everything that is scored or shown. The first three are in a criterion's fingerprint, the rest are not.
CONTENT_DRIFTS = [
    with_guidance, with_new_title, with_swapped_criteria, with_new_scale_label, with_new_na_rule,
    with_heavier_c01, with_new_name, with_new_section_title, with_swapped_sections, with_unlocked,
    with_based_on, with_other_criterion_order, with_other_section_for_c01,
]  # fmt: skip


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


def test_export_still_checks_the_whole_text_before_writing(
    source: Source, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    checked: list[str] = []
    real_check = snapshots.assert_no_signed_urls

    def spy(text: str) -> None:
        checked.append(text)
        real_check(text)

    monkeypatch.setattr(snapshots, "assert_no_signed_urls", spy)
    path, _ = exported(source, tmp_path)
    assert checked[-1] == path.read_text(encoding="utf-8")  # the full serialized text, as written


@pytest.mark.parametrize("part", ["conversations", "checklists"])
def test_the_refusal_names_the_part_and_the_row_but_not_the_text(source: Source, tmp_path: Path, part: str) -> None:
    signed = "https://files.example.invalid/a?sig=SECRETSIGNATURE"
    if part == "conversations":
        conv = store.get_conversation(CHAT)
        first = conv.transcript[0].model_copy(update={"text": signed})
        store.upsert_conversation(conv.model_copy(update={"transcript": [first, *conv.transcript[1:]]}), None)
        index = [r[0] for r in rows("SELECT id FROM conversations ORDER BY id")].index(CHAT)
    else:
        alter_stored((source.copy.checklist_id, 1), lambda data: data.update(description=signed), refingerprint=False)
        index = [r[0] for r in rows("SELECT checklist_id FROM checklist_versions ORDER BY rowid")].index(
            source.copy.checklist_id
        )

    target = tmp_path / "snapshot.json"
    with pytest.raises(SnapshotError) as caught:
        export_snapshot(target)
    message = str(caught.value)
    assert f"{part}[{index}]" in message
    assert "SECRETSIGNATURE" not in message and "files.example.invalid" not in message
    assert not target.exists()


# --- a seeded checklist that differs from its seed file ------------------------------------


@pytest.mark.parametrize("change", CONTENT_DRIFTS, ids=lambda change: change.__name__)
def test_export_refuses_when_the_seed_file_changed_since_the_database_was_seeded(
    source: Source, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: Callable[[dict], None]
) -> None:
    seed_from(monkeypatch, changed_official_seed(tmp_path / "seeds", change))
    target = tmp_path / "out" / "snapshot.json"
    target.parent.mkdir()
    target.write_text("OLD", encoding="utf-8")

    with pytest.raises(SnapshotError) as caught:
        export_snapshot(target)

    message = str(caught.value)
    assert "official-chat" in message and "version 1" in message and "official-chat-v1.json" in message
    assert "fresh database" in message
    assert "Changed after" not in message and "(new)" not in message  # names the checklist, never its text
    assert target.read_text(encoding="utf-8") == "OLD"  # nothing was written
    assert [p.name for p in target.parent.iterdir()] == ["snapshot.json"]  # and no temp file is left
    fresh_target = tmp_path / "never.json"
    with pytest.raises(SnapshotError):
        export_snapshot(fresh_target)
    assert not fresh_target.exists()


@pytest.mark.parametrize(
    ("change", "refingerprint"),
    [
        (with_guidance, True), (with_guidance, False),
        (with_new_title, True), (with_new_title, False),
        (with_swapped_criteria, False),
        (with_heavier_c01, False), (with_new_name, False), (with_swapped_sections, False),
    ],
    ids=[
        "guidance, older version", "guidance, hand-edited row",
        "title, older version", "title, hand-edited row",
        "order",
        "weight only", "name only", "section order",
    ],
)  # fmt: skip
def test_export_refuses_a_stored_seeded_checklist_that_was_altered(
    source: Source, tmp_path: Path, change: Callable[[dict], None], refingerprint: bool
) -> None:
    alter_stored(OFFICIAL, change, refingerprint=refingerprint)
    target = tmp_path / "snapshot.json"

    with pytest.raises(SnapshotError) as caught:
        export_snapshot(target)

    assert "official-chat" in str(caught.value) and "version 1" in str(caught.value)
    assert "official-chat-v1.json" in str(caught.value)
    assert "fresh database" in str(caught.value)
    assert not target.exists()


def test_export_refuses_a_seeded_checklist_whose_locked_flag_was_changed(source: Source, tmp_path: Path) -> None:
    conn = connect()
    try:  # the column is the authoritative flag (the JSON's copy keeps the old value)
        conn.execute("UPDATE checklist_versions SET locked = 0 WHERE checklist_id = ?", (OFFICIAL[0],))
        conn.commit()
    finally:
        conn.close()
    target = tmp_path / "snapshot.json"
    with pytest.raises(SnapshotError, match="official-chat version 1"):
        export_snapshot(target)
    assert not target.exists()


def test_export_ignores_storage_metadata_of_a_seeded_checklist(source: Source, tmp_path: Path) -> None:
    # Only `created_at` is not content: a database seeded on another day is the same checklist.
    alter_stored(OFFICIAL, lambda data: data.update(created_at="2020-01-02T03:04:05+00:00"), refingerprint=False)
    path, document = exported(source, tmp_path)
    assert path.is_file() and document["checklists"]


def test_export_ignores_checklists_that_are_not_seeded(source: Source, tmp_path: Path) -> None:
    alter_stored((source.copy.checklist_id, 1), with_new_title, refingerprint=True)  # a user's own checklist
    path, _ = exported(source, tmp_path)
    assert path.is_file()


def test_export_without_seed_files_or_with_a_seed_the_database_lacks(
    source: Source, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def other_id(data: dict) -> None:
        data["checklist_id"] = "not-in-this-database"

    seed_from(monkeypatch, changed_official_seed(tmp_path / "seeds", other_id))
    assert exported(source, tmp_path / "one")[0].is_file()  # nothing stored under that id: nothing to compare

    seed_from(monkeypatch, tmp_path / "seeds" / "gone.json")  # no seed file at all
    assert exported(source, tmp_path / "two")[0].is_file()


def test_export_refuses_a_seed_file_it_cannot_read(
    source: Source, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    broken = tmp_path / "seeds" / "official-chat-v1.json"
    broken.parent.mkdir()
    broken.write_text('{"checklist_id": "official-chat", "sig=SECRET', encoding="utf-8")
    seed_from(monkeypatch, broken)
    target = tmp_path / "snapshot.json"

    with pytest.raises(SnapshotError) as caught:
        export_snapshot(target)

    assert "official-chat-v1.json" in str(caught.value)
    assert "SECRET" not in str(caught.value)
    assert not target.exists()


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


@pytest.mark.parametrize(
    "change", [with_guidance, with_heavier_c01, with_new_name, with_unlocked], ids=lambda change: change.__name__
)
def test_import_warns_when_the_seeded_checklist_differs_from_the_snapshots_copy(
    source: Source, fresh, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture,
    change: Callable[[dict], None],
) -> None:
    path, _ = exported(source, tmp_path)  # exported while the seed file was still the original
    seed_from(monkeypatch, changed_official_seed(tmp_path / "seeds", change))
    fresh()  # the new database is seeded from the changed file
    seeded = rows("SELECT * FROM checklist_versions WHERE checklist_id = 'official-chat'")

    with caplog.at_level(logging.WARNING, logger="app.snapshot"):
        count = import_snapshot(path)

    warned = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warned) == 1
    assert "official-chat" in warned[0].getMessage() and "version 1" in warned[0].getMessage()
    assert "Changed after" not in caplog.text and "(new)" not in caplog.text  # names the checklist, not its text
    assert count > 0 and len(store.list_conversations()) == 6  # the import still went ahead
    assert rows("SELECT * FROM checklist_versions WHERE checklist_id = 'official-chat'") == seeded  # seeded one kept


def test_import_does_not_warn_when_the_seeded_checklist_has_the_same_content(
    source: Source, fresh, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path, document = exported(source, tmp_path)
    for row in document["checklists"]:  # the snapshot was made on another day: only created_at differs
        row["created_at"] = row["checklist"]["created_at"] = "2020-01-02T03:04:05+00:00"
    fresh()

    with caplog.at_level(logging.WARNING, logger="app.snapshot"):
        import_snapshot(write_doc(tmp_path / "older.json", document))

    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


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


# --- tables other streams register (final review I2) ---------------------------------------
#
# A stand-in for stream C's `c_translations` (conversation, lang, payload = a JSON list of strings,
# created_at; PRIMARY KEY (conversation, lang)), under a test-only name. The registries are
# process-global: `registry` gives each test private copies, so nothing leaks into other tests.

FAKE_PART = "t_fake_translations"
FAKE_TABLE_SQL = f"""
    CREATE TABLE {FAKE_PART} (
        conversation TEXT NOT NULL,
        lang TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation, lang)
    );
"""
FAKE_TABLE = snapshots.Table(
    FAKE_PART, FAKE_PART, ("conversation", "lang", "created_at"), "payload", "payload", list[str],
    order="conversation, lang",
)  # fmt: skip


@pytest.fixture
def registry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(snapshots, "_REGISTERED", dict(snapshots._REGISTERED))
    monkeypatch.setattr(db, "_MIGRATIONS", dict(db._MIGRATIONS))


@pytest.fixture
def translations(registry: None) -> snapshots.Table:
    """The stand-in table, registered for migrations and for the snapshot, and created now."""
    db.register_migration("t_001_fake_translations", FAKE_TABLE_SQL)
    snapshots.register_snapshot_table(FAKE_TABLE)
    migrate()
    return FAKE_TABLE


def add_translation(conversation: str, lang: str, lines: list[str], created_at: str = "2026-11-07T12:00:00+00:00") -> None:
    conn = connect()
    try:
        conn.execute(
            f"INSERT INTO {FAKE_PART} (conversation, lang, payload, created_at) VALUES (?, ?, ?, ?)",
            (conversation, lang, json.dumps(lines, ensure_ascii=False), created_at),
        )
        conn.commit()
    finally:
        conn.close()


def translation_rows() -> list[tuple]:
    """The rows with the payload parsed: it comes back as the canonical (compact) JSON of its type."""
    found = rows(f"SELECT conversation, lang, payload, created_at FROM {FAKE_PART} ORDER BY conversation, lang")
    return [(conversation, lang, json.loads(payload), created_at) for conversation, lang, payload, created_at in found]


def test_a_registered_table_round_trips(source: Source, fresh, translations, tmp_path: Path) -> None:
    add_translation(VOICE, "ru", ["Здравствуйте", "Спасибо"])
    add_translation(CHAT, "ru", ["Добрый день"], created_at="2026-11-07T11:00:00+00:00")
    before = translation_rows()

    path, document = exported(source, tmp_path)
    assert document["format"] == 1  # the part is additive
    assert document[FAKE_PART] == [  # sorted by the table's order, the JSON column nested
        {"conversation": CHAT, "lang": "ru", "created_at": "2026-11-07T11:00:00+00:00", "payload": ["Добрый день"]},
        {"conversation": VOICE, "lang": "ru", "created_at": "2026-11-07T12:00:00+00:00",
         "payload": ["Здравствуйте", "Спасибо"]},
    ]  # fmt: skip
    text = path.read_text(encoding="utf-8")
    assert text == json.dumps(document, sort_keys=True, ensure_ascii=False, indent=1) + "\n"
    assert row_count(document) == sum(len(document[t.key]) for t in TABLES) + 2
    again, _ = exported(source, tmp_path / "again")
    assert again.read_bytes() == path.read_bytes()  # deterministic

    fresh()
    assert translation_rows() == []
    assert import_snapshot(path) == row_count(document) - 1  # the seeded official checklist is skipped
    assert translation_rows() == before
    assert len(store.list_conversations()) == 6  # B's parts in the same import


def test_a_registered_table_that_does_not_exist_is_not_exported(source: Source, registry, tmp_path: Path) -> None:
    snapshots.register_snapshot_table(FAKE_TABLE)  # registered, but no migration created it
    _, document = exported(source, tmp_path)
    assert FAKE_PART not in document


def test_a_signed_url_in_a_registered_table_refuses_the_export(source: Source, translations, tmp_path: Path) -> None:
    add_translation(CHAT, "en", ["fine"])
    add_translation(VOICE, "ru", ["see https://files.example.invalid/a?sig=SECRETSIGNATURE"])
    target = tmp_path / "snapshot.json"
    with pytest.raises(SnapshotError) as caught:
        export_snapshot(target)
    message = str(caught.value)
    assert f"{FAKE_PART}[1]" in message  # the part and the row
    assert "SECRETSIGNATURE" not in message and "files.example.invalid" not in message
    assert not target.exists()


def test_the_whole_text_check_covers_registered_tables(
    source: Source, translations, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    add_translation(CHAT, "ru", ["https://files.example.invalid/a?sig=SECRETSIGNATURE"])
    monkeypatch.setattr(snapshots, "_check_rows_for_signed_urls", lambda document: None)  # the last line of defence
    target = tmp_path / "snapshot.json"
    with pytest.raises(SnapshotError):
        export_snapshot(target)
    assert not target.exists()


def test_a_part_not_registered_here_is_skipped_with_a_warning(
    source: Source, fresh, translations, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    add_translation(CHAT, "ru", ["Добрый день"])
    path, document = exported(source, tmp_path)
    expected = row_count(document) - 1 - len(document[FAKE_PART])  # no seeded checklist, no unknown part
    monkeypatch.setattr(snapshots, "_REGISTERED", {})  # the importing machine lacks that package
    fresh()

    with caplog.at_level(logging.WARNING, logger="app.snapshot"):
        count = import_snapshot(path)

    assert count == expected
    assert len(store.list_conversations()) == 6
    assert translation_rows() == []  # its table exists here (the migration ran), but nothing went in
    warned = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warned) == 1 and FAKE_PART in warned[0]
    assert "Добрый день" not in caplog.text  # names the part, never the data


def test_a_registered_table_missing_from_the_snapshot_stays_empty(
    source: Source, fresh, registry, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path, document = exported(source, tmp_path)  # made before the table was registered
    assert FAKE_PART not in document
    db.register_migration("t_001_fake_translations", FAKE_TABLE_SQL)
    snapshots.register_snapshot_table(FAKE_TABLE)
    fresh()
    with caplog.at_level(logging.WARNING, logger="app.snapshot"):
        import_snapshot(path)
    assert translation_rows() == []
    assert len(store.list_conversations()) == 6
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


def test_a_registered_part_whose_table_is_missing_here_is_skipped_with_a_warning(
    source: Source, fresh, translations, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    add_translation(CHAT, "ru", ["Добрый день"])
    path, _ = exported(source, tmp_path)
    monkeypatch.setattr(db, "_MIGRATIONS", {k: v for k, v in db._MIGRATIONS.items() if not k.startswith("t_")})
    fresh()  # registered for the snapshot, but its migration never ran here
    with caplog.at_level(logging.WARNING, logger="app.snapshot"):
        import_snapshot(path)
    assert len(store.list_conversations()) == 6  # B's parts still load
    warned = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warned) == 1 and FAKE_PART in warned[0]


def test_a_non_empty_registered_table_refuses_the_import(source: Source, fresh, translations, tmp_path: Path) -> None:
    add_translation(CHAT, "ru", ["Добрый день"])
    path, _ = exported(source, tmp_path)
    fresh()
    add_translation("DEV:other", "ru", ["already here"])
    with pytest.raises(ValueError, match="empty"):
        import_snapshot(path)
    assert store.list_conversations() == []  # nothing of the snapshot went in
    assert translation_rows() == [("DEV:other", "ru", ["already here"], "2026-11-07T12:00:00+00:00")]


def test_a_bad_row_of_a_registered_table_is_refused_and_stores_nothing(
    source: Source, fresh, translations, tmp_path: Path
) -> None:
    add_translation(CHAT, "ru", ["Добрый день"])
    _, document = exported(source, tmp_path)
    document[FAKE_PART][0]["payload"] = {"not": "a list SECRETVALUE"}
    path = write_doc(tmp_path / "bad.json", document)
    fresh()
    with pytest.raises(SnapshotError) as caught:
        import_snapshot(path)
    assert f"{FAKE_PART}[0]" in str(caught.value) and "SECRETVALUE" not in str(caught.value)
    assert store.list_conversations() == []


@pytest.mark.parametrize(
    "table",
    [
        FAKE_TABLE,  # the same key twice
        dataclasses.replace(FAKE_TABLE, table="t_other"),  # the same key for another table
        *(dataclasses.replace(FAKE_TABLE, key=key) for key in ("conversations", "judgments", "format", "jobs")),
        dataclasses.replace(FAKE_TABLE, key="t_elsewhere", table="appeals"),  # one of B's tables
    ],
    ids=["duplicate", "same key", "conversations", "judgments", "format", "jobs", "b table"],
)
def test_registration_refuses_a_duplicate_or_one_of_bs_parts(registry, table: snapshots.Table) -> None:
    snapshots.register_snapshot_table(FAKE_TABLE)
    with pytest.raises(ValueError):
        snapshots.register_snapshot_table(table)
    assert snapshots.registered_snapshot_tables() == (FAKE_TABLE,)
