"""Call cost and the c_llm_calls log.

Owner: #19. `call_cost` is S3, `log_calls` / `total_cost` are S7. Tests: test_cost.py.
The table schema below is final (scaffold) so other streams can read it.
"""

from __future__ import annotations

from decimal import Decimal

from app.db import register_migration
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
    raise NotImplementedError("S3 (#19): call_cost")


def log_calls(records: list[LLMCallRecord], *, conversation: str | None, criterion_id: str | None) -> None:
    """Insert one c_llm_calls row per record; cost stored as a string. S7."""
    raise NotImplementedError("S7 (#19): log_calls")


def total_cost(records: list[LLMCallRecord]) -> Decimal:
    """Exact sum of cost_usd, quantized to QUANTUM; Decimal("0.000000") for no records. S7."""
    raise NotImplementedError("S7 (#19): total_cost")
