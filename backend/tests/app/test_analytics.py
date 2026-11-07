"""Analytics and CSV export (Task 12, issue #14): GET /analytics and GET /export.csv.

Stream C's evaluator is replaced by tests.app.fakes.FakeEvaluator (no network, no Claude API).
Most tests store evaluations directly with `put`, which scores them through the code path a real
evaluation and a reviewer's decision take (`appeals.apply_decisions`), so totals, points and the
gross-error flag are the real ones. Two tests run real jobs and decide a real appeal.
"""

import csv
import io
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from fractions import Fraction
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import analytics, appeals, jobs, store
from app.errors import ApiError
from app.models import (
    Analytics,
    Answer,
    ChecklistVersion,
    CriterionResult,
    Evaluation,
    StepAnswer,
)
from app.transcript import normalize_record
from tests.app.fakes import FakeEvaluator, default_answer, dev_records, ensure_official, load_dev_subset
from tests.app.helpers import decide, file, validate

MakeClient = Callable[..., TestClient]
KEY = {"ANTHROPIC_API_KEY": "test-key"}
START = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)
BOM = b"\xef\xbb\xbf"
HEADER_START = "conversation_id;group_id;channel;language;checklist_id;version;original_total;final_total"

# The T2 test vector of the front-end design (section 6): 84.17 on the official checklist.
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
    jobs.set_evaluator(evaluator)
    yield evaluator
    jobs.reset_evaluator()


@pytest.fixture
def setup(make_client: MakeClient, fake: FakeEvaluator) -> tuple[TestClient, ChecklistVersion]:
    return make_client(**KEY), ensure_official()


# --- helpers -------------------------------------------------------------------------------


def add_conversation(group_id: str, conversation_id: str, channel: str = "agent chat", language: str = "RU") -> str:
    """Store a small conversation and return its id ("{group_id}:{conversation_id}")."""
    record = {
        "conversation_id": conversation_id,
        "channel": channel,
        "language": language,
        "transcript": dev_records()[0]["transcript"][:3],
    }
    conversation, _ = normalize_record(record, group_id)
    store.upsert_conversation(conversation, None)
    return conversation.id


def put(
    conversation: str,
    version: ChecklistVersion,
    answers: dict[str, Answer] | None = None,
    *,
    kinds: dict[str, list[str]] | None = None,
    seconds: int = 0,
    status: str = "done",
) -> Evaluation:
    """Store an evaluation of `conversation`, `seconds` after START, with these model answers
    (criterion id -> answer); the other criteria get the fake's default (yes, the top step, no).
    Points, totals and the gross-error flag are calculated like a real evaluation's."""
    answers = answers or {}
    results = [
        CriterionResult(
            criterion_id=c.id,
            answer=answers.get(c.id, default_answer(c)),
            kinds=(kinds or {}).get(c.id, []),
            explanation=f"Judgment of {c.id}.",
            confidence="high",
            points=None,
            effective_weight=None,
        )
        for c in version.criteria
    ]
    draft = Evaluation(
        id=str(uuid4()),
        created_at=START + timedelta(seconds=seconds),
        conversation=conversation,
        checklist_id=version.checklist_id,
        version=version.version,
        status=status,
        results=results,
    )
    evaluation = appeals.apply_decisions(draft, version, {}, {})
    store.insert_evaluation(evaluation)
    return evaluation


def put_total(
    conversation: str, version: ChecklistVersion, total: str | None, *, seconds: int = 0, status: str = "done"
) -> None:
    """Store an evaluation that only has a final total (no results)."""
    store.insert_evaluation(
        Evaluation(
            id=str(uuid4()),
            created_at=START + timedelta(seconds=seconds),
            conversation=conversation,
            checklist_id=version.checklist_id,
            version=version.version,
            status=status,
            final_total=None if total is None else Decimal(total),
        )
    )


def run(client: TestClient, conversations: list[str], version: ChecklistVersion) -> dict[str, dict]:
    """Run one job and return its (done) evaluations by conversation id."""
    body = {
        "conversations": conversations,
        "checklist_id": version.checklist_id,
        "version": version.version,
        "role": "controller",
    }
    r = client.post("/api/evaluations", json=body)
    assert r.status_code == 201, r.text
    job_id = r.json()["id"]
    client.portal.call(jobs.wait_for_job, job_id)
    job = client.get(f"/api/jobs/{job_id}").json()
    assert job["status"] == "done", job
    return {
        item["conversation"]: client.get(f"/api/evaluations/{item['evaluation_id']}").json() for item in job["items"]
    }


def query(checklist: ChecklistVersion | None = None, **params: str) -> dict[str, str]:
    given = dict(params)
    if checklist is not None:
        given.update(checklist_id=checklist.checklist_id, version=str(checklist.version))
    return given


def get_analytics(client: TestClient, checklist: ChecklistVersion | None = None, **params: str) -> dict:
    r = client.get("/api/analytics", params=query(checklist, **params))
    assert r.status_code == 200, r.text
    body = r.json()
    validate("analytics", body)
    Analytics.model_validate(body)  # the model reads back what the route sends
    return body


