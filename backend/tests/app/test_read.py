"""The read endpoints (Task 9, issue #11): the queue, one conversation, evaluations and
`store.list_evaluations`.

Evaluations come from real jobs (stream C's evaluator replaced by FakeEvaluator) where the test is
about what a job leaves behind, and are written straight into the store where it needs exact
timestamps, statuses or `needs_review` flags that a job would not produce.
"""

import json
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import jobs, store
from app.models import ChecklistVersion, CriterionResult, Evaluation, GrossError, QueueItem
from app.transcript import normalize_record
from tests.app.fakes import FakeEvaluator, dev_records, ensure_official, load_dev_subset

MakeClient = Callable[..., TestClient]
KEY = {"ANTHROPIC_API_KEY": "test-key"}
SECRET_URL = "https://media.example/call.mp3?sig=LEAK"

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SCHEMAS_DIR = REPO_ROOT / "contract" / "schemas"

DEV = "DEV"
CHAT = f"{DEV}:p1-ru-001"
CALL = f"{DEV}:p4-ru-001"
OTHER_CHAT = f"{DEV}:p1-ru-010"
ALL_DEV = [f"{DEV}:{r['conversation_id']}" for r in dev_records()]


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
    client = make_client(**KEY)
    load_dev_subset()
    return client, ensure_official()


# --- helpers -------------------------------------------------------------------------------


def run_job(client: TestClient, conversations: list[str], version: ChecklistVersion) -> dict:
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
    r = client.get(f"/api/jobs/{job_id}")
    assert r.status_code == 200, r.text
    return r.json()


