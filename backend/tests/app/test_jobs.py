"""Evaluation jobs (Task 8, issue #10): reuse, full mode, dry run, retry, recovery.

Stream C's evaluator is replaced by tests.app.fakes.FakeEvaluator (no network, no Claude API).
The checklist is the official one: seeded from stream A's file when it is on the branch, built
inline otherwise (`ensure_official`), so these tests pass either way.
"""

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import evaluator_port, jobs, store
from app.models import ChecklistVersion, Evaluation, Job, JobItem, StepAnswer
from app.settings import get_settings
from tests.app.fakes import FakeEvaluator, copy_body, ensure_official, load_dev_subset

MakeClient = Callable[..., TestClient]
KEY = {"ANTHROPIC_API_KEY": "test-key"}
FAILING = "DEV:p1-ru-012"

REPO_ROOT = Path(__file__).resolve().parents[3]
SCHEMAS_DIR = REPO_ROOT / "contract" / "schemas"


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "RETRY_DELAY_SECONDS", 0)


@pytest.fixture
def fake() -> Iterator[FakeEvaluator]:
    evaluator = FakeEvaluator()
    jobs.set_evaluator(evaluator)
    yield evaluator
    jobs.reset_evaluator()


@pytest.fixture
def setup(make_client: MakeClient, fake: FakeEvaluator) -> Callable[..., tuple[TestClient, list[str], ChecklistVersion]]:
    def factory(**env: str) -> tuple[TestClient, list[str], ChecklistVersion]:
        client = make_client(**{**KEY, **env})
        return client, load_dev_subset(), ensure_official()

    return factory


# --- helpers -------------------------------------------------------------------------------


def body(conversations: list[str], version: ChecklistVersion, **extra) -> dict:
    return {
        "conversations": conversations,
        "checklist_id": version.checklist_id,
        "version": version.version,
        "role": "controller",
        **extra,
    }


def dry_run(client: TestClient, conversations: list[str], version: ChecklistVersion, **extra) -> dict:
    r = client.post("/api/evaluations", json=body(conversations, version, dry_run=True, **extra))
    assert r.status_code == 200, r.text
    return r.json()


def wait(client: TestClient, job_id: str) -> dict:
    client.portal.call(jobs.wait_for_job, job_id)
    r = client.get(f"/api/jobs/{job_id}")
    assert r.status_code == 200, r.text
    return r.json()


def run(client: TestClient, conversations: list[str], version: ChecklistVersion, **extra) -> dict:
    r = client.post("/api/evaluations", json=body(conversations, version, **extra))
    assert r.status_code == 201, r.text
    started = r.json()
    Job.model_validate(started)
    return wait(client, started["id"])


def retry(client: TestClient, job_id: str) -> dict:
    r = client.post(f"/api/jobs/{job_id}/retry", json={"role": "controller"})
    assert r.status_code == 200, r.text
    return wait(client, job_id)


def evaluation(client: TestClient, evaluation_id: str) -> dict:
    r = client.get(f"/api/evaluations/{evaluation_id}")
    assert r.status_code == 200, r.text
    return r.json()


def evaluations_of(client: TestClient, job: dict) -> dict[str, dict]:
    return {item["conversation"]: evaluation(client, item["evaluation_id"]) for item in job["items"]}


def save_copy(client: TestClient, version: ChecklistVersion, change: Callable[[dict], None]) -> ChecklistVersion:
    copied = copy_body(version)
    change(copied)
    r = client.post("/api/checklists", json={"role": "controller", "checklist": copied})
    assert r.status_code == 201, r.text
    saved = r.json()
    return ChecklistVersion.model_validate({k: v for k, v in saved.items() if k != "warnings"})


def criterion(copied: dict, criterion_id: str) -> dict:
    return next(c for c in copied["criteria"] if c["id"] == criterion_id)


# --- the brief's tests ---------------------------------------------------------------------


def test_dry_run_counts(setup) -> None:
    client, ids, official = setup()
    assert dry_run(client, ids, official) == {"total": 6, "model_calls": 48, "reused": 0}
    job = run(client, ids, official, mode="full")
    assert job["status"] == "done"
    assert dry_run(client, ids, official) == {"total": 6, "model_calls": 0, "reused": 48}
    # a dry run in full mode ignores the cache
    assert dry_run(client, ids, official, mode="full") == {"total": 6, "model_calls": 48, "reused": 0}


