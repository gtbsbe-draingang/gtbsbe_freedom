"""Shared test fixtures for every stream (app, evaluator, quality, audio).

Isolation rules, all enforced by the autouse fixture below:

* A developer's shell may export ANTHROPIC_API_KEY / ORGANIZER_API_URL and backend/.env may
  hold real values. No test may see them, and no test may reach a network because of them.
* Settings never read a .env file during tests.
* Every test gets its own SQLite file under tmp_path.
* The get_settings() cache is cleared before and after each test.
"""

import os
from collections.abc import Callable, Iterator
from contextlib import ExitStack

import pytest
from fastapi.testclient import TestClient

from app.settings import Settings, get_settings


def _settings_env_names() -> set[str]:
    # Derived from the fields so a setting added later is isolated automatically.
    return {name.upper() for name in Settings.model_fields}


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch: pytest.MonkeyPatch, tmp_path) -> Iterator[None]:
    names = _settings_env_names()
    # pydantic-settings matches variable names case-insensitively, so remove every spelling.
    for key in list(os.environ):
        if key.upper() in names:
            monkeypatch.delenv(key)
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    monkeypatch.setenv("DB_PATH", str(tmp_path / "cqa-test.db"))
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def make_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., TestClient]]:
    """Factory: make_client(ANTHROPIC_API_KEY="x", CORS_ORIGINS='["https://a"]') builds the
    app with those environment variables and returns a started TestClient (lifespan ran)."""
    from app.main import create_app

    stack = ExitStack()

    def factory(**env: str) -> TestClient:
        for key, value in env.items():
            monkeypatch.setenv(key, value)
        get_settings.cache_clear()
        return stack.enter_context(TestClient(create_app()))

    with stack:
        yield factory


@pytest.fixture
def client(make_client: Callable[..., TestClient]) -> TestClient:
    return make_client()
