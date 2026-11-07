# TEMPORARY: delete when app.models (#4) is on main (PLAN.md step S13)
"""Verbatim copy of the shared models from docs/superpowers/plans/2026-11-07-shared-interfaces.md.

Do not edit by hand except to re-sync with that file. Never import this module directly:
import from `evaluator._compat`.
"""

from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Speaker = Literal["client", "operator", "bot", "system"]


class Message(BaseModel):
    timestamp: str
    speaker: Speaker | str
    text: str
    duplicate: bool = False


class Facts(BaseModel):
    operator_joined_index: int | None
    first_reaction_seconds: float | None
    longest_wait_seconds: float | None
    identity_verified_index: int | None
    ending: Literal["operator_closed", "client_left", "connection_lost", "client_ended_call", "normal"]


class DialogInfo(BaseModel):
    topic: str
    mood_start: str
    mood_end: str
    outcome: Literal["resolved", "passed_to_specialists", "unresolved", "client_left"]


class AudioOffset(BaseModel):
    message_index: int
    seconds: float


class VoiceMeasurement(BaseModel):
    message_index: int
    from_seconds: float
    to_seconds: float
    pitch_range: float | None
    rate_wpm: float | None
    pauses: float | None
    overlap: float | None


class Conversation(BaseModel):
    id: str
    created_at: datetime | None = None
    conversation_id: str
    group_id: str
    channel: Literal["agent chat", "voice call"]
    language: Literal["RU", "KZ", "EN"]
    transcript: list[Message]
    status: Literal["new", "evaluated", "disputed"] = "new"
    facts: Facts | None = None
    info: DialogInfo | None = None
    audio: str | None = None
    audio_unavailable_reason: Literal["needs_import", "none"] | None = None
    audio_offsets: list[AudioOffset] = []
    voice_measurements: list[VoiceMeasurement] = []


class ScaleStep(BaseModel):
    value: int
    label: str


class Criterion(BaseModel):
    id: str
    section_id: str
    order: int
    title: str
    wording: str
    answer_type: Literal["yes_no", "scale"]
    scale_steps: list[ScaleStep] = []
    weight: Decimal
    na_allowed: bool
    na_condition: str | None = None
    kind: Literal["scored", "gross_error"] = "scored"
    kinds: list[str] = []
    guidance: str | None = None
    model: str | None = None
    fingerprint: str


class Section(BaseModel):
    id: str
    title: str
    order: int


class ChecklistVersion(BaseModel):
    id: str | None = None
    created_at: datetime | None = None
    checklist_id: str
    version: int
    name: str
    description: str = ""
    channel: Literal["any", "chat", "call"] = "any"
    locked: bool = False
    based_on: dict | None = None
    author_role: Literal["controller", "reviewer"] | None = None
    rounding: int = 2
    guidance: str = ""
    sections: list[Section]
    criteria: list[Criterion]


class StepAnswer(BaseModel):
    step: int


Answer = Literal["yes", "no", "na"] | StepAnswer


class Evidence(BaseModel):
    message_index: int
    quote: str
    role: Literal["supports", "expected_here"]


class CheckedRange(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: int = Field(alias="from")
    to: int


class LLMCallRecord(BaseModel):
    purpose: Literal["criterion", "info", "second_opinion", "translation"]
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal
    latency_ms: int
    reuse_key: str | None = None


class Judgment(BaseModel):
    criterion_id: str
    answer: Answer
    kinds: list[str] = []
    explanation: str
    evidence: list[Evidence] = []
    checked_range: CheckedRange | None = None
    na_reason: str | None = None
    confidence: Literal["low", "medium", "high"]
    needs_review: bool = False
    coaching: str | None = None
    model: str
    reuse_key: str
    calls: list[LLMCallRecord] = []


class CriterionResult(Judgment):
    final_answer: Answer | None = None
    points: Decimal | None
    effective_weight: Decimal | None
    reused: bool = False
    carried_decision: dict | None = None


class SecondOpinion(BaseModel):
    answer: Answer
    reasoning: str
