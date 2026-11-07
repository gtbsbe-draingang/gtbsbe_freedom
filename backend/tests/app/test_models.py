"""The shared models serialise to the contract (section 7 of the front-end design).

Fixtures: until the contract/ folder (stream A) exists at the repo root, the examples are the
invented ones in tests/app/contract_examples/. Once contract/ lands the tests read
contract/examples/ and contract/schemas/ instead, and the fallback folder is deleted.
"""

import json
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ValidationError

from app.models import (
    Analytics,
    Appeal,
    ChecklistVersion,
    CheckedRange,
    Comparison,
    Config,
    Conversation,
    CriterionResult,
    DryRun,
    ErrorBody,
    Evaluation,
    ImportSummary,
    Job,
    LLMCallRecord,
    Message,
    QueueItem,
    StepAnswer,
    dump,
)

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]

if (REPO_ROOT / "contract").is_dir():
    CONTRACT_DIR = REPO_ROOT / "contract"
    EXAMPLES_DIR = CONTRACT_DIR / "examples"
else:
    CONTRACT_DIR = HERE / "contract_examples"
    EXAMPLES_DIR = CONTRACT_DIR
SCHEMAS_DIR = CONTRACT_DIR / "schemas"

# File-name prefix -> model. None: a shape that is not a backend model here (the evaluator,
# quality and seed code own them), so its examples are skipped.
MODELS: dict[str, type[BaseModel] | None] = {
    "conversation": Conversation,
    "queue-item": QueueItem,
    "checklist-version": ChecklistVersion,
    "evaluation": Evaluation,
    "appeal": Appeal,
    "job": Job,
    "config": Config,
    "comparison": Comparison,
    "analytics": Analytics,
    "dry-run": DryRun,
    "import-summary": ImportSummary,
    "error": ErrorBody,
    "accuracy": None,
    "translation": None,
    "checklist-seed": None,
}


def example_key(path: Path) -> str:
    """The longest mapping key the file stem starts with, so a longer key always wins."""
    keys = [key for key in MODELS if path.stem.startswith(key)]
    assert keys, f"{path.name} matches no key of MODELS"
    return max(keys, key=len)


def examples() -> list[Path]:
    return sorted(
        path for path in EXAMPLES_DIR.glob("*.json") if MODELS[example_key(path)] is not None
    )


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


EXAMPLES = examples()


# --- the contract examples -----------------------------------------------------------------


def test_mapping_uses_the_longest_key() -> None:
    assert example_key(Path("checklist-version-2.json")) == "checklist-version"
    assert example_key(Path("checklist-seed-official.json")) == "checklist-seed"
    assert example_key(Path("dry-run.json")) == "dry-run"
    assert example_key(Path("evaluation-gross-error.json")) == "evaluation"


def test_every_shape_has_an_example() -> None:
    present = {example_key(path) for path in EXAMPLES_DIR.glob("*.json")}
    expected = {key for key, model in MODELS.items() if model is not None}
    assert expected - present == set()


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_every_contract_example_parses(path: Path) -> None:
    model = MODELS[example_key(path)]
    assert model is not None
    model.model_validate(load(path))


@pytest.mark.skipif(not SCHEMAS_DIR.is_dir(), reason="waiting for contract/schemas")
@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_dump_validates_against_schema(path: Path) -> None:
    from jsonschema import Draft202012Validator
    from referencing import Registry, Resource
    from referencing.jsonschema import DRAFT202012

    schemas = {file.name: load(file) for file in SCHEMAS_DIR.glob("*.schema.json")}
    registry: Registry = Registry()
    for name, schema in schemas.items():
        resource = Resource.from_contents(schema, default_specification=DRAFT202012)
        registry = registry.with_resources(
            [(schema.get("$id", name), resource), (f"cqa/{name}", resource), (name, resource)]
        )
    key = example_key(path)
    schema = schemas.get(f"{key}.schema.json")
    assert schema is not None, f"contract/schemas/{key}.schema.json is missing"
    model = MODELS[key]
    assert model is not None
    body = dump(model.model_validate(load(path)))
    Draft202012Validator(schema, registry=registry).validate(body)


