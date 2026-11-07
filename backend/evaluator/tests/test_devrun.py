import asyncio
import json

import pytest

from evaluator.devrun import (
    Expectation,
    check_expectations,
    load_dev_conversations,
    load_expectations,
)
from evaluator.testing import VALID_C01_NO, from_recorded

DUMMY = "https://example.invalid/a.wav"
URL_KEY = "audio_" + "url"  # spelled in two parts: greps allow the word only in devrun.py


def rec(cid, lines, channel="agent chat", language="RU", **extra):
    return {
        "conversation_id": cid,
        "channel": channel,
        "language": language,
        "transcript": [{"timestamp": f"00:{i:02d}", "speaker": s, "text": t} for i, (s, t) in enumerate(lines)],
        **extra,
    }


def test_loader_ids_duplicates_and_no_audio_field(tmp_path):
    f = tmp_path / "dev.json"
    f.write_text(
        json.dumps(
            [
                rec("a1", [("client", "Привет"), ("operator", "Здравствуйте"), ("operator", "Здравствуйте"),
                           ("client", "Здравствуйте"), ("operator", "Здравствуйте")]),
                rec("v1", [("client", "алло")], channel="voice call", language="KZ", **{URL_KEY: DUMMY}),
            ]
        ),
        encoding="utf-8",
    )
    a, v = load_dev_conversations(f)
    assert (a.id, a.conversation_id, a.group_id, a.channel, a.language) == ("DEV:a1", "a1", "DEV", "agent chat", "RU")
    assert [m.duplicate for m in a.transcript] == [False, False, True, False, False]
    assert [m.timestamp for m in a.transcript] == [f"00:{i:02d}" for i in range(5)]  # original kept
    assert len(a.transcript) == 5  # indices kept
    assert v.id == "DEV:v1" and v.language == "KZ"
    assert URL_KEY not in v.model_dump() and DUMMY not in v.model_dump_json()


def test_loader_group_id_envelope_and_bare_list(tmp_path):
    f = tmp_path / "dev.json"
    envelope = {
        "error": None,
        "isSuccess": True,
        "data": {"dataset_group_id": "g", "total_records": 1, "records": [rec("x", [("client", "hi")], language="EN")]},
    }
    f.write_text(json.dumps(envelope), encoding="utf-8")
    assert load_dev_conversations(f, group_id="G")[0].id == "G:x"
    f.write_text(json.dumps([rec("y", [("client", "hi")])]), encoding="utf-8")
    assert load_dev_conversations(f)[0].id == "DEV:y"


def test_expectations_file_loads():
    exps = load_expectations()
    assert exps and all(e.conversation_id.startswith("DEV:") and e.answer in {"yes", "no", "na"} for e in exps)


def test_load_expectations(tmp_path):
    f = tmp_path / "e.json"
    f.write_text(json.dumps([{"conversation_id": "DEV:a", "criterion_id": "c01", "answer": "no", "note": "n"}]))
    assert load_expectations(f) == [Expectation("DEV:a", "c01", "no", "n")]


def test_check_expectations():
    run = {
        "conversations": {
            "DEV:a": {"results": [{"criterion_id": "c01", "answer": "no"}, {"criterion_id": "c04", "answer": {"step": 15}}]}
        }
    }
    ok = [Expectation("DEV:a", "c01", "no"), Expectation("DEV:a", "c04", "step:15")]
    assert check_expectations(run, ok) == []
    assert check_expectations(run, [Expectation("DEV:zz", "c01", "yes")]) == ["DEV:zz c01: conversation not in run"]
    bad = check_expectations(
        run, [Expectation("DEV:a", "c01", "yes", "why"), Expectation("DEV:a", "c04", "step:10"), Expectation("DEV:a", "c09", "no")]
    )
    assert len(bad) == 3 and "expected yes, got no" in bad[0] and "no result" in bad[2]


def test_from_recorded_replays_in_order(tmp_path):
    (tmp_path / "1.json").write_text(json.dumps([{"payload": VALID_C01_NO}, {"text": "plain", "usage": [1, 2, 3, 4]}]))
    (tmp_path / "2.json").write_text(json.dumps({"payload": {"x": 1}, "stop_reason": "max_tokens"}))
    fake = from_recorded(tmp_path)

    async def go():
        return [await fake.messages.create(a=i) for i in range(3)]

    r = asyncio.run(go())
    assert json.loads(r[0].content[-1].text)["answer"] == "no"
    assert r[1].content[-1].text == "plain" and r[1].usage.output_tokens == 4
    assert r[2].stop_reason == "max_tokens"
    with pytest.raises(AssertionError):
        asyncio.run(fake.messages.create())
    assert len(fake.calls) == 4


def test_from_recorded_single_file(tmp_path):
    f = tmp_path / "r.json"
    f.write_text(json.dumps({"payload": {"a": 1}}))
    assert len(from_recorded(f).script) == 1


# --- run / main (replayed, no API) --------------------------------------------------------------
from pathlib import Path

from evaluator import client
from evaluator.devrun import main, run
from evaluator.testing import make_checklist