def test_dry_run_starts_nothing(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    payload = body(ids, official, dry_run=True)
    del payload["role"]  # a dry run changes nothing, so it needs no role
    r = client.post("/api/evaluations", json=payload)
    assert r.status_code == 200
    assert fake.calls == 0
    assert store.list_jobs() == []


def test_weight_only_change_makes_no_calls(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.answers = {"c01": "no"}
    first = run(client, ids, official)
    assert fake.calls == 48

    def heavier_c01(copied: dict) -> None:
        criterion(copied, "c01")["weight"] = 20

    copy = save_copy(client, official, heavier_c01)
    fake.calls = 0
    second = run(client, ids, copy)
    assert fake.calls == 0
    assert second["status"] == "done" and second["done"] == 6

    before, after = evaluations_of(client, first), evaluations_of(client, second)
    for conversation in ids:
        old, new = before[conversation], after[conversation]
        assert [r["answer"] for r in old["results"]] == [r["answer"] for r in new["results"]]
        assert all(r["reused"] for r in new["results"])
        assert new["cost_usd"] == 0
        # only the weights differ: 90 of 100 before, 90 of 110 after
        assert old["final_total"] == 90.0
        assert new["final_total"] == 81.82
        c01_old = old["results"][0]
        c01_new = new["results"][0]
        assert (c01_old["effective_weight"], c01_new["effective_weight"]) == (10.0, 18.18)


def test_replaced_criterion_calls_only_that_criterion(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    run(client, ids, official)

    def replace_c06(copied: dict) -> None:
        c06 = criterion(copied, "c06")
        c06.update(id="c06b", title="Скорость ответа", wording="Оцените скорость ответов оператора.")

    copy = save_copy(client, official, replace_c06)
    fake.calls, fake.judged = 0, []
    job = run(client, ids, copy)
    assert job["status"] == "done"
    assert fake.calls == 6
    assert fake.judged_criteria() == {"c06b"}
    for ev in evaluations_of(client, job).values():
        by_id = {r["criterion_id"]: r for r in ev["results"]}
        assert by_id["c06b"]["reused"] is False
        assert all(r["reused"] for cid, r in by_id.items() if cid != "c06b")


def test_full_mode_ignores_cache(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    run(client, ids, official)
    fake.calls = 0
    job = run(client, ids, official, mode="full")
    assert job["mode"] == "full" and job["status"] == "done"
    assert fake.calls == 48
    assert not any(r["reused"] for ev in evaluations_of(client, job).values() for r in ev["results"])


def set_key(monkeypatch: pytest.MonkeyPatch, present: bool) -> None:
    if present:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    else:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    get_settings.cache_clear()


def test_no_key_needs_calls_409(setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch) -> None:
    client, ids, official = setup()
    set_key(monkeypatch, False)
    r = client.post("/api/evaluations", json=body(ids, official))
    assert r.status_code == 409
    assert r.json()["error"] == "model_key_missing"
    assert store.list_jobs() == []

    set_key(monkeypatch, True)
    run(client, ids, official)  # fills the cache
    set_key(monkeypatch, False)
    fake.calls = 0
    job = run(client, ids, official)  # everything cached: no key needed
    assert job["status"] == "done" and job["done"] == 6
    assert fake.calls == 0
    # a dry run without a key still answers
    assert dry_run(client, ids, official) == {"total": 6, "model_calls": 0, "reused": 48}


def test_failure_isolated_and_retry(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}
    job = run(client, ids, official)
    items = {item["conversation"]: item for item in job["items"]}
    assert items[FAILING]["status"] == "failed"
    assert items[FAILING]["error"] == "model_timeout"
    assert all(items[c]["status"] == "done" for c in ids if c != FAILING)
    assert (job["done"], job["failed"]) == (5, 1)
    assert job["status"] == "done"  # finished; `failed` says how many did not make it
    assert evaluation(client, items[FAILING]["evaluation_id"])["status"] == "failed"

    fake.fail_for = set()
    fake.judged = []
    retried = retry(client, job["id"])
    assert {conversation for conversation, _ in fake.judged} == {FAILING}
    assert retried["status"] == "done"
    assert (retried["done"], retried["failed"]) == (6, 0)
    item = next(i for i in retried["items"] if i["conversation"] == FAILING)
    assert item["error"] is None
    assert evaluation(client, item["evaluation_id"])["status"] == "done"


def test_parallelism_bounded(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup(MAX_PARALLEL_CALLS="2")
    run(client, ids, official)
    assert fake.max_concurrency == 2  # bounded, and the bound is actually used


def test_evaluation_shape(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    first = run(client, ids[:1], official)
    ev = evaluation(client, first["items"][0]["evaluation_id"])

    Evaluation.model_validate(ev)
    if SCHEMAS_DIR.is_dir():  # stream A's contract; until it lands, the model check above stands
        from jsonschema import Draft202012Validator

        schema = json.loads((SCHEMAS_DIR / "evaluation.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(ev)
        job_schema = json.loads((SCHEMAS_DIR / "job.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator(job_schema).validate(first)

    assert ev["status"] == "done" and ev["source"] == "model"
    assert ev["conversation"] == ids[0]
    assert (ev["checklist_id"], ev["version"]) == (official.checklist_id, official.version)
    assert [r["criterion_id"] for r in ev["results"]] == [c.id for c in official.criteria]
    assert ev["original_total"] == ev["final_total"] == 100.0
    assert all(r["final_answer"] == r["answer"] for r in ev["results"])
    assert all(r["carried_decision"] is None for r in ev["results"])
    assert not any("reuse_key" in r or "calls" in r for r in ev["results"])
    assert ev["model"] == "claude-haiku-5-5"
    assert ev["cost_usd"] == pytest.approx(0.009)  # 8 criterion calls + 1 dialog-info call
    assert not any(r["reused"] for r in ev["results"])
    gross = ev["results"][-1]
    assert gross["points"] is None and gross["effective_weight"] is None
    assert ev["gross_error"]["flag"] is False
    assert ev["gross_error"]["explanation"] == gross["explanation"]
    assert ev["sections"][-1] == {"section_id": "gross", "points": None, "available": None, "percent": None}

    second = run(client, ids[:1], official)
    again = evaluation(client, second["items"][0]["evaluation_id"])
    assert again["id"] != ev["id"]
    assert all(r["reused"] for r in again["results"])
    assert again["cost_usd"] == 0
    assert again["final_total"] == ev["final_total"]


def test_recover_interrupted(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    job = insert_stuck_job(ids[:2], official)

    jobs.recover_interrupted()

    stuck = client.get(f"/api/jobs/{job.id}").json()
    assert [i["status"] for i in stuck["items"]] == ["failed", "failed"]
    assert [i["error"] for i in stuck["items"]] == ["interrupted", "interrupted"]
    assert stuck["status"] == "failed" and stuck["failed"] == 2
    assert all(evaluation(client, i["evaluation_id"])["status"] == "failed" for i in stuck["items"])

    retried = retry(client, job.id)
    assert retried["status"] == "done" and retried["done"] == 2
    assert all(evaluation(client, i["evaluation_id"])["status"] == "done" for i in retried["items"])


# --- more behaviour ------------------------------------------------------------------------


def insert_stuck_job(conversations: list[str], version: ChecklistVersion) -> Job:
    """A job left behind by a process that died: one item running, one queued."""
    now = datetime.now(UTC)
    items = []
    for n, conversation in enumerate(conversations):
        status = "running" if n == 0 else "queued"
        ev = Evaluation(
            id=f"ev-stuck-{n}", created_at=now, conversation=conversation,
            checklist_id=version.checklist_id, version=version.version, status=status,
        )  # fmt: skip
        store.insert_evaluation(ev)
        items.append(JobItem(conversation=conversation, status=status, evaluation_id=ev.id))
    job = Job(
        id="job-stuck", created_at=now, status="running", mode="reuse",
        total=len(items), done=0, failed=0, items=items,
    )  # fmt: skip
    store.insert_job(job, version.checklist_id, version.version, "controller")
    return job


def test_recovery_runs_at_startup(make_client: MakeClient, fake: FakeEvaluator) -> None:
    make_client(**KEY)
    ids, official = load_dev_subset(), ensure_official()
    job = insert_stuck_job(ids[:2], official)
    restarted = make_client(**KEY)  # a new app on the same database: the lifespan recovers
    stuck = restarted.get(f"/api/jobs/{job.id}").json()
    assert [i["error"] for i in stuck["items"]] == ["interrupted", "interrupted"]


def test_first_criterion_runs_before_the_rest(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    run(client, ids, official)
    for conversation in ids:
        events = [(kind, cid) for kind, conv, cid in fake.events if conv == conversation]
        first = events[0][1]
        assert events[1] == ("end", first), events[:3]  # nothing else started before it ended
        assert len(events) == 16


def test_conversations_and_info_are_updated(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    run(client, ids, official)
    assert fake.info_calls == 6
    conv = client.get(f"/api/conversations/{ids[0]}").json()
    assert conv["status"] == "evaluated"
    assert conv["info"]["topic"] == "Fake topic"

    run(client, ids, official)
    assert fake.info_calls == 6  # info is stored once, not asked for again


def test_info_failure_is_ignored(setup, fake: FakeEvaluator, caplog: pytest.LogCaptureFixture) -> None:
    client, ids, official = setup()
    fake.info_fails = True
    job = run(client, ids[:1], official)
    assert job["status"] == "done" and job["done"] == 1
    assert client.get(f"/api/conversations/{ids[0]}").json()["info"] is None
    assert "sig=" not in caplog.text and "secret.example" not in caplog.text


def test_error_texts_never_carry_exception_messages(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}
    fake.failure = lambda: RuntimeError("boom https://secret.example/a?sig=LEAK")
    job = run(client, ids, official)
    item = next(i for i in job["items"] if i["conversation"] == FAILING)
    assert item["error"] == "RuntimeError"


@pytest.mark.parametrize(
    ("failure", "expected_error", "calls"),
    [
        # final refusal on the first criterion: the other seven are not launched
        (lambda: FakeEvaluator.JudgmentFailed("bad_answer", retryable=False), "bad_answer", 1),
        # retryable: every criterion is tried twice
        (lambda: FakeEvaluator.JudgmentFailed("overloaded", retryable=True), "overloaded", 16),
        (lambda: ValueError("x"), "ValueError", 16),
    ],
)
def test_retry_policy(setup, fake: FakeEvaluator, failure, expected_error, calls) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}
    fake.failure = failure
    job = run(client, [FAILING], official)
    assert job["items"][0]["error"] == expected_error
    assert fake.calls == calls


def test_model_key_missing_is_not_retried(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}
    fake.failure = lambda: FakeEvaluator.ModelKeyMissing()
    job = run(client, [FAILING], official)
    assert job["items"][0]["error"] == "model_key_missing"
    assert fake.calls == 1  # neither retried nor followed by the other criteria
    assert fake.info_calls == 0


def test_a_transient_failure_recovers_on_the_retry(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}

    def first_attempt_fails():
        criterion_id = fake.current
        if sum(1 for _, cid in fake.judged if cid == criterion_id) == 1:
            return FakeEvaluator.JudgmentFailed("overloaded", retryable=True)
        return None

    fake.failure = first_attempt_fails
    job = run(client, [FAILING], official)
    assert job["status"] == "done" and job["done"] == 1
    assert fake.calls == 16


def test_invalid_answer_fails_the_item(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.answers = {"c06": {"step": 3}}  # not a step of c06's scale
    job = run(client, ids[:1], official)
    assert job["items"][0]["status"] == "failed"
    assert job["items"][0]["error"] == "validation:step_not_in_scale"
    # the valid judgments were cached, the invalid one was not
    fake.answers, fake.judged = {}, []
    retry(client, job["id"])
    assert fake.judged_criteria() == {"c06"}


def test_retry_needs_a_key_when_calls_are_needed(
    setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}
    job = run(client, ids, official)
    set_key(monkeypatch, False)
    r = client.post(f"/api/jobs/{job['id']}/retry", json={"role": "controller"})
    assert r.status_code == 409 and r.json()["error"] == "model_key_missing"
    assert client.get(f"/api/jobs/{job['id']}").json()["failed"] == 1  # nothing was reset


def test_retry_with_nothing_failed_returns_the_job(setup) -> None:
    client, ids, official = setup()
    job = run(client, ids[:1], official)
    r = client.post(f"/api/jobs/{job['id']}/retry", json={"role": "controller"})
    assert r.status_code == 200 and r.json()["status"] == "done"


def test_request_errors(setup) -> None:
    client, ids, official = setup()
    r = client.post("/api/evaluations", json=body([*ids, "DEV:nope"], official))
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    r = client.post("/api/evaluations", json={**body(ids, official), "version": 99})
    assert r.status_code == 404 and r.json()["error"] == "not_found"
    r = client.post("/api/evaluations", json=body([], official))
    assert r.status_code == 422
    no_role = body(ids, official)
    del no_role["role"]
    r = client.post("/api/evaluations", json=no_role)
    assert r.status_code == 422
    r = client.post("/api/evaluations", json={**body(ids, official), "role": "admin"})
    assert r.status_code == 422
    assert client.get("/api/jobs/nope").status_code == 404
    assert client.post("/api/jobs/nope/retry", json={"role": "controller"}).status_code == 404
    assert client.post("/api/jobs/nope/retry", json={}).status_code == 422
    assert client.get("/api/evaluations/nope").status_code == 404
    assert store.list_jobs() == []


def test_duplicate_conversations_are_evaluated_once(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    job = run(client, [ids[0], ids[0]], official)
    assert job["total"] == 1 and fake.calls == 8


def test_job_progress_is_visible_while_running(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.delay = 0.05
    r = client.post("/api/evaluations", json=body(ids, official))
    started = r.json()
    assert started["status"] in ("queued", "running")
    assert started["total"] == 6 and started["done"] == 0
    assert all(i["evaluation_id"] for i in started["items"])
    assert evaluation(client, started["items"][0]["evaluation_id"])["status"] in ("queued", "running")
    finished = wait(client, started["id"])
    assert finished["status"] == "done"


def test_no_evaluator_is_503(make_client: MakeClient, monkeypatch: pytest.MonkeyPatch) -> None:
    jobs.reset_evaluator()
    monkeypatch.setattr(evaluator_port, "_import_evaluator", lambda: None)
    client = make_client(**KEY)
    ids, official = load_dev_subset(), ensure_official()
    r = client.post("/api/evaluations", json=body(ids, official, dry_run=True))
    assert r.status_code == 503 and r.json()["error"] == "evaluator_unavailable"


def test_judgment_cache_is_keyed_by_reuse_key(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    run(client, ids[:1], official)
    conv = store.get_conversation(ids[0])
    c01 = official.criteria[0]
    key = fake.reuse_key(conv, official, c01, "claude-haiku-5-5")
    cached = store.get_judgments([key])
    assert cached[key].criterion_id == "c01"
    assert cached[key].answer == "yes"


def test_cost_counts_only_new_calls(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    job = run(client, ids[:1], official)
    ev = evaluation(client, job["items"][0]["evaluation_id"])
    assert Decimal(str(ev["cost_usd"])) == Decimal("0.009")


# --- fix round 1 ---------------------------------------------------------------------------


def test_start_item_failure_leaves_a_retryable_item(
    setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    client, ids, official = setup()
    real = store.start_item

    def flaky(job_id: str, conversation: str):
        if conversation == FAILING:
            raise RuntimeError("database is locked at https://secret.example/?sig=LEAK")
        return real(job_id, conversation)

    monkeypatch.setattr(store, "start_item", flaky)
    job = run(client, ids, official)
    item = next(i for i in job["items"] if i["conversation"] == FAILING)
    assert item["status"] == "queued" and job["status"] == "running" and job["done"] == 5
    assert "RuntimeError" in caplog.text and "sig=" not in caplog.text

    monkeypatch.setattr(store, "start_item", real)
    retried = retry(client, job["id"])  # a queued item no run owns is picked up
    assert retried["status"] == "done" and retried["done"] == 6


def test_finish_item_failure_falls_back_to_store_failed(
    setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ids, official = setup()
    real = store.finish_item

    def flaky(job_id, conversation, *, evaluation=None, error=None):
        if conversation == FAILING and error is None:
            raise RuntimeError("disk I/O error")
        return real(job_id, conversation, evaluation=evaluation, error=error)

    monkeypatch.setattr(store, "finish_item", flaky)
    job = run(client, ids, official)
    item = next(i for i in job["items"] if i["conversation"] == FAILING)
    assert (item["status"], item["error"]) == ("failed", "store_failed")

    monkeypatch.setattr(store, "finish_item", real)
    assert retry(client, job["id"])["done"] == 6


def test_both_finish_attempts_failing_leaves_a_retryable_item(
    setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, ids, official = setup()
    real = store.finish_item

    def broken(job_id, conversation, *, evaluation=None, error=None):
        if conversation == FAILING:
            raise RuntimeError("disk I/O error")
        return real(job_id, conversation, evaluation=evaluation, error=error)

    monkeypatch.setattr(store, "finish_item", broken)
    job = run(client, ids, official)
    item = next(i for i in job["items"] if i["conversation"] == FAILING)
    assert item["status"] == "running"  # stuck in the database, but owned by no run

    monkeypatch.setattr(store, "finish_item", real)
    assert retry(client, job["id"])["done"] == 6


def test_retry_does_not_reset_items_a_run_still_owns(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.delay = 0.05
    started = client.post("/api/evaluations", json=body(ids, official)).json()
    r = client.post(f"/api/jobs/{started['id']}/retry", json={"role": "controller"})
    assert r.status_code == 200
    assert r.json()["retries"] == []  # every unfinished item belongs to the running run
    wait(client, started["id"])
    assert fake.calls == 48  # nothing ran twice


def test_retry_records_the_role(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}
    job = run(client, ids, official)
    assert job["retries"] == []
    fake.fail_for = set()
    r = client.post(f"/api/jobs/{job['id']}/retry", json={"role": "reviewer"})
    assert r.status_code == 200
    retries = wait(client, job["id"])["retries"]
    assert len(retries) == 1
    assert retries[0]["role"] == "reviewer" and retries[0]["items"] == [FAILING]
    assert datetime.fromisoformat(retries[0]["at"]).tzinfo is not None


def test_invalid_cached_answer_counts_as_a_call(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    run(client, ids[:1], official)
    conv = store.get_conversation(ids[0])
    c06 = next(c for c in official.criteria if c.id == "c06")
    key = fake.reuse_key(conv, official, c06, "claude-haiku-5-5")
    broken = store.get_judgments([key])[key].model_copy(update={"answer": StepAnswer(step=3)})
    store.save_judgment(broken)  # not a step of c06's scale

    assert dry_run(client, ids[:1], official) == {"total": 1, "model_calls": 1, "reused": 7}
    fake.judged = []
    job = run(client, ids[:1], official)
    assert job["status"] == "done"
    assert fake.judged == [(ids[0], "c06")]  # the run agrees with the estimate


def test_invalid_cached_answer_needs_a_key(setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch) -> None:
    client, ids, official = setup()
    run(client, ids[:1], official)
    conv = store.get_conversation(ids[0])
    c01 = official.criteria[0]
    key = fake.reuse_key(conv, official, c01, "claude-haiku-5-5")
    store.save_judgment(store.get_judgments([key])[key].model_copy(update={"answer": StepAnswer(step=1)}))
    set_key(monkeypatch, False)
    r = client.post("/api/evaluations", json=body(ids[:1], official))
    assert r.status_code == 409 and r.json()["error"] == "model_key_missing"


def test_two_jobs_share_the_limit(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup(MAX_PARALLEL_CALLS="2")
    fake.delay = 0.02
    first = client.post("/api/evaluations", json=body(ids[:3], official, mode="full")).json()
    second = client.post("/api/evaluations", json=body(ids[3:], official, mode="full")).json()
    wait(client, first["id"])
    wait(client, second["id"])
    assert fake.calls == 48
    assert fake.max_concurrency == 2


def test_unknown_conversation_is_404_even_without_an_evaluator(
    make_client: MakeClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    jobs.reset_evaluator()
    monkeypatch.setattr(evaluator_port, "_import_evaluator", lambda: None)
    client = make_client(**KEY)
    official = ensure_official()
    for dry in (True, False):
        r = client.post("/api/evaluations", json=body(["DEV:nope"], official, dry_run=dry))
        assert r.status_code == 404 and r.json()["error"] == "not_found"


def test_no_call_outlives_its_failed_item(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup()
    fake.fail_for = {FAILING}

    def c02_refused():
        if fake.current == "c02":
            return FakeEvaluator.JudgmentFailed("refused", retryable=False)
        return None

    fake.failure = c02_refused
    job = run(client, [FAILING], official)
    assert job["items"][0]["error"] == "refused"
    # the siblings were all awaited before the item was resolved
    assert fake.in_flight == 0
    assert [kind for kind, _, _ in fake.events].count("end") == 8
