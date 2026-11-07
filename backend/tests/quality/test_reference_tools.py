import json
from pathlib import Path

import pytest

from quality.reference_tools import export_csv, import_csv, merge, validate

SEED = Path(__file__).parent / "fixtures" / "seed_min.json"


def write(path, labels, checklist_id="official-chat", version=1):
    path.write_text(json.dumps({"checklist_id": checklist_id, "version": version, "labels": labels},
                               ensure_ascii=False), encoding="utf-8")
    return path


def lab(conv="p1-ru-001", crit="c01", answer="yes", kinds=(), note="Приветствие [#9]", disputed=False):
    return {"conversation_id": conv, "criterion_id": crit, "answer": answer, "kinds": list(kinds),
            "note": note, "disputed": disputed}


def dev(tmp_path, ids):
    p = tmp_path / "dev.json"
    p.write_text(json.dumps({"data": {"records": [{"conversation_id": i} for i in ids]}}), encoding="utf-8")
    return p


def full_set(conv):
    return [lab(conv, "c01", "yes"), lab(conv, "c04", {"step": 20}), lab(conv, "c08", "no")]


def test_valid_file_has_no_errors(tmp_path):
    p = write(tmp_path / "l.json", full_set("p1-ru-001"))
    assert validate(p, SEED, dev(tmp_path, ["p1-ru-001"])) == []


def test_na_not_allowed_rejected(tmp_path):
    errs = validate(write(tmp_path / "l.json", [lab(answer="na")]), SEED, full=False)
    assert len(errs) == 1 and "labels[0]" in errs[0] and "c01" in errs[0] and "na" in errs[0]


def test_step_not_in_scale_rejected(tmp_path):
    errs = validate(write(tmp_path / "l.json", [lab(crit="c04", answer={"step": 12})]), SEED, full=False)
    assert len(errs) == 1 and "12" in errs[0]


def test_step_as_string_rejected(tmp_path):
    errs = validate(write(tmp_path / "l.json", [lab(crit="c04", answer={"step": "15"})]), SEED, full=False)
    assert len(errs) == 1


@pytest.mark.parametrize("bad", [
    lab(crit="c01", answer="yes", kinds=["insult"]),
    lab(crit="c08", answer="yes", kinds=["theft"]),
    lab(crit="c08", answer="no", kinds=["insult"]),
])
def test_kinds_rules(tmp_path, bad):
    assert len(validate(write(tmp_path / "l.json", [bad]), SEED, full=False)) == 1


def test_missing_and_duplicate_pairs_reported(tmp_path):
    labels = full_set("p1-ru-001") + [lab("p1-ru-001", "c01", "no")] + full_set("p1-ru-002")[:2]
    errs = validate(write(tmp_path / "l.json", labels), SEED, dev(tmp_path, ["p1-ru-001", "p1-ru-002"]))
    assert any("duplicate" in e and "p1-ru-001/c01" in e for e in errs)
    assert any(e == "missing p1-ru-002/c08" for e in errs)


@pytest.mark.parametrize("note", ["см. https://example.test/x", "ссылка ?sig=abc"])
def test_links_rejected(tmp_path, note):
    assert len(validate(write(tmp_path / "l.json", [lab(note=note)]), SEED, full=False)) == 1


def test_note_length_limit(tmp_path):
    assert len(validate(write(tmp_path / "l.json", [lab(note="а" * 201)]), SEED, full=False)) == 1


def test_csv_round_trip_preserves_labels(tmp_path):
    labels = full_set("p1-ru-001") + [lab("p1-ru-002", "c08", "yes", ["insult"], "Оскорбление [#9]: «Вы, вообще...»", True)]
    src = write(tmp_path / "l.json", labels)
    export_csv(src, tmp_path / "l.csv")
    out = write(tmp_path / "out.json", [])
    assert import_csv(tmp_path / "l.csv", out) == 4
    assert json.loads(out.read_text(encoding="utf-8"))["labels"] == labels


def test_merge_rejects_duplicates_across_batches(tmp_path):
    b = tmp_path / "batches"
    b.mkdir()
    write(b / "a.json", full_set("p1-ru-001"))
    write(b / "b.json", [lab("p1-ru-001", "c04", {"step": 15})])
    with pytest.raises(ValueError):
        merge(b, tmp_path / "all.json")


def test_merge_joins_and_sorts(tmp_path):
    b = tmp_path / "batches"
    b.mkdir()
    write(b / "b.json", full_set("p1-ru-002"))
    write(b / "a.json", full_set("p1-ru-001"))
    assert merge(b, tmp_path / "all.json") == 6
    got = json.loads((tmp_path / "all.json").read_text(encoding="utf-8"))
    assert got["checklist_id"] == "official-chat" and got["labels"][0]["conversation_id"] == "p1-ru-001"
