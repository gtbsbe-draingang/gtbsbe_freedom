"""Build the jury snapshot from a saved evaluator.devrun report, with no model calls (#15).

    uv run python -m quality.snapshot_from_run --from-devrun <run>.json --dev ../data/dev.json \\
        [--out ../data/snapshot/cqa-snapshot.json]

The 65-dialogue DEV run of 7 November (PR #60, Claude Haiku 5.5, official checklist v1) is
replayed through the app's own path: the importer stores the dataset, `jobs.start_job` runs one
evaluation per dialogue with a replay evaluator in place of the model, the app scores and stores
it (points, sections, totals, gross error) and caches each judgment under the real evaluator's
reuse key, so a later run with a key reuses them, and `snapshot.export_snapshot` writes the file
(it refuses any signed URL). Nothing calls the model API.

What the replay adds to the saved run, and says so: that run kept no evidence list, so each
criterion's evidence is the lines its explanation cites, quoted from the transcript; its per
dialogue cost is split evenly over the criteria so totals stay exact. Dialogue info comes from
the run as saved.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from decimal import Decimal
from pathlib import Path

MAX_EVIDENCE = 6


def _records(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data["data"]["records"] if isinstance(data.get("data"), dict) else data.get("records", data)


class ReplayEvaluator:
    """Answers from a devrun report; the reuse key is the real evaluator's, so caches line up."""

    class ModelKeyMissing(Exception):
        pass

    class JudgmentFailed(Exception):
        reason = "not in the saved run"
        retryable = False

    def __init__(self, report: dict, transcripts: dict[str, list[dict]]):
        import evaluator

        self._real = evaluator
        self.runs = report["conversations"]
        self.transcripts = transcripts
        self.model = report.get("model") or "claude-haiku-5-5"

    def reuse_key(self, conv, checklist, criterion, model):
        return self._real.reuse_key(conv, checklist, criterion, model)

    def _run(self, conv) -> dict:
        run = self.runs.get(conv.id) or self.runs.get(f"DEV:{conv.conversation_id}")
        if run is None:
            raise self.JudgmentFailed()
        return run

    async def judge_criterion(self, conv, checklist, criterion, *, model):
        from app.models import Evidence, Judgment, LLMCallRecord
        from quality.results_export import turns_from_text

        run = self._run(conv)
        row = next((r for r in run["results"] if r["criterion_id"] == criterion.id), None)
        if row is None:
            raise self.JudgmentFailed()
        lines = self.transcripts[conv.conversation_id]
        cited = [t - 1 for t in turns_from_text(row.get("explanation", ""), len(lines))][:MAX_EVIDENCE]
        evidence = [Evidence(message_index=i, quote=lines[i]["text"][:160], role="supports")
                    for i in cited if lines[i]["text"].strip()]
        share = (Decimal(str(run.get("cost_usd") or "0")) / max(1, len(run["results"]))).quantize(Decimal("0.000001"))
        return Judgment(
            criterion_id=criterion.id, answer=row["answer"], kinds=row.get("kinds") or [],
            explanation=row.get("explanation") or "", evidence=evidence, na_reason=row.get("na_reason"),
            confidence=row.get("confidence") or "medium", needs_review=bool(row.get("needs_review")),
            coaching=row.get("coaching"), model=row.get("model") or self.model, reuse_key="",
            calls=[LLMCallRecord(purpose="criterion", model=row.get("model") or self.model, input_tokens=0,
                                 output_tokens=0, cost_usd=share, latency_ms=0)],
        )

    async def dialog_info(self, conv):
        from app.models import DialogInfo

        info = self._run(conv).get("info")
        if not info:
            raise self.JudgmentFailed()
        return DialogInfo.model_validate(info), []

    async def second_opinion(self, *args, **kwargs):
        raise self.ModelKeyMissing()


async def build(report: dict, records: list[dict], out: Path) -> dict:
    from app import jobs, store
    from app.checklists import seed_into_db
    from app.db import migrate
    from app.evaluator_port import reset_evaluator, set_evaluator
    from app.importer import import_records
    from app.snapshot import export_snapshot
    from app.settings import DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION
    from quality.results_export import expected_score, value, CODES

    migrate()
    seed_into_db()
    summary = await import_records(records, "DEV")
    print(f"imported: {summary.model_dump()}", file=sys.stderr)
    set_evaluator(ReplayEvaluator(report, {r["conversation_id"]: r["transcript"] for r in records}))
    try:
        ids = [f"DEV:{r['conversation_id']}" for r in records]
        job = await jobs.start_job(ids, DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION, "reuse", "controller")
        await jobs.wait_for_job(job.id)
    finally:
        reset_evaluator()
    evaluations = store.list_evaluations(DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION, group_id="DEV")
    mismatched = []
    for e in evaluations:
        crit = [{"criterion_id": CODES[r.criterion_id], "value": value(r.answer)} for r in e.results]
        want = expected_score(crit)
        got = None if e.original_total is None else float(Decimal(str(e.original_total)).quantize(Decimal("0.01")))
        if got != want:
            mismatched.append((e.conversation, got, want))
    cost = sum((Decimal(str(e.cost_usd)) for e in evaluations), Decimal(0))
    print(f"evaluations done: {len(evaluations)} of {len(ids)}; total mismatches {mismatched}; cost {cost}", file=sys.stderr)
    if len(evaluations) != len(ids) or mismatched:
        raise SystemExit("snapshot not written: missing evaluations or totals that differ from the run")
    return export_snapshot(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-devrun", type=Path, required=True)
    parser.add_argument("--dev", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[2] / "data" / "snapshot" / "cqa-snapshot.json")
    args = parser.parse_args(argv)
    report = json.loads(args.from_devrun.read_text(encoding="utf-8"))
    records = _records(args.dev)
    with tempfile.TemporaryDirectory(prefix="cqa-snapshot-") as tmp:
        os.environ["DB_PATH"] = str(Path(tmp) / "build.db")
        os.environ["CQA_AUDIO_ALIGNMENT"] = "off"  # the snapshot drops call audio anyway
        # start_job asks for a key before any model call; the replay makes none, and nothing
        # about this placeholder is stored or exported.
        os.environ["ANTHROPIC_API_KEY"] = "replay-no-model-calls"
        from app.settings import Settings, get_settings

        Settings.model_config["env_file"] = None  # never read a developer .env here
        get_settings.cache_clear()
        doc = asyncio.run(build(report, records, args.out))
    counts = {k: len(v) for k, v in doc.items() if isinstance(v, list)}
    print(f"wrote {args.out}: {counts}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
