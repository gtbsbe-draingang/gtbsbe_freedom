"""Export evaluations as the organisers' results file (appendix «Как сдать результаты», JSON 1.0).

    uv run python -m quality.results_export --group DEV --out ../results/dev/results.json --expect 65
    uv run python -m quality.results_export --group <control group> --out ../results/prod/results.json --expect 10

One record per conversation of the group, in the group's order, under the organisers' original
`conversation_id`. A conversation's record comes from its newest finished run of the checklist
version with `source=model`; a mock run never counts. A conversation without one gets
`status: "error"` with the reason, never a made-up score. Values are the model's own answers
(`--answers final` takes the answers after appeals instead). `evidence_turns` are 1-based
positions in the original transcript array, events included. The file is validated before it is
written: every rule of the appendix, plus a recomputation of each final score from the values.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction
from pathlib import Path

SCHEMA_VERSION = "1.0"
CODES = {"c01": "contact", "c02": "discovery", "c03": "identification", "c04": "consultation",
         "c05": "empathy", "c06": "dialogue", "c07": "closure", "c08": "critical"}
# The appendix's table: allowed values, and the weight and top of the scale for the score check.
ALLOWED = {
    "contact": ({True, False}, 10, None), "discovery": ({True, False, None}, 15, None),
    "identification": ({True, False, None}, 20, None), "consultation": ({0, 5, 10, 15, 20, None}, 20, 20),
    "empathy": ({True, False}, 15, None), "dialogue": ({0, 4, 7, 10}, 15, 10),
    "closure": ({True, False, None}, 5, None), "critical": ({True, False}, 0, None),
}
MODES = ("local", "external_api", "hybrid")


def value(answer):
    if answer == "yes":
        return True
    if answer == "no":
        return False
    if answer == "na":
        return None
    return int(answer.step if hasattr(answer, "step") else answer["step"])


def pick_runs(store, checklist_id: str, version: int, conversations: set[str]) -> dict:
    """{conversation: newest done model run, else newest run of any other kind (for its status)}."""
    done, other = {}, {}
    for e in store.find_evaluations(checklist_id=checklist_id):  # newest first
        if e.version != version or e.conversation not in conversations:
            continue
        if e.status == "done" and e.source == "model":
            done.setdefault(e.conversation, e)
        else:
            other.setdefault(e.conversation, e)
    return {c: done.get(c) or other.get(c) for c in conversations if c in done or c in other}


def error(conversation_id: str, reason: str) -> dict:
    return {"conversation_id": conversation_id, "status": "error", "criteria": [], "score": None, "error": reason}


def record(conv, run, answers: str = "original") -> tuple[dict, set[str]]:
    if run is None:
        return error(conv.conversation_id, "Диалог не оценён: нет запуска модели по этому чек-листу."), set()
    if run.source != "model":
        return error(conv.conversation_id, "Есть только демо-оценка (мок), результата модели нет."), set()
    if run.status != "done":
        reason = {"failed": "Оценка завершилась ошибкой.", "queued": "Оценка ещё в очереди.",
                  "running": "Оценка ещё выполняется."}.get(run.status, f"Оценка в статусе {run.status}.")
        return error(conv.conversation_id, reason), set()
    by_id = {r.criterion_id: r for r in run.results}
    missing = [cid for cid in CODES if cid not in by_id]
    if missing:
        return error(conv.conversation_id, f"Нет результата по критериям: {', '.join(missing)}."), set()
    criteria, models = [], set()
    turns = len(conv.transcript)
    for cid, code in CODES.items():
        r = by_id[cid]
        answer = r.final_answer if answers == "final" and r.final_answer is not None else r.answer
        evidence = sorted({e.message_index + 1 for e in r.evidence if 0 <= e.message_index < turns})
        criteria.append({"criterion_id": code, "value": value(answer),
                         "rationale": " ".join((r.explanation or "").split()), "evidence_turns": evidence})
        if r.model:
            models.add(r.model)
    total = run.final_total if answers == "final" else run.original_total
    critical = criteria[-1]["value"]
    score = {"final_score": None if total is None else float(Decimal(str(total)).quantize(Decimal("0.01"), ROUND_HALF_UP)),
             "critical_flag": critical}
    if run.model:
        models.add(run.model)
    return {"conversation_id": conv.conversation_id, "status": "ok", "criteria": criteria, "score": score}, models


def expected_score(criteria: list[dict]) -> float | None:
    """The appendix's procedure: N/A drops out, weights rescale to 100, half-up to 2 decimals."""
    earned, applicable = Fraction(0), Fraction(0)
    for c in criteria:
        _, weight, top = ALLOWED[c["criterion_id"]]
        v = c["value"]
        if weight == 0 or v is None:
            continue
        applicable += weight
        earned += weight * (Fraction(v, top) if top else Fraction(int(v is True)))
    if applicable == 0:
        return None
    exact = earned * 100 / applicable
    return float((Decimal(exact.numerator) / Decimal(exact.denominator)).quantize(Decimal("0.01"), ROUND_HALF_UP))


