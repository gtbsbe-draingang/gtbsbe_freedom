"""The checklists API (Task 7): versions, copy with based_on, fingerprints, validation.

Almost every test builds its checklist inline, so they run with or without stream A's official
seed (`checklists/official-chat-v1.json`). Once the seed is on the branch, every test client's
database also holds `official-chat:1`; the tests therefore look their own checklists up by id and
never assume the list is exactly theirs. The tests about the real official checklist are skipped
until the seed exists.
"""

import copy
import json
import re
import threading
from collections.abc import Callable
from decimal import Decimal
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import checklists, db, store
from app.checklists import (
    criterion_fingerprint,
    new_checklist_id,
    slug,
    validate_checklist,
    weight_warnings,
)
from app.errors import ApiError
from app.models import ChecklistVersion

REPO_ROOT = Path(__file__).resolve().parents[3]
SEED = REPO_ROOT / "checklists" / "official-chat-v1.json"
MAX_VERSION = 2**31 - 1
needs_seed = pytest.mark.skipif(not SEED.exists(), reason="stream A's official seed is not on this branch")

MakeClient = Callable[..., TestClient]
OFFICIAL_ID = {"checklist_id": "official-chat", "version": 1}


def official_like() -> dict:
    """A checklist body in the shape of the official one: 8 criteria, weights sum 100, a scale
    (c04, c06), a gross-error criterion (c08). No fingerprints, no checklist_id."""

    def criterion(cid, section, order, title, wording, weight, **extra) -> dict:
        return {
            "id": cid, "section_id": section, "order": order, "title": title, "wording": wording,
            "answer_type": "yes_no", "scale_steps": [], "weight": weight, "na_allowed": False,
            "na_condition": None, "kind": "scored", "kinds": [], "guidance": None,
            **extra,
        }  # fmt: skip

    def steps(*values: int) -> list[dict]:
        return [{"value": v, "label": f"Шаг {v}"} for v in values]

    return {
        "name": "Чек-лист качества чатов (копия)",
        "description": "Восемь критериев",
        "channel": "any",
        "rounding": 2,
        "guidance": "Общая памятка.",
        "sections": [
            {"id": "start", "title": "Начало", "order": 1},
            {"id": "safety", "title": "Безопасность", "order": 2},
            {"id": "conduct", "title": "Ведение", "order": 3},
            {"id": "gross", "title": "Грубые ошибки", "order": 4},
        ],
        "criteria": [
            criterion("c01", "start", 1, "Приветствие", "Да — оператор поздоровался.", 10),
            criterion("c02", "start", 2, "Выявление", "Да — оператор уточнил запрос.", 15, na_allowed=True),
            criterion("c03", "safety", 3, "Проверка клиента", "Да — личность подтверждена.", 20),
            criterion("c04", "safety", 4, "Точность", "Оцените точность.", 20,
                      answer_type="scale", scale_steps=steps(0, 5, 10, 15, 20)),
            criterion("c05", "conduct", 5, "Вежливость", "Да — тон вежливый.", 15),
            criterion("c06", "conduct", 6, "Решение", "Оцените решение.", 15,
                      answer_type="scale", scale_steps=steps(0, 4, 7, 10), guidance="Пример."),
            criterion("c07", "conduct", 7, "Завершение", "Да — диалог завершён.", 5, na_allowed=True),
            criterion("c08", "gross", 8, "Грубые нарушения", "Да — есть нарушение.", 0,
                      kind="gross_error", kinds=["insult", "pii"]),
        ],
    }  # fmt: skip


def create(client: TestClient, checklist: dict | None = None, role: str = "controller", **body):
    return client.post(
        "/api/checklists",
        json={"role": role, "checklist": official_like() if checklist is None else checklist, **body},
    )


def create_ok(client: TestClient, checklist: dict | None = None, role: str = "controller") -> dict:
    r = create(client, checklist, role)
    assert r.status_code == 201, r.text
    return r.json()


def new_version(client: TestClient, checklist_id: str, checklist: dict, role: str = "controller"):
    return client.post(
        f"/api/checklists/{checklist_id}/versions", json={"role": role, "checklist": checklist}
    )


def lock(checklist_id: str, version: int) -> None:
    conn = db.connect()
    try:
        conn.execute(
            "UPDATE checklist_versions SET locked = 1 WHERE checklist_id = ? AND version = ?",
            (checklist_id, version),
        )
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def official_base(client: TestClient) -> dict:
    """official-chat v1, which the copies are based on (a `based_on` must exist): stream A's seed
    when it is on this branch, else an inline stand-in saved locked. As the API serves it."""
    if store.get_checklist_version("official-chat", 1) is None:
        store.save_checklist_version(stored_version("official-chat", 1, locked=True))
    return client.get("/api/checklists/official-chat/versions/1").json()


def fingerprints(version: dict) -> dict[str, str]:
    return {c["id"]: c["fingerprint"] for c in version["criteria"]}


def listed(client: TestClient, checklist_id: str) -> dict:
    found = [c for c in client.get("/api/checklists").json() if c["checklist_id"] == checklist_id]
    assert len(found) == 1
    return found[0]


def replace_criterion(checklist: dict, old_id: str, **new_fields) -> dict:
    """Replace one criterion: a new id and the given fields, the rest kept."""
    out = copy.deepcopy(checklist)
    out["criteria"] = [{**c, **new_fields} if c["id"] == old_id else c for c in out["criteria"]]
    return out


# --- GET: reading --------------------------------------------------------------------------


@needs_seed
def test_official_is_seeded_and_locked(client: TestClient) -> None:
    r = client.get("/api/checklists")
    assert r.status_code == 200
    official = [c for c in r.json() if c["checklist_id"] == "official-chat"]
    assert len(official) == 1
    assert official[0]["version"] == 2 and official[0]["locked"] is True
    assert official[0]["versions"] == [1, 2]
    assert client.get("/api/checklists/official-chat/versions/1").json()["locked"] is True


