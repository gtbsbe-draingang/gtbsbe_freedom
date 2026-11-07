"""The single entry point evaluate(dialogue, checklist, options) -> EvaluatorRun.

Owner: S12 (proposed checkbox on #17). Tests: test_run.py. Types and DictCache are final (scaffold).
evaluate() must call judge_criterion / dialog_info, never re-implement them. It does not score,
round, redistribute N/A weight or carry appeals: those are B's.

Steps: (1) ModelKeyMissing only if a call is needed; (2) facts via app.transcript.compute_facts on a
copy when None (lazy import; skip if B's #8 is missing); (3) reuse_key + cache hits; (4) first missing
criterion alone, then the rest under asyncio.Semaphore(settings.max_parallel_calls); (5) dialog_info if
with_info; (6) collect. Per-criterion JudgmentFailed -> failures, the run continues.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Any, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict

from app.settings import get_settings
from evaluator import client, info, judge, keys
from evaluator._compat import (
    ChecklistVersion,
    Conversation,
    DialogInfo,
    Judgment,
    LLMCallRecord,
)
from evaluator.cost import QUANTUM


@runtime_checkable
class JudgmentCache(Protocol):
    """B's judgments table implements this; DictCache is the in-memory version for tests."""

    def get(self, key: str) -> Judgment | None: ...

    def put(self, key: str, judgment: Judgment) -> None: ...


class DictCache:
    def __init__(self) -> None:
        self.data: dict[str, Judgment] = {}
        self.info_data: dict[str, DialogInfo] = {}  # dialogue info by keys.info_key

    def get(self, key: str) -> Judgment | None:
        return self.data.get(key)

    def put(self, key: str, judgment: Judgment) -> None:
        self.data[key] = judgment


class EvaluateOptions(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    model: str | None = None  # None = criterion.model or settings.default_model
    criteria: list[str] | None = None  # subset of Criterion.id; None = all
    with_info: bool = True
    mode: Literal["reuse", "full"] = "reuse"  # "full" ignores the cache but still writes it
    cache: JudgmentCache | None = None
    # key (keys.info_key) -> DialogInfo. None: use `cache.info_data` when the cache has one (DictCache).
    info_cache: Any = None  # a MutableMapping[str, DialogInfo]; typed Any so pydantic does not copy it


class Failure(BaseModel):
    criterion_id: str
    reason: str
    retryable: bool
    request_id: str | None = None


class EvaluatorRun(BaseModel):
    conversation: str
    checklist_id: str
    version: int
    source: Literal["model"] = "model"
    results: list[Judgment]  # checklist order; failed criteria absent
    failures: list[Failure] = []
    reused: list[str] = []
    info: DialogInfo | None = None
    info_error: str | None = None
    calls: list[LLMCallRecord] = []  # calls made by THIS run only
    cost_usd: Decimal
    needs_review: bool


def _with_facts(conv: Conversation) -> Conversation:
    """A copy; facts filled by B's compute_facts when it exists and facts are missing."""
    conv = conv.model_copy(deep=True)
    if conv.facts is None:
        try:
            from app.transcript import compute_facts  # type: ignore[import-not-found]
        except ImportError:  # B's #8 not merged: leave facts None ("not computed")
            return conv
        conv.facts = compute_facts(conv.transcript)
    return conv


async def evaluate(
    dialogue: Conversation, checklist: ChecklistVersion, options: EvaluateOptions | None = None
) -> EvaluatorRun:
    opts = options or EvaluateOptions()
    conv = _with_facts(dialogue)
    default_model = get_settings().default_model
    if opts.criteria is not None:
        unknown = sorted(set(opts.criteria) - {c.id for c in checklist.criteria})
        if unknown:
            raise ValueError(f"unknown criterion id(s): {', '.join(unknown)}")
    selected = [c for c in checklist.criteria if opts.criteria is None or c.id in opts.criteria]
    cache = opts.cache

    found: dict[str, Judgment] = {}
    todo = []  # (criterion, model, key)
    for c in selected:
        model = opts.model or c.model or default_model
        key = keys.reuse_key(conv, checklist, c, model)
        hit = cache.get(key) if cache is not None and opts.mode == "reuse" else None
        if hit is not None:
            # keys omit criterion ids: relabel the hit for this criterion, drop its old paid calls (as jobs.py does)
            found[c.id] = hit.model_copy(update={"criterion_id": c.id, "calls": []})
        else:
            todo.append((c, model, key))

    if todo:
        client.get_client()  # ModelKeyMissing before any work

    failures: list[Failure] = []
    failed_calls: list[LLMCallRecord] = []  # paid calls of criteria that failed
    fresh: dict[str, Judgment] = {}
    sem = asyncio.Semaphore(max(1, get_settings().max_parallel_calls))

    async def one(c, model, key) -> None:
        async with sem:
            try:
                j = await judge.judge_criterion(conv, checklist, c, model=model)
            except client.JudgmentFailed as e:
                failed_calls.extend(e.calls)
                failures.append(Failure(criterion_id=c.id, reason=e.reason, retryable=e.retryable, request_id=e.request_id))
                return
        fresh[c.id] = j
        if cache is not None:
            cache.put(key, j)

    dialog_info = None
    info_error = None
    info_calls: list[LLMCallRecord] = []
    info_store = opts.info_cache if opts.info_cache is not None else getattr(cache, "info_data", None)
    info_key = keys.info_key(conv, default_model)

    async def get_info() -> None:
        nonlocal dialog_info, info_error, info_calls
        hit = info_store.get(info_key) if info_store is not None and opts.mode == "reuse" else None
        if hit is not None:
            dialog_info = hit
            return
        async with sem:
            try:
                dialog_info, info_calls = await info.dialog_info(conv)
            except client.ModelKeyMissing:
                info_error = "model_key_missing"
                return
            except client.JudgmentFailed as e:
                info_error = e.reason
                info_calls = e.calls
                return
        if info_store is not None:
            info_store[info_key] = dialog_info

    rest = [one(*t) for t in todo[1:]]
    if todo:  # the first alone, so the others read the prompt cache it wrote
        await one(*todo[0])
    # dialogue info runs together with the remaining criteria, not after them
    await asyncio.gather(*rest, *([get_info()] if opts.with_info else []))

    results = [j for c in selected if (j := found.get(c.id) or fresh.get(c.id)) is not None]
    calls = [r for c in selected if c.id in fresh for r in fresh[c.id].calls] + failed_calls + info_calls
    failures.sort(key=lambda f: [c.id for c in selected].index(f.criterion_id))
    return EvaluatorRun(
        conversation=conv.id,
        checklist_id=checklist.checklist_id,
        version=checklist.version,
        results=results,
        failures=failures,
        reused=[c.id for c in selected if c.id in found],
        info=dialog_info,
        info_error=info_error,
        calls=calls,
        cost_usd=sum((r.cost_usd for r in calls), Decimal(0)).quantize(QUANTUM),
        needs_review=any(j.needs_review for j in results),
    )
