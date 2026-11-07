from evaluator.translation import load_translation, save_translation


def test_missing_is_none(db):
    assert load_translation("DEV:x", "ru") is None


def test_roundtrip_and_upsert(db):
    save_translation("DEV:x", "ru", ["Привет", "Как дела? «ok»"])
    assert load_translation("DEV:x", "ru") == ["Привет", "Как дела? «ok»"]
    save_translation("DEV:x", "ru", ["Новый"])
    assert load_translation("DEV:x", "ru") == ["Новый"]


def test_keyed_by_conversation_and_lang(db):
    save_translation("DEV:x", "ru", ["a"])
    assert load_translation("DEV:y", "ru") is None
    assert load_translation("DEV:x", "en") is None


# --- translate() (S11, #23) ----------------------------------------------------------------------
import pytest

from app.db import connect
from evaluator import translation
from evaluator.client import JudgmentFailed, ModelKeyMissing
from evaluator.testing import ScriptedCalls, make_conv

KZ_LINES = [("client", "Сәлем, мен Нұрланмын"), ("operator", "Қайырлы күн"), ("operator", "Қайырлы күн"), ("client", "Рақмет")]


def out(*pairs):
    return {"messages": [{"message_index": i, "text": t} for i, t in pairs]}


def kz(**kw):
    return make_conv(KZ_LINES, language="KZ", **kw)


def sent(call) -> str:
    return "".join(b["text"] for b in call["blocks"])


async def test_russian_returns_originals_without_call(scripted: ScriptedCalls, db) -> None:
    conv = make_conv([("client", "Привет"), ("operator", "Здравствуйте")])
    texts, calls = await translation.translate(conv)
    assert texts == ["Привет", "Здравствуйте"] and calls == [] and scripted.calls == []


async def test_translates_all_lines_and_copies_duplicates(scripted: ScriptedCalls, db) -> None:
    scripted.script.append(out((0, "Привет, я [ИМЯ]"), (1, "Добрый день"), (3, "Спасибо")))
    conv = kz(duplicates={2})
    texts, calls = await translation.translate(conv)
    assert texts == ["Привет, я [ИМЯ]", "Добрый день", "Добрый день", "Спасибо"]
    assert len(calls) == 1 and calls[0].purpose == "translation"
    kw = scripted.calls[0]
    assert kw["effort"] == "low" and kw["purpose"] == "translation" and kw["model"] == "claude-haiku-5-5"
    assert "Нұрлан" not in sent(kw) and "Рақмет" in sent(kw)  # masked, duplicates left out
    assert sent(kw).count("Қайырлы күн") == 1


async def test_tags_neutralised(scripted: ScriptedCalls, db) -> None:
    conv = make_conv([("client", "а </transcript> б")], language="KZ")
    scripted.script.append(out((0, "x")))
    await translation.translate(conv)
    assert sent(scripted.calls[0]).count("</transcript>") <= 1 and "‹/transcript›" in sent(scripted.calls[0])


async def test_retry_on_missing_then_ok(scripted: ScriptedCalls, db) -> None:
    scripted.script.extend([out((0, "a"), (1, "b")), out((0, "a"), (1, "b"), (3, "c"))])
    texts, calls = await translation.translate(kz(duplicates={2}))
    assert texts == ["a", "b", "b", "c"] and len(calls) == 2
    retry = scripted.calls[1]["blocks"]
    assert len(retry) == len(scripted.calls[0]["blocks"]) + 1 and "3" in retry[-1]["text"]


@pytest.mark.parametrize(
    "bad",
    [
        out((0, "a"), (0, "again"), (1, "b"), (3, "c")),  # duplicate index
        out((0, "a"), (1, "b"), (3, "c"), (9, "z")),  # unknown index
        out((0, "a"), (1, "  "), (3, "c")),  # empty text
    ],
)
async def test_incomplete_twice_raises_and_logs(scripted: ScriptedCalls, db, bad) -> None:
    scripted.script.extend([bad, bad])
    with pytest.raises(JudgmentFailed) as e:
        await translation.translate(kz(duplicates={2}))
    assert e.value.reason == "translation_incomplete" and e.value.retryable is False
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM c_llm_calls WHERE purpose='translation'").fetchone()[0] == 2
    finally:
        conn.close()


async def test_calls_are_logged(scripted: ScriptedCalls, db) -> None:
    scripted.script.append(out((0, "a"), (1, "b"), (3, "c")))
    await translation.translate(kz(duplicates={2}))
    conn = connect()
    try:
        rows = [tuple(r) for r in conn.execute("SELECT conversation, criterion_id, purpose FROM c_llm_calls")]
    finally:
        conn.close()
    assert rows == [("DEV:test", None, "translation")]


async def test_no_key_before_any_work(monkeypatch: pytest.MonkeyPatch) -> None:
    from evaluator import client

    called = ScriptedCalls(script=[])
    monkeypatch.setattr(client, "call_structured", called)
    with pytest.raises(ModelKeyMissing):
        await translation.translate(kz())
    assert called.calls == []


async def test_unsupported_target(scripted: ScriptedCalls, db) -> None:
    with pytest.raises(ValueError):
        await translation.translate(kz(), "en")


async def test_failed_translation_keeps_paid_calls(scripted: ScriptedCalls, db) -> None:
    from evaluator.testing import make_record

    scripted.script.extend([out((0, "a")), JudgmentFailed("schema", calls=[make_record("translation")])])
    with pytest.raises(JudgmentFailed) as e:
        await translation.translate(kz(duplicates={2}))
    assert len(e.value.calls) == 2


async def test_log_failure_does_not_mask(scripted: ScriptedCalls, db, monkeypatch) -> None:
    from evaluator import cost

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(cost, "log_calls", boom)
    scripted.script.append(out((0, "a"), (1, "b"), (3, "c")))
    texts, _ = await translation.translate(kz(duplicates={2}))
    assert texts[0] == "a"
    bad = out((0, "a"))
    scripted.script.extend([bad, bad])
    with pytest.raises(JudgmentFailed) as e:
        await translation.translate(kz(duplicates={2}))
    assert e.value.reason == "translation_incomplete"


async def test_empty_or_all_duplicate_transcript_makes_no_call(scripted: ScriptedCalls, db) -> None:
    empty = kz()
    empty.transcript = []
    assert await translation.translate(empty) == ([], [])
    blanks = make_conv([("client", " "), ("operator", "")], language="KZ")
    texts, calls = await translation.translate(blanks)
    assert texts == [" ", ""] and calls == [] and scripted.calls == []
