"""Checklist helpers: criterion fingerprints and the checklist files that seed the database.

Shared names (shared-interfaces.md): `criterion_fingerprint`, `load_seed`. The checklist endpoints
(app/routes/checklists.py) build on the editing rules here: `with_fingerprints`,
`validate_checklist`, `weight_warnings` and the id helpers `slug` and `new_checklist_id`.

A checklist file (`checklists/*.json`) is a `ChecklistVersion` without fingerprints: they are
derived data, computed here on load, so the files never carry a stale one. Web (stream A) computes
the same fingerprint in `fingerprint.js`; the test vector in tests/app/test_checklists_seed.py
is the shared contract.
"""

import hashlib
import json
import logging
import re
import secrets
import unicodedata
from decimal import Decimal
from pathlib import Path
from typing import Any

from app.errors import ApiError
from app.models import ChecklistVersion, Criterion
from app.store import get_checklist_version, save_checklist_version

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]  # backend/app/checklists.py -> the repo root
OFFICIAL_SEED = REPO_ROOT / "checklists" / "official-chat-v1.json"  # stream A; the default checklist
CALLS_SEED = REPO_ROOT / "checklists" / "calls_v1.json"  # stream D; optional

# The fields a fingerprint covers. Not weight, order, model, id, section_id or the fingerprint
# itself: changing those does not change what the criterion asks, so a stored judgment stays valid.
_REQUIRED_FIELDS = ("title", "wording", "answer_type", "na_allowed")


