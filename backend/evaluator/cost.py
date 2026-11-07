"""Call cost and the c_llm_calls log.

Owner: #19. `call_cost` is S3, `log_calls` / `total_cost` are S7. Tests: test_cost.py.
The table schema below is final (scaffold) so other streams can read it.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from app.db import connect, register_migration
from app.settings import get_settings
from evaluator._compat import LLMCallRecord

CACHE_WRITE = Decimal("1.25")  # x input price
CACHE_READ = Decimal("0.10")  # x input price
QUANTUM = Decimal("0.000001")  # USD, 6 decimals

register_migration(
    "c_001_llm_calls",
    """
    CREATE TABLE c_llm_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        conversation TEXT,
        criterion_id TEXT,
        purpose TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        reuse_key TEXT
    );
    CREATE INDEX c_llm_calls_conversation ON c_llm_calls (conversation);
    """,
)


def call_cost(
    model: str,
    *,
    input_tokens: int,
    cache_write_tokens: int,
    cache_read_tokens: int,
    output_tokens: int,
) -> Decimal:
    """(in*p_in + write*p_in*1.25 + read*p_in*0.10 + out*p_out) / 1e6, quantized to QUANTUM.

    Prices from `get_settings().prices` (USD per 1M). KeyError for an unknown model. S3.
    """
    price = get_settings().prices[model]
    p_in, p_out = price["input"], price["output"]
    total = (
        input_tokens * p_in
        + cache_write_tokens * p_in * CACHE_WRITE
        + cache_read_tokens * p_in * CACHE_READ
        + output_tokens * p_out
    ) / Decimal(1_000_000)
    return total.quantize(QUANTUM, rounding=ROUND_HALF_UP)


def log_calls(records: list[LLMCallRecord], *, conversation: str | None, criterion_id: str | None) -> None:
    """Insert one c_llm_calls row per record; cost stored as a string. S7."""
    if not records:
        return
    now = datetime.now(UTC).isoformat(timespec="seconds")
    conn = connect()
    try:
        with conn:
            conn.executemany(
                "INSERT INTO c_llm_calls (created_at, conversation, criterion_id, purpose, model, input_tokens,"
                " output_tokens, cost_usd, latency_ms, reuse_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [
                    (now, conversation, criterion_id, r.purpose, r.model, r.input_tokens, r.output_tokens,
                     str(r.cost_usd), r.latency_ms, r.reuse_key)
                    for r in records
                ],
            )
    finally:
        conn.close()


def log_calls_quietly(records: list[LLMCallRecord], *, conversation: str | None, criterion_id: str | None) -> None:
    """log_calls that never raises: a failed log write must not hide the real result or error.
    Logs the exception class only (no message, so no secrets)."""
    try:
        log_calls(records, conversation=conversation, criterion_id=criterion_id)
    except Exception as exc:  # noqa: BLE001
        logging.getLogger(__name__).warning("c_llm_calls write failed: %s", type(exc).__name__)


def total_cost(records: list[LLMCallRecord]) -> Decimal:
    """Exact sum of cost_usd, quantized to QUANTUM; Decimal("0.000000") for no records. S7."""
    return sum((r.cost_usd for r in records), Decimal(0)).quantize(QUANTUM)
