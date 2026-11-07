"""FastAPI application factory.

Run from backend/: `uv run uvicorn app.main:create_app --factory`.
"""

import importlib
import importlib.util
import mimetypes
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from starlette.datastructures import MutableHeaders
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from app import appeals
from app.checklists import seed_into_db
from app.db import migrate
from app.jobs import recover_interrupted, shutdown as stop_jobs
from app.errors import install_error_handlers
from app.routes import all_routers
from app.settings import get_settings

# Top-level packages of the other streams. Each may expose `<package>.router.router`
# (an APIRouter); it is mounted under settings.base_path once that module exists.
OPTIONAL_ROUTER_PACKAGES = ("evaluator", "audio", "quality")

_WILDCARD = "[A-Za-z0-9-]*"

# StaticFiles takes a file's content type from `mimetypes`, which on Windows also reads the
# registry, where another program may have registered `.css` or `.js` as something else (a
# stylesheet served as text/plain leaves the page unstyled). These are set at app creation.
UI_CONTENT_TYPES = (("text/javascript", ".js"), ("text/css", ".css"), ("image/svg+xml", ".svg"))


def default_web_dist() -> Path:
    """<repo>/web/dist, where the front-end build is committed."""
    return Path(__file__).resolve().parents[2] / "web" / "dist"


def split_cors_origins(origins: list[str]) -> tuple[list[str], str | None]:
    """Exact origins, plus one regex for the entries that contain `*`.

    In the regex every `*` stands for one DNS label fragment ([A-Za-z0-9-]*, so it never crosses
    a dot) and everything else is literal: `https://*.crm*.dynamics.com` matches
    `https://org1.crm4.dynamics.com`."""
    exact = [o for o in origins if "*" not in o]
    patterns = [re.escape(o).replace(r"\*", _WILDCARD) for o in origins if "*" in o]
    return exact, ("|".join(f"(?:{p})" for p in patterns) if patterns else None)


def content_security_policy(frame_ancestors: list[str]) -> str:
    ancestors = " ".join(frame_ancestors) or "'none'"  # an empty list must not mean "anyone"
    return "; ".join(
        [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "font-src 'self' data:",
            "media-src 'self'",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            f"frame-ancestors {ancestors}",
        ]
    )


class ContentSecurityPolicyMiddleware:
    """Adds the Content-Security-Policy header to every text/html response."""

    def __init__(self, app: ASGIApp, policy: str) -> None:
        self.app = app
        self.policy = policy

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_policy(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                if headers.get("content-type", "").lower().startswith("text/html"):
                    headers["Content-Security-Policy"] = self.policy
            await send(message)

        await self.app(scope, receive, send_with_policy)


class StaticUI:
    """Serves the built UI (web/dist) as the router's fallback for every path no API route took.

    It only answers GET and HEAD for paths outside `base_path`: anything else is the ordinary
    404 error, so an unknown API call looks the same with or without a UI build. The directory
    is checked per request, so building the UI while the server runs just works. Without a
    build, `/` explains that."""

    def __init__(self, directory: Path, base_path: str) -> None:
        self.directory = directory
        self.base_path = base_path  # "" when the API is mounted at the root
        self.files = StaticFiles(directory=directory, html=True, check_dir=False)

    def _is_api_path(self, path: str) -> bool:
        return bool(self.base_path) and (path == self.base_path or path.startswith(f"{self.base_path}/"))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "websocket":
            await WebSocketClose()(scope, receive, send)
            return
        if scope["method"] not in ("GET", "HEAD") or self._is_api_path(scope["path"]):
            raise HTTPException(status_code=404)
        if not self.directory.is_dir():
            if scope["path"] == "/":
                note = PlainTextResponse("UI not built. Run `npm run build` in web/.")
                await note(scope, receive, send)
                return
            raise HTTPException(status_code=404)
        await self.files(scope, receive, send)


def optional_routers() -> list[APIRouter]:
    """Routers of the other streams whose `<package>.router` module exists.

    A package or router module that is absent is skipped. One that exists but fails to import
    raises: a broken router must not be silently dropped."""
    routers: list[APIRouter] = []
    for package in OPTIONAL_ROUTER_PACKAGES:
        if importlib.util.find_spec(package) is None:
            continue
        if importlib.util.find_spec(f"{package}.router") is None:
            continue
        routers.append(importlib.import_module(f"{package}.router").router)
    return routers


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    migrate()
    seed_into_db()
    recover_interrupted()  # nothing runs yet: what a previous process left running was cut off
    appeals.recover_pending()  # likewise for second opinions
    yield
    await stop_jobs()
    await appeals.shutdown()


def create_app() -> FastAPI:
    settings = get_settings()
    for content_type, extension in UI_CONTENT_TYPES:
        mimetypes.add_type(content_type, extension)
    app = FastAPI(
        title="CQA backend",
        lifespan=lifespan,
        # Swagger and ReDoc pages pull scripts from a CDN, which the strict CSP blocks; the
        # schema itself stays available under the API base path.
        docs_url=None,
        redoc_url=None,
        openapi_url=f"{settings.base_path}/openapi.json",
    )
    install_error_handlers(app)

    for router in [*all_routers(), *optional_routers()]:
        app.include_router(router, prefix=settings.base_path)

    app.add_middleware(
        ContentSecurityPolicyMiddleware,
        policy=content_security_policy(settings.frame_ancestors),
    )
    exact_origins, origin_regex = split_cors_origins(settings.cors_origins)
    if exact_origins or origin_regex:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=exact_origins,
            allow_origin_regex=origin_regex,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    # The UI is the fallback (not a mount at "/"): a mount would swallow a wrong-method call
    # to an API route and answer 405 with the static files' Allow header.
    app.router.default = StaticUI(settings.web_dist or default_web_dist(), settings.base_path)
    return app
