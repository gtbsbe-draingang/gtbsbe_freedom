"""Appeals, reviewer decisions, the second-opinion hook and carry-forward (Task 10, issue #12).

Stream C's evaluator is replaced by tests.app.fakes.FakeEvaluator (no network, no Claude API). The
fake answers with the T2 pattern of the front-end design (section 6): c01 yes, c02 N/A, c03 N/A,
c04 = 15, c05 yes, c06 = 7, c07 N/A, c08 no, which totals 84.17 on the official checklist.
"""

import logging
from collections.abc import Callable, Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient

from app import appeals, jobs, store
from app.models import Appeal, ChecklistVersion, Evaluation, StepAnswer
from app.scoring import ScoringError
from app.settings import get_settings
from app.transcript import normalize_record
from tests.app.fakes import FakeEvaluator, dev_records, ensure_official, load_dev_subset
from tests.app.helpers import criterion, decide, file, save_copy, validate

MakeClient = Callable[..., TestClient]
KEY = {"ANTHROPIC_API_KEY": "test-key"}
CHAT = "DEV:p1-ru-001"
OTHER = "DEV:p1-ru-010"

T2 = {
    "c01": "yes",
    "c02": "na",
    "c03": "na",
    "c04": StepAnswer(step=15),
    "c05": "yes",
    "c06": StepAnswer(step=7),
    "c07": "na",
    "c08": "no",
}


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "RETRY_DELAY_SECONDS", 0)


@pytest.fixture
def fake() -> Iterator[FakeEvaluator]:
    evaluator = FakeEvaluator()
    evaluator.answers = dict(T2)
    jobs.set_evaluator(evaluator)
    yield evaluator
    jobs.reset_evaluator()


@pytest.fixture
def setup(make_client: MakeClient, fake: FakeEvaluator) -> tuple[TestClient, ChecklistVersion]:
    client = make_client(**KEY)
    load_dev_subset()
    return client, ensure_official()


# --- helpers -------------------------------------------------------------------------------


def set_key(monkeypatch: pytest.MonkeyPatch, present: bool) -> None:
    if present:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    else:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    get_settings.cache_clear()


def grade(client: TestClient, version: ChecklistVersion, conversation: str = CHAT, **extra) -> dict:
    """Run one job on `conversation` and return its (done) evaluation."""
    body = {
        "conversations": [conversation],
        "checklist_id": version.checklist_id,
        "version": version.version,
        "role": "controller",
        **extra,
    }
    r = client.post("/api/evaluations", json=body)
    assert r.status_code == 201, r.text
    job_id = r.json()["id"]
    client.portal.call(jobs.wait_for_job, job_id)
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "done", job
    ev = client.get(f"/api/evaluations/{job['items'][0]['evaluation_id']}").json()
    assert ev["status"] == "done"
    return ev


def result(ev: dict, criterion_id: str) -> dict:
    return next(r for r in ev["results"] if r["criterion_id"] == criterion_id)


def heavier_c01(copied: dict) -> None:
    criterion(copied, "c01")["weight"] = 20


def reimport(transcript_edit: Callable[[list[dict]], None] | None = None, conversation_id: str = "p1-ru-001") -> None:
    record = next(r for r in dev_records() if r["conversation_id"] == conversation_id)
    record = {k: v for k, v in record.items() if k != "audio_url"}
    if transcript_edit is not None:
        transcript_edit(record["transcript"])
    conv, _ = normalize_record(record, "DEV")
    store.upsert_conversation(conv, None)


def edit_first_line(transcript: list[dict]) -> None:
    transcript[0]["text"] = transcript[0]["text"] + " (исправлено)"


def status_of(client: TestClient, conversation: str = CHAT) -> str:
    return client.get(f"/api/conversations/{conversation}").json()["status"]


# --- the brief's tests ---------------------------------------------------------------------