def test_get_checklists_is_a_list_of_latest_versions_with_all_version_numbers(client: TestClient) -> None:
    first = create_ok(client)
    cid = first["checklist_id"]
    other = create_ok(client, {**official_like(), "name": "Второй"})
    for weight in (11, 12):
        changed = official_like()
        changed["criteria"][0]["weight"] = weight
        assert new_version(client, cid, changed).status_code == 201

    body = client.get("/api/checklists").json()
    assert isinstance(body, list)
    mine = [c for c in body if c["checklist_id"] in (cid, other["checklist_id"])]
    assert [c["checklist_id"] for c in mine] == [cid, other["checklist_id"]]  # oldest first
    assert [(c["version"], c["versions"]) for c in mine] == [(3, [1, 2, 3]), (1, [1])]
    assert mine[0]["criteria"][0]["weight"] == 12  # the latest version's content
    assert mine[0]["id"] == f"{cid}:3"
    assert "warnings" not in mine[0]


def test_get_version_returns_that_version(client: TestClient) -> None:
    first = create_ok(client)
    cid = first["checklist_id"]
    changed = official_like()
    changed["criteria"][0]["weight"] = 12
    new_version(client, cid, changed)
    v1 = client.get(f"/api/checklists/{cid}/versions/1")
    v2 = client.get(f"/api/checklists/{cid}/versions/2")
    assert v1.status_code == v2.status_code == 200
    assert v1.json()["criteria"][0]["weight"] == 10 and v1.json()["version"] == 1
    assert v2.json()["criteria"][0]["weight"] == 12 and v2.json()["version"] == 2
    assert "warnings" not in v1.json() and "versions" not in v1.json()
    assert ChecklistVersion.model_validate(v2.json()).id == f"{cid}:2"


@pytest.mark.parametrize("path", ["/api/checklists/nope/versions/1", "/api/checklists/nope/versions/9"])
def test_get_unknown_version_is_404(client: TestClient, path: str) -> None:
    r = client.get(path)
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


@pytest.mark.parametrize(
    "number",
    ["0", "-1", str(MAX_VERSION), str(MAX_VERSION + 1), "9223372036854775807", "9223372036854775808", "99999999999999999999"],
)
def test_a_version_number_out_of_range_is_404_not_a_server_error(client: TestClient, number: str) -> None:
    cid = create_ok(client)["checklist_id"]
    for path in (f"/api/checklists/{cid}/versions/{number}", f"/api/checklists/nope/versions/{number}"):
        r = client.get(path)
        assert (r.status_code, r.json()["error"]) == (404, "not_found"), path


