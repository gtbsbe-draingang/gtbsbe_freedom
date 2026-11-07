"""Checklist versions in SQLite, loading checklist files, and seeding at startup (Task 3).

These tests write their own small checklist files into tmp_path, so they run without stream A's
official seed and stream D's calls_v1.json.
"""

import json
import logging
import re
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import checklists, db, store
from app.checklists import criterion_fingerprint, load_checklist_file, load_seed, seed_into_db
from app.errors import ApiError
from app.models import ChecklistVersion

REPO_ROOT = Path(__file__).resolve().parents[3]
REAL_SEED = REPO_ROOT / "checklists" / "official-chat-v1.json"

MakeClient = Callable[..., TestClient]


def checklist_dict(checklist_id: str = "official-chat", version: int = 1, **overrides) -> dict:
    """A checklist as a seed file holds it: no fingerprints, no id."""
    data = {
        "checklist_id": checklist_id,
        "version": version,
        "name": "Тестовый чек-лист",
        "description": "",
        "channel": "any",
        "locked": True,
        "rounding": 2,
        "guidance": "Общая памятка.",
        "sections": [{"id": "s1", "title": "Раздел", "order": 1}],
        "criteria": [
            {
                "id": "c01", "section_id": "s1", "order": 1, "title": "Приветствие",
                "wording": "Да — оператор поздоровался.", "answer_type": "yes_no",
                "scale_steps": [], "weight": 40, "na_allowed": False, "na_condition": None,
                "kind": "scored", "kinds": [], "guidance": None,
            },
            {
                "id": "c02", "section_id": "s1", "order": 2, "title": "Ответ",
                "wording": "Оцените ответ.", "answer_type": "scale",
                "scale_steps": [{"value": 0, "label": "Нет"}, {"value": 60, "label": "Да"}],
                "weight": 60, "na_allowed": True, "na_condition": "N/A — вопроса не было.",
                "kind": "scored", "kinds": [], "guidance": "Пример.",
            },
        ],
    }  # fmt: skip
    return {**data, **overrides}


def write_checklist(path: Path, **kwargs) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(checklist_dict(**kwargs), ensure_ascii=False), encoding="utf-8")
    return path


def make_version(version: int = 1, checklist_id: str = "custom", **overrides) -> ChecklistVersion:
    data = checklist_dict(checklist_id, version, locked=False, **overrides)
    for criterion in data["criteria"]:
        criterion["fingerprint"] = criterion_fingerprint(criterion)
    return ChecklistVersion.model_validate(data)


@pytest.fixture
def migrated() -> None:
    db.migrate()


