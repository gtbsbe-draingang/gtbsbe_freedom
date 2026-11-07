"""Transcript normalization and the facts computed in code.

`normalize_record` turns an organisers' record into a `Conversation`: the id, duplicates marked,
facts computed, the audio fields set, and the signed `audio_url` handed back separately so the
caller can store it privately (it is never part of the Conversation).

The facts are plain statements for the evaluator and the UI (design section 6). Their patterns and
rules match the front end's mock (`web/src/domain/normalize.js`), so a mock conversation and a real
one show the same numbers. Indices always refer to the original transcript, duplicate lines
included.
"""

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any

from app.models import Conversation, Facts, Message

# --- system-event texts (the DEV phrases, in RU, KZ and EN) --------------------------------

HANDOVER = re.compile(
    r"^(Эскалация на оператора|Чат операторға жіберілді|Chat transferred to an agent"
    r"|Агент присоединился к разговору)"
)
IDENTITY = re.compile(
    r"^(Личность клиента подтверждена|Клиенттің жеке басы расталды|Customer identity verified)"
)
# The last matching system line wins, so the order here does not matter: no text matches two.
ENDINGS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("operator_closed", re.compile(r"^(Оператор закрыл чат|Оператор чатты жапты|Agent closed the chat)")),
    ("client_left", re.compile(r"^(Клиент покинул чат|Customer left the chat)")),
    (
        "connection_lost",
        re.compile(
            r"^(Соединение с клиентом прервано|Клиентпен байланыс үзілді|Connection to customer lost)"
        ),
    ),
    ("client_ended_call", re.compile(r"^Клиент завершил разговор")),
)

# --- time ----------------------------------------------------------------------------------

_CLOCK_MS = re.compile(r"^(\d{1,3}):([0-5]\d)$")  # MM:SS, minutes may pass 59 in a long chat
_CLOCK_HMS = re.compile(r"^(\d{1,2}):([0-5]\d):([0-5]\d)$")  # H:MM:SS
# fromisoformat alone would also take a bare date or "20260311T..."; a line time needs a clock.
_ISO_START = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")


def _clock_seconds(timestamp: str) -> float | None:
    if m := _CLOCK_MS.match(timestamp):
        return float(int(m[1]) * 60 + int(m[2]))
    if m := _CLOCK_HMS.match(timestamp):
        return float(int(m[1]) * 3600 + int(m[2]) * 60 + int(m[3]))
    return None


def _iso_time(timestamp: str) -> datetime | None:
    """An ISO 8601 line time as an aware datetime; a time without a zone is read as UTC (only
    differences between lines are used, so they stay right)."""
    if not _ISO_START.match(timestamp):
        return None
    try:
        parsed = datetime.fromisoformat(timestamp)  # Python 3.12: any number of fraction digits
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def seconds(transcript: list[Message]) -> list[float | None]:
    """The time of every line in seconds, None where it cannot be read.

    `MM:SS` and `H:MM:SS` give seconds from the start of the chat. An ISO 8601 time gives seconds
    from the first ISO line that parses. Anything else gives None.
    """
    stamps = [m.timestamp.strip() for m in transcript]
    clocks = [_clock_seconds(stamp) for stamp in stamps]
    isos = [None if clock is not None else _iso_time(stamp) for clock, stamp in zip(clocks, stamps)]
    base = next((t for t in isos if t is not None), None)
    result: list[float | None] = []
    for clock, iso in zip(clocks, isos):
        if clock is not None:
            result.append(clock)
        elif iso is not None and base is not None:
            result.append((iso - base).total_seconds())
        else:
            result.append(None)
    return result


def _gap(times: list[float | None], start: int, end: int) -> float | None:
    """Seconds from line `start` to line `end`; None when a time is missing or the order is
    backwards (an out-of-order clock is not a wait). Rounded to the microsecond, the precision
    of an ISO time, so float noise from the subtraction does not reach the UI."""
    a, b = times[start], times[end]
    if a is None or b is None or b < a:
        return None
    return round(b - a, 6)


# --- duplicates, facts, hash ---------------------------------------------------------------


def mark_duplicates(transcript: list[Message]) -> list[Message]:
    """A copy of the transcript where a line equal in timestamp, speaker and text to the line
    before it has `duplicate=True`. The input is not changed."""
    marked: list[Message] = []
    for i, message in enumerate(transcript):
        previous = transcript[i - 1] if i else None
        same = (
            previous is not None
            and message.timestamp == previous.timestamp
            and message.speaker == previous.speaker
            and message.text == previous.text
        )
        marked.append(message.model_copy(update={"duplicate": message.duplicate or same}))
    return marked


