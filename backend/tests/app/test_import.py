"""Import by group_id and by upload (Task 6): the conversation store, the importer, the routes.

The organisers' endpoint is faked with respx (https://org.example/run?sp=x&sig=FAKE&group_id=DEV,
set through ORGANIZER_API_URL); no test reaches a network. The six DEV records come from the
committed fixture, which has no signed URL.
"""

import asyncio
import importlib.util
import json
import logging
import sys
import time
import types
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from importlib.machinery import ModuleSpec
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from fastapi.testclient import TestClient

from app import db, importer, store
from app.errors import ApiError
from app.models import AudioOffset, VoiceMeasurement
from app.settings import get_settings
from app.transcript import normalize_record
from tests.app.helpers import validate

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "dev_subset.json"
ORGANIZER_URL = "https://org.example/run?sp=x&sig=FAKE&group_id=DEV"
CALL_ID = "p4-ru-001"
MakeClient = Callable[..., TestClient]


def dev_records() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def organizer_response(records: list[dict], group: str = "DEV") -> dict:
    return {
        "error": "",
        "isSuccess": True,
        "data": {"dataset_group_id": group, "total_records": len(records), "records": records},
    }


def with_audio(records: list[dict], url: str = "https://media.example/a?sig=Z") -> list[dict]:
    return [{**r, "audio_url": url} if r["conversation_id"] == CALL_ID else r for r in records]


def stored_count() -> int:
    conn = db.connect()
    try:
        return conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]
    finally:
        conn.close()


def stored_row(conversation: str) -> dict:
    conn = db.connect()
    try:
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation,)).fetchone()
        return dict(row) if row else {}
    finally:
        conn.close()


@pytest.fixture
def organizer(monkeypatch: pytest.MonkeyPatch) -> Iterator[respx.MockRouter]:
    """The organisers' URL is configured and every request to it is mocked."""
    monkeypatch.setenv("ORGANIZER_API_URL", ORGANIZER_URL)
    get_settings.cache_clear()
    with respx.mock(assert_all_called=False) as mock:
        yield mock


def serve(mock: respx.MockRouter, group: str, records: list[dict]) -> respx.Route:
    return mock.get("https://org.example/run", params={"group_id": group}).respond(
        200, json=organizer_response(records, group)
    )


@pytest.fixture
def migrated() -> None:
    db.migrate()


# --- organizer_url_for ---------------------------------------------------------------------


def test_url_only_group_id_changes(organizer: respx.MockRouter) -> None:
    assert (
        importer.organizer_url_for("CONTROL")
        == "https://org.example/run?sp=x&sig=FAKE&group_id=CONTROL"
    )


@pytest.mark.parametrize(
    ("configured", "expected"),
    [
        # a signature with %2F and = in it, group_id in the middle
        (
            "https://org.example/run?sp=x&sig=ab%2Fc%3D%3D=&api-version=2&group_id=DEV&z=1",
            "https://org.example/run?sp=x&sig=ab%2Fc%3D%3D=&api-version=2&group_id=NEW&z=1",
        ),
        # group_id first and last
        ("https://o.example/r?group_id=DEV&sig=Z%2fz=", "https://o.example/r?group_id=NEW&sig=Z%2fz="),
        ("https://o.example/r?sig=A+b%7E&group_id=DEV", "https://o.example/r?sig=A+b%7E&group_id=NEW"),
        # an empty value and a parameter with no value at all stay as they are
        ("https://o.example/r?a=&b&group_id=DEV", "https://o.example/r?a=&b&group_id=NEW"),
        # a name that only contains "group_id" is not the parameter
        (
            "https://o.example/r?old_group_id=1&group_id=DEV&group_id2=2",
            "https://o.example/r?old_group_id=1&group_id=NEW&group_id2=2",
        ),
        # no group_id at all: it is added after everything else
        ("https://o.example/r?sp=x&sig=A%2FB", "https://o.example/r?sp=x&sig=A%2FB&group_id=NEW"),
        ("https://o.example/r", "https://o.example/r?group_id=NEW"),
        # a fragment stays a fragment
        ("https://o.example/r?sig=A%2FB&group_id=DEV#frag", "https://o.example/r?sig=A%2FB&group_id=NEW#frag"),
    ],
)
def test_url_other_parameters_are_byte_identical(
    monkeypatch: pytest.MonkeyPatch, configured: str, expected: str
) -> None:
    monkeypatch.setenv("ORGANIZER_API_URL", configured)
    get_settings.cache_clear()
    assert importer.organizer_url_for("NEW") == expected


@pytest.mark.parametrize(
    ("group", "encoded"),
    [
        ("a&sp=evil", "a%26sp%3Devil"),
        ("a b", "a%20b"),
        ("x#y", "x%23y"),
        ("ключ", "%D0%BA%D0%BB%D1%8E%D1%87"),
    ],
)
def test_url_group_id_is_escaped(organizer: respx.MockRouter, group: str, encoded: str) -> None:
    assert importer.organizer_url_for(group) == f"https://org.example/run?sp=x&sig=FAKE&group_id={encoded}"


def test_url_missing_is_409(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ApiError) as caught:
        importer.organizer_url_for("DEV")
    assert (caught.value.status, caught.value.code) == (409, "organizer_url_missing")


async def test_request_keeps_the_signature_bytes(monkeypatch: pytest.MonkeyPatch) -> None:
    configured = "https://org.example/run?sp=x&sig=ab%2Fc%3D%3D%2b%2F=&group_id=DEV"
    monkeypatch.setenv("ORGANIZER_API_URL", configured)
    get_settings.cache_clear()
    with respx.mock(assert_all_called=False) as mock:
        route = mock.get(host="org.example").respond(200, json=organizer_response([]))
        await importer.fetch_group("CONTROL")
    sent = str(route.calls.last.request.url)
    assert sent == "https://org.example/run?sp=x&sig=ab%2Fc%3D%3D%2b%2F=&group_id=CONTROL"


