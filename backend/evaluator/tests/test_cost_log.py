from decimal import Decimal

from app.db import connect
from evaluator.cost import log_calls, total_cost
from evaluator.testing import make_record


def _rows():
    conn = connect()
    try:
        return [dict(r) for r in conn.execute("SELECT * FROM c_llm_calls ORDER BY id")]
    finally:
        conn.close()


def test_total_cost_exact_sum_and_empty():
    recs = [make_record(cost="0.000100"), make_record(cost="0.000200"), make_record(cost="0.1")]
    assert total_cost(recs) == Decimal("0.100300")
    assert str(total_cost([])) == "0.000000"


def test_log_calls_writes_rows(db):
    recs = [make_record("criterion", cost="0.000123", reuse_key="k" * 64), make_record("info")]
    log_calls(recs, conversation="DEV:test", criterion_id="c01")
    rows = _rows()
    assert len(rows) == 2
    r = rows[0]
    assert (r["conversation"], r["criterion_id"], r["purpose"]) == ("DEV:test", "c01", "criterion")
    assert r["cost_usd"] == "0.000123" and r["reuse_key"] == "k" * 64
    assert (r["model"], r["input_tokens"], r["output_tokens"], r["latency_ms"]) == ("claude-haiku-5-5", 2000, 600, 100)
    assert r["created_at"]
    assert rows[1]["reuse_key"] is None


def test_log_calls_nullable_ids_and_empty(db):
    log_calls([], conversation=None, criterion_id=None)
    assert _rows() == []
    log_calls([make_record("info")], conversation=None, criterion_id=None)
    assert _rows()[0]["conversation"] is None


def test_sum_of_logged_rows_matches_total(db):
    recs = [make_record(cost="0.000100"), make_record(cost="0.000250")]
    log_calls(recs, conversation="DEV:test", criterion_id="c01")
    assert sum(Decimal(r["cost_usd"]) for r in _rows()) == total_cost(recs)


def test_log_calls_quietly_swallows_db_errors(monkeypatch, caplog):
    import logging

    from evaluator import cost
    from evaluator.testing import make_record

    def boom(*a, **k):
        raise RuntimeError("disk is full sk-secret")

    monkeypatch.setattr(cost, "log_calls", boom)
    with caplog.at_level(logging.WARNING):
        cost.log_calls_quietly([make_record()], conversation="DEV:x", criterion_id="c01")
    assert "RuntimeError" in caplog.text and "sk-secret" not in caplog.text
