"""S6 (#17, #18): judge_criterion with the real wave-1 functions and a scripted model."""

import copy

import pytest

from app.db import connect
from evaluator import client, judge, keys, prompt
from evaluator._compat import StepAnswer
from evaluator.checking import CHECKED_RANGE_MISSING, Problem
from evaluator.client import JudgmentFailed, ModelKeyMissing
from evaluator.testing import (
    VALID_C01_NO,
    ScriptedCalls,
    make_checklist,
    make_conv,
    make_criterion,
    make_gross_criterion,
)

MODEL = "claude-haiku-5-5"
CONV_LINES = [
    ("client", "Здравствуйте"),
    ("operator", "Привет, где именно ищете?"),
    ("client", "Тут"),
]


def conv_():
    return make_conv(CONV_LINES)


def bad(**kw):
    return {**VALID_C01_NO, **kw}


BAD_INDEX = bad(evidence=[{"message_index": 99, "quote": "x", "role": "supports"}])
BAD_QUOTE = bad(
    evidence=[
        {
            "message_index": 1,
            "quote": "совсем другая фраза оператора",
            "role": "supports",
        }
    ]
)


async def run(criterion=None, conv=None, checklist=None):
    cl = checklist or make_checklist()
    return await judge.judge_criterion(
        conv or conv_(), cl, criterion or cl.criteria[0], model=MODEL
    )


async def test_valid_first_try(scripted: ScriptedCalls, db) -> None:
    scripted.script.append(VALID_C01_NO)
    cl, conv = make_checklist(), conv_()
    j = await run(conv=conv, checklist=cl)
    assert len(scripted.calls) == 1 and j.answer == "no" and j.needs_review is False
    assert j.criterion_id == "c01" and j.model == MODEL and j.confidence == "high"
    assert (
        j.reuse_key == keys.reuse_key(conv, cl, cl.criteria[0], MODEL)
        and len(j.calls) == 1
    )
    assert [(e.message_index, e.role) for e in j.evidence] == [(1, "supports")]
    kw = scripted.calls[0]
    assert (
        kw["purpose"] == "criterion"
        and kw["effort"] == "medium"
        and kw["model"] == MODEL
    )
    assert (
        kw["system"] == prompt.SYSTEM_PROMPT
        and len(kw["blocks"]) == 2
        and kw["reuse_key"] == j.reuse_key
    )


async def test_retry_then_ok(scripted: ScriptedCalls, db) -> None:
    scripted.script.extend([BAD_INDEX, VALID_C01_NO])
    j = await run()
    assert len(scripted.calls) == 2 and len(j.calls) == 2 and j.needs_review is False
    first, second = (c["blocks"] for c in scripted.calls)
    assert len(first) == 2 and len(second) == 3 and second[:2] == first
    assert (
        "cache_control" not in second[2] and "index_out_of_range" in second[2]["text"]
    )
    assert j.evidence[0].message_index == 1


async def test_still_bad_evidence_dropped_and_flagged(
    scripted: ScriptedCalls, db
) -> None:
    ok_ev = {
        "message_index": 1,
        "quote": "Привет, где именно ищете?",
        "role": "supports",
    }
    both = bad(evidence=[ok_ev, BAD_QUOTE["evidence"][0]])
    scripted.script.extend([both, both])
    j = await run()
    assert len(scripted.calls) == 2 and j.needs_review is True
    assert [e.quote for e in j.evidence] == [ok_ev["quote"]]


async def test_still_invalid_answer_raises(scripted: ScriptedCalls, db) -> None:
    wrong = bad(answer="na", na_reason="r")  # c01 does not allow N/A
    scripted.script.extend([wrong, wrong])
    with pytest.raises(JudgmentFailed) as e:
        await run()
    assert e.value.reason == "invalid_answer" and e.value.retryable is False
    assert len(scripted.calls) == 2


async def test_fatal_then_fixed(scripted: ScriptedCalls, db) -> None:
    scripted.script.extend([bad(answer="na", na_reason="r"), VALID_C01_NO])
    assert (await run()).answer == "no"


