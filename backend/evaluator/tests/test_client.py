"""S3 (#17): call_structured against FakeAsyncAnthropic (the Claude API is never called)."""

import pytest

pytest.importorskip("anthropic")
import anthropic
import httpx2

from evaluator import client
from evaluator.client import JudgmentFailed, ModelKeyMissing
from evaluator.schemas import CriterionOutput
from evaluator.testing import (
    VALID_C01_NO,
    FakeAsyncAnthropic,
    status_error,
    text_response,
)

BLOCKS = [
    {"type": "text", "text": "prefix", "cache_control": {"type": "ephemeral"}},
    {"type": "text", "text": "c"},
]


async def call(model="claude-haiku-5-5", **kw):
    return await client.call_structured(
        purpose="criterion",
        model=model,
        effort="medium",
        system="SYS",
        blocks=BLOCKS,
        output_type=CriterionOutput,
        reuse_key="k" * 64,
        **kw,
    )


async def test_success_request_shape_and_record(
    fake_anthropic: FakeAsyncAnthropic,
) -> None:
    fake_anthropic.script.append(
        text_response(VALID_C01_NO, usage=(2000, 10000, 50000, 600))
    )
    out, rec = await call()
    assert isinstance(out, CriterionOutput) and out.answer == "no"
    kind, kw = fake_anthropic.calls[0]
    assert kind == "messages"
    assert (
        kw["model"] == "claude-haiku-5-5"
        and kw["system"] == "SYS"
        and kw["max_tokens"] == 16000
    )
    assert kw["messages"] == [{"role": "user", "content": BLOCKS}]
    oc = kw["output_config"]
    assert oc["effort"] == "medium" and oc["format"]["type"] == "json_schema"
    assert oc["format"]["schema"]["additionalProperties"] is False
    for banned in (
        "thinking",
        "tool_choice",
        "tools",
        "temperature",
        "betas",
        "fallbacks",
        "output_format",
    ):
        assert banned not in kw
    assert kw["messages"][-1]["role"] == "user"  # no prefill
    assert (
        rec.purpose == "criterion"
        and rec.model == "claude-haiku-5-5"
        and rec.reuse_key == "k" * 64
    )
    assert (
        rec.input_tokens == 62000 and rec.output_tokens == 600
    )  # includes cache write and read
    assert str(rec.cost_usd) == "0.002250" and rec.latency_ms >= 0


async def test_max_tokens_passed_through(fake_anthropic: FakeAsyncAnthropic) -> None:
    fake_anthropic.script.append(text_response(VALID_C01_NO))
    await call(max_tokens=123)
    assert fake_anthropic.calls[0][1]["max_tokens"] == 123


async def test_sonnet_uses_beta_fallback(fake_anthropic: FakeAsyncAnthropic) -> None:
    fake_anthropic.script.append(text_response(VALID_C01_NO, model="claude-sonnet-5-5"))
    _, rec = await call("claude-sonnet-5-5")
    kind, kw = fake_anthropic.calls[0]
    assert (
        kind == "beta"
        and kw["betas"] == [client.SONNET_FALLBACK_BETA]
        and kw["fallbacks"] == "default"
    )
    assert (
        kw["output_config"]["effort"] == "medium" and rec.model == "claude-sonnet-5-5"
    )


async def test_reads_last_text_block_after_thinking(
    fake_anthropic: FakeAsyncAnthropic,
) -> None:
    fake_anthropic.script.append(text_response(VALID_C01_NO, with_thinking=True))
    out, _ = await call()
    assert out.confidence == "high"


@pytest.mark.parametrize(
    ("details", "reason"),
    [
        (type("D", (), {"category": "cyber"})(), "refusal:cyber"),
        (None, "refusal:unknown"),
    ],
)
async def test_refusal(fake_anthropic: FakeAsyncAnthropic, details, reason) -> None:
    fake_anthropic.script.append(
        text_response("", stop_reason="refusal", stop_details=details)
    )
    with pytest.raises(JudgmentFailed) as e:
        await call()
    assert e.value.reason == reason and e.value.retryable is False


