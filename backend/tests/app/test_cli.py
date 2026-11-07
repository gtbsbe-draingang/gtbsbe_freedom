"""The two commands, `cqa-serve` and `cqa-snapshot` (Task 13, issue #15).

uvicorn.run is replaced by a recorder, so nothing binds a port. Every URL and key here is fake.
"""

import importlib
import json
import logging
import sqlite3
import sys
import tomllib
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn
from fastapi import FastAPI

from app import checklists, cli, snapshot as snapshot_store, store
from app.checklists import seed_into_db
from app.db import migrate
from app.settings import BACKEND_DIR, ENV_FILE, Settings, get_settings
from app.snapshot import SNAPSHOT as REAL_SNAPSHOT
from tests.app.fakes import load_dev_subset
from tests.app.helpers import changed_official_seed

# Read at collection time, before the autouse fixture takes the .env file away.
DEFAULT_ENV_FILE = Settings.model_config.get("env_file")

SECRET_KEY = "sk-ant-SECRETKEYVALUE"
SECRET_URL = "https://organiser.example.invalid/api/data?group_id=x&sig=SECRETSIGNATURE"


@pytest.fixture
def uvicorn_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    calls: list[dict] = []
    monkeypatch.setattr(uvicorn, "run", lambda app, **kwargs: calls.append({"app": app, **kwargs}))
    return calls


