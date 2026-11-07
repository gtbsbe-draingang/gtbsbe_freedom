"""Signed URLs never reach a log line.

The organisers' URL (settings.organizer_api_url) and the calls' `audio_url`s carry a signature
(`sig=`): they are secrets. Two kinds of log records can still carry one:

* httpx and httpcore log every request, URL included ("HTTP Request: GET <url> ..."), at INFO or
  DEBUG;
* an exception that escapes a request is logged with its text and traceback twice: by our
  last-resort handler (`app.errors`) and again by uvicorn (`uvicorn.error`, "Exception in ASGI
  application"). An httpx error's text names the URL it was fetching.

`RedactSignedUrls` rewrites such a URL to "<redacted>" in a record's message, its formatted
exception and its stack, and keeps everything else. It is installed on those loggers when this
module is imported (app.errors and app.importer import it).

A logger's filters do not apply to its children's records, so httpcore's loggers are named one by
one.
"""

import logging
import re

import httpx

from app.settings import get_settings

__all__ = ["REDACTED", "RedactSignedUrls", "install", "redact_signed_urls"]

REDACTED = "<redacted>"
_URL_IN_TEXT = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_SIGNATURE = re.compile(r"sig(?:nature)?=", re.IGNORECASE)

_HTTP_LOGGERS = (
    "httpx",
    "httpcore",
    "httpcore.connection",
    "httpcore.http11",
    "httpcore.http2",
    "httpcore.proxy",
    "httpcore.socks",
)
_ERROR_LOGGERS = ("app.errors", "uvicorn.error")


def _organizer_endpoints() -> list[str]:
    """The configured organisers' URL without its query, as written and as httpx writes it (host
    in lower case, the default port dropped), lower-cased for comparing."""
    secret = get_settings().organizer_api_url
    configured = secret.get_secret_value().strip() if secret is not None else ""
    if not configured:
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

    redacted = _URL_IN_TEXT.sub(lambda m: REDACTED if is_secret(m.group()) else m.group(), message)
    if _SIGNATURE.search(redacted) or any(e in redacted.lower() for e in endpoints):
        return REDACTED
    return redacted


def _redact_lines(text: str) -> str:
    # Line by line, so a stray signature costs one line of a traceback, not the whole traceback.
    return "\n".join(redact_signed_urls(line) for line in text.split("\n"))


_FORMATTER = logging.Formatter()


class RedactSignedUrls(logging.Filter):
    """Redacts the message, the exception text and the stack of every record it sees (never drops
    a record). The exception is formatted here, into `record.exc_text`, which every
    `logging.Formatter` (uvicorn's included) prints instead of formatting `exc_info` again."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
            redacted = redact_signed_urls(message)
        except Exception:  # a logging problem must not break a request, nor let a message through
            message, redacted = "", REDACTED
        if redacted != message:
            record.msg, record.args = redacted, None
        try:
            if record.exc_info and not record.exc_text:
                record.exc_text = _FORMATTER.formatException(record.exc_info)
            if record.exc_text:
                record.exc_text = _redact_lines(record.exc_text)
            if record.stack_info:
                record.stack_info = _redact_lines(record.stack_info)
        except Exception:
            record.exc_text = REDACTED if record.exc_info or record.exc_text else record.exc_text
            record.stack_info = REDACTED if record.stack_info else None
        return True


_filter = RedactSignedUrls()


def install(*names: str) -> None:
    """Put the redaction filter on these loggers (again is a no-op)."""
    for name in names:
        logging.getLogger(name).addFilter(_filter)


install(*_HTTP_LOGGERS, *_ERROR_LOGGERS)
