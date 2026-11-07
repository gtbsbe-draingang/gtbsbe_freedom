import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.errors import install_error_handlers
from evaluator import router as router_mod
from evaluator import translation
from evaluator.client import JudgmentFailed
from evaluator.testing import make_conv

KZ = make_conv([("client", "Сәлем"), ("operator", "Қайырлы күн")], language="KZ")
RU = make_conv([("client", "Привет")], language="RU")
URL = "/conversations/DEV:test/translation"


@pytest.fixture
def http(db, monkeypatch):
    convs = {"DEV:test": KZ, "DEV:ru": RU}
    monkeypatch.setattr(router_mod, "find_conversation", convs.get)
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(router_mod.router)
    return TestClient(app)


def test_unsupported_language(http):
    r = http.get(URL, params={"to": "en"})
    assert r.status_code == 422 and r.json()["error"] == "unsupported_language"


def test_not_found(http):
    r = http.get("/conversations/DEV:nope/translation")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_cached_returns_200_without_key(http):
    translation.save_translation("DEV:test", "ru", ["Привет", "Добрый день"])
    r = http.get(URL)
    assert r.status_code == 200
    assert r.json() == {
        "conversation": "DEV:test",
        "to": "ru",
        "messages": [{"message_index": 0, "text": "Привет"}, {"message_index": 1, "text": "Добрый день"}],
    }


def test_nothing_cached_no_key_is_409(http):
    r = http.get(URL)
    assert r.status_code == 409 and r.json()["error"] == "model_key_missing"


def test_russian_dialogue_returns_originals(http):
    r = http.get("/conversations/DEV:ru/translation")
    assert r.status_code == 200 and r.json()["messages"] == [{"message_index": 0, "text": "Привет"}]


def test_translates_stores_and_reuses(http, api_key, monkeypatch):
    from evaluator import client

    client.set_client(object())
    seen = []

    async def fake(conv, to="ru"):
        seen.append(to)
        return ["a", "b"], []

    monkeypatch.setattr(translation, "translate", fake)
    assert http.get(URL).json()["messages"][1]["text"] == "b"
    assert http.get(URL).status_code == 200
    assert seen == ["ru"]  # second call came from storage


def test_model_failure_is_502(http, api_key, monkeypatch):
    from evaluator import client

    client.set_client(object())

    async def boom(conv, to="ru"):
        raise JudgmentFailed("server_error", retryable=True)

    monkeypatch.setattr(translation, "translate", boom)
    r = http.get(URL)
    assert r.status_code == 502 and r.json()["error"] == "model_failed"
    assert translation.load_translation("DEV:test", "ru") is None


def test_uncached_path_runs_real_translate_and_logs(http, scripted, db):
    from app.db import connect

    scripted.script.append({"messages": [{"message_index": 0, "text": "Привет"}, {"message_index": 1, "text": "Добрый день"}]})
    r = http.get(URL)
    assert r.status_code == 200 and r.json()["messages"][1]["text"] == "Добрый день"
    assert http.get(URL).status_code == 200 and len(scripted.calls) == 1  # second answer from storage
    assert translation.load_translation("DEV:test", "ru") == ["Привет", "Добрый день"]
    conn = connect()
    try:
        assert [tuple(x) for x in conn.execute("SELECT conversation, purpose FROM c_llm_calls")] == [
            ("DEV:test", "translation")
        ]
    finally:
        conn.close()


def test_incomplete_translation_is_502_and_not_stored(http, scripted, db):
    bad = {"messages": [{"message_index": 0, "text": "Привет"}]}
    scripted.script.extend([bad, bad])
    r = http.get(URL)
    assert r.status_code == 502 and r.json()["error"] == "model_failed"
    assert translation.load_translation("DEV:test", "ru") is None