def use_database(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    monkeypatch.setenv("DB_PATH", str(path))
    get_settings.cache_clear()


def build_snapshot(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """A snapshot of the six DEV dialogues, written to tmp_path and made the one `cqa-serve` finds.
    The database in use afterwards is a new, empty one."""
    use_database(monkeypatch, tmp_path / "source.db")
    migrate()
    seed_into_db()
    load_dev_subset()
    path = tmp_path / "snapshot" / "cqa-snapshot.json"
    snapshot_store.export_snapshot(path)
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", path)
    use_database(monkeypatch, tmp_path / "serve.db")
    return path


# --- arguments -----------------------------------------------------------------------------


def test_serve_arguments_default_to_localhost_8000() -> None:
    args = cli.parse_serve_args([])
    assert (args.host, args.port) == ("127.0.0.1", 8000)


def test_serve_arguments_can_be_overridden() -> None:
    args = cli.parse_serve_args(["--host", "0.0.0.0", "--port", "8765"])
    assert (args.host, args.port) == ("0.0.0.0", 8765)


@pytest.mark.parametrize("argv", [["--port", "abc"], ["--port", "0"], ["--port", "70000"], ["--nope"], ["8000"]])
def test_bad_serve_arguments_are_refused(argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as caught:
        cli.parse_serve_args(argv)
    assert caught.value.code == 2
    assert "usage" in capsys.readouterr().err


def test_the_console_scripts_are_declared() -> None:
    project = tomllib.loads((BACKEND_DIR / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    assert project["scripts"] == {"cqa-serve": "app.cli:serve", "cqa-snapshot": "app.cli:snapshot"}
    assert callable(cli.serve) and callable(cli.snapshot)


def test_dotenv_is_found_from_the_package_not_from_the_working_directory() -> None:
    assert ENV_FILE == BACKEND_DIR / ".env"
    assert DEFAULT_ENV_FILE == ENV_FILE
    assert ENV_FILE.is_absolute()
    assert (BACKEND_DIR / "app" / "settings.py").is_file()


def test_no_test_can_reach_the_real_snapshot_file(tmp_path: Path) -> None:
    # The autouse fixture in tests/conftest.py points the path into tmp_path for every test.
    assert REAL_SNAPSHOT.parts[-3:] == ("data", "snapshot", "cqa-snapshot.json")
    assert snapshot_store.SNAPSHOT != REAL_SNAPSHOT
    assert snapshot_store.SNAPSHOT.is_relative_to(tmp_path)


def test_cqa_snapshot_with_the_default_path_writes_under_tmp_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    use_database(monkeypatch, tmp_path / "source.db")
    migrate()
    seed_into_db()
    load_dev_subset()
    before = REAL_SNAPSHOT.read_bytes() if REAL_SNAPSHOT.is_file() else None  # None: not committed yet

    cli.snapshot([])  # the path is not patched here: it is the fixture's

    assert snapshot_store.SNAPSHOT.is_file() and snapshot_store.SNAPSHOT.is_relative_to(tmp_path)
    assert (REAL_SNAPSHOT.read_bytes() if REAL_SNAPSHOT.is_file() else None) == before


# --- cqa-serve -----------------------------------------------------------------------------


def test_serve_loads_the_snapshot_into_an_empty_database(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], capsys: pytest.CaptureFixture[str]
) -> None:
    build_snapshot(monkeypatch, tmp_path)
    assert not (tmp_path / "serve.db").exists()

    cli.serve([])

    assert len(store.list_conversations()) == 6
    assert store.get_checklist_version("official-chat", 1) is not None  # seeded
    assert len(uvicorn_calls) == 1
    call = uvicorn_calls[0]
    assert isinstance(call.pop("app"), FastAPI)
    assert call == {"host": "127.0.0.1", "port": 8000}
    out = capsys.readouterr().out
    assert "CQA is running at http://127.0.0.1:8000/" in out.splitlines()
    assert "Model key: not configured." in out
    assert "snapshot" in out.lower()


def test_serve_host_and_port_reach_uvicorn_and_the_printed_address(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], capsys: pytest.CaptureFixture[str]
) -> None:
    build_snapshot(monkeypatch, tmp_path)
    cli.serve(["--host", "0.0.0.0", "--port", "8765"])
    assert (uvicorn_calls[0]["host"], uvicorn_calls[0]["port"]) == ("0.0.0.0", 8765)
    assert "CQA is running at http://0.0.0.0:8765/" in capsys.readouterr().out.splitlines()


def test_serve_brackets_an_ipv6_host(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], capsys: pytest.CaptureFixture[str]
) -> None:
    build_snapshot(monkeypatch, tmp_path)
    cli.serve(["--host", "::1"])
    assert "CQA is running at http://[::1]:8000/" in capsys.readouterr().out.splitlines()


def test_serve_without_a_snapshot_starts_with_an_empty_database(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], caplog: pytest.LogCaptureFixture
) -> None:
    use_database(monkeypatch, tmp_path / "serve.db")
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", tmp_path / "missing" / "cqa-snapshot.json")
    with caplog.at_level(logging.WARNING, logger="app.cli"):
        cli.serve([])
    assert len(uvicorn_calls) == 1
    assert store.list_conversations() == []
    assert store.get_checklist_version("official-chat", 1) is not None  # the seeded checklists are there
    assert any("snapshot" in message.lower() for message in caplog.messages)


def test_serve_leaves_a_database_that_has_conversations_alone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], capsys: pytest.CaptureFixture[str]
) -> None:
    build_snapshot(monkeypatch, tmp_path)
    cli.serve([])
    first = len(store.list_conversations())
    capsys.readouterr()

    cli.serve([])  # the second start: the data is already there

    assert len(store.list_conversations()) == first == 6
    assert len(uvicorn_calls) == 2
    assert "Loaded" not in capsys.readouterr().out


def test_serve_survives_a_snapshot_that_cannot_be_loaded(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], caplog: pytest.LogCaptureFixture
) -> None:
    use_database(monkeypatch, tmp_path / "serve.db")
    broken = tmp_path / "cqa-snapshot.json"
    broken.write_text('{"format": 1, "conversations": "sig=SECRETSIGNATURE', encoding="utf-8")
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", broken)
    with caplog.at_level(logging.WARNING, logger="app.cli"):
        cli.serve([])
    assert len(uvicorn_calls) == 1
    assert store.list_conversations() == []
    assert any("snapshot" in message.lower() for message in caplog.messages)
    assert "SECRETSIGNATURE" not in caplog.text


def test_serve_survives_a_snapshot_that_is_not_text(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], caplog: pytest.LogCaptureFixture
) -> None:
    use_database(monkeypatch, tmp_path / "serve.db")
    undecodable = tmp_path / "cqa-snapshot.json"
    undecodable.write_bytes(b'\xff\xfe{"format": 1, "x": "sig=SECRETSIGNATURE')
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", undecodable)
    with caplog.at_level(logging.WARNING, logger="app.cli"):
        cli.serve([])
    assert len(uvicorn_calls) == 1
    assert store.list_conversations() == []
    assert any("UnicodeDecodeError" in message for message in caplog.messages)  # the type only
    assert "SECRETSIGNATURE" not in caplog.text