async def test_max_tokens_stop(fake_anthropic: FakeAsyncAnthropic) -> None:
    fake_anthropic.script.append(
        text_response('{"answer": "no"', stop_reason="max_tokens")
    )
    with pytest.raises(JudgmentFailed) as e:
        await call()
    assert e.value.reason == "max_tokens" and e.value.retryable is False


@pytest.mark.parametrize(
    "payload",
    [
        "not json",
        "[]",
        {"answer": "no"},
        {**VALID_C01_NO, "extra": 1},
        {**VALID_C01_NO, "answer": "maybe"},
    ],
)
async def test_schema_invalid(fake_anthropic: FakeAsyncAnthropic, payload) -> None:
    fake_anthropic.script.append(text_response(payload))
    with pytest.raises(JudgmentFailed) as e:
        await call()
    assert e.value.reason == "schema" and e.value.retryable is False


def _conn(cls):
    return cls(request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages"))


@pytest.mark.parametrize(
    ("make", "reason", "retryable"),
    [
        (lambda: status_error(anthropic.RateLimitError, 429), "rate_limited", True),
        (
            lambda: status_error(anthropic.InternalServerError, 500),
            "server_error",
            True,
        ),
        (
            lambda: status_error(anthropic.InternalServerError, 529),
            "server_error",
            True,
        ),
        (lambda: _conn(anthropic.APIConnectionError), "connection", True),
        (lambda: _conn(anthropic.APITimeoutError), "connection", True),
        (lambda: status_error(anthropic.BadRequestError, 400), "bad_request", False),
        (lambda: status_error(anthropic.AuthenticationError, 401), "auth", False),
        (lambda: status_error(anthropic.PermissionDeniedError, 403), "auth", False),
        (lambda: status_error(anthropic.NotFoundError, 404), "model_not_found", False),
        (lambda: status_error(anthropic.APIStatusError, 418), "api_error", False),
    ],
)
async def test_sdk_errors_mapped(
    fake_anthropic: FakeAsyncAnthropic, make, reason, retryable
) -> None:
    fake_anthropic.script.append(make())
    with pytest.raises(JudgmentFailed) as e:
        await call()
    assert (e.value.reason, e.value.retryable) == (reason, retryable)
    assert str(e.value) == reason  # no request body, no key


async def test_request_id_carried(fake_anthropic: FakeAsyncAnthropic) -> None:
    fake_anthropic.script.append(status_error(anthropic.RateLimitError, 429))
    with pytest.raises(JudgmentFailed) as e:
        await call()
    assert e.value.request_id == "req_test"


async def test_no_key_raises_before_any_call() -> None:
    with pytest.raises(ModelKeyMissing):
        await call()


async def test_unknown_model_fails_before_any_request(fake_anthropic: FakeAsyncAnthropic) -> None:
    with pytest.raises(JudgmentFailed) as e:
        await call("claude-not-priced")
    assert e.value.reason == "unknown_model" and e.value.retryable is False
    assert fake_anthropic.calls == []


@pytest.mark.parametrize(
    ("kwargs", "reason"),
    [
        ({"stop_reason": "refusal"}, "refusal:unknown"),
        ({"stop_reason": "max_tokens"}, "max_tokens"),
        ({"stop_reason": "end_turn"}, "schema"),
    ],
)
async def test_paid_failures_carry_their_call_record(fake_anthropic: FakeAsyncAnthropic, kwargs, reason) -> None:
    payload = "not json" if reason == "schema" else ""
    fake_anthropic.script.append(text_response(payload, usage=(2000, 0, 0, 600), **kwargs))
    with pytest.raises(JudgmentFailed) as e:
        await call()
    assert e.value.reason == reason
    (rec,) = e.value.calls
    assert rec.purpose == "criterion" and rec.input_tokens == 2000 and rec.output_tokens == 600
    assert rec.cost_usd > 0 and rec.reuse_key == "k" * 64


async def test_unpaid_failures_carry_no_records(fake_anthropic: FakeAsyncAnthropic) -> None:
    fake_anthropic.script.append(status_error(anthropic.RateLimitError, 429))
    with pytest.raises(JudgmentFailed) as e:
        await call()
    assert e.value.calls == []


def test_judgment_failed_calls_is_trailing_optional() -> None:
    assert JudgmentFailed("x").calls == []
    assert JudgmentFailed("x", calls=[1]).calls == [1]  # type: ignore[list-item]
