"""The control hour in one command: import a group, evaluate it, write the organisers' results file.

    cd backend
    uv run cqa-serve                       # in another terminal: the server the UI uses
    uv run python -m quality.control_run --group <group_id> --out ../results/prod/results.json --expect 10

It drives the RUNNING server over HTTP, so the UI and this command share one database: what it
imports and evaluates shows up in the UI, and the results file is built from what the server
serves. The steps, each with a timestamped line:

1. `GET /config`: the server answers (and whether a model key is configured).
2. Import: `GET /datasets/{group}` (the organisers' API, through the server), or with
   `--from-json FILE` the file's records through `POST /conversations` into that same group
   (`{data: {records}}`, `{records}` or a bare list; `--limit N` keeps the first N, for a rehearsal).
3. `GET /conversations?group_id=` and a dry run of `POST /evaluations`: total, model calls, reused.
4. The job: `POST /evaluations`, then `GET /jobs/{id}` until it finishes; failed items are retried
   with `POST /jobs/{id}/retry` up to `--retries` times.
5. Export: `quality.results_export.build` and `validate`, reading the server through its API (never
   a guessed SQLite path: a server started from another directory may use another file).
6. The file is written, then every validation problem is printed.
7. The git commands to commit it are printed; this command never runs git.

Exit codes: 0 the file is valid and every record is `ok`; 1 the file was written but has problems,
`status: "error"` records, or the job timed out; 2 nothing was written (no server, the import or the
job could not start, no conversations in the group).

`--export-only` skips steps 2 to 4 (after a run made in the UI); `--skip-import` skips step 2 (the
group is already on the server). The organisers' URL never passes through this command (the server
holds it), and no line it prints carries a signed URL.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx

from app.models import Conversation, Evaluation, QueueItem
from app.redaction import redact_signed_urls
from app.settings import BACKEND_DIR, DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION, get_settings
from quality import results_export as rx

DEFAULT_HOST = "127.0.0.1"  # app.cli's defaults (not imported: that pulls in uvicorn and the app)
DEFAULT_PORT = 8000
DEFAULT_OUT = BACKEND_DIR.parent / "results" / "prod" / "results.json"
REQUEST_TIMEOUT_SECONDS = 120  # the server allows the organisers' API 60 s; an import adds its own work
FINISHED = ("done", "failed")

EXIT_OK, EXIT_PROBLEMS, EXIT_NOT_WRITTEN = 0, 1, 2


class RunFailed(Exception):
    """A step that stops the run before a file is written (exit code 2)."""


def default_base_url() -> str:
    return f"http://{DEFAULT_HOST}:{DEFAULT_PORT}{get_settings().base_path}"


def log(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {redact_signed_urls(message)}", flush=True)


def warn(message: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] WARNING {redact_signed_urls(message)}", file=sys.stderr, flush=True)


# --- the server's API --------------------------------------------------------------------------


class Api:
    """The few calls this command makes. Every failure is a RunFailed with the server's own
    `{error, message}` (or the transport error's type), never a URL with a signature."""

    def __init__(self, client: httpx.Client, base_url: str) -> None:
        self.client = client
        self.base = base_url.rstrip("/")

    def call(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self.client.request(method, f"{self.base}{path}", **kwargs)
        except httpx.TimeoutException:
            raise RunFailed(f"{method} {path}: the server did not answer in time.") from None
        except httpx.HTTPError as exc:
            raise RunFailed(f"{method} {path}: could not reach the server ({type(exc).__name__}).") from None
        if response.status_code >= 400:
            try:
                body = response.json()
                detail = f"{body.get('error')}: {body.get('message')}"
            except (ValueError, AttributeError):
                detail = "no JSON error body"
            raise RunFailed(f"{method} {path}: HTTP {response.status_code} {detail}")
        try:
            return response.json()
        except ValueError:
            raise RunFailed(f"{method} {path}: the answer is not JSON (is --base-url the API path?).") from None


class HttpStore:
    """What `results_export.build` needs from `app.store`, answered by the running server, so the
    file comes from exactly the data the UI shows. Evaluations are fetched per conversation of the
    group (each list newest first, which is all `pick_runs` relies on)."""

    def __init__(self, api: Api) -> None:
        self.api = api
        self._group: list[QueueItem] = []

    def list_conversations(self, *, group_id: str) -> list[QueueItem]:
        rows = self.api.call("GET", "/conversations", params={"group_id": group_id})
        self._group = [QueueItem.model_validate(row) for row in rows]
        return self._group

    def get_conversation(self, conversation: str) -> Conversation:
        return Conversation.model_validate(self.api.call("GET", f"/conversations/{quote(conversation, safe='')}"))

    def find_evaluations(self, *, checklist_id: str) -> list[Evaluation]:
        found: list[Evaluation] = []
        for conv in self._group:
            rows = self.api.call("GET", "/evaluations", params={"conversation": conv.id, "checklist_id": checklist_id})
            found.extend(Evaluation.model_validate(row) for row in rows)
        return found


class HttpGroup:
    """The group with transcripts, as `results_export.check_file(..., store=)` reads it (the queue
    rows of `GET /conversations` carry no transcript), so the file on disk is cross-checked against
    exactly the conversations the server holds, not a guessed SQLite file."""

    def __init__(self, store: HttpStore) -> None:
        self.store = store

    def list_conversations(self, *, group_id: str) -> list[Conversation]:
        return [self.store.get_conversation(c.id) for c in self.store.list_conversations(group_id=group_id)]


# --- the steps ---------------------------------------------------------------------------------


def check_server(api: Api) -> dict:
    try:
        config = api.call("GET", "/config")
    except RunFailed as exc:
        raise RunFailed(f"{exc} Is the server running? Start it with `cd backend && uv run cqa-serve`, "
                        f"or point --base-url at it.") from None
    if not isinstance(config, dict) or "model_key_configured" not in config:
        raise RunFailed("GET /config answered without model_key_configured: is --base-url the CQA API?")
    key = "configured" if config["model_key_configured"] else "NOT configured"
    log(f"Server {api.base} is up. Model key: {key}.")
    return config


def read_records(path: Path, limit: int | None) -> list[dict]:
    """The records of an organiser-style JSON file: `{data: {records}}`, `{records}` or a list."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise RunFailed(f"Cannot read {path} as JSON ({type(exc).__name__}).") from None
    if isinstance(data, dict):
        body = data["data"] if isinstance(data.get("data"), dict) else data
        records = body.get("records")
    else:
        records = data
    if not isinstance(records, list) or not records:
        raise RunFailed(f"{path} has no records (expected {{data: {{records}}}}, {{records}} or a list).")
    return records[:limit] if limit else records


def import_group(api: Api, group: str, from_json: Path | None, limit: int | None) -> None:
    if from_json is None:
        log(f"Importing group {group!r} from the organisers' API (through the server)...")
        summary = api.call("GET", f"/datasets/{quote(group, safe='')}")
    else:
        records = read_records(from_json, limit)
        log(f"Uploading {len(records)} record(s) from {from_json.name} as group {group!r}...")
        summary = api.call("POST", "/conversations", json={"records": records, "dataset_group_id": group})
    if summary.get("group_id") != group:
        raise RunFailed(f"The import went into group {summary.get('group_id')!r}, not {group!r}.")
    log(f"Imported: total {summary['total']}, new {summary['imported']}, updated {summary['updated']}, "
        f"unchanged {summary['unchanged']}.")


def list_group(api: Api, group: str, expect: int | None) -> list[str]:
    rows = api.call("GET", "/conversations", params={"group_id": group})
    ids = [row["id"] for row in rows]
    if not ids:
        raise RunFailed(f"The server has no conversations in group {group!r}. Import it first (or check --group).")
    channels: dict[str, int] = {}
    for row in rows:
        channels[row["channel"]] = channels.get(row["channel"], 0) + 1
    shown = ", ".join(f"{n} {c}" for c, n in sorted(channels.items()))
    log(f"Group {group!r}: {len(ids)} conversation(s) ({shown}).")
    if expect is not None and len(ids) != expect:
        warn(f"the group has {len(ids)} conversation(s), --expect says {expect}. Carrying on; "
             "the file will be flagged.")
    return ids


def plan(api: Api, ids: list[str], checklist_id: str, version: int, mode: str, key_configured: bool) -> dict:
    estimate = api.call("POST", "/evaluations", json={
        "conversations": ids, "checklist_id": checklist_id, "version": version, "mode": mode, "dry_run": True})
    log(f"Dry run {checklist_id} v{version}, mode {mode}: {estimate['total']} conversation(s), "
        f"{estimate['model_calls']} model call(s), {estimate['reused']} reused.")
    if estimate["model_calls"] and not key_configured:
        raise RunFailed(f"{estimate['model_calls']} model call(s) are needed and the server has no model key. "
                        "Set ANTHROPIC_API_KEY in backend/.env and restart the server.")
    return estimate


def _progress(job: dict) -> str:
    return f"job {job['id'][:8]} {job['status']}: {job['done']}/{job['total']} done, {job['failed']} failed"


def wait_for(api: Api, job_id: str, deadline: float, poll_seconds: float,
             sleep: Callable[[float], None], clock: Callable[[], float]) -> tuple[dict, bool]:
    """Poll the job until it is finished or the deadline passes: (the job, finished?). A line is
    printed when the counts change, and at least once a minute."""
    last, last_at = None, clock()
    while True:
        job = api.call("GET", f"/jobs/{quote(job_id, safe='')}")
        shown = (job["status"], job["done"], job["failed"])
        if shown != last or clock() - last_at >= 60:
            log(_progress(job))
            last, last_at = shown, clock()
        if job["status"] in FINISHED:
            return job, True
        if clock() >= deadline:
            return job, False
        sleep(poll_seconds)


def evaluate(api: Api, ids: list[str], args: argparse.Namespace,
             sleep: Callable[[float], None], clock: Callable[[], float]) -> tuple[dict, bool]:
    """Start the job, wait, retry failed items: (the last job state, finished in time?)."""
    job = api.call("POST", "/evaluations", json={
        "conversations": ids, "checklist_id": args.checklist_id, "version": args.version,
        "mode": args.mode, "role": args.role})
    log(f"Started job {job['id']} ({job['total']} conversation(s)).")
    deadline = clock() + args.timeout_minutes * 60
    job, finished = wait_for(api, job["id"], deadline, args.poll_seconds, sleep, clock)
    for attempt in range(1, args.retries + 1):
        if not finished or not job["failed"]:
            break
        for item in job["items"]:
            if item["status"] == "failed":
                log(f"  failed {item['conversation']}: {item.get('error') or 'no reason given'}")
        log(f"Retry {attempt}/{args.retries} of {job['failed']} failed item(s) as {args.role}...")
        try:
            api.call("POST", f"/jobs/{quote(job['id'], safe='')}/retry", json={"role": args.role})
        except RunFailed as exc:
            warn(f"the retry could not start: {exc}")
            break
        job, finished = wait_for(api, job["id"], deadline, args.poll_seconds, sleep, clock)
    if not finished:
        warn(f"the job did not finish within {args.timeout_minutes} min; unfinished dialogues go into "
             "the file as errors. Run again with --export-only once it has finished.")
    for item in job["items"]:
        if item["status"] == "failed":
            log(f"  still failed {item['conversation']}: {item.get('error') or 'no reason given'}")
    return job, finished


def export(api: Api, args: argparse.Namespace, job: dict | None) -> tuple[dict, list[str]]:
    store = HttpStore(api)
    doc = rx.build(store, args.group, args.checklist_id, args.version, team=args.team, mode=args.model_mode)
    if not doc["results"]:
        raise RunFailed(f"The server has no conversations in group {args.group!r}; nothing to export.")
    problems = rx.validate(doc, args.expect)
    if job is not None:  # every dialogue the job finished must be an ok record of the file
        by_id = {conv.id: conv.conversation_id for conv in store._group}
        status = {r["conversation_id"]: r["status"] for r in doc["results"]}
        for item in job["items"]:
            if item["status"] == "done" and status.get(by_id.get(item["conversation"])) != "ok":
                problems.append(f"{item['conversation']}: the job finished it but the file has no ok record")
    return doc, problems


def write(doc: dict, out: Path) -> None:
    text = json.dumps(doc, ensure_ascii=False, indent=2) + "\n"
    if "sig=" in text.lower():
        raise RunFailed("The results text contains 'sig=' (a signed URL?). Not written; check the rationales.")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")


def next_steps(out: Path, group: str) -> None:
    repo = BACKEND_DIR.parent
    try:
        shown = out.resolve().relative_to(repo.resolve())
    except ValueError:
        shown = out
    branch = f"results/control-{''.join(ch if ch.isalnum() or ch in '-_' else '-' for ch in group)}"
    print("\nNext (run these yourself, from the repository root):")
    print(f"  git switch -c {branch}")
    print(f"  git add {shown}")
    print(f'  git commit -m "results: control set {group}"')
    print(f"  git push -u origin {branch}")
    print(f'  gh pr create --title "results: control set {group}" --body "results/prod/results.json for the '
          f'control group {group}, validated by quality.control_run."')


# --- command line -------------------------------------------------------------------------------


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="python -m quality.control_run", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--group", required=True, help="the organisers' group_id (the group to import into)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"results file (default {DEFAULT_OUT})")
    parser.add_argument("--expect", type=int, help="the number of records the file must have (10 for the control set)")
    parser.add_argument("--base-url", default=None, help="the server's API (default http://127.0.0.1:8000 plus BASE_PATH)")
    parser.add_argument("--from-json", type=Path, help="upload this organiser-style JSON instead of calling their API")
    parser.add_argument("--limit", type=int, help="with --from-json: only the first N records (rehearsal)")
    parser.add_argument("--skip-import", action="store_true", help="the group is already on the server")
    parser.add_argument("--export-only", action="store_true", help="no import, no evaluation: write the file")
    parser.add_argument("--checklist-id", default=DEFAULT_CHECKLIST_ID)
    parser.add_argument("--version", type=int, default=DEFAULT_CHECKLIST_VERSION)
    parser.add_argument("--mode", choices=("reuse", "full"), default="reuse")
    parser.add_argument("--role", choices=("controller", "reviewer"), default="controller")
    parser.add_argument("--poll-seconds", type=float, default=3.0)
    parser.add_argument("--timeout-minutes", type=float, default=40.0)
    parser.add_argument("--retries", type=int, default=1, help="retries of the failed items (default 1)")
    parser.add_argument("--team", default="gtbsbe")
    parser.add_argument("--model-mode", choices=rx.MODES, default="external_api", help="results file model.mode")
    args = parser.parse_args(argv)
    if args.limit is not None and (args.limit < 1 or args.from_json is None):
        parser.error("--limit needs --from-json and a number of at least 1")
    if args.from_json is not None and (args.skip_import or args.export_only):
        parser.error("--from-json imports; it cannot go with --skip-import or --export-only")
    if args.retries < 0 or args.poll_seconds < 0 or args.timeout_minutes <= 0:
        parser.error("--retries and --poll-seconds must be 0 or more, --timeout-minutes more than 0")
    if args.base_url is None:
        args.base_url = default_base_url()
    return args


def main(argv: list[str] | None = None, *, client: httpx.Client | None = None,
         sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic) -> int:
    args = parse_args(argv)
    own = client is None
    http = client if client is not None else httpx.Client(timeout=REQUEST_TIMEOUT_SECONDS)
    api = Api(http, args.base_url)
    try:
        config = check_server(api)
        if not (args.skip_import or args.export_only):
            import_group(api, args.group, args.from_json, args.limit)
        ids = list_group(api, args.group, args.expect)
        job, finished = None, True
        if not args.export_only:
            plan(api, ids, args.checklist_id, args.version, args.mode, bool(config["model_key_configured"]))
            job, finished = evaluate(api, ids, args, sleep, clock)
        log("Exporting from the server...")
        doc, problems = export(api, args, job)
        write(doc, args.out)
        # Re-read the file as written (strict JSON, no secrets, the appendix's rules) and cross-check
        # its ids and evidence turns against the group on the server: what gets pushed is this file.
        log("Checking the written file against the server's group...")
        problems += [p for p in rx.check_file(args.out, args.expect, group=args.group,
                                              store=HttpGroup(HttpStore(api))) if p not in problems]
    except RunFailed as exc:
        print(f"[{datetime.now():%H:%M:%S}] FAILED {redact_signed_urls(str(exc))}", file=sys.stderr, flush=True)
        return EXIT_NOT_WRITTEN
    finally:
        if own:
            http.close()

    errors = [r for r in doc["results"] if r["status"] == "error"]
    log(f"Wrote {args.out.resolve()}: {len(doc['results'])} record(s), {len(doc['results']) - len(errors)} ok, "
        f"{len(errors)} error(s), model {doc['model']['name']}.")
    for r in errors:
        log(f"  error {r['conversation_id']}: {r['error']}")
    for p in problems:
        print(f"  PROBLEM {redact_signed_urls(p)}", file=sys.stderr, flush=True)
    if problems or errors or not finished:
        reasons = [what for what, bad in (("validation problems", problems), ("error records", errors),
                                          ("job timed out", not finished)) if bad]
        log(f"NOT READY: {', '.join(reasons)}. The file keeps every record as it is; fix and run again "
            "(--export-only re-exports without new model calls), or commit it as it is if time is up.")
        next_steps(args.out, args.group)
        return EXIT_PROBLEMS
    log("Valid: every record is ok.")
    next_steps(args.out, args.group)
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