@pytest.mark.parametrize(
    "error",
    [
        PermissionError("denied: SECRETDETAIL"),
        ValueError("bad value: SECRETDETAIL"),
        sqlite3.OperationalError("database is locked: SECRETDETAIL"),
    ],
    ids=["unreadable file", "other value error", "database locked"],
)
def test_serve_survives_an_import_that_fails_for_any_other_reason(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    uvicorn_calls: list[dict],
    caplog: pytest.LogCaptureFixture,
    error: Exception,
) -> None:
    use_database(monkeypatch, tmp_path / "serve.db")
    present = tmp_path / "cqa-snapshot.json"
    present.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", present)

    def failing(path: Path) -> int:
        raise error

    monkeypatch.setattr(snapshot_store, "import_snapshot", failing)
    with caplog.at_level(logging.WARNING, logger="app.cli"):
        cli.serve([])  # no traceback: the app starts with whatever the database holds

    assert len(uvicorn_calls) == 1
    assert store.get_checklist_version("official-chat", 1) is not None  # still migrated and seeded
    assert any(type(error).__name__ in message for message in caplog.messages)
    assert "SECRETDETAIL" not in caplog.text  # the type only, never the text


def test_serve_never_prints_the_key_or_the_organisers_url(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    uvicorn_calls: list[dict],
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    build_snapshot(monkeypatch, tmp_path)
    monkeypatch.setenv("ANTHROPIC_API_KEY", SECRET_KEY)
    monkeypatch.setenv("ORGANIZER_API_URL", SECRET_URL)
    get_settings.cache_clear()
    with caplog.at_level(logging.DEBUG):
        cli.serve([])
    shown = capsys.readouterr()
    everything = shown.out + shown.err + caplog.text
    assert "Model key: configured." in shown.out
    assert "Organisers' API: configured." in shown.out
    for secret in (SECRET_KEY, "SECRETKEYVALUE", SECRET_URL, "SECRETSIGNATURE", "organiser.example.invalid"):
        assert secret not in everything


def test_serve_reports_a_missing_organisers_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], capsys: pytest.CaptureFixture[str]
) -> None:
    build_snapshot(monkeypatch, tmp_path)
    cli.serve([])
    assert "Organisers' API: not configured." in capsys.readouterr().out


def test_serve_resolves_a_relative_database_path_against_backend(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict]
) -> None:
    backend, elsewhere = tmp_path / "backend", tmp_path / "elsewhere"
    backend.mkdir()
    elsewhere.mkdir()
    monkeypatch.setattr(cli, "BACKEND_DIR", backend)
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", tmp_path / "none.json")
    monkeypatch.setenv("DB_PATH", "relative.db")
    monkeypatch.chdir(elsewhere)  # not backend/: the same file must be used from anywhere
    get_settings.cache_clear()

    cli.serve([])

    assert (backend / "relative.db").is_file()
    assert not (elsewhere / "relative.db").exists()
    assert get_settings().db_path == backend / "relative.db"
    assert len(uvicorn_calls) == 1


def test_serve_keeps_an_absolute_database_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict]
) -> None:
    target = tmp_path / "somewhere" / "mine.db"
    use_database(monkeypatch, target)
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", tmp_path / "none.json")
    cli.serve([])
    assert target.is_file()


def test_the_app_serve_hands_to_uvicorn_works(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict]
) -> None:
    from fastapi.testclient import TestClient

    build_snapshot(monkeypatch, tmp_path)
    cli.serve([])
    with TestClient(uvicorn_calls[0]["app"]) as client:
        assert client.get("/api/config").json()["model_key_configured"] is False
        assert len(client.get("/api/conversations").json()) == 6


# --- cqa-snapshot --------------------------------------------------------------------------


