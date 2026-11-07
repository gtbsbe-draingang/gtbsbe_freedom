"""Claude client lifecycle, one structured call, error mapping.

Owner: #17 (PLAN.md S3). The two exception classes and get_client/set_client are final
(scaffold); `call_structured` is the work of S3.

Before implementing S3, invoke the `claude-api` skill and re-verify PLAN.md "Conflicts" item 8.
"""

from __future__ import annotations

import json
import time
from typing import Any, TypeVar

from pydantic import BaseModel

from evaluator import cost
from evaluator._compat import LLMCallRecord
from evaluator.schemas import json_schema_for

T = TypeVar("T", bound=BaseModel)

SONNET_FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_RETRIES = 4
TIMEOUT_SECONDS = 60.0  # the default of settings.model_timeout_seconds (env MODEL_TIMEOUT_SECONDS)
MAX_TOKENS = 16000


class ModelKeyMissing(Exception):
    """No ANTHROPIC_API_KEY is configured. B maps it to 409 `model_key_missing`."""


class JudgmentFailed(Exception):
    """The model call failed, or the answer is still invalid after one retry.

    `reason` values: "invalid_answer", "schema", "max_tokens", "refusal:<category>",
    "rate_limited", "server_error", "connection", "bad_request", "auth", "model_not_found",
    "api_error", "unknown_model", "translation_incomplete". `calls` holds the records of paid calls behind the failure (may be empty).
    Signature is final; never carries request bodies.
    """

    def __init__(
        self,
        reason: str,
        *,
        retryable: bool = False,
        request_id: str | None = None,
        calls: list[LLMCallRecord] | None = None,
    ):
        super().__init__(reason)
        self.calls: list[LLMCallRecord] = list(calls or [])  # paid calls made before the failure
        self.reason = reason
        self.retryable = retryable
        self.request_id = request_id


_client: Any | None = None


def set_client(client: Any | None) -> None:
    """Inject a client (tests pass `evaluator.testing.FakeAsyncAnthropic`); None resets."""
    global _client
    _client = client


def get_client() -> Any:
    """The cached `anthropic.AsyncAnthropic`, built lazily from settings.

    Raises ModelKeyMissing when no key is set and no client was injected. Call it first in every
    public function so the error comes before any work.
    """
    global _client
    if _client is not None:
        return _client
    from app.settings import get_settings

    settings = get_settings()
    if not settings.model_key_configured:
        raise ModelKeyMissing("ANTHROPIC_API_KEY is not set")
    import anthropic

    options: dict[str, Any] = {}
    if settings.anthropic_base_url and settings.anthropic_base_url.strip():
        options["base_url"] = settings.anthropic_base_url.strip()
    _client = anthropic.AsyncAnthropic(
        api_key=settings.anthropic_api_key.get_secret_value(),  # type: ignore[union-attr]
        max_retries=MAX_RETRIES,
        timeout=settings.model_timeout_seconds,
        **options,
    )
    return _client


async def call_structured(
    *,
    purpose: str,
    model: str,
    effort: str,
    system: str,
    blocks: list[dict],
    output_type: type[T],
    reuse_key: str | None = None,
    max_tokens: int = MAX_TOKENS,
) -> tuple[T, LLMCallRecord]:
    """One structured-output call -> (validated output, call record), or JudgmentFailed.

    S3 / #17. Request: system text, one user message made of `blocks`, `output_config` with
    `effort` and a json_schema format from `schemas.json_schema_for(output_type)`. Sonnet goes
    through `client.beta.messages.create(..., betas=[SONNET_FALLBACK_BETA], fallbacks="default")`.
    Stop reasons `refusal`/`max_tokens` and SDK errors map per PLAN.md "Error handling".
    `LLMCallRecord.input_tokens` = input + cache write + cache read; cost via `cost.call_cost`.
    """
    client = get_client()
    from app.settings import get_settings

    if model not in get_settings().prices:  # fail before a paid call, never lose a response to KeyError
        raise JudgmentFailed("unknown_model")
    request: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": blocks}],
        "output_config": {
            "effort": effort,
            "format": {"type": "json_schema", "schema": json_schema_for(output_type)},
        },
    }
    started = time.monotonic()
    try:
        if "sonnet" in model:
            response = await client.beta.messages.create(
                **request, betas=[SONNET_FALLBACK_BETA], fallbacks="default"
            )
        else:
            response = await client.messages.create(**request)
    except Exception as exc:  # noqa: BLE001  non-SDK errors are re-raised unchanged by _map_error
        raise _map_error(exc) from None
    latency_ms = int((time.monotonic() - started) * 1000)

    request_id = getattr(response, "_request_id", None)
    usage = response.usage
    fresh = usage.input_tokens or 0
    write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    read = getattr(usage, "cache_read_input_tokens", 0) or 0
    record = LLMCallRecord(
        purpose=purpose,  # type: ignore[arg-type]
        model=model,
        input_tokens=fresh + write + read,
        output_tokens=usage.output_tokens,
        cost_usd=cost.call_cost(
            model,
            input_tokens=fresh,
            cache_write_tokens=write,
            cache_read_tokens=read,
            output_tokens=usage.output_tokens,
        ),
        latency_ms=latency_ms,
        reuse_key=reuse_key,
    )
    # A response came back, so it was paid for: every failure below carries its record.
    if response.stop_reason == "refusal":
        category = getattr(response.stop_details, "category", None) or "unknown"
        raise JudgmentFailed(f"refusal:{category}", request_id=request_id, calls=[record])
    if response.stop_reason == "max_tokens":
        raise JudgmentFailed("max_tokens", request_id=request_id, calls=[record])
    texts = [b.text for b in response.content if getattr(b, "type", None) == "text"]
    try:
        output = output_type.model_validate(json.loads(texts[-1]))
    except (IndexError, ValueError):  # no text block, bad JSON, or pydantic.ValidationError
        raise JudgmentFailed("schema", request_id=request_id, calls=[record]) from None
    return output, record


def _map_error(exc: Exception) -> Exception:
    """SDK error -> JudgmentFailed (reason + request id only; never the body or the key).
    Anything that is not an SDK error is returned unchanged."""
    import anthropic

    if not isinstance(exc, anthropic.APIError):
        return exc
    request_id = getattr(exc, "request_id", None)
    status = getattr(exc, "status_code", None)
    if isinstance(exc, anthropic.APIConnectionError):  # includes APITimeoutError
        reason, retryable = "connection", True
    elif status == 429:
        reason, retryable = "rate_limited", True
    elif status is not None and status >= 500:
        reason, retryable = "server_error", True
    elif status == 400:
        reason, retryable = "bad_request", False
    elif status in (401, 403):
        reason, retryable = "auth", False
    elif status == 404:
        reason, retryable = "model_not_found", False
    else:
        reason, retryable = "api_error", False
    return JudgmentFailed(reason, retryable=retryable, request_id=request_id)


async def call_into(calls: list[LLMCallRecord], **kwargs: Any):
    """call_structured that appends every paid call (success or failure) to `calls`.
    On JudgmentFailed the records are copied into `calls`; the caller re-raises with all of them."""
    try:
        out, record = await call_structured(**kwargs)
    except JudgmentFailed as exc:
        calls.extend(exc.calls)
        raise
    calls.append(record)
    return out
