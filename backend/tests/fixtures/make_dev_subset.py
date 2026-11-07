"""Build tests/fixtures/dev_subset.json: six DEV records for the transcript tests.

The fixture is committed because CI has no data/dev.json (the organisers' data is never
committed). Every record's `audio_url` is a signed URL (a secret), so it is replaced by None and
the script refuses to write anything that still contains a `sig=` query parameter.

Usage (from backend/):
    uv run python tests/fixtures/make_dev_subset.py [path/to/dev.json]

The default input is data/dev.json at the repository root. In a git worktree that file does not
exist (it is gitignored), so pass the main checkout's path as the argument.
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]  # backend/tests/fixtures -> repo root
DEFAULT_INPUT = REPO_ROOT / "data" / "dev.json"
OUTPUT = HERE / "dev_subset.json"

KEEP = [
    "p1-ru-001",
    "p1-ru-010",
    "p1-ru-012",
    "p1-ru-018",
    "p1-ru-025",
    "p4-ru-001",
]


def load_records(path: Path) -> list[dict]:
    """The organisers' full response ({error, isSuccess, data: {records}}) or a bare list."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]
    if isinstance(data, dict):
        data = data.get("records")
    if not isinstance(data, list):
        raise SystemExit("unrecognised shape: expected a list of records or a {data: {records}} response")
    return data


def main(argv: list[str]) -> None:
    source = Path(argv[1]) if len(argv) > 1 else DEFAULT_INPUT
    if not source.is_file():
        raise SystemExit(f"{source} not found; pass the path of data/dev.json as the first argument")
    by_id = {record["conversation_id"]: record for record in load_records(source)}
    missing = [cid for cid in KEEP if cid not in by_id]
    if missing:
        raise SystemExit(f"records missing from the input: {', '.join(missing)}")

    subset = [{**by_id[cid], "audio_url": None} for cid in KEEP]
    text = json.dumps(subset, ensure_ascii=False, indent=2) + "\n"
    assert "sig=" not in text, "a signed URL is still in the output"
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"wrote {len(subset)} records to {OUTPUT.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main(sys.argv)
