"""Storage for conversations (the conversation part of app/store.py).

One row per conversation, keyed by `Conversation.id` ("{group_id}:{conversation_id}", so a control
set that reuses a DEV conversation_id is a different conversation). The row keeps the whole
`Conversation` as JSON, plus the columns the app filters and compares on.

`audio_url` is the organisers' signed URL, a secret: it lives in its own column, is never part of
`conversation_json` and is only handed out by `get_audio_url` (to the audio package, never to the
UI).

Checklist versions: one row per (checklist_id, version), the whole `ChecklistVersion` as JSON plus
the `locked` flag as a column (the flag is the part that changes after a version is saved).

Shared names (shared-interfaces.md): `get_conversation`, `get_audio_url`, `save_audio_results`,
`get_checklist_version`, `latest_versions`, `save_checklist_version`.

Evaluation jobs (app/jobs.py): the judgment cache (one row per reuse key, the evaluator's
`Judgment` as JSON), evaluations (the whole `Evaluation` as JSON plus the columns filtered on) and
jobs (the whole `Job` as JSON, items included, plus the checklist version and role it runs with).
Every status change of a job item is one write transaction together with its evaluation, so the
two never disagree and `GET /jobs/{id}` shows progress as it happens.
"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Literal

from app.db import connect, register_migration
from app.errors import ApiError
from app.models import (
    AudioOffset,
    ChecklistVersion,
    Conversation,
    DialogInfo,
    Evaluation,
    Job,
    JobItem,
    JobRetry,
    Judgment,
    Role,
    VoiceMeasurement,
)
from app.transcript import transcript_hash

register_migration(
    "b_001_conversations",
    """
    CREATE TABLE conversations (
        id                TEXT PRIMARY KEY,
        group_id          TEXT NOT NULL,
        conversation_id   TEXT NOT NULL,
        channel           TEXT NOT NULL,
        language          TEXT NOT NULL,
        conversation_json TEXT NOT NULL,
        transcript_hash   TEXT NOT NULL,
        audio_url         TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
    );
    CREATE INDEX conversations_group ON conversations (group_id);
    """,
)

register_migration(
    "b_002_checklist_versions",
    """
    CREATE TABLE checklist_versions (
        checklist_id TEXT NOT NULL,
        version      INTEGER NOT NULL,
        json         TEXT NOT NULL,
        locked       INTEGER NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (checklist_id, version)
    );
    """,
)

register_migration(
    "b_003_judgments",
    """
    CREATE TABLE judgments (
        reuse_key    TEXT PRIMARY KEY,
        criterion_id TEXT NOT NULL,
        json         TEXT NOT NULL,
        created_at   TEXT NOT NULL
    );
    """,
)

register_migration(
    "b_004_evaluations",
    """
    CREATE TABLE evaluations (
        id           TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        checklist_id TEXT NOT NULL,
        version      INTEGER NOT NULL,
        status       TEXT NOT NULL,
        json         TEXT NOT NULL,
        created_at   TEXT NOT NULL
    );
    CREATE INDEX evaluations_conversation ON evaluations (conversation, created_at);
    CREATE INDEX evaluations_checklist ON evaluations (checklist_id, version, status);
    """,
)

register_migration(
    "b_005_jobs",
    """
    CREATE TABLE jobs (
        id           TEXT PRIMARY KEY,
        checklist_id TEXT NOT NULL,
        version      INTEGER NOT NULL,
        role         TEXT NOT NULL,
        status       TEXT NOT NULL,
        json         TEXT NOT NULL,
        created_at   TEXT NOT NULL
    );
    CREATE INDEX jobs_status ON jobs (status);
    """,
)

# Checklist version numbers are small positive integers. The bound keeps a huge number from
# reaching SQLite, which raises OverflowError for an integer beyond 64 bits.
MAX_CHECKLIST_VERSION = 2**31 - 1

UpsertOutcome = Literal["imported", "updated", "unchanged"]


def _now() -> datetime:
    return datetime.now(UTC)


def _stamp(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


@contextmanager
def write_transaction() -> Iterator[sqlite3.Connection]:
    """A connection inside one write transaction: committed when the block ends, rolled back when
    it raises. BEGIN IMMEDIATE takes the write lock first, so a read-then-write inside the block
    cannot interleave with another writer."""
    conn = connect()
    try:
        conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
        except BaseException:
            conn.rollback()
            raise
        conn.commit()
    finally:
        conn.close()


def _read_conversation(conversation_json: str) -> Conversation:
    return Conversation.model_validate_json(conversation_json)


def upsert_conversation(
    conv: Conversation, audio_url: str | None, *, conn: sqlite3.Connection | None = None
) -> UpsertOutcome:
    """Store a conversation.

    "imported" for a new id. "updated" when the transcript hash changed: the stored conversation is
    replaced (status back to "new", audio results dropped, because they described the old
    transcript). "unchanged" otherwise: nothing but the audio link is touched.

    `created_at` is set on insert (UTC) and kept afterwards; `updated_at` moves with every write.
    A stored `audio_url` is kept when `audio_url` is None, and so are the conversation's `audio`
    fields that go with it. A new `audio_url` replaces the stored one; when it arrives for a
    conversation that had none (the committed snapshot has no links) the `audio` fields are filled
    in, even if the transcript is unchanged.

    With `conn` the caller owns the transaction (see `write_transaction`); without it the call is
    its own transaction.
    """
    if conn is None:
        with write_transaction() as own:
            return upsert_conversation(conv, audio_url, conn=own)

    now = _now().replace(microsecond=0)  # whole seconds: the column and the JSON hold the same value
    new_hash = transcript_hash(conv.transcript)
    row = conn.execute(
        "SELECT conversation_json, transcript_hash, audio_url, created_at "
        "FROM conversations WHERE id = ?",
        (conv.id,),
    ).fetchone()

    if row is None:
        stored = conv.model_copy(update={"created_at": now})
        conn.execute(
            "INSERT INTO conversations (id, group_id, conversation_id, channel, language, "
            "conversation_json, transcript_hash, audio_url, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                conv.id, conv.group_id, conv.conversation_id, conv.channel, conv.language,
                stored.model_dump_json(), new_hash, audio_url, _stamp(now), _stamp(now),
            ),
        )  # fmt: skip
        return "imported"

    previous = _read_conversation(row["conversation_json"])
    has_new_url = audio_url is not None
    # The audio fields describe the audio_url that is kept, so they come from the same side.
    audio_fields = {
        "audio": conv.audio if has_new_url else previous.audio,
        "audio_unavailable_reason": (
            conv.audio_unavailable_reason if has_new_url else previous.audio_unavailable_reason
        ),
    }

    if new_hash != row["transcript_hash"]:
        # created_at is kept exactly: the stored conversation's value, written to the column as well.
        created = previous.created_at or datetime.fromisoformat(row["created_at"])
        stored = conv.model_copy(update={"created_at": created, **audio_fields})
        conn.execute(
            "UPDATE conversations SET channel = ?, language = ?, conversation_json = ?, "
            "transcript_hash = ?, audio_url = ?, created_at = ?, updated_at = ? WHERE id = ?",
            (
                conv.channel, conv.language, stored.model_dump_json(), new_hash,
                audio_url if has_new_url else row["audio_url"], _stamp(created), _stamp(now), conv.id,
            ),
        )  # fmt: skip
        return "updated"

    if has_new_url and audio_url != row["audio_url"]:
        stored = previous.model_copy(update=audio_fields)
        conn.execute(
            "UPDATE conversations SET conversation_json = ?, audio_url = ?, updated_at = ? "
            "WHERE id = ?",
            (stored.model_dump_json(), audio_url, _stamp(now), conv.id),
        )
    return "unchanged"


def get_conversation(conversation: str) -> Conversation | None:
    """The conversation with this `Conversation.id`, or None. `created_at` is always set."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT conversation_json FROM conversations WHERE id = ?", (conversation,)
        ).fetchone()
    finally:
        conn.close()
    return None if row is None else _read_conversation(row["conversation_json"])


