"""Before/after comparison of final totals (Task 11, issue #13): GET /comparisons.

Stream C's evaluator is replaced by tests.app.fakes.FakeEvaluator (no network, no Claude API). Its
default answers give the official checklist 100 on every dialogue (yes everywhere, the top step on
every scale). Tests that need exact totals the model would not produce (null, three decimals) store
evaluations directly with `put`.
"""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app import comparisons, jobs, store
from app.errors import ApiError
from app.models import ChecklistVersion, Comparison, Evaluation, StepAnswer
from tests.app.fakes import FakeEvaluator, ensure_official, load_dev_subset
from tests.app.helpers import criterion, decide, file, save_copy, validate

MakeClient = Callable[..., TestClient]
KEY = {"ANTHROPIC_API_KEY": "test-key"}
START = datetime(2026, 11, 7, 12, 0, tzinfo=UTC)


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
def setup(make_client: MakeClient, fake: FakeEvaluator) -> tuple[TestClient, list[str], ChecklistVersion]:
    client = make_client(**KEY)
    return client, load_dev_subset(), ensure_official()


# --- helpers -------------------------------------------------------------------------------


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


def no_change(copied: dict) -> None:
    """A copy that differs from its source in the id only."""


def compare_url(old: ChecklistVersion, new: ChecklistVersion, query: str = "") -> str:
    base = (
        f"/api/comparisons?from_checklist={old.checklist_id}&from_version={old.version}"
        f"&to_checklist={new.checklist_id}&to_version={new.version}"
    )
    return f"{base}&{query}" if query else base


def get_comparison(client: TestClient, old: ChecklistVersion, new: ChecklistVersion, query: str = "") -> dict:
    r = client.get(compare_url(old, new, query))
    assert r.status_code == 200, r.text
    body = r.json()
    validate("comparison", body)
    Comparison.model_validate(body)  # the model reads back what the route sends
    return body


def put(
    conversation: str,
    version: ChecklistVersion,
    total: str | None,
    *,
    status: str = "done",
    seconds: int = 0,
) -> None:
    """Store an evaluation of `conversation` with this final total, `seconds` after START."""
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


def only_row(client: TestClient, old: ChecklistVersion, new: ChecklistVersion) -> dict:
    rows = get_comparison(client, old, new)["rows"]
    assert len(rows) == 1
    return rows[0]


def repeated(*conversations: str) -> str:
    """The UI's form of the filter: one `conversations` parameter per id, the colon URL-encoded."""
    return "&".join(f"conversations={c.replace(':', '%3A')}" for c in conversations)


def row_ids(body: dict) -> list[str]:
    return [row["conversation"] for row in body["rows"]]


# --- the brief's tests ---------------------------------------------------------------------


