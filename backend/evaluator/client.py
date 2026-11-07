"""Claude client lifecycle, one structured call, error mapping.

Owner: #17 (PLAN.md S3). The two exception classes and get_client/set_client are final
(scaffold); `call_structured` is the work of S3.

Before implementing S3, invoke the `claude-api` skill and re-verify PLAN.md "Conflicts" item 8.
"""

from __future__ import annotations

from typing import Any, TypeVar

from pydantic import BaseModel

from evaluator._compat import LLMCallRecord

T = TypeVar("T", bound=BaseModel)

SONNET_FALLBACK_BETA = "server-side-fallback-2026-07-01"
MAX_RETRIES = 4
TIMEOUT_SECONDS = 60.0
MAX_TOKENS = 16000


class ModelKeyMissing(Exception):
    """No ANTHROPIC_API_KEY is configured. B maps it to 409 `model_key_missing`."""


class JudgmentFailed(Exception):
    """The model call failed, or the answer is still invalid after one retry.

    `reason` values: "invalid_answer", "schema", "max_tokens", "refusal:<category>",
    "rate_limited", "server_error", "connection", "bad_request", "auth", "model_not_found",
    "api_error", "translation_incomplete". Signature is final; never carries request bodies.
    """

    def __init__(self, reason: str, *, retryable: bool = False, request_id: str | None = None):
        super().__init__(reason)
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

    _client = anthropic.AsyncAnthropic(
        api_key=settings.anthropic_api_key.get_secret_value(),  # type: ignore[union-attr]
        max_retries=MAX_RETRIES,
        timeout=TIMEOUT_SECONDS,
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
    raise NotImplementedError("S3 (#17): call_structured")
