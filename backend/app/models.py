"""Shared Pydantic models: the single definition of every shape of the API contract.

Section 7 of the front-end design is the contract; shared-interfaces.md pins the names. The
evaluator (C) and quality/audio (D) import these and never redefine them.

Every route returns `dump(model)`, never `model.model_dump()`: it applies the JSON rules of the
contract (decimals as JSON numbers, `from` as the key of a checked range or comparison side, no
internal fields on an evaluation).
"""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    StrictInt,
    model_validator,
)

# A Decimal that goes out in JSON as a number (84.17, not "84.17"). Python-mode dumps keep the
# exact Decimal, so the storage layer loses nothing. Input accepts numbers, strings and Decimals.
Num = Annotated[Decimal, PlainSerializer(lambda d: float(d), return_type=float, when_used="json")]

Role = Literal["controller", "reviewer"]
Speaker = Literal["client", "operator", "bot", "system"]
_RunStatus = Literal["queued", "running", "done", "failed"]


# --- conversations -------------------------------------------------------------------------


class Message(BaseModel):  # a transcript line; referred to by its index in Conversation.transcript
    timestamp: str  # original, unchanged: "MM:SS" (chats) or ISO 8601 with zone (calls)
    speaker: Speaker | str  # unknown speakers in a new set are kept, not rejected
    text: str
    duplicate: bool = False


class Facts(BaseModel):
    operator_joined_index: int | None
    first_reaction_seconds: float | None
    longest_wait_seconds: float | None
    identity_verified_index: int | None
    ending: Literal[
        "operator_closed", "client_left", "connection_lost", "client_ended_call", "normal"
    ]


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
    pitch_range: float | None  # semitones
    rate_wpm: float | None
    pauses: float | None  # seconds of silence inside the part
    overlap: float | None  # seconds overlapping the client


class Conversation(BaseModel):
    # An audio_url in the input is dropped, never kept: it is stored privately
    # (see app.store.get_audio_url) and never sent to the UI.
    model_config = ConfigDict(extra="ignore")

    id: str  # f"{group_id}:{conversation_id}"
    created_at: datetime | None = None
    conversation_id: str
    group_id: str
    channel: Literal["agent chat", "voice call"]
    # RU, KZ or EN by convention; the contract keeps any other code exactly as given (no
    # upper-casing, no trimming), so one unexpected code never fails an import.
    language: str
    transcript: list[Message]
    status: Literal["new", "evaluated", "disputed"] = "new"
    facts: Facts | None = None
    info: DialogInfo | None = None
    audio: str | None = None  # relative path of our audio endpoint, or None
    audio_unavailable_reason: Literal["needs_import", "none"] | None = None
    audio_offsets: list[AudioOffset] = []
    voice_measurements: list[VoiceMeasurement] = []


class FinalSummary(BaseModel):
    checklist_id: str
    version: int
    total: Num | None
    gross_error: bool
    open_appeals: int
    needs_review: bool


class QueueItem(Conversation):  # GET /conversations: a conversation without its transcript
    transcript: list[Message] = Field(default=[], exclude=True)
    final: FinalSummary | None


# --- checklists ----------------------------------------------------------------------------


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
    weight: Num  # 0 for the gross-error criterion
    na_allowed: bool
    na_condition: str | None = None
    kind: Literal["scored", "gross_error"] = "scored"
    kinds: list[str] = []  # gross-error violation kinds
    guidance: str | None = None
    model: str | None = None  # per-criterion model override
    fingerprint: str  # see app.checklists.criterion_fingerprint


class Section(BaseModel):
    id: str
    title: str
    order: int


class ChecklistVersion(BaseModel):
    id: str | None = None  # f"{checklist_id}:{version}"; filled in when missing (e.g. a seed)
    created_at: datetime | None = None
    checklist_id: str
    version: int
    name: str
    description: str = ""
    channel: Literal["any", "chat", "call"] = "any"
    locked: bool = False
    based_on: dict | None = None  # {"checklist_id": str, "version": int}
    author_role: Role | None = None
    rounding: int = 2
    guidance: str = ""
    sections: list[Section]
    criteria: list[Criterion]

    @model_validator(mode="after")
    def _derive_id(self) -> "ChecklistVersion":
        if self.id is None:
            self.id = f"{self.checklist_id}:{self.version}"
        return self


# --- answers and judgments -----------------------------------------------------------------


class StepAnswer(BaseModel):
    step: StrictInt  # the step's VALUE (e.g. 15), not its position; {"step": "15"} is rejected


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
    cost_usd: Num
    latency_ms: int
    reuse_key: str | None = None


class Judgment(BaseModel):  # what the evaluator returns for one criterion (not in the contract)
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


class CriterionResult(Judgment):  # Judgment + what B's scoring and appeals add
    # Lenient here only: the wire shape of a result never has reuse_key (dump() hides it) and
    # the contract does not list model, so a dumped or contract evaluation must parse again.
    # Judgment (the evaluator's type) still requires both.
    model: str | None = None
    reuse_key: str | None = None
    final_answer: Answer | None = None  # after decided and carried appeals
    points: Num | None
    effective_weight: Num | None
    reused: bool = False
    carried_decision: dict | None = None  # {"appeal_id": str, "evaluation_id": str}


class SecondOpinion(BaseModel):
    answer: Answer
    reasoning: str


# --- evaluations ---------------------------------------------------------------------------