def get_csv(client: TestClient, checklist: ChecklistVersion | None = None, **params: str):
    r = client.get("/api/export.csv", params=query(checklist, **params))
    assert r.status_code == 200, r.text
    return r


def parse(content: bytes) -> list[list[str]]:
    """The CSV as an Excel-style reader sees it: BOM dropped, `;` delimiter, quoted cells joined."""
    assert content.startswith(BOM)
    return list(csv.reader(io.StringIO(content[len(BOM) :].decode("utf-8"), newline=""), delimiter=";"))


def criterion_row(body: dict, criterion_id: str) -> dict:
    return next(row for row in body["by_criterion"] if row["criterion_id"] == criterion_id)


def three(group_id: str = "G") -> list[str]:
    return [add_conversation(group_id, f"x{n}") for n in range(3)]


# --- the brief's tests ---------------------------------------------------------------------


def test_analytics_shape_and_values(setup) -> None:
    client, official = setup
    ids = three()
    for conversation, answer in zip(ids, ("no", "yes", "yes"), strict=True):
        put(conversation, official, {"c01": answer})

    body = get_analytics(client, official)  # validates against analytics.schema.json
    assert criterion_row(body, "c01") == {
        "criterion_id": "c01",
        "title": official.criteria[0].title,
        "fail_rate": 0.3333,
        "na_rate": 0,
        "n": 3,
    }
    # every scored criterion of the checklist, in its order (the gross-error one is in gross_errors);
    # the others were all answered well
    assert [row["criterion_id"] for row in body["by_criterion"]] == [
        c.id for c in official.criteria if c.kind != "gross_error"
    ]
    assert all(row["fail_rate"] == 0 and row["n"] == 3 for row in body["by_criterion"][1:])
    assert body["gross_errors"] == {"count": 0, "by_kind": [], "conversations": []}
    # totals 90, 100 and 100 (c01 weighs 10 of 100): the mean 96.67
    assert body["by_language"] == [{"language": "RU", "avg_total": 96.67, "n": 3}]
    assert body["by_channel"] == [{"channel": "agent chat", "avg_total": 96.67, "n": 3}]


def test_gross_errors_listed(setup) -> None:
    client, official = setup
    clean, flagged = three()[:2]
    put(clean, official)
    put(flagged, official, {"c08": "yes"}, kinds={"c08": ["insult"]})

    body = get_analytics(client, official)
    assert body["gross_errors"] == {
        "count": 1,
        "by_kind": [{"kind": "insult", "count": 1}],
        "conversations": [flagged],
    }
    assert "c08" not in [row["criterion_id"] for row in body["by_criterion"]]  # reported in gross_errors only


def test_csv_bom_and_header(setup, fake: FakeEvaluator) -> None:
    client, official = setup
    ids = load_dev_subset()
    fake.answers = dict(T2)
    run(client, ids[:3], official)

    response = get_csv(client, official)
    assert response.content.startswith(BOM)
    first_line = response.content[len(BOM) :].decode("utf-8").split("\r\n")[0]
    assert first_line.startswith("conversation_id;group_id;channel;language")
    assert first_line == ";".join(
        [
            *HEADER_START.split(";"),
            "gross_error",
            "gross_error_kinds",
            *(f"{c.id}_{part}" for c in official.criteria for part in ("answer", "points")),
        ]
    )
    rows = parse(response.content)
    assert len(rows) == 3 + 1
    assert any("84,17" in row for row in rows[1:])  # a decimal comma, for Excel with a Russian locale
    assert {len(row) for row in rows} == {len(rows[0])}  # every row has every column


# --- analytics -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("count", "n", "rate"),
    [
        (0, 5, "0.0000"),
        (5, 5, "1.0000"),
        (1, 3, "0.3333"),
        (2, 3, "0.6667"),
        (1, 16, "0.0625"),
        (1, 32, "0.0313"),  # 0.03125: half-up, where float rounding gives 0.0312
        (3, 32, "0.0938"),  # 0.09375
        (1, 8, "0.1250"),
        (7, 9, "0.7778"),
    ],
)
def test_rates_are_exact_and_half_up(count: int, n: int, rate: str) -> None:
    assert analytics.rate(count, n) == Decimal(rate)
    assert str(analytics.rate(count, n)) == rate  # always four decimals


def test_fail_and_na_rates(setup) -> None:
    client, official = setup
    ids = [add_conversation("G", f"x{n}") for n in range(4)]
    answers: list[dict[str, Answer]] = [
        {"c01": "no", "c04": StepAnswer(step=20), "c06": StepAnswer(step=10), "c02": "na"},
        {"c01": "yes", "c04": StepAnswer(step=15), "c06": StepAnswer(step=7), "c02": "na"},
        {"c01": "yes", "c04": StepAnswer(step=0), "c06": StepAnswer(step=0), "c02": "yes"},
        {"c01": "yes", "c04": "na", "c06": StepAnswer(step=10), "c02": "no"},
    ]
    for conversation, given in zip(ids, answers, strict=True):
        put(conversation, official, given)

    body = get_analytics(client, official)
    # yes/no: "no" fails
    assert criterion_row(body, "c01")["fail_rate"] == 0.25
    # c02: two na, one no, one yes; the failures are the share of the two it applied to, na_rate of all four
    c02 = criterion_row(body, "c02")
    assert (c02["fail_rate"], c02["na_rate"], c02["n"]) == (0.5, 0.5, 4)
    # a scale: any step below the top step fails; na is not a failure and is not in the denominator
    # (c04: steps 20 and 15, 0, na: two failures of the three it applied to)
    c04 = criterion_row(body, "c04")
    assert (c04["fail_rate"], c04["na_rate"], c04["n"]) == (0.6667, 0.25, 4)
    # the top step is 10 on c06: 10, 7 and 0, 10
    assert criterion_row(body, "c06")["fail_rate"] == 0.5


