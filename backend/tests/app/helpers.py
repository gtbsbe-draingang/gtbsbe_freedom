"""Helpers shared by the app tests that drive the API end to end (jobs, appeals, comparisons).

Import as `from tests.app.helpers import save_copy, ...`. They need a started TestClient (the
`make_client` fixture) and, for `file`, a `FakeEvaluator` installed with `jobs.set_evaluator`.
"""

import json
from collections.abc import Callable
from pathlib import Path

from fastapi.testclient import TestClient

from app import appeals
from app.models import ChecklistVersion
from tests.app.fakes import copy_body

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS_DIR = REPO_ROOT / "contract" / "schemas"


def save_copy(client: TestClient, version: ChecklistVersion, change: Callable[[dict], None]) -> ChecklistVersion:
    """Save a copy of `version` as a new checklist, after `change` edited the POST body."""
    copied = copy_body(version)
    change(copied)
    r = client.post("/api/checklists", json={"role": "controller", "checklist": copied})
    assert r.status_code == 201, r.text
    return ChecklistVersion.model_validate({k: v for k, v in r.json().items() if k != "warnings"})


def criterion(copied: dict, criterion_id: str) -> dict:
    return next(c for c in copied["criteria"] if c["id"] == criterion_id)


def validate(name: str, body: dict) -> None:
    """Validate `body` against contract/schemas/<name>.schema.json."""
    from jsonschema import Draft202012Validator

    schema = json.loads((SCHEMAS_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(body)


def file(client: TestClient, evaluation_id: str, criterion_id: str = "c04", **extra) -> dict:
    """File an appeal as the controller and wait for its second opinion; returns the stored appeal."""
    body = {"evaluation_id": evaluation_id, "criterion_id": criterion_id, "comment": "Не согласен.",
            "role": "controller", **extra}  # fmt: skip
    r = client.post("/api/appeals", json=body)
    assert r.status_code == 201, r.text
    client.portal.call(appeals.wait_for_second_opinions)
    return client.get(f"/api/appeals/{r.json()['id']}").json()


def decide(client: TestClient, appeal_id: str, outcome: str = "changed", answer=None, **extra) -> dict:
    """Decide an appeal as the reviewer; returns the recalculated evaluation."""
    body = {"outcome": outcome, "reason": "Оператор ответил полностью.", "role": "reviewer", **extra}
    if answer is not None:
        body["answer"] = answer
    r = client.post(f"/api/appeals/{appeal_id}/decision", json=body)
    assert r.status_code == 200, r.text
    return r.json()
