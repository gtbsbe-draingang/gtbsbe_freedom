"""`results_export --check`: re-checking a results file already written, right before the push."""
import copy
import json
from pathlib import Path

import pytest

from app.models import Conversation, Message
from quality import results_export as rx

REPO = Path(__file__).resolve().parents[3]
CRITERIA = [("contact", True), ("discovery", None), ("identification", None), ("consultation", 15),
            ("empathy", True), ("dialogue", 7), ("closure", True), ("critical", False)]
DOC = {
    "schema_version": "1.0", "team_name": "gtbsbe", "model": {"mode": "external_api", "name": "claude-haiku-5-5"},
    "results": [
        {"conversation_id": "chat-1", "status": "ok",
         "criteria": [{"criterion_id": k, "value": v, "rationale": "x", "evidence_turns": [1, 6]} for k, v in CRITERIA],
         "score": {"final_score": 85.38, "critical_flag": False}},
        {"conversation_id": "chat-2", "status": "error", "criteria": [], "score": None, "error": "Оценка завершилась ошибкой."},
    ],
}
SIX_LINES = [{"speaker": "client", "text": f"line {i}"} for i in range(6)]


def write(tmp_path, doc=None, *, text=None, raw=None, name="results.json"):
    path = tmp_path / name
    if raw is not None:
        path.write_bytes(raw)
    else:
        path.write_text(text if text is not None else json.dumps(doc or DOC, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    return path


def changed(change):
    doc = copy.deepcopy(DOC)
    change(doc)
    return doc


def dataset(tmp_path, ids=("chat-1", "chat-2"), lines=SIX_LINES, wrap=True):
    records = [{"conversation_id": c, "group_id": "DEV", "transcript": lines} for c in ids]
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps({"data": {"records": records}} if wrap else records), encoding="utf-8")
    return path


def test_a_valid_file_passes_and_the_cli_says_ok(tmp_path, capsys):
    path = write(tmp_path)
    assert rx.check_file(path, expect=2) == []
    assert rx.check_file(path, expect=2, dev=dataset(tmp_path)) == []
    assert rx.check_file(path, expect=2, dev=dataset(tmp_path, wrap=False)) == []  # a bare list of records
    assert rx.main(["--check", str(path), "--expect", "2"]) == 0
    out = capsys.readouterr().out
    assert out.startswith(f"OK {path}: 2 records, 1 errors\n") and "error chat-2: Оценка завершилась ошибкой." in out


@pytest.mark.parametrize("raw, word", [
    (b"\xef\xbb\xbf" + json.dumps(DOC).encode(), "BOM"),
    (json.dumps(DOC).encode().replace(b"gtbsbe", b"gtbsb\xe9"), "not UTF-8"),  # a Latin-1 é
    (json.dumps(DOC).replace("85.38", "NaN").encode(), "NaN"),
    (json.dumps(DOC).replace("85.38", "-Infinity").encode(), "Infinity"),
    (json.dumps(DOC).replace("85.38", "1e400").encode(), "out of range"),
    (json.dumps(DOC).replace('"team_name": "gtbsbe"', '"team_name": "gtbsbe", "team_name": "x"').encode(),
     "duplicate key 'team_name'"),
    (json.dumps(DOC).replace('"x"', '"\\ud800"', 1).encode(), "lone surrogate"),
    (json.dumps(DOC)[:-1].encode(), "not valid JSON"),
    (json.dumps([DOC]).encode(), "top level must be a JSON object"),
])
def test_what_only_the_bytes_show_fails(tmp_path, raw, word):
    problems = rx.check_file(write(tmp_path, raw=raw), expect=2)
    assert problems and any(word in p for p in problems), problems


def test_the_appendix_rules_still_apply(tmp_path):
    path = write(tmp_path)
    assert rx.check_file(path, expect=10) == ["2 records, expected 10"]
    broken = changed(lambda d: d["results"][0]["criteria"][5].update(value=False))
    assert any("dialogue value False" in p for p in rx.check_file(write(tmp_path, broken), expect=2))


def test_shapes_validate_cannot_read_are_problems_not_crashes(tmp_path):
    for change in (lambda d: d["results"].append("chat-3"),
                   lambda d: d["results"][0].update(criteria={"contact": True}),
                   lambda d: d["results"][0]["criteria"][7].pop("value"),
                   lambda d: d["results"][0].update(conversation_id=["chat-1"]),
                   lambda d: d.update(model="claude"),
                   lambda d: d.update(results=7)):
        assert rx.check_file(write(tmp_path, changed(change)), dev=dataset(tmp_path))


def test_missing_and_extra_ids_against_a_dataset(tmp_path):
    path = write(tmp_path)
    problems = rx.check_file(path, dev=dataset(tmp_path, ids=("chat-1", "chat-3", "chat-4")))
    assert problems == ["2 conversation(s) of dataset dataset.json missing from the file: chat-3, chat-4",
                        "1 conversation(s) in the file not in dataset dataset.json: chat-2"]


def test_an_evidence_turn_past_the_transcript_fails(tmp_path):
    path = write(tmp_path)  # turns [1, 6]: the sixth line is the last one, so it fits six lines
    assert rx.check_file(path, dev=dataset(tmp_path, lines=SIX_LINES)) == []
    problems = rx.check_file(path, dev=dataset(tmp_path, lines=SIX_LINES[:5]))
    assert len(problems) == 8 and problems[0] == "chat-1: contact evidence_turns [6] past the end of the transcript (5 lines)"


@pytest.mark.parametrize("planted", [
    "https://prod-00.example.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?api-version=1&sp=x&sig=FAKE",
    "see sig=FAKE", "http://example.org/a?b=1"])
def test_a_signed_link_or_a_url_with_a_query_fails_without_being_printed(tmp_path, capsys, planted):
    path = write(tmp_path, changed(lambda d: d["results"][0]["criteria"][2].update(rationale=planted)))
    problems = rx.check_file(path, expect=2)
    assert problems == ["$.results[0].criteria[2].rationale: contains a signed link or a URL with a query string; remove it"]
    assert rx.main(["--check", str(path)]) == 1
    captured = capsys.readouterr()
    assert planted not in captured.out + captured.err and "FAIL" in captured.err
    assert rx.check_file(write(tmp_path, changed(lambda d: d["results"][0]["criteria"][2].update(
        rationale="see https://example.org/page")))) == []  # a plain link without a query is fine
    in_an_id = rx.check_file(write(tmp_path, changed(lambda d: d["results"][1].update(conversation_id=planted))),
                             dev=dataset(tmp_path))  # the id is echoed as missing/extra: masked there too
    assert len(in_an_id) == 3 and not any("FAKE" in p or "b=1" in p for p in in_an_id), in_an_id


def test_check_writes_nothing(tmp_path, monkeypatch):
    from app.settings import get_settings
    work = tmp_path / "work"
    work.mkdir()
    path = write(work)
    monkeypatch.chdir(work)
    before = {p: p.stat().st_mtime_ns for p in work.rglob("*")}
    assert rx.main(["--check", str(path), "--expect", "2"]) == 0
    assert rx.main(["--check", str(path), "--group", "CTRL"]) == 1  # no app database: reported, not created
    assert {p: p.stat().st_mtime_ns for p in work.rglob("*")} == before
    assert not get_settings().db_path.exists()


def test_check_against_a_group_in_the_store(client, tmp_path):
    from app import store
    lines = [Message(timestamp=f"00:0{i}", speaker="operator", text=f"line {i}") for i in range(6)]
    for cid, group in (("chat-1", "CTRL"), ("chat-3", "CTRL"), ("chat-2", "DEV")):
        store.upsert_conversation(Conversation(id=f"{group}:{cid}", conversation_id=cid, group_id=group,
                                               channel="agent chat", language="RU", transcript=lines), None)
    path = write(tmp_path)
    assert rx.check_file(path, expect=2, group="CTRL") == [
        "1 conversation(s) of group CTRL missing from the file: chat-3",
        "1 conversation(s) in the file not in group CTRL: chat-2"]
    assert rx.check_file(path, group="NOPE") == ["group 'NOPE' has no conversations in the app store; import it first"]
    two = changed(lambda d: d["results"][1].update(conversation_id="chat-3"))
    assert rx.check_file(write(tmp_path, two), expect=2, group="CTRL") == []


def test_check_refuses_export_options_and_export_still_needs_out(tmp_path, capsys):
    path = write(tmp_path)
    for extra in (["--out", str(tmp_path / "x.json")], ["--from-devrun", "r.json"], ["--answers", "final"]):
        with pytest.raises(SystemExit) as e:
            rx.main(["--check", str(path), *extra])
        assert e.value.code == 2
    assert "--check only reads FILE" in capsys.readouterr().err
    assert not (tmp_path / "x.json").exists()
    with pytest.raises(SystemExit) as e:
        rx.main(["--group", "CTRL"])
    assert e.value.code == 2 and "--out" in capsys.readouterr().err


@pytest.mark.skipif(not (REPO / "results/dev/results.json").exists(), reason="no committed DEV results")
def test_the_committed_dev_file_passes():
    assert rx.check_file(REPO / "results/dev/results.json", expect=65) == []