def compute_facts(transcript: list[Message]) -> Facts:
    """The facts the evaluator is given and the UI shows. Anything that cannot be worked out is
    None; the ending is "normal" when no system line says otherwise."""
    times = seconds(transcript)

    handover: int | None = None
    identity: int | None = None
    ending = "normal"
    for i, message in enumerate(transcript):
        if message.speaker != "system":
            continue
        text = message.text.strip()
        if handover is None and HANDOVER.match(text):
            handover = i
        if identity is None and IDENTITY.match(text):
            identity = i
        for kind, pattern in ENDINGS:
            if pattern.match(text):
                ending = kind  # the last match wins

    # The first operator line after the handover. Only without a handover is it the first operator
    # line anywhere: an operator who spoke before a handover that nobody follows up did not "join"
    # at it, and the UI's mock (web/src/domain/normalize.js) gives null there too.
    joined = next(
        (
            i
            for i, m in enumerate(transcript)
            if m.speaker == "operator" and (handover is None or i > handover)
        ),
        None,
    )

    first_reaction = None
    if handover is not None and joined is not None:
        first_reaction = _gap(times, handover, joined)

    # A wait runs from the first client line that no operator line has answered yet to the next
    # operator line. Only lines after the handover count (the bot's phase is left out); without a
    # handover the scan starts at the operator's first line. A client line that is never answered
    # is not a wait.
    longest_wait: float | None = None
    if joined is not None:
        pending: int | None = None
        for i in range(handover + 1 if handover is not None else joined, len(transcript)):
            speaker = transcript[i].speaker
            if speaker == "client" and pending is None:
                pending = i
            elif speaker == "operator" and pending is not None:
                wait = _gap(times, pending, i)
                if wait is not None and (longest_wait is None or wait > longest_wait):
                    longest_wait = wait
                pending = None

    return Facts(
        operator_joined_index=joined,
        first_reaction_seconds=first_reaction,
        longest_wait_seconds=longest_wait,
        identity_verified_index=identity,
        ending=ending,
    )


def transcript_hash(transcript: list[Message]) -> str:
    """sha256 (hex) of the canonical JSON of the lines' timestamp, speaker and text. The
    `duplicate` flag is left out, so marking duplicates never changes the hash."""
    canonical = json.dumps(
        [{"timestamp": m.timestamp, "speaker": m.speaker, "text": m.text} for m in transcript],
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# --- records -------------------------------------------------------------------------------


def _text(value: Any) -> str:
    return value if isinstance(value, str) else "" if value is None else str(value)


def _message(line: Any) -> Message:
    """One organisers' line as a Message. A missing field becomes "", so an odd line in an
    unseen set is kept rather than failing the whole import. Speakers are kept as given."""
    if isinstance(line, dict):
        return Message(
            timestamp=_text(line.get("timestamp")),
            speaker=_text(line.get("speaker")),
            text=_text(line.get("text")),
        )
    return Message(timestamp="", speaker="", text=_text(line))


def _conversation_id(value: Any) -> Any:
    """An integer id (an export may write one as a number) as its text; anything else as it is."""
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else value


def normalize_record(record: dict, group_id: str) -> tuple[Conversation, str | None]:
    """An organisers' record as `(Conversation, audio_url)`.

    The Conversation has `id` = "{group_id}:{conversation_id}", status "new", duplicates marked
    and facts computed; `created_at` is left for the store. An integer `conversation_id` becomes
    its text; `language` is kept exactly as given (any string); a missing or null transcript is
    empty. `audio` is our own endpoint path when the record has an audio_url, else None with the
    reason "needs_import" (a call) or "none" (a chat). The signed audio_url is returned as the
    second value and is not in the Conversation. The input record is not changed.

    Raises pydantic.ValidationError when conversation_id, channel or language is missing, when
    conversation_id or language is not a string (an integer id aside) or when channel is not one
    of the contract's values.
    """
    conversation_id = _conversation_id(record.get("conversation_id"))
    channel = record.get("channel")
    id_ = f"{group_id}:{conversation_id}"

    raw_lines = record.get("transcript")
    lines = [_message(line) for line in raw_lines] if isinstance(raw_lines, list) else []
    transcript = mark_duplicates(lines)

    raw_url = record.get("audio_url")
    audio_url = raw_url if isinstance(raw_url, str) and raw_url.strip() else None

    conversation = Conversation(
        id=id_,
        conversation_id=conversation_id,
        group_id=group_id,
        channel=channel,
        language=record.get("language"),
        transcript=transcript,
        status="new",
        facts=compute_facts(transcript),
        audio=f"conversations/{id_}/audio" if audio_url is not None else None,
        audio_unavailable_reason=(
            None if audio_url is not None else "needs_import" if channel == "voice call" else "none"
        ),
    )
    return conversation, audio_url
