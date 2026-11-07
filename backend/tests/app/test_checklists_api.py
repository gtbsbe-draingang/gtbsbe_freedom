"""The checklists API (Task 7): versions, copy with based_on, fingerprints, validation.

Almost every test builds its checklist inline, so they run with or without stream A's official
seed (`checklists/official-chat-v1.json`). Once the seed is on the branch, every test client's
database also holds `official-chat:1`; the tests therefore look their own checklists up by id and
never assume the list is exactly theirs. The tests about the real official checklist are skipped
until the seed exists.
"""

import copy
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
    assert official[0]["version"] == 1 and official[0]["locked"] is True
    assert official[0]["versions"] == [1]
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


def test_copy_with_based_on_and_replace_one_criterion(client: TestClient) -> None:
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
def test_copy_of_the_real_official_with_c06_replaced(client: TestClient) -> None:
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


def test_create_keeps_based_on_when_given_and_validates_its_shape(client: TestClient) -> None:
    assert create_ok(client)["based_on"] is None
    assert create(client, {**official_like(), "based_on": None}).json()["based_on"] is None
    bad_shapes = ({"checklist_id": "official-chat"}, {"version": 1}, "official-chat", {"checklist_id": "x", "version": "v1"})
    for bad in bad_shapes:
        r = create(client, {**official_like(), "based_on": bad})
        assert (r.status_code, r.json()["error"]) == (422, "invalid_request"), bad


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


def test_new_version_keeps_based_on_when_given(client: TestClient) -> None:
    cid = create_ok(client)["checklist_id"]
    given = new_version(client, cid, {**official_like(), "based_on": OFFICIAL_ID}).json()
    assert given["based_on"] == OFFICIAL_ID
    omitted = new_version(client, cid, official_like()).json()
    assert omitted["based_on"] is None


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
    r = new_version(client, "official-chat", official_like())
    assert (r.status_code, r.json()["error"]) == (409, "checklist_locked")
    assert listed(client, "official-chat")["versions"] == [1]


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