def test_change_recalculates(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    assert ev["original_total"] == ev["final_total"] == 84.17
    appeal = file(client, ev["id"])
    assert status_of(client) == "disputed"

    decided = decide(client, appeal["id"], answer={"step": 20})
    assert decided["id"] == ev["id"]
    assert decided["final_total"] == 92.5
    assert decided["original_total"] == 84.17
    c04 = result(decided, "c04")
    assert c04["answer"] == {"step": 15}
    assert c04["final_answer"] == {"step": 20}
    # points and effective weight follow the final answer: 20/20 of 100*20/60
    assert (c04["points"], c04["effective_weight"]) == (33.33, 33.33)
    safety = next(s for s in decided["sections"] if s["section_id"] == "safety")
    assert (safety["points"], safety["percent"]) == (33.33, 100.0)
    # stored, not only returned
    assert client.get(f"/api/evaluations/{ev['id']}").json() == decided
    assert status_of(client) == "evaluated"
    stored = client.get(f"/api/appeals/{appeal['id']}").json()
    assert stored["status"] == "decided"
    assert stored["decision"]["outcome"] == "changed"
    assert stored["decision"]["answer"] == {"step": 20}
    assert stored["decision"]["role"] == "reviewer"
    validate("evaluation", decided)


def test_confirm_keeps_total(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    appeal = file(client, ev["id"])
    decided = decide(client, appeal["id"], outcome="confirmed", answer={"step": 0})  # a sent answer is ignored
    assert decided["final_total"] == 84.17
    assert result(decided, "c04")["final_answer"] == {"step": 15}
    stored = client.get(f"/api/appeals/{appeal['id']}").json()
    assert stored["decision"]["outcome"] == "confirmed"
    assert stored["decision"]["answer"] == {"step": 15}  # the original answer


def test_confirm_needs_no_answer(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    appeal = file(client, ev["id"])
    assert decide(client, appeal["id"], outcome="confirmed")["final_total"] == 84.17


def test_one_open_appeal_per_criterion(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    first = file(client, ev["id"])
    body = {"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "Ещё раз.", "role": "controller"}
    r = client.post("/api/appeals", json=body)
    assert r.status_code == 409
    assert r.json()["error"] == "appeal_already_open"
    file(client, ev["id"], "c05")  # another criterion is fine

    decide(client, first["id"], answer={"step": 20})
    file(client, ev["id"])  # once decided, the criterion can be appealed again


def test_one_open_appeal_is_enforced_by_the_database(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    appeal = Appeal.model_validate(file(client, ev["id"]))
    twin = appeal.model_copy(update={"id": "twin"})
    with pytest.raises(store.AppealAlreadyOpen):
        store.insert_appeal(twin, fingerprint="f", transcript_hash="h")


def test_roles(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    body = {"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "x", "role": "reviewer"}
    r = client.post("/api/appeals", json=body)
    assert r.status_code == 403
    assert r.json()["error"] == "role_not_allowed"
    assert client.get("/api/appeals").json() == []

    appeal = file(client, ev["id"])
    r = client.post(
        f"/api/appeals/{appeal['id']}/decision",
        json={"outcome": "changed", "answer": {"step": 20}, "reason": "x", "role": "controller"},
    )
    assert r.status_code == 403
    assert r.json()["error"] == "role_not_allowed"
    assert client.get(f"/api/appeals/{appeal['id']}").json()["status"] == "open"


def test_role_is_required(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    r = client.post("/api/appeals", json={"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "x"})
    assert r.status_code == 422 and r.json()["error"] == "invalid_request"
    appeal = file(client, ev["id"])
    r = client.post(f"/api/appeals/{appeal['id']}/decision", json={"outcome": "confirmed", "reason": "x"})
    assert r.status_code == 422 and r.json()["error"] == "invalid_request"


def test_appeal_without_key(setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch) -> None:
    client, official = setup
    ev = grade(client, official)
    set_key(monkeypatch, False)
    r = client.post(
        "/api/appeals",
        json={"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "x", "role": "controller"},
    )
    assert r.status_code == 201
    created = r.json()
    assert created["second_opinion_status"] == "unavailable"
    assert created["second_opinion"] is None
    assert created["status"] == "open" and created["decision"] is None
    client.portal.call(appeals.wait_for_second_opinions)
    assert fake.second_opinions == 0
    # deciding never needs a key either
    assert decide(client, created["id"], answer={"step": 20})["final_total"] == 92.5


def test_appeal_without_evaluator(setup, monkeypatch: pytest.MonkeyPatch) -> None:
    client, official = setup
    ev = grade(client, official)
    monkeypatch.setattr(appeals, "find_evaluator", lambda: None)
    appeal = file(client, ev["id"])
    assert appeal["second_opinion_status"] == "unavailable"


def test_second_opinion_filled(setup, fake: FakeEvaluator) -> None:
    client, official = setup
    ev = grade(client, official)
    r = client.post(
        "/api/appeals",
        json={"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "x", "role": "controller"},
    )
    assert r.status_code == 201
    assert r.json()["second_opinion_status"] == "pending"
    client.portal.call(appeals.wait_for_second_opinions)
    appeal = client.get(f"/api/appeals/{r.json()['id']}").json()
    assert appeal["second_opinion_status"] == "done"
    assert appeal["second_opinion"]["answer"] == {"step": 15}
    assert appeal["second_opinion"]["reasoning"]
    assert fake.second_opinions == 1
    validate("appeal", appeal)


def test_second_opinion_failure_is_unavailable(
    setup, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    client, official = setup
    ev = grade(client, official)

    async def broken(*args, **kwargs):
        raise RuntimeError("boom at https://secret.example/x?sig=LEAK")

    monkeypatch.setattr(fake, "second_opinion", broken)
    with caplog.at_level(logging.WARNING):
        appeal = file(client, ev["id"])
    assert appeal["second_opinion_status"] == "unavailable"
    assert appeal["second_opinion"] is None
    assert "RuntimeError" in caplog.text
    assert "sig=LEAK" not in caplog.text


def test_carry_forward_weight_only(setup, fake: FakeEvaluator) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"])
    decide(client, appeal["id"], answer={"step": 20})

    copy = save_copy(client, official, heavier_c01)
    fake.calls = 0
    second = grade(client, copy)
    assert fake.calls == 0  # weight-only: everything reused
    c04 = result(second, "c04")
    assert c04["carried_decision"] == {"appeal_id": appeal["id"], "evaluation_id": first["id"]}
    assert c04["answer"] == {"step": 15}
    assert c04["final_answer"] == {"step": 20}
    # weights 20 + 20 + 15 + 15 = 70: the model's 15 gives 60.5 / 70, the decided 20 gives 65.5 / 70
    assert second["original_total"] == 86.43
    assert second["final_total"] == 93.57
    assert all(r["carried_decision"] is None for r in second["results"] if r["criterion_id"] != "c04")
    validate("evaluation", second)


def test_no_carry_on_replaced_criterion(setup) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"], "c06")
    decide(client, appeal["id"], answer={"step": 10})

    def replace_c06(copied: dict) -> None:
        criterion(copied, "c06").update(
            id="c06b", title="Скорость ответа", wording="Оцените скорость ответов."
        )

    copy = save_copy(client, official, replace_c06)
    second = grade(client, copy)
    assert all(r["carried_decision"] is None for r in second["results"])
    assert second["final_total"] == second["original_total"]


def test_no_carry_when_transcript_changed(setup) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"])
    decide(client, appeal["id"], answer={"step": 20})

    reimport(edit_first_line)
    second = grade(client, official)
    assert all(r["carried_decision"] is None for r in second["results"])
    assert second["final_total"] == 84.17


# --- carry-forward details -----------------------------------------------------------------


def test_rerun_of_the_same_version_carries(setup) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"])
    decide(client, appeal["id"], answer={"step": 20})
    second = grade(client, official)
    assert result(second, "c04")["carried_decision"]["appeal_id"] == appeal["id"]
    assert (second["original_total"], second["final_total"]) == (84.17, 92.5)


def test_full_mode_rerun_carries_too(setup) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"])
    decide(client, appeal["id"], answer={"step": 20})
    second = grade(client, official, mode="full")
    assert result(second, "c04")["final_answer"] == {"step": 20}


def test_confirmed_decision_carries_the_original_answer(setup, fake: FakeEvaluator) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"])
    decide(client, appeal["id"], outcome="confirmed")
    fake.answers["c04"] = StepAnswer(step=5)  # the model now says otherwise
    second = grade(client, official, mode="full")
    c04 = result(second, "c04")
    assert c04["answer"] == {"step": 5}
    assert c04["carried_decision"]["appeal_id"] == appeal["id"]
    assert c04["final_answer"] == {"step": 15}  # the confirmed answer wins over the new model answer


def test_most_recent_decision_carries(setup) -> None:
    client, official = setup
    first = grade(client, official)
    older = file(client, first["id"])
    decide(client, older["id"], answer={"step": 20})
    second = grade(client, official)
    newer = file(client, second["id"])
    decide(client, newer["id"], answer={"step": 10})
    third = grade(client, official)
    c04 = result(third, "c04")
    assert c04["carried_decision"] == {"appeal_id": newer["id"], "evaluation_id": second["id"]}
    assert c04["final_answer"] == {"step": 10}


def test_own_decision_outranks_a_carried_one(setup) -> None:
    client, official = setup
    first = grade(client, official)
    decide(client, file(client, first["id"])["id"], answer={"step": 20})
    second = grade(client, official)
    assert result(second, "c04")["final_answer"] == {"step": 20}
    own = file(client, second["id"])
    decided = decide(client, own["id"], answer={"step": 5})
    c04 = result(decided, "c04")
    assert c04["final_answer"] == {"step": 5}
    # 5/20 of 33.33 instead of 20/20: 50.5 - 15 + 5 = 40.5 of 60
    assert decided["final_total"] == 67.5
    assert decided["original_total"] == 84.17


def test_decision_on_another_conversation_does_not_carry(setup) -> None:
    client, official = setup
    first = grade(client, official)
    decide(client, file(client, first["id"])["id"], answer={"step": 20})
    other = grade(client, official, conversation=OTHER)
    assert all(r["carried_decision"] is None for r in other["results"])


def test_open_appeal_does_not_carry(setup) -> None:
    client, official = setup
    first = grade(client, official)
    file(client, first["id"])
    second = grade(client, official)
    assert all(r["carried_decision"] is None for r in second["results"])


def test_carry_uses_the_transcript_the_appealed_evaluation_graded(setup) -> None:
    """An appeal filed on an evaluation of an older transcript belongs to that transcript, not to
    the conversation's current one."""
    client, official = setup
    first = grade(client, official)
    reimport(edit_first_line)  # the conversation now holds another transcript
    decide(client, file(client, first["id"])["id"], answer={"step": 20})

    edited = grade(client, official)
    assert all(r["carried_decision"] is None for r in edited["results"])
    reimport()  # back to the transcript `first` graded
    again = grade(client, official)
    assert result(again, "c04")["carried_decision"]["evaluation_id"] == first["id"]


def test_carry_forward_function(setup) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"])
    decide(client, appeal["id"], answer={"step": 20})
    conv = store.get_conversation(CHAT)
    assert conv is not None
    from app.transcript import transcript_hash

    carries = appeals.carry_forward(CHAT, transcript_hash(conv.transcript), official)
    assert set(carries) == {"c04"}
    assert carries["c04"]["appeal_id"] == appeal["id"]
    assert carries["c04"]["evaluation_id"] == first["id"]
    assert carries["c04"]["answer"] == StepAnswer(step=20)
    assert carries["c04"]["kinds"] == []
    assert appeals.carry_forward(CHAT, "another-hash", official) == {}


# --- validation ----------------------------------------------------------------------------


def test_file_errors(setup) -> None:
    client, official = setup
    ev = grade(client, official)

    def post(**override) -> tuple[int, str]:
        body = {"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "x", "role": "controller", **override}
        r = client.post("/api/appeals", json=body)
        return r.status_code, r.json()["error"]

    assert post(evaluation_id="nope") == (404, "not_found")
    assert post(evaluation_id="nope", role="reviewer") == (404, "not_found")  # 404 first
    assert post(criterion_id="c99") == (404, "not_found")

    queued = Evaluation(
        id="queued-one", created_at=datetime.now(UTC), conversation=CHAT,
        checklist_id=official.checklist_id, version=official.version, status="queued",
    )  # fmt: skip
    store.insert_evaluation(queued)
    assert post(evaluation_id="queued-one") == (409, "evaluation_not_done")
    assert client.get("/api/appeals").json() == []


def test_decision_validation_order(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    appeal = file(client, ev["id"])

    def post(appeal_id: str = appeal["id"], **override) -> tuple[int, str]:
        body = {"outcome": "changed", "answer": {"step": 20}, "reason": "Потому что.", "role": "reviewer",
                **override}  # fmt: skip
        r = client.post(f"/api/appeals/{appeal_id}/decision", json=body)
        return r.status_code, r.json()["error"]

    assert post("nope", role="controller", reason="") == (404, "not_found")
    assert post(role="controller", reason="", answer={"step": 3}) == (403, "role_not_allowed")
    assert post(reason="   ", answer={"step": 3}) == (422, "reason_required")
    assert post(reason="") == (422, "reason_required")
    assert post(answer={"step": 3}) == (422, "step_not_in_scale")
    assert post(answer="yes") == (422, "bad_answer")
    assert post(answer=None) == (422, "invalid_request")  # changed needs an answer
    assert client.get(f"/api/appeals/{appeal['id']}").json()["status"] == "open"

    decide(client, appeal["id"], answer={"step": 20})
    assert post(reason="", answer={"step": 3}) == (409, "appeal_already_decided")


def test_na_is_checked_against_the_criterion(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    appeal = file(client, ev["id"], "c01")  # c01 does not allow N/A
    r = client.post(
        f"/api/appeals/{appeal['id']}/decision",
        json={"outcome": "changed", "answer": "na", "reason": "x", "role": "reviewer"},
    )
    assert r.status_code == 422 and r.json()["error"] == "na_not_allowed"


def test_recompute_failure_is_422(setup, monkeypatch: pytest.MonkeyPatch) -> None:
    client, official = setup
    ev = grade(client, official)
    appeal = file(client, ev["id"])

    def broken(*args, **kwargs):
        raise ScoringError("bad_scale", "c04")

    monkeypatch.setattr(appeals, "score", broken)
    r = client.post(
        f"/api/appeals/{appeal['id']}/decision",
        json={"outcome": "changed", "answer": {"step": 20}, "reason": "x", "role": "reviewer"},
    )
    assert r.status_code == 422 and r.json()["error"] == "bad_scale"
    # nothing was stored
    assert client.get(f"/api/appeals/{appeal['id']}").json()["status"] == "open"
    assert client.get(f"/api/evaluations/{ev['id']}").json()["final_total"] == 84.17


# --- reading -------------------------------------------------------------------------------


def test_list_and_get(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    a = file(client, ev["id"], "c04")
    b = file(client, ev["id"], "c05")
    c = file(client, ev["id"], "c06")
    decide(client, b["id"], outcome="confirmed")

    listed = client.get("/api/appeals").json()
    assert [x["id"] for x in listed] == [c["id"], b["id"], a["id"]]  # newest first
    assert [x["id"] for x in client.get("/api/appeals", params={"status": "open"}).json()] == [c["id"], a["id"]]
    assert [x["id"] for x in client.get("/api/appeals", params={"status": "decided"}).json()] == [b["id"]]
    assert client.get("/api/appeals", params={"status": "nope"}).status_code == 422
    for appeal in listed:
        Appeal.model_validate(appeal)
        validate("appeal", appeal)

    one = client.get(f"/api/appeals/{a['id']}")
    assert one.status_code == 200
    assert one.json()["conversation"] == CHAT and one.json()["evaluation_id"] == ev["id"]
    assert one.json()["comment"] == "Не согласен."
    by_evaluation = client.get("/api/appeals", params={"evaluation_id": ev["id"], "status": ""}).json()
    assert len(by_evaluation) == 3
    assert client.get("/api/appeals", params={"evaluation_id": "nope"}).json() == []
    assert len(client.get("/api/appeals", params={"conversation": CHAT}).json()) == 3
    assert client.get("/api/appeals", params={"conversation": OTHER}).json() == []
    missing = client.get("/api/appeals/nope")
    assert missing.status_code == 404 and missing.json()["error"] == "not_found"


def test_created_appeal_validates_against_the_contract(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    r = client.post(
        "/api/appeals",
        json={"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "x", "role": "controller"},
    )
    validate("appeal", r.json())
    client.portal.call(appeals.wait_for_second_opinions)
    decide(client, r.json()["id"], answer={"step": 20})
    validate("appeal", client.get(f"/api/appeals/{r.json()['id']}").json())


# --- conversation status and the queue -----------------------------------------------------


def test_queue_counts_real_open_appeals(setup) -> None:
    client, official = setup
    ev = grade(client, official)

    def open_appeals() -> int:
        items = client.get("/api/conversations").json()
        return next(i for i in items if i["id"] == CHAT)["final"]["open_appeals"]

    assert open_appeals() == 0
    first = file(client, ev["id"], "c04")
    file(client, ev["id"], "c05")
    assert open_appeals() == 2
    decide(client, first["id"], answer={"step": 20})
    assert open_appeals() == 1
    item = next(i for i in client.get("/api/conversations").json() if i["id"] == CHAT)
    assert item["status"] == "disputed"  # one appeal is still open
    assert item["final"]["total"] == 92.5


def test_count_open_appeals(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    file(client, ev["id"], "c04")
    file(client, ev["id"], "c05")
    assert store.count_open_appeals([ev["id"], "other", ev["id"]]) == {ev["id"]: 2, "other": 0}
    assert store.count_open_appeals([]) == {}


def test_job_keeps_disputed_while_an_appeal_is_open(setup) -> None:
    client, official = setup
    ev = grade(client, official)
    appeal = file(client, ev["id"])
    grade(client, official)
    assert status_of(client) == "disputed"
    decide(client, appeal["id"], answer={"step": 20})
    assert status_of(client) == "evaluated"
    grade(client, official)
    assert status_of(client) == "evaluated"


# --- recovery ------------------------------------------------------------------------------


def test_pending_second_opinions_become_unavailable_at_startup(
    setup, make_client: MakeClient, fake: FakeEvaluator, monkeypatch: pytest.MonkeyPatch
) -> None:
    client, official = setup
    ev = grade(client, official)
    monkeypatch.setattr(appeals, "_schedule_second_opinion", lambda appeal_id: None)  # never runs
    r = client.post(
        "/api/appeals",
        json={"evaluation_id": ev["id"], "criterion_id": "c04", "comment": "x", "role": "controller"},
    )
    assert r.json()["second_opinion_status"] == "pending"
    restarted = make_client(**KEY)
    assert restarted.get(f"/api/appeals/{r.json()['id']}").json()["second_opinion_status"] == "unavailable"


# --- final review: appeals on a superseded transcript --------------------------------------


def queue_item(client: TestClient, conversation: str = CHAT) -> dict:
    return next(i for i in client.get("/api/conversations").json() if i["id"] == conversation)


def test_an_appeal_on_a_superseded_transcript_leaves_the_status_new(setup) -> None:
    client, official = setup
    first = grade(client, official)
    reimport(edit_first_line)
    assert status_of(client) == "new"  # no evaluation of the current text

    appeal = file(client, first["id"])
    assert status_of(client) == "new"  # the appeal is about text the conversation no longer holds
    assert queue_item(client)["final"]["open_appeals"] == 0
    decide(client, appeal["id"], answer={"step": 20})
    assert status_of(client) == "new"


def test_only_appeals_on_the_current_transcript_count(setup) -> None:
    """The status and the queue's `open_appeals` count only the open appeals on the conversation's
    current transcript, so the two always agree."""
    client, official = setup
    first = grade(client, official)
    file(client, first["id"])  # stays open, on the transcript `first` graded
    assert status_of(client) == "disputed"
    assert queue_item(client)["final"]["open_appeals"] == 1

    reimport(edit_first_line)
    item = queue_item(client)
    assert item["status"] == "new"
    assert item["final"]["open_appeals"] == 0  # `final` still shows `first`, whose transcript is gone

    second = grade(client, official)  # the current transcript
    item = queue_item(client)
    assert (item["status"], item["final"]["open_appeals"]) == ("evaluated", 0)

    current = file(client, second["id"])
    item = queue_item(client)
    assert (item["status"], item["final"]["open_appeals"]) == ("disputed", 1)

    decide(client, current["id"], answer={"step": 20})
    item = queue_item(client)
    assert (item["status"], item["final"]["open_appeals"]) == ("evaluated", 0)  # the old one does not count
    assert item["final"]["total"] == 92.5


# --- final review: a decision reaches later evaluations ------------------------------------


def csv_row(client: TestClient, version: ChecklistVersion, conversation_id: str = "p1-ru-001") -> dict[str, str]:
    r = client.get("/api/export.csv", params={"checklist_id": version.checklist_id, "version": version.version})
    assert r.status_code == 200, r.text
    lines = r.content.decode("utf-8-sig").splitlines()
    header = lines[0].split(";")
    rows = [dict(zip(header, line.split(";"), strict=True)) for line in lines[1:]]
    return next(row for row in rows if row["conversation_id"] == conversation_id)


def test_a_decision_reaches_a_later_evaluation_of_the_same_transcript(setup) -> None:
    """An appeal filed on E1, a re-run that creates E2 before the decision: the decision reaches E2,
    and so every reader of E2 (the queue, analytics, the CSV) shows it."""
    client, official = setup
    earlier = grade(client, official)  # before the appealed one: carry-forward only goes forward
    first = grade(client, official)
    appeal = file(client, first["id"])
    second = grade(client, official)
    assert result(second, "c04")["carried_decision"] is None  # an open appeal carries nothing
    assert queue_item(client)["final"]["total"] == 84.17

    decide(client, appeal["id"], answer={"step": 20})

    after = client.get(f"/api/evaluations/{second['id']}").json()
    validate("evaluation", after)
    c04 = result(after, "c04")
    assert c04["carried_decision"] == {"appeal_id": appeal["id"], "evaluation_id": first["id"]}
    assert (c04["answer"], c04["final_answer"]) == ({"step": 15}, {"step": 20})
    assert (c04["points"], c04["effective_weight"]) == (33.33, 33.33)
    assert (after["original_total"], after["final_total"]) == (84.17, 92.5)
    assert all(r["carried_decision"] is None for r in after["results"] if r["criterion_id"] != "c04")

    assert queue_item(client)["final"]["total"] == 92.5
    body = client.get(
        "/api/analytics", params={"checklist_id": official.checklist_id, "version": official.version}
    ).json()
    assert body["by_language"] == [{"language": "RU", "avg_total": 92.5, "n": 1}]
    row = csv_row(client, official)
    assert (row["final_total"], row["original_total"], row["c04_answer"]) == ("92,50", "84,17", "20")

    untouched = client.get(f"/api/evaluations/{earlier['id']}").json()
    assert untouched["final_total"] == 84.17 and result(untouched, "c04")["carried_decision"] is None


def test_a_later_evaluations_own_decision_outranks_a_newer_one_elsewhere(setup) -> None:
    client, official = setup
    first = grade(client, official)
    on_first = file(client, first["id"])
    second = grade(client, official)
    decide(client, file(client, second["id"])["id"], answer={"step": 5})  # E2's own decision

    decide(client, on_first["id"], answer={"step": 20})  # decided later, on E1

    after = client.get(f"/api/evaluations/{second['id']}").json()
    assert result(after, "c04")["final_answer"] == {"step": 5}  # its own decision stands
    assert after["final_total"] == 67.5
    assert client.get(f"/api/evaluations/{first['id']}").json()["final_total"] == 92.5


def test_a_decision_reaches_later_evaluations_of_any_checklist_with_the_same_criterion(setup) -> None:
    client, official = setup
    first = grade(client, official)
    appeal = file(client, first["id"])
    heavier = grade(client, save_copy(client, official, heavier_c01))  # weights only: same fingerprint

    def reword_c04(copied: dict) -> None:
        criterion(copied, "c04")["wording"] = "Оцените полноту ответа по шкале."

    reworded = grade(client, save_copy(client, official, reword_c04))  # another fingerprint
    reimport(edit_first_line)
    other_text = grade(client, official)  # another transcript

    decide(client, appeal["id"], answer={"step": 20})

    after = client.get(f"/api/evaluations/{heavier['id']}").json()
    assert result(after, "c04")["final_answer"] == {"step": 20}
    assert (after["original_total"], after["final_total"]) == (86.43, 93.57)
    for unchanged in (reworded, other_text):
        assert client.get(f"/api/evaluations/{unchanged['id']}").json() == unchanged
