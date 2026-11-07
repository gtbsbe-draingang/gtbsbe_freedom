"""The results snapshot: what the repo ships so that a jury machine shows results without a model key.

`export_snapshot` writes every stored result of this backend (B's tables) to one JSON file;
`import_snapshot` loads such a file into an empty database. `cqa-serve` does the import on a first
start, `cqa-snapshot` the export (app/cli.py).

What is in the file (`format: 1`), each part a list of rows:

* `conversations`: the conversation with its row columns, without the `audio_url` column (the
  organisers' signed recording link, a secret that is never committed). A voice call comes back as
  `audio: null` with the reason `needs_import`; importing its group from the organisers' API with
  the jury's own URL brings the link, and the playback, back.
* `checklists`: every checklist version.
* `evaluations`: the `done` ones. Queued, running and failed evaluations belong to jobs, which are
  not exported (`jobs` is always `[]`), so they would be orphans.
* `appeals`: every appeal with the criterion fingerprint and graded transcript hash that
  carry-forward matches on, so decisions still carry over after a restore.
* `judgments`: the judgment cache, so re-applying a checklist whose results are stored needs no
  model call (and no key).

The other streams' tables (C's and D's) are not exported. Each row keeps its table columns as
they are, and the JSON column as a nested object under its own key (`conversation`, `checklist`,
`evaluation`, `appeal`, `judgment`).

No signed URL may be in the file, and none is: the text is checked (`assert_no_signed_urls`) before
anything is written, and again before anything is loaded. The check is blunt on purpose: any
`sig=` or `audio_url`, anywhere, refuses the export, even one a transcript merely mentions. A refusal
names the part and the row (`conversations[3]`), never the text.

The checklists that ship as files (`checklists/*.json`) are seeded by `cqa-serve` before the import,
and the import keeps a version that is already stored. A locked version never changes, so any
difference in its content under the same id and version makes it another checklist: stored totals,
reuse keys and appeal fingerprints would not match what a fresh machine seeds and shows. So the
export refuses a database whose seeded version differs from its seed file in anything that is scored
or shown (`SnapshotError`, nothing written), and the import logs a warning when the snapshot's copy
of a version it skips differs from the stored one. Only storage metadata (`created_at`) is ignored.
"""

import json
import logging
import os
import sqlite3
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from app import store
from app.checklists import load_checklist_file, seed_files
from app.db import connect
from app.models import Appeal, ChecklistVersion, Conversation, Evaluation, Judgment

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]  # backend/app/snapshot.py -> the repo root
SNAPSHOT = REPO_ROOT / "data" / "snapshot" / "cqa-snapshot.json"
FORMAT = 1

_SIGNED_URL_MARKERS = ("sig=", "audio_url")
_MAX_LISTED_PROBLEMS = 3


class SnapshotError(ValueError):
    """The snapshot cannot be written or loaded. The message never repeats the data."""


def assert_no_signed_urls(text: str) -> None:
    """Raise SnapshotError (a ValueError) when `text` holds `sig=` (any case) or `audio_url`.

    The message names the marker, never the text around it."""
    lowered = text.lower()
    for marker in _SIGNED_URL_MARKERS:
        if marker in lowered:
            raise SnapshotError(
                f"The text contains {marker!r}, which marks a signed URL. "
                "Signed URLs must never be written to the snapshot."
            )


# --- what is exported ----------------------------------------------------------------------


def _content(version: ChecklistVersion, locked: bool) -> dict[str, Any]:
    """Everything of a checklist version that is scored or shown, as plain data to compare: every
    version field (name, sections and their order, guidance, `based_on`, ...) and every criterion
    field (weight, wording, scale steps, N/A rules, fingerprint, ...). Only storage metadata,
    `created_at`, is left out. `locked` is the column's value, which is the authoritative one (the
    JSON's copy can be older, see store.get_checklist_version)."""
    return version.model_copy(update={"locked": bool(locked)}).model_dump(exclude={"created_at"})