def get_audio_url(conversation: str) -> str | None:
    """The organisers' signed audio URL (private: never send it to the UI, never log it)."""
    conn = connect()
    try:
        row = conn.execute("SELECT audio_url FROM conversations WHERE id = ?", (conversation,)).fetchone()
    finally:
        conn.close()
    return None if row is None else row["audio_url"]


def save_audio_results(
    conversation: str, offsets: list[AudioOffset], measurements: list[VoiceMeasurement]
) -> None:
    """Store a call's `audio_offsets` and `voice_measurements` in its `conversation_json`.

    Raises LookupError for an unknown conversation."""
    with write_transaction() as conn:
        row = conn.execute(
            "SELECT conversation_json FROM conversations WHERE id = ?", (conversation,)
        ).fetchone()
        if row is None:
            raise LookupError(f"unknown conversation {conversation!r}")
        updated = _read_conversation(row["conversation_json"]).model_copy(
            update={"audio_offsets": offsets, "voice_measurements": measurements}
        )
        conn.execute(
            "UPDATE conversations SET conversation_json = ?, updated_at = ? WHERE id = ?",
            (updated.model_dump_json(), _stamp(_now()), conversation),
        )


def _read_checklist_version(json_text: str, locked: int) -> ChecklistVersion:
    # The column is authoritative for `locked`: it is the part that changes after a save.
    stored = ChecklistVersion.model_validate_json(json_text)
    return stored.model_copy(update={"locked": bool(locked)})


