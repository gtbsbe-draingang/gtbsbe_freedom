"""The single entry point evaluate(dialogue, checklist, options) -> EvaluatorRun.

Owner: S12 (proposed checkbox on #17). Tests: test_run.py. Types and DictCache are final (scaffold).
evaluate() must call judge_criterion / dialog_info, never re-implement them. It does not score,
round, redistribute N/A weight or carry appeals: those are B's.

Steps: (1) ModelKeyMissing only if a call is needed; (2) facts via app.transcript.compute_facts on a
copy when None (lazy import; skip if B's #8 is missing); (3) reuse_key + cache hits; (4) first missing
criterion alone, then the rest under asyncio.Semaphore(settings.max_parallel_calls); (5) dialog_info if
with_info; (6) collect. Per-criterion JudgmentFailed -> failures, the run continues.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

from evaluator._compat import ChecklistVersion, Conversation, DialogInfo, Judgment, LLMCallRecord


@runtime_checkable
class JudgmentCache(Protocol):
    """B's judgments table implements this; DictCache is the in-memory version for tests."""

    def get(self, key: str) -> Judgment | None: ...

    def put(self, key: str, judgment: Judgment) -> None: ...


class DictCache:
    def __init__(self) -> None:
        self.data: dict[str, Judgment] = {}

    def get(self, key: str) -> Judgment | None:
        return self.data.get(key)

    def put(self, key: str, judgment: Judgment) -> None:
        self.data[key] = judgment


class EvaluateOptions(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    model: str | None = None  # None = criterion.model or settings.default_model
    criteria: list[str] | None = None  # subset of Criterion.id; None = all
    with_info: bool = True
    mode: Literal["reuse", "full"] = "reuse"  # "full" ignores the cache but still writes it
    cache: JudgmentCache | None = None


class Failure(BaseModel):
    criterion_id: str
    reason: str
    retryable: bool
    request_id: str | None = None


class EvaluatorRun(BaseModel):
    conversation: str
    checklist_id: str
    version: int
    source: Literal["model"] = "model"
    results: list[Judgment]  # checklist order; failed criteria absent
    failures: list[Failure] = []
    reused: list[str] = []
    info: DialogInfo | None = None
    info_error: str | None = None
    calls: list[LLMCallRecord] = []  # calls made by THIS run only
    cost_usd: Decimal
    needs_review: bool


async def evaluate(
    dialogue: Conversation, checklist: ChecklistVersion, options: EvaluateOptions | None = None
) -> EvaluatorRun:
    raise NotImplementedError("S12: evaluate")
