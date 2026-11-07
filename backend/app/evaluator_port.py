"""The port through which B's jobs and appeals use stream C's evaluator.

C owns `backend/evaluator/__init__.py` (shared-interfaces.md, "Evaluator API"). It may not exist
yet, so it is imported lazily, the first time it is needed, never at module import. Tests put a
fake in its place with `set_evaluator(fake)` and take it out with `reset_evaluator()`.

C's exceptions are caught by the classes the active evaluator exposes (`ModelKeyMissing`,
`JudgmentFailed` as attributes of the module or of the fake), so a fake's own classes are
recognised exactly like the real ones.
"""

import importlib
import importlib.util
import logging
import sys
from typing import Any, Protocol

from app.errors import ApiError
from app.models import (
    ChecklistVersion,
    Conversation,
    Criterion,
    CriterionResult,
    DialogInfo,
    Judgment,
    LLMCallRecord,
    SecondOpinion,
)

logger = logging.getLogger(__name__)


class EvaluatorPort(Protocol):
    """C's four functions and two exception classes. The `evaluator` module satisfies it as is."""

    ModelKeyMissing: type[Exception]
    JudgmentFailed: type[Exception]  # .reason: str, .retryable: bool, .request_id: str | None

    def reuse_key(
        self, conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, model: str
    ) -> str: ...

    async def judge_criterion(
        self, conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, *, model: str
    ) -> Judgment: ...

    async def dialog_info(self, conv: Conversation) -> tuple[DialogInfo, list[LLMCallRecord]]: ...

    async def second_opinion(
        self,
        conv: Conversation,
        checklist: ChecklistVersion,
        criterion: Criterion,
        result: CriterionResult,
        comment: str,
    ) -> tuple[SecondOpinion, list[LLMCallRecord]]: ...


class _NeverRaised(Exception):
    """Stands in for an exception class the evaluator does not define: nothing is ever one."""


_override: Any = None


def set_evaluator(evaluator: Any) -> None:
    """Use `evaluator` instead of the `evaluator` package (tests)."""
    global _override
    _override = evaluator


def reset_evaluator() -> None:
    global _override
    _override = None


def _import_evaluator() -> Any:
    """Stream C's `evaluator` package, or None while it does not exist (or cannot be imported)."""
    try:
        if importlib.util.find_spec("evaluator") is None:
            return None
    except ValueError:
        # Already in sys.modules without a __spec__ (a stand-in): it is there.
        return sys.modules.get("evaluator")
    try:
        return importlib.import_module("evaluator")
    except Exception:
        logger.exception("The evaluator package exists but cannot be imported")
        return None


def find_evaluator() -> EvaluatorPort | None:
    """The fake set by a test, else the `evaluator` package, else None."""
    if _override is not None:
        return _override
    return _import_evaluator()


def get_evaluator() -> EvaluatorPort:
    """The active evaluator. Raises ApiError(503, "evaluator_unavailable") when there is none."""
    evaluator = find_evaluator()
    if evaluator is None:
        raise ApiError(
            503,
            "evaluator_unavailable",
            "The evaluator is not available on this server, so dialogues cannot be evaluated.",
        )
    return evaluator


def model_key_missing_class(evaluator: Any) -> type[Exception]:
    return getattr(evaluator, "ModelKeyMissing", None) or _NeverRaised


def judgment_failed_class(evaluator: Any) -> type[Exception]:
    return getattr(evaluator, "JudgmentFailed", None) or _NeverRaised
