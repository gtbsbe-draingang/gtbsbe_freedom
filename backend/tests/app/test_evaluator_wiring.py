"""The evaluator's routes through the assembled app (create_app), with the real conversation store."""

from app.settings import get_settings
from app.store import upsert_conversation
from evaluator import translation
from evaluator.testing import make_conv


def test_translation_finds_a_stored_conversation(client):
    conv = make_conv([("client", "Сәлем"), ("operator", "Қайырлы күн")], language="KZ")
    upsert_conversation(conv, None)
    translation.save_translation(conv.id, "ru", ["Привет", "Добрый день"])  # cached: no model key needed
    r = client.get(f"{get_settings().base_path}/conversations/{conv.id}/translation", params={"to": "ru"})
    assert r.status_code == 200, r.text
    assert [m["text"] for m in r.json()["messages"]] == ["Привет", "Добрый день"]


def test_translation_of_an_unknown_conversation_is_404(client):
    r = client.get(f"{get_settings().base_path}/conversations/DEV:nope/translation")
    assert r.status_code == 404 and r.json()["error"] == "not_found"