def test_snapshot_exports_the_current_database(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = build_snapshot(monkeypatch, tmp_path)
    use_database(monkeypatch, tmp_path / "source.db")
    target.unlink()

    cli.snapshot([])

    assert target.is_file()
    document = snapshot_store.export_snapshot(tmp_path / "again.json")
    assert len(document["conversations"]) == 6
    assert target.read_bytes() == (tmp_path / "again.json").read_bytes()
    out = capsys.readouterr().out
    assert f"Wrote {snapshot_store.row_count(document)} rows to {target}" in out


def test_snapshot_refuses_signed_text(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = build_snapshot(monkeypatch, tmp_path)
    use_database(monkeypatch, tmp_path / "source.db")
    conv = store.get_conversation("DEV:p1-ru-001")
    assert conv is not None
    first = conv.transcript[0].model_copy(update={"text": "https://files.example.invalid/a?sig=SECRETSIGNATURE"})
    store.upsert_conversation(conv.model_copy(update={"transcript": [first, *conv.transcript[1:]]}), None)
    target.write_text("OLD", encoding="utf-8")

    with pytest.raises(SystemExit) as caught:
        cli.snapshot([])

    assert caught.value.code == 1
    shown = capsys.readouterr()
    assert "refus" in shown.err.lower()
    assert "SECRETSIGNATURE" not in shown.out + shown.err
    assert "conversations[" in shown.err  # says where, not what
    assert target.read_text(encoding="utf-8") == "OLD"


@pytest.mark.parametrize(
    "change",
    [lambda d: d["criteria"][0].update(guidance="New guidance."), lambda d: d["criteria"][0].update(weight=20)],
    ids=["guidance", "weight only"],
)
def test_snapshot_refuses_a_seeded_checklist_that_differs_from_its_seed_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str], change
) -> None:
    target = build_snapshot(monkeypatch, tmp_path)
    use_database(monkeypatch, tmp_path / "source.db")  # seeded from the original seed file
    changed = changed_official_seed(tmp_path / "seeds", change)
    monkeypatch.setattr(checklists, "OFFICIAL_SEED", changed)
    monkeypatch.setattr(checklists, "CALLS_SEED", tmp_path / "seeds" / "none.json")
    target.write_text("OLD", encoding="utf-8")

    with pytest.raises(SystemExit) as caught:
        cli.snapshot([])

    assert caught.value.code == 1
    shown = capsys.readouterr()
    assert "official-chat" in shown.err and "version 1" in shown.err and "official-chat-v1.json" in shown.err
    assert "fresh database" in shown.err
    assert "New guidance" not in shown.out + shown.err
    assert target.read_text(encoding="utf-8") == "OLD"


def test_snapshot_refuses_an_empty_database_and_keeps_the_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    target = build_snapshot(monkeypatch, tmp_path)  # leaves a new, empty database in use
    migrate()
    seed_into_db()
    before = target.read_bytes()

    with pytest.raises(SystemExit) as caught:
        cli.snapshot([])

    assert caught.value.code == 1
    assert "nothing to export" in capsys.readouterr().err.lower()
    assert target.read_bytes() == before