# --- GET /datasets/{group_id} --------------------------------------------------------------


def test_import_dev_subset_idempotent(organizer: respx.MockRouter, client: TestClient) -> None:
    route = serve(organizer, "DEV", dev_records())

    first = client.get("/api/datasets/DEV")
    assert first.status_code == 200
    assert first.json() == {"group_id": "DEV", "total": 6, "imported": 6, "updated": 0, "unchanged": 0}

    second = client.get("/api/datasets/DEV")
    assert second.status_code == 200
    assert second.json() == {"group_id": "DEV", "total": 6, "imported": 0, "updated": 0, "unchanged": 6}

    assert route.call_count == 2
    assert stored_count() == 6


def test_import_stores_normalised_conversations(organizer: respx.MockRouter, client: TestClient) -> None:
    serve(organizer, "DEV", dev_records())
    client.get("/api/datasets/DEV")

    body = client.get("/api/conversations/DEV:p1-ru-001").json()
    assert body["id"] == "DEV:p1-ru-001"
    assert body["group_id"] == "DEV"
    assert body["conversation_id"] == "p1-ru-001"
    assert body["status"] == "new"
    assert len(body["transcript"]) == 12
    assert body["facts"]["operator_joined_index"] == 9
    assert body["audio"] is None
    assert body["audio_unavailable_reason"] == "none"
    assert isinstance(body["created_at"], str) and body["created_at"].endswith("Z")

    call = client.get(f"/api/conversations/DEV:{CALL_ID}").json()
    assert call["channel"] == "voice call"
    assert call["audio_unavailable_reason"] == "needs_import"


def test_import_never_returns_audio_url(organizer: respx.MockRouter, client: TestClient) -> None:
    serve(organizer, "DEV", with_audio(dev_records()))

    imported = client.get("/api/datasets/DEV")
    one = client.get(f"/api/conversations/DEV:{CALL_ID}")

    assert imported.status_code == one.status_code == 200
    assert "sig=Z" not in imported.text
    assert "sig=Z" not in one.text
    assert "media.example" not in one.text
    assert one.json()["audio"] == f"conversations/DEV:{CALL_ID}/audio"
    assert one.json()["audio_unavailable_reason"] is None
    assert store.get_audio_url(f"DEV:{CALL_ID}") == "https://media.example/a?sig=Z"


def test_control_set_id_collision(organizer: respx.MockRouter, client: TestClient) -> None:
    dev = dev_records()
    serve(organizer, "DEV", dev)
    client.get("/api/datasets/DEV")

    control = [json.loads(json.dumps(r)) for r in dev if r["conversation_id"] == "p1-ru-001"]
    control[0]["transcript"][-1]["text"] = "Совсем другой текст в контрольном наборе."
    serve(organizer, "CONTROL", control)
    summary = client.get("/api/datasets/CONTROL")

    assert summary.json() == {"group_id": "CONTROL", "total": 1, "imported": 1, "updated": 0, "unchanged": 0}
    assert stored_count() == 7
    dev_one = client.get("/api/conversations/DEV:p1-ru-001").json()
    control_one = client.get("/api/conversations/CONTROL:p1-ru-001").json()
    assert dev_one["transcript"][-1]["text"] != control_one["transcript"][-1]["text"]
    # importing DEV again changes nothing: the control record never touched it
    again = client.get("/api/datasets/DEV")
    assert again.json()["unchanged"] == 6


def test_changed_transcript_is_updated(organizer: respx.MockRouter, client: TestClient) -> None:
    records = dev_records()
    route = serve(organizer, "DEV", records)
    client.get("/api/datasets/DEV")
    changed = [json.loads(json.dumps(r)) for r in records]
    changed[0]["transcript"][0]["text"] = "Здравствуйте, это уже другая реплика."
    route.respond(200, json=organizer_response(changed))

    summary = client.get("/api/datasets/DEV").json()

    assert (summary["imported"], summary["updated"], summary["unchanged"]) == (0, 1, 5)
    one = client.get("/api/conversations/DEV:p1-ru-001").json()
    assert one["transcript"][0]["text"] == "Здравствуйте, это уже другая реплика."


# --- GET /datasets/{group_id}: failures ----------------------------------------------------


def test_organizer_http_error(organizer: respx.MockRouter, client: TestClient) -> None:
    organizer.get(host="org.example").respond(500, text="boom sig=FAKE")

    r = client.get("/api/datasets/DEV")

    assert r.status_code == 502
    assert r.json()["error"] == "organizer_error"
    assert "500" in r.json()["message"]
    assert "sig=" not in r.text
    assert "org.example" not in r.text
    assert stored_count() == 0


def test_organizer_timeout(organizer: respx.MockRouter, client: TestClient) -> None:
    organizer.get(host="org.example").mock(side_effect=httpx.ReadTimeout("slow"))

    r = client.get("/api/datasets/DEV")

    assert r.status_code == 502
    assert r.json()["error"] == "organizer_error"
    assert "timeout" in r.json()["message"]
    assert "sig=" not in r.text
    assert stored_count() == 0