class SectionScore(BaseModel):
    section_id: str
    points: Num | None  # null when nothing in the section applies
    available: Num | None
    percent: Num | None


class GrossError(BaseModel):
    flag: bool
    kinds: list[str] = []
    explanation: str | None = None
    evidence: list[Evidence] = []


class Evaluation(BaseModel):
    # A queued, running or failed evaluation has no results or totals yet, so everything after
    # `source` has a default.
    id: str
    created_at: datetime
    conversation: str  # the conversation's id
    checklist_id: str
    version: int
    status: _RunStatus
    source: Literal["model", "mock"] = "model"
    model: str | None = None
    cost_usd: Num = Decimal("0")
    results: list[CriterionResult] = Field(default_factory=list)
    original_total: Num | None = None  # null = not calculated
    final_total: Num | None = None
    sections: list[SectionScore] = Field(default_factory=list)
    gross_error: GrossError = Field(default_factory=lambda: GrossError(flag=False))
    # Internal, never sent to the UI: the hash of the transcript a done evaluation graded. An
    # appeal on it belongs to that transcript (carry-forward), even after a re-import.
    transcript_hash: str | None = None


# --- appeals -------------------------------------------------------------------------------


class Decision(BaseModel):
    outcome: Literal["confirmed", "changed"]
    answer: Answer  # "confirmed": the model's original answer; "changed": the reviewer's
    reason: str
    role: Role
    decided_at: datetime
    # Beyond the contract: the gross-error kinds that go with `answer` (the model's kinds when the
    # answer is the model's, else none), so a carried decision scores exactly like the original.
    kinds: list[str] = []


class Appeal(BaseModel):
    id: str
    created_at: datetime
    evaluation_id: str
    conversation: str
    criterion_id: str
    comment: str
    role: Role
    status: Literal["open", "decided"]
    second_opinion: SecondOpinion | None
    second_opinion_status: Literal["pending", "done", "unavailable"]
    decision: Decision | None


# --- jobs ----------------------------------------------------------------------------------


class JobItem(BaseModel):
    conversation: str
    status: _RunStatus
    error: str | None = None
    evaluation_id: str | None = None


class JobRetry(BaseModel):  # one POST /jobs/{id}/retry (beyond the contract; extra fields are allowed)
    role: Role
    at: datetime
    items: list[str]  # the conversations put back in the queue


class Job(BaseModel):
    id: str
    created_at: datetime
    status: _RunStatus
    mode: Literal["reuse", "full"]
    total: int
    done: int
    failed: int
    items: list[JobItem]
    retries: list[JobRetry] = []


class DryRun(BaseModel):  # POST /evaluations with dry_run: true
    total: int
    model_calls: int
    reused: int


# --- config, imports, errors ---------------------------------------------------------------


class Config(BaseModel):
    models: list[str]
    prices: dict[str, dict[str, Num]]  # USD per 1M tokens, by model, then "input" / "output"
    model_key_configured: bool
    default_checklist: dict  # {"checklist_id": str, "version": int}


class ImportSummary(BaseModel):  # GET /datasets/{group_id} and POST /conversations
    group_id: str
    total: int
    imported: int
    updated: int
    unchanged: int


class ErrorBody(BaseModel):
    error: str
    message: str


# --- comparison and analytics --------------------------------------------------------------


class ComparisonSide(BaseModel):
    checklist_id: str
    version: int
    name: str


class ComparisonSummary(BaseModel):
    total: int
    changed: int
    avg_delta: Num | None  # null when no dialogue has both totals


class ComparisonRow(BaseModel):
    conversation: str  # the conversation's id
    conversation_id: str
    group_id: str
    old_total: Num | None  # final totals; null = not calculated
    new_total: Num | None
    delta: Num | None  # null when either side is null


class Comparison(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    from_: ComparisonSide = Field(alias="from")
    to: ComparisonSide
    summary: ComparisonSummary
    rows: list[ComparisonRow]


class AnalyticsCriterion(BaseModel):
    criterion_id: str
    title: str
    fail_rate: Num
    na_rate: Num
    n: int


class AnalyticsLanguage(BaseModel):
    language: str  # the conversations' code, as stored (see Conversation.language)
    avg_total: Num | None
    n: int


class AnalyticsChannel(BaseModel):
    channel: Literal["agent chat", "voice call"]
    avg_total: Num | None
    n: int


class GrossErrorKindCount(BaseModel):
    kind: str
    count: int


class GrossErrorStats(BaseModel):
    count: int
    by_kind: list[GrossErrorKindCount]
    conversations: list[str]  # conversation ids


class Analytics(BaseModel):
    by_criterion: list[AnalyticsCriterion]
    by_language: list[AnalyticsLanguage]
    by_channel: list[AnalyticsChannel]
    gross_errors: GrossErrorStats


# --- output --------------------------------------------------------------------------------

# What an evaluation never sends to the UI: the model-call log, the reuse hash and the hash of
# the graded transcript.
_EVALUATION_HIDDEN = {"transcript_hash": True, "results": {"__all__": {"calls", "reuse_key"}}}


def dump(model: BaseModel) -> dict[str, Any]:
    """The JSON body of a model. Every route returns this."""
    if isinstance(model, Evaluation):
        return model.model_dump(mode="json", by_alias=True, exclude=_EVALUATION_HIDDEN)
    return model.model_dump(mode="json", by_alias=True)