@dataclass(frozen=True)
class Table:
    key: str  # the part of the snapshot
    table: str
    columns: tuple[str, ...]  # exported as they are
    json_column: str  # exported as a nested object, under `json_key`
    json_key: str
    model: type[BaseModel]  # what the JSON column is checked against on import
    order: str  # makes the file the same every time
    where: str = ""  # which rows are exported
    skip_if_present: tuple[str, ...] = ()  # columns that identify a row that is not inserted twice
    replace: bool = False  # a row with the same key replaces the stored one
    # Called when a row is skipped because it is stored already: (connection, the row's columns
    # by name, the row's JSON).
    on_present: Callable[[sqlite3.Connection, dict[str, Any], str], None] | None = None


def _voice_call_without_audio(conversation: Conversation) -> Conversation:
    """A voice call has no recording link here: its audio is the import's to bring back."""
    if conversation.channel != "voice call":
        return conversation
    return conversation.model_copy(update={"audio": None, "audio_unavailable_reason": "needs_import"})


_RESTORE: dict[str, Callable[[Any], Any]] = {"conversations": _voice_call_without_audio}


def _warn_if_checklist_differs(conn: sqlite3.Connection, row: dict[str, Any], payload: str) -> None:
    """A checklist version the snapshot holds is stored already (the seeded one wins). Warn when
    the two differ in anything scored or shown (`_content`). Names the checklist and version,
    nothing else."""
    stored = conn.execute(
        "SELECT json, locked FROM checklist_versions WHERE checklist_id = ? AND version = ?",
        (row["checklist_id"], row["version"]),
    ).fetchone()
    try:
        same = _content(ChecklistVersion.model_validate_json(stored["json"]), stored["locked"]) == _content(
            ChecklistVersion.model_validate_json(payload), row["locked"]
        )
    except ValidationError:
        same = False
    if not same:
        logger.warning(
            "The seeded checklist %s version %s differs from the snapshot's copy. The seeded one is kept, "
            "so the snapshot's stored totals, reuse keys and appeal fingerprints may not match it. "
            "Export the snapshot again from a fresh database.",
            row["checklist_id"], row["version"],
        )  # fmt: skip


# In the order they are loaded.
TABLES: tuple[Table, ...] = (
    Table(
        "checklists", "checklist_versions",
        ("checklist_id", "version", "locked", "created_at"), "json", "checklist", ChecklistVersion,
        order="rowid", skip_if_present=("checklist_id", "version"), on_present=_warn_if_checklist_differs,
    ),
    Table(
        "conversations", "conversations",
        ("id", "group_id", "conversation_id", "channel", "language", "transcript_hash", "created_at", "updated_at"),
        "conversation_json", "conversation", Conversation, order="id",
    ),
    Table(
        "evaluations", "evaluations",
        ("id", "conversation", "checklist_id", "version", "status", "created_at"), "json", "evaluation", Evaluation,
        order="created_at, id", where="status = 'done'",
    ),
    Table(
        "appeals", "appeals",
        (
            "id", "evaluation_id", "conversation", "criterion_id", "fingerprint", "transcript_hash",
            "status", "created_at", "decided_at",
        ),
        "json", "appeal", Appeal, order="created_at, rowid",
    ),
    Table(
        "judgments", "judgments",
        ("reuse_key", "criterion_id", "created_at"), "json", "judgment", Judgment,
        order="reuse_key", replace=True,
    ),
)  # fmt: skip

# Stored columns that are deliberately not exported (the guard test checks every other column is).
NOT_EXPORTED: dict[str, tuple[str, ...]] = {"conversations": ("audio_url",)}


def row_count(document: dict) -> int:
    """The number of rows in a snapshot document."""
    return sum(len(document[table.key]) for table in TABLES)


# --- export --------------------------------------------------------------------------------


def _dump(conn: sqlite3.Connection, table: Table) -> list[dict[str, Any]]:
    selected = ", ".join((*table.columns, table.json_column))
    where = f" WHERE {table.where}" if table.where else ""
    found = conn.execute(f"SELECT {selected} FROM {table.table}{where} ORDER BY {table.order}").fetchall()
    result = []
    for row in found:
        item = {column: row[column] for column in table.columns}
        item[table.json_key] = json.loads(row[table.json_column])
        result.append(item)
    return result


