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
`get_checklist_version`. Later tasks add the rest of the checklist part and the evaluation part.
"""

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Literal

from app.db import connect, register_migration
from app.errors import ApiError
from app.models import AudioOffset, ChecklistVersion, Conversation, VoiceMeasurement
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


def get_checklist_version(checklist_id: str, version: int) -> ChecklistVersion | None:
    """The stored checklist version, or None. `created_at` is always set; `locked` is the column's
    current value."""
    conn = connect()
    try:
        row = conn.execute(
            "SELECT json, locked FROM checklist_versions WHERE checklist_id = ? AND version = ?",
            (checklist_id, version),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        return None
    stored = ChecklistVersion.model_validate_json(row["json"])
    return stored.model_copy(update={"locked": bool(row["locked"])})


def save_checklist_version(v: ChecklistVersion) -> ChecklistVersion:
    """Store a new checklist version and return it as stored: `created_at` is filled with the
    current UTC time when missing, `id` is `"{checklist_id}:{version}"`.

    A stored version is never overwritten (editing a checklist makes a new version): an existing
    (checklist_id, version) raises ApiError(409, "version_exists")."""
    created = v.created_at or _now().replace(microsecond=0)
    stored = v.model_copy(update={"id": f"{v.checklist_id}:{v.version}", "created_at": created})
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
        conn.execute(
            "INSERT INTO checklist_versions (checklist_id, version, json, locked, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (v.checklist_id, v.version, stored.model_dump_json(), int(v.locked), _stamp(created)),
        )
    return stored
