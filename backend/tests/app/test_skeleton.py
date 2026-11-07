import io
import json
import logging
import mimetypes
import re
import sqlite3
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import BaseModel

from app import db, main
from app.errors import ApiError
from app.main import create_app
from app.settings import Settings, get_settings

MakeClient = Callable[..., TestClient]


# --- /config -----------------------------------------------------------------------------


def test_config_reports_no_key(client: TestClient) -> None:
    r = client.get("/api/config")
    assert r.status_code == 200
    body = r.json()
    assert body["model_key_configured"] is False
    assert "claude-haiku-5-5" in body["prices"]


def test_config_reports_key(make_client: MakeClient) -> None:
    client = make_client(ANTHROPIC_API_KEY="sk-ant-test-SECRET-value")
    r = client.get("/api/config")
    assert r.status_code == 200
    assert r.json()["model_key_configured"] is True
    assert "SECRET" not in r.text
    assert "sk-ant" not in r.text


@pytest.mark.parametrize("value", ["", "   "])
def test_config_blank_key_is_not_configured(make_client: MakeClient, value: str) -> None:
    client = make_client(ANTHROPIC_API_KEY=value)
    assert client.get("/api/config").json()["model_key_configured"] is False


def test_config_shape(client: TestClient) -> None:
    body = client.get("/api/config").json()
    assert set(body) == {"models", "prices", "model_key_configured", "default_checklist"}
    assert body["models"] == list(get_settings().prices)
    assert body["models"] == ["claude-haiku-5-5", "claude-sonnet-5-5"]
    # Prices go out as JSON numbers, never strings.
    assert body["prices"]["claude-haiku-5-5"] == {"input": 0.10, "output": 0.50}
    assert body["prices"]["claude-sonnet-5-5"] == {"input": 2.0, "output": 10.0}
    for per_model in body["prices"].values():
        assert all(isinstance(v, (int, float)) for v in per_model.values())
    assert body["default_checklist"] == {"checklist_id": "official-chat", "version": 1}


def test_config_follows_base_path(make_client: MakeClient) -> None:
    client = make_client(BASE_PATH="/v2")
    assert client.get("/v2/config").status_code == 200
    assert client.get("/api/config").status_code == 404


def test_base_path_is_normalised(monkeypatch: pytest.MonkeyPatch) -> None:
    for raw, expected in [("v2/", "/v2"), ("/v2/", "/v2"), ("/a/b", "/a/b"), ("/", "")]:
        monkeypatch.setenv("BASE_PATH", raw)
        assert Settings().base_path == expected


def test_openapi_json_lives_under_base_path_and_docs_ui_is_off(client: TestClient) -> None:
    # Swagger/ReDoc pages load scripts from a CDN, which the strict CSP would block.
    assert client.get("/api/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 404
    assert client.get("/redoc").status_code == 404


# --- settings isolation ------------------------------------------------------------------


def test_tests_do_not_read_dotenv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / ".env").write_text("ANTHROPIC_API_KEY=from-dotenv\nORGANIZER_API_URL=https://x\n")
    monkeypatch.chdir(tmp_path)
    get_settings.cache_clear()
    s = get_settings()
    assert s.anthropic_api_key is None
    assert s.organizer_api_url is None
    # The guard is real: with the isolation lifted, the same .env is picked up.
    monkeypatch.setitem(Settings.model_config, "env_file", ".env")
    assert Settings().anthropic_api_key.get_secret_value() == "from-dotenv"


def test_settings_defaults(client: TestClient) -> None:
    s = get_settings()
    assert s.base_path == "/api"
    assert s.cors_origins == []
    assert s.frame_ancestors == ["'self'"]
    assert s.default_model == "claude-haiku-5-5"
    assert s.max_parallel_calls == 8
    assert s.web_dist is None
    assert s.db_path.name == "cqa-test.db"