def test_fail_rate_is_among_the_evaluations_the_criterion_applied_to(setup) -> None:
    client, official = setup
    ids = [add_conversation("G", f"x{n}") for n in range(4)]
    for conversation, answer in zip(ids, ("no", "yes", "na", "na"), strict=True):
        put(conversation, official, {"c02": answer})

    c02 = criterion_row(get_analytics(client, official), "c02")
    # one failure among the two evaluations where c02 applied (n - na); over all four it would be 0.25
    assert (c02["fail_rate"], c02["na_rate"], c02["n"]) == (0.5, 0.5, 4)

    # the same on a scale: step 0 fails, the top step 20 passes, na is left out of the denominator
    for conversation, answer in zip(ids, (StepAnswer(step=0), StepAnswer(step=20), "na", "na"), strict=True):
        put(conversation, official, {"c04": answer}, seconds=1)
    c04 = criterion_row(get_analytics(client, official), "c04")
    assert (c04["fail_rate"], c04["na_rate"], c04["n"]) == (0.5, 0.5, 4)


def test_fail_rate_is_exact_and_half_up_among_applicable(setup) -> None:
    client, official = setup
    # 1 failure among 32 applicable evaluations (the 2 na ones are left out of the denominator):
    # 1/32 = 0.03125, half-up 0.0313 (float rounding gives 0.0312); na_rate 2/34 = 0.0588
    answers = ["no"] + ["yes"] * 31 + ["na"] * 2
    for n, answer in enumerate(answers):
        put(add_conversation("G", f"x{n}"), official, {"c02": answer})
    c02 = criterion_row(get_analytics(client, official), "c02")
    assert (c02["fail_rate"], c02["na_rate"], c02["n"]) == (0.0313, 0.0588, 34)


def test_a_criterion_answered_na_everywhere_has_no_failures(setup) -> None:
    client, official = setup
    for n in range(3):
        put(add_conversation("G", f"x{n}"), official, {"c03": "na"})
    body = get_analytics(client, official)  # validates: the schema wants numbers
    c03 = criterion_row(body, "c03")
    assert (c03["fail_rate"], c03["na_rate"], c03["n"]) == (0, 1, 3)  # nothing applied: no failure rate
    assert isinstance(c03["fail_rate"], int | float)
    assert criterion_row(body, "c01")["n"] == 3  # the other criteria are untouched


def test_gross_error_count_and_kinds(setup) -> None:
    client, official = setup
    a, b, c, d = [add_conversation("G", f"x{n}") for n in range(4)]
    put(a, official, {"c08": "yes"}, kinds={"c08": ["paid_service_outside_company", "insult"]})
    put(b, official, {"c08": "yes"}, kinds={"c08": ["insult"]})
    put(c, official, {"c08": "yes"}, kinds={"c08": ["paid_service_outside_company"]})
    put(d, official, {"c08": "no"})

    body = get_analytics(client, official)
    gross = body["gross_errors"]
    assert gross["count"] == 3
    # a count that ties is ordered by kind
    assert gross["by_kind"] == [
        {"kind": "insult", "count": 2},
        {"kind": "paid_service_outside_company", "count": 2},
    ]
    assert gross["conversations"] == [a, b, c]


def test_by_kind_is_ordered_by_count_then_kind(setup) -> None:
    client, official = setup
    ids = [add_conversation("G", f"x{n}") for n in range(4)]
    put(ids[0], official, {"c08": "yes"}, kinds={"c08": ["zeta"]})
    put(ids[1], official, {"c08": "yes"}, kinds={"c08": ["alpha"]})
    put(ids[2], official, {"c08": "yes"}, kinds={"c08": ["beta", "zeta"]})
    put(ids[3], official, {"c08": "yes"}, kinds={"c08": ["zeta", "zeta"]})  # a repeat counts once

    kinds = get_analytics(client, official)["gross_errors"]["by_kind"]
    assert kinds == [
        {"kind": "zeta", "count": 3},
        {"kind": "alpha", "count": 1},
        {"kind": "beta", "count": 1},
    ]


