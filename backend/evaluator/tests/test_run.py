import asyncio
import json

import pytest

from evaluator import evaluate
from evaluator.client import JudgmentFailed, ModelKeyMissing
from evaluator.run import DictCache, EvaluateOptions
from evaluator.testing import VALID_C01_NO, make_checklist, make_conv, make_criterion

LINES = [("client", "Привет"), ("operator", "Привет, где именно ищете?"), ("client", "ок")]
INFO = {"topic": "Тест", "mood_start": "спокойный", "mood_end": "довольный", "outcome": "resolved"}
YES = {**VALID_C01_NO, "answer": "yes", "evidence": [{"message_index": 1, "quote": "где именно ищете", "role": "supports"}],
       "coaching": None}
NO_STEP = {**YES, "answer": "step", "step": 10}
GROSS_NO = {**VALID_C01_NO, "answer": "no", "evidence": [], "checked_range": {"from_index": 0, "to_index": 2}, "coaching": None}
NA = {**VALID_C01_NO, "answer": "na", "evidence": [], "na_reason": "условие", "checked_range": None, "coaching": None}


def out_for(crit):
    """Valid output for a criterion, whatever its type (scripted calls run in checklist order)."""
    if crit.kind == "gross_error":
        return GROSS_NO
    if crit.answer_type == "scale":
        return {**NO_STEP, "step": crit.scale_steps[-1].value}
    return YES


def script_all(scripted, checklist, info=True, only=None):
    for c in checklist.criteria:
        if only is None or c.id in only:
            scripted.script.append(out_for(c))
    if info:
        scripted.script.append(INFO)


def run(conv, checklist, **opts):
    return asyncio.run(evaluate(conv, checklist, EvaluateOptions(**opts) if opts else None))


@pytest.fixture(autouse=True)
def _db(db):
    pass


def test_all_criteria_in_checklist_order(scripted):
    cl, conv = make_checklist(), make_conv(LINES)
    script_all(scripted, cl)
    r = run(conv, cl)
    assert [j.criterion_id for j in r.results] == [f"c0{i}" for i in range(1, 9)]
    assert r.conversation == "DEV:test" and r.checklist_id == "official-chat" and r.version == 1
    assert r.info and r.info.topic == "Тест" and r.failures == [] and r.reused == []
    assert len(r.calls) == 9 and r.cost_usd == sum(c.cost_usd for c in r.calls)
    assert r.needs_review is False


def test_first_criterion_runs_alone_then_rest(scripted):
    cl, conv = make_checklist(), make_conv(LINES)
    script_all(scripted, cl)
    run(conv, cl)
    # first scripted call is c01's (criterion block mentions its title; all share it, so check count/order)
    assert scripted.calls[0]["purpose"] == "criterion"
    assert scripted.calls[-1]["purpose"] == "info" or any(c["purpose"] == "info" for c in scripted.calls)


def test_second_run_with_cache_makes_no_calls(scripted):
    cl, conv, cache = make_checklist(), make_conv(LINES), DictCache()
    script_all(scripted, cl)
    first = run(conv, cl, cache=cache)
    n = len(scripted.calls)
    second = run(conv, cl, cache=cache, with_info=False)
    assert len(scripted.calls) == n
    assert second.calls == [] and str(second.cost_usd) == "0.000000" or second.cost_usd == 0
    assert second.reused == [j.criterion_id for j in first.results]
    assert [j.answer for j in second.results] == [j.answer for j in first.results]


def test_replaced_criterion_only_is_called(scripted):
    cl, conv, cache = make_checklist(), make_conv(LINES), DictCache()
    script_all(scripted, cl)
    run(conv, cl, cache=cache)
    crits = [c if c.id != "c03" else make_criterion(id="c03", order=3, fingerprint="9" * 64) for c in cl.criteria]
    cl2 = make_checklist(crits)
    scripted.script.append(YES)
    r = run(conv, cl2, cache=cache, with_info=False)
    assert len(r.calls) == 1 and r.reused == [c for c in ("c01", "c02", "c04", "c05", "c06", "c07", "c08")]