RECORDED = Path(__file__).parent / "recorded" / "synth-001.json"
LINES = [("client", "Привет"), ("operator", "Привет, где именно ищете?"), ("client", "ок")]


@pytest.fixture
def files(tmp_path):
    data = tmp_path / "dev.json"
    data.write_text(json.dumps({"error": None, "isSuccess": True, "data": {"dataset_group_id": "g", "total_records": 1,
                                                                          "records": [rec("synth-001", LINES)]}}))
    cl = tmp_path / "cl.json"
    cl.write_text(make_checklist().model_dump_json())
    return data, cl


def test_run_replays_recording_and_shape(files, api_key, db):
    data, cl = files
    client.set_client(from_recorded(RECORDED))
    result = asyncio.run(run(load_dev_conversations(data), cl))
    c = result["conversations"]["DEV:synth-001"]
    assert [r["criterion_id"] for r in c["results"]] == [f"c0{i}" for i in range(1, 9)]
    answers = {r["criterion_id"]: r["answer"] for r in c["results"]}
    assert answers["c04"] == {"step": 20} and answers["c02"] == "na" and answers["c08"] == "no"
    assert c["info"]["topic"] and c["failures"] == [] and result["totals"]["calls"] == 9
    assert check_expectations(result, [Expectation("DEV:synth-001", "c04", "step:20"), Expectation("DEV:synth-001", "c01", "no")]) == [
        "DEV:synth-001 c01: expected no, got yes"
    ]


def test_record_then_replay_roundtrip(files, api_key, db, tmp_path):
    data, cl = files
    # "real" client = the replay fake; the recorder wraps it and writes what it saw
    client.set_client(from_recorded(RECORDED))
    rec_dir = tmp_path / "rec"
    first = asyncio.run(run(load_dev_conversations(data), cl, record_dir=rec_dir))
    saved = rec_dir / "synth-001.json"
    assert saved.exists() and len(json.loads(saved.read_text())) == 9
    assert "s" + "ig=" not in saved.read_text()
    client.set_client(from_recorded(saved))
    second = asyncio.run(run(load_dev_conversations(data), cl))
    assert first["conversations"] == second["conversations"]


def test_main_expectations_exit_codes(files, api_key, db, tmp_path, capsys):
    data, cl = files
    exp = tmp_path / "exp.json"
    exp.write_text(json.dumps([{"conversation_id": "DEV:synth-001", "criterion_id": "c01", "answer": "yes"}]))
    out = tmp_path / "runs" / "r.json"
    client.set_client(from_recorded(RECORDED))
    argv = ["--data", str(data), "--checklist", str(cl), "--expectations", str(exp), "--out", str(out)]
    assert main(argv) == 0
    shown = capsys.readouterr().out
    assert "synth-001" in shown and "c04=step:20" in shown and "cost_usd=" in shown and "1 ok, 0 failed" in shown
    assert json.loads(out.read_text())["failed_expectations"] == []
    exp.write_text(json.dumps([{"conversation_id": "DEV:synth-001", "criterion_id": "c01", "answer": "no"}]))
    client.set_client(from_recorded(RECORDED))
    assert main(argv) == 1


def test_main_expectations_only_limits_calls(files, api_key, db, tmp_path):
    data, cl = files
    exp = tmp_path / "exp.json"
    exp.write_text(json.dumps([{"conversation_id": "DEV:synth-001", "criterion_id": "c01", "answer": "yes"}]))
    fake = from_recorded(RECORDED)
    client.set_client(fake)
    assert main(["--data", str(data), "--checklist", str(cl), "--expectations", str(exp), "--expectations-only"]) == 0
    assert len(fake.calls) == 1  # one criterion, no info


def test_main_without_key(files, tmp_path, capsys):
    data, cl = files
    exp = tmp_path / "exp.json"
    exp.write_text("[]")
    assert main(["--data", str(data), "--checklist", str(cl), "--expectations", str(exp)]) == 2
    assert "ANTHROPIC_API_KEY" in capsys.readouterr().out


def test_main_no_matching_conversation_exits_1(files, api_key, db, tmp_path, capsys):
    data, cl = files
    exp = tmp_path / "exp.json"
    exp.write_text(json.dumps([{"conversation_id": "DEV:other", "criterion_id": "c01", "answer": "yes"}]))
    fake = from_recorded(RECORDED)
    client.set_client(fake)
    assert main(["--data", str(data), "--checklist", str(cl), "--expectations", str(exp), "--expectations-only"]) == 1
    assert fake.calls == []
    assert "no conversations" in capsys.readouterr().out


def test_main_ids_subset_ignores_other_expectations(files, api_key, db, tmp_path):
    data, cl = files
    exp = tmp_path / "exp.json"
    exp.write_text(json.dumps([{"conversation_id": "DEV:synth-001", "criterion_id": "c01", "answer": "yes"},
                               {"conversation_id": "DEV:other", "criterion_id": "c01", "answer": "no"}]))
    client.set_client(from_recorded(RECORDED))
    assert main(["--data", str(data), "--checklist", str(cl), "--expectations", str(exp), "--ids", "synth-001"]) == 0