def test_the_gross_error_criterion_is_reported_in_gross_errors_only(setup) -> None:
    client, official = setup
    clean, flagged = three()[:2]
    put(clean, official)
    put(flagged, official, {"c08": "yes"}, kinds={"c08": ["insult"]})

    body = get_analytics(client, official)
    gross_error_ids = [c.id for c in official.criteria if c.kind == "gross_error"]
    assert gross_error_ids == ["c08"]
    listed = [row["criterion_id"] for row in body["by_criterion"]]
    assert not set(gross_error_ids) & set(listed)
    assert listed == [c.id for c in official.criteria if c.kind != "gross_error"]
    # the gross_errors block still counts it
    assert body["gross_errors"] == {
        "count": 1,
        "by_kind": [{"kind": "insult", "count": 1}],
        "conversations": [flagged],
    }
    # the CSV is unchanged on this point: the criterion keeps its answer and points columns
    header = parse(get_csv(client, official).content)[0]
    assert "c08_answer" in header and "c08_points" in header


def test_final_answers_count_not_the_models(setup) -> None:
    client, official = setup
    ids = load_dev_subset()
    graded = run(client, ids[:2], official)  # the fake answers yes and the top step everywhere
    first = graded[ids[0]]
    assert first["final_total"] == 100.0
    appeal = file(client, first["id"], "c06")
    assert decide(client, appeal["id"], answer={"step": 4})["final_total"] == 91.0

    body = get_analytics(client, official)
    c06 = criterion_row(body, "c06")
    assert (c06["fail_rate"], c06["n"]) == (0.5, 2)  # the reviewer's step 4, not the model's 10
    assert body["by_channel"][0] == {"channel": "agent chat", "avg_total": 95.5, "n": 2}

    # the model's answer is the fallback when no decision was made
    assert criterion_row(body, "c05")["fail_rate"] == 0


def test_a_decision_can_clear_and_raise_a_gross_error(setup, fake: FakeEvaluator) -> None:
    client, official = setup
    ids = load_dev_subset()
    fake.answers = {"c08": "yes"}
    graded = run(client, ids[:1], official)
    only = graded[ids[0]]
    assert only["gross_error"]["flag"] is True
    assert get_analytics(client, official)["gross_errors"]["count"] == 1

    appeal = file(client, only["id"], "c08")
    decide(client, appeal["id"], answer="no")
    body = get_analytics(client, official)
    assert body["gross_errors"] == {"count": 0, "by_kind": [], "conversations": []}


def test_by_language_and_channel(setup) -> None:
    client, official = setup
    kz = add_conversation("G", "kz1", language="KZ")
    en_call = add_conversation("G", "en1", channel="voice call", language="EN")
    ru_call = add_conversation("G", "ru1", channel="voice call")
    ru_chat = add_conversation("G", "ru2")
    kz2 = add_conversation("G", "kz2", language="KZ")
    for conversation, total in (
        (kz, "80.00"),
        (kz2, "71.00"),
        (en_call, "60.00"),
        (ru_call, "50.00"),
        (ru_chat, "90.00"),
    ):
        put_total(conversation, official, total)

    body = get_analytics(client, official)
    # a fixed order, only the values that occur
    assert body["by_language"] == [
        {"language": "RU", "avg_total": 70.0, "n": 2},
        {"language": "KZ", "avg_total": 75.5, "n": 2},
        {"language": "EN", "avg_total": 60.0, "n": 1},
    ]
    assert body["by_channel"] == [
        {"channel": "agent chat", "avg_total": 80.33, "n": 3},
        {"channel": "voice call", "avg_total": 55.0, "n": 2},
    ]


def test_avg_total_skips_null_totals_and_is_exact(setup) -> None:
    client, official = setup
    a, b, c, d = [add_conversation("G", f"x{n}", language="KZ") for n in range(4)]
    put_total(a, official, "10.00")
    put_total(b, official, "10.01")  # the mean 10.005 rounds half-up to 10.01
    put_total(c, official, None)  # not calculated: counted in n, left out of the mean
    put_total(d, official, None)

    body = get_analytics(client, official)
    assert body["by_language"] == [{"language": "KZ", "avg_total": 10.01, "n": 4}]
    assert body["by_channel"] == [{"channel": "agent chat", "avg_total": 10.01, "n": 4}]


def test_avg_total_is_null_when_no_total_is_calculated(setup) -> None:
    client, official = setup
    put_total(add_conversation("G", "x"), official, None)
    body = get_analytics(client, official)
    assert body["by_language"] == [{"language": "RU", "avg_total": None, "n": 1}]
    assert body["by_channel"] == [{"channel": "agent chat", "avg_total": None, "n": 1}]


def test_the_latest_done_evaluation_of_each_conversation_counts(setup) -> None:
    client, official = setup
    a, b = [add_conversation("G", f"x{n}") for n in range(2)]
    put(a, official, {"c01": "no"}, seconds=1)
    put(a, official, {"c01": "yes"}, seconds=2)  # the latest done one counts
    put(a, official, {"c01": "no"}, seconds=3, status="failed")  # newer, but not done
    put(a, official, {"c01": "no"}, seconds=4, status="running")
    put(b, official, {"c01": "no"}, seconds=1, status="queued")  # never graded on this version

    body = get_analytics(client, official)
    assert (criterion_row(body, "c01")["fail_rate"], criterion_row(body, "c01")["n"]) == (0, 1)
    assert body["by_language"][0]["n"] == 1


