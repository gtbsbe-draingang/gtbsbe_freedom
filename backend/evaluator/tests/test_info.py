import asyncio
import json

import pytest

from evaluator import info
from evaluator.client import JudgmentFailed, ModelKeyMissing
from evaluator.schemas import InfoOutput, json_schema_for
from evaluator.testing import make_conv

OK = {"topic": "Вход в личный кабинет", "mood_start": "спокойный", "mood_end": "довольный", "outcome": "resolved"}
CONV = make_conv([("client", "Позвоните мне на +77011234567"), ("operator", "Хорошо")])


def run(conv=CONV):
    return asyncio.run(info.dialog_info(conv))


def test_maps_output_and_logs(scripted, db):
    scripted.script.append(OK)
    result, calls = run()
    assert result.topic == OK["topic"] and result.outcome == "resolved" and result.mood_end == "довольный"
    assert len(calls) == 1 and calls[0].purpose == "info"
    from app.db import connect

    conn = connect()
    try:
        row = conn.execute("SELECT conversation, criterion_id, purpose FROM c_llm_calls").fetchone()
    finally:
        conn.close()
    assert tuple(row) == ("DEV:test", None, "info")


def test_call_shape_effort_low_default_model_masked(scripted, db):
    scripted.script.append(OK)
    run()
    kw = scripted.calls[0]
    assert kw["effort"] == "low" and kw["purpose"] == "info" and kw["output_type"] is InfoOutput
    assert kw["model"] == "claude-haiku-5-5"
    sent = json.dumps(kw["blocks"], ensure_ascii=False)
    assert "+7701" not in sent and "[ТЕЛЕФОН]" in sent and "[0]" in sent
    assert "<transcript>" in sent


def test_schema_has_no_max_length():
    assert "maxLength" not in json.dumps(json_schema_for(InfoOutput))


def test_no_key_raises_before_call():
    with pytest.raises(ModelKeyMissing):
        run()


def test_failure_propagates(scripted, db):
    scripted.script.append(JudgmentFailed("server_error", retryable=True))
    with pytest.raises(JudgmentFailed):
        run()


def test_long_topic_is_truncated_not_failed(scripted, db):
    scripted.script.append({**OK, "topic": "очень длинная тема " * 10})
    result, _ = run()
    assert 0 < len(result.topic) <= 80


async def test_failed_paid_call_is_logged(api_key, scripted, db):
    """A paid info call that fails (e.g. max_tokens) still lands in c_llm_calls."""
    import pytest

    from app.db import connect
    from evaluator import client
    from evaluator.info import dialog_info
    from evaluator.testing import make_record

    scripted.script.append(client.JudgmentFailed("max_tokens", calls=[make_record(purpose="info")]))
    with pytest.raises(client.JudgmentFailed):
        await dialog_info(CONV)
    conn = connect()
    try:
        rows = conn.execute("SELECT purpose FROM c_llm_calls").fetchall()
    finally:
        conn.close()
    assert [r["purpose"] for r in rows] == ["info"]