def test_get_version_that_does_not_exist_of_a_known_checklist_is_404(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    r = client.get(f"/api/checklists/{cid}/versions/2")
    assert (r.status_code, r.json()["error"]) == (404, "not_found")


def test_locked_is_read_from_the_column_everywhere(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    lock(cid, 1)
    assert client.get(f"/api/checklists/{cid}/versions/1").json()["locked"] is True
    assert listed(client, cid)["locked"] is True
    assert store.get_checklist_version(cid, 1).locked is True
    assert [v for v in store.latest_versions() if v.checklist_id == cid][0].locked is True


# --- POST /checklists: create and copy -----------------------------------------------------


def test_create_assigns_id_version_locked_and_fingerprints(client: TestClient) -> None:
    r = create(client)
    assert r.status_code == 201
    body = r.json()
    assert re.fullmatch(r"[a-z0-9-]+-[0-9a-f]{6}", body["checklist_id"])
    assert body["id"] == f"{body['checklist_id']}:1"
    assert (body["version"], body["locked"], body["based_on"]) == (1, False, None)
    assert body["author_role"] == "controller"
    assert body["created_at"]
    assert body["warnings"] == []
    assert all(re.fullmatch(r"[0-9a-f]{64}", c["fingerprint"]) for c in body["criteria"])
    assert body["criteria"][0]["weight"] == 10  # a JSON number, not a string
    assert ChecklistVersion.model_validate(body).checklist_id == body["checklist_id"]
    assert client.get(f"/api/checklists/{body['checklist_id']}/versions/1").json() == {
        k: v for k, v in body.items() if k != "warnings"
    }


def test_create_ignores_what_the_server_decides(client: TestClient) -> None:
    # The UI may post back a version it read: id, checklist_id, version, locked and created_at
    # in the body must change nothing.
    checklist = {
        **official_like(),
        "id": "official-chat:1", "checklist_id": "official-chat", "version": 7, "locked": True,
        "created_at": "2020-01-01T00:00:00Z", "author_role": "reviewer",
    }  # fmt: skip
    r = create(client, checklist, role="controller")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["checklist_id"] != "official-chat"
    assert (body["version"], body["locked"], body["author_role"]) == (1, False, "controller")
    assert body["id"] == f"{body['checklist_id']}:1"
    assert not body["created_at"].startswith("2020")


def test_copy_with_based_on_and_replace_one_criterion(client: TestClient, official_base: dict) -> None:
    base = official_like()
    base_fingerprints = {c["id"]: criterion_fingerprint(c) for c in base["criteria"]}
    replaced = replace_criterion(base, "c06", id="c06b", wording="Новая формулировка критерия.")
    # Client-sent fingerprints are ignored: all stale, and c06b carries c06's old one (what a UI
    # that copies a criterion and edits its text would send).
    for c in replaced["criteria"]:
        c["fingerprint"] = f"stale-{c['id']}"
    replaced["criteria"][5]["fingerprint"] = base_fingerprints["c06"]

    r = create(client, {**replaced, "based_on": OFFICIAL_ID})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["based_on"] == OFFICIAL_ID
    assert (body["version"], body["locked"]) == (1, False)
    assert body["checklist_id"] != "official-chat"

    fresh = fingerprints(body)
    assert set(fresh) == (set(base_fingerprints) - {"c06"}) | {"c06b"}
    differing = set(fresh.values()) - set(base_fingerprints.values())
    assert differing == {fresh["c06b"]}  # exactly one fingerprint differs from the official set
    assert fresh["c06b"] == criterion_fingerprint(body["criteria"][5])
    assert fresh["c06b"] != base_fingerprints["c06"]
    for cid in ("c01", "c02", "c03", "c04", "c05", "c07", "c08"):
        assert fresh[cid] == base_fingerprints[cid]
    assert body["warnings"] == []
    assert client.get(f"/api/checklists/{body['checklist_id']}/versions/1").json()["based_on"] == OFFICIAL_ID


@needs_seed
def test_copy_of_the_real_official_with_c06_replaced(client: TestClient, official_base: dict) -> None:
    # The live test at the defence: read the locked official, replace one criterion, save a copy.
    official = client.get("/api/checklists/official-chat/versions/1").json()
    original = fingerprints(official)
    posted = copy.deepcopy(official)  # as the UI sends it back: with its id, locked and fingerprints
    posted["criteria"] = [
        {**c, "id": "c06b", "wording": "Совсем другой критерий."} if c["id"] == "c06" else c
        for c in posted["criteria"]
    ]
    posted["based_on"] = OFFICIAL_ID
    r = create(client, posted, role="reviewer")
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["checklist_id"] != "official-chat" and body["locked"] is False
    assert body["warnings"] == []
    assert body["author_role"] == "reviewer" and body["based_on"] == OFFICIAL_ID
    assert set(fingerprints(body).values()) - set(original.values()) == {fingerprints(body)["c06b"]}
    assert client.get("/api/checklists/official-chat/versions/1").json() == official  # untouched


def test_create_keeps_based_on_when_given_and_validates_its_shape(
    client: TestClient, official_base: dict
) -> None:
    assert create_ok(client)["based_on"] is None
    assert create(client, {**official_like(), "based_on": None}).json()["based_on"] is None
    assert create(client, {**official_like(), "based_on": OFFICIAL_ID}).json()["based_on"] == OFFICIAL_ID
    bad_shapes = (
        {"checklist_id": "official-chat"},
        {"version": 1},
        {"checklist_id": "official-chat", "version": 0},
        "official-chat",
        {"checklist_id": "x", "version": "v1"},
    )
    for bad in bad_shapes:
        r = create(client, {**official_like(), "based_on": bad})
        assert (r.status_code, r.json()["error"]) == (422, "invalid_request"), bad


@pytest.mark.parametrize(
    "dangling",
    [
        {"checklist_id": "no-such-checklist", "version": 1},
        {"checklist_id": "official-chat", "version": 99},
        {"checklist_id": "official-chat", "version": 99999999999999999999},  # beyond SQLite's integers
    ],
)
def test_based_on_must_reference_an_existing_version(
    client: TestClient, official_base: dict, dangling: dict
) -> None:
    before = len(client.get("/api/checklists").json())
    r = create(client, {**official_like(), "based_on": dangling})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_checklist"), r.text
    assert "based_on" in r.json()["message"] and dangling["checklist_id"] in r.json()["message"]
    assert len(client.get("/api/checklists").json()) == before

    cid = create_ok(client)["checklist_id"]
    r = new_version(client, cid, {**official_like(), "based_on": dangling})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_checklist"), r.text
    assert client.get(f"/api/checklists/{cid}/versions/2").status_code == 404


def test_based_on_may_reference_any_stored_version_not_only_the_latest(client: TestClient) -> None:
    base = create_ok(client)["checklist_id"]
    new_version(client, base, official_like())
    old = {"checklist_id": base, "version": 1}
    assert create(client, {**official_like(), "based_on": old}).json()["based_on"] == old


def test_create_without_fingerprints_is_fine_and_with_garbage_ones_too(client: TestClient) -> None:
    clean = official_like()
    assert all("fingerprint" not in c for c in clean["criteria"])
    expected = {c["id"]: criterion_fingerprint(c) for c in clean["criteria"]}
    assert fingerprints(create_ok(client, clean)) == expected
    for garbage in (None, "", "x", 5, {"a": 1}):
        noisy = official_like()
        noisy["criteria"][0]["fingerprint"] = garbage
        assert fingerprints(create_ok(client, noisy)) == expected, garbage


def test_fingerprint_is_computed_from_the_validated_criterion(client: TestClient) -> None:
    # `na_allowed: 0` and a scale value `5.0` are coerced; the fingerprint is that of the result.
    checklist = official_like()
    checklist["criteria"][0]["na_allowed"] = 0
    checklist["criteria"][3]["scale_steps"][1]["value"] = 5.0
    body = create_ok(client, checklist)
    for c in body["criteria"]:
        assert c["fingerprint"] == criterion_fingerprint(c)
    assert body["criteria"][0]["na_allowed"] is False
    assert fingerprints(body) == fingerprints(create_ok(client, official_like()))


def test_created_checklists_get_different_ids_even_with_the_same_name(client: TestClient) -> None:
    ids = {create_ok(client)["checklist_id"] for _ in range(5)}
    assert len(ids) == 5


def test_create_retries_an_id_that_is_taken(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    taken = create_ok(client)["checklist_id"]
    candidates = iter([taken, taken, "fresh-id-abc123"])
    monkeypatch.setattr("app.routes.checklists.new_checklist_id", lambda name: next(candidates))
    assert create_ok(client)["checklist_id"] == "fresh-id-abc123"
    assert client.get(f"/api/checklists/{taken}/versions/1").json()["checklist_id"] == taken


# --- validation ----------------------------------------------------------------------------


def test_invalid_checklist(client: TestClient) -> None:
    broken = official_like()
    broken["criteria"][3]["scale_steps"] = []  # c04 is a scale without steps
    r = create(client, broken)
    assert r.status_code == 422
    assert r.json()["error"] == "invalid_checklist"
    assert "c04" in r.json()["message"]
    assert not [c for c in client.get("/api/checklists").json() if c["name"] == broken["name"]]


def mutate(fn: Callable[[dict], None]) -> dict:
    checklist = official_like()
    fn(checklist)
    return checklist


INVALID = {
    "duplicate_criterion_id": (lambda c: c["criteria"][1].update(id="c01"), "duplicate criterion id 'c01'"),
    "unknown_section": (lambda c: c["criteria"][0].update(section_id="nowhere"), "'nowhere'"),
    "scale_without_steps": (lambda c: c["criteria"][5].update(scale_steps=[]), "'c06'"),
    "duplicate_step_values": (
        lambda c: c["criteria"][3].update(
            scale_steps=[{"value": 0, "label": "a"}, {"value": 5, "label": "b"}, {"value": 5, "label": "c"}]
        ),
        "duplicate scale step value 5",
    ),
    "top_step_zero": (
        lambda c: c["criteria"][3].update(scale_steps=[{"value": 0, "label": "a"}]),
        "'c04'",
    ),
    "top_step_negative": (
        lambda c: c["criteria"][3].update(scale_steps=[{"value": -5, "label": "a"}, {"value": -1, "label": "b"}]),
        "'c04'",
    ),
    "gross_error_with_weight": (lambda c: c["criteria"][7].update(weight=5), "'c08'"),
    "negative_weight": (lambda c: c["criteria"][0].update(weight=-1), "'c01'"),
    "negative_step_value": (
        lambda c: c["criteria"][3].update(
            scale_steps=[{"value": -5, "label": "a"}, {"value": 0, "label": "b"}, {"value": 10, "label": "c"}]
        ),
        "criterion 'c04': scale step values must not be negative",
    ),
    "empty_name": (lambda c: c.update(name=""), "needs a name"),
    "blank_name": (lambda c: c.update(name="  \t\n "), "needs a name"),
    "no_criteria": (lambda c: c.update(criteria=[]), "at least one criterion"),
    "duplicate_section_id": (
        lambda c: c["sections"].append({"id": "start", "title": "Ещё раз", "order": 9}),
        "duplicate section id 'start'",
    ),
}  # fmt: skip


@pytest.mark.parametrize("case", INVALID)
def test_each_rule_rejects_with_invalid_checklist(client: TestClient, case: str) -> None:
    mutation, fragment = INVALID[case]
    r = create(client, mutate(mutation))
    assert (r.status_code, r.json()["error"]) == (422, "invalid_checklist"), r.text
    assert fragment in r.json()["message"]
    cid = create_ok(client)["checklist_id"]
    r = new_version(client, cid, mutate(mutation))
    assert (r.status_code, r.json()["error"]) == (422, "invalid_checklist")
    assert client.get(f"/api/checklists/{cid}/versions/2").status_code == 404


def test_all_errors_are_listed_in_one_message(client: TestClient) -> None:
    def break_two(c: dict) -> None:
        c["criteria"][0]["section_id"] = "nowhere"
        c["criteria"][7]["weight"] = 5

    message = create(client, mutate(break_two)).json()["message"]
    assert "'nowhere'" in message and "'c08'" in message and "; " in message


def test_a_scale_may_start_above_zero(client: TestClient) -> None:
    checklist = official_like()
    checklist["criteria"][3]["scale_steps"] = [{"value": 1, "label": "a"}, {"value": 3, "label": "b"}]
    assert create(client, checklist).status_code == 201


@pytest.mark.parametrize(
    "bad",
    [{}, {"criteria": "nope"}, {"name": "x", "sections": [], "criteria": [{"id": "c01"}]}],
)
def test_a_malformed_body_is_invalid_request(client: TestClient, bad: dict) -> None:
    r = client.post("/api/checklists", json={"role": "controller", "checklist": bad})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_request")


# --- weights (they arrive as JSON numbers or as strings) -----------------------------------


def with_weight(weight) -> dict:
    checklist = official_like()
    checklist["criteria"][0]["weight"] = weight  # c01, 10 in the official shape: the sum becomes 90 + weight
    return checklist


@pytest.mark.parametrize(
    ("weight", "expected_weight", "warnings"),
    [
        ("12", 12, ["weights_sum_102"]),
        ("12.0", 12, ["weights_sum_102"]),
        ("12.5", 12.5, ["weights_sum_102.5"]),
        ("0.1", 0.1, ["weights_sum_90.1"]),
        (12, 12, ["weights_sum_102"]),
        (12.5, 12.5, ["weights_sum_102.5"]),
        ("10", 10, []),
        ("10.00", 10, []),
        ("1000", 1000, ["weights_sum_1090"]),
        ("0", 0, ["weights_sum_90"]),
    ],
)
def test_valid_weights_as_numbers_or_strings_keep_their_exact_warnings(
    client: TestClient, weight, expected_weight, warnings: list[str]
) -> None:
    created = create(client, with_weight(weight))
    assert created.status_code == 201, created.text
    assert created.json()["warnings"] == warnings
    assert created.json()["criteria"][0]["weight"] == expected_weight
    assert isinstance(created.json()["criteria"][0]["weight"], int | float)

    cid = create_ok(client)["checklist_id"]
    appended = new_version(client, cid, with_weight(weight))
    assert appended.status_code == 201, appended.text
    assert appended.json()["warnings"] == warnings
    assert client.get("/api/checklists").status_code == 200


@pytest.mark.parametrize(
    "weight",
    ["1e400", "1e100000", "1000.01", "1001", "1e3000000", "-1", "-0.5", "1e-400", "12.1234567890123456789", "0.1000000000000000055511151231257827"],
)
def test_a_weight_that_cannot_be_stored_is_invalid_checklist_naming_the_criterion(
    client: TestClient, weight: str
) -> None:
    cid = create_ok(client)["checklist_id"]
    listed_before = client.get("/api/checklists").json()

    r = create(client, with_weight(weight))
    assert (r.status_code, r.json()["error"]) == (422, "invalid_checklist"), r.text
    assert "'c01'" in r.json()["message"] and "weight" in r.json()["message"]

    r = new_version(client, cid, with_weight(weight))
    assert (r.status_code, r.json()["error"]) == (422, "invalid_checklist"), r.text
    assert "'c01'" in r.json()["message"]

    # Nothing was stored, and reading the checklists still works (it used to fail for good).
    after = client.get("/api/checklists")
    assert after.status_code == 200
    assert after.json() == listed_before
    assert client.get(f"/api/checklists/{cid}/versions/2").status_code == 404


@pytest.mark.parametrize("weight", ["Infinity", "-Infinity", "NaN", "inf", "nan", "twelve", "", None])
def test_a_weight_that_is_not_a_number_is_invalid_request(client: TestClient, weight) -> None:
    r = create(client, with_weight(weight))
    assert (r.status_code, r.json()["error"]) == (422, "invalid_request"), r.text
    assert client.get("/api/checklists").status_code == 200


@pytest.mark.parametrize("literal", ["1e400", "-1e400", "NaN", "Infinity"])
def test_a_json_number_literal_that_is_not_finite_is_rejected(client: TestClient, literal: str) -> None:
    # Python's JSON parser reads 1e400 as an infinite float and accepts NaN / Infinity.
    body = json.dumps({"role": "controller", "checklist": with_weight("__W__")}).replace('"__W__"', literal)
    r = client.post("/api/checklists", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 422, r.text
    assert client.get("/api/checklists").status_code == 200


def test_the_weight_cap_applies_to_the_gross_error_weight_too(client: TestClient) -> None:
    checklist = official_like()
    checklist["criteria"][7]["weight"] = "1e400"
    r = create(client, checklist)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_checklist")
    assert "'c08'" in r.json()["message"]


# --- validate_checklist / weight_warnings (unit) -------------------------------------------


def version_of(checklist: dict) -> ChecklistVersion:
    data = {**checklist, "checklist_id": "x", "version": 1}
    data["criteria"] = [{**c, "fingerprint": "-"} for c in data["criteria"]]
    return ChecklistVersion.model_validate(data)


def test_validate_checklist_accepts_the_official_shape() -> None:
    assert validate_checklist(version_of(official_like())) == []


def test_validate_checklist_returns_every_error_without_raising() -> None:
    def break_three(c: dict) -> None:
        c["criteria"][1]["id"] = "c01"
        c["criteria"][0]["section_id"] = "nowhere"
        c["criteria"][7]["weight"] = 5

    errors = validate_checklist(version_of(mutate(break_three)))
    assert len(errors) == 3
    assert any("duplicate criterion id 'c01'" in e for e in errors)


@pytest.mark.parametrize(
    "weight",
    [
        Decimal("Infinity"), Decimal("-Infinity"), Decimal("NaN"), Decimal("sNaN"),
        Decimal("1E+400"), Decimal("1E+100000"), Decimal("1000.01"), Decimal("-0.01"),
        Decimal("1E-400"), Decimal("0.1234567890123456789"),
    ],
)  # fmt: skip
def test_validate_checklist_rejects_a_weight_that_cannot_be_stored_without_raising(weight: Decimal) -> None:
    # model_copy skips validation: this is the loader's and the API's last line of defence.
    version = version_of(official_like())
    criteria = [version.criteria[0].model_copy(update={"weight": weight}), *version.criteria[1:]]
    errors = validate_checklist(version.model_copy(update={"criteria": criteria}))
    assert len(errors) == 1 and "'c01'" in errors[0] and "weight" in errors[0]


@pytest.mark.parametrize("weight", [Decimal("0"), Decimal("12"), Decimal("12.0"), Decimal("12.5"), Decimal("1000"), Decimal("0.1")])
def test_validate_checklist_accepts_weights_that_survive_the_float_round_trip(weight: Decimal) -> None:
    version = version_of(official_like())
    criteria = [version.criteria[0].model_copy(update={"weight": weight}), *version.criteria[1:]]
    assert validate_checklist(version.model_copy(update={"criteria": criteria})) == []


def test_validate_checklist_needs_a_name_and_a_criterion_and_no_negative_step() -> None:
    assert validate_checklist(version_of(mutate(lambda c: c.update(name="")))) == ["the checklist needs a name"]
    assert validate_checklist(version_of(mutate(lambda c: c.update(name=" \t ")))) == ["the checklist needs a name"]
    assert validate_checklist(version_of(mutate(lambda c: c.update(criteria=[])))) == [
        "the checklist needs at least one criterion"
    ]
    negative = mutate(lambda c: c["criteria"][5].update(
        scale_steps=[{"value": -1, "label": "a"}, {"value": 7, "label": "b"}]
    ))  # fmt: skip
    assert validate_checklist(version_of(negative)) == ["criterion 'c06': scale step values must not be negative"]


@needs_seed
def test_the_official_seed_passes_validation_without_a_warning() -> None:
    official = checklists.load_seed(SEED)
    assert validate_checklist(official) == []
    assert weight_warnings(official) == []


def test_weight_warnings() -> None:
    assert weight_warnings(version_of(official_like())) == []

    def bump(weight):
        checklist = official_like()
        checklist["criteria"][0]["weight"] = weight
        return weight_warnings(version_of(checklist))

    assert bump(12) == ["weights_sum_102"]
    assert bump(Decimal("9.5")) == ["weights_sum_99.5"]
    assert bump(0) == ["weights_sum_90"]
    only_gross = official_like()
    only_gross["criteria"] = [only_gross["criteria"][7]]
    assert weight_warnings(version_of(only_gross)) == ["weights_sum_0"]


# --- slug ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Звонки", "zvonki"),
        ("Чек-лист качества чатов", "chek-list-kachestva-chatov"),
        ("Щётка, ёж & Ъ-знак!", "shchyotka-yozh-znak"),
        ("Қазақ әдебиеті: ғылым, өнер", "kazak-adebieti-gylym-oner"),
        ("Ұлт, үй, һәм, ақыл, іс", "ult-uy-ham-akyl-is"),
        ("Ң ң Ә ә Ө ө Ғ ғ", "n-n-a-a-o-o-g-g"),
        ("  Hello,   WORLD!!  ", "hello-world"),
        ("Café déjà vu", "cafe-deja-vu"),
        ("Version 2.0 (final)", "version-2-0-final"),
        ("", "checklist"),
        ("???", "checklist"),
        ("中文", "checklist"),
    ],
)
def test_slug(name: str, expected: str) -> None:
    assert slug(name) == expected


def test_slug_is_at_most_40_characters_and_never_ends_with_a_dash() -> None:
    long = slug("Очень длинное название чек-листа для проверки качества диалогов операторов")
    assert 0 < len(long) <= 40
    assert not long.startswith("-") and not long.endswith("-")
    assert slug("a" * 39 + " b") == "a" * 39  # cut at 40 characters, then the dangling dash goes


def test_a_russian_name_gives_an_ascii_id() -> None:
    cid = new_checklist_id("Чек-лист качества чатов")
    assert cid.isascii()
    assert re.fullmatch(r"chek-list-kachestva-chatov-[0-9a-f]{6}", cid)
    assert re.fullmatch(r"checklist-[0-9a-f]{6}", new_checklist_id("!!!"))
    assert new_checklist_id("x") != new_checklist_id("x")


def test_created_id_from_a_russian_name_is_ascii_through_the_api(client: TestClient) -> None:
    body = create_ok(client, {**official_like(), "name": "Проверка ёжиков"})
    assert body["checklist_id"].isascii()
    assert re.fullmatch(r"proverka-yozhikov-[0-9a-f]{6}", body["checklist_id"])


# --- POST /checklists/{id}/versions --------------------------------------------------------


def test_new_version_is_latest_plus_one(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    versions = []
    for weight in (11, 12, 13):
        changed = official_like()
        changed["criteria"][0]["weight"] = weight
        r = new_version(client, cid, changed)
        assert r.status_code == 201, r.text
        versions.append((r.json()["version"], r.json()["id"], r.json()["checklist_id"], r.json()["locked"]))
    assert versions == [(v, f"{cid}:{v}", cid, False) for v in (2, 3, 4)]
    assert listed(client, cid)["versions"] == [1, 2, 3, 4]
    # Older versions are immutable.
    assert client.get(f"/api/checklists/{cid}/versions/1").json()["criteria"][0]["weight"] == 10


def test_weight_only_change_keeps_fingerprints(client: TestClient) -> None:
    first = create_ok(client)
    cid = first["checklist_id"]
    changed = official_like()
    changed["criteria"][0]["weight"] = 12  # c01: 10 -> 12, the sum is 102
    r = new_version(client, cid, changed)
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["version"] == 2
    assert fingerprints(body) == fingerprints(first)
    assert body["warnings"] == ["weights_sum_102"]
    assert body["criteria"][0]["weight"] == 12
    # The warning is not stored: reading the version again has none, and the save did succeed.
    assert "warnings" not in client.get(f"/api/checklists/{cid}/versions/2").json()


def test_a_changed_wording_changes_that_fingerprint_only(client: TestClient) -> None:
    first = create_ok(client)
    cid = first["checklist_id"]
    changed = official_like()
    changed["criteria"][2]["wording"] = "Да — личность подтверждена дважды."
    body = new_version(client, cid, changed).json()
    differing = {k for k, v in fingerprints(body).items() if fingerprints(first)[k] != v}
    assert differing == {"c03"}


def test_new_version_takes_the_id_from_the_path_and_ignores_the_body(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    checklist = {
        **official_like(),
        "id": "other:99", "checklist_id": "other", "version": 99, "locked": True,
        "created_at": "2020-01-01T00:00:00Z",
    }  # fmt: skip
    r = new_version(client, cid, checklist, role="reviewer")
    assert r.status_code == 201, r.text
    body = r.json()
    assert (body["checklist_id"], body["version"], body["locked"]) == (cid, 2, False)
    assert body["id"] == f"{cid}:2" and body["author_role"] == "reviewer"
    assert client.get("/api/checklists/other/versions/99").status_code == 404


def test_new_version_inherits_based_on_when_the_key_is_absent(client: TestClient, official_base: dict) -> None:
    cid = create_ok(client, {**official_like(), "based_on": OFFICIAL_ID})["checklist_id"]
    omitted = new_version(client, cid, official_like())  # no `based_on` key at all
    assert omitted.status_code == 201 and omitted.json()["based_on"] == OFFICIAL_ID
    assert client.get(f"/api/checklists/{cid}/versions/2").json()["based_on"] == OFFICIAL_ID
    # ... and the next one inherits from the latest, so it keeps going.
    assert new_version(client, cid, official_like()).json()["based_on"] == OFFICIAL_ID


def test_new_version_with_a_based_on_replaces_the_inherited_one(client: TestClient, official_base: dict) -> None:
    cid = create_ok(client, {**official_like(), "based_on": OFFICIAL_ID})["checklist_id"]
    other = {"checklist_id": create_ok(client)["checklist_id"], "version": 1}
    given = new_version(client, cid, {**official_like(), "based_on": other})
    assert given.json()["based_on"] == other
    assert new_version(client, cid, official_like()).json()["based_on"] == other  # inherits the new one


def test_an_explicit_null_clears_based_on(client: TestClient, official_base: dict) -> None:
    cid = create_ok(client, {**official_like(), "based_on": OFFICIAL_ID})["checklist_id"]
    cleared = new_version(client, cid, {**official_like(), "based_on": None})
    assert cleared.status_code == 201 and cleared.json()["based_on"] is None
    assert client.get(f"/api/checklists/{cid}/versions/2").json()["based_on"] is None
    # Cleared stays cleared: the next version inherits the null.
    assert new_version(client, cid, official_like()).json()["based_on"] is None
    # The earlier version still says what it was based on.
    assert client.get(f"/api/checklists/{cid}/versions/1").json()["based_on"] == OFFICIAL_ID


def test_a_new_version_of_a_checklist_without_based_on_has_none(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    assert new_version(client, cid, official_like()).json()["based_on"] is None


def test_new_version_of_an_unknown_checklist_is_404(client: TestClient) -> None:
    r = new_version(client, "nope", official_like())
    assert (r.status_code, r.json()["error"]) == (404, "not_found")
    assert client.get("/api/checklists/nope/versions/1").status_code == 404


def test_locked_refuses_new_version(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    lock(cid, 1)
    r = new_version(client, cid, official_like())
    assert r.status_code == 409
    assert r.json()["error"] == "checklist_locked"
    assert client.get(f"/api/checklists/{cid}/versions/2").status_code == 404


@needs_seed
def test_official_refuses_new_version(client: TestClient) -> None:
    before = listed(client, "official-chat")["versions"]
    r = new_version(client, "official-chat", official_like())
    assert (r.status_code, r.json()["error"]) == (409, "checklist_locked")
    assert listed(client, "official-chat")["versions"] == before


def test_the_latest_version_decides_whether_a_checklist_is_locked(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    assert new_version(client, cid, official_like()).status_code == 201
    lock(cid, 2)
    assert new_version(client, cid, official_like()).status_code == 409
    assert listed(client, cid)["versions"] == [1, 2]


# --- roles ---------------------------------------------------------------------------------


@pytest.mark.parametrize("role", ["controller", "reviewer"])
def test_role_recorded(client: TestClient, role: str) -> None:
    body = create_ok(client, role=role)
    assert body["author_role"] == role
    cid = body["checklist_id"]
    assert client.get(f"/api/checklists/{cid}/versions/1").json()["author_role"] == role
    other = "reviewer" if role == "controller" else "controller"
    assert new_version(client, cid, official_like(), role=other).json()["author_role"] == other
    assert client.get(f"/api/checklists/{cid}/versions/2").json()["author_role"] == other
    assert client.get(f"/api/checklists/{cid}/versions/1").json()["author_role"] == role


def test_missing_role_is_422(client: TestClient) -> None:
    r = client.post("/api/checklists", json={"checklist": official_like()})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_request")
    assert "role" in r.json()["message"]
    cid = create_ok(client)["checklist_id"]
    r = client.post(f"/api/checklists/{cid}/versions", json={"checklist": official_like()})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_request")
    assert client.get(f"/api/checklists/{cid}/versions/2").status_code == 404


@pytest.mark.parametrize("role", ["admin", "", None, 1])
def test_unknown_role_is_422(client: TestClient, role) -> None:
    r = create(client, role=role)
    assert (r.status_code, r.json()["error"]) == (422, "invalid_request")


def test_missing_checklist_is_422(client: TestClient) -> None:
    r = client.post("/api/checklists", json={"role": "controller"})
    assert (r.status_code, r.json()["error"]) == (422, "invalid_request")


# --- the store -----------------------------------------------------------------------------


def stored_version(checklist_id: str, version: int = 1, **overrides) -> ChecklistVersion:
    data = {**official_like(), "checklist_id": checklist_id, "version": version, **overrides}
    data["criteria"] = [{**c, "fingerprint": criterion_fingerprint(c)} for c in data["criteria"]]
    return ChecklistVersion.model_validate(data)


@pytest.fixture
def migrated() -> None:
    db.migrate()


def test_latest_versions_one_per_checklist_oldest_first(migrated: None) -> None:
    store.save_checklist_version(stored_version("b-list", 1))
    store.save_checklist_version(stored_version("a-list", 1))
    store.save_checklist_version(stored_version("b-list", 2))
    store.save_checklist_version(stored_version("b-list", 3, locked=True))
    latest = store.latest_versions()
    assert [(v.checklist_id, v.version) for v in latest] == [("b-list", 3), ("a-list", 1)]
    assert latest[0] == store.get_checklist_version("b-list", 3)
    assert latest[0].locked is True and latest[1].locked is False
    assert store.latest_versions() == [store.get_checklist_version(c, v) for c, v in (("b-list", 3), ("a-list", 1))]


@pytest.mark.parametrize("number", [0, -1, MAX_VERSION + 1, 2**63, 10**20])
def test_get_checklist_version_out_of_range_is_none_not_an_overflow(migrated: None, number: int) -> None:
    store.save_checklist_version(stored_version("x", 1))
    assert store.get_checklist_version("x", number) is None


def test_append_inherits_based_on_only_when_asked(migrated: None) -> None:
    root = {"checklist_id": "root", "version": 1}
    other = {"checklist_id": "other", "version": 2}
    store.save_checklist_version(stored_version("x", 1, based_on=root))
    plain = stored_version("ignored", 1)  # based_on None
    assert store.append_checklist_version("x", plain).based_on is None
    given = store.append_checklist_version("x", plain.model_copy(update={"based_on": other}))
    assert given.based_on == other
    store.save_checklist_version(stored_version("y", 1, based_on=root))
    inherited = store.append_checklist_version("y", plain, inherit_based_on=True)
    assert inherited.based_on == root
    assert store.get_checklist_version("y", 2).based_on == root
    # Inheriting takes the latest stored version's value, which may itself be None.
    assert store.append_checklist_version("x", given, inherit_based_on=True).based_on == other


def test_latest_versions_is_empty_without_checklists(migrated: None) -> None:
    assert store.latest_versions() == []
    assert store.list_checklists() == []


def test_list_checklists_pairs_each_latest_with_its_version_numbers(migrated: None) -> None:
    for version in (1, 2, 3):
        store.save_checklist_version(stored_version("x", version))
    store.save_checklist_version(stored_version("y", 1))
    listing = store.list_checklists()
    assert [(v.checklist_id, v.version, numbers) for v, numbers in listing] == [
        ("x", 3, [1, 2, 3]),
        ("y", 1, [1]),
    ]


def test_latest_versions_reads_locked_from_the_column(migrated: None) -> None:
    store.save_checklist_version(stored_version("x", 1))
    lock("x", 1)
    assert store.latest_versions()[0].locked is True
    assert store.get_checklist_version("x", 1).locked is True


def test_save_writes_the_locked_column_from_the_model(migrated: None) -> None:
    store.save_checklist_version(stored_version("x", 1, locked=True))
    store.save_checklist_version(stored_version("y", 1, locked=False))
    conn = db.connect()
    try:
        rows = conn.execute("SELECT checklist_id, locked FROM checklist_versions ORDER BY 1").fetchall()
    finally:
        conn.close()
    assert [(r["checklist_id"], r["locked"]) for r in rows] == [("x", 1), ("y", 0)]


def test_append_checklist_version(migrated: None) -> None:
    store.save_checklist_version(stored_version("x", 1))
    saved = store.append_checklist_version("x", stored_version("ignored", 99, name="Второй"))
    assert (saved.checklist_id, saved.version, saved.id) == ("x", 2, "x:2")
    assert saved.created_at is not None
    assert store.get_checklist_version("x", 2) == saved
    assert store.get_checklist_version("ignored", 99) is None


def test_append_refuses_unknown_and_locked(migrated: None) -> None:
    with pytest.raises(ApiError) as unknown:
        store.append_checklist_version("x", stored_version("x", 1))
    assert (unknown.value.status, unknown.value.code) == (404, "not_found")
    store.save_checklist_version(stored_version("x", 1, locked=True))
    with pytest.raises(ApiError) as locked:
        store.append_checklist_version("x", stored_version("x", 2))
    assert (locked.value.status, locked.value.code) == (409, "checklist_locked")
    assert store.get_checklist_version("x", 2) is None


def test_concurrent_appends_get_distinct_consecutive_versions(migrated: None) -> None:
    store.save_checklist_version(stored_version("x", 1))
    results: list[int] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(6)

    def run() -> None:
        try:
            barrier.wait()
            results.append(store.append_checklist_version("x", stored_version("x", 1)).version)
        except BaseException as exc:  # noqa: BLE001 - collected and asserted below
            errors.append(exc)

    threads = [threading.Thread(target=run) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert sorted(results) == [2, 3, 4, 5, 6, 7]


def test_concurrent_posts_of_a_new_version(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    statuses: list[tuple[int, int | None]] = []
    barrier = threading.Barrier(4)

    def run() -> None:
        barrier.wait()
        r = new_version(client, cid, official_like())
        statuses.append((r.status_code, r.json().get("version")))

    threads = [threading.Thread(target=run) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(statuses) == [(201, 2), (201, 3), (201, 4), (201, 5)]
    assert listed(client, cid)["versions"] == [1, 2, 3, 4, 5]


# --- Hidden checklist versions (HIDDEN_CHECKLIST_VERSIONS) ---------------------------------------


def _hide_setup() -> None:
    """x has versions 1-3, y has one version; both stored before the client starts."""
    db.migrate()
    for version in (1, 2, 3):
        store.save_checklist_version(stored_version("x-hide", version))
    store.save_checklist_version(stored_version("y-hide", 1))


def _listing(client: TestClient) -> dict[str, tuple[int, list[int]]]:
    return {c["checklist_id"]: (c["version"], c["versions"]) for c in client.get("/api/checklists").json()}


def test_nothing_hidden_by_default(make_client: MakeClient) -> None:
    _hide_setup()
    listing = _listing(make_client())
    assert listing["x-hide"] == (3, [1, 2, 3])
    assert listing["y-hide"] == (1, [1])


def test_a_hidden_older_version_leaves_the_numbers(make_client: MakeClient) -> None:
    _hide_setup()
    listing = _listing(make_client(HIDDEN_CHECKLIST_VERSIONS='["x-hide:2"]'))
    assert listing["x-hide"] == (3, [1, 3])


def test_a_hidden_latest_version_is_replaced_by_the_latest_visible(make_client: MakeClient) -> None:
    _hide_setup()
    client = make_client(HIDDEN_CHECKLIST_VERSIONS='["x-hide:3"]')
    entry = next(c for c in client.get("/api/checklists").json() if c["checklist_id"] == "x-hide")
    assert (entry["version"], entry["versions"]) == (2, [1, 2])
    assert {k: v for k, v in entry.items() if k != "versions"} == client.get(
        "/api/checklists/x-hide/versions/2"
    ).json()


def test_a_checklist_with_every_version_hidden_is_not_listed(make_client: MakeClient) -> None:
    _hide_setup()
    listing = _listing(make_client(HIDDEN_CHECKLIST_VERSIONS='["y-hide:1"]'))
    assert "y-hide" not in listing
    assert listing["x-hide"] == (3, [1, 2, 3])


def test_a_hidden_version_stays_readable_and_stored(make_client: MakeClient) -> None:
    _hide_setup()
    client = make_client(HIDDEN_CHECKLIST_VERSIONS='["x-hide:3", "y-hide:1"]')
    assert client.get("/api/checklists/x-hide/versions/3").status_code == 200
    assert client.get("/api/checklists/y-hide/versions/1").status_code == 200
    assert store.get_checklist_version("y-hide", 1) is not None


def test_hiding_an_unknown_version_changes_nothing(make_client: MakeClient) -> None:
    _hide_setup()
    listing = _listing(make_client(HIDDEN_CHECKLIST_VERSIONS='["x-hide:9", "nope:1"]'))
    assert listing["x-hide"] == (3, [1, 2, 3])
    assert listing["y-hide"] == (1, [1])


@pytest.mark.parametrize("entry", ["official-chat", "x:0", "x:-1", "x:1.5", ":1", "a b:1", "x:1:2"])
def test_a_malformed_hidden_entry_is_rejected(entry: str) -> None:
    from pydantic import ValidationError

    from app.settings import Settings

    with pytest.raises(ValidationError):
        Settings(hidden_checklist_versions=[entry])


def test_the_default_checklist_version_cannot_be_hidden() -> None:
    from pydantic import ValidationError

    from app.settings import DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION, Settings

    with pytest.raises(ValidationError, match="cannot be hidden"):
        Settings(hidden_checklist_versions=[f"{DEFAULT_CHECKLIST_ID}:{DEFAULT_CHECKLIST_VERSION}"])