def get_checklist_version(checklist_id: str, version: int) -> ChecklistVersion | None:
    """The stored checklist version, or None (also for a number outside 1..MAX_CHECKLIST_VERSION,
    which cannot exist). `created_at` is always set; `locked` is the column's current value."""
    if not 1 <= version <= MAX_CHECKLIST_VERSION:
        return None
    conn = connect()
    try:
        row = conn.execute(
            "SELECT json, locked FROM checklist_versions WHERE checklist_id = ? AND version = ?",
            (checklist_id, version),
        ).fetchone()
    finally:
        conn.close()
    return None if row is None else _read_checklist_version(row["json"], row["locked"])


def list_checklists() -> list[tuple[ChecklistVersion, list[int]]]:
    """The latest version of every checklist with all its version numbers (ascending), oldest
    checklist first (the order its first version was stored: the seeds, then the user's). Both
    queries read one snapshot, so the numbers always end with the version returned."""
    conn = connect()
    try:
        conn.execute("BEGIN")  # a read snapshot: a save between the two queries stays invisible
        latest = conn.execute(
            "SELECT cv.json, cv.locked "
            "FROM checklist_versions cv "
            "JOIN (SELECT checklist_id, MAX(version) AS version, MIN(rowid) AS first_row "
            "      FROM checklist_versions GROUP BY checklist_id) newest "
            "  ON newest.checklist_id = cv.checklist_id AND newest.version = cv.version "
            "ORDER BY newest.first_row"
        ).fetchall()
        numbers: dict[str, list[int]] = {}
        for row in conn.execute("SELECT checklist_id, version FROM checklist_versions ORDER BY version"):
            numbers.setdefault(row["checklist_id"], []).append(row["version"])
    finally:
        conn.close()
    result = []
    for row in latest:
        version = _read_checklist_version(row["json"], row["locked"])
        result.append((version, numbers[version.checklist_id]))
    return result


def latest_versions() -> list[ChecklistVersion]:
    """The latest version of every checklist, oldest checklist first. `locked` is read like
    `get_checklist_version` reads it."""
    return [version for version, _ in list_checklists()]


def _insert_checklist_version(conn: sqlite3.Connection, v: ChecklistVersion) -> ChecklistVersion:
    created = v.created_at or _now().replace(microsecond=0)
    stored = v.model_copy(update={"id": f"{v.checklist_id}:{v.version}", "created_at": created})
    conn.execute(
        "INSERT INTO checklist_versions (checklist_id, version, json, locked, created_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (v.checklist_id, v.version, stored.model_dump_json(), int(v.locked), _stamp(created)),
    )
    return stored


def save_checklist_version(v: ChecklistVersion) -> ChecklistVersion:
    """Store a new checklist version and return it as stored: `created_at` is filled with the
    current UTC time when missing, `id` is `"{checklist_id}:{version}"`.

    A stored version is never overwritten (editing a checklist makes a new version): an existing
    (checklist_id, version) raises ApiError(409, "version_exists")."""
    with write_transaction() as conn:
        if conn.execute(
            "SELECT 1 FROM checklist_versions WHERE checklist_id = ? AND version = ?",
            (v.checklist_id, v.version),
        ).fetchone():
            raise ApiError(
                409,
                "version_exists",
                f"Checklist {v.checklist_id!r} version {v.version} already exists; "
                "save the changes as a new version.",
            )
        return _insert_checklist_version(conn, v)