async def test_low_confidence_flags_without_retry(scripted: ScriptedCalls, db) -> None:
    scripted.script.append(bad(confidence="low"))
    j = await run()
    assert j.needs_review is True and j.confidence == "low" and len(scripted.calls) == 1


async def test_step_and_range_mapping(scripted: ScriptedCalls, db) -> None:
    cl = make_checklist()
    scale = cl.criteria[5]  # steps 0/4/7/10
    out = bad(
        answer="step",
        step=7,
        evidence=[],
        checked_range={"from_index": 0, "to_index": 2},
        coaching=None,
    )
    scripted.script.append(out)
    j = await run(scale, checklist=cl)
    assert j.answer == StepAnswer(step=7) and j.needs_review is False
    dumped = j.model_dump(mode="json", by_alias=True)
    assert dumped["answer"] == {"step": 7} and dumped["checked_range"] == {
        "from": 0,
        "to": 2,
    }


async def test_step_position_is_not_a_value(scripted: ScriptedCalls, db) -> None:
    cl = make_checklist()
    wrong = bad(
        answer="step",
        step=2,
        evidence=[],
        checked_range={"from_index": 0, "to_index": 2},
    )
    scripted.script.extend([wrong, wrong])
    with pytest.raises(JudgmentFailed):
        await run(cl.criteria[5], checklist=cl)


async def test_gross_error_kinds(scripted: ScriptedCalls, db) -> None:
    g = make_gross_criterion()
    scripted.script.append(bad(answer="yes", kinds=["insult"]))
    j = await run(g)
    assert j.answer == "yes" and j.kinds == ["insult"]


async def test_prompt_gets_masked_text_only(scripted: ScriptedCalls, db) -> None:
    conv = make_conv(
        [
            ("client", "Пишите на ivan.petrov@example.com"),
            ("operator", "Привет, где именно ищете?"),
        ]
    )
    scripted.script.append(VALID_C01_NO)
    await run(conv=conv)
    sent = "".join(b["text"] for b in scripted.calls[0]["blocks"])
    assert "ivan.petrov@example.com" not in sent and "Привет, где именно ищете?" in sent


async def test_no_key_before_any_work(monkeypatch: pytest.MonkeyPatch) -> None:
    called = ScriptedCalls(script=[VALID_C01_NO])
    monkeypatch.setattr(client, "call_structured", called)
    with pytest.raises(ModelKeyMissing):
        await run()
    assert called.calls == []


async def test_model_failure_propagates(scripted: ScriptedCalls, db) -> None:
    scripted.script.append(JudgmentFailed("rate_limited", retryable=True))
    with pytest.raises(JudgmentFailed) as e:
        await run()
    assert e.value.reason == "rate_limited" and e.value.retryable is True


def _rows():
    conn = connect()
    try:
        return [
            tuple(r)
            for r in conn.execute(
                "SELECT conversation, criterion_id, purpose, model, reuse_key FROM c_llm_calls ORDER BY id"
            )
        ]
    finally:
        conn.close()


async def test_calls_are_logged(scripted: ScriptedCalls, db) -> None:
    scripted.script.append(VALID_C01_NO)
    j = await run()
    assert _rows() == [
        ("DEV:test", "c01", "criterion", "claude-haiku-5-5", j.reuse_key)
    ]


async def test_retry_and_failure_calls_are_logged(scripted: ScriptedCalls, db) -> None:
    wrong = bad(answer="na", na_reason="r")
    scripted.script.extend([wrong, wrong])
    with pytest.raises(JudgmentFailed):
        await run()
    assert len(_rows()) == 2


async def test_copied_checklist_with_replaced_criterion(
    scripted: ScriptedCalls, db
) -> None:
    cl = make_checklist()
    new = make_criterion(
        id="c03", order=3, wording="Совсем новая формулировка", fingerprint="9" * 64
    )
    cl2 = make_checklist([*cl.criteria[:2], new, *cl.criteria[3:]])
    scripted.script.append(VALID_C01_NO)
    j = await run(new, checklist=cl2)
    assert j.criterion_id == "c03"
    assert "Совсем новая формулировка" in scripted.calls[0]["blocks"][1]["text"]


