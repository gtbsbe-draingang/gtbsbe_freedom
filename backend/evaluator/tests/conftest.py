"""Fixtures for evaluator tests. Helpers (factories, fakes) live in `evaluator.testing`.

Tests never call the Claude API. Every model call goes through `evaluator.client.call_structured`;
evaluator modules must call it as `client.call_structured(...)` (module attribute), so the
`scripted` fixture can replace it.
"""

import os
from collections.abc import Iterator

import pytest

from app.settings import Settings, get_settings
from evaluator import client
from evaluator.testing import FakeAsyncAnthropic, ScriptedCalls


@pytest.fixture(autouse=True)
def _isolated_settings(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    """Same isolation as backend/tests/conftest.py (this folder is outside it): no real key or
    .env reaches a test, and every test gets its own SQLite file."""
    names = {name.upper() for name in Settings.model_fields}
    for key in list(os.environ):
        if key.upper() in names:
            monkeypatch.delenv(key)
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    monkeypatch.setenv("DB_PATH", str(tmp_path / "cqa-test.db"))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _reset_client() -> Iterator[None]:
    client.set_client(None)
    yield
    client.set_client(None)


@pytest.fixture
def api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A fake key in settings (never a real one)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    get_settings.cache_clear()


@pytest.fixture
def scripted(monkeypatch: pytest.MonkeyPatch) -> ScriptedCalls:
    """Replace call_structured: `scripted.script.extend([VALID_C01_NO, ...])`, read `scripted.calls`.
    Also injects a dummy client so get_client() does not raise ModelKeyMissing."""
    calls = ScriptedCalls(script=[])
    monkeypatch.setattr(client, "call_structured", calls)
    client.set_client(object())
    return calls


@pytest.fixture
def fake_anthropic(api_key: None) -> FakeAsyncAnthropic:
    """Replace the SDK client (for testing call_structured itself, S3)."""
    fake = FakeAsyncAnthropic()
    client.set_client(fake)
    return fake


@pytest.fixture
def db() -> None:
    """Apply every migration (B's and C's) to the per-test SQLite file."""
    import evaluator.cost  # noqa: F401  registers c_001_llm_calls
    import evaluator.translation  # noqa: F401  registers c_002_translations
    from app.db import migrate

    migrate()