def test_group_filter(setup) -> None:
    client, official = setup
    inside = [add_conversation("A", f"x{n}") for n in range(2)]
    beside = [add_conversation("A-1", f"y{n}", language="EN") for n in range(2)]
    put(inside[0], official, {"c01": "no"})
    put(inside[1], official, {"c01": "yes"})
    put(beside[0], official, {"c01": "no"})
    put(beside[1], official, {"c08": "yes"}, kinds={"c08": ["insult"]})

    everything = get_analytics(client, official)
    assert criterion_row(everything, "c01")["n"] == 4
    assert everything["gross_errors"]["conversations"] == [beside[1]]

    only_a = get_analytics(client, official, group_id="A")
    assert criterion_row(only_a, "c01")["fail_rate"] == 0.5
    assert criterion_row(only_a, "c01")["n"] == 2
    assert [row["language"] for row in only_a["by_language"]] == ["RU"]
    assert only_a["gross_errors"]["count"] == 0

    only_a1 = get_analytics(client, official, group_id="A-1")
    assert only_a1["by_language"] == [{"language": "EN", "avg_total": 95.0, "n": 2}]  # 90 and 100
    assert only_a1["gross_errors"]["conversations"] == [beside[1]]

    # a blank group is no group filter; an unknown group is an empty report
    assert criterion_row(get_analytics(client, official, group_id=""), "c01")["n"] == 4
    nobody = get_analytics(client, official, group_id="nope")
    assert nobody == {
        "by_criterion": [],
        "by_language": [],
        "by_channel": [],
        "gross_errors": {"count": 0, "by_kind": [], "conversations": []},
    }


def test_gross_error_conversations_are_ordered_by_group_then_conversation(setup) -> None:
    client, official = setup
    # as text "A-1:x" sorts before "A:x"; by group id and then conversation id "A" comes first
    in_a = add_conversation("A", "x")
    in_a1 = add_conversation("A-1", "x")
    in_a2 = add_conversation("A", "b")
    for conversation in (in_a1, in_a, in_a2):
        put(conversation, official, {"c08": "yes"}, kinds={"c08": ["insult"]})
    assert get_analytics(client, official)["gross_errors"]["conversations"] == [in_a2, in_a, in_a1]


def test_evaluations_of_a_conversation_that_is_not_stored_are_left_out(setup) -> None:
    client, official = setup
    stored = add_conversation("G", "x")
    put(stored, official, {"c01": "yes"})
    put("G:ghost", official, {"c01": "no"})  # no stored conversation: no language, channel or group

    body = get_analytics(client, official)
    assert (criterion_row(body, "c01")["fail_rate"], criterion_row(body, "c01")["n"]) == (0, 1)
    assert sum(row["n"] for row in body["by_language"]) == 1
    assert [row[1] for row in parse(get_csv(client, official).content)[1:]] == ["G"]


def test_nothing_graded(setup) -> None:
    client, official = setup
    body = get_analytics(client, official)
    assert body == {
        "by_criterion": [],
        "by_language": [],
        "by_channel": [],
        "gross_errors": {"count": 0, "by_kind": [], "conversations": []},
    }


def test_a_criterion_no_evaluation_contains_is_left_out(setup) -> None:
    client, official = setup
    conversation = add_conversation("G", "x")
    # an evaluation that has results for some criteria only (the schema wants numbers, never null)
    draft = put(conversation, official)
    fewer = draft.model_copy(update={"results": [r for r in draft.results if r.criterion_id != "c03"]})
    with store.write_transaction() as conn:
        store.write_evaluation(conn, fewer)
    body = get_analytics(client, official)
    assert "c03" not in [row["criterion_id"] for row in body["by_criterion"]]
    assert criterion_row(body, "c01")["n"] == 1


def test_default_checklist_when_omitted(setup) -> None:
    client, official = setup
    conversation = add_conversation("G", "x")
    put(conversation, official, {"c01": "no"})
    assert get_analytics(client) == get_analytics(client, official)
    assert criterion_row(get_analytics(client), "c01")["fail_rate"] == 1
    # each missing half takes its own default
    assert get_analytics(client, checklist_id=official.checklist_id) == get_analytics(client, official)
    assert get_analytics(client, version="1") == get_analytics(client, official)
    # a blank value is an omitted one
    assert get_analytics(client, checklist_id="", version="1", group_id="") == get_analytics(client, official)
    assert get_analytics(client, checklist_id="", version="", group_id="") == get_analytics(client, official)
    assert get_csv(client, checklist_id="", version="").content == get_csv(client, official).content


def test_analytics_of_another_checklist(setup) -> None:
    client, official = setup
    other = official.model_copy(update={"checklist_id": "other", "version": 1, "locked": False, "id": "other:1"})
    store.save_checklist_version(other)
    conversation = add_conversation("G", "x")
    put(conversation, official, {"c01": "yes"})
    put(conversation, other, {"c01": "no"})
    assert criterion_row(get_analytics(client, official), "c01")["fail_rate"] == 0
    assert criterion_row(get_analytics(client, other), "c01")["fail_rate"] == 1