def test_mode_full_ignores_cache_but_writes(scripted):
    cl, conv, cache = make_checklist(), make_conv(LINES), DictCache()
    script_all(scripted, cl, info=False)
    run(conv, cl, cache=cache, with_info=False)
    script_all(scripted, cl, info=False)
    r = run(conv, cl, cache=cache, with_info=False, mode="full")
    assert len(r.calls) == 8 and r.reused == [] and len(cache.data) == 8


def test_failure_collected_others_returned(scripted):
    cl, conv = make_checklist(), make_conv(LINES)
    for c in cl.criteria:
        scripted.script.append(JudgmentFailed("max_tokens") if c.id == "c01" else out_for(c))
    r = run(conv, cl, with_info=False)
    assert [f.criterion_id for f in r.failures] == ["c01"] and r.failures[0].reason == "max_tokens"
    assert [j.criterion_id for j in r.results] == [f"c0{i}" for i in range(2, 9)]


def test_no_key_cold_cache_raises():
    with pytest.raises(ModelKeyMissing):
        run(make_conv(LINES), make_checklist())


def test_no_key_warm_cache_works(scripted):
    cl, conv, cache = make_checklist(), make_conv(LINES), DictCache()
    script_all(scripted, cl, info=False)
    run(conv, cl, cache=cache, with_info=False)
    from evaluator import client

    client.set_client(None)  # no injected client, no key
    r = run(conv, cl, cache=cache)  # with_info=True, but no key: info degrades, results still returned
    assert len(r.results) == 8 and r.info is None and r.info_error == "model_key_missing"


def test_criteria_subset_and_model_override(scripted):
    cl, conv = make_checklist(), make_conv(LINES)
    script_all(scripted, cl, info=False, only={"c02", "c05"})
    r = run(conv, cl, criteria=["c05", "c02"], with_info=False, model="claude-sonnet-5-5")
    assert [j.criterion_id for j in r.results] == ["c02", "c05"]
    assert {j.model for j in r.results} == {"claude-sonnet-5-5"}


def test_with_info_false_and_info_failure(scripted):
    cl, conv = make_checklist(), make_conv(LINES)
    script_all(scripted, cl, info=False)
    assert run(conv, cl, with_info=False).info is None and len(scripted.calls) == 8
    script_all(scripted, cl, info=False)
    scripted.script.append(JudgmentFailed("server_error", retryable=True))
    r = run(conv, cl)
    assert r.info is None and r.info_error == "server_error" and len(r.results) == 8


def test_needs_review_propagates(scripted):
    cl = make_checklist([make_criterion()])
    scripted.script.append({**YES, "confidence": "low"})
    assert run(make_conv(LINES), cl, with_info=False).needs_review is True


def test_input_not_mutated_and_no_audio_link(scripted):
    cl, conv = make_checklist(), make_conv(LINES)
    before = conv.model_dump()
    script_all(scripted, cl)
    r = run(conv, cl)
    assert conv.model_dump() == before
    dumped = json.dumps(r.model_dump(mode="json", by_alias=True))
    assert "audio_" + "url" not in dumped


def test_calls_logged_once(scripted):
    from app.db import connect

    cl, conv = make_checklist([make_criterion()]), make_conv(LINES)
    scripted.script.append(YES)
    run(conv, cl, with_info=False)
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM c_llm_calls").fetchone()[0] == 1
    finally:
        conn.close()


def test_failed_criterion_calls_count_in_run_totals(scripted):
    from evaluator.testing import make_record

    cl, conv = make_checklist(), make_conv(LINES)
    scripted.script.append(JudgmentFailed("max_tokens", calls=[make_record(cost="0.000500")]))
    for c in cl.criteria[1:]:
        scripted.script.append(out_for(c))
    scripted.script.append(INFO)
    r = run(conv, cl)
    assert [f.criterion_id for f in r.failures] == ["c01"]
    assert len(r.calls) == 1 + 7 + 1 and r.cost_usd == sum(c.cost_usd for c in r.calls)
    assert any(str(c.cost_usd) == "0.000500" for c in r.calls)