def allowed_value(code: str, v) -> bool:
    """Type-aware: in Python 0 == False, so a plain `in` would accept false for a scale."""
    allowed = ALLOWED[code][0]
    if v is None:
        return None in allowed
    yes_no = any(isinstance(a, bool) for a in allowed)
    if isinstance(v, bool):
        return yes_no
    if isinstance(v, int):
        return not yes_no and v in allowed
    return False


def validate(doc: dict, expect: int | None = None, check_scores: bool = True) -> list[str]:
    problems = []
    if doc.get("schema_version") != SCHEMA_VERSION:
        problems.append("schema_version must be \"1.0\"")
    if not isinstance(doc.get("team_name"), str) or not doc["team_name"].strip():
        problems.append("team_name is empty")
    model = doc.get("model") or {}
    if model.get("mode") not in MODES or not str(model.get("name") or "").strip():
        problems.append("model needs mode (local, external_api or hybrid) and name")
    results = doc.get("results")
    if not isinstance(results, list):
        return problems + ["results must be a list"]
    ids = [r.get("conversation_id") for r in results]
    if len(set(ids)) != len(ids):
        problems.append("duplicate conversation_id")
    if expect is not None and len(results) != expect:
        problems.append(f"{len(results)} records, expected {expect}")
    for r in results:
        cid = r.get("conversation_id")
        if not isinstance(cid, str) or not cid:
            problems.append("a record has no conversation_id")
            continue
        if r.get("status") == "error":
            if r.get("criteria") != [] or r.get("score") is not None or not r.get("error"):
                problems.append(f"{cid}: an error record needs empty criteria, score null and an error text")
            continue
        if r.get("status") != "ok":
            problems.append(f"{cid}: status must be ok or error")
            continue
        crit = r.get("criteria") or []
        codes = [c.get("criterion_id") for c in crit]
        if sorted(codes) != sorted(ALLOWED):
            problems.append(f"{cid}: needs each of the 8 criteria exactly once")
            continue
        for c in crit:
            if not allowed_value(c["criterion_id"], c.get("value")):
                problems.append(f"{cid}: {c['criterion_id']} value {c.get('value')!r} not allowed")
            if not isinstance(c.get("rationale"), str) or not isinstance(c.get("evidence_turns"), list) \
                    or not all(isinstance(t, int) and not isinstance(t, bool) and t >= 1 for t in c["evidence_turns"]):
                problems.append(f"{cid}: {c['criterion_id']} needs a rationale and 1-based evidence_turns")
        score = r.get("score") or {}
        fs = score.get("final_score")
        critical = next(c["value"] for c in crit if c["criterion_id"] == "critical")
        if score.get("critical_flag") is not critical:
            problems.append(f"{cid}: critical_flag must equal the critical value")
        if fs is not None and (not isinstance(fs, (int, float)) or isinstance(fs, bool) or not 0 <= fs <= 100
                               or round(fs, 2) != fs):
            problems.append(f"{cid}: final_score must be 0 to 100 with two decimals")
        elif check_scores and fs != expected_score(crit):
            problems.append(f"{cid}: final_score {fs} differs from the values ({expected_score(crit)})")
    return problems


def build(store, group_id: str, checklist_id: str, version: int, *, team: str, mode: str,
          answers: str = "original") -> dict:
    convs = store.list_conversations(group_id=group_id)
    runs = pick_runs(store, checklist_id, version, {c.id for c in convs})
    results, models = [], set()
    for conv in convs:
        full = store.get_conversation(conv.id)  # with its transcript, for the turn range
        rec, used = record(full, runs.get(conv.id), answers)
        results.append(rec)
        models |= used
    return {"schema_version": SCHEMA_VERSION, "team_name": team,
            "model": {"mode": mode, "name": ", ".join(sorted(models)) or "нет результатов модели"},
            "results": results}


# --- from an evaluator.devrun report --------------------------------------------------------
# The DEV run of 7 November (PR #60) saved answers and explanations but not the evidence list.
# Its explanations cite lines by their 0-based transcript index («сообщение 4», «реплика [9]»,
# «(индекс 9)», «сообщения 13, 16, 18», «(21, 23)»); those citations become evidence_turns.

_NUMS = r"\[?\d+\]?(?:\s*(?:,|и|and|-|–|—)\s*\[?\d+\]?)*"
_CITES = [
    re.compile(rf"(?:реплик\w*|сообщени\w*|индекс\w*|строк\w*|message\w*|turn\w*|line\w*)\s*№?\s*({_NUMS})", re.I),
    re.compile(r"\[(\d+)\]"),
    re.compile(r"\((\d+(?:\s*(?:,|и|-|–)\s*\d+)*)\)"),
]


