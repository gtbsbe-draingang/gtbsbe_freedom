"""Test doubles and helpers for the evaluation jobs (and the appeals tests that build on them).

Import as `from tests.app.fakes import FakeEvaluator` (backend/ is on sys.path; `tests` and
`tests.app` are namespace packages, so this never clashes with the real `app` package).

`FakeEvaluator` stands in for stream C's `evaluator` package: same four functions, same two
exception classes (exposed as attributes, which is how app.evaluator_port finds them). No network,
no Claude API.
"""

import asyncio
import hashlib
import json
from decimal import Decimal
from pathlib import Path

from app import store
from app.checklists import with_fingerprints
from app.models import (
    Answer,
    ChecklistVersion,
    Conversation,
    Criterion,
    CriterionResult,
    DialogInfo,
    Evidence,
    Judgment,
    LLMCallRecord,
    SecondOpinion,
    StepAnswer,
)
from app.settings import get_settings
from app.transcript import normalize_record, transcript_hash

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "dev_subset.json"
OFFICIAL = ("official-chat", 1)
CALL_COST = Decimal("0.001")


class ModelKeyMissing(Exception):
    """The fake's own class: the port must recognise it through `FakeEvaluator.ModelKeyMissing`."""


class JudgmentFailed(Exception):
    def __init__(self, reason: str, *, retryable: bool, request_id: str | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.retryable = retryable
        self.request_id = request_id


class FakeEvaluator:
    ModelKeyMissing = ModelKeyMissing
    JudgmentFailed = JudgmentFailed

    def __init__(self, delay: float = 0.005) -> None:
        self.delay = delay  # the await inside a call, so concurrency is observable
        self.calls = 0  # judge_criterion calls
        self.judged: list[tuple[str, str]] = []  # (conversation id, criterion id) per call
        self.events: list[tuple[str, str, str]] = []  # ("start" | "end", conversation, criterion)
        self.fail_for: set[str] = set()  # conversation ids whose calls raise `failure()`
        # What a call for a conversation in fail_for raises: a fresh exception every time, or None
        # for "this call succeeds" (`judged[-1]` is the call being made).
        self.failure = lambda: JudgmentFailed("model_timeout", retryable=True)
        self.answers: dict[str, Answer] = {}  # criterion id -> answer, instead of the default
        self.in_flight = 0
        self.max_concurrency = 0
        self.info_calls = 0
        self.info_fails = False
        self.second_opinions = 0

    # --- the evaluator API ---------------------------------------------------------------------

    def reuse_key(
        self, conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, model: str
    ) -> str:
        parts = [criterion.fingerprint, checklist.guidance, transcript_hash(conv.transcript), model]
        return hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode("utf-8")).hexdigest()

    async def judge_criterion(
        self, conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, *, model: str
    ) -> Judgment:
        if not get_settings().model_key_configured:
            raise self.ModelKeyMissing()
        self.calls += 1
        self.judged.append((conv.id, criterion.id))
        self.events.append(("start", conv.id, criterion.id))
        self.in_flight += 1
        self.max_concurrency = max(self.max_concurrency, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
            if conv.id in self.fail_for:
                exc = self.failure()
                if exc is not None:
                    raise exc
        finally:
            self.in_flight -= 1
            self.events.append(("end", conv.id, criterion.id))
        return Judgment(
            criterion_id=criterion.id,
            answer=self.answers.get(criterion.id, default_answer(criterion)),
            explanation=f"Fake judgment of {criterion.id}.",
            evidence=[Evidence(message_index=0, quote=conv.transcript[0].text[:40], role="supports")],
            confidence="high",
            model=model,
            reuse_key=self.reuse_key(conv, checklist, criterion, model),
            calls=[call_record("criterion", model, self.reuse_key(conv, checklist, criterion, model))],
        )

    async def dialog_info(self, conv: Conversation) -> tuple[DialogInfo, list[LLMCallRecord]]:
        if not get_settings().model_key_configured:
            raise self.ModelKeyMissing()
        self.info_calls += 1
        await asyncio.sleep(self.delay)
        if self.info_fails:
            raise RuntimeError("info failed at https://secret.example/x?sig=LEAK")
        info = DialogInfo(topic="Fake topic", mood_start="calm", mood_end="calm", outcome="resolved")
        return info, [call_record("info", get_settings().default_model)]

    async def second_opinion(
        self,
        conv: Conversation,
        checklist: ChecklistVersion,
        criterion: Criterion,
        result: CriterionResult,
        comment: str,
    ) -> tuple[SecondOpinion, list[LLMCallRecord]]:
        if not get_settings().model_key_configured:
            raise self.ModelKeyMissing()
        self.second_opinions += 1
        await asyncio.sleep(self.delay)
        opinion = SecondOpinion(answer=result.answer, reasoning="The fake agrees with the first answer.")
        return opinion, [call_record("second_opinion", get_settings().default_model)]

    # --- for assertions ------------------------------------------------------------------------

    def judged_criteria(self) -> set[str]:
        return {criterion for _, criterion in self.judged}


def default_answer(criterion: Criterion) -> Answer:
    """yes for a scored yes/no criterion, the top step for a scale, no for a gross-error one."""
    if criterion.kind == "gross_error":
        return "no"
    if criterion.answer_type == "scale":
        return StepAnswer(step=max(s.value for s in criterion.scale_steps))
    return "yes"


def call_record(purpose: str, model: str, reuse_key: str | None = None) -> LLMCallRecord:
    return LLMCallRecord(
        purpose=purpose,
        model=model,
        input_tokens=100,
        output_tokens=20,
        cost_usd=CALL_COST,
        latency_ms=5,
        reuse_key=reuse_key,
    )


# --- data ----------------------------------------------------------------------------------


def dev_records() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def load_dev_subset(group_id: str = "DEV") -> list[str]:
    """Store the six DEV dialogues (without their audio links) and return their ids."""
    ids = []
    for record in dev_records():
        conversation, _ = normalize_record({k: v for k, v in record.items() if k != "audio_url"}, group_id)
        store.upsert_conversation(conversation, None)
        ids.append(conversation.id)
    return ids


def official_checklist() -> ChecklistVersion:
    """The official checklist's structure, inline: 4 sections, 7 scored criteria (weights
    10/15/20/20/15/15/5, scales c04 and c06) and the gross-error criterion c08. Used when stream A's
    seed is not on the branch; when it is, `ensure_official` returns the seeded one instead."""

    def criterion(cid, section, order, title, wording, weight, **extra) -> Criterion:
        return Criterion(
            id=cid, section_id=section, order=order, title=title, wording=wording,
            answer_type=extra.pop("answer_type", "yes_no"), weight=Decimal(weight),
            na_allowed=extra.pop("na_allowed", False), fingerprint="", **extra,
        )  # fmt: skip

    def steps(*values: int) -> list[dict]:
        return [{"value": v, "label": f"Шаг {v}"} for v in values]

    version = ChecklistVersion(
        checklist_id=OFFICIAL[0],
        version=OFFICIAL[1],
        name="Чек-лист качества чатов",
        description="Восемь критериев для оценки работы оператора по переписке",
        locked=True,
        guidance="Общая памятка оценщику.",
        sections=[
            {"id": "start", "title": "Начало и понимание запроса", "order": 1},
            {"id": "safety", "title": "Безопасность и решение", "order": 2},
            {"id": "conduct", "title": "Ведение и завершение диалога", "order": 3},
            {"id": "gross", "title": "Грубые нарушения", "order": 4},
        ],
        criteria=[
            criterion("c01", "start", 1, "Установление контакта", "Да — оператор поздоровался.", 10),
            criterion("c02", "start", 2, "Выявление потребности", "Да — уточнил запрос.", 15,
                      na_allowed=True, na_condition="N/A — данных хватало."),
            criterion("c03", "safety", 3, "Идентификация", "Да — личность подтверждена.", 20,
                      na_allowed=True, na_condition="N/A — не требовалась."),
            criterion("c04", "safety", 4, "Консультация", "Оцените ответ по шкале.", 20,
                      answer_type="scale", scale_steps=steps(0, 5, 10, 15, 20), na_allowed=True),
            criterion("c05", "conduct", 5, "Эмпатия", "Да — оператор вежлив.", 15),
            criterion("c06", "conduct", 6, "Управление диалогом", "Оцените ясность.", 15,
                      answer_type="scale", scale_steps=steps(0, 4, 7, 10)),
            criterion("c07", "conduct", 7, "Завершение", "Да — подвёл итог.", 5,
                      na_allowed=True, na_condition="N/A — чат оборвался."),
            criterion("c08", "gross", 8, "Грубые ошибки", "Да — выявлено нарушение.", 0,
                      kind="gross_error", kinds=["insult", "paid_service_outside_company"]),
        ],
    )  # fmt: skip
    return with_fingerprints(version)


def ensure_official() -> ChecklistVersion:
    """The official checklist from the database: the seeded one when stream A's seed was loaded,
    else the inline one, saved now."""
    stored = store.get_checklist_version(*OFFICIAL)
    if stored is not None:
        return stored
    return store.save_checklist_version(official_checklist())


def copy_body(version: ChecklistVersion, name: str = "Копия") -> dict:
    """A POST /checklists body that copies `version` (fingerprints and ids left to the server)."""
    data = version.model_dump(mode="json")
    criteria = [{k: v for k, v in c.items() if k != "fingerprint"} for c in data["criteria"]]
    return {
        "name": name,
        "description": data["description"],
        "channel": data["channel"],
        "based_on": {"checklist_id": version.checklist_id, "version": version.version},
        "rounding": data["rounding"],
        "guidance": data["guidance"],
        "sections": data["sections"],
        "criteria": criteria,
    }