def test_settings_cache_and_empty_values(monkeypatch: pytest.MonkeyPatch) -> None:
    assert get_settings() is get_settings()
    monkeypatch.setenv("CORS_ORIGINS", "")  # an empty variable means "unset", not a JSON error
    monkeypatch.setenv("ORGANIZER_API_URL", "")
    s = Settings()
    assert s.cors_origins == []
    assert s.organizer_api_url is None


def test_settings_reject_unsafe_frame_ancestors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FRAME_ANCESTORS", '["https://a.example; script-src *"]')
    with pytest.raises(ValueError):
        Settings()


# --- error shape -------------------------------------------------------------------------


def test_unknown_route_error_shape(client: TestClient) -> None:
    r = client.get("/api/nope")
    assert r.status_code == 404
    body = r.json()
    assert set(body) == {"error", "message"}
    assert body["error"] == "not_found"
    assert isinstance(body["message"], str) and body["message"]


def test_validation_error_shape(client: TestClient) -> None:
    class Body(BaseModel):
        name: str
        count: int

    def typed(body: Body) -> dict:
        return {"ok": True}

    client.app.add_api_route("/api/typed", typed, methods=["POST"])
    r = client.post("/api/typed", json={"name": 5, "count": "many"})
    assert r.status_code == 422
    body = r.json()
    assert set(body) == {"error", "message"}
    assert body["error"] == "invalid_request"
    assert "count" in body["message"]  # says which field is wrong


