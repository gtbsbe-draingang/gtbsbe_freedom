"""Export evaluations as the organisers' results file (appendix «Как сдать результаты», JSON 1.0).

    uv run python -m quality.results_export --group DEV --out ../results/dev/results.json --expect 65
    uv run python -m quality.results_export --group <control group> --out ../results/prod/results.json --expect 10
    uv run python -m quality.results_export --check ../results/prod/results.json --expect 10 [--group G] [--dev PATH]

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


# --- checking a file already written (--check) -------------------------------------------------
# validate() sees a parsed dict; these also see the bytes (UTF-8, no BOM, strict JSON), secrets
# that must never be pushed, and the conversations the file should cover (a group or a dataset).

_BOMS = (b"\xef\xbb\xbf", b"\xff\xfe", b"\xfe\xff")
_SIGNED = re.compile(r"sig=", re.I)
_URL_WITH_QUERY = re.compile(r"https?://[^\s\"'<>]*\?", re.I)


def _redact(text: str) -> str:
    """A problem message with any URL with a query or `sig=` value masked (ids and keys are echoed)."""
    text = re.sub(r"https?://[^\s\"'<>]*\?\S*", "[URL redacted]", text, flags=re.I)
    return re.sub(r"sig=[^\s&,;'\"]*", "sig=[redacted]", text, flags=re.I)


def read_strict(path: Path) -> tuple[object, list[str]]:
    """(the parsed document, problems): UTF-8 without a BOM, strict JSON (no NaN, Infinity or
    out-of-range numbers, no duplicate keys, no lone surrogates), an object at the top."""
    try:
        raw = Path(path).read_bytes()
    except OSError as e:
        return None, [f"cannot read the file: {e.strerror or e}"]
    if raw.startswith(_BOMS):
        return None, ["the file starts with a byte order mark (BOM); save it as UTF-8 without a BOM"]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        return None, [f"not UTF-8: invalid byte at offset {e.start}"]
    duplicates: list[str] = []

    def pairs(items):
        seen = set()
        for key, _ in items:
            if key in seen:
                duplicates.append(key)
            seen.add(key)
        return dict(items)

    def no_constant(name):
        raise ValueError(f"{name} is not JSON")

    def finite(number):
        f = float(number)
        if f in (float("inf"), float("-inf")):
            raise ValueError(f"{number} is out of range for a JSON number")
        return f

    try:
        doc = json.loads(text, object_pairs_hook=pairs, parse_constant=no_constant, parse_float=finite)
    except json.JSONDecodeError as e:
        return None, [f"not valid JSON: {e.msg} at line {e.lineno} column {e.colno}"]
    except ValueError as e:
        return None, [f"not strict JSON: {e}"]
    problems = [f"duplicate key {k[:80]!r} in an object" for k in dict.fromkeys(duplicates)]
    for where, s in _strings(doc):
        try:
            s.encode("utf-8")
        except UnicodeEncodeError:
            problems.append(f"{where}: a lone surrogate escape, not valid Unicode")
    if not isinstance(doc, dict):
        problems.append("the top level must be a JSON object")
    return doc, problems


def _strings(node, where: str = "$"):
    """Every string in a parsed document, keys included, with where it sits ($.results[3].error)."""
    if isinstance(node, str):
        yield where, node
    elif isinstance(node, list):
        for i, item in enumerate(node):
            yield from _strings(item, f"{where}[{i}]")
    elif isinstance(node, dict):
        for key, item in node.items():
            yield f"{where} (a key)", key
            yield from _strings(item, f"{where}.{key}")


def secret_problems(doc) -> list[str]:
    """Places holding a signed link (`sig=`) or any URL with a query string. Only the place is
    reported, never the text: it may be a real signed URL."""
    return [f"{where}: contains a signed link or a URL with a query string; remove it"
            for where, s in _strings(doc) if _SIGNED.search(s) or _URL_WITH_QUERY.search(s)]


def shape_problems(doc: dict) -> list[str]:
    """The JSON types validate() relies on; it would crash on a record or criterion that is not an object."""
    problems = []
    if "model" in doc and not isinstance(doc["model"], dict):
        problems.append("model must be an object")
    results = doc.get("results")
    for i, r in enumerate(results if isinstance(results, list) else []):
        if not isinstance(r, dict):
            problems.append(f"results[{i}] must be an object")
            continue
        if "conversation_id" in r and not isinstance(r["conversation_id"], str):
            problems.append(f"results[{i}]: conversation_id must be a string")
        if r.get("score") is not None and not isinstance(r["score"], dict):
            problems.append(f"results[{i}]: score must be an object or null")
        crit = r.get("criteria")
        if crit is not None and (not isinstance(crit, list) or not all(
                isinstance(c, dict) and isinstance(c.get("criterion_id"), str) and "value" in c for c in crit)):
            problems.append(f"results[{i}]: criteria must be a list of objects with a criterion_id and a value")
    return problems


def dataset_lengths(path: Path) -> dict[str, int]:
    """{conversation_id: transcript length} from a dataset JSON: the API response
    ({data: {records: [...]}}), {records: [...]} or a bare list of records."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data["data"]["records"] if isinstance(data.get("data"), dict) else data["records"]
    return {r["conversation_id"]: len(r.get("transcript") or []) for r in data}


def group_lengths(group: str, store=None) -> dict[str, int]:
    """{conversation_id (the organisers' original id): transcript length} for a group in the app's
    store. Reads only: no migration, and a missing database is an error rather than a new file."""
    if store is None:
        from app import store
        from app.settings import get_settings

        db = get_settings().db_path
        if not db.exists():
            raise LookupError(f"no app database at {db}")
    return {c.conversation_id: len(c.transcript) for c in store.list_conversations(group_id=group)}


