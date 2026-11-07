"""Getting dialogues in: from the organisers' API by group_id, or from an uploaded file.

Both ways end in `import_records`, which checks every record first, then stores all of them in one
transaction (a bad record or a failure stores nothing) and hands new voice calls to the audio
package in the background.

The organisers' URL (settings.organizer_api_url) carries a signature: it is a secret. It is not
logged, and it is not part of any error message or response.
"""

import asyncio
import importlib
import importlib.util
import logging
import sys
from collections import Counter
from datetime import UTC, datetime
from types import ModuleType
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from app import store
from app.errors import ApiError
from app.models import ImportSummary
from app.settings import get_settings
from app.transcript import normalize_record

logger = logging.getLogger(__name__)

FETCH_TIMEOUT_SECONDS = 60
_REQUIRED_FIELDS = ("conversation_id", "channel", "language", "transcript")
_MAX_LISTED_PROBLEMS = 3

# --- the organisers' URL -------------------------------------------------------------------


def _configured_url() -> str | None:
    secret = get_settings().organizer_api_url
    configured = secret.get_secret_value().strip() if secret is not None else ""
    return configured or None


def organizer_url_for(group_id: str) -> str:
    """settings.organizer_api_url with the value of its `group_id` parameter replaced.

    The URL is cut and put back together as text, never parsed and re-encoded: every other
    parameter (the signature above all, with its %2F and =) stays byte-identical, and so does the
    order. A URL without a `group_id` parameter gets one at the end. Raises
    ApiError(409, "organizer_url_missing") when no URL is configured.
    """
    configured = _configured_url()
    if configured is None:
        raise ApiError(
            409,
            "organizer_url_missing",
            "The organisers' API URL is not configured (set ORGANIZER_API_URL), "
            "so a dataset cannot be fetched. Upload the JSON instead.",
        )
    without_fragment, hash_mark, fragment = configured.partition("#")
    path, _, query = without_fragment.partition("?")
    value = quote(group_id, safe="")  # a group id must not be able to add or change parameters
    parts = query.split("&") if query else []
    replaced = False
    for i, part in enumerate(parts):
        if part.partition("=")[0] == "group_id":
            parts[i] = f"group_id={value}"
            replaced = True
    if not replaced:
        parts.append(f"group_id={value}")
    return f"{path}?{'&'.join(parts)}{hash_mark}{fragment}"


class _HideOrganizerUrl(logging.Filter):
    """httpx logs every request, URL included, at INFO. That URL has the signature in it."""

    def filter(self, record: logging.LogRecord) -> bool:
        configured = _configured_url()
        if configured is None:
            return True
        endpoint = configured.partition("#")[0].partition("?")[0]
        return endpoint not in record.getMessage()


logging.getLogger("httpx").addFilter(_HideOrganizerUrl())


def _organizer_error(message: str) -> ApiError:
    return ApiError(502, "organizer_error", message)


async def fetch_group(group_id: str) -> list[dict]:
    """The records of one dataset group from the organisers' API.

    Raises ApiError 409 `organizer_url_missing` without a configured URL, and 502
    `organizer_error` when the call times out (60 s), fails, answers with a status other than 200
    or `isSuccess` false, or answers with something that is not `data.records`. The message names
    the upstream status or "timeout", never the URL.
    """
    url = organizer_url_for(group_id)
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS) as client:
            response = await client.get(url)
    except httpx.TimeoutException:
        raise _organizer_error("The organisers' API did not answer in time (timeout).") from None
    except (httpx.HTTPError, httpx.InvalidURL) as exc:
        # The exception's own text is not used: it may name the URL.
        raise _organizer_error(f"The organisers' API could not be reached ({type(exc).__name__}).") from None

    if response.status_code != 200:
        raise _organizer_error(f"The organisers' API answered HTTP {response.status_code}.")
    try:
        payload = response.json()
    except ValueError:
        raise _organizer_error("The organisers' API did not answer with JSON.") from None
    if not isinstance(payload, dict):
        raise _organizer_error("The organisers' API answered with an unexpected shape.")
    if not payload.get("isSuccess", True):
        raise _organizer_error(
            f"The organisers' API reported a failure (isSuccess false, HTTP {response.status_code})."
        )
    data = payload.get("data")
    records = data.get("records") if isinstance(data, dict) else None
    if not isinstance(records, list):
        raise _organizer_error("The organisers' API answered without data.records.")
    return records


# --- upload --------------------------------------------------------------------------------


def _problem_with(record: Any) -> str | None:
    """Why a record cannot be imported, judged by its shape only; None when it looks fine."""
    if not isinstance(record, dict):
        return "it is not an object"
    missing = [field for field in _REQUIRED_FIELDS if record.get(field) is None]
    if missing:
        return f"missing {', '.join(missing)}"
    conversation_id = record["conversation_id"]
    if not isinstance(conversation_id, str) or not conversation_id.strip():
        return "conversation_id must be a non-empty string"
    if not isinstance(record["transcript"], list):
        return "transcript must be a list"
    return None


def _bad_record(index: int, problem: str) -> ApiError:
    return ApiError(422, f"bad_record:{index}", f"Record {index} cannot be imported: {problem}.")