def criterion_fingerprint(c: Criterion | dict[str, Any]) -> str:
    """sha256 hex of the canonical JSON of the fields that define what a criterion asks:
    title, wording, answer_type, scale_steps (value and label), na_allowed, na_condition, kind,
    kinds and guidance.

    Canonical JSON is sorted keys, no spaces and non-ASCII kept as is, hashed as UTF-8. A dict may
    leave out the fields `Criterion` defaults (scale_steps, na_condition, kind, kinds, guidance);
    one that lacks title, wording, answer_type or na_allowed is a ValueError."""
    data = c.model_dump() if isinstance(c, Criterion) else c
    missing = [name for name in _REQUIRED_FIELDS if name not in data]
    if missing:
        raise ValueError(f"cannot fingerprint a criterion without {', '.join(missing)}")
    subset = {
        "title": data["title"],
        "wording": data["wording"],
        "answer_type": data["answer_type"],
        "scale_steps": [
            {"value": step["value"], "label": step["label"]} for step in data.get("scale_steps") or []
        ],
        "na_allowed": data["na_allowed"],
        "na_condition": data.get("na_condition"),
        "kind": data.get("kind", "scored"),
        "kinds": list(data.get("kinds") or []),
        "guidance": data.get("guidance"),
    }
    canonical = json.dumps(subset, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def with_fingerprints(v: ChecklistVersion) -> ChecklistVersion:
    """The version with every criterion's fingerprint computed from the criterion as validated
    (`na_allowed: 0` is already False, a step value `5.0` already 5). A fingerprint that came with
    the data is replaced: the server is the only source of fingerprints."""
    criteria = [c.model_copy(update={"fingerprint": criterion_fingerprint(c)}) for c in v.criteria]
    return v.model_copy(update={"criteria": criteria})


def load_checklist_file(path: Path) -> ChecklistVersion:
    """Read a checklist file: every criterion's fingerprint is computed (one in the file is
    replaced) and the id is `"{checklist_id}:{version}"`. `locked` is as the file says, False
    when it says nothing. Invalid JSON, a file that is not a checklist, or one that breaks the
    editing rules of `validate_checklist` (the API's rules: a weight that cannot be stored would
    make every later read of the checklists fail) raises ValueError."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.name}: expected a JSON object")
    data.pop("id", None)  # derived from checklist_id and version by ChecklistVersion
    criteria = data.get("criteria")
    if isinstance(criteria, list):
        for criterion in criteria:
            if isinstance(criterion, dict):
                criterion["fingerprint"] = ""  # a placeholder: the real one needs the typed criterion
    version = ChecklistVersion.model_validate(data)
    errors = validate_checklist(version)
    if errors:
        raise ValueError(f"{path.name}: {'; '.join(errors)}")
    return with_fingerprints(version)


def load_seed(path: Path) -> ChecklistVersion:
    """The official checklist (`checklists/official-chat-v1.json`), id `official-chat:1`."""
    return load_checklist_file(path)


def _insert_if_missing(path: Path) -> None:
    version = load_checklist_file(path)
    if get_checklist_version(version.checklist_id, version.version) is not None:
        return
    try:
        save_checklist_version(version)
    except ApiError as exc:
        # Another process seeded between our check and our insert: that is the same outcome.
        if exc.code != "version_exists":
            raise
        return
    logger.info("Seeded checklist %s from %s", version.id, path.name)


def _later_official_versions() -> list[Path]:
    """Later published versions of the official checklist next to OFFICIAL_SEED
    (`official-chat-v2.json`, ...), oldest first. A changed interpretation is a new immutable
    version, never an edit of v1 (#25 added v2 with the team guidance)."""
    found = []
    for path in OFFICIAL_SEED.parent.glob("official-chat-v*.json"):
        match = re.fullmatch(r"official-chat-v(\d+)\.json", path.name)
        if match and int(match[1]) > 1:
            found.append((int(match[1]), path))
    return [path for _, path in sorted(found)]


def seed_files() -> list[Path]:
    """The checklist files that ship with the repo and exist now, in the order they are seeded:
    the official chat checklist, its later versions, then stream D's calls checklist."""
    paths = [OFFICIAL_SEED, *_later_official_versions(), CALLS_SEED]
    return [path for path in paths if path.is_file()]


def seed_into_db() -> None:
    """Insert the checklists that ship as files (`seed_files`), each only when its
    (checklist_id, version) is not stored yet.

    Never changes a stored version, so it is safe on every startup. The official seed missing is a
    warning, not an error (CI and early development run without it). A file that exists but is
    not a valid checklist raises: a broken seed must not be silently dropped."""
    if not OFFICIAL_SEED.is_file():
        logger.warning("Official checklist seed %s not found; not seeding it.", OFFICIAL_SEED)
    for path in seed_files():
        _insert_if_missing(path)


# --- editing rules -------------------------------------------------------------------------


MAX_WEIGHT = Decimal(1000)


def validate_checklist(v: ChecklistVersion) -> list[str]:
    """Every reason this version cannot be saved, in the order found; empty when it is fine.

    No name (blank after trimming) or no criterion; duplicate criterion or section ids; a criterion
    in an unknown section; a scale without steps, with duplicate or negative step values or with a
    top step that is not above 0 (scoring divides by it); a gross-error criterion with a weight
    other than 0; a weight that is not a finite number from 0 to 1000 or that does not survive a
    float round trip (the JSON carries weights as floats: an infinite one is stored as null and
    then no read of the checklists works). Weights that do not sum to 100 are not an error (see
    `weight_warnings`). The caller raises `ApiError(422, "invalid_checklist", "; ".join(errors))`."""
    errors: list[str] = []
    if not v.name.strip():
        errors.append("the checklist needs a name")
    if not v.criteria:
        errors.append("the checklist needs at least one criterion")

    section_ids: set[str] = set()
    for section in v.sections:
        if section.id in section_ids:
            errors.append(f"duplicate section id {section.id!r}")
        section_ids.add(section.id)

    criterion_ids: set[str] = set()
    for c in v.criteria:
        if c.id in criterion_ids:
            errors.append(f"duplicate criterion id {c.id!r}")
        criterion_ids.add(c.id)
        if c.section_id not in section_ids:
            errors.append(f"criterion {c.id!r}: unknown section {c.section_id!r}")
        weight_error = _weight_error(c.weight)
        if weight_error:
            errors.append(f"criterion {c.id!r}: {weight_error}")
        elif c.kind == "gross_error" and c.weight != 0:
            errors.append(f"criterion {c.id!r}: a gross_error criterion must have weight 0")
        if c.answer_type == "scale":
            errors.extend(_scale_errors(c))
    return errors


def _weight_error(weight: Decimal) -> str | None:
    # Finiteness first: ordering comparisons with a NaN raise instead of answering.
    if not weight.is_finite():
        return "weight must be a finite number"
    if weight < 0:
        return "weight must not be negative"
    if weight > MAX_WEIGHT:
        return f"weight must not be above {MAX_WEIGHT}"
    if Decimal(str(float(weight))) != weight:  # float() of a value this small cannot overflow
        return "weight must survive a float round trip (at most 15 significant digits)"
    return None


def _scale_errors(c: Criterion) -> list[str]:
    if not c.scale_steps:
        return [f"criterion {c.id!r}: a scale needs scale_steps"]
    errors: list[str] = []
    seen: set[int] = set()
    for step in c.scale_steps:
        if step.value in seen:
            errors.append(f"criterion {c.id!r}: duplicate scale step value {step.value}")
        seen.add(step.value)
    if min(seen) < 0:
        errors.append(f"criterion {c.id!r}: scale step values must not be negative")
    if max(seen) <= 0:
        errors.append(f"criterion {c.id!r}: the top scale step must be above 0")
    return errors


def weight_warnings(v: ChecklistVersion) -> list[str]:
    """`["weights_sum_<n>"]` when the scored weights do not add up to 100, else `[]`. Never an
    error: scoring rescales to 100 whatever the sum is (the user's decision), so the editor only
    shows the sum. `<n>` is the sum without trailing zeros: "102", "99.5"."""
    total = sum((c.weight for c in v.criteria if c.kind == "scored"), Decimal(0))
    if total == 100:
        return []
    return [f"weights_sum_{format(total.normalize(), 'f')}"]


# --- ids -----------------------------------------------------------------------------------

_SLUG_MAX_LENGTH = 40
_SLUG_FALLBACK = "checklist"

# Russian and Kazakh Cyrillic to Latin (a plain, readable scheme, not a standard: the result is
# only an id). The hard and soft signs are dropped.
_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "yo", "ж": "zh", "з": "z",
    "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r",
    "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh",
    "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "ә": "a", "ғ": "g", "қ": "k", "ң": "n", "ө": "o", "ұ": "u", "ү": "u", "һ": "h", "і": "i",
}  # fmt: skip
_NOT_ALNUM = re.compile(r"[^a-z0-9]+")


def slug(name: str) -> str:
    """A checklist name as an ASCII id part: lowercase, Cyrillic (Russian and Kazakh letters)
    transliterated, accents dropped, every run of other characters one "-", no "-" at either end,
    at most 40 characters; "checklist" when nothing is left (an empty or non-Latin-script name)."""
    lowered = name.lower()
    latin = "".join(_TRANSLIT.get(ch, ch) for ch in lowered)
    ascii_only = unicodedata.normalize("NFKD", latin).encode("ascii", "ignore").decode("ascii")
    cut = _NOT_ALNUM.sub("-", ascii_only).strip("-")[:_SLUG_MAX_LENGTH].strip("-")
    return cut or _SLUG_FALLBACK


def new_checklist_id(name: str) -> str:
    """`slug(name)` + "-" + 6 random hex characters: `"chek-list-kachestva-chatov-3fa9c1"`."""
    return f"{slug(name)}-{secrets.token_hex(3)}"
