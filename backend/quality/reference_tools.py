"""Reference-label tools (issue #24): validate, merge batches, and a CSV round trip for review.

    uv run python -m quality.reference_tools validate <labels> --seed <seed> [--dev <dev.json>] [--partial]
    uv run python -m quality.reference_tools merge <batch_dir> <out>
    uv run python -m quality.reference_tools export-csv <labels> <csv>
    uv run python -m quality.reference_tools import-csv <csv> <labels>

The seed is read as plain JSON, so this module depends on nothing from stream B.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

NOTE_LIMIT = 200
CSV_COLUMNS = ["conversation_id", "criterion_id", "answer", "kinds", "note", "disputed"]


def _load(path: Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write(path: Path, data: dict) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write("\n")


def _check_answer(crit: dict, label: dict) -> list[str]:
    errs = []
    ans, kinds = label.get("answer"), label.get("kinds", [])
    if not isinstance(kinds, list):
        return ["kinds must be a list"]
    if ans == "na":
        if not crit.get("na_allowed"):
            errs.append("na not allowed")
    elif crit.get("answer_type") == "scale":
        if not (isinstance(ans, dict) and set(ans) == {"step"}):
            errs.append(f"scale answer must be {{\"step\": value}}, got {json.dumps(ans, ensure_ascii=False)}")
        elif not isinstance(ans["step"], int) or isinstance(ans["step"], bool):
            errs.append(f"step must be an integer, got {json.dumps(ans['step'], ensure_ascii=False)}")
        elif ans["step"] not in [s["value"] for s in crit.get("scale_steps", [])]:
            errs.append(f"step {ans['step']} not in scale")
    elif ans not in ("yes", "no"):
        errs.append(f"answer must be yes, no or na, got {json.dumps(ans, ensure_ascii=False)}")
    if crit.get("kind") == "gross_error":
        allowed = set(crit.get("kinds", []))
        if ans == "yes" and not kinds:
            errs.append("gross error yes needs kinds")
        if ans != "yes" and kinds:
            errs.append("kinds only allowed with yes")
        bad = [k for k in kinds if k not in allowed]
        if bad:
            errs.append(f"unknown kinds {bad}")
    elif kinds:
        errs.append("kinds only allowed on the gross-error criterion")
    return errs


def _check_note(note) -> list[str]:
    if not isinstance(note, str):
        return ["note must be a string"]
    errs = []
    if len(note) > NOTE_LIMIT:
        errs.append(f"note longer than {NOTE_LIMIT} characters")
    if "sig=" in note or "http" in note.lower():
        errs.append("note contains a link")
    return errs


def validate(labels_path: Path, seed_path: Path, dev_path: Path | None = None, *, full: bool = True) -> list[str]:
    """Every problem as one string naming the label, e.g. "labels[17] p1-ru-003/c01: na not allowed"."""
    data, seed = _load(labels_path), _load(seed_path)
    crits = {c["id"]: c for c in seed["criteria"]}
    errs = []
    if data.get("checklist_id") != seed.get("checklist_id") or data.get("version") != seed.get("version"):
        errs.append(f"file is for {data.get('checklist_id')} v{data.get('version')}, "
                    f"seed is {seed.get('checklist_id')} v{seed.get('version')}")
    known = None
    if dev_path:
        known = {r["conversation_id"] for r in _load(dev_path)["data"]["records"]}
    seen: dict[tuple[str, str], int] = {}
    for i, lab in enumerate(data.get("labels", [])):
        key = (lab.get("conversation_id"), lab.get("criterion_id"))
        where = f"labels[{i}] {key[0]}/{key[1]}"
        if key in seen:
            errs.append(f"{where}: duplicate of labels[{seen[key]}]")
        seen.setdefault(key, i)
        if known is not None and key[0] not in known:
            errs.append(f"{where}: conversation not in DEV")
        crit = crits.get(key[1])
        if crit is None:
            errs.append(f"{where}: criterion not in seed")
            continue
        if not isinstance(lab.get("disputed", False), bool):
            errs.append(f"{where}: disputed must be true or false")
        errs += [f"{where}: {e}" for e in _check_answer(crit, lab) + _check_note(lab.get("note", ""))]
    if full and known is not None:
        for conv in sorted(known):
            for cid in crits:
                if (conv, cid) not in seen:
                    errs.append(f"missing {conv}/{cid}")
    return errs


def merge(batch_dir: Path, out_path: Path) -> int:
    """Join batch files into one reference file; a repeated (conversation, criterion) is an error."""
    labels, header, seen = [], None, {}
    for f in sorted(Path(batch_dir).glob("*.json")):
        data = _load(f)
        h = (data.get("checklist_id"), data.get("version"))
        if header is None:
            header = h
        elif h != header:
            raise ValueError(f"{f.name} is for {h}, earlier batches for {header}")
        for lab in data.get("labels", []):
            key = (lab["conversation_id"], lab["criterion_id"])
            if key in seen:
                raise ValueError(f"duplicate {key[0]}/{key[1]} in {f.name} and {seen[key]}")
            seen[key] = f.name
            labels.append(lab)
    if header is None:
        raise ValueError(f"no batch files in {batch_dir}")
    labels.sort(key=lambda lab: (lab["conversation_id"], lab["criterion_id"]))
    _write(out_path, {"checklist_id": header[0], "version": header[1], "labels": labels})
    return len(labels)


def _answer_to_cell(ans) -> str:
    return str(ans["step"]) if isinstance(ans, dict) else ans


def _cell_to_answer(cell: str):
    cell = cell.strip()
    if cell in ("yes", "no", "na"):
        return cell
    try:
        return {"step": int(cell)}
    except ValueError:
        return cell  # left for validate() to report


def export_csv(labels_path: Path, csv_path: Path) -> None:
    data = _load(labels_path)
    with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        w.writeheader()
        for lab in data["labels"]:
            w.writerow({"conversation_id": lab["conversation_id"], "criterion_id": lab["criterion_id"],
                        "answer": _answer_to_cell(lab["answer"]), "kinds": ";".join(lab.get("kinds", [])),
                        "note": lab.get("note", ""), "disputed": "true" if lab.get("disputed") else "false"})


def import_csv(csv_path: Path, labels_path: Path) -> int:
    """Replace the labels in `labels_path` with the CSV rows, keeping its header."""
    data = _load(labels_path)
    labels = []
    with open(csv_path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            labels.append({"conversation_id": row["conversation_id"].strip(), "criterion_id": row["criterion_id"].strip(),
                           "answer": _cell_to_answer(row["answer"]),
                           "kinds": [k.strip() for k in row["kinds"].split(";") if k.strip()],
                           "note": row["note"], "disputed": row["disputed"].strip().lower() in ("true", "1", "yes")})
    data["labels"] = labels
    _write(labels_path, data)
    return len(labels)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="quality.reference_tools")
    sub = p.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate")
    v.add_argument("labels", type=Path)
    v.add_argument("--seed", type=Path, required=True)
    v.add_argument("--dev", type=Path)
    v.add_argument("--partial", action="store_true")
    m = sub.add_parser("merge")
    m.add_argument("batch_dir", type=Path)
    m.add_argument("out", type=Path)
    e = sub.add_parser("export-csv")
    e.add_argument("labels", type=Path)
    e.add_argument("csv", type=Path)
    i = sub.add_parser("import-csv")
    i.add_argument("csv", type=Path)
    i.add_argument("labels", type=Path)
    a = p.parse_args(argv)
    if a.cmd == "validate":
        errs = validate(a.labels, a.seed, a.dev, full=not a.partial)
        for line in errs:
            print(line)
        print(f"{len(errs)} errors, {len(_load(a.labels).get('labels', []))} labels")
        return 1 if errs else 0
    if a.cmd == "merge":
        print(f"{merge(a.batch_dir, a.out)} labels")
    elif a.cmd == "export-csv":
        export_csv(a.labels, a.csv)
    else:
        print(f"{import_csv(a.csv, a.labels)} labels")
    return 0


if __name__ == "__main__":
    sys.exit(main())
