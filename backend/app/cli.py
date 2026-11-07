"""The two commands of `[project.scripts]`: `cqa-serve` (the one-command start) and `cqa-snapshot`.

    cd backend
    uv run cqa-serve [--host 127.0.0.1] [--port 8000]
    uv run cqa-snapshot

`cqa-serve` prepares the database (migrations, the seeded checklists) and, when it holds no
conversations yet, loads the results snapshot the repo ships, so a fresh clone shows results with no
model key. It then runs the app with uvicorn. It never prints the model key or the organisers' URL.

Both commands first import the other streams' router modules, as the app does when it starts: those
modules register their migrations and snapshot tables (`app.snapshot.register_snapshot_table`) at
import, and both must be known before the database is migrated, restored or exported.

`cqa-serve` sends the app's own log records (the `app` loggers: imports, jobs, second-opinion cost,
warnings) at INFO and above to stderr, with the time and the level. Only the `app` logger is
configured: the root logger and the libraries' loggers keep their settings (uvicorn configures its
own). Signed URLs in exception logs are redacted by app.redaction, on the loggers themselves.

Both commands work the same from any directory: `backend/.env` is found from the package path (see
app/settings.py) and a relative `DB_PATH` (the default is `cqa.db`) is resolved against `backend/`.
"""

import argparse
import logging
import os
import sqlite3
import sys
from pathlib import Path
from typing import NoReturn

import uvicorn

from app import snapshot as snapshots
from app.checklists import seed_into_db
from app.db import migrate
from app.main import create_app, optional_routers
from app.settings import BACKEND_DIR, get_settings

logger = logging.getLogger(__name__)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8000
LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def _port(text: str) -> int:
    try:
        port = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a port number") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("a port is a number from 1 to 65535")
    return port


def parse_serve_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="cqa-serve", description="Start CQA (Conversation Quality Analytics) on this machine."
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"address to listen on (default {DEFAULT_HOST})")
    parser.add_argument("--port", type=_port, default=DEFAULT_PORT, help=f"port to listen on (default {DEFAULT_PORT})")
    return parser.parse_args(argv)


def _fail(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def _anchor_db_path() -> Path:
    """The database file, with a relative `DB_PATH` resolved against backend/ (not the working
    directory), so every start and every export use the same file."""
    db_path = get_settings().db_path
    if not db_path.is_absolute():
        # An environment variable wins over backend/.env, so this holds wherever DB_PATH came from.
        os.environ["DB_PATH"] = str(BACKEND_DIR / db_path)
        get_settings.cache_clear()
    return get_settings().db_path


class _AppLogHandler(logging.StreamHandler):
    """Writes to whatever `sys.stderr` is when a record comes (as logging's last-resort handler
    does), so a replaced stderr (a test's capture) is never written to after it is gone."""

    def __init__(self) -> None:
        logging.Handler.__init__(self, logging.INFO)

    @property
    def stream(self):  # type: ignore[override]
        return sys.stderr


def configure_logging() -> None:
    """The `app` loggers' records at INFO and above to stderr, with the time and the level. Only
    the `app` logger: the root logger and the libraries' loggers are left as they are. Calling it
    again changes nothing."""
    app_logger = logging.getLogger("app")
    app_logger.setLevel(logging.INFO)
    if any(isinstance(handler, _AppLogHandler) for handler in app_logger.handlers):
        return
    handler = _AppLogHandler()
    handler.setFormatter(logging.Formatter(LOG_FORMAT))
    app_logger.addHandler(handler)


def _load_other_streams() -> None:
    """Import the other streams' routers (the modules the app mounts), so the migrations and the
    snapshot tables they register at import are known before the database is touched."""
    optional_routers()


def _address(host: str, port: int) -> str:
    shown = f"[{host}]" if ":" in host and not host.startswith("[") else host
    return f"http://{shown}:{port}/"


def _restore_snapshot() -> None:
    """Load the shipped snapshot when the database has no conversations. A snapshot that is
    missing or cannot be loaded is a warning, not a failure: the app starts with whatever the
    database holds (empty, when nothing was loaded). A warning names an exception's type, never its
    text: the text may hold part of the file."""
    if snapshots.has_conversations():
        return
    path = snapshots.SNAPSHOT
    if not path.is_file():
        logger.warning("No results snapshot at %s; starting with an empty database.", path)
        return
    try:
        rows = snapshots.import_snapshot(path)
    except snapshots.SnapshotError as exc:
        logger.warning("The results snapshot was not loaded: %s Starting with an empty database.", exc)
    except (ValueError, OSError) as exc:
        logger.warning(
            "The results snapshot could not be read (%s). Starting with an empty database.", type(exc).__name__
        )
    except sqlite3.OperationalError as exc:  # e.g. another process held the database lock too long
        logger.warning(
            "The results snapshot was not loaded (%s). Starting with whatever the database holds.",
            type(exc).__name__,
        )
    else:
        print(f"Loaded the results snapshot ({rows} rows).")


def serve(argv: list[str] | None = None) -> None:
    """`cqa-serve`: prepare the database, load the snapshot into an empty one, run the app."""
    args = parse_serve_args(argv)
    configure_logging()
    db_path = _anchor_db_path()
    _load_other_streams()
    migrate()
    seed_into_db()
    _restore_snapshot()

    settings = get_settings()
    print(f"Database: {db_path}")
    print(f"CQA is running at {_address(args.host, args.port)}")
    if settings.model_key_configured:
        print("Model key: configured. New evaluations are enabled.")
    else:
        print(
            "Model key: not configured. Stored results work; new evaluations need ANTHROPIC_API_KEY "
            "in backend/.env."
        )
    organisers = settings.organizer_api_url
    if organisers is not None and organisers.get_secret_value().strip():
        print("Organisers' API: configured.")
    else:
        print(
            "Organisers' API: not configured. Importing a group and playing calls need "
            "ORGANIZER_API_URL in backend/.env."
        )
    sys.stdout.flush()
    uvicorn.run(create_app(), host=args.host, port=args.port)


def snapshot(argv: list[str] | None = None) -> None:
    """`cqa-snapshot`: write the snapshot of the current database to data/snapshot/.

    Refuses (exit code 1, a message on stderr) when the text holds a signed URL, when there is no
    database, and when it has no conversations (an empty export would overwrite the shipped one)."""
    argparse.ArgumentParser(
        prog="cqa-snapshot", description="Export the stored results of this machine as the shipped snapshot."
    ).parse_args(argv)
    db_path = _anchor_db_path()
    if not db_path.is_file():
        _fail(f"No database at {db_path}. Nothing to export.")
    _load_other_streams()
    migrate()
    if not snapshots.has_conversations():
        _fail(
            f"The database {db_path} has no conversations, so there is nothing to export. "
            "The snapshot was left as it is."
        )
    target = snapshots.SNAPSHOT
    try:
        document = snapshots.export_snapshot(target)
    except snapshots.SnapshotError as exc:
        _fail(f"Refusing to write the snapshot. {exc}")
    print(f"Wrote {snapshots.row_count(document)} rows to {target}")
