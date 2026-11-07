"""S3 (#17): json_schema_for makes Pydantic schemas acceptable to the structured-output API."""

import json

from pydantic import BaseModel, Field

from evaluator.schemas import (
    UNSUPPORTED_SCHEMA_KEYS,
    CriterionOutput,
    InfoOutput,
    TranslationOutput,
    json_schema_for,
)


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def _objects(schema):
    return [n for n in _walk(schema) if n.get("type") == "object"]


def test_every_object_forbids_additional_properties() -> None:
    for model in (CriterionOutput, InfoOutput, TranslationOutput):
        schema = json_schema_for(model)
        objs = _objects(schema)
        assert objs and all(o.get("additionalProperties") is False for o in objs)
    assert (
        len(_objects(json_schema_for(CriterionOutput))) >= 3
    )  # root + evidence + range ($defs)


def test_unsupported_keys_removed() -> None:
    class Limited(BaseModel):
        text: str = Field(max_length=5)

    assert "maxLength" in json.dumps(Limited.model_json_schema())  # the premise
    for model in (CriterionOutput, InfoOutput, TranslationOutput, Limited):
        for node in _walk(json_schema_for(model)):
            assert not (UNSUPPORTED_SCHEMA_KEYS & set(node)), node


def test_property_names_are_not_mistaken_for_keywords() -> None:
    class Odd(BaseModel):
        pattern: str
        minimum: int
        maxItems: list[str]

    props = json_schema_for(Odd)["properties"]
    assert set(props) == {"pattern", "minimum", "maxItems"}
    assert "items" in props["maxItems"]


def test_required_and_enums_kept_and_input_not_mutated() -> None:
    before = json.dumps(CriterionOutput.model_json_schema(), sort_keys=True)
    schema = json_schema_for(CriterionOutput)
    assert set(schema["required"]) == set(CriterionOutput.model_fields)
    assert schema["properties"]["answer"]["enum"] == ["yes", "no", "na", "step"]
    assert json.dumps(CriterionOutput.model_json_schema(), sort_keys=True) == before
    json.dumps(schema)  # serialisable