def test_retry_block_lists_problems() -> None:
    blk = judge.retry_block(
        [
            Problem(CHECKED_RANGE_MISSING, "need range"),
            Problem("quote_mismatch", "bad quote", 0),
        ]
    )
    assert blk["type"] == "text" and "cache_control" not in blk
    assert (
        "checked_range_missing: need range" in blk["text"]
        and "quote_mismatch: bad quote" in blk["text"]
    )


def test_to_judgment_low_confidence_forces_review() -> None:
    from evaluator.schemas import CriterionOutput

    out = CriterionOutput.model_validate(bad(confidence="low"))
    j = judge.to_judgment(
        out,
        criterion=make_criterion(),
        model=MODEL,
        reuse_key="k",
        calls=[],
        needs_review=False,
    )
    assert j.needs_review is True
    assert copy.deepcopy(j).answer == "no"


async def test_invalid_checked_range_dropped_and_flagged(scripted: ScriptedCalls, db) -> None:
    badrange = bad(checked_range={"from_index": 0, "to_index": 99})
    scripted.script.extend([badrange, badrange])
    j = await run()
    assert j.checked_range is None and j.needs_review is True and len(scripted.calls) == 2


async def test_failed_judgment_keeps_all_paid_calls(scripted: ScriptedCalls, db) -> None:
    wrong = bad(answer="na", na_reason="r")
    scripted.script.extend([wrong, wrong])
    with pytest.raises(JudgmentFailed) as e:
        await run()
    assert len(e.value.calls) == 2 and len(_rows()) == 2


async def test_failure_on_retry_keeps_first_call_and_the_failed_record(scripted: ScriptedCalls, db) -> None:
    from evaluator.testing import make_record

    scripted.script.extend([BAD_INDEX, JudgmentFailed("schema", calls=[make_record()])])
    with pytest.raises(JudgmentFailed) as e:
        await run()
    assert e.value.reason == "schema" and len(e.value.calls) == 2 and len(_rows()) == 2


async def test_first_call_failure_record_is_logged(scripted: ScriptedCalls, db) -> None:
    from evaluator.testing import make_record

    scripted.script.append(JudgmentFailed("max_tokens", calls=[make_record()]))
    with pytest.raises(JudgmentFailed) as e:
        await run()
    assert len(e.value.calls) == 1 and len(_rows()) == 1


async def test_na_reason_dropped_when_answer_is_not_na(scripted: ScriptedCalls, db) -> None:
    scripted.script.append(bad(na_reason="лишнее"))
    j = await run()
    assert j.answer == "no" and j.na_reason is None


async def test_na_reason_kept_for_na(scripted: ScriptedCalls, db) -> None:
    cl = make_checklist()
    na = bad(answer="na", na_reason="условие", evidence=[], coaching=None)
    scripted.script.append(na)
    j = await run(cl.criteria[1], checklist=cl)
    assert j.answer == "na" and j.na_reason == "условие"


def _break_log(monkeypatch):
    from evaluator import cost

    def boom(*a, **k):
        raise RuntimeError("db down")

    monkeypatch.setattr(cost, "log_calls", boom)


async def test_log_failure_does_not_mask_result(scripted: ScriptedCalls, db, monkeypatch) -> None:
    _break_log(monkeypatch)
    scripted.script.append(VALID_C01_NO)
    assert (await run()).answer == "no"


async def test_log_failure_does_not_mask_the_real_error(scripted: ScriptedCalls, db, monkeypatch) -> None:
    _break_log(monkeypatch)
    wrong = bad(answer="na", na_reason="r")
    scripted.script.extend([wrong, wrong])
    with pytest.raises(JudgmentFailed) as e:
        await run()
    assert e.value.reason == "invalid_answer"