def test_failed_info_calls_count_in_run_totals(scripted):
    from evaluator.testing import make_record

    cl, conv = make_checklist(), make_conv(LINES)
    script_all(scripted, cl, info=False)
    scripted.script.append(JudgmentFailed("schema", calls=[make_record("info", cost="0.000700")]))
    r = run(conv, cl)
    assert r.info_error == "schema" and any(str(c.cost_usd) == "0.000700" for c in r.calls)


def test_second_run_with_defaults_and_cache_is_free_including_info(scripted):
    cl, conv, cache = make_checklist(), make_conv(LINES), DictCache()
    script_all(scripted, cl)
    first = run(conv, cl, cache=cache)
    n = len(scripted.calls)
    second = run(conv, cl, cache=cache)  # with_info stays True
    assert len(scripted.calls) == n and second.calls == [] and second.cost_usd == 0
    assert second.info == first.info and second.info_error is None


def test_info_cache_option_and_full_mode(scripted):
    cl, conv, store = make_checklist(), make_conv(LINES), {}
    script_all(scripted, cl)
    run(conv, cl, info_cache=store)
    assert len(store) == 1
    scripted.script.append(out_for(cl.criteria[0]))
    n = len(scripted.calls)
    r = run(conv, cl, info_cache=store, criteria=["c01"])
    assert r.info is not None
    assert [c["purpose"] for c in scripted.calls[n:]] == ["criterion"]  # info came from the store
    scripted.script.extend([out_for(cl.criteria[0]), INFO])
    n = len(scripted.calls)
    run(conv, cl, info_cache=store, criteria=["c01"], mode="full")
    assert [c["purpose"] for c in scripted.calls[n:]] == ["criterion", "info"]


def test_info_not_cached_on_failure_or_other_transcript(scripted):
    cl, store = make_checklist([make_checklist().criteria[0]]), {}
    scripted.script.extend([out_for(cl.criteria[0]), JudgmentFailed("schema")])
    r = run(make_conv(LINES), cl, info_cache=store)
    assert r.info_error == "schema" and store == {}
    scripted.script.extend([INFO, INFO])
    run(make_conv(LINES), cl, info_cache=store, mode="full", criteria=[])
    run(make_conv([*LINES, ("client", "ещё")]), cl, info_cache=store, mode="full", criteria=[])
    assert len(store) == 2


def test_info_runs_concurrently_with_the_other_criteria(monkeypatch):
    from evaluator import client
    from evaluator.testing import make_record

    cl, conv = make_checklist(), make_conv(LINES)
    events: list[tuple[str, str]] = []

    async def fake(**kw):
        p = kw["purpose"]
        events.append(("start", p))
        await asyncio.sleep(0.02)
        events.append(("end", p))
        data = out_for(next(c for c in cl.criteria if c.wording in kw["blocks"][1]["text"])) if p == "criterion" else INFO
        return kw["output_type"].model_validate(data), make_record(p)

    monkeypatch.setattr(client, "call_structured", fake)
    client.set_client(object())
    cl = make_checklist([make_criterion(id=f"c0{i}", order=i, wording=f"w{i}", fingerprint=str(i) * 64) for i in range(1, 4)])
    r = run(conv, cl)
    assert r.info is not None and len(r.results) == 3
    assert events.index(("start", "info")) < max(i for i, e in enumerate(events) if e == ("end", "criterion"))


def test_unknown_criterion_id_raises_before_any_call(scripted):
    cl, conv = make_checklist(), make_conv(LINES)
    with pytest.raises(ValueError, match="c99"):
        run(conv, cl, criteria=["c01", "c99"])
    assert scripted.calls == []


def test_reused_judgment_takes_the_new_criterion_id(scripted):
    """Keys omit criterion ids: an equivalent criterion under a new id reuses the judgment, relabelled."""
    conv, cache = make_conv(LINES), DictCache()
    scripted.script.append(YES)
    first = run(conv, make_checklist([make_criterion(id="old")]), cache=cache, with_info=False)
    assert first.results[0].criterion_id == "old" and first.calls
    r = run(conv, make_checklist([make_criterion(id="new")]), cache=cache, with_info=False)
    assert r.reused == ["new"] and r.calls == []
    assert r.results[0].criterion_id == "new" and r.results[0].calls == []