def test_snapshot_refuses_when_there_is_no_database(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", tmp_path / "cqa-snapshot.json")
    missing = tmp_path / "no" / "such.db"
    use_database(monkeypatch, missing)

    with pytest.raises(SystemExit) as caught:
        cli.snapshot([])

    assert caught.value.code == 1
    assert "no database" in capsys.readouterr().err.lower()
    assert not missing.exists()  # looking must not create it
    assert not (tmp_path / "cqa-snapshot.json").exists()


# --- the other streams' snapshot tables (final review I2) ----------------------------------
#
# A test-only package stands in for stream C: like `evaluator/translation.py` (imported by
# `evaluator/router.py`), its router module registers a migration and a snapshot table when it is
# imported. Each test starts as a new process would: nothing of it is imported or registered yet.

FAKE_STREAM = "cqa_fake_stream"
FAKE_STREAM_ROUTER = f'''
from fastapi import APIRouter

from app.db import register_migration
from app.snapshot import Table, register_snapshot_table

register_migration(
    "t_001_fake_stream",
    "CREATE TABLE t_fake_stream (conversation TEXT NOT NULL, lang TEXT NOT NULL, payload TEXT NOT NULL, "
    "created_at TEXT NOT NULL, PRIMARY KEY (conversation, lang));",
)
register_snapshot_table(
    Table("t_fake_stream", "t_fake_stream", ("conversation", "lang", "created_at"), "payload", "payload",
          list[str], order="conversation, lang")
)
router = APIRouter()
'''
FAKE_ROW = ("DEV:p1-ru-001", "ru", '["Добрый день"]', "2026-11-07T12:00:00+00:00")


class FakeStream:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app import db

        self._registries = (dict(snapshot_store._REGISTERED), dict(db._MIGRATIONS))
        monkeypatch.setattr(snapshot_store, "_REGISTERED", dict(self._registries[0]))
        monkeypatch.setattr(db, "_MIGRATIONS", dict(self._registries[1]))

    def new_process(self) -> None:
        """Forget the package and what it registered, as a fresh `cqa-serve` / `cqa-snapshot` would."""
        from app import db

        for name in (f"{FAKE_STREAM}.router", FAKE_STREAM):
            sys.modules.pop(name, None)
        snapshot_store._REGISTERED.clear()
        snapshot_store._REGISTERED.update(self._registries[0])
        db._MIGRATIONS.clear()
        db._MIGRATIONS.update(self._registries[1])

    def source_database(self, monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
        """A database with the six DEV dialogues and one row in the package's table."""
        importlib.import_module(f"{FAKE_STREAM}.router")
        use_database(monkeypatch, path)
        migrate()
        seed_into_db()
        load_dev_subset()
        conn = sqlite3.connect(path)
        try:
            conn.execute("INSERT INTO t_fake_stream VALUES (?, ?, ?, ?)", FAKE_ROW)
            conn.commit()
        finally:
            conn.close()


@pytest.fixture
def fake_stream(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[FakeStream]:
    from app import main

    package = tmp_path / "packages" / FAKE_STREAM
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "router.py").write_text(FAKE_STREAM_ROUTER, encoding="utf-8")
    monkeypatch.syspath_prepend(str(package.parent))
    monkeypatch.setattr(main, "OPTIONAL_ROUTER_PACKAGES", (FAKE_STREAM,))
    stream = FakeStream(monkeypatch)
    yield stream
    for name in (f"{FAKE_STREAM}.router", FAKE_STREAM):
        sys.modules.pop(name, None)


def fake_rows(path: Path) -> list[tuple]:
    conn = sqlite3.connect(path)
    try:
        return [tuple(row) for row in conn.execute("SELECT * FROM t_fake_stream ORDER BY conversation, lang")]
    finally:
        conn.close()


def test_serve_restores_a_table_another_stream_registers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, uvicorn_calls: list[dict], fake_stream: FakeStream
) -> None:
    fake_stream.source_database(monkeypatch, tmp_path / "source.db")
    path = tmp_path / "snapshot" / "cqa-snapshot.json"
    document = snapshot_store.export_snapshot(path)
    assert document["t_fake_stream"] == [
        {"conversation": FAKE_ROW[0], "lang": "ru", "created_at": FAKE_ROW[3], "payload": ["Добрый день"]}
    ]
    monkeypatch.setattr(snapshot_store, "SNAPSHOT", path)
    fake_stream.new_process()
    use_database(monkeypatch, tmp_path / "serve.db")

    cli.serve([])  # loads the other streams' modules before it migrates and restores

    assert len(store.list_conversations()) == 6
    assert fake_rows(tmp_path / "serve.db") == [FAKE_ROW]


def test_cqa_snapshot_exports_a_table_another_stream_registers(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fake_stream: FakeStream
) -> None:
    fake_stream.source_database(monkeypatch, tmp_path / "source.db")
    fake_stream.new_process()

    cli.snapshot([])

    written = json.loads(snapshot_store.SNAPSHOT.read_text(encoding="utf-8"))
    assert written["t_fake_stream"] == [
        {"conversation": FAKE_ROW[0], "lang": "ru", "created_at": FAKE_ROW[3], "payload": ["Добрый день"]}
    ]
