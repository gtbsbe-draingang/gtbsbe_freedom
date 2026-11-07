"""Not-scored dialogue information: topic, moods, outcome (extra B).

Owner: #21 (PLAN.md S9). Tests: test_info.py.
Never enters a reuse key or a score. Model = settings.default_model, effort low,
masked transcript + facts (prompt.render_transcript / render_facts), logged with criterion_id=None.
"""

from __future__ import annotations

from evaluator import client  # noqa: F401  call as client.call_structured(...) so tests can script it
from evaluator._compat import Conversation, DialogInfo, LLMCallRecord

EFFORT_INFO = "low"

INFO_SYSTEM_PROMPT = ""  # S9: topic in Russian, <= 8 words; client's mood; outcome definitions.


async def dialog_info(conv: Conversation) -> tuple[DialogInfo, list[LLMCallRecord]]:
    """Public API. Raises ModelKeyMissing or JudgmentFailed."""
    raise NotImplementedError("S9 (#21): dialog_info")