def test_organizer_unreachable(organizer: respx.MockRouter, client: TestClient) -> None:
    organizer.get(host="org.example").mock(
        side_effect=httpx.ConnectError("cannot connect to https://org.example/run?sig=FAKE")
    )

    r = client.get("/api/datasets/DEV")

    assert r.status_code == 502
    assert r.json()["error"] == "organizer_error"
    assert "sig=" not in r.text
    assert "org.example" not in r.text


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(200, json={"error": "denied", "isSuccess": False, "data": None}),
        httpx.Response(200, text="<html>not json</html>"),
        httpx.Response(200, json={"error": "", "isSuccess": True, "data": {"records": "nope"}}),
        httpx.Response(200, json=[1, 2, 3]),
    ],
    ids=["is_success_false", "not_json", "records_not_a_list", "not_an_object"],
)
def test_organizer_bad_answer(
    organizer: respx.MockRouter, client: TestClient, answer: httpx.Response
) -> None:
    organizer.get(host="org.example").mock(return_value=answer)

    r = client.get("/api/datasets/DEV")

    assert r.status_code == 502
    assert r.json()["error"] == "organizer_error"
    assert "sig=" not in r.text
    assert stored_count() == 0


def test_organizer_is_success_false_names_the_status(organizer: respx.MockRouter, client: TestClient) -> None:
    organizer.get(host="org.example").respond(200, json={"error": "no", "isSuccess": False, "data": None})
    assert "200" in client.get("/api/datasets/DEV").json()["message"]


def test_organizer_bad_record_stores_nothing(organizer: respx.MockRouter, client: TestClient) -> None:
    records = dev_records()
    records[3] = {**records[3], "channel": "fax"}
    serve(organizer, "DEV", records)

    r = client.get("/api/datasets/DEV")

    assert r.status_code == 422
    assert r.json()["error"] == "bad_record:3"
    assert stored_count() == 0


def test_no_organizer_url(client: TestClient) -> None:
    r = client.get("/api/datasets/DEV")
    assert r.status_code == 409
    assert r.json()["error"] == "organizer_url_missing"
    assert stored_count() == 0