def test_analytics_function(setup) -> None:
    client, official = setup
    put(add_conversation("G", "x"), official, {"c01": "no"})
    result = analytics.analytics(official.checklist_id, official.version, None)
    assert isinstance(result, Analytics)
    assert result.by_criterion[0].fail_rate == Decimal("1.0000")
    assert result.by_language[0].avg_total == Decimal("90.00")
    assert analytics.analytics(official.checklist_id, official.version, "").by_criterion[0].n == 1
    assert analytics.analytics(official.checklist_id, official.version, "OTHER").by_criterion == []
    with pytest.raises(ApiError) as caught:
        analytics.analytics("nope", 1, None)
    assert caught.value.status == 404


def test_analytics_reads_in_a_fixed_number_of_queries(setup, monkeypatch: pytest.MonkeyPatch) -> None:
    client, official = setup
    calls = 0
    real = store.connect

    def counting():
        nonlocal calls
        calls += 1
        return real()

    monkeypatch.setattr(store, "connect", counting)

    def queries() -> int:
        nonlocal calls
        calls = 0
        analytics.analytics(official.checklist_id, official.version, None)
        analytics.export_csv(official.checklist_id, official.version, None)
        return calls

    for n in range(6):
        put(add_conversation("S", f"x{n}"), official)
    six = queries()
    for n in range(6):
        put(add_conversation("T", f"x{n}"), official)
    twelve = queries()
    # the checklist, the evaluations and the conversations, once for each of the two reads
    assert six == twelve == 6


def test_conversation_profiles(setup) -> None:
    client, official = setup
    assert store.conversation_profiles([]) == {}
    a = add_conversation("G", "a", channel="voice call", language="KZ")
    b = add_conversation("H", "b")
    profiles = store.conversation_profiles([a, "G:unknown", b, a])
    assert set(profiles) == {a, b}
    assert profiles[a] == store.ConversationProfile("G", "a", "voice call", "KZ")
    assert profiles[b] == store.ConversationProfile("H", "b", "agent chat", "RU")


# --- errors --------------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/api/analytics", "/api/export.csv"])
@pytest.mark.parametrize(
    "params",
    [
        {"checklist_id": "nope", "version": "1"},
        {"checklist_id": "official-chat", "version": "99"},
        {"checklist_id": "official-chat", "version": "0"},
        {"checklist_id": "official-chat", "version": "-3"},
        {"checklist_id": "official-chat", "version": "99999999999999999999"},
        {"checklist_id": "nope"},
    ],
)
def test_unknown_version_is_404(setup, path: str, params: dict[str, str]) -> None:
    client, official = setup
    r = client.get(path, params=params)
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"
    validate("error", r.json())


@pytest.mark.parametrize("path", ["/api/analytics", "/api/export.csv"])
def test_a_version_must_be_an_integer(setup, path: str) -> None:
    client, official = setup
    r = client.get(path, params={"version": "one"})
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_request"


# --- CSV -----------------------------------------------------------------------------------


def test_csv_t2_row(setup, fake: FakeEvaluator) -> None:
    client, official = setup
    ids = load_dev_subset()
    fake.answers = dict(T2)
    run(client, ids[:1], official)

    rows = parse(get_csv(client, official).content)
    assert len(rows) == 2
    assert rows[1] == [
        "p1-ru-001", "DEV", "agent chat", "RU", official.checklist_id, "1", "84,17", "84,17", "0", "",
        "yes", "16,67",  # c01
        "na", "",  # c02
        "na", "",  # c03
        "15", "25,00",  # c04: the step's value
        "yes", "25,00",  # c05
        "7", "17,50",  # c06
        "na", "",  # c07
        "no", "",  # c08: the gross-error criterion has no points
    ]  # fmt: skip
    raw = get_csv(client, official).content.decode("utf-8")
    assert ";84,17;84,17;" in raw  # a decimal comma, never a point
    assert "." not in raw  # no decimal point anywhere in the file


def test_csv_uses_final_answers_and_totals(setup) -> None:
    client, official = setup
    ids = load_dev_subset()
    graded = run(client, ids[:2], official)
    appeal = file(client, graded[ids[0]]["id"], "c06")
    decide(client, appeal["id"], answer={"step": 4})

    rows = {row[0]: row for row in parse(get_csv(client, official).content)[1:]}
    header = parse(get_csv(client, official).content)[0]

    def cell(conversation: str, column: str) -> str:
        return rows[conversation][header.index(column)]

    assert (cell("p1-ru-001", "original_total"), cell("p1-ru-001", "final_total")) == ("100,00", "91,00")
    assert (cell("p1-ru-001", "c06_answer"), cell("p1-ru-001", "c06_points")) == ("4", "6,00")
    assert (cell("p1-ru-010", "c06_answer"), cell("p1-ru-010", "c06_points")) == ("10", "15,00")
    assert cell("p1-ru-010", "final_total") == "100,00"


