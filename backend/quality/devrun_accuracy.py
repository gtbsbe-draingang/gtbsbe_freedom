"""Agreement of an evaluator.devrun report with our reference answers (#73).

    uv run python -m quality.devrun_accuracy --from-devrun <run>.json --dev ../data/dev.json \\
        --out ../data/reference/agreement-dev-2026-11-07.json

Uses `quality.accuracy.accuracy_report`, the same code as `/api/reports/accuracy`: disputed labels
are left out and counted, a missing answer is counted as missing, never as a disagreement.

The 7 November run graded the official checklist v1; the references are written for
`official-chat` v2. v2 is v1 plus guidance on c01, c03, c06 and c07, and every label that guidance
affects is disputed (#25), so the undisputed labels mean the same under both versions. The run is
therefore compared with the undisputed labels as if it were a v2 run; the output says so.
"""
from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from app.checklists import OFFICIAL_SEED, load_seed
from app.models import Conversation, CriterionResult, Evaluation
from quality.accuracy import accuracy_report, load_reference

REFERENCE = Path(__file__).resolve().parents[2] / "data" / "reference" / "dev_labels.json"


def evaluations_from_devrun(report: dict, records: list[dict], checklist_id: str, version: int) -> list[Evaluation]:
    out = []
    for rec in records:
        run = report.get("conversations", {}).get(f"DEV:{rec['conversation_id']}")
        if run is None:
            continue
        results = [CriterionResult(criterion_id=r["criterion_id"], answer=r["answer"], kinds=r.get("kinds") or [],
                                   explanation=r.get("explanation") or "", confidence=r.get("confidence") or "medium",
                                   model=r.get("model"), points=None, effective_weight=None)
                   for r in run.get("results", [])]
        out.append(Evaluation(id=f"devrun:{rec['conversation_id']}", created_at=datetime(2026, 11, 7, tzinfo=UTC),
                              conversation=f"DEV:{rec['conversation_id']}", checklist_id=checklist_id,
                              version=version, status="done", source="model", model=report.get("model"),
                              results=results))
    return out


def conversations_from(records: list[dict]) -> dict[str, Conversation]:
    return {f"DEV:{r['conversation_id']}": Conversation(
        id=f"DEV:{r['conversation_id']}", conversation_id=r["conversation_id"], group_id="DEV",
        channel=r["channel"], language=r["language"], transcript=[]) for r in records}


def build(report: dict, records: list[dict], reference_path: Path = REFERENCE) -> dict:
    reference = load_reference(reference_path)
    evaluations = evaluations_from_devrun(report, records, reference.checklist_id, reference.version)
    result = accuracy_report(reference, evaluations, conversations=conversations_from(records),
                             checklist=load_seed(OFFICIAL_SEED))
    totals = report.get("totals", {})
    return {
        "what": "Agreement of the model's answers with our reference answers, not with organiser ground truth.",
        "run": {"date": "2026-11-07", "source": "evaluator.devrun, PR #60", "checklist": "official-chat v1",
                "conversations": len(evaluations), "calls": totals.get("calls"), "failures": totals.get("failures"),
                "cost_usd": totals.get("cost_usd")},
        "references": {"file": "data/reference/dev_labels.json", "checklist": f"{reference.checklist_id} v{reference.version}",
                       "labels": len(reference.labels), "status": "drafts; team review pending (#73)"},
        "version_note": ("The run graded v1; the references are for v2, which only adds guidance on c01, c03, c06 "
                         "and c07. Every label that guidance affects is disputed and excluded, so the undisputed "
                         "labels are compared as they stand."),
        "report": result.model_dump(),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-devrun", type=Path, required=True)
    parser.add_argument("--dev", type=Path, required=True)
    parser.add_argument("--reference", type=Path, default=REFERENCE)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    data = json.loads(args.dev.read_text(encoding="utf-8"))
    records = data["data"]["records"] if isinstance(data.get("data"), dict) else data.get("records", data)
    doc = build(json.loads(args.from_devrun.read_text(encoding="utf-8")), records, args.reference)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    r = doc["report"]
    print(f"overall {r['overall']['agreement']} on {r['overall']['n']} labels; "
          f"{r['disputed_excluded']} disputed excluded, {r['missing']} missing, {len(r['disagreements'])} disagreements")
    for row in r["by_criterion"]:
        print(f"  {row['criterion_id']} {row['agreement']} (n={row['n']})")
    for row in r["by_language"] + r["by_channel"]:
        print(f"  {row.get('language') or row.get('channel')} {row['agreement']} (n={row['n']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