def test_organizer_url_is_never_logged(
    organizer: respx.MockRouter, client: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    serve(organizer, "DEV", dev_records())
    caplog.set_level(logging.DEBUG)

    client.get("/api/datasets/DEV")

    assert "sig=FAKE" not in caplog.text
    assert "org.example" not in caplog.text
    assert any("DEV" in r.getMessage() and "6" in r.getMessage() for r in caplog.records)


# --- POST /conversations -------------------------------------------------------------------


def one_record() -> dict:
    return next(r for r in dev_records() if r["conversation_id"] == "p1-ru-010")


def test_upload_shapes(client: TestClient) -> None:
    record = one_record()
    records = dev_records()[:3]

    shapes: list[tuple[Any, int, str | None]] = [
        (record, 1, None),  # one record
        (records, 3, None),  # an array
        ({"records": records}, 3, None),  # {"records": [...]}
        (organizer_response(records, "HINT"), 3, "HINT"),  # a full organisers' response
    ]
    for payload, total, hint in shapes:
        r = client.post("/api/conversations", json=payload)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["total"] == total
        assert body["imported"] + body["updated"] + body["unchanged"] == total
        if hint:
            assert body["group_id"] == hint
        else:
            assert body["group_id"].startswith("upload-")
            assert len(body["group_id"]) == len("upload-") + 14
            assert body["group_id"][len("upload-") :].isdigit()


def test_upload_group_follows_the_hint(client: TestClient) -> None:
    r = client.post("/api/conversations", json=organizer_response(dev_records(), "CONTROL"))
    assert r.json() == {"group_id": "CONTROL", "total": 6, "imported": 6, "updated": 0, "unchanged": 0}
    assert client.get("/api/conversations/CONTROL:p1-ru-001").status_code == 200

    again = client.post("/api/conversations", json=organizer_response(dev_records(), "CONTROL"))
    assert again.json()["unchanged"] == 6


def test_upload_hint_is_also_read_from_the_data_object(client: TestClient) -> None:
    r = client.post("/api/conversations", json={"dataset_group_id": "X1", "records": dev_records()[:2]})
    assert r.json()["group_id"] == "X1"


@pytest.mark.parametrize("hint", ["", "   ", None, 7])
def test_upload_unusable_hint_is_ignored(client: TestClient, hint: Any) -> None:
    r = client.post("/api/conversations", json=organizer_response(dev_records()[:1], hint))
    assert r.status_code == 200
    assert r.json()["group_id"].startswith("upload-")


def test_upload_bad_record_index(client: TestClient) -> None:
    r = client.post("/api/conversations", json=[{"conversation_id": "a"}, {}])
    assert r.status_code == 422
    assert r.json()["error"] == "bad_record:0"
    assert "channel" in r.json()["message"]


@pytest.mark.parametrize("payload", [{}, [], {"records": []}, {"data": {"records": []}}, "text", 5, {"x": 1}])
def test_upload_no_records(client: TestClient, payload: Any) -> None:
    r = client.post("/api/conversations", json=payload)
    assert r.status_code == 422
    assert r.json()["error"] == "no_records"


def test_upload_not_json_is_the_ordinary_422(client: TestClient) -> None:
    r = client.post("/api/conversations", content=b"{not json", headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_request"


def broken(record: dict, **changes: Any) -> dict:
    out = {**record, **changes}
    return {k: v for k, v in out.items() if v is not ...}


@pytest.mark.parametrize(
    "change",
    [
        {"conversation_id": ...},
        {"conversation_id": ""},
        {"conversation_id": "   "},
        {"conversation_id": 1.5},
        {"conversation_id": True},
        {"channel": ...},
        {"channel": "fax"},
        {"language": ...},
        {"language": None},
        {"language": 7},
        {"transcript": ...},
        {"transcript": "hello"},
    ],
    ids=lambda c: next(iter(c)) + "=" + repr(next(iter(c.values()))),
)
def test_upload_rejects_a_bad_field_and_stores_nothing(client: TestClient, change: dict) -> None:
    good, other = dev_records()[0], dev_records()[1]
    r = client.post("/api/conversations", json=[good, broken(other, **change)])

    assert r.status_code == 422
    assert r.json()["error"] == "bad_record:1"
    assert stored_count() == 0


@pytest.mark.parametrize("bad", [None, "text", 7, ["a"]])
def test_upload_rejects_a_record_that_is_not_an_object(client: TestClient, bad: Any) -> None:
    r = client.post("/api/conversations", json=[dev_records()[0], bad])
    assert r.status_code == 422
    assert r.json()["error"] == "bad_record:1"
    assert stored_count() == 0


def test_upload_keeps_values_dev_never_had_as_given(client: TestClient) -> None:
    """A control set may hold what DEV never did (final review I1): a lower-case or unknown language
    code, an integer conversation_id, a null transcript. Every record is stored, nothing is
    normalised, and every response still fits the contract."""
    base = dev_records()[0]
    records = [
        {**base, "conversation_id": "lower", "language": "ru"},
        {**base, "conversation_id": "unknown", "language": "KK"},
        {**base, "conversation_id": 123, "language": "EN"},
        {**base, "conversation_id": "empty", "transcript": None},
    ]
    r = client.post("/api/conversations", json={"dataset_group_id": "CTRL", "records": records})

    assert r.status_code == 200, r.text
    assert r.json() == {"group_id": "CTRL", "total": 4, "imported": 4, "updated": 0, "unchanged": 0}
    validate("import-summary", r.json())
    got = {cid: client.get(f"/api/conversations/CTRL:{cid}").json() for cid in ("lower", "unknown", "123", "empty")}
    for body in got.values():
        validate("conversation", body)
    assert got["lower"]["language"] == "ru"  # kept as given, not upper-cased
    assert got["unknown"]["language"] == "KK"
    assert (got["123"]["id"], got["123"]["conversation_id"]) == ("CTRL:123", "123")
    assert got["empty"]["transcript"] == []
    assert stored_row("CTRL:lower")["language"] == "ru"

    queue = client.get("/api/conversations", params={"group_id": "CTRL"}).json()
    for item in queue:
        validate("queue-item", item)
    assert sorted(item["language"] for item in queue) == ["EN", "KK", "RU", "ru"]
    assert [i["id"] for i in client.get("/api/conversations", params={"language": "ru"}).json()] == ["CTRL:lower"]

    again = client.post("/api/conversations", json={"dataset_group_id": "CTRL", "records": records})
    assert again.json()["unchanged"] == 4  # the same values again: nothing changed


def test_upload_message_never_echoes_the_record_values(client: TestClient) -> None:
    bad = {**one_record(), "channel": "https://media.example/a?sig=Z"}
    r = client.post("/api/conversations", json=[bad])
    assert r.status_code == 422
    assert "sig=Z" not in r.text


def test_upload_drops_the_audio_url_from_every_response(client: TestClient) -> None:
    r = client.post("/api/conversations", json=with_audio(dev_records()))
    assert "sig=Z" not in r.text
    group = r.json()["group_id"]
    one = client.get(f"/api/conversations/{group}:{CALL_ID}")
    assert "sig=Z" not in one.text
    assert store.get_audio_url(f"{group}:{CALL_ID}") == "https://media.example/a?sig=Z"


def test_upload_tolerates_odd_transcript_lines(client: TestClient) -> None:
    lines = [{"timestamp": "00:01", "speaker": "robot", "text": "hi"}, "bare"]
    record = {**one_record(), "transcript": lines}
    r = client.post("/api/conversations", json=[record])
    assert r.status_code == 200


def test_upload_repeated_ids_in_one_payload_keep_the_last(client: TestClient) -> None:
    first = one_record()
    last = json.loads(json.dumps(first))
    last["transcript"][0]["text"] = "latest"
    r = client.post("/api/conversations", json=organizer_response([first, last], "DUP"))
    assert r.status_code == 200
    assert r.json()["total"] == 2
    assert client.get("/api/conversations/DUP:p1-ru-010").json()["transcript"][0]["text"] == "latest"


# --- GET /conversations/{id} ---------------------------------------------------------------


def test_get_unknown_conversation_is_404(client: TestClient) -> None:
    r = client.get("/api/conversations/DEV:nope")
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


# --- the store -----------------------------------------------------------------------------


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Callable[[datetime], None]:
    def set_to(moment: datetime) -> None:
        monkeypatch.setattr(store, "_now", lambda: moment)

    return set_to


def conv(conversation_id: str = "p4-ru-001", group: str = "DEV", url: str | None = None, edit=None):
    record = next(r for r in dev_records() if r["conversation_id"] == conversation_id)
    record = json.loads(json.dumps(record))
    if url is not None:
        record["audio_url"] = url
    if edit:
        edit(record)
    return normalize_record(record, group)


def test_store_created_at_is_kept_and_updated_at_moves(migrated: None, clock: Callable) -> None:
    t0 = datetime(2026, 11, 7, 10, 0, 0, tzinfo=UTC)
    clock(t0)
    c, url = conv("p1-ru-001")
    assert store.upsert_conversation(c, url) == "imported"
    row = stored_row("DEV:p1-ru-001")
    assert row["created_at"] == row["updated_at"] == "2026-11-07T10:00:00+00:00"
    assert store.get_conversation("DEV:p1-ru-001").created_at == t0  # type: ignore[union-attr]

    clock(t0 + timedelta(hours=1))
    same, url = conv("p1-ru-001")
    assert store.upsert_conversation(same, url) == "unchanged"
    assert stored_row("DEV:p1-ru-001")["updated_at"] == "2026-11-07T10:00:00+00:00"

    def edit(record: dict) -> None:
        record["transcript"][0]["text"] = "changed"

    changed, url = conv("p1-ru-001", edit=edit)
    assert store.upsert_conversation(changed, url) == "updated"
    row = stored_row("DEV:p1-ru-001")
    assert row["created_at"] == "2026-11-07T10:00:00+00:00"
    assert row["updated_at"] == "2026-11-07T11:00:00+00:00"
    got = store.get_conversation("DEV:p1-ru-001")
    assert got is not None
    assert got.created_at == t0
    assert got.transcript[0].text == "changed"


def test_store_created_at_is_the_same_in_column_and_json_and_survives_an_update(
    migrated: None, clock: Callable
) -> None:
    clock(datetime(2026, 11, 7, 10, 0, 0, 987654, tzinfo=UTC))  # a clock with microseconds
    first, url = conv("p1-ru-001")
    store.upsert_conversation(first, url)
    row = stored_row("DEV:p1-ru-001")
    in_json = json.loads(row["conversation_json"])["created_at"]
    assert datetime.fromisoformat(in_json) == datetime.fromisoformat(row["created_at"])
    assert in_json == "2026-11-07T10:00:00Z"  # whole seconds, so the two cannot drift apart

    # A row whose column disagrees with its JSON (an older write): an update keeps the JSON's value
    # and writes the column from that same value.
    conn = db.connect()
    conn.execute(
        "UPDATE conversations SET created_at = '2020-01-01T00:00:00+00:00' WHERE id = 'DEV:p1-ru-001'"
    )
    conn.commit()
    conn.close()
    clock(datetime(2026, 11, 7, 11, 30, 0, 5, tzinfo=UTC))

    def edit(record: dict) -> None:
        record["transcript"][0]["text"] = "changed"

    changed, url = conv("p1-ru-001", edit=edit)
    assert store.upsert_conversation(changed, url) == "updated"

    row = stored_row("DEV:p1-ru-001")
    assert row["created_at"] == "2026-11-07T10:00:00+00:00"
    assert json.loads(row["conversation_json"])["created_at"] == in_json
    assert row["updated_at"] == "2026-11-07T11:30:00+00:00"


def test_store_columns(migrated: None) -> None:
    c, url = conv("p4-ru-001", url="https://media.example/a?sig=Z")
    store.upsert_conversation(c, url)
    row = stored_row("DEV:p4-ru-001")
    assert row["group_id"] == "DEV"
    assert row["conversation_id"] == "p4-ru-001"
    assert row["channel"] == "voice call"
    assert row["language"] == "RU"
    assert len(row["transcript_hash"]) == 64
    assert row["audio_url"] == "https://media.example/a?sig=Z"
    assert "sig=Z" not in row["conversation_json"]


def test_store_keeps_the_audio_url_when_the_new_one_is_none(migrated: None) -> None:
    with_url, url = conv(url="https://media.example/a?sig=Z")
    store.upsert_conversation(with_url, url)

    # same transcript, no url: unchanged, url and audio fields kept
    plain, none = conv()
    assert none is None
    assert store.upsert_conversation(plain, none) == "unchanged"
    assert store.get_audio_url("DEV:p4-ru-001") == "https://media.example/a?sig=Z"
    kept = store.get_conversation("DEV:p4-ru-001")
    assert kept is not None and kept.audio == "conversations/DEV:p4-ru-001/audio"
    assert kept.audio_unavailable_reason is None

    # a changed transcript without a url: updated, url and audio fields still kept
    def edit(record: dict) -> None:
        record["transcript"][1]["text"] = "changed"

    edited, none = conv(edit=edit)
    assert store.upsert_conversation(edited, none) == "updated"
    assert store.get_audio_url("DEV:p4-ru-001") == "https://media.example/a?sig=Z"
    kept = store.get_conversation("DEV:p4-ru-001")
    assert kept is not None and kept.audio == "conversations/DEV:p4-ru-001/audio"
    assert kept.audio_unavailable_reason is None


def test_store_a_url_arriving_later_fills_the_audio_fields(migrated: None, clock: Callable) -> None:
    clock(datetime(2026, 11, 7, 10, tzinfo=UTC))
    snapshot, none = conv()
    store.upsert_conversation(snapshot, none)
    before = store.get_conversation("DEV:p4-ru-001")
    assert before is not None and before.audio is None
    assert before.audio_unavailable_reason == "needs_import"
    assert store.get_audio_url("DEV:p4-ru-001") is None

    clock(datetime(2026, 11, 7, 11, tzinfo=UTC))
    live, url = conv(url="https://media.example/a?sig=Z")
    assert store.upsert_conversation(live, url) == "unchanged"  # the transcript did not change
    after = store.get_conversation("DEV:p4-ru-001")
    assert after is not None
    assert after.audio == "conversations/DEV:p4-ru-001/audio"
    assert after.audio_unavailable_reason is None
    assert store.get_audio_url("DEV:p4-ru-001") == "https://media.example/a?sig=Z"
    assert stored_row("DEV:p4-ru-001")["updated_at"] == "2026-11-07T11:00:00+00:00"


def test_store_a_refreshed_url_replaces_the_old_one(migrated: None) -> None:
    first, url = conv(url="https://media.example/a?sig=1")
    store.upsert_conversation(first, url)
    second, url = conv(url="https://media.example/a?sig=2")
    assert store.upsert_conversation(second, url) == "unchanged"
    assert store.get_audio_url("DEV:p4-ru-001") == "https://media.example/a?sig=2"


def test_store_unknown_conversation(migrated: None) -> None:
    assert store.get_conversation("DEV:nope") is None
    assert store.get_audio_url("DEV:nope") is None


def test_save_audio_results(migrated: None) -> None:
    c, url = conv(url="https://media.example/a?sig=Z")
    store.upsert_conversation(c, url)
    offsets = [AudioOffset(message_index=0, seconds=1.5), AudioOffset(message_index=1, seconds=4.0)]
    measurements = [
        VoiceMeasurement(
            message_index=1, from_seconds=4.0, to_seconds=9.0,
            pitch_range=5.0, rate_wpm=130.0, pauses=0.4, overlap=0.0,
        )
    ]

    store.save_audio_results("DEV:p4-ru-001", offsets, measurements)

    got = store.get_conversation("DEV:p4-ru-001")
    assert got is not None
    assert got.audio_offsets == offsets
    assert got.voice_measurements == measurements
    assert got.audio == "conversations/DEV:p4-ru-001/audio"  # everything else is as it was
    assert got.created_at is not None
    assert store.get_audio_url("DEV:p4-ru-001") == "https://media.example/a?sig=Z"

    # a re-import with the same transcript keeps them; a changed transcript drops them
    same, url = conv(url="https://media.example/a?sig=Z")
    assert store.upsert_conversation(same, url) == "unchanged"
    kept = store.get_conversation("DEV:p4-ru-001")
    assert kept is not None and kept.audio_offsets == offsets

    def edit(record: dict) -> None:
        record["transcript"][2]["text"] = "changed"

    edited, url = conv(url="https://media.example/a?sig=Z", edit=edit)
    assert store.upsert_conversation(edited, url) == "updated"
    reset = store.get_conversation("DEV:p4-ru-001")
    assert reset is not None
    assert reset.audio_offsets == [] and reset.voice_measurements == []


def test_save_audio_results_for_an_unknown_conversation(migrated: None) -> None:
    with pytest.raises(LookupError):
        store.save_audio_results("DEV:nope", [], [])


# --- atomic writes -------------------------------------------------------------------------


async def test_import_is_all_or_nothing_on_a_store_failure(
    migrated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    real = store.upsert_conversation
    calls: list[str] = []

    def failing(c, audio_url, **kwargs):
        calls.append(c.id)
        if len(calls) == 3:
            raise RuntimeError("disk full")
        return real(c, audio_url, **kwargs)

    monkeypatch.setattr(store, "upsert_conversation", failing)

    with pytest.raises(RuntimeError):
        await importer.import_records(dev_records(), "DEV")

    assert len(calls) == 3
    assert stored_count() == 0


async def test_import_checks_every_record_before_writing(
    migrated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    def must_not_run(*args, **kwargs):
        raise AssertionError("nothing may be written when a record is bad")

    monkeypatch.setattr(store, "upsert_conversation", must_not_run)
    records = dev_records()
    records[5] = {**records[5], "channel": "fax"}

    with pytest.raises(ApiError) as caught:
        await importer.import_records(records, "DEV")

    assert (caught.value.status, caught.value.code) == (422, "bad_record:5")


async def test_import_records_counts(migrated: None) -> None:
    summary = await importer.import_records(dev_records(), "DEV")
    assert summary.model_dump() == {
        "group_id": "DEV", "total": 6, "imported": 6, "updated": 0, "unchanged": 0,
    }  # fmt: skip


# --- the audio hook ------------------------------------------------------------------------


@pytest.fixture
def fake_audio(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """A stand-in for stream D's `audio` package; the list holds the ids process_call received."""
    seen: list[str] = []
    module = types.ModuleType("audio")
    module.__spec__ = ModuleSpec("audio", None)

    async def process_call(conversation: str) -> None:
        await asyncio.sleep(0)
        seen.append(conversation)

    module.process_call = process_call  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "audio", module)
    return seen


@pytest.fixture(autouse=True)
def _no_audio_tasks_left_over() -> Iterator[None]:
    """The in-flight table is module state: a task of an earlier test must not suppress a later one."""
    importer._background_tasks.clear()
    yield
    importer._background_tasks.clear()


async def settle() -> None:
    while importer._background_tasks:
        await asyncio.gather(*list(importer._background_tasks.values()))


async def test_audio_hook_runs_for_the_voice_call_only(migrated: None, fake_audio: list[str]) -> None:
    records = with_audio(dev_records())
    for r in records:
        if r["conversation_id"] != CALL_ID:  # a chat with a stray audio_url must not be processed
            r["audio_url"] = None

    await importer.import_records(records, "DEV")
    await settle()

    assert fake_audio == [f"DEV:{CALL_ID}"]


async def test_audio_hook_skips_chats_even_with_a_url(migrated: None, fake_audio: list[str]) -> None:
    records = dev_records()
    records[0] = {**records[0], "audio_url": "https://media.example/chat?sig=Z"}  # a chat

    await importer.import_records(records, "DEV")
    await settle()

    assert fake_audio == []


async def test_audio_hook_needs_a_url(migrated: None, fake_audio: list[str]) -> None:
    await importer.import_records(dev_records(), "DEV")  # the call has no audio_url
    await settle()
    assert fake_audio == []


async def test_audio_hook_is_not_rerun_once_results_exist(migrated: None, fake_audio: list[str]) -> None:
    records = with_audio(dev_records())
    await importer.import_records(records, "DEV")
    await settle()
    assert fake_audio == [f"DEV:{CALL_ID}"]

    # nothing was saved by the fake: an import retries the call
    await importer.import_records(records, "DEV")
    await settle()
    assert fake_audio == [f"DEV:{CALL_ID}"] * 2

    # once offsets are stored, an unchanged re-import leaves the call alone
    store.save_audio_results(f"DEV:{CALL_ID}", [AudioOffset(message_index=0, seconds=0.0)], [])
    await importer.import_records(records, "DEV")
    await settle()
    assert fake_audio == [f"DEV:{CALL_ID}"] * 2

    # a changed transcript resets the results, so it is processed again
    changed = json.loads(json.dumps(records))
    for r in changed:
        if r["conversation_id"] == CALL_ID:
            r["transcript"][0]["text"] = "changed"
    await importer.import_records(changed, "DEV")
    await settle()
    assert fake_audio == [f"DEV:{CALL_ID}"] * 3


async def test_audio_hook_failure_is_logged_and_does_not_block(
    migrated: None, fake_audio: list[str], monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def boom(conversation: str) -> None:
        raise RuntimeError("no ffmpeg")

    monkeypatch.setattr(sys.modules["audio"], "process_call", boom)

    summary = await importer.import_records(with_audio(dev_records()), "DEV")
    await settle()

    assert summary.imported == 6
    assert stored_count() == 6
    failures = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(failures) == 1
    assert f"DEV:{CALL_ID}" in failures[0].getMessage()
    assert "RuntimeError" in failures[0].getMessage()  # the type, so the log says what went wrong
    assert "no ffmpeg" not in caplog.text  # not the text: an exception message can hold a signed URL
    assert failures[0].exc_info is None  # and no traceback
    assert importer._background_tasks == {}


async def test_audio_hook_failure_log_never_carries_the_exception_text(
    migrated: None, fake_audio: list[str], monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def boom(conversation: str) -> None:
        try:
            raise ValueError("could not fetch https://media.example/a?sig=Z")
        except ValueError as inner:
            raise RuntimeError("download failed: https://media.example/a?sig=Z") from inner

    monkeypatch.setattr(sys.modules["audio"], "process_call", boom)
    caplog.set_level(logging.DEBUG)

    await importer.import_records(with_audio(dev_records()), "DEV")
    await settle()

    assert "sig=Z" not in caplog.text
    assert "media.example" not in caplog.text
    assert any(
        f"DEV:{CALL_ID}" in r.getMessage() and "RuntimeError" in r.getMessage() for r in caplog.records
    )


async def test_audio_hook_keeps_references_until_done(migrated: None, fake_audio: list[str]) -> None:
    await importer.import_records(with_audio(dev_records()), "DEV")
    assert len(importer._background_tasks) == 1  # held, so it cannot be garbage-collected mid-run
    await settle()
    assert importer._background_tasks == {}


async def test_audio_hook_does_not_start_a_second_run_while_one_is_in_flight(
    migrated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []
    gate = asyncio.Event()
    module = types.ModuleType("audio")
    module.__spec__ = ModuleSpec("audio", None)

    async def process_call(conversation: str) -> None:
        started.append(conversation)
        await gate.wait()

    module.process_call = process_call  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "audio", module)
    records = with_audio(dev_records())

    await importer.import_records(records, "DEV")
    await asyncio.sleep(0)  # let the task start
    assert started == [f"DEV:{CALL_ID}"]
    # the same call is imported twice more (a second click, a second tab) while it is still running
    await importer.import_records(records, "DEV")
    await importer.import_records(records, "DEV")
    await asyncio.sleep(0)
    assert started == [f"DEV:{CALL_ID}"]
    assert len(importer._background_tasks) == 1

    gate.set()
    await settle()
    assert importer._background_tasks == {}

    # once it has finished (and left nothing behind) the next import starts it again
    gate.clear()
    await importer.import_records(records, "DEV")
    await asyncio.sleep(0)
    assert started == [f"DEV:{CALL_ID}"] * 2
    gate.set()
    await settle()


async def test_audio_hook_runs_different_calls_side_by_side(
    migrated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    started: list[str] = []
    gate = asyncio.Event()
    module = types.ModuleType("audio")
    module.__spec__ = ModuleSpec("audio", None)

    async def process_call(conversation: str) -> None:
        started.append(conversation)
        await gate.wait()

    module.process_call = process_call  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "audio", module)

    await importer.import_records(with_audio(dev_records()), "DEV")
    await importer.import_records(with_audio(dev_records()), "OTHER")
    await asyncio.sleep(0)

    assert sorted(started) == [f"DEV:{CALL_ID}", f"OTHER:{CALL_ID}"]
    gate.set()
    await settle()


async def test_audio_package_that_fails_to_import_does_not_block(
    migrated: None, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    real_find_spec = importlib.util.find_spec
    # find_spec reports the package, but importing it fails (a missing audio library, say)
    monkeypatch.setattr(
        importlib.util,
        "find_spec",
        lambda name, *a: ModuleSpec(name, None) if name == "audio" else real_find_spec(name, *a),
    )
    monkeypatch.setitem(sys.modules, "audio", None)

    summary = await importer.import_records(with_audio(dev_records()), "DEV")
    await settle()

    assert summary.imported == 6
    assert stored_count() == 6
    assert any(r.levelno >= logging.ERROR for r in caplog.records)


async def test_audio_module_without_a_spec_is_still_used(
    migrated: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[str] = []
    module = types.ModuleType("audio")  # __spec__ is None: find_spec raises ValueError for it

    async def process_call(conversation: str) -> None:
        seen.append(conversation)

    module.process_call = process_call  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "audio", module)

    await importer.import_records(with_audio(dev_records()), "DEV")
    await settle()

    assert seen == [f"DEV:{CALL_ID}"]


def test_audio_hook_through_the_route(
    organizer: respx.MockRouter, client: TestClient, fake_audio: list[str]
) -> None:
    serve(organizer, "DEV", with_audio(dev_records()))

    assert client.get("/api/datasets/DEV").status_code == 200

    deadline = time.monotonic() + 5  # the task runs on the app's own event loop
    while not fake_audio and time.monotonic() < deadline:
        time.sleep(0.01)
    assert fake_audio == [f"DEV:{CALL_ID}"]


# --- logging -------------------------------------------------------------------------------

REALISTIC_URL = (
    "https://PROD-12.Region.logic.example:443/workflows/x/invoke"
    "?api-version=2016-06-01&sp=x&sig=FAKESIG&group_id=DEV"
)
REALISTIC_URL_WITHOUT_SIG = (
    "https://PROD-12.Region.logic.example:443/workflows/x/invoke?api-version=2016-06-01&group_id=DEV"
)


async def test_httpx_request_log_does_not_carry_the_signed_url(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ORGANIZER_API_URL", ORGANIZER_URL)
    get_settings.cache_clear()
    caplog.set_level(logging.DEBUG)
    with respx.mock(assert_all_called=False) as mock:
        mock.get(host="org.example").respond(200, json=organizer_response([]))
        await importer.fetch_group("DEV")

    assert "sig=FAKE" not in caplog.text
    assert "org.example" not in caplog.text


@pytest.mark.parametrize(
    "configured", [REALISTIC_URL, REALISTIC_URL_WITHOUT_SIG], ids=["signed", "no_sig_param"]
)
async def test_httpx_log_redacts_the_url_httpx_normalises(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch, configured: str
) -> None:
    # httpx logs the normalised URL (host in lower case, the default :443 dropped), which is not
    # the text that was configured.
    monkeypatch.setenv("ORGANIZER_API_URL", configured)
    get_settings.cache_clear()
    caplog.set_level(logging.DEBUG)
    with respx.mock(assert_all_called=False) as mock:
        mock.route(method="GET").respond(200, json=organizer_response([]))
        await importer.fetch_group("DEV")

    text = caplog.text.lower()
    assert "fakesig" not in text
    assert "sig=" not in text
    assert "prod-12" not in text
    assert "logic.example" not in text
    assert "workflows" not in text
    # the record is kept, with the method and the status, and the URL replaced
    requests = [r.getMessage() for r in caplog.records if r.name == "httpx"]
    assert len(requests) == 1
    assert requests[0] == 'HTTP Request: GET <redacted> "HTTP/1.1 200 OK"'


@pytest.mark.parametrize("url", ["https://media.example/a?sig=Z", "https://media.example/a?x=1&SIG=Z&y=2"])
async def test_httpx_log_redacts_any_signed_url(caplog: pytest.LogCaptureFixture, url: str) -> None:
    # e.g. stream D's audio links: no organiser URL is configured at all here
    caplog.set_level(logging.DEBUG)
    with respx.mock(assert_all_called=False) as mock:
        mock.route(method="GET").respond(200, text="ok")
        async with httpx.AsyncClient() as client:
            await client.get(url)

    assert "sig=" not in caplog.text.lower()
    assert "media.example" not in caplog.text
    assert [r.getMessage() for r in caplog.records if r.name == "httpx"] == [
        'HTTP Request: GET <redacted> "HTTP/1.1 200 OK"'
    ]


async def test_httpx_log_keeps_urls_that_are_not_secret(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    with respx.mock(assert_all_called=False) as mock:
        mock.route(method="GET").respond(200, text="ok")
        async with httpx.AsyncClient() as client:
            await client.get("https://api.example/v1/messages?page=2")

    assert [r.getMessage() for r in caplog.records if r.name == "httpx"] == [
        'HTTP Request: GET https://api.example/v1/messages?page=2 "HTTP/1.1 200 OK"'
    ]


@pytest.mark.parametrize(
    "name",
    ["httpx", "httpcore", "httpcore.connection", "httpcore.http11", "httpcore.http2", "httpcore.proxy"],
)
def test_httpx_and_httpcore_loggers_redact(caplog: pytest.LogCaptureFixture, name: str) -> None:
    caplog.set_level(logging.DEBUG)
    logging.getLogger(name).debug("fetching %s now", "https://media.example/a?sig=Z")
    logging.getLogger(name).debug("no secret here, host=%r", "media.example")

    assert [r.getMessage() for r in caplog.records if r.name == name] == [
        "fetching <redacted> now",
        "no secret here, host='media.example'",
    ]


def test_a_signature_outside_a_url_redacts_the_whole_message(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    logging.getLogger("httpcore.http11").debug("query was %s", "a=1&sig=Z")

    assert "sig=Z" not in caplog.text
    assert [r.getMessage() for r in caplog.records] == ["<redacted>"]


# --- the fetch deadline --------------------------------------------------------------------


class _Drip(httpx.AsyncByteStream):
    """A body that never stalls for long but never ends: every single read is fast."""

    async def __aiter__(self):
        for _ in range(500):
            await asyncio.sleep(0.01)
            yield b" "


def test_a_slowly_dripping_answer_hits_the_total_deadline(
    organizer: respx.MockRouter, client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(importer, "FETCH_TIMEOUT_SECONDS", 0.2)
    organizer.get(host="org.example").mock(return_value=httpx.Response(200, stream=_Drip()))

    started = time.monotonic()
    r = client.get("/api/datasets/DEV")

    assert time.monotonic() - started < 3
    assert r.status_code == 502
    assert r.json()["error"] == "organizer_error"
    assert "timeout" in r.json()["message"]
    assert "sig=" not in r.text
    assert stored_count() == 0


def test_the_deadline_is_the_documented_sixty_seconds() -> None:
    assert importer.FETCH_TIMEOUT_SECONDS == 60