def turns_from_text(text: str, n_lines: int) -> list[int]:
    """1-based turns for the 0-based line numbers an explanation cites; numbers out of range are dropped."""
    found: set[int] = set()
    for pattern in _CITES:
        for match in pattern.finditer(text or ""):
            part = match.group(1)
            for a, dash, b in re.findall(r"(\d+)\]?\s*([-–—]?)\s*\[?(\d*)", part):
                lo = int(a)
                hi = int(b) if dash and b and 0 <= int(b) - lo <= 15 else lo
                found.update(range(lo, hi + 1))
    return sorted(i + 1 for i in found if 0 <= i < n_lines)


def from_devrun(report: dict, records: list[dict], *, team: str, mode: str) -> dict:
    """The results file from an evaluator.devrun report plus the dataset it ran on (for ids and turns)."""
    runs = report.get("conversations", {})
    results, models = [], set()
    for rec in records:
        cid = rec["conversation_id"]
        run = runs.get(f"{rec.get('group_id', 'DEV')}:{cid}") or runs.get(f"DEV:{cid}") or runs.get(cid)
        if run is None:
            results.append(error(cid, "Диалог не оценён в этом запуске."))
            continue
        by_id = {r["criterion_id"]: r for r in run.get("results", [])}
        failed = [f.get("criterion_id") for f in run.get("failures", [])]
        missing = [k for k in CODES if k not in by_id]
        if missing or failed:
            results.append(error(cid, f"Нет результата модели по критериям: {', '.join(missing or failed)}."))
            continue
        n_lines = len(rec["transcript"])
        criteria = []
        for k, code in CODES.items():
            r = by_id[k]
            evidence = [e["message_index"] + 1 for e in r.get("evidence") or [] if 0 <= e["message_index"] < n_lines]
            criteria.append({"criterion_id": code, "value": value(r["answer"]),
                             "rationale": " ".join((r.get("explanation") or "").split()),
                             "evidence_turns": sorted(set(evidence)) or turns_from_text(r.get("explanation", ""), n_lines)})
            if r.get("model"):
                models.add(r["model"])
        results.append({"conversation_id": cid, "status": "ok", "criteria": criteria,
                        "score": {"final_score": expected_score(criteria), "critical_flag": criteria[-1]["value"]}})
    if report.get("model"):
        models.add(report["model"])
    return {"schema_version": SCHEMA_VERSION, "team_name": team,
            "model": {"mode": mode, "name": ", ".join(sorted(models)) or "нет результатов модели"},
            "results": results}


def main(argv: list[str] | None = None) -> int:
    from app.settings import DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--group", help="group_id as imported, e.g. DEV (reads the app's store)")
    parser.add_argument("--from-devrun", type=Path, help="an evaluator.devrun --out report instead of the store")
    parser.add_argument("--dev", type=Path, help="the dataset JSON the devrun report was made from")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--checklist-id", default=DEFAULT_CHECKLIST_ID)
    parser.add_argument("--version", type=int, default=DEFAULT_CHECKLIST_VERSION)
    parser.add_argument("--team", default="gtbsbe")
    parser.add_argument("--mode", choices=MODES, default="external_api")
    parser.add_argument("--answers", choices=("original", "final"), default="original")
    parser.add_argument("--expect", type=int, help="the number of records the file must have (65 DEV, 10 prod)")
    args = parser.parse_args(argv)

    if args.from_devrun:
        if not args.dev:
            parser.error("--from-devrun needs --dev")
        data = json.loads(args.dev.read_text(encoding="utf-8"))
        records = data["data"]["records"] if isinstance(data.get("data"), dict) else data.get("records", data)
        doc = from_devrun(json.loads(args.from_devrun.read_text(encoding="utf-8")), records,
                          team=args.team, mode=args.mode)
    else:
        if not args.group:
            parser.error("give --group (store) or --from-devrun with --dev")
        from app import store
        from app.db import migrate

        migrate()
        doc = build(store, args.group, args.checklist_id, args.version, team=args.team, mode=args.mode,
                    answers=args.answers)
        if not doc["results"]:
            print(f"No conversations in group {args.group!r}; import it first.", file=sys.stderr)
            return 1
    problems = validate(doc, args.expect)
    errors = [r for r in doc["results"] if r["status"] == "error"]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{args.out}: {len(doc['results'])} records, {len(errors)} errors, model {doc['model']['name']}")
    for r in errors[:20]:
        print(f"  error {r['conversation_id']}: {r['error']}")
    for p in problems:
        print(f"  PROBLEM {p}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