def test_csv_gross_error_columns(setup) -> None:
    client, official = setup
    clean, flagged = [add_conversation("G", f"x{n}", channel="voice call", language="EN") for n in (1, 2)]
    put(clean, official)
    put(flagged, official, {"c08": "yes"}, kinds={"c08": ["insult", "paid_service_outside_company"]})

    rows = parse(get_csv(client, official).content)
    header = rows[0]
    by_id = {row[0]: row for row in rows[1:]}
    flagged_row = by_id["x2"]
    assert flagged_row[header.index("gross_error")] == "1"
    assert flagged_row[header.index("gross_error_kinds")] == "insult,paid_service_outside_company"
    assert flagged_row[header.index("c08_answer")] == "yes"
    assert flagged_row[header.index("channel")] == "voice call"
    assert flagged_row[header.index("language")] == "EN"
    clean_row = by_id["x1"]
    assert clean_row[header.index("gross_error")] == "0"
    assert clean_row[header.index("gross_error_kinds")] == ""


def test_csv_blank_totals_when_not_calculated(setup) -> None:
    client, official = setup
    conversation = add_conversation("G", "x")
    put_total(conversation, official, None)
    rows = parse(get_csv(client, official).content)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert (row["original_total"], row["final_total"]) == ("", "")
    # an evaluation without results has no answer or points cells
    assert row["c01_answer"] == "" and row["c01_points"] == ""
    assert row["gross_error"] == "0"


def test_csv_totals_have_two_decimals(setup) -> None:
    client, official = setup
    for n, total in enumerate(("100", "0", "5.5", "84.17", "1.005")):
        put_total(add_conversation("G", f"x{n}"), official, total)
    rows = parse(get_csv(client, official).content)
    header = rows[0]
    assert [row[header.index("final_total")] for row in rows[1:]] == ["100,00", "0,00", "5,50", "84,17", "1,01"]


def test_csv_numbers_have_a_decimal_comma_and_are_not_quoted(setup) -> None:
    client, official = setup
    put(add_conversation("G", "t2"), official, T2)  # totals 84.17, points with fractions
    put_total(add_conversation("G", "none"), official, None)  # not calculated
    put_total(add_conversation("G", "date"), official, "10.01")  # "10.01" is a date to a ru-RU Excel

    content = get_csv(client, official).content
    raw = content[len(BOM) :].decode("utf-8")
    lines = raw.split("\r\n")
    assert len(lines) == 4 + 1  # the header, three rows, and the empty piece after the last CRLF
    by_id = {line.split(";")[0]: line for line in lines[1:-1]}
    # a decimal comma, unquoted (the delimiter is `;`, so a comma needs no quotes), exact, two decimals
    assert by_id["t2"].startswith("t2;G;agent chat;RU;official-chat;1;84,17;84,17;0;;yes;16,67;")
    assert by_id["date"].startswith("date;G;agent chat;RU;official-chat;1;;10,01;0;;")  # no model total stored
    # a total that is null is an empty cell, and so are the criteria it has no results for
    assert by_id["none"].startswith("none;G;agent chat;RU;official-chat;1;;;0;;")
    assert '"' not in raw  # nothing was quoted

    # read back as cells: the number cells carry a comma and no point
    rows = {row[0]: dict(zip(parse(content)[0], row, strict=True)) for row in parse(content)[1:]}
    assert (rows["t2"]["original_total"], rows["t2"]["final_total"]) == ("84,17", "84,17")
    assert (rows["t2"]["c01_points"], rows["t2"]["c04_points"], rows["t2"]["c06_points"]) == ("16,67", "25,00", "17,50")
    assert (rows["none"]["original_total"], rows["none"]["final_total"]) == ("", "")
    number_columns = ("original_total", "final_total", "c01_points", "c04_points", "c05_points", "c06_points")
    assert not [row[column] for row in rows.values() for column in number_columns if "." in row[column]]
    # unchanged: the version is an integer, the gross-error cell 1/0, a step answer its integer value
    assert (rows["t2"]["version"], rows["t2"]["gross_error"], rows["t2"]["c04_answer"]) == ("1", "0", "15")


def test_csv_rows_are_ordered_by_group_then_conversation(setup) -> None:
    client, official = setup
    for group, conversation in (("B", "a"), ("A-1", "a"), ("A", "z"), ("A", "b")):
        put(add_conversation(group, conversation), official)
    rows = parse(get_csv(client, official).content)[1:]
    assert [(row[1], row[0]) for row in rows] == [("A", "b"), ("A", "z"), ("A-1", "a"), ("B", "a")]


def test_csv_group_filter_and_filename(setup) -> None:
    client, official = setup
    put(add_conversation("A", "x"), official)
    put(add_conversation("B", "y"), official)

    everything = get_csv(client, official)
    assert everything.headers["content-type"] == "text/csv; charset=utf-8"
    assert everything.headers["content-disposition"] == 'attachment; filename="cqa-all.csv"'
    assert [row[1] for row in parse(everything.content)[1:]] == ["A", "B"]

    only_b = get_csv(client, official, group_id="B")
    assert only_b.headers["content-disposition"] == 'attachment; filename="cqa-B.csv"'
    assert [row[1] for row in parse(only_b.content)[1:]] == ["B"]

    blank = get_csv(client, official, group_id="")
    assert blank.headers["content-disposition"] == 'attachment; filename="cqa-all.csv"'
    assert len(parse(blank.content)) == 3

    nobody = get_csv(client, official, group_id="nope")
    assert len(parse(nobody.content)) == 1  # the header alone