def _assert_keys_kept(example: Any, dumped: Any, where: str) -> None:
    """Every key of the example must survive the round trip through the model."""
    if isinstance(example, dict):
        assert isinstance(dumped, dict), f"{where}: expected an object"
        for key, value in example.items():
            if key in {"reuse_key", "calls"}:  # internal, never sent to the UI
                continue
            assert key in dumped, f"{where}.{key} was dropped by the model"
            _assert_keys_kept(value, dumped[key], f"{where}.{key}")
    elif isinstance(example, list):
        assert isinstance(dumped, list) and len(dumped) == len(example), f"{where}: list differs"
        for index, (a, b) in enumerate(zip(example, dumped, strict=True)):
            _assert_keys_kept(a, b, f"{where}[{index}]")


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.name)
def test_dump_keeps_every_example_field(path: Path) -> None:
    model = MODELS[example_key(path)]
    assert model is not None
    data = load(path)
    _assert_keys_kept(data, dump(model.model_validate(data)), path.name)


# --- numbers -------------------------------------------------------------------------------


def _result(**override: Any) -> CriterionResult:
    base: dict[str, Any] = {
        "criterion_id": "c01",
        "answer": "yes",
        "explanation": "because",
        "confidence": "high",
        "model": "claude-haiku-5-5",
        "reuse_key": "k",
        "points": Decimal("10.00"),
        "effective_weight": Decimal("10"),
    }
    return CriterionResult(**{**base, **override})


def _evaluation(**override: Any) -> Evaluation:
    base: dict[str, Any] = {
        "id": "eval-1",
        "created_at": datetime(2026, 11, 7, 9, 0, tzinfo=UTC),
        "conversation": "demo:demo-ru-001",
        "checklist_id": "demo-checklist",
        "version": 1,
        "status": "done",
        "model": "claude-haiku-5-5",
        "cost_usd": Decimal("0.0042"),
        "results": [_result()],
        "original_total": Decimal("84.17"),
        "final_total": None,
        "sections": [
            {
                "section_id": "s1",
                "points": Decimal("50.5"),
                "available": Decimal("60"),
                "percent": Decimal("84.17"),
            }
        ],
        "gross_error": {"flag": False},
    }
    return Evaluation(**{**base, **override})


def test_numbers_are_json_numbers() -> None:
    body = dump(_evaluation())
    assert body["original_total"] == 84.17
    assert type(body["original_total"]) is float
    assert type(body["cost_usd"]) is float
    assert body["final_total"] is None
    section = body["sections"][0]
    assert [type(section[k]) for k in ("points", "available", "percent")] == [float] * 3
    result = body["results"][0]
    assert type(result["points"]) is float
    assert type(result["effective_weight"]) is float
    assert json.dumps(body)  # the whole dump is plain JSON


def test_every_decimal_in_the_shared_models_is_a_json_number() -> None:
    call = LLMCallRecord(
        purpose="criterion",
        model="m",
        input_tokens=1,
        output_tokens=2,
        cost_usd=Decimal("0.001"),
        latency_ms=5,
    )
    assert type(call.model_dump(mode="json")["cost_usd"]) is float
    checklist = ChecklistVersion.model_validate(load(EXAMPLES_DIR / "checklist-version.json"))
    weights = [c["weight"] for c in dump(checklist)["criteria"]]
    assert weights == [10, 10.5, 20, 10, 10, 0]
    assert all(type(w) is float for w in weights)
    config = dump(
        Config(
            models=["m"],
            prices={"m": {"input": Decimal("0.10")}},
            model_key_configured=True,
            default_checklist={},
        )
    )
    assert config["prices"] == {"m": {"input": 0.1}}
    assert type(config["prices"]["m"]["input"]) is float


def test_python_mode_keeps_exact_decimals() -> None:
    # The storage layer can persist exact values; only JSON output turns them into floats.
    evaluation = _evaluation()
    assert evaluation.model_dump()["original_total"] == Decimal("84.17")
    assert isinstance(evaluation.results[0].points, Decimal)


def test_json_float_input_becomes_the_exact_decimal() -> None:
    assert _result(points=84.17).points == Decimal("84.17")
    assert _evaluation(original_total=84.17).original_total == Decimal("84.17")


# --- answers, ranges, conversation ---------------------------------------------------------


def test_step_answer_shape() -> None:
    result = _result(answer=StepAnswer(step=15))
    assert result.model_dump(mode="json")["answer"] == {"step": 15}
    assert _result(answer={"step": 15}).answer == StepAnswer(step=15)
    with pytest.raises(ValidationError):
        _result(answer={"step": "15"})
    with pytest.raises(ValidationError):
        _result(answer={"step": True})
    with pytest.raises(ValidationError):
        StepAnswer.model_validate({"step": "15"})