def reference_problems(doc: dict, lengths: dict[str, int], source: str) -> list[str]:
    """The file covers exactly the reference conversations, and no evidence turn is past the end
    of its transcript (turns are 1-based, so the last line is turn == length)."""
    results = doc.get("results")
    records = [r for r in (results if isinstance(results, list) else []) if isinstance(r, dict)]
    ids = [r.get("conversation_id") for r in records]
    problems = []
    missing = [c for c in lengths if c not in set(ids)]
    extra = [c for c in dict.fromkeys(ids) if isinstance(c, str) and c not in lengths]
    if missing:
        problems.append(f"{len(missing)} conversation(s) of {source} missing from the file: {', '.join(missing)}")
    if extra:
        problems.append(f"{len(extra)} conversation(s) in the file not in {source}: {', '.join(extra)}")
    for r in records:
        n = lengths.get(r.get("conversation_id"))
        if n is None or r.get("status") != "ok":
            continue
        for c in r.get("criteria") or []:
            past = [t for t in c.get("evidence_turns") or [] if isinstance(t, int) and t > n]
            if past:
                problems.append(f"{r['conversation_id']}: {c.get('criterion_id')} evidence_turns {past} "
                                f"past the end of the transcript ({n} lines)")
    return problems


def check(path: Path, expect: int | None = None, *, group: str | None = None, dev: Path | None = None,
          store=None) -> tuple[object, list[str]]:
    """(the parsed document, every problem found). Writes nothing."""
    doc, problems = read_strict(path)
    if not isinstance(doc, dict):
        return doc, [_redact(p) for p in problems]
    problems += secret_problems(doc)
    shape = shape_problems(doc)
    try:
        problems += shape or validate(doc, expect)
    except Exception as e:  # a shape shape_problems() did not foresee: report it, do not crash
        shape = [f"cannot validate: {type(e).__name__}: {e}"]
        problems += shape
    references = []
    if group:
        try:
            lengths = group_lengths(group, store)
        except Exception as e:  # a missing database or table must be a reported problem, not a traceback
            problems.append(f"cannot read group {group!r} from the app store: {e}")
        else:
            if lengths:
                references.append((lengths, f"group {group}"))
            else:
                problems.append(f"group {group!r} has no conversations in the app store; import it first")
    if dev:
        try:
            references.append((dataset_lengths(dev), f"dataset {Path(dev).name}"))
        except (OSError, ValueError, KeyError, TypeError) as e:
            problems.append(f"cannot read the dataset {dev}: {type(e).__name__}: {e}")
    if not shape:
        for lengths, source in references:
            problems += reference_problems(doc, lengths, source)
    return doc, [_redact(p) for p in problems]


def check_file(path: Path, expect: int | None = None, group: str | None = None, dev: Path | None = None,
               store=None) -> list[str]:
    """Every problem of a results file already written; [] means it can be pushed. Writes nothing."""
    return check(path, expect, group=group, dev=dev, store=store)[1]


def _check_cli(parser: argparse.ArgumentParser, args: argparse.Namespace) -> int:
    export_only = [f"--{d.replace('_', '-')}" for d in ("out", "from_devrun", "checklist_id", "version",
                                                        "team", "mode", "answers")
                   if getattr(args, d) != parser.get_default(d)]
    if export_only:
        parser.error(f"--check only reads FILE; {', '.join(export_only)} belong to the export "
                     "(with --check, --group and --dev are cross-checks)")
    doc, problems = check(args.check, args.expect, group=args.group, dev=args.dev)
    if problems:
        for p in problems:
            print(f"  PROBLEM {p}", file=sys.stderr)
        print(f"FAIL {args.check}: {len(problems)} problem(s)", file=sys.stderr)
        return 1
    errors = [r for r in doc["results"] if r["status"] == "error"]
    print(f"OK {args.check}: {len(doc['results'])} records, {len(errors)} errors")
    for r in errors:
        print(f"  error {r['conversation_id']}: {r['error']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    from app.settings import DEFAULT_CHECKLIST_ID, DEFAULT_CHECKLIST_VERSION

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--group", help="group_id as imported, e.g. DEV (reads the app's store)")
    parser.add_argument("--from-devrun", type=Path, help="an evaluator.devrun --out report instead of the store")
    parser.add_argument("--dev", type=Path, help="the dataset JSON the devrun report was made from")
    parser.add_argument("--out", type=Path, help="the results file to write (required unless --check)")
    parser.add_argument("--check", type=Path, metavar="FILE",
                        help="only check a written results file, write nothing; with it, --group and --dev "
                             "name the conversations the file must cover (the store's group, a dataset JSON)")
    parser.add_argument("--checklist-id", default=DEFAULT_CHECKLIST_ID)
    parser.add_argument("--version", type=int, default=DEFAULT_CHECKLIST_VERSION)
    parser.add_argument("--team", default="gtbsbe")
    parser.add_argument("--mode", choices=MODES, default="external_api")
    parser.add_argument("--answers", choices=("original", "final"), default="original")
    parser.add_argument("--expect", type=int, help="the number of records the file must have (65 DEV, 10 prod)")
    args = parser.parse_args(argv)
    if args.check:
        return _check_cli(parser, args)
    if not args.out:
        parser.error("the following arguments are required: --out (or --check FILE)")

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
