"""One error shape for the whole API: {"error": "<code>", "message": "<text>"}."""

from http import HTTPStatus

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

_MAX_LISTED_ERRORS = 5


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _body(code: str, message: str) -> dict[str, str]:
    return {"error": code, "message": message}


def _http_message(exc: StarletteHTTPException) -> str:
    if isinstance(exc.detail, str) and exc.detail:
        return exc.detail
    try:
        return HTTPStatus(exc.status_code).phrase
    except ValueError:
        return f"HTTP {exc.status_code}"


def _validation_message(exc: RequestValidationError) -> str:
    errors = exc.errors()
    parts = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in errors[:_MAX_LISTED_ERRORS]]
    if len(errors) > _MAX_LISTED_ERRORS:
        parts.append(f"(+{len(errors) - _MAX_LISTED_ERRORS} more)")
    return "; ".join(parts) or "Invalid request."


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(_body(exc.code, exc.message), status_code=exc.status)

    # Starlette's class, so it covers FastAPI's HTTPException and the 404 of unknown routes
    # and of the static mount.
    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = "not_found" if exc.status_code == 404 else f"http_{exc.status_code}"
        return JSONResponse(
            _body(code, _http_message(exc)), status_code=exc.status_code, headers=exc.headers
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(_body("invalid_request", _validation_message(exc)), status_code=422)