def test_compare_across_checklists(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup
    fake.answers = {"c06": StepAnswer(step=10)}
    before = run(client, ids, official)
    assert {ev["final_total"] for ev in before.values()} == {100.0}

    def replace_c06(copied: dict) -> None:
        # the scale becomes a yes/no question under a new id: a replaced criterion
        criterion(copied, "c06").update(
            id="c06b", title="Скорость ответа", wording="Да — оператор отвечал быстро.",
            answer_type="yes_no", scale_steps=[],
        )  # fmt: skip

    copy = save_copy(client, official, replace_c06)
    worse = [ids[1], ids[5]]
    fake.answers = {"c06b": "yes"}
    run(client, [i for i in ids if i not in worse], copy)
    fake.answers = {"c06b": "no"}
    after = run(client, worse, copy)
    assert {ev["final_total"] for ev in after.values()} == {85.0}  # c06b weighs 15 of 100

    body = get_comparison(client, official, copy)
    assert body["from"] == {"checklist_id": official.checklist_id, "version": 1, "name": official.name}
    assert body["to"] == {"checklist_id": copy.checklist_id, "version": 1, "name": copy.name}
    assert body["summary"] == {"total": 6, "changed": 2, "avg_delta": -5.0}
    assert row_ids(body) == sorted(ids)
    for row in body["rows"]:
        gone = row["conversation"] in worse
        assert row["old_total"] == 100.0
        assert row["new_total"] == (85.0 if gone else 100.0)
        assert row["delta"] == (-15.0 if gone else 0.0)
        group_id, conversation_id = row["conversation"].split(":", 1)
        assert (row["group_id"], row["conversation_id"]) == (group_id, conversation_id)


def test_compare_uses_final_totals(setup, fake: FakeEvaluator) -> None:
    client, ids, official = setup
    first = run(client, ids[:1], official)[ids[0]]
    assert first["final_total"] == 100.0
    appeal = file(client, first["id"], "c06")
    decided = decide(client, appeal["id"], answer={"step": 4})
    assert (decided["original_total"], decided["final_total"]) == (100.0, 91.0)

    # the decision carries into the copy (same criteria, same transcript): nothing is judged again
    copy = save_copy(client, official, no_change)
    fake.calls = 0
    second = run(client, ids[:1], copy)[ids[0]]
    assert fake.calls == 0
    assert (second["original_total"], second["final_total"]) == (100.0, 91.0)

    body = get_comparison(client, official, copy)
    assert body["rows"] == [
        {
            "conversation": ids[0],
            "conversation_id": "p1-ru-001",
            "group_id": "DEV",
            "old_total": 91.0,
            "new_total": 91.0,
            "delta": 0.0,
        }
    ]
    assert body["summary"] == {"total": 1, "changed": 0, "avg_delta": 0.0}


def test_missing_side_null_delta(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    run(client, ids[0:3], official)
    run(client, ids[2:4], copy)  # ids[2] is graded on both sides, ids[0:2] and ids[3] on one

    body = get_comparison(client, official, copy)
    assert row_ids(body) == sorted(ids[0:4])  # ids[4:] have no evaluation on either side
    rows = {row["conversation"]: row for row in body["rows"]}
    assert (rows[ids[0]]["old_total"], rows[ids[0]]["new_total"], rows[ids[0]]["delta"]) == (100.0, None, None)
    assert (rows[ids[1]]["old_total"], rows[ids[1]]["new_total"], rows[ids[1]]["delta"]) == (100.0, None, None)
    assert (rows[ids[2]]["old_total"], rows[ids[2]]["new_total"], rows[ids[2]]["delta"]) == (100.0, 100.0, 0.0)
    assert (rows[ids[3]]["old_total"], rows[ids[3]]["new_total"], rows[ids[3]]["delta"]) == (None, 100.0, None)
    # a total against nothing is a change; the average covers the one row that has a delta
    assert body["summary"] == {"total": 4, "changed": 3, "avg_delta": 0.0}


def test_scope_by_conversations(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    for n, conversation in enumerate(ids):
        put(conversation, official, "50.00")
        put(conversation, copy, f"{50 + n}.00")
    a, b, c = sorted(ids)[:3]

    # repeated parameters (the UI's form), ids URL-encoded
    body = get_comparison(client, official, copy, repeated(b, a))
    assert row_ids(body) == [a, b]  # ordered by group and conversation id, not as asked
    assert body["summary"]["total"] == 2
    # comma-separated, with the colon encoded or not
    assert row_ids(get_comparison(client, official, copy, f"conversations={a},{b}")) == [a, b]
    assert row_ids(get_comparison(client, official, copy, f"conversations={a.replace(':', '%3A')}%2C{b}")) == [a, b]
    # both forms at once, blanks trimmed, repeats counted once, an unknown id matches nothing
    mixed = f"conversations=%20{a}%20,,{b}&conversations={a}&conversations=&conversations={c},DEV:unknown"
    assert row_ids(get_comparison(client, official, copy, mixed)) == [a, b, c]
    # no value at all is no filter
    assert len(get_comparison(client, official, copy, "conversations=")["rows"]) == len(ids)
    assert len(get_comparison(client, official, copy, "conversations=,%20,")["rows"]) == len(ids)
    # the summary covers the rows in scope only
    only_c = get_comparison(client, official, copy, f"conversations={c}")
    assert only_c["summary"] == {"total": 1, "changed": 1, "avg_delta": 2.0}


def test_group_filter_and_order(make_client: MakeClient, fake: FakeEvaluator) -> None:
    client = make_client(**KEY)
    official = ensure_official()
    copy = save_copy(client, official, no_change)
    # "A:x" sorts after "A-1:x" as text; by group id and then conversation id it comes first
    inside, beside = load_dev_subset("A"), load_dev_subset("A-1")
    for conversation in inside + beside:
        put(conversation, official, "60.00")
        put(conversation, copy, "70.00")
    put("DEV:ghost", official, "60.00")  # an evaluation without a stored conversation has no group

    body = get_comparison(client, official, copy)
    assert [(row["group_id"], row["conversation_id"]) for row in body["rows"]] == [
        *(("A", cid) for cid in sorted(i.split(":", 1)[1] for i in inside)),
        *(("A-1", cid) for cid in sorted(i.split(":", 1)[1] for i in beside)),
    ]
    assert body["summary"] == {"total": 12, "changed": 12, "avg_delta": 10.0}

    scoped = get_comparison(client, official, copy, "group_id=A-1")
    assert row_ids(scoped) == sorted(beside)
    # a blank group is no group filter; group and conversations both apply
    assert len(get_comparison(client, official, copy, "group_id=")["rows"]) == 12
    both = get_comparison(client, official, copy, f"group_id=A&conversations={inside[0]},{beside[0]}")
    assert row_ids(both) == [inside[0]]
    assert get_comparison(client, official, copy, "group_id=nope")["rows"] == []


def test_null_totals(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    a, b, c, d, e, *_ = sorted(ids)
    put(a, official, "80.00"), put(a, copy, None)  # not calculated on the new side
    put(b, official, None), put(b, copy, None)  # not calculated on either side
    put(c, official, "50"), put(c, copy, "50.00")  # the same number
    put(d, official, "60.00"), put(d, copy, "65.50")
    put(e, official, "0.00"), put(e, copy, None)  # zero is a total, not "not calculated"

    body = get_comparison(client, official, copy)
    by_id = {row["conversation"]: row for row in body["rows"]}
    assert (by_id[a]["old_total"], by_id[a]["new_total"], by_id[a]["delta"]) == (80.0, None, None)
    assert (by_id[b]["old_total"], by_id[b]["new_total"], by_id[b]["delta"]) == (None, None, None)
    assert (by_id[c]["old_total"], by_id[c]["new_total"], by_id[c]["delta"]) == (50.0, 50.0, 0.0)
    assert by_id[d]["delta"] == 5.5
    assert (by_id[e]["old_total"], by_id[e]["new_total"], by_id[e]["delta"]) == (0.0, None, None)
    # b has a row (both sides were graded) but is no change; the average skips the null deltas
    assert body["summary"] == {"total": 5, "changed": 3, "avg_delta": 2.75}

    only_nulls = get_comparison(client, official, copy, f"conversations={a},{b}")
    assert only_nulls["summary"] == {"total": 2, "changed": 1, "avg_delta": None}


@pytest.mark.parametrize(
    ("old", "new", "delta"),
    [
        ("1.000", "1.005", 0.01),  # half-up (as floats the difference is 0.004999999999999893)
        ("1.005", "1.000", -0.01),  # half-up, away from zero
        ("10.000", "10.004", 0.0),
        ("0.10", "0.30", 0.2),
        ("84.17", "92.50", 8.33),
    ],
)
def test_delta_is_exact_and_half_up(setup, old: str, new: str, delta: float) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    put(ids[0], official, old), put(ids[0], copy, new)
    row = only_row(client, official, copy)
    assert row["delta"] == delta
    assert row["old_total"] == float(old) and row["new_total"] == float(new)


def test_average_comes_from_the_exact_deltas(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    # exact deltas 0.005, 0.005 and 0.004 (rows show 0.01, 0.01, 0.00); the exact mean is
    # 0.014 / 3 = 0.00467, which rounds to 0.00, where the mean of the shown deltas would give 0.01
    for conversation, old, new in zip(sorted(ids), ("10.000", "20.000", "30.000"), ("10.005", "20.005", "30.004")):
        put(conversation, official, old), put(conversation, copy, new)
    body = get_comparison(client, official, copy)
    assert [row["delta"] for row in body["rows"]] == [0.01, 0.01, 0.0]
    assert body["summary"] == {"total": 3, "changed": 3, "avg_delta": 0.0}


def test_each_side_uses_its_latest_done_evaluation(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    a, b, *_ = sorted(ids)
    put(a, official, "10.00", seconds=1)
    put(a, official, "20.00", seconds=2)  # the latest done one counts
    put(a, official, "99.00", seconds=3, status="failed")  # newer, but not done
    put(a, official, "98.00", seconds=4, status="queued")
    put(a, copy, "30.00", seconds=1)
    put(a, copy, "40.00", seconds=5, status="running")
    put(b, official, "70.00", seconds=1, status="failed")  # never graded on this side
    put(b, copy, "70.00", seconds=1)

    body = get_comparison(client, official, copy)
    by_id = {row["conversation"]: row for row in body["rows"]}
    assert (by_id[a]["old_total"], by_id[a]["new_total"], by_id[a]["delta"]) == (20.0, 30.0, 10.0)
    assert (by_id[b]["old_total"], by_id[b]["new_total"], by_id[b]["delta"]) == (None, 70.0, None)


def test_nothing_graded(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    body = get_comparison(client, official, copy)
    assert body["rows"] == []
    assert body["summary"] == {"total": 0, "changed": 0, "avg_delta": None}
    assert body["from"]["name"] == official.name  # the sides are still described


def test_a_version_against_itself_changes_nothing(setup) -> None:
    client, ids, official = setup
    for conversation in ids[:2]:
        put(conversation, official, "75.25")
    body = get_comparison(client, official, official)
    assert body["summary"] == {"total": 2, "changed": 0, "avg_delta": 0.0}
    assert [row["delta"] for row in body["rows"]] == [0.0, 0.0]


def test_conversation_keys(setup) -> None:
    client, ids, official = setup
    assert store.conversation_keys([]) == {}
    keys = store.conversation_keys([ids[0], "DEV:unknown", ids[5], ids[0]])
    assert keys == {ids[0]: ("DEV", "p1-ru-001"), ids[5]: ("DEV", "p4-ru-001")}


def test_compare_function(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    put(ids[0], official, "50.00"), put(ids[0], copy, "60.00")
    old, new = (official.checklist_id, official.version), (copy.checklist_id, copy.version)

    result = comparisons.compare(old, new, None, None)
    assert isinstance(result, Comparison)
    assert result.summary.avg_delta == Decimal("10.00")
    assert result.rows[0].delta == Decimal("10.00")
    # an empty list of conversations is an empty scope; the route turns a blank value into None
    assert comparisons.compare(old, new, None, []).rows == []
    assert comparisons.compare(old, new, "DEV", [ids[0], ids[0]]).summary.total == 1
    assert comparisons.compare(old, new, "OTHER", None).summary.total == 0


# --- errors --------------------------------------------------------------------------------


def test_missing_version_is_404(setup) -> None:
    client, ids, official = setup
    copy = save_copy(client, official, no_change)
    unknown = [
        ("nope", 1, copy.checklist_id, 1),  # from: no such checklist
        (official.checklist_id, 2, copy.checklist_id, 1),  # from: no such version
        (official.checklist_id, 1, "nope", 1),  # to: no such checklist
        (official.checklist_id, 1, copy.checklist_id, 7),  # to: no such version
        (official.checklist_id, 0, copy.checklist_id, 1),  # a version number that cannot exist
        (official.checklist_id, 1, copy.checklist_id, -3),
    ]
    for from_checklist, from_version, to_checklist, to_version in unknown:
        r = client.get(
            "/api/comparisons",
            params={
                "from_checklist": from_checklist, "from_version": from_version,
                "to_checklist": to_checklist, "to_version": to_version,
            },
        )  # fmt: skip
        assert r.status_code == 404, (from_checklist, from_version, to_checklist, to_version)
        assert r.json()["error"] == "not_found"
        validate("error", r.json())
    with pytest.raises(ApiError) as caught:
        comparisons.compare(("nope", 1), (copy.checklist_id, 1), None, None)
    assert caught.value.status == 404


@pytest.mark.parametrize("missing", ["from_checklist", "from_version", "to_checklist", "to_version"])
def test_the_four_references_are_required(setup, missing: str) -> None:
    client, ids, official = setup
    params = {
        "from_checklist": official.checklist_id, "from_version": 1,
        "to_checklist": official.checklist_id, "to_version": 1,
    }  # fmt: skip
    del params[missing]
    r = client.get("/api/comparisons", params=params)
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_request"
    assert missing in r.json()["message"]


def test_a_version_number_must_be_an_integer(setup) -> None:
    client, ids, official = setup
    r = client.get(compare_url(official, official).replace("from_version=1", "from_version=one"))
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_request"
