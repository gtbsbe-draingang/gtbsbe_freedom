"""Guards the evaluator's frozen surface so issues can be solved in parallel.

If this test fails, a PR changed a name or signature another issue relies on. Additive changes
(new functions, new optional params at the end) are fine: add them to FROZEN in the same PR.
Removing or renaming needs team agreement (PLAN.md rule 6).
"""

import importlib
import inspect
import subprocess
from pathlib import Path

import pytest

import evaluator
from evaluator import client
from evaluator.testing import (
    VALID_C01_NO,
    FakeAsyncAnthropic,
    make_checklist,
    make_conv,
    text_response,
)

FROZEN = {
    "masking.mask_text": "text",
    "masking.mask_transcript": "messages",
    "prompt.neutralize_tags": "text, tags=('transcript', 'appeal_comment')",
    "prompt.render_transcript": "conv, masked",
    "prompt.render_facts": "conv",
    "prompt.render_checklist_context": "checklist",
    "prompt.render_criterion": "checklist, criterion",
    "prompt.build_blocks": "conv, masked, checklist, criterion",
    "schemas.json_schema_for": "model",
    "client.set_client": "client",
    "client.get_client": "",
    "client.call_structured": "*, purpose, model, effort, system, blocks, output_type, reuse_key=None, max_tokens=16000",
    "cost.call_cost": "model, *, input_tokens, cache_write_tokens, cache_read_tokens, output_tokens",
    "cost.log_calls": "records, *, conversation, criterion_id",
    "cost.total_cost": "records",
    "keys.transcript_hash": "conv",
    "keys.reuse_key": "conv, checklist, criterion, model",
    "checking.normalize": "text",
    "checking.quote_matches": "quote, original, masked",
    "checking.check_answer": "answer, step, kinds, criterion",
    "checking.check_output": "out, criterion, conv, masked",
    "judge.retry_block": "problems",
    "judge.to_judgment": "out, *, criterion, model, reuse_key, calls, needs_review",
    "judge.judge_criterion": "conv, checklist, criterion, *, model",
    "info.dialog_info": "conv",
    "second_opinion.appeal_block": "result, comment",
    "second_opinion.second_opinion": "conv, checklist, criterion, result, comment",
    "translation.translate": "conv, to='ru'",
    "translation.load_translation": "conversation, lang",
    "translation.save_translation": "conversation, lang, texts",
    "devrun.load_dev_conversations": "path, group_id='DEV'",
    "devrun.load_expectations": "path=<path>",
    "devrun.check_expectations": "run, expectations",
    "devrun.run": "conversations, checklist_path, *, model=None, criteria=None, record_dir=None, with_info=True",
    "devrun.main": "argv=None",
    "run.evaluate": "dialogue, checklist, options=None",
}

PUBLIC = {
    "DictCache",
    "EvaluateOptions",
    "EvaluatorRun",
    "Failure",
    "JudgmentCache",
    "JudgmentFailed",
    "ModelKeyMissing",
    "dialog_info",
    "evaluate",
    "judge_criterion",
    "reuse_key",
    "second_opinion",
}


def _shape(fn) -> str:
    out, star = [], False
    for p in inspect.signature(fn).parameters.values():
        if p.kind is p.KEYWORD_ONLY and not star:
            out.append("*")
            star = True
        s = p.name
        if p.default is not p.empty:
            s += "=" + ("<path>" if hasattr(p.default, "__fspath__") else repr(p.default))
        out.append(s)
    return ", ".join(out)


@pytest.mark.parametrize("dotted", sorted(FROZEN))
def test_signature_frozen(dotted: str) -> None:
    module, name = dotted.split(".")
    fn = getattr(importlib.import_module(f"evaluator.{module}"), name)
    assert _shape(fn) == FROZEN[dotted]


def test_public_surface() -> None:
    assert set(evaluator.__all__) >= PUBLIC
    for name in PUBLIC:
        assert hasattr(evaluator, name)


def test_judgment_failed_shape() -> None:
    err = evaluator.JudgmentFailed("rate_limited", retryable=True, request_id="req_1")
    assert (err.reason, err.retryable, err.request_id) == ("rate_limited", True, "req_1")
    assert evaluator.JudgmentFailed("schema").retryable is False


def test_no_key_raises_model_key_missing() -> None:
    with pytest.raises(evaluator.ModelKeyMissing):
        client.get_client()


def test_factories_build_valid_models() -> None:
    checklist = make_checklist()
    assert [c.id for c in checklist.criteria] == [f"c0{i}" for i in range(1, 9)]
    assert checklist.criteria[-1].kind == "gross_error"
    conv = make_conv([("client", "Здравствуйте"), ("operator", "Привет, где именно ищете?")])
    assert conv.id == "DEV:test" and conv.transcript[1].timestamp == "00:10"
    call = make_conv([("client", "a"), ("operator", "b")], channel="voice call", duplicates={1})
    assert call.transcript[1].duplicate and "T" in call.transcript[0].timestamp


async def test_scripted_fixture_replaces_call_structured(scripted) -> None:
    from evaluator.schemas import CriterionOutput

    scripted.script.append(VALID_C01_NO)
    client.get_client()  # no ModelKeyMissing: a dummy client is injected
    out, record = await client.call_structured(
        purpose="criterion", model="m", effort="medium", system="", blocks=[], output_type=CriterionOutput
    )
    assert out.answer == "no" and record.purpose == "criterion"
    assert scripted.calls[0]["effort"] == "medium"


async def test_fake_anthropic_fixture(fake_anthropic: FakeAsyncAnthropic) -> None:
    fake_anthropic.script.append(text_response(VALID_C01_NO))
    assert client.get_client() is fake_anthropic
    resp = await fake_anthropic.messages.create(model="x")
    assert resp.content[-1].type == "text" and fake_anthropic.calls[0][0] == "messages"


def test_migrations_apply(db) -> None:
    from app.db import connect

    conn = connect()
    try:
        names = {r["name"] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()
    assert {"c_llm_calls", "c_translations"} <= names


def test_dict_cache_is_a_judgment_cache() -> None:
    assert isinstance(evaluator.DictCache(), evaluator.JudgmentCache)
    evaluator.EvaluateOptions(cache=evaluator.DictCache())


def test_output_schemas_forbid_extra() -> None:
    from pydantic import ValidationError

    from evaluator.schemas import CriterionOutput

    with pytest.raises(ValidationError):
        CriterionOutput.model_validate({**VALID_C01_NO, "extra": 1})


def test_no_secrets_in_evaluator_code() -> None:
    root = Path(__file__).resolve().parents[2]  # backend/
    out = subprocess.run(
        ["git", "grep", "--untracked", "-n", "-I", "-E", "sig=|sk-ant-", "--", "evaluator", 
         ":!evaluator/PLAN.md", ":!evaluator/MISTAKES.md", ":!evaluator/tests/test_scaffold.py"],
        cwd=root, capture_output=True, text=True,
    )
    assert out.stdout == "", out.stdout