def test_validation_error_with_garbage_body(client: TestClient) -> None:
    class Body(BaseModel):
        name: str

    def typed(body: Body) -> dict:
        return {"ok": True}

    client.app.add_api_route("/api/typed", typed, methods=["POST"])
    r = client.post("/api/typed", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_request"


def test_other_http_status_uses_http_code_and_keeps_headers(client: TestClient) -> None:
    def post_only() -> dict:
        return {}

    client.app.add_api_route("/api/post-only", post_only, methods=["POST"])
    r = client.get("/api/post-only")
    # The API route answers (not the static UI), so Allow lists the API route's methods.
    assert r.status_code == 405
    assert r.json()["error"] == "http_405"
    assert r.headers["allow"] == "POST"


def test_api_error_is_mapped(client: TestClient) -> None:
    def boom() -> None:
        raise ApiError(409, "model_key_missing", "No model key is configured.")

    client.app.add_api_route("/api/boom", boom, methods=["GET"])
    r = client.get("/api/boom")
    assert r.status_code == 409
    assert r.json() == {"error": "model_key_missing", "message": "No model key is configured."}


def test_unhandled_exception_is_500_internal_error(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    def explode() -> None:
        raise RuntimeError("secret-detail postgres://user:pw@host/db")

    client.app.add_api_route("/api/explode", explode, methods=["GET"])
    # TestClient re-raises server exceptions by default; a real client only sees the response.
    quiet = TestClient(client.app, raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="app.errors"):
        r = quiet.get("/api/explode")
    assert r.status_code == 500
    assert r.json() == {"error": "internal_error", "message": "Internal server error."}
    assert "secret-detail" not in r.text  # the exception text is never echoed
    logged = [rec for rec in caplog.records if rec.name == "app.errors"]
    assert len(logged) == 1
    assert logged[0].exc_info is not None and logged[0].exc_info[0] is RuntimeError
    assert "secret-detail" in "".join(logging.Formatter().format(rec) for rec in logged)


SIGNED = "https://media.example.invalid/calls/a.mp3?sv=2024&sig=FAKESIGNATURE"


def test_the_unhandled_exception_log_never_carries_a_signed_url(
    client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    def explode() -> None:
        raise RuntimeError(f"download failed for {SIGNED} (timeout)")

    client.app.add_api_route("/api/explode-signed", explode, methods=["GET"])
    quiet = TestClient(client.app, raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="app.errors"):
        r = quiet.get("/api/explode-signed")
    assert r.status_code == 500
    logged = [rec for rec in caplog.records if rec.name == "app.errors"]
    formatted = "".join(logging.Formatter().format(rec) for rec in logged)
    assert "Traceback" in formatted
    assert "RuntimeError: download failed for <redacted> (timeout)" in formatted  # the rest is kept
    assert "sig=FAKE" not in formatted and "media.example.invalid" not in formatted
    assert "sig=FAKE" not in caplog.text


@pytest.mark.parametrize("name", ["app.errors", "uvicorn.error"])
def test_exception_text_is_redacted_on_the_error_loggers(name: str) -> None:
    """uvicorn logs the same exception again on `uvicorn.error` ("Exception in ASGI application"),
    through its own formatter."""
    from uvicorn.logging import DefaultFormatter

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(DefaultFormatter("%(levelprefix)s %(message)s", use_colors=False))
    logger = logging.getLogger(name)
    logger.addHandler(handler)
    try:
        try:
            raise RuntimeError(f"download failed for {SIGNED}")
        except RuntimeError as exc:
            logger.error("Exception in ASGI application\n", exc_info=exc)
            logger.error("while fetching %s", SIGNED, stack_info=True)
    finally:
        logger.removeHandler(handler)
    output = stream.getvalue()
    assert "Exception in ASGI application" in output and "RuntimeError: download failed for <redacted>" in output
    assert "while fetching <redacted>" in output and "Stack (most recent call last)" in output
    assert "sig=FAKE" not in output and "FAKESIGNATURE" not in output


# --- SQLite ------------------------------------------------------------------------------


@pytest.fixture
def clean_migrations(monkeypatch: pytest.MonkeyPatch) -> None:
    """Registered migrations are process-global; give each test a private copy."""
    monkeypatch.setattr(db, "_MIGRATIONS", dict(db._MIGRATIONS))


def test_connect_pragmas() -> None:
    conn = db.connect()
    try:
        assert conn.row_factory is sqlite3.Row
        assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert conn.execute("PRAGMA journal_mode").fetchone()[0].lower() == "wal"
    finally:
        conn.close()


def test_connect_creates_parent_directory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DB_PATH", str(tmp_path / "nested" / "dir" / "x.db"))
    get_settings.cache_clear()
    db.connect().close()
    assert (tmp_path / "nested" / "dir" / "x.db").exists()


def test_migrations_apply_once(clean_migrations: None) -> None:
    db.register_migration("zz_test", "CREATE TABLE t (id INTEGER PRIMARY KEY)")
    db.migrate()
    db.migrate()
    conn = db.connect()
    try:
        assert conn.execute("SELECT name FROM sqlite_master WHERE name = 't'").fetchone()
        rows = conn.execute(
            "SELECT name, applied_at FROM schema_migrations WHERE name = 'zz_test'"
        ).fetchall()
        assert len(rows) == 1
        assert rows[0]["applied_at"]
    finally:
        conn.close()


def test_migrations_apply_in_name_order(clean_migrations: None) -> None:
    db.register_migration("zz_b", "CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id))")
    db.register_migration("zz_a", "CREATE TABLE a (id INTEGER PRIMARY KEY)")
    db.migrate()
    conn = db.connect()
    try:
        names = [r["name"] for r in conn.execute("SELECT name FROM schema_migrations ORDER BY rowid")]
        assert [n for n in names if n.startswith("zz_")] == ["zz_a", "zz_b"]
    finally:
        conn.close()


def test_migration_registered_later_is_applied_by_next_migrate(clean_migrations: None) -> None:
    db.migrate()
    db.register_migration("zz_late", "CREATE TABLE late (id INTEGER)")
    db.migrate()
    conn = db.connect()
    try:
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'late'").fetchone()
    finally:
        conn.close()


def test_failed_migration_rolls_back(clean_migrations: None) -> None:
    db.register_migration("zz_bad", "CREATE TABLE half (id INTEGER); INSERT INTO missing_table VALUES (1);")
    with pytest.raises(sqlite3.OperationalError):
        db.migrate()
    conn = db.connect()
    try:
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'half'").fetchone() is None
        assert conn.execute("SELECT 1 FROM schema_migrations WHERE name = 'zz_bad'").fetchone() is None
    finally:
        conn.close()


def test_register_migration_is_idempotent_but_rejects_changed_sql(clean_migrations: None) -> None:
    db.register_migration("zz_dup", "CREATE TABLE d (id INTEGER)")
    db.register_migration("zz_dup", "CREATE TABLE d (id INTEGER)")  # module imported twice: fine
    with pytest.raises(ValueError):
        db.register_migration("zz_dup", "CREATE TABLE d (id INTEGER, extra TEXT)")


def test_app_startup_runs_migrations(clean_migrations: None, make_client: MakeClient) -> None:
    db.register_migration("zz_startup", "CREATE TABLE startup_t (id INTEGER)")
    make_client()  # entering the TestClient runs the lifespan
    conn = db.connect()
    try:
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE name = 'startup_t'").fetchone()
    finally:
        conn.close()


# --- static UI and CSP -------------------------------------------------------------------


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    d = tmp_path / "web" / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<!doctype html><title>CQA</title><div id=app></div>")
    (d / "assets" / "app.js").write_text("console.log(1)")
    return d


def test_index_has_strict_csp(make_client: MakeClient, dist: Path) -> None:
    client = make_client(WEB_DIST=str(dist))
    r = client.get("/")
    assert r.status_code == 200
    csp = r.headers["content-security-policy"]
    assert "default-src 'self'" in csp
    assert "frame-ancestors 'self'" in csp
    assert "unsafe-inline" not in csp
    assert "unsafe-eval" not in csp
    directives = {d.split()[0]: d.split()[1:] for d in csp.split(";") if d.strip()}
    assert directives["script-src"] == ["'self'"]
    assert directives["style-src"] == ["'self'"]
    assert directives["img-src"] == ["'self'", "data:"]
    assert directives["font-src"] == ["'self'", "data:"]
    assert directives["media-src"] == ["'self'"]
    assert directives["connect-src"] == ["'self'"]
    assert directives["object-src"] == ["'none'"]
    assert directives["base-uri"] == ["'self'"]
    assert directives["form-action"] == ["'self'"]


def test_csp_only_on_html_and_assets_are_served(make_client: MakeClient, dist: Path) -> None:
    client = make_client(WEB_DIST=str(dist))
    js = client.get("/assets/app.js")
    assert js.status_code == 200
    assert "content-security-policy" not in js.headers
    assert "content-security-policy" not in client.get("/api/config").headers
    # An unknown path under the static mount is still a JSON error.
    r = client.get("/assets/missing.js")
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_the_ui_files_get_standard_content_types_whatever_the_system_says(
    make_client: MakeClient, dist: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """StaticFiles asks `mimetypes`, which on Windows reads the registry: a misregistered type there
    must not reach the browser (a stylesheet sent as text/plain leaves the page unstyled)."""
    (dist / "assets" / "app.css").write_text("a{}")
    (dist / "assets" / "icon.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>")
    broken = mimetypes.MimeTypes()  # what a misconfigured registry can leave behind
    for extension in (".js", ".css", ".svg"):
        broken.add_type("text/plain", extension)
    monkeypatch.setattr(mimetypes, "_db", broken)  # restored after the test

    client = make_client(WEB_DIST=str(dist))

    assert client.get("/assets/app.js").headers["content-type"].startswith("text/javascript")
    assert client.get("/assets/app.css").headers["content-type"].startswith("text/css")
    assert client.get("/assets/icon.svg").headers["content-type"].startswith("image/svg+xml")


def test_frame_ancestors_follow_settings(make_client: MakeClient, dist: Path) -> None:
    client = make_client(
        WEB_DIST=str(dist),
        FRAME_ANCESTORS='["\'self\'", "https://*.crm4.dynamics.com"]',
    )
    csp = client.get("/").headers["content-security-policy"]
    assert "frame-ancestors 'self' https://*.crm4.dynamics.com" in csp


def test_empty_frame_ancestors_means_none(make_client: MakeClient, dist: Path) -> None:
    client = make_client(WEB_DIST=str(dist), FRAME_ANCESTORS="[]")
    assert "frame-ancestors 'none'" in client.get("/").headers["content-security-policy"]


def test_missing_ui_directory_gives_plain_text_note(make_client: MakeClient, tmp_path: Path) -> None:
    client = make_client(WEB_DIST=str(tmp_path / "not-built"))
    r = client.get("/")
    assert "UI not built" in r.text
    assert r.headers["content-type"].startswith("text/plain")
    # API errors stay JSON even without a UI.
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"
    assert client.get("/api/config").status_code == 200


def test_post_to_unknown_api_path_is_404_with_ui_built(make_client: MakeClient, dist: Path) -> None:
    client = make_client(WEB_DIST=str(dist))
    r = client.post("/api/nope", json={})
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"
    assert "allow" not in r.headers


def test_post_to_unknown_api_path_is_404_without_ui(make_client: MakeClient, tmp_path: Path) -> None:
    client = make_client(WEB_DIST=str(tmp_path / "not-built"))
    r = client.post("/api/nope", json={})
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_static_ui_answers_404_to_non_read_methods(make_client: MakeClient, dist: Path, method: str) -> None:
    client = make_client(WEB_DIST=str(dist))
    for path in ("/", "/assets/app.js", "/nope"):
        r = client.request(method, path)
        assert r.status_code == 404, (method, path)
        assert r.json()["error"] == "not_found"


def test_static_ui_never_serves_files_under_base_path(make_client: MakeClient, dist: Path) -> None:
    (dist / "api").mkdir()
    (dist / "api" / "leak.txt").write_text("static file inside the API prefix")
    client = make_client(WEB_DIST=str(dist))
    r = client.get("/api/leak.txt")
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"
    assert client.get("/api").status_code == 404
    # A path that merely starts with the same letters is not under the prefix.
    (dist / "apiary.txt").write_text("hello")
    assert client.get("/apiary.txt").text == "hello"


def test_static_ui_serves_everything_when_there_is_no_base_path(make_client: MakeClient, dist: Path) -> None:
    client = make_client(WEB_DIST=str(dist), BASE_PATH="/")
    assert client.get("/").status_code == 200
    assert client.get("/assets/app.js").status_code == 200
    assert client.get("/config").status_code == 200  # API routes are mounted at the root


def test_default_ui_directory_is_repo_web_dist() -> None:
    expected = Path(main.__file__).resolve().parents[2] / "web" / "dist"
    assert main.default_web_dist() == expected


# --- CORS --------------------------------------------------------------------------------


def preflight(client: TestClient, origin: str):
    return client.options(
        "/api/config",
        headers={"Origin": origin, "Access-Control-Request-Method": "GET"},
    )


def test_cors_wildcard_origin(make_client: MakeClient) -> None:
    client = make_client(CORS_ORIGINS=json.dumps(["https://*.crm*.dynamics.com"]))
    ok = preflight(client, "https://org1.crm4.dynamics.com")
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == "https://org1.crm4.dynamics.com"
    bad = preflight(client, "https://evil.com")
    assert bad.status_code == 400
    assert "access-control-allow-origin" not in bad.headers
    # A simple request gets the header too, a disallowed one does not.
    r = client.get("/api/config", headers={"Origin": "https://org1.crm4.dynamics.com"})
    assert r.headers["access-control-allow-origin"] == "https://org1.crm4.dynamics.com"
    r = client.get("/api/config", headers={"Origin": "https://evil.com"})
    assert "access-control-allow-origin" not in r.headers


def test_cors_exact_origin(make_client: MakeClient) -> None:
    client = make_client(CORS_ORIGINS=json.dumps(["http://localhost:5173"]))
    assert preflight(client, "http://localhost:5173").status_code == 200
    assert preflight(client, "http://localhost:5174").status_code == 400


def test_cors_off_by_default(client: TestClient) -> None:
    r = client.get("/api/config", headers={"Origin": "https://org1.crm4.dynamics.com"})
    assert "access-control-allow-origin" not in r.headers


def test_cors_split_builds_escaped_regex() -> None:
    exact, regex = main.split_cors_origins(["http://localhost:5173", "https://*.crm*.dynamics.com"])
    assert exact == ["http://localhost:5173"]
    assert regex is not None
    pattern = re.compile(regex)
    assert pattern.fullmatch("https://org1.crm4.dynamics.com")
    assert pattern.fullmatch("https://org-1.crm.dynamics.com")
    assert not pattern.fullmatch("https://org1.crm4.dynamicsXcom")  # dots are literal
    assert not pattern.fullmatch("https://a.b.crm4.dynamics.com")  # `*` does not cross dots
    assert not pattern.fullmatch("https://evil.com/https://org1.crm4.dynamics.com")
    assert not pattern.fullmatch("http://localhost:5173")  # exact entries are not in the regex
    assert main.split_cors_origins(["http://a"]) == (["http://a"], None)
    assert main.split_cors_origins([]) == ([], None)


# --- optional routers of other streams ---------------------------------------------------


@pytest.fixture
def fake_packages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., str]]:
    """Writes top-level packages into a tmp dir that is put on sys.path."""
    pkgs = tmp_path / "pkgs"
    pkgs.mkdir()
    monkeypatch.syspath_prepend(str(pkgs))
    created: list[str] = []

    def make(name: str, router_src: str | None = None) -> str:
        pkg = pkgs / name
        pkg.mkdir()
        (pkg / "__init__.py").write_text("")
        if router_src is not None:
            (pkg / "router.py").write_text(router_src)
        created.append(name)
        return name

    yield make
    for key in list(sys.modules):
        if any(key == n or key.startswith(n + ".") for n in created):
            del sys.modules[key]


ROUTER_SRC = (
    "from fastapi import APIRouter\n"
    "router = APIRouter()\n"
    "@router.get('/ping')\n"
    "def ping():\n"
    "    return {'pong': True}\n"
)


def test_default_optional_packages() -> None:
    assert main.OPTIONAL_ROUTER_PACKAGES == ("evaluator", "audio", "quality")


def test_missing_package_is_skipped(monkeypatch: pytest.MonkeyPatch, make_client: MakeClient) -> None:
    monkeypatch.setattr(main, "OPTIONAL_ROUTER_PACKAGES", ("cqa_no_such_package",))
    client = make_client()
    assert client.get("/api/config").status_code == 200


def test_package_without_router_module_is_skipped(
    monkeypatch: pytest.MonkeyPatch, make_client: MakeClient, fake_packages
) -> None:
    name = fake_packages("cqa_fake_norouter")
    monkeypatch.setattr(main, "OPTIONAL_ROUTER_PACKAGES", (name,))
    client = make_client()
    assert client.get("/api/config").status_code == 200
    assert client.get("/api/ping").status_code == 404


def test_router_is_mounted_under_base_path(
    monkeypatch: pytest.MonkeyPatch, make_client: MakeClient, fake_packages
) -> None:
    name = fake_packages("cqa_fake_withrouter", ROUTER_SRC)
    monkeypatch.setattr(main, "OPTIONAL_ROUTER_PACKAGES", (name,))
    client = make_client()
    assert client.get("/api/ping").json() == {"pong": True}
    assert client.get("/ping").status_code == 404


def test_router_that_fails_on_import_raises(
    monkeypatch: pytest.MonkeyPatch, fake_packages
) -> None:
    name = fake_packages("cqa_fake_broken", "raise RuntimeError('router exploded')\n")
    monkeypatch.setattr(main, "OPTIONAL_ROUTER_PACKAGES", (name,))
    with pytest.raises(RuntimeError, match="router exploded"):
        create_app()