def append_checklist_version(
    checklist_id: str, v: ChecklistVersion, *, inherit_based_on: bool = False
) -> ChecklistVersion:
    """Store `v` as the next version of an existing checklist: its `checklist_id` becomes the one
    given and its `version` the latest stored one + 1 (both of `v` are ignored). Returns it as
    stored. With `inherit_based_on`, `v.based_on` is replaced by the latest version's.

    The latest version is read and the new one inserted in one write transaction, so concurrent
    saves get consecutive numbers instead of colliding. Raises ApiError(404, "not_found") for an
    unknown checklist and ApiError(409, "checklist_locked") when its latest version is locked
    (the column's value)."""
    with write_transaction() as conn:
        latest = conn.execute(
            "SELECT version, locked, json FROM checklist_versions WHERE checklist_id = ? "
            "ORDER BY version DESC LIMIT 1",
            (checklist_id,),
        ).fetchone()
        if latest is None:
            raise ApiError(404, "not_found", f"No checklist {checklist_id!r}.")
        if latest["locked"]:
            raise ApiError(
                409,
                "checklist_locked",
                f"Checklist {checklist_id!r} is locked; save the changes as a new checklist.",
            )
        update: dict[str, object] = {"checklist_id": checklist_id, "version": latest["version"] + 1}
        if inherit_based_on:
            update["based_on"] = ChecklistVersion.model_validate_json(latest["json"]).based_on
        return _insert_checklist_version(conn, v.model_copy(update=update))


# --- conversations: what an evaluation writes back -------------------------------------------


def update_conversation_info(conversation: str, info: DialogInfo, expected_hash: str) -> bool:
    """Store the dialogue info (extra B) the evaluator produced, only while the stored transcript
    is still the one with `expected_hash` (a re-import in the meantime wins). True when written."""
    with write_transaction() as conn:
        row = conn.execute(
            "SELECT conversation_json, transcript_hash FROM conversations WHERE id = ?", (conversation,)
        ).fetchone()
        if row is None or row["transcript_hash"] != expected_hash:
            return False
        updated = _read_conversation(row["conversation_json"]).model_copy(update={"info": info})
        conn.execute(
            "UPDATE conversations SET conversation_json = ?, updated_at = ? WHERE id = ?",
            (updated.model_dump_json(), _stamp(_now()), conversation),
        )
    return True


def mark_conversation_evaluated(conversation: str, expected_hash: str) -> bool:
    """A done evaluation: status "new" becomes "evaluated". "disputed" stays (open appeals are
    still open), and nothing changes when the transcript is no longer the evaluated one."""
    with write_transaction() as conn:
        row = conn.execute(
            "SELECT conversation_json, transcript_hash FROM conversations WHERE id = ?", (conversation,)
        ).fetchone()
        if row is None or row["transcript_hash"] != expected_hash:
            return False
        stored = _read_conversation(row["conversation_json"])
        if stored.status != "new":
            return False
        conn.execute(
            "UPDATE conversations SET conversation_json = ?, updated_at = ? WHERE id = ?",
            (stored.model_copy(update={"status": "evaluated"}).model_dump_json(), _stamp(_now()), conversation),
        )
    return True


# --- judgment cache --------------------------------------------------------------------------

_SQL_CHUNK = 500  # well under SQLite's limit on bound parameters


def get_judgments(reuse_keys: list[str]) -> dict[str, Judgment]:
    """The cached judgments among `reuse_keys`, by reuse key."""
    keys = list(dict.fromkeys(reuse_keys))
    found: dict[str, Judgment] = {}
    conn = connect()
    try:
        for start in range(0, len(keys), _SQL_CHUNK):
            chunk = keys[start : start + _SQL_CHUNK]
            marks = ", ".join("?" * len(chunk))
            for row in conn.execute(
                f"SELECT reuse_key, json FROM judgments WHERE reuse_key IN ({marks})", chunk
            ):
                found[row["reuse_key"]] = Judgment.model_validate_json(row["json"])
    finally:
        conn.close()
    return found