def parse_upload(payload: Any) -> tuple[list[dict], str | None]:
    """The records of an uploaded JSON body, and the group it names (or None).

    Accepts one record, an array of records, `{"records": [...]}` (an optional
    `dataset_group_id` next to it names the group) or the organisers' full response
    (`data.records`, group `data.dataset_group_id`). Every record needs `conversation_id`,
    `channel`, `language` and `transcript` (a list); the values themselves are checked by
    `import_records`.

    Raises ApiError 422 `no_records`, or `bad_record:<i>` with i the index in the payload.
    """
    records: Any = None
    hint: Any = None
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict):
        body = payload["data"] if isinstance(payload.get("data"), dict) else payload
        if "records" in body:
            records, hint = body["records"], body.get("dataset_group_id")
        elif any(field in payload for field in _REQUIRED_FIELDS):
            records = [payload]
    if not isinstance(records, list) or not records:
        raise ApiError(
            422,
            "no_records",
            "No records found. Send one record, an array of records, "
            '{"records": [...]} or the organisers\' response.',
        )
    for i, record in enumerate(records):
        problem = _problem_with(record)
        if problem is not None:
            raise _bad_record(i, problem)
    group = hint.strip() if isinstance(hint, str) and hint.strip() else None
    return records, group


def upload_group_id() -> str:
    """The group an upload without a name goes into: upload-<UTC yyyymmddHHMMSS>."""
    return f"upload-{datetime.now(UTC):%Y%m%d%H%M%S}"


# --- import --------------------------------------------------------------------------------


def _describe(exc: ValidationError) -> str:
    # Field names and rules only: the offending value (it may be anything) is left out.
    errors = exc.errors(include_input=False, include_url=False)
    shown = errors[:_MAX_LISTED_PROBLEMS]
    return "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in shown)


def _store_records(records: list[dict], group_id: str) -> tuple[ImportSummary, list[str]]:
    """Blocking part of an import: check every record, write all of them in one transaction.
    Returns the summary and the ids of the voice calls whose audio still has to be processed."""
    prepared = []
    for i, record in enumerate(records):
        problem = _problem_with(record)
        if problem is not None:
            raise _bad_record(i, problem)
        try:
            prepared.append(normalize_record(record, group_id))
        except ValidationError as exc:
            raise _bad_record(i, _describe(exc)) from None

    outcomes: Counter[str] = Counter()
    with store.write_transaction() as conn:
        for conversation, audio_url in prepared:
            outcomes[store.upsert_conversation(conversation, audio_url, conn=conn)] += 1

    # A call is worth processing when it has a recording and no results yet: new or changed calls,
    # and calls whose earlier attempt left nothing. Unchanged, finished calls are left alone.
    to_process: dict[str, None] = {}
    for conversation, audio_url in prepared:
        if conversation.channel == "voice call" and audio_url is not None:
            stored = store.get_conversation(conversation.id)
            if stored is not None and not stored.audio_offsets:
                to_process[conversation.id] = None

    summary = ImportSummary(
        group_id=group_id,
        total=len(records),
        imported=outcomes["imported"],
        updated=outcomes["updated"],
        unchanged=outcomes["unchanged"],
    )
    return summary, list(to_process)


async def import_records(records: list[dict], group_id: str) -> ImportSummary:
    """Store records as the conversations of `group_id`.

    Every record is checked before anything is written (ApiError 422 `bad_record:<i>`), and the
    writes are one transaction: nothing partial is stored on any error. A conversation whose
    transcript is unchanged is "unchanged"; a changed one is "updated". Afterwards the voice calls
    that have an `audio_url` are handed to `audio.process_call` in the background, when that
    package exists.

    It is a coroutine so the database work runs off the event loop and the audio tasks are created
    on it.
    """
    summary, voice_calls = await asyncio.to_thread(_store_records, records, group_id)
    logger.info(
        "Imported group %r: total=%d imported=%d updated=%d unchanged=%d",
        group_id, summary.total, summary.imported, summary.updated, summary.unchanged,
    )  # fmt: skip
    _schedule_audio(voice_calls)
    return summary


# --- audio hook ----------------------------------------------------------------------------

# Tasks are only weakly referenced by the event loop: hold them until they are done.
_background_tasks: set[asyncio.Task[None]] = set()


def _audio_package() -> ModuleType | None:
    """Stream D's `audio` package, or None while it does not exist (or cannot be imported)."""
    try:
        if importlib.util.find_spec("audio") is None:
            return None
    except ValueError:
        # Already in sys.modules without a __spec__ (a stand-in): it is there.
        return sys.modules.get("audio")
    try:
        return importlib.import_module("audio")
    except Exception:
        logger.exception("The audio package exists but cannot be imported; calls are not processed")
        return None


async def _process_call(process_call: Any, conversation: str) -> None:
    try:
        await process_call(conversation)
    except Exception:
        logger.exception("Audio processing failed for %s", conversation)


def _schedule_audio(conversations: list[str]) -> None:
    """Start `audio.process_call(id)` for each id as a background task. A failure is logged and
    never reaches the import."""
    if not conversations:
        return
    package = _audio_package()
    if package is None:
        return
    process_call = getattr(package, "process_call", None)
    if process_call is None:
        logger.error("The audio package has no process_call; calls are not processed")
        return
    loop = asyncio.get_running_loop()
    for conversation in conversations:
        task = loop.create_task(_process_call(process_call, conversation))
        _background_tasks.add(task)
        task.add_done_callback(_background_tasks.discard)