@pytest.fixture
def seed_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Point the seed locations into tmp_path. Neither file exists yet."""
    official = tmp_path / "checklists" / "official-chat-v1.json"
    calls = tmp_path / "checklists" / "calls_v1.json"
    monkeypatch.setattr(checklists, "OFFICIAL_SEED", official)
    monkeypatch.setattr(checklists, "CALLS_SEED", calls)
    return official, calls


def stored_rows() -> list[tuple[str, int, int]]:
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT checklist_id, version, locked FROM checklist_versions ORDER BY 1, 2"
        ).fetchall()
    finally:
        conn.close()
    return [(r["checklist_id"], r["version"], r["locked"]) for r in rows]


# --- the table -----------------------------------------------------------------------------


def test_migration_creates_checklist_versions(migrated: None) -> None:
    conn = db.connect()
    try:
        columns = {r["name"]: r for r in conn.execute("PRAGMA table_info(checklist_versions)")}
        applied = [r["name"] for r in conn.execute("SELECT name FROM schema_migrations")]
    finally:
        conn.close()
    assert list(columns) == ["checklist_id", "version", "json", "locked", "created_at"]
    assert all(columns[name]["notnull"] for name in ("json", "locked", "created_at"))
    assert columns["checklist_id"]["pk"] == 1 and columns["version"]["pk"] == 2
    assert "b_002_checklist_versions" in applied


# --- load_checklist_file / load_seed -------------------------------------------------------


def test_load_checklist_file_fills_fingerprints_and_id(tmp_path: Path) -> None:
    path = write_checklist(tmp_path / "x.json", checklist_id="calls", version=3)
    loaded = load_checklist_file(path)
    assert loaded.id == "calls:3"
    assert loaded.checklist_id == "calls" and loaded.version == 3
    assert [c.fingerprint for c in loaded.criteria] == [
        criterion_fingerprint(c) for c in checklist_dict()["criteria"]
    ]
    assert len({c.fingerprint for c in loaded.criteria}) == 2


def test_load_checklist_file_id_always_follows_checklist_id_and_version(tmp_path: Path) -> None:
    path = write_checklist(tmp_path / "x.json", id="somebody-elses:9", version=2)
    assert load_checklist_file(path).id == "official-chat:2"


def test_load_checklist_file_recomputes_a_fingerprint_it_finds(tmp_path: Path) -> None:
    data = checklist_dict()
    data["criteria"][0]["fingerprint"] = "stale"
    path = tmp_path / "x.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    assert re.fullmatch(r"[0-9a-f]{64}", load_checklist_file(path).criteria[0].fingerprint)


def test_load_checklist_file_fingerprints_the_validated_criterion(tmp_path: Path) -> None:
    # `na_allowed: 0` and a scale value `5.0` are valid input that pydantic coerces to False and 5.
    # The fingerprint must be that of the stored criterion, not of the raw dict (where 0 and 5.0
    # hash differently), or a fingerprint computed again later would not match the stored one.
    data = checklist_dict()
    data["criteria"][0]["na_allowed"] = 0
    data["criteria"][1]["scale_steps"] = [
        {"value": 0.0, "label": "Нет"},
        {"value": 60.0, "label": "Да"},
    ]
    path = tmp_path / "x.json"
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    loaded = load_checklist_file(path)
    for criterion in loaded.criteria:
        assert criterion.fingerprint == criterion_fingerprint(criterion)
    typed = checklist_dict()["criteria"]  # the same checklist written with the proper types
    assert [c.fingerprint for c in loaded.criteria] == [criterion_fingerprint(c) for c in typed]


def write_raw(path: Path, data: dict) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        (lambda d: d["criteria"][0].update(weight="1e400"), "criterion 'c01': weight"),
        (lambda d: d["criteria"][0].update(weight="1e100000"), "criterion 'c01': weight"),
        (lambda d: d["criteria"][0].update(weight=1001), "criterion 'c01': weight"),
        (lambda d: d["criteria"][0].update(weight="12.1234567890123456789"), "criterion 'c01': weight"),
        (lambda d: d["criteria"][1].update(id="c01"), "duplicate criterion id 'c01'"),
        (lambda d: d["criteria"][0].update(section_id="nowhere"), "unknown section 'nowhere'"),
        (lambda d: d.update(name="  "), "needs a name"),
        (lambda d: d.update(criteria=[]), "at least one criterion"),
    ],
)
def test_load_checklist_file_rejects_a_checklist_that_breaks_the_editing_rules(
    tmp_path: Path, change, fragment: str
) -> None:
    # The same rules as the API's: a seed that would poison the database is a loud error.
    data = checklist_dict()
    change(data)
    with pytest.raises(ValueError, match=re.escape(fragment)):
        load_checklist_file(write_raw(tmp_path / "x.json", data))


def test_a_seed_that_breaks_the_rules_is_an_error_and_stores_nothing(migrated: None, seed_files) -> None:
    official, _ = seed_files
    data = checklist_dict()
    data["criteria"][0]["weight"] = "1e400"
    write_raw(official, data)
    with pytest.raises(ValueError, match="official-chat-v1.json"):
        seed_into_db()
    assert stored_rows() == []


def test_load_checklist_file_keeps_locked_as_written(tmp_path: Path) -> None:
    unlocked = write_checklist(tmp_path / "u.json", locked=False)
    assert load_checklist_file(unlocked).locked is False
    assert load_checklist_file(write_checklist(tmp_path / "l.json", locked=True)).locked is True


def test_load_checklist_file_rejects_a_broken_file(tmp_path: Path) -> None:
    path = tmp_path / "x.json"
    path.write_text(json.dumps({"checklist_id": "x"}), encoding="utf-8")
    with pytest.raises(ValueError):  # pydantic's ValidationError is a ValueError
        load_checklist_file(path)


def test_load_seed_is_load_checklist_file(tmp_path: Path) -> None:
    path = write_checklist(tmp_path / "official-chat-v1.json")
    assert load_seed(path) == load_checklist_file(path)
    assert load_seed(path).id == "official-chat:1"


def test_seed_locations() -> None:
    assert checklists.OFFICIAL_SEED == REPO_ROOT / "checklists" / "official-chat-v1.json"
    assert checklists.CALLS_SEED == REPO_ROOT / "checklists" / "calls_v1.json"


# --- get / save ----------------------------------------------------------------------------


def test_get_checklist_version_unknown_is_none(migrated: None) -> None:
    assert store.get_checklist_version("nope", 1) is None


def test_save_then_get_round_trips(migrated: None) -> None:
    saved = store.save_checklist_version(make_version(2))
    assert saved.created_at is not None
    got = store.get_checklist_version("custom", 2)
    assert got == saved
    assert got.id == "custom:2"
    assert [c.fingerprint for c in got.criteria] == [c.fingerprint for c in make_version(2).criteria]
    assert [str(c.weight) for c in got.criteria] == ["40", "60"]  # Decimal survives storage
    assert store.get_checklist_version("custom", 1) is None


def test_save_fills_created_at_in_utc(migrated: None) -> None:
    before = datetime.now(UTC).replace(microsecond=0)
    saved = store.save_checklist_version(make_version())
    after = datetime.now(UTC)
    assert saved.created_at is not None and saved.created_at.utcoffset() is not None
    assert before <= saved.created_at <= after
    conn = db.connect()
    try:
        column = conn.execute("SELECT created_at FROM checklist_versions").fetchone()["created_at"]
    finally:
        conn.close()
    assert datetime.fromisoformat(column) == saved.created_at


def test_save_keeps_a_given_created_at(migrated: None) -> None:
    given = datetime(2026, 11, 7, 9, 30, tzinfo=UTC)
    saved = store.save_checklist_version(make_version().model_copy(update={"created_at": given}))
    assert saved.created_at == given
    assert store.get_checklist_version("custom", 1).created_at == given


def test_save_refuses_to_overwrite(migrated: None) -> None:
    first = store.save_checklist_version(make_version())
    changed = make_version(name="Другое имя")
    with pytest.raises(ApiError) as caught:
        store.save_checklist_version(changed)
    assert (caught.value.status, caught.value.code) == (409, "version_exists")
    assert "custom" in caught.value.message
    assert store.get_checklist_version("custom", 1) == first


def test_same_id_different_version_is_a_new_row(migrated: None) -> None:
    store.save_checklist_version(make_version(1))
    store.save_checklist_version(make_version(2))
    assert [v for _, v, _ in stored_rows()] == [1, 2]


def test_locked_is_stored_in_its_column(migrated: None) -> None:
    store.save_checklist_version(make_version(1))
    store.save_checklist_version(make_version(2).model_copy(update={"locked": True}))
    assert stored_rows() == [("custom", 1, 0), ("custom", 2, 1)]


def test_get_reads_locked_from_the_column(migrated: None) -> None:
    # The column is what changes after the first save (a version locks when it is first used).
    store.save_checklist_version(make_version())
    conn = db.connect()
    try:
        conn.execute("UPDATE checklist_versions SET locked = 1")
        conn.commit()
    finally:
        conn.close()
    assert store.get_checklist_version("custom", 1).locked is True


# --- seed_into_db --------------------------------------------------------------------------


def test_seed_into_db_inserts_the_official_seed_as_written(migrated: None, seed_files) -> None:
    official, _ = seed_files
    write_checklist(official, locked=True)
    seed_into_db()
    assert stored_rows() == [("official-chat", 1, 1)]
    stored = store.get_checklist_version("official-chat", 1)
    assert stored == load_seed(official).model_copy(update={"created_at": stored.created_at})
    assert stored.created_at is not None


def test_seed_into_db_is_idempotent(migrated: None, seed_files) -> None:
    official, calls = seed_files
    write_checklist(official)
    write_checklist(calls, checklist_id="calls", locked=False)
    seed_into_db()
    first = [store.get_checklist_version(c, 1) for c in ("official-chat", "calls")]
    seed_into_db()
    seed_into_db()
    assert [store.get_checklist_version(c, 1) for c in ("official-chat", "calls")] == first
    assert stored_rows() == [("calls", 1, 0), ("official-chat", 1, 1)]


def test_seed_into_db_does_not_overwrite_a_stored_version(migrated: None, seed_files) -> None:
    official, _ = seed_files
    write_checklist(official, name="Первый")
    seed_into_db()
    write_checklist(official, name="Изменён в файле")
    seed_into_db()
    assert store.get_checklist_version("official-chat", 1).name == "Первый"


def test_seed_into_db_keeps_a_lock_set_after_seeding(migrated: None, seed_files) -> None:
    _, calls = seed_files
    write_checklist(calls, checklist_id="calls", locked=False)
    seed_into_db()
    conn = db.connect()
    try:
        conn.execute("UPDATE checklist_versions SET locked = 1 WHERE checklist_id = 'calls'")
        conn.commit()
    finally:
        conn.close()
    seed_into_db()
    assert store.get_checklist_version("calls", 1).locked is True


def test_calls_seed_is_unlocked_unless_the_file_says_otherwise(migrated: None, seed_files) -> None:
    _, calls = seed_files
    data = checklist_dict("calls")
    del data["locked"]
    calls.parent.mkdir(parents=True, exist_ok=True)
    calls.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    seed_into_db()
    assert stored_rows() == [("calls", 1, 0)]


def test_calls_seed_locked_when_the_file_says_so(migrated: None, seed_files) -> None:
    _, calls = seed_files
    write_checklist(calls, checklist_id="calls", locked=True)
    seed_into_db()
    assert stored_rows() == [("calls", 1, 1)]


def test_calls_seed_is_inserted_when_only_its_version_is_missing(migrated: None, seed_files) -> None:
    _, calls = seed_files
    store.save_checklist_version(make_version(1, "calls"))
    write_checklist(calls, checklist_id="calls", version=2, locked=False)
    seed_into_db()
    assert [(c, v) for c, v, _ in stored_rows()] == [("calls", 1), ("calls", 2)]


def test_missing_official_seed_warns_and_skips(
    migrated: None, seed_files, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="app.checklists"):
        seed_into_db()
    assert stored_rows() == []
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "official-chat-v1.json" in warnings[0].getMessage()


def test_missing_calls_seed_is_silent(migrated: None, seed_files, caplog: pytest.LogCaptureFixture) -> None:
    official, _ = seed_files
    write_checklist(official)
    with caplog.at_level(logging.WARNING, logger="app.checklists"):
        seed_into_db()
    assert stored_rows() == [("official-chat", 1, 1)]
    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_a_missing_official_seed_does_not_stop_the_calls_seed(migrated: None, seed_files) -> None:
    _, calls = seed_files
    write_checklist(calls, checklist_id="calls", locked=False)
    seed_into_db()
    assert stored_rows() == [("calls", 1, 0)]


def test_a_broken_seed_file_is_an_error_not_a_silent_skip(migrated: None, seed_files) -> None:
    official, _ = seed_files
    official.parent.mkdir(parents=True, exist_ok=True)
    official.write_text('{"checklist_id": "official-chat"}', encoding="utf-8")
    with pytest.raises(ValueError):
        seed_into_db()
    assert stored_rows() == []


def test_concurrent_seeding_inserts_once(migrated: None, seed_files) -> None:
    # Two server processes starting together both see the version missing; the loser's 409 is fine.
    official, _ = seed_files
    write_checklist(official)
    errors: list[BaseException] = []
    barrier = threading.Barrier(4)

    def run() -> None:
        try:
            barrier.wait()
            seed_into_db()
        except BaseException as exc:  # noqa: BLE001 - collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert stored_rows() == [("official-chat", 1, 1)]


# --- startup -------------------------------------------------------------------------------


def test_startup_seeds_after_migrating(make_client: MakeClient, seed_files) -> None:
    official, calls = seed_files
    write_checklist(official)
    write_checklist(calls, checklist_id="calls", locked=False)
    make_client()
    assert stored_rows() == [("calls", 1, 0), ("official-chat", 1, 1)]
    assert store.get_checklist_version("official-chat", 1).id == "official-chat:1"


def test_startup_without_any_seed_file_still_boots(make_client: MakeClient, seed_files) -> None:
    client = make_client()
    assert client.get("/api/openapi.json").status_code == 200
    assert stored_rows() == []


@pytest.mark.skipif(not REAL_SEED.exists(), reason="waiting for stream A seed")
def test_startup_seeds_the_real_official_checklist(make_client: MakeClient) -> None:
    make_client()
    stored = store.get_checklist_version("official-chat", 1)
    assert stored is not None and stored.locked is True and len(stored.criteria) == 8