def _write_atomically(path: Path, text: str) -> None:
    """Write `text` to `path` through a temporary file in the same folder, so a reader (or a crash)
    sees the old file or the new one, never half of one. No temporary file is left behind."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
        os.chmod(temp_name, 0o644)  # mkstemp makes it private; this is a file for a repo
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def _check_seeded_checklists(exported: list[dict[str, Any]]) -> None:
    """Refuse (SnapshotError) when a seeded checklist version in the database differs from the one
    its seed file builds in anything that is scored or shown (`_content`). A version the database
    lacks is not compared. The message names the checklist, version and seed file, not the difference."""
    stored = {(row["checklist_id"], row["version"]): row for row in exported}
    for path in seed_files():
        try:
            seeded = load_checklist_file(path)
        except (ValueError, OSError) as exc:
            raise SnapshotError(
                f"The seed file {path.name} cannot be checked against the database ({type(exc).__name__}), "
                "so the snapshot was not written."
            ) from None
        row = stored.get((seeded.checklist_id, seeded.version))
        if row is None:
            continue
        try:
            same = _content(ChecklistVersion.model_validate(row["checklist"]), row["locked"]) == _content(
                seeded, seeded.locked
            )
        except ValidationError:
            same = False
        if not same:
            raise SnapshotError(
                f"The seeded checklist {seeded.checklist_id} version {seeded.version} in the database differs "
                f"from its seed file {path.name}. A fresh machine seeds the file's version and keeps it, so "
                "the stored results in the snapshot would not match it. "
                "Start from a fresh database, run the evaluations again, then export."
            )


def _check_rows_for_signed_urls(document: dict[str, Any]) -> None:
    """The same check as the whole text gets, one row at a time, so a refusal can say where the
    problem is. The whole-text check still runs after this one: it covers everything."""
    for table in TABLES:
        for i, row in enumerate(document[table.key]):
            try:
                assert_no_signed_urls(json.dumps(row, ensure_ascii=False))
            except SnapshotError as exc:
                raise SnapshotError(f"{table.key}[{i}]: {exc}") from None


def export_snapshot(path: Path) -> dict:
    """Write the snapshot of the current database to `path` and return the document written.

    Sorted keys, `ensure_ascii=False`, indent 1. Two things refuse the export (SnapshotError):
    a seeded checklist version that differs from its seed file, and a signed URL anywhere in the
    text (the message names the part and the row, never the text). The checks run before anything
    is written: on a refusal nothing is written (an existing file stays as it is)."""
    conn = connect()
    try:
        conn.execute("BEGIN")  # one read snapshot, so every part describes the same moment
        document: dict[str, Any] = {"format": FORMAT, **{t.key: _dump(conn, t) for t in TABLES}, "jobs": []}
    finally:
        conn.close()
    _check_seeded_checklists(document["checklists"])
    _check_rows_for_signed_urls(document)
    text = json.dumps(document, sort_keys=True, ensure_ascii=False, indent=1) + "\n"
    assert_no_signed_urls(text)
    _write_atomically(Path(path), text)
    logger.info("Wrote snapshot %s (%d rows)", path, row_count(document))
    return document


# --- import --------------------------------------------------------------------------------


def has_conversations() -> bool:
    conn = connect()
    try:
        return conn.execute("SELECT 1 FROM conversations LIMIT 1").fetchone() is not None
    finally:
        conn.close()


def _describe(exc: ValidationError) -> str:
    # Field names and rules only: the offending value is left out.
    errors = exc.errors(include_input=False, include_url=False, include_context=False)
    shown = errors[:_MAX_LISTED_PROBLEMS]
    return "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in shown)


def _rows(document: dict, table: Table) -> list[dict[str, Any]]:
    items = document.get(table.key)
    if not isinstance(items, list):
        raise SnapshotError(f"{table.key}: expected a list.")
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise SnapshotError(f"{table.key}[{i}]: expected an object.")
        missing = [name for name in (*table.columns, table.json_key) if name not in item]
        if missing:
            raise SnapshotError(f"{table.key}[{i}]: missing {', '.join(missing)}.")
        if any(isinstance(item[column], dict | list) for column in table.columns):
            raise SnapshotError(f"{table.key}[{i}]: a column holds an object or a list.")
    return items


def _check_references(document: dict) -> None:
    conversations = {row["id"] for row in document["conversations"]}
    for i, row in enumerate(document["evaluations"]):
        if row["conversation"] not in conversations:
            raise SnapshotError(f"evaluations[{i}]: its conversation is not in the snapshot.")
    evaluations = {row["id"] for row in document["evaluations"]}
    for i, row in enumerate(document["appeals"]):
        if row["evaluation_id"] not in evaluations:
            raise SnapshotError(f"appeals[{i}]: its evaluation is not in the snapshot.")


def _prepare(text: str) -> list[tuple[Table, list[tuple[tuple, str]]]]:
    """Check the whole file and turn it into rows to insert: (column values, JSON text) per table.
    Nothing is written here."""
    try:
        document = json.loads(text)
    except ValueError:
        raise SnapshotError("The snapshot is not valid JSON.") from None
    if not isinstance(document, dict):
        raise SnapshotError("The snapshot must be a JSON object.")
    if document.get("format") != FORMAT:
        raise SnapshotError(f"Unsupported snapshot format (this version reads format {FORMAT}).")
    rows = {table.key: _rows(document, table) for table in TABLES}
    _check_references(rows)

    prepared = []
    for table in TABLES:
        restore = _RESTORE.get(table.key)
        items = []
        for i, item in enumerate(rows[table.key]):
            try:
                model = table.model.model_validate_json(json.dumps(item[table.json_key], ensure_ascii=False))
            except ValidationError as exc:
                raise SnapshotError(f"{table.key}[{i}]: {_describe(exc)}") from None
            payload = (restore(model) if restore else model).model_dump_json()
            items.append((tuple(item[column] for column in table.columns), payload))
        prepared.append((table, items))
    return prepared


def _require_empty(conn: sqlite3.Connection) -> None:
    for noun in ("conversations", "evaluations", "appeals"):
        if conn.execute(f"SELECT 1 FROM {noun} LIMIT 1").fetchone() is not None:
            raise SnapshotError(
                f"A snapshot can only be loaded into an empty database, and this one already has {noun}."
            )


def _insert(conn: sqlite3.Connection, table: Table, items: list[tuple[tuple, str]]) -> int:
    columns = (*table.columns, table.json_column)
    verb = "INSERT OR REPLACE" if table.replace else "INSERT"
    insert = f"{verb} INTO {table.table} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})"
    present = (
        f"SELECT 1 FROM {table.table} WHERE " + " AND ".join(f"{c} = ?" for c in table.skip_if_present)
        if table.skip_if_present
        else None
    )
    key_positions = [table.columns.index(c) for c in table.skip_if_present]
    inserted = 0
    for values, payload in items:
        if present is not None and conn.execute(present, [values[i] for i in key_positions]).fetchone():
            if table.on_present is not None:
                table.on_present(conn, dict(zip(table.columns, values)), payload)
            continue  # e.g. the seeded official checklist: it stays as it is
        try:
            conn.execute(insert, (*values, payload))
        except (sqlite3.IntegrityError, sqlite3.ProgrammingError, OverflowError):
            # The database's message may quote values; this one does not.
            raise SnapshotError(f"{table.key}: a row conflicts with another or has an unusable value.") from None
        inserted += 1
    return inserted


def import_snapshot(path: Path) -> int:
    """Load the snapshot at `path` into the current database and return the number of rows inserted.

    Only into a database without conversations, evaluations and appeals (SnapshotError, a
    ValueError, otherwise). The whole file is checked first and the rows go in as one transaction:
    on any error nothing is stored. Checklist versions that are already stored (the seeded official
    one) are skipped, not duplicated and not counted; the seeded one stays authoritative, and a
    warning names it when the snapshot's copy differs in anything scored or shown. Voice calls come
    back without audio, with the reason `needs_import`. The schema must already be migrated
    (`app.db.migrate`)."""
    text = Path(path).read_text(encoding="utf-8")
    assert_no_signed_urls(text)
    prepared = _prepare(text)
    with store.write_transaction() as conn:
        _require_empty(conn)
        inserted = sum(_insert(conn, table, items) for table, items in prepared)
    logger.info("Loaded snapshot %s (%d rows)", path, inserted)
    return inserted