def save_judgment(judgment: Judgment) -> None:
    """Cache a judgment under its reuse key (a newer one for the same key replaces it)."""
    with write_transaction() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO judgments (reuse_key, criterion_id, json, created_at) "
            "VALUES (?, ?, ?, ?)",
            (judgment.reuse_key, judgment.criterion_id, judgment.model_dump_json(), _now().isoformat()),
        )


# --- evaluations -----------------------------------------------------------------------------


def insert_evaluation(ev: Evaluation, *, conn: sqlite3.Connection | None = None) -> None:
    if conn is None:
        with write_transaction() as own:
            return insert_evaluation(ev, conn=own)
    conn.execute(
        "INSERT INTO evaluations (id, conversation, checklist_id, version, status, json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            ev.id, ev.conversation, ev.checklist_id, ev.version, ev.status,
            ev.model_dump_json(), ev.created_at.isoformat(),
        ),
    )  # fmt: skip


def _write_evaluation(conn: sqlite3.Connection, ev: Evaluation) -> None:
    conn.execute(
        "UPDATE evaluations SET status = ?, json = ? WHERE id = ?",
        (ev.status, ev.model_dump_json(), ev.id),
    )


def _read_evaluation(conn: sqlite3.Connection, evaluation_id: str) -> Evaluation | None:
    row = conn.execute("SELECT json FROM evaluations WHERE id = ?", (evaluation_id,)).fetchone()
    return None if row is None else Evaluation.model_validate_json(row["json"])


def get_evaluation(evaluation_id: str) -> Evaluation | None:
    conn = connect()
    try:
        return _read_evaluation(conn, evaluation_id)
    finally:
        conn.close()


def _set_evaluation_status(conn: sqlite3.Connection, evaluation_id: str | None, status: str) -> None:
    """Move an evaluation to `status`, dropping any results it had (a queued, running or failed
    evaluation has none)."""
    if evaluation_id is None:
        return
    ev = _read_evaluation(conn, evaluation_id)
    if ev is None:
        return
    blank = Evaluation(
        id=ev.id, created_at=ev.created_at, conversation=ev.conversation,
        checklist_id=ev.checklist_id, version=ev.version, status=status, source=ev.source,
    )  # fmt: skip
    _write_evaluation(conn, blank)


# --- jobs ------------------------------------------------------------------------------------


def _recount(job: Job) -> Job:
    """`done`, `failed` and `status` from the items. A job is `queued` while nothing has started,
    `running` while anything is queued or running, `failed` when every item failed and `done`
    otherwise (finished; `failed` counts the items that did not make it)."""
    statuses = [item.status for item in job.items]
    done = statuses.count("done")
    failed = statuses.count("failed")
    if statuses and all(s == "queued" for s in statuses):
        status = "queued"
    elif any(s in ("queued", "running") for s in statuses):
        status = "running"
    elif statuses and failed == len(statuses):
        status = "failed"
    else:
        status = "done"
    return job.model_copy(update={"done": done, "failed": failed, "status": status})


def _write_job(conn: sqlite3.Connection, job: Job) -> Job:
    job = _recount(job)
    conn.execute(
        "UPDATE jobs SET status = ?, json = ? WHERE id = ?", (job.status, job.model_dump_json(), job.id)
    )
    return job


def insert_job(
    job: Job, checklist_id: str, version: int, role: Role, *, conn: sqlite3.Connection | None = None
) -> Job:
    """Store a new job (its counts and status recomputed from the items) and return it."""
    if conn is None:
        with write_transaction() as own:
            return insert_job(job, checklist_id, version, role, conn=own)
    job = _recount(job)
    conn.execute(
        "INSERT INTO jobs (id, checklist_id, version, role, status, json, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            job.id, checklist_id, version, role, job.status, job.model_dump_json(),
            job.created_at.isoformat(),
        ),
    )  # fmt: skip
    return job


def create_job(
    job: Job, evaluations: list[Evaluation], checklist_id: str, version: int, role: Role
) -> Job:
    """Store a job and its queued evaluations in one transaction."""
    with write_transaction() as conn:
        for ev in evaluations:
            insert_evaluation(ev, conn=conn)
        return insert_job(job, checklist_id, version, role, conn=conn)


def _read_job(conn: sqlite3.Connection, job_id: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT json, checklist_id, version, role FROM jobs WHERE id = ?", (job_id,)
    ).fetchone()


