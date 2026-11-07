"""Test helpers shared by every evaluator test (and devrun's replay). Never calls the network.

Lives in the package, not in tests/, because pytest runs with --import-mode=importlib and
evaluator/tests cannot be a package (it would shadow `evaluator`). Import as
`from evaluator.testing import make_conv, ScriptedCalls, ...`.

Two levels of fake, so issues can be solved in parallel:
- ScriptedCalls replaces `call_structured` itself: test judge/info/second_opinion/translation
  without S3 being done. Use `scripted` fixture (evaluator/tests/conftest.py).
- FakeAsyncAnthropic replaces the SDK client: test call_structured (S3). Use `fake_anthropic`.

Test data here is generic on purpose: no official criterion text.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from pydantic import BaseModel

from evaluator._compat import (
    ChecklistVersion,
    Conversation,
    Criterion,
    LLMCallRecord,
    Message,
    ScaleStep,
    Section,
)

GROSS_KINDS = ["insult", "paid_service_outside_company", "confidential_disclosure"]


# --- factories --------------------------------------------------------------------------------
def make_conv(
    lines: list[tuple[str, str]],
    *,
    channel: str = "agent chat",
    language: str = "RU",
    timestamps: list[str] | None = None,
    duplicates: set[int] | frozenset[int] = frozenset(),
) -> Conversation:
    """lines = [(speaker, text), ...]. Chat timestamps default to MM:SS 10 s apart, calls to ISO."""
    if timestamps is None:
        if channel == "voice call":
            timestamps = [f"2026-11-01T10:00:{i * 5:02d}.000+05:00" for i in range(len(lines))]
        else:
            timestamps = [f"{(i * 10) // 60:02d}:{(i * 10) % 60:02d}" for i in range(len(lines))]
    transcript = [
        Message(timestamp=ts, speaker=sp, text=tx, duplicate=i in duplicates)
        for i, ((sp, tx), ts) in enumerate(zip(lines, timestamps, strict=True))
    ]
    return Conversation(
        id="DEV:test",
        conversation_id="test",
        group_id="DEV",
        channel=channel,  # type: ignore[arg-type]
        language=language,  # type: ignore[arg-type]
        transcript=transcript,
    )


def make_criterion(**overrides: Any) -> Criterion:
    """A yes/no criterion c01; override any field. `answer_type="scale"` gets 0/4/7/10 steps."""
    data: dict[str, Any] = {
        "id": "c01",
        "section_id": "s1",
        "order": 1,
        "title": "Test criterion",
        "wording": "Test wording: did the operator do the tested thing?",
        "answer_type": "yes_no",
        "weight": Decimal("10"),
        "na_allowed": False,
        "fingerprint": "f" * 64,
    }
    data.update(overrides)
    if data["answer_type"] == "scale" and "scale_steps" not in overrides:
        data["scale_steps"] = [ScaleStep(value=v, label=f"level {v}") for v in (0, 4, 7, 10)]
    return Criterion(**data)


def make_gross_criterion(**overrides: Any) -> Criterion:
    data: dict[str, Any] = {
        "id": "c08",
        "order": 8,
        "kind": "gross_error",
        "kinds": list(GROSS_KINDS),
        "weight": Decimal("0"),
        "fingerprint": "8" * 64,
    }
    data.update(overrides)
    return make_criterion(**data)


def make_checklist(criteria: list[Criterion] | None = None, **overrides: Any) -> ChecklistVersion:
    """Default: 8 criteria shaped like the official one (yes/no, scale, N/A, gross error)."""
    if criteria is None:
        criteria = [
            make_criterion(id="c01", order=1, fingerprint="1" * 64),
            make_criterion(id="c02", order=2, fingerprint="2" * 64, na_allowed=True, na_condition="test N/A"),
            make_criterion(id="c03", order=3, fingerprint="3" * 64),
            make_criterion(
                id="c04",
                order=4,
                fingerprint="4" * 64,
                answer_type="scale",
                scale_steps=[ScaleStep(value=v, label=f"level {v}") for v in (0, 5, 10, 15, 20)],
                na_allowed=True,
                na_condition="test N/A",
            ),
            make_criterion(id="c05", order=5, fingerprint="5" * 64),
            make_criterion(id="c06", order=6, fingerprint="6" * 64, answer_type="scale"),
            make_criterion(id="c07", order=7, fingerprint="7" * 64),
            make_gross_criterion(),
        ]
    data: dict[str, Any] = {
        "id": "official-chat:1",
        "checklist_id": "official-chat",
        "version": 1,
        "name": "Test checklist",
        "guidance": "Test checklist guidance.",
        "sections": [Section(id="s1", title="Section", order=1)],
        "criteria": criteria,
    }
    data.update(overrides)
    return ChecklistVersion(**data)


VALID_C01_NO: dict[str, Any] = {
    "answer": "no",
    "step": None,
    "kinds": [],
    "explanation": "Критерий — Нет. Оператор не поздоровался. Основание — сообщение 1.",
    "evidence": [{"message_index": 1, "quote": "Привет, где именно ищете?", "role": "supports"}],
    "checked_range": None,
    "na_reason": None,
    "confidence": "high",
    "coaching": "Поздоровайтесь и представьтесь.",
}


def make_record(purpose: str = "criterion", *, cost: str = "0.000100", reuse_key: str | None = None) -> LLMCallRecord:
    return LLMCallRecord(
        purpose=purpose,  # type: ignore[arg-type]
        model="claude-haiku-5-5",
        input_tokens=2000,
        output_tokens=600,
        cost_usd=Decimal(cost),
        latency_ms=100,
        reuse_key=reuse_key,
    )


# --- level 1: fake call_structured ------------------------------------------------------------
@dataclass
class ScriptedCalls:
    """Drop-in for `evaluator.client.call_structured`.

    script items: a dict (validated into output_type), a BaseModel, or an Exception to raise.
    `.calls` keeps every kwargs dict, so tests can assert on blocks/effort/model.
    """

    script: list[Any]
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def __call__(self, **kwargs: Any):
        self.calls.append(kwargs)
        if not self.script:
            raise AssertionError("ScriptedCalls: no scripted response left")
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        output_type = kwargs["output_type"]
        out = item if isinstance(item, output_type) else output_type.model_validate(item)
        return out, make_record(kwargs.get("purpose", "criterion"), reuse_key=kwargs.get("reuse_key"))


# --- level 2: fake SDK client -----------------------------------------------------------------
class _Endpoint:
    def __init__(self, owner: FakeAsyncAnthropic, name: str) -> None:
        self._owner, self._name = owner, name

    async def create(self, **kwargs: Any):
        self._owner.calls.append((self._name, kwargs))
        if not self._owner.script:
            raise AssertionError("FakeAsyncAnthropic: no scripted response left")
        item = self._owner.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


class FakeAsyncAnthropic:
    """Scripted stand-in for anthropic.AsyncAnthropic: `.messages.create`, `.beta.messages.create`.
    `.calls` = [("messages" | "beta", kwargs), ...]."""

    def __init__(self, script: list[Any] | None = None) -> None:
        self.script: list[Any] = list(script or [])
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.messages = _Endpoint(self, "messages")
        self.beta = SimpleNamespace(messages=_Endpoint(self, "beta"))


def text_response(
    payload: dict | str,
    *,
    stop_reason: str = "end_turn",
    stop_details: Any = None,
    usage: tuple[int, int, int, int] = (2000, 0, 0, 600),
    model: str = "claude-haiku-5-5",
    with_thinking: bool = True,
) -> SimpleNamespace:
    """A Messages API response look-alike. usage = (input, cache_write, cache_read, output)."""
    import json

    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    content = []
    if with_thinking:
        content.append(SimpleNamespace(type="thinking", thinking="", signature="sig"))
    content.append(SimpleNamespace(type="text", text=text))
    inp, write, read, out = usage
    return SimpleNamespace(
        content=content,
        stop_reason=stop_reason,
        stop_details=stop_details,
        usage=SimpleNamespace(
            input_tokens=inp,
            cache_creation_input_tokens=write,
            cache_read_input_tokens=read,
            output_tokens=out,
        ),
        model=model,
        _request_id="req_test",
    )


def status_error(cls: type, status: int) -> Exception:
    """Build an anthropic.APIStatusError subclass instance (anthropic 2.x is built on httpx2)."""
    import httpx2

    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx2.Response(status, request=request, headers={"request-id": "req_test"})
    return cls(f"HTTP {status}", response=response, body=None)


def from_recorded(path: Any) -> FakeAsyncAnthropic:
    """FakeAsyncAnthropic replaying responses saved by `devrun --record`. S8 (#20)."""
    raise NotImplementedError("S8 (#20): from_recorded")