def test_checked_range_alias() -> None:
    parsed = CheckedRange.model_validate({"from": 3, "to": 9})
    assert (parsed.from_, parsed.to) == (3, 9)
    assert parsed.model_dump(mode="json", by_alias=True) == {"from": 3, "to": 9}
    assert CheckedRange(from_=3, to=9) == parsed
    result = _result(checked_range={"from": 1, "to": 2})
    assert dump(_evaluation(results=[result]))["results"][0]["checked_range"] == {
        "from": 1,
        "to": 2,
    }


def test_conversation_has_no_audio_url() -> None:
    assert "audio_url" not in Conversation.model_fields
    assert "audio_url" not in QueueItem.model_fields
    data = load(EXAMPLES_DIR / "conversation-chat-handover.json")
    parsed = Conversation.model_validate({**data, "audio_url": "x"})
    assert "audio_url" not in dump(parsed)
    assert not hasattr(parsed, "audio_url")


def test_unknown_speaker_kept() -> None:
    assert Message(timestamp="00:01", speaker="agent", text="hi").speaker == "agent"
    assert Message(timestamp="00:01", speaker="bot", text="hi").speaker == "bot"
    assert Message(timestamp="00:01", speaker="client", text="hi").duplicate is False


def test_queue_item_dump_has_no_transcript() -> None:
    data = load(EXAMPLES_DIR / "queue-item.json")
    line = {"timestamp": "00:01", "speaker": "client", "text": "hi"}
    item = QueueItem.model_validate({**data, "transcript": [line]})
    body = dump(item)
    assert "transcript" not in body
    assert body["final"]["total"] == 62.5
    assert QueueItem.model_validate(data).transcript == []
    assert QueueItem.model_validate({**data, "final": None}).final is None


def test_checklist_version_id_defaults_to_checklist_and_version() -> None:
    data = load(EXAMPLES_DIR / "checklist-version.json")
    without_id = {k: v for k, v in data.items() if k not in {"id", "created_at"}}
    parsed = ChecklistVersion.model_validate(without_id)
    assert parsed.id == "demo-checklist:2"
    assert parsed.created_at is None
    assert ChecklistVersion.model_validate({**without_id, "id": "custom"}).id == "custom"


# --- dump() --------------------------------------------------------------------------------


def test_evaluation_dump_hides_calls() -> None:
    call = LLMCallRecord(
        purpose="criterion",
        model="claude-haiku-5-5",
        input_tokens=100,
        output_tokens=20,
        cost_usd=Decimal("0.0001"),
        latency_ms=800,
        reuse_key="k",
    )
    evaluation = _evaluation(results=[_result(calls=[call])])
    assert evaluation.results[0].calls == [call]  # kept in memory for the store
    result = dump(evaluation)["results"][0]
    assert "calls" not in result
    assert "reuse_key" not in result
    assert result["model"] == "claude-haiku-5-5"
    assert result["criterion_id"] == "c01"


def test_dump_uses_aliases_for_other_models() -> None:
    comparison = Comparison.model_validate(load(EXAMPLES_DIR / "comparison.json"))
    body = dump(comparison)
    assert set(body) == {"from", "to", "summary", "rows"}
    assert body["from"]["version"] == 1
    assert body["rows"][2]["delta"] is None
    assert type(body["summary"]["avg_delta"]) is float
    assert Comparison.model_validate(body) == comparison


def test_dump_leaves_datetimes_as_iso_strings() -> None:
    assert dump(_evaluation())["created_at"] == "2026-11-07T09:00:00Z"
    chat = Conversation.model_validate(load(EXAMPLES_DIR / "conversation-chat-handover.json"))
    assert dump(chat)["created_at"] == "2026-11-07T08:00:00Z"


def test_call_conversation_keeps_original_timestamps_and_needs_import_reason() -> None:
    data = load(EXAMPLES_DIR / "conversation-call-needs-import.json")
    body = dump(Conversation.model_validate(data))
    assert body["audio"] is None
    assert body["audio_unavailable_reason"] == "needs_import"
    assert [m["timestamp"] for m in body["transcript"]] == [
        m["timestamp"] for m in data["transcript"]
    ]


def test_error_body_and_import_summary_shapes() -> None:
    assert dump(ErrorBody(error="not_found", message="No such dialogue")) == {
        "error": "not_found",
        "message": "No such dialogue",
    }
    assert dump(ImportSummary(group_id="g", total=3, imported=1, updated=1, unchanged=1)) == {
        "group_id": "g",
        "total": 3,
        "imported": 1,
        "updated": 1,
        "unchanged": 1,
    }
