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
import re
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


# httpx logs every request, URL included, at INFO ("HTTP Request: GET <url> ..."), and that URL has
# the signature in it. So does any other signed link a library logs (the audio recordings'). The
# filter below rewrites such a URL to "<redacted>" and keeps the rest of the record (method, status).
#
# It is a filter on the loggers themselves, and a logger's filters do not apply to its children, so
# httpcore's loggers are named one by one.
_HTTP_LOGGERS = (
    "httpx",
    "httpcore",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
    "httpcore.socks",
)
_REDACTED = "<redacted>"
_URL_IN_TEXT = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_SIGNATURE = re.compile(r"sig(?:nature)?=", re.IGNORECASE)


def _organizer_endpoints() -> list[str]:
    """The configured URL without its query, as written and as httpx writes it (host in lower
    case, the default port dropped), lower-cased for comparing."""
    configured = _configured_url()
    if configured is None:
        return []
    forms = [configured]
    try:
        forms.append(str(httpx.URL(configured)))
    except httpx.InvalidURL:
        pass
    return [form.partition("#")[0].partition("?")[0].lower() for form in forms]


def redact_signed_urls(message: str) -> str:
    """`message` with every signed URL (a `sig=` / `signature=` parameter, any case) and every URL
    of the configured organiser endpoint replaced by "<redacted>". A signature or the endpoint that
    sits outside anything shaped like a URL makes the whole message "<redacted>"."""
    endpoints = _organizer_endpoints()

    def is_secret(url: str) -> bool:
        return bool(_SIGNATURE.search(url)) or any(url.lower().startswith(e) for e in endpoints)

    redacted = _URL_IN_TEXT.sub(lambda m: _REDACTED if is_secret(m.group()) else m.group(), message)
    if _SIGNATURE.search(redacted) or any(e in redacted.lower() for e in endpoints):
        return _REDACTED
    return redacted


class _RedactSignedUrls(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
            redacted = redact_signed_urls(message)
        except Exception:  # a logging problem must not break a request, nor let a message through
            message, redacted = "", _REDACTED
        if redacted != message:
            record.msg, record.args = redacted, None
        return True


_redact_filter = _RedactSignedUrls()
for _name in _HTTP_LOGGERS:
    logging.getLogger(_name).addFilter(_redact_filter)


def _organizer_error(message: str) -> ApiError:
    return ApiError(502, "organizer_error", message)


async def fetch_group(group_id: str) -> list[dict]:
    """The records of one dataset group from the organisers' API.

    Raises ApiError 409 `organizer_url_missing` without a configured URL, and 502
    `organizer_error` when the call takes longer than 60 s in total, fails, answers with a status
    other than 200 or `isSuccess` false, or answers with something that is not `data.records`. The
    message names the upstream status or "timeout", never the URL.
    """
    url = organizer_url_for(group_id)
    try:
        # httpx's own timeout limits each wait (connect, one read), so a body that drips in forever
        # would never trip it: the deadline for the whole call is this one.
        async with asyncio.timeout(FETCH_TIMEOUT_SECONDS):
            async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS) as client:
                response = await client.get(url)
    except (httpx.TimeoutException, TimeoutError):
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
    """Why a record cannot be imported, judged by its shape only; None when it looks fine.

    Lenient where a new set may differ from DEV without being wrong: an integer conversation_id
    (stored as its text) and a null transcript (an empty one) are fine. A transcript that is
    absent is still missing."""
    if not isinstance(record, dict):
        return "it is not an object"
    missing = [
        field
        for field in _REQUIRED_FIELDS
        if field not in record or (record[field] is None and field != "transcript")
    ]
    if missing:
        return f"missing {', '.join(missing)}"
    conversation_id = record["conversation_id"]
    is_integer = isinstance(conversation_id, int) and not isinstance(conversation_id, bool)
    if not is_integer and not (isinstance(conversation_id, str) and conversation_id.strip()):
        return "conversation_id must be a non-empty string or an integer"
    if record["transcript"] is not None and not isinstance(record["transcript"], list):
        return "transcript must be a list"
    return None


def _bad_record(index: int, problem: str) -> ApiError:
    return ApiError(422, f"bad_record:{index}", f"Record {index} cannot be imported: {problem}.")


def parse_upload(payload: Any) -> tuple[list[dict], str | None]:
    """The records of an uploaded JSON body, and the group it names (or None).

    Accepts one record, an array of records, `{"records": [...]}` (an optional
    `dataset_group_id` next to it names the group) or the organisers' full response
    (`data.records`, group `data.dataset_group_id`). Every record needs `conversation_id` (a
    string or an integer), `channel`, `language` and `transcript` (a list, or null for none); the
    values themselves are checked by `import_records`.

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

# Audio runs in flight, by conversation id. The table keeps each task referenced until it is done
# (the event loop only holds tasks weakly) and stops a second run of the same call from starting.
_background_tasks: dict[str, asyncio.Task[None]] = {}


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
    except Exception as exc:
        # Only the type. The message and the traceback of a failed download can hold the signed URL.
        logger.error("Audio processing failed for %s: %s", conversation, type(exc).__name__)


def _forget(conversation: str, task: asyncio.Task[None]) -> None:
    if _background_tasks.get(conversation) is task:  # not a newer run of the same call
        del _background_tasks[conversation]


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
        running = _background_tasks.get(conversation)
        if running is not None and not running.done():
            continue  # already being processed; its result is what the caller is waiting for
        task = loop.create_task(_process_call(process_call, conversation))
        _background_tasks[conversation] = task
        task.add_done_callback(lambda done, key=conversation: _forget(key, done))