@pytest.mark.parametrize(
    ("group", "name"),
    [
        ("DEV", "DEV"),
        ("set-2.v1_b", "set-2.v1_b"),
        ('a b/c;d"e\r\nf', "a_b_c_d_e__f"),
        ("..", ".."),
        ("../etc/passwd", ".._etc_passwd"),
        ("Набор", "_____"),
    ],
)
def test_csv_filename_is_sanitised(setup, group: str, name: str) -> None:
    client, official = setup
    r = client.get("/api/export.csv", params=query(official, group_id=group))
    assert r.status_code == 200
    assert r.headers["content-disposition"] == f'attachment; filename="cqa-{name}.csv"'


def test_csv_default_checklist_when_omitted(setup) -> None:
    client, official = setup
    put(add_conversation("G", "x"), official)
    assert get_csv(client).content == get_csv(client, official).content


def test_csv_is_crlf_and_quotes_what_needs_it(setup) -> None:
    client, official = setup
    odd = 'say "hi"; bye\nnext\rline'
    conversation = add_conversation("G", odd)
    put(conversation, official)

    content = get_csv(client, official).content
    text = content[len(BOM) :].decode("utf-8")
    assert text.endswith("\r\n")
    assert text.count("\r\n") == 2  # one per row; the lone \n and \r inside the cell are not line ends
    rows = parse(content)
    assert len(rows) == 2
    assert rows[1][0] == odd  # one cell, however many delimiters, quotes and breaks it holds
    assert {len(row) for row in rows} == {len(rows[0])}


def test_csv_injection_is_neutralised(setup) -> None:
    client, official = setup
    hostile = ["=1+1", "+cmd", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd", '=HYPERLINK("http://x")']
    for n, conversation_id in enumerate(hostile):
        put(add_conversation("=group" if n == 0 else "G", conversation_id), official)

    rows = parse(get_csv(client, official).content)[1:]
    cells = {(row[1], row[0]) for row in rows}
    assert ("'=group", "'=1+1") in cells
    for conversation_id in hostile[1:]:
        assert ("G", "'" + conversation_id) in cells
    # nothing a spreadsheet would read as a formula is left at the start of a text cell
    assert not [cell for row in rows for cell in row[:2] if cell and cell[0] in "=+-@\t\r"]


def test_csv_injection_in_the_header_and_checklist_columns(setup) -> None:
    client, official = setup
    criteria = [c.model_copy(update={"id": "=" + c.id if c.id == "c01" else c.id}) for c in official.criteria]
    hostile = official.model_copy(
        update={"checklist_id": "@evil", "version": 1, "id": "@evil:1", "locked": False, "criteria": criteria}
    )
    store.save_checklist_version(hostile)
    put(add_conversation("G", "x"), hostile, {"=c01": "no"})
    put(add_conversation("G", "y"), hostile, {"c08": "yes"}, kinds={"c08": ["-bad", "=worse"]})

    rows = parse(get_csv(client, hostile).content)
    header = rows[0]
    assert "'=c01_answer" in header and "'=c01_points" in header
    assert "=c01_answer" not in header
    assert [row[header.index("checklist_id")] for row in rows[1:]] == ["'@evil", "'@evil"]
    assert rows[2][header.index("gross_error_kinds")] == "'-bad,=worse"


def test_csv_numbers_are_not_prefixed(setup) -> None:
    client, official = setup
    put(add_conversation("G", "x"), official, {"c04": StepAnswer(step=0)})
    rows = parse(get_csv(client, official).content)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["c04_answer"] == "0"
    assert row["version"] == "1"
    assert (row["original_total"], row["final_total"]) == ("80,00", "80,00")  # c04 weighs 20 of 100
    assert row["c04_points"] == "0,00"
    assert not any(cell.startswith("'") for cell in rows[1])


def test_csv_function_returns_bytes(setup) -> None:
    client, official = setup
    put(add_conversation("G", "x"), official)
    content = analytics.export_csv(official.checklist_id, official.version, None)
    assert isinstance(content, bytes)
    assert content.startswith(BOM)
    assert analytics.export_csv(official.checklist_id, official.version, "OTHER").count(b"\r\n") == 1
    with pytest.raises(ApiError) as caught:
        analytics.export_csv("nope", 1, None)
    assert caught.value.status == 404


def test_csv_and_analytics_agree(setup) -> None:
    client, official = setup
    ids = [add_conversation("G", f"x{n}") for n in range(4)]
    for conversation, answer in zip(ids, ("no", "no", "yes", "yes"), strict=True):
        put(conversation, official, {"c01": answer})
    rows = parse(get_csv(client, official).content)
    header = rows[0]
    fails = sum(row[header.index("c01_answer")] == "no" for row in rows[1:])
    assert criterion_row(get_analytics(client, official), "c01")["fail_rate"] == float(Fraction(fails, len(rows) - 1))