def queue(client: TestClient, **params: str) -> list[dict]:
    r = client.get("/api/conversations", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def queue_ids(client: TestClient, **params: str) -> list[str]:
    return [item["id"] for item in queue(client, **params)]


def validate_queue_item(item: dict) -> None:
    """Against stream A's schema, once contract/ exists; QueueItem always."""
    QueueItem.model_validate(item)
    if not SCHEMAS_DIR.is_dir():
        return
    from jsonschema import Draft202012Validator

    schema = json.loads((SCHEMAS_DIR / "queue-item.schema.json").read_text(encoding="utf-8"))
    Draft202012Validator(schema).validate(item)


T0 = datetime(2026, 11, 7, 9, 0, 0, tzinfo=UTC)


def evaluation(
    conversation: str,
    *,
    id: str,
    status: str = "done",
    minutes: int = 0,
    checklist: tuple[str, int] = ("official-chat", 1),
    total: str | None = "80.00",
    needs_review: bool = False,
    gross_error: bool = False,
    seconds: float = 0,
) -> Evaluation:
    """An evaluation written straight into the store at T0 + `minutes`."""
    done = status == "done"
    results = []
    if done:
        results = [
            CriterionResult(
                criterion_id=criterion_id, answer="yes", explanation="because", confidence="high",
                needs_review=needs_review and criterion_id == "c02",
                points=Decimal(10), effective_weight=Decimal(10),
            )
            for criterion_id in ("c01", "c02", "c03")
        ]  # fmt: skip
    ev = Evaluation(
        id=id, created_at=T0 + timedelta(minutes=minutes, seconds=seconds), conversation=conversation,
        checklist_id=checklist[0], version=checklist[1], status=status,
        results=results,
        original_total=Decimal(total) if done and total else None,
        final_total=Decimal(total) if done and total else None,
        gross_error=GrossError(flag=gross_error),
    )  # fmt: skip
    store.insert_evaluation(ev)
    return ev


def count_connections(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Count the database connections the store opens from now on."""
    opened = [0]
    real = store.connect

    def counting():
        opened[0] += 1
        return real()

    monkeypatch.setattr(store, "connect", counting)
    return opened


# --- the queue: shape ----------------------------------------------------------------------


def test_queue_has_no_transcript_or_audio_url(setup) -> None:
    client, _ = setup
    # The call has a signed link in the database (a secret): it must not reach the queue.
    call, url = normalize_record(
        {**next(r for r in dev_records() if r["conversation_id"] == "p4-ru-001"), "audio_url": SECRET_URL}, DEV
    )
    assert url == SECRET_URL
    store.upsert_conversation(call, url)

    r = client.get("/api/conversations")
    assert r.status_code == 200
    items = r.json()
    assert [item["id"] for item in items] == sorted(ALL_DEV)
    for item in items:
        assert "transcript" not in item
        assert "audio_url" not in item
        validate_queue_item(item)
    assert "sig=" not in r.text and "LEAK" not in r.text
    call_item = next(item for item in items if item["id"] == CALL)
    assert call_item["audio"] is not None  # the relative path of our own endpoint, not the link


def test_queue_item_keeps_the_conversation_fields(setup) -> None:
    client, _ = setup
    item = next(i for i in queue(client) if i["id"] == CHAT)
    stored = client.get(f"/api/conversations/{CHAT}").json()
    assert {k: v for k, v in stored.items() if k != "transcript"} == {k: v for k, v in item.items() if k != "final"}
    assert item["group_id"] == DEV and item["conversation_id"] == "p1-ru-001"
    assert item["channel"] == "agent chat" and item["language"] == "RU" and item["status"] == "new"


def test_queue_is_empty_without_conversations(client: TestClient) -> None:
    assert queue(client) == []


# --- the queue: final ----------------------------------------------------------------------


def test_final_null_until_graded(setup) -> None:
    client, official = setup
    items = queue(client)
    assert len(items) == 6
    assert all(item["final"] is None and "final" in item for item in items)

    job = run_job(client, [CHAT, CALL], official)
    evaluations = {i["conversation"]: client.get(f"/api/evaluations/{i['evaluation_id']}").json() for i in job["items"]}

    by_id = {item["id"]: item for item in queue(client)}
    for conversation in (CHAT, CALL):
        final = by_id[conversation]["final"]
        assert final == {
            "checklist_id": "official-chat",
            "version": 1,
            "total": evaluations[conversation]["final_total"],
            "gross_error": False,
            "open_appeals": 0,
            "needs_review": False,
        }
        assert final["total"] == 100.0
        validate_queue_item(by_id[conversation])
    graded = {CHAT, CALL}
    assert all(item["final"] is None for cid, item in by_id.items() if cid not in graded)
    assert {cid: item["status"] for cid, item in by_id.items()}[CHAT] == "evaluated"


def test_final_is_the_latest_done_evaluation_of_the_default_checklist(setup) -> None:
    client, _ = setup
    evaluation(CHAT, id="old", minutes=0, total="60.00")
    evaluation(CHAT, id="new", minutes=5, total="90.50")
    evaluation(CHAT, id="newer-but-failed", minutes=9, status="failed")
    evaluation(CHAT, id="newer-but-running", minutes=10, status="running")
    evaluation(CHAT, id="newer-but-queued", minutes=11, status="queued")
    evaluation(CHAT, id="other-version", minutes=12, checklist=("official-chat", 2), total="10.00")
    evaluation(CHAT, id="other-checklist", minutes=13, checklist=("custom", 1), total="20.00")

    final = next(i for i in queue(client) if i["id"] == CHAT)["final"]
    assert final["total"] == 90.5
    assert (final["checklist_id"], final["version"]) == ("official-chat", 1)


def test_final_without_a_done_evaluation_is_null(setup) -> None:
    client, _ = setup
    evaluation(CHAT, id="failed", status="failed")
    evaluation(CALL, id="elsewhere", checklist=("custom", 1))
    assert all(item["final"] is None for item in queue(client))


def test_final_gross_error_needs_review_and_a_total_that_is_not_calculated(setup) -> None:
    client, _ = setup
    evaluation(CHAT, id="flagged", gross_error=True, needs_review=True, total="51.00")
    evaluation(CALL, id="blank", total=None)
    evaluation(OTHER_CHAT, id="plain")

    by_id = {item["id"]: item["final"] for item in queue(client)}
    assert by_id[CHAT]["gross_error"] is True and by_id[CHAT]["needs_review"] is True
    assert by_id[CHAT]["total"] == 51.0
    assert by_id[CALL]["total"] is None and by_id[CALL]["gross_error"] is False
    assert by_id[OTHER_CHAT]["needs_review"] is False and by_id[OTHER_CHAT]["total"] == 80.0
    for item in queue(client):
        validate_queue_item(item)


def test_final_open_appeals_come_from_the_store(setup, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = setup
    evaluation(CHAT, id="graded-1")
    evaluation(CALL, id="graded-2")
    asked: list[list[str]] = []

    def counts(evaluation_ids: list[str]) -> dict[str, int]:
        asked.append(sorted(evaluation_ids))
        return {"graded-1": 2, "graded-2": 0}

    monkeypatch.setattr(store, "count_open_appeals", counts)
    by_id = {item["id"]: item["final"] for item in queue(client)}
    assert by_id[CHAT]["open_appeals"] == 2 and by_id[CALL]["open_appeals"] == 0
    assert asked == [["graded-1", "graded-2"]]  # one batch for the whole queue, not one call each


def test_count_open_appeals_is_a_batch_that_answers_every_id(client: TestClient) -> None:
    assert store.count_open_appeals([]) == {}
    assert store.count_open_appeals(["a", "b", "a"]) == {"a": 0, "b": 0}


def test_queue_does_not_query_per_conversation(setup, monkeypatch: pytest.MonkeyPatch) -> None:
    client, _ = setup
    for index, conversation in enumerate(ALL_DEV):
        evaluation(conversation, id=f"e{index}")
    opened = count_connections(monkeypatch)
    assert len(queue(client)) == 6
    few = opened[0]

    load_dev_subset("CTRL")  # twice the conversations, all graded
    for index, conversation in enumerate(ALL_DEV):
        evaluation(conversation.replace(DEV, "CTRL", 1), id=f"c{index}")
    opened[0] = 0
    assert len(queue(client)) == 12
    assert opened[0] == few
    assert 1 <= few <= 3


# --- the queue: filters and order ----------------------------------------------------------


def test_filters(setup) -> None:
    client, _ = setup
    assert queue_ids(client, channel="voice call") == [CALL]
    assert queue_ids(client, language="RU") == sorted(ALL_DEV)
    assert len(queue_ids(client, language="RU")) == 6
    assert queue_ids(client, q="Кабинет") == [CHAT]


def test_group_and_status_filters(setup) -> None:
    client, official = setup
    load_dev_subset("CTRL")
    run_job(client, [CHAT], official)
    assert queue_ids(client, group_id="CTRL") == sorted(c.replace(DEV, "CTRL", 1) for c in ALL_DEV)
    assert queue_ids(client, group_id=DEV, status="evaluated") == [CHAT]
    assert len(queue_ids(client, status="new")) == 11
    assert queue_ids(client, status="disputed") == []
    assert queue_ids(client, group_id="NOPE") == []
    assert queue_ids(client, group_id="CTRL", status="evaluated") == []


def test_filters_combine(setup) -> None:
    client, _ = setup
    assert queue_ids(client, channel="agent chat", q="кабинет") == [CHAT]
    assert queue_ids(client, channel="voice call", q="кабинет") == []
    assert queue_ids(client, language="EN") == []  # exact, and nothing is English here
    assert queue_ids(client, language="ru") == []  # exact: not case-insensitive
    assert queue_ids(client, channel="chat") == []  # exact: not a prefix match


def test_q_is_case_insensitive_over_id_topic_and_message_text(setup) -> None:
    client, official = setup
    assert queue_ids(client, q="кабинет") == queue_ids(client, q="КАБИНЕТ") == [CHAT]
    assert queue_ids(client, q="P4-RU-001") == [CALL]  # the organisers' conversation_id
    assert queue_ids(client, q="p1-ru-0") == sorted(c for c in ALL_DEV if "p1-ru-0" in c)
    assert queue_ids(client, q="fake topic") == []  # the topic is not known before an evaluation
    run_job(client, [OTHER_CHAT], official)
    assert queue_ids(client, q="FAKE topic") == [OTHER_CHAT]  # info.topic
    assert queue_ids(client, q="  fake  ") == [OTHER_CHAT]  # surrounding blanks do not count
    assert queue_ids(client, q="zzz-no-such-text") == []


def test_q_does_not_match_the_json_around_the_text(setup) -> None:
    client, _ = setup
    # Keys of the stored JSON. (Not "transcript": a real call says that word aloud.)
    for key_name in ("speaker", "timestamp", "duplicate", "conversation_json", "audio_unavailable_reason"):
        assert queue_ids(client, q=key_name) == []


def test_q_matches_a_quote_or_backslash_in_a_message_as_itself(setup) -> None:
    client, _ = setup
    record = {**next(r for r in dev_records() if r["conversation_id"] == "p1-ru-012")}
    record["conversation_id"] = "quoted-1"
    record["transcript"] = [
        {**record["transcript"][0], "text": 'Он сказал "ДА" и ушёл, путь C:\\temp'},
        *record["transcript"][1:],
    ]
    conversation, _ = normalize_record({k: v for k, v in record.items() if k != "audio_url"}, DEV)
    store.upsert_conversation(conversation, None)

    assert queue_ids(client, q='"да"') == [f"{DEV}:quoted-1"]
    assert queue_ids(client, q="c:\\TEMP") == [f"{DEV}:quoted-1"]
    assert queue_ids(client, q='\\"') == []  # the escaped form never existed in the text


def test_blank_filters_are_not_filters(setup) -> None:
    client, _ = setup
    assert queue_ids(client, group_id="", status="", channel="", language="", q="") == sorted(ALL_DEV)
    assert queue_ids(client, q="   ") == sorted(ALL_DEV)


def test_queue_order_is_group_then_conversation_id(setup) -> None:
    client, _ = setup
    load_dev_subset("AAA")
    load_dev_subset("ZZZ")
    items = queue(client)
    keys = [(item["group_id"], item["conversation_id"]) for item in items]
    assert keys == sorted(keys)
    assert [g for g, _ in keys][:1] == ["AAA"] and [g for g, _ in keys][-1:] == ["ZZZ"]
    assert len(keys) == 18


# --- GET /conversations/{id} ---------------------------------------------------------------


def test_get_conversation_has_the_transcript_and_no_audio_url(setup) -> None:
    client, _ = setup
    call, url = normalize_record(
        {**next(r for r in dev_records() if r["conversation_id"] == "p4-ru-001"), "audio_url": SECRET_URL}, DEV
    )
    store.upsert_conversation(call, url)
    r = client.get(f"/api/conversations/{CALL}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == CALL and len(body["transcript"]) == 45
    assert "audio_url" not in body and "LEAK" not in r.text
    assert "final" not in body


def test_get_unknown_conversation_is_not_found(setup) -> None:
    client, _ = setup
    r = client.get("/api/conversations/DEV:nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


# --- GET /evaluations ----------------------------------------------------------------------


def listed(client: TestClient, **params: str) -> list[dict]:
    r = client.get("/api/evaluations", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def test_evaluations_list_newest_first(setup) -> None:
    client, official = setup
    first = run_job(client, [CHAT], official)["items"][0]["evaluation_id"]
    second = run_job(client, [CHAT], official)["items"][0]["evaluation_id"]
    run_job(client, [CALL], official)

    mine = listed(client, conversation=CHAT)
    assert [e["id"] for e in mine] == [second, first]
    created = [e["created_at"] for e in mine]
    assert created == sorted(created, reverse=True)
    for item in mine:
        assert item["conversation"] == CHAT and item["status"] == "done"
        assert not any("reuse_key" in r or "calls" in r for r in item["results"])
    assert mine[0] == client.get(f"/api/evaluations/{second}").json()


def test_evaluations_list_order_with_equal_timestamps_uses_the_id(setup) -> None:
    client, _ = setup
    evaluation(CHAT, id="b", minutes=1)
    evaluation(CHAT, id="a", minutes=1)
    evaluation(CHAT, id="c", minutes=1)
    evaluation(CHAT, id="z", minutes=0)
    evaluation(CHAT, id="y", minutes=2, seconds=0.5)
    assert [e["id"] for e in listed(client, conversation=CHAT)] == ["y", "c", "b", "a", "z"]


def test_evaluations_list_filters(setup) -> None:
    client, _ = setup
    evaluation(CHAT, id="chat-official", minutes=0)
    evaluation(CHAT, id="chat-custom", minutes=1, checklist=("custom", 1))
    evaluation(CHAT, id="chat-failed", minutes=2, status="failed")
    evaluation(CALL, id="call-official", minutes=3)

    assert [e["id"] for e in listed(client)] == ["call-official", "chat-failed", "chat-custom", "chat-official"]
    assert [e["id"] for e in listed(client, conversation=CHAT)] == ["chat-failed", "chat-custom", "chat-official"]
    assert [e["id"] for e in listed(client, checklist_id="official-chat")] == [
        "call-official", "chat-failed", "chat-official",
    ]  # fmt: skip
    assert [e["id"] for e in listed(client, conversation=CHAT, checklist_id="custom")] == ["chat-custom"]
    assert listed(client, conversation="DEV:nope") == []
    assert listed(client, conversation=CHAT, checklist_id="nope") == []
    assert listed(client, conversation="", checklist_id="") == listed(client)


def test_evaluations_list_validates_against_the_contract(setup) -> None:
    client, official = setup
    run_job(client, [CHAT], official)
    items = listed(client)
    assert len(items) == 1
    Evaluation.model_validate(items[0])
    if SCHEMAS_DIR.is_dir():
        from jsonschema import Draft202012Validator

        schema = json.loads((SCHEMAS_DIR / "evaluation.schema.json").read_text(encoding="utf-8"))
        Draft202012Validator(schema).validate(items[0])


def test_get_evaluation_by_id(setup) -> None:
    client, _ = setup
    evaluation(CHAT, id="one")
    assert client.get("/api/evaluations/one").json()["id"] == "one"
    r = client.get("/api/evaluations/nope")
    assert r.status_code == 404 and r.json()["error"] == "not_found"


# --- store.list_evaluations (shared interface, used by stream D's accuracy report) ---------


def test_list_evaluations_is_the_latest_done_per_conversation(setup) -> None:
    client, _ = setup
    evaluation(CHAT, id="chat-old", minutes=0, total="10.00")
    evaluation(CHAT, id="chat-new", minutes=1, total="20.00")
    evaluation(CHAT, id="chat-failed", minutes=2, status="failed")
    evaluation(CALL, id="call-only", minutes=0)
    evaluation(OTHER_CHAT, id="other-version", minutes=0, checklist=("official-chat", 2))
    evaluation(OTHER_CHAT, id="other-checklist", minutes=0, checklist=("custom", 1))

    found = store.list_evaluations("official-chat", 1)
    assert [(e.conversation, e.id) for e in found] == [(CHAT, "chat-new"), (CALL, "call-only")]
    assert all(isinstance(e, Evaluation) and e.status == "done" for e in found)
    assert [e.id for e in store.list_evaluations("official-chat", 2)] == ["other-version"]
    assert [e.id for e in store.list_evaluations("custom", 1)] == ["other-checklist"]
    assert store.list_evaluations("official-chat", 99) == []
    assert store.list_evaluations("missing", 1) == []


def test_list_evaluations_can_be_restricted_to_a_group(setup) -> None:
    client, _ = setup
    load_dev_subset("CTRL")
    evaluation(CHAT, id="dev-chat")
    evaluation("CTRL:p1-ru-001", id="ctrl-chat", minutes=1)
    evaluation("CTRL:p4-ru-001", id="ctrl-call", minutes=1)

    assert [e.id for e in store.list_evaluations("official-chat", 1, group_id="CTRL")] == ["ctrl-chat", "ctrl-call"]
    assert [e.id for e in store.list_evaluations("official-chat", 1, group_id=DEV)] == ["dev-chat"]
    assert store.list_evaluations("official-chat", 1, group_id="NOPE") == []
    # sorted by conversation id: CTRL:... before DEV:...
    assert [e.id for e in store.list_evaluations("official-chat", 1)] == ["ctrl-chat", "ctrl-call", "dev-chat"]


def test_list_evaluations_returns_full_evaluations(setup) -> None:
    client, official = setup
    job = run_job(client, [CHAT], official)
    found = store.list_evaluations(official.checklist_id, official.version)
    assert len(found) == 1
    assert found[0] == store.get_evaluation(job["items"][0]["evaluation_id"])
    assert found[0].results and found[0].results[0].calls  # the stored model, nothing stripped
