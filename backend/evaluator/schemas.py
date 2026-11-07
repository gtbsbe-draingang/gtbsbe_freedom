"""Model-output schemas (what Claude must return), one per call kind.

All models are final (scaffold); only `json_schema_for` is the work of S3 (#17).
Every model has extra="forbid". Constraints the API rejects (maxLength, minimum, pattern, ...)
are stripped from the sent schema by `json_schema_for`; Pydantic still validates them locally.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict

AnswerOut = Literal["yes", "no", "na", "step"]
Mood = Literal["спокойный", "обеспокоенный", "раздражённый", "довольный", "нейтральный"]
Outcome = Literal["resolved", "passed_to_specialists", "unresolved", "client_left"]

UNSUPPORTED_SCHEMA_KEYS = frozenset(
    {
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "pattern",
    }
)


class _Out(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- criterion (#17, S3) -------------------------------------------------------------------
class OutEvidence(_Out):
    message_index: int
    quote: str
    role: Literal["supports", "expected_here"]


class OutRange(_Out):
    from_index: int
    to_index: int


class CriterionOutput(_Out):
    answer: AnswerOut
    step: int | None  # the step VALUE when answer == "step"
    kinds: list[str]
    explanation: str
    evidence: list[OutEvidence]
    checked_range: OutRange | None
    na_reason: str | None
    confidence: Literal["low", "medium", "high"]
    coaching: str | None


# --- dialog info (#21, S9) -----------------------------------------------------------------
class InfoOutput(_Out):
    topic: str  # about 8 words (prompt); info.dialog_info truncates to 80 chars, no maxLength sent
    mood_start: Mood
    mood_end: Mood
    outcome: Outcome


# --- second opinion (#22, S10) -------------------------------------------------------------
class SecondOpinionOutput(_Out):
    answer: AnswerOut
    step: int | None
    reasoning: str


# --- translation (#23, S11) ----------------------------------------------------------------
class TranslatedLine(_Out):
    message_index: int
    text: str


class TranslationOutput(_Out):
    messages: list[TranslatedLine]


def json_schema_for(model: type[BaseModel]) -> dict:
    """Pydantic JSON schema with additionalProperties:false on every object (incl. $defs) and
    UNSUPPORTED_SCHEMA_KEYS removed. S3 (#17)."""
    return _clean(model.model_json_schema())


def _clean(node):
    if isinstance(node, list):
        return [_clean(v) for v in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key, value in node.items():
        if key in UNSUPPORTED_SCHEMA_KEYS:
            continue
        if key in ("properties", "$defs") and isinstance(value, dict):
            out[key] = {name: _clean(sub) for name, sub in value.items()}  # names are not keywords
        else:
            out[key] = _clean(value)
    if out.get("type") == "object":
        out["additionalProperties"] = False
    return out