def get_job(job_id: str) -> Job | None:
    conn = connect()
    try:
        row = _read_job(conn, job_id)
    finally:
        conn.close()
    return None if row is None else Job.model_validate_json(row["json"])


def get_job_checklist(job_id: str) -> tuple[str, int, Role] | None:
    """The checklist id, version and role a job runs with."""
    conn = connect()
    try:
        row = _read_job(conn, job_id)
    finally:
        conn.close()
    return None if row is None else (row["checklist_id"], row["version"], row["role"])


def list_jobs() -> list[Job]:
    """Every job, oldest first."""
    conn = connect()
    try:
        rows = conn.execute("SELECT json FROM jobs ORDER BY created_at, rowid").fetchall()
    finally:
        conn.close()
    return [Job.model_validate_json(row["json"]) for row in rows]


def _item(job: Job, conversation: str) -> JobItem | None:
    return next((item for item in job.items if item.conversation == conversation), None)


def start_item(job_id: str, conversation: str) -> str | None:
    """Claim a queued item: it and its evaluation become `running`. Returns the evaluation id, or
    None when the item is not queued (another run has it, or it is gone)."""
    with write_transaction() as conn:
        row = _read_job(conn, job_id)
        if row is None:
            return None
        job = Job.model_validate_json(row["json"])
        item = _item(job, conversation)
        if item is None or item.status != "queued" or item.evaluation_id is None:
            return None
        item.status, item.error = "running", None
        _set_evaluation_status(conn, item.evaluation_id, "running")
        _write_job(conn, job)
        return item.evaluation_id


def finish_item(
    job_id: str, conversation: str, *, evaluation: Evaluation | None = None, error: str | None = None
) -> None:
    """End a running item: `done` with its evaluation stored, or `failed` with `error` (and its
    evaluation failed). One transaction, so the item and the evaluation always agree."""
    with write_transaction() as conn:
        row = _read_job(conn, job_id)
        if row is None:
            return
        job = Job.model_validate_json(row["json"])
        item = _item(job, conversation)
        if item is None or item.status != "running":
            return  # recovered or reset in the meantime: that outcome stands
        if evaluation is not None and error is None:
            item.status, item.error = "done", None
            _write_evaluation(conn, evaluation)
        else:
            item.status, item.error = "failed", error or "failed"
            _set_evaluation_status(conn, item.evaluation_id, "failed")
        _write_job(conn, job)


def requeue_items(job_id: str, conversations: list[str], role: Role) -> list[str]:
    """Put the job's items among `conversations` that are failed, or queued or running without a
    run of this process owning them (the caller decides which those are), back to `queued` (their
    evaluations too). Records the retry (`role`, time, the items) in the job's `retries` and
    returns the items reset. Done items are never touched; a run claims an item before working on
    it (`start_item`), so an item reset twice is still run once."""
    wanted = set(conversations)
    reset: list[str] = []
    with write_transaction() as conn:
        row = _read_job(conn, job_id)
        if row is None:
            return reset
        job = Job.model_validate_json(row["json"])
        for item in job.items:
            if item.conversation in wanted and item.status != "done" and item.evaluation_id:
                item.status, item.error = "queued", None
                _set_evaluation_status(conn, item.evaluation_id, "queued")
                reset.append(item.conversation)
        if reset:
            job.retries.append(JobRetry(role=role, at=_now(), items=reset))
            _write_job(conn, job)
    return reset


def fail_interrupted() -> int:
    """At startup, nothing is running yet: every queued or running job item becomes `failed` with
    the error "interrupted", and so does every queued or running evaluation. Returns the number of
    items changed."""
    changed = 0
    with write_transaction() as conn:
        for row in conn.execute(
            "SELECT json FROM jobs WHERE status IN ('queued', 'running')"
        ).fetchall():
            job = Job.model_validate_json(row["json"])
            for item in job.items:
                if item.status in ("queued", "running"):
                    item.status, item.error = "failed", "interrupted"
                    changed += 1
            _write_job(conn, job)
        for row in conn.execute(
            "SELECT id FROM evaluations WHERE status IN ('queued', 'running')"
        ).fetchall():
            _set_evaluation_status(conn, row["id"], "failed")
    return changed
