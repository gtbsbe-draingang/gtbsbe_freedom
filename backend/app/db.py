"""SQLite access and migrations.

Every module that owns tables calls `register_migration(name, sql)` at import time; the app
applies the unapplied ones, in name order, once each, at startup (`migrate()`). Streams prefix
their migration names (`b_`, `c_`, `d_`) so the order is stable and names never clash.

A migration's SQL must not contain its own BEGIN / COMMIT: `migrate()` wraps each one in a
transaction together with the `schema_migrations` row, so a failing migration leaves nothing behind.
"""

import sqlite3
from datetime import UTC, datetime

from app.settings import get_settings

_MIGRATIONS: dict[str, str] = {}


def _open(**kwargs) -> sqlite3.Connection:
    path = get_settings().db_path
    path.parent.mkdir(parents=True, exist_ok=True)
    # Jobs write from several threads: wait for a lock instead of failing at once.
    conn = sqlite3.connect(path, timeout=30, **kwargs)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def connect() -> sqlite3.Connection:
    """A new connection to settings.db_path (rows are sqlite3.Row, foreign keys on, WAL).
    The caller closes it."""
    return _open()


def register_migration(name: str, sql: str) -> None:
    """Register a migration to be applied once by migrate(). Re-registering the same name with
    the same SQL is a no-op (a module imported twice); different SQL under a used name is a bug."""
    existing = _MIGRATIONS.get(name)
    if existing is not None and existing != sql:
        raise ValueError(f"migration {name!r} is already registered with different SQL")
    _MIGRATIONS[name] = sql


def migrate() -> None:
    """Apply every registered migration that is not in schema_migrations, in name order."""
    # autocommit=True: transactions are explicit, and executescript() does not commit behind our back.
    conn = _open(autocommit=True)
    try:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        applied = {row["name"] for row in conn.execute("SELECT name FROM schema_migrations")}
        for name in sorted(_MIGRATIONS):
            if name not in applied:
                _apply(conn, name, _MIGRATIONS[name])
    finally:
        conn.close()


def _apply(conn: sqlite3.Connection, name: str, sql: str) -> None:
    conn.execute("BEGIN IMMEDIATE")  # takes the write lock: a second process waits here
    try:
        # Re-check under the lock: another process may have applied it since we looked.
        if conn.execute("SELECT 1 FROM schema_migrations WHERE name = ?", (name,)).fetchone() is None:
            conn.executescript(sql)
            conn.execute(
                "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
                (name, datetime.now(UTC).isoformat(timespec="seconds")),
            )
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise
