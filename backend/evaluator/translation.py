"""Translation on demand into Russian (extra 5). The original text is never replaced.

Owner: #23 (PLAN.md S11). Tests: test_translation.py. Endpoint: evaluator/router.py.
RU -> originals, no call. Otherwise one call on masked, non-duplicate lines; every index exactly
once; one retry, then JudgmentFailed("translation_incomplete"). Duplicates copy their source line.
"""

from __future__ import annotations

from app.db import register_migration
from evaluator import client  # noqa: F401  call as client.call_structured(...) so tests can script it
from evaluator._compat import Conversation, LLMCallRecord

EFFORT_TRANSLATION = "low"
SUPPORTED_TARGETS = frozenset({"ru"})

register_migration(
    "c_002_translations",
    """
    CREATE TABLE c_translations (
        conversation TEXT NOT NULL,
        lang TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (conversation, lang)
    );
    """,
)


async def translate(conv: Conversation, to: str = "ru") -> tuple[list[str], list[LLMCallRecord]]:
    """One string per transcript line, in order."""
    raise NotImplementedError("S11 (#23): translate")


def load_translation(conversation: str, lang: str) -> list[str] | None:
    """Stored translation from c_translations, or None."""
    raise NotImplementedError("S11 (#23): load_translation")


def save_translation(conversation: str, lang: str, texts: list[str]) -> None:
    """Upsert into c_translations (payload = JSON list of strings)."""
    raise NotImplementedError("S11 (#23): save_translation")
