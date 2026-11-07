"""The only place the evaluator imports the shared models from.

Every evaluator module does `from evaluator._compat import Conversation, ...`, never
`from app.models import ...`, so switching off the vendored copy (S13) is a one-file change.
"""

try:
    from app.models import (  # type: ignore[import-not-found]
        Answer,
        CheckedRange,
        ChecklistVersion,
        Conversation,
        Criterion,
        CriterionResult,
        DialogInfo,
        Evidence,
        Facts,
        Judgment,
        LLMCallRecord,
        Message,
        ScaleStep,
        SecondOpinion,
        Section,
        StepAnswer,
        VoiceMeasurement,
    )
except ImportError:  # until B's #4 merges; S13 removes this branch and _vendor.py
    from evaluator._vendor import (
        Answer,
        CheckedRange,
        ChecklistVersion,
        Conversation,
        Criterion,
        CriterionResult,
        DialogInfo,
        Evidence,
        Facts,
        Judgment,
        LLMCallRecord,
        Message,
        ScaleStep,
        SecondOpinion,
        Section,
        StepAnswer,
        VoiceMeasurement,
    )

__all__ = [
    "Answer",
    "CheckedRange",
    "ChecklistVersion",
    "Conversation",
    "Criterion",
    "CriterionResult",
    "DialogInfo",
    "Evidence",
    "Facts",
    "Judgment",
    "LLMCallRecord",
    "Message",
    "ScaleStep",
    "SecondOpinion",
    "Section",
    "StepAnswer",
    "VoiceMeasurement",
]
