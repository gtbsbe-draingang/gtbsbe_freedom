"""Checklists: read them, create one (also: copy with `based_on`), save a new version.

The contract is section 7 of the front-end design, editing rules are in its section 6. A version is
immutable once saved. An unlocked checklist gets a new version on every save; a locked one (the
official v1) refuses it with 409 `checklist_locked`, and the UI saves a copy as a new checklist
instead, recording `based_on`.

What the server decides, never the client: the checklist id (create), the version number, `locked`
(always False for a new version), `created_at`, `id`, and every fingerprint (computed from the
criterion as validated; a fingerprint in the body is ignored, so the UI may leave it out or post
back what it read). What the client decides: name, description, channel, rounding, guidance,
sections, criteria and `based_on`, which must name a stored version. A new version posted without
a `based_on` key inherits the previous version's; an explicit null clears it.
"""

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app import store
from app.checklists import new_checklist_id, validate_checklist, weight_warnings, with_fingerprints
from app.errors import ApiError
from app.models import ChecklistVersion, Criterion, Role, Section, dump
from app.settings import get_settings

router = APIRouter()

# A random 6-hex suffix makes a taken id a one-in-16-million event; retrying makes it harmless.
_ID_ATTEMPTS = 5


class BasedOn(BaseModel):
    checklist_id: str
    version: int = Field(ge=1)


class CriterionIn(Criterion):
    fingerprint: Any = None  # whatever the client sends is ignored: the server computes it


class ChecklistIn(BaseModel):
    name: str
    description: str = ""
    channel: Literal["any", "chat", "call"] = "any"
    based_on: BasedOn | None = None
    rounding: int = 2
    guidance: str = ""
    sections: list[Section]
    criteria: list[CriterionIn]


class ChecklistRequest(BaseModel):
    role: Role
    checklist: ChecklistIn


def _based_on_error(based_on: BasedOn | None) -> str | None:
    if based_on is None or store.get_checklist_version(based_on.checklist_id, based_on.version):
        return None
    return (
        f"based_on refers to checklist {based_on.checklist_id!r} version {based_on.version}, "
        "which does not exist"
    )


def _draft(request: ChecklistRequest) -> tuple[ChecklistVersion, list[str]]:
    """The version to store (id and version still to be set by the store) and its warnings.
    Raises ApiError(422, "invalid_checklist") when it breaks a rule or its `based_on` is not a
    stored version."""
    body = request.checklist
    draft = ChecklistVersion(
        checklist_id="",
        version=1,
        name=body.name,
        description=body.description,
        channel=body.channel,
        locked=False,
        based_on=body.based_on.model_dump() if body.based_on else None,
        author_role=request.role,
        rounding=body.rounding,
        guidance=body.guidance,
        sections=body.sections,
        criteria=[Criterion(**{**dict(c), "fingerprint": ""}) for c in body.criteria],
    )
    errors = validate_checklist(draft)
    based_on_error = _based_on_error(body.based_on)
    if based_on_error:
        errors.append(based_on_error)
    if errors:
        raise ApiError(422, "invalid_checklist", "; ".join(errors))
    return with_fingerprints(draft), weight_warnings(draft)


def _saved(version: ChecklistVersion, warnings: list[str]) -> dict[str, Any]:
    return {**dump(version), "warnings": warnings}


@router.get("/checklists")
def list_checklists() -> list[dict[str, Any]]:
    """The latest version of every checklist, each with `versions`: all its version numbers.

    Versions named in HIDDEN_CHECKLIST_VERSIONS are left out: of `versions`, and as the version
    returned (the latest visible one stands in for a hidden latest). A checklist whose versions are
    all hidden is not listed. Hidden versions are still readable by id and number."""
    hidden = set(get_settings().hidden_checklist_versions)
    listing = []
    for version, numbers in store.list_checklists():
        visible = [n for n in numbers if f"{version.checklist_id}:{n}" not in hidden]
        if not visible:
            continue
        if visible[-1] != version.version:
            shown = store.get_checklist_version(version.checklist_id, visible[-1])
            if shown is None:  # cannot happen: the number came from the same table
                continue
            version = shown
        listing.append({**dump(version), "versions": visible})
    return listing


@router.get("/checklists/{checklist_id}/versions/{version}")
def get_checklist_version(checklist_id: str, version: int) -> dict[str, Any]:
    # A number outside 1..2**31-1 is a version that cannot exist: the store answers None, so 404.
    found = store.get_checklist_version(checklist_id, version)
    if found is None:
        raise ApiError(404, "not_found", f"No version {version} of checklist {checklist_id!r}.")
    return dump(found)


def _save_as_new_checklist(draft: ChecklistVersion) -> ChecklistVersion:
    checklist_id = new_checklist_id(draft.name)
    return store.save_checklist_version(draft.model_copy(update={"checklist_id": checklist_id}))


@router.post("/checklists", status_code=201)
def create_checklist(request: ChecklistRequest) -> dict[str, Any]:
    """A new checklist at version 1, unlocked. With `based_on` it is a copy: this is how the locked
    official checklist is "edited"."""
    draft, warnings = _draft(request)
    for _ in range(_ID_ATTEMPTS - 1):
        try:
            return _saved(_save_as_new_checklist(draft), warnings)
        except ApiError as exc:
            if exc.code != "version_exists":
                raise
            # that id is taken (a one-in-16-million draw): try another
    return _saved(_save_as_new_checklist(draft), warnings)  # the last attempt may fail for real


@router.post("/checklists/{checklist_id}/versions", status_code=201)
def create_checklist_version(checklist_id: str, request: ChecklistRequest) -> dict[str, Any]:
    """The next version (latest + 1) of an unlocked checklist. Without a `based_on` key in the body
    it keeps the previous version's; `"based_on": null` clears it."""
    draft, warnings = _draft(request)
    inherit = "based_on" not in request.checklist.model_fields_set
    return _saved(store.append_checklist_version(checklist_id, draft, inherit_based_on=inherit), warnings)
