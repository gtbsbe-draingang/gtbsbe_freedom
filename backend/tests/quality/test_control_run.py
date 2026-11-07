"""The one-command control run, against the app in-process (TestClient) with the fake evaluator:
no network, no model, no real server."""
import itertools
import json
import time
from collections.abc import Iterator

import httpx
import pytest

from app import jobs, store
from quality import control_run as cr
from quality import results_export as rx
from tests.app.fakes import FakeEvaluator, dev_records, ensure_official

KEY = {"ANTHROPIC_API_KEY": "test-key"}
GROUP = "CTRL-TEST"
BASE = "http://testserver/api"


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "RETRY_DELAY_SECONDS", 0)


@pytest.fixture
def fake() -> Iterator[FakeEvaluator]:
    evaluator = FakeEvaluator()
    jobs.set_evaluator(evaluator)
    yield evaluator
    jobs.reset_evaluator()


@pytest.fixture
def organiser_file(tmp_path):
    """Five DEV chats in the organisers' response shape, without audio links."""
    chats = [{k: v for k, v in r.items() if k != "audio_url"} for r in dev_records() if r["channel"] == "agent chat"]
    path = tmp_path / "control.json"
    path.write_text(json.dumps({"isSuccess": True, "data": {"dataset_group_id": "ignored", "records": chats}},
                               ensure_ascii=False), encoding="utf-8")
    return path


def nap(_: float) -> None:
    time.sleep(0.005)


def run(client, *args, **kwargs) -> int:
    return cr.main(["--group", GROUP, "--base-url", BASE, "--poll-seconds", "0", *args],
                   client=client, sleep=nap, **kwargs)


def fail_until_retry(client, fake: FakeEvaluator, conversation: str) -> list[str]:
    """`conversation` fails (not retryable) until the runner posts a retry; the retries seen."""
    fake.fail_for = {conversation}
    fake.failure = lambda: FakeEvaluator.JudgmentFailed("bad_answer", retryable=False)
    retries: list[str] = []

    def hook(request: httpx.Request) -> None:
        if request.method == "POST" and request.url.path.endswith("/retry"):
            retries.append(request.url.path)
            fake.fail_for = set()

    client.event_hooks["request"].append(hook)
    return retries


def test_rehearsal_imports_evaluates_retries_and_writes_a_valid_file(make_client, fake, organiser_file,
                                                                      tmp_path, capsys):
    client = make_client(**KEY)
    ensure_official()
    retries = fail_until_retry(client, fake, f"{GROUP}:p1-ru-010")
    out = tmp_path / "results" / "prod" / "results.json"

    code = run(client, "--from-json", str(organiser_file), "--limit", "3", "--expect", "3", "--out", str(out))

    printed = capsys.readouterr()
    assert code == cr.EXIT_OK, printed.err
    assert len(retries) == 1
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert rx.validate(doc, expect=3) == []
    assert [r["conversation_id"] for r in doc["results"]] == ["p1-ru-001", "p1-ru-010", "p1-ru-012"]
    assert all(r["status"] == "ok" for r in doc["results"])
    assert doc["results"][0]["score"] == {"final_score": 100.0, "critical_flag": False}
    # the upload went into --group, not the file's own dataset_group_id
    assert [c.id for c in store.list_conversations(group_id=GROUP)] == [
        f"{GROUP}:p1-ru-001", f"{GROUP}:p1-ru-010", f"{GROUP}:p1-ru-012"]
    # the file read over HTTP is the file the store gives directly: one database, by construction
    assert doc == rx.build(store, GROUP, "official-chat", 1, team="gtbsbe", mode="external_api")
    job = store.list_jobs()[0]
    assert (job.done, job.failed, [r.role for r in job.retries]) == (3, 0, ["controller"])
    for line in ("Imported: total 3, new 3", "24 model call(s), 0 reused",
                 "1 failed", "Retry 1/1", "3 ok, 0 error(s)", "Valid: every record is ok.",
                 "git add", "git push -u origin results/control-CTRL-TEST"):
        assert line in printed.out, line
    assert "sig=" not in printed.out + printed.err


def test_a_dialogue_that_keeps_failing_stays_an_error_record_and_exits_1(make_client, fake, organiser_file,
                                                                          tmp_path, capsys):
    client = make_client(**KEY)
    ensure_official()
    fake.fail_for = {f"{GROUP}:p1-ru-012"}
    fake.failure = lambda: FakeEvaluator.JudgmentFailed("bad_answer", retryable=False)
    out = tmp_path / "results.json"

    code = run(client, "--from-json", str(organiser_file), "--limit", "2", "--retries", "2", "--out", str(out))
    assert code == cr.EXIT_OK  # p1-ru-012 is not among the first two
    fake.judged = []
    code = run(client, "--from-json", str(organiser_file), "--limit", "3", "--retries", "2", "--expect", "3",
               "--out", str(out))

    printed = capsys.readouterr()
    assert code == cr.EXIT_PROBLEMS
    assert {conv for conv, _ in fake.judged} == {f"{GROUP}:p1-ru-012"}  # the two done ones were reused
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert rx.validate(doc, expect=3) == []  # an error record is a valid record
    by = {r["conversation_id"]: r for r in doc["results"]}
    assert by["p1-ru-012"] == {"conversation_id": "p1-ru-012", "status": "error", "criteria": [],
                               "score": None, "error": "Оценка завершилась ошибкой."}
    assert "Retry 2/2" in printed.out and "still failed" in printed.out
    assert "NOT READY: error records" in printed.out and "git add" in printed.out


def test_a_timeout_writes_the_file_with_unfinished_dialogues_as_errors(make_client, fake, organiser_file,
                                                                       tmp_path, capsys):
    client = make_client(**KEY)
    ensure_official()
    fake.delay = 5  # the job cannot finish before the fake clock runs out
    ticks = itertools.count(0, 600)
    out = tmp_path / "results.json"

    code = run(client, "--from-json", str(organiser_file), "--limit", "2", "--timeout-minutes", "1",
               "--out", str(out), clock=lambda: next(ticks))

    printed = capsys.readouterr()
    assert code == cr.EXIT_PROBLEMS
    assert "did not finish within 1.0 min" in printed.err and "job timed out" in printed.out
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert [r["status"] for r in doc["results"]] == ["error", "error"]


def test_export_only_reads_the_server_and_flags_a_wrong_count(make_client, fake, organiser_file, tmp_path, capsys):
    client = make_client(**KEY)
    ensure_official()
    out = tmp_path / "results.json"
    assert run(client, "--from-json", str(organiser_file), "--limit", "2", "--out", str(out)) == cr.EXIT_OK
    calls = fake.calls
    capsys.readouterr()

    code = run(client, "--export-only", "--expect", "10", "--out", str(out))

    printed = capsys.readouterr()
    assert code == cr.EXIT_PROBLEMS and fake.calls == calls
    assert "PROBLEM 2 records, expected 10" in printed.err
    assert "Importing" not in printed.out and "Dry run" not in printed.out


def test_no_conversations_in_the_group_writes_nothing(make_client, tmp_path, capsys):
    client = make_client(**KEY)
    out = tmp_path / "results.json"
    assert run(client, "--skip-import", "--out", str(out)) == cr.EXIT_NOT_WRITTEN
    assert "no conversations in group 'CTRL-TEST'" in capsys.readouterr().err
    assert not out.exists()


def test_needed_model_calls_without_a_key_stop_before_the_job(make_client, fake, organiser_file, tmp_path, capsys):
    client = make_client()  # no key
    ensure_official()
    out = tmp_path / "results.json"
    code = run(client, "--from-json", str(organiser_file), "--limit", "1", "--out", str(out))
    printed = capsys.readouterr()
    assert code == cr.EXIT_NOT_WRITTEN
    assert "Model key: NOT configured" in printed.out and "no model key" in printed.err
    assert store.list_jobs() == [] and not out.exists()


def test_no_server_is_a_clear_failure(tmp_path, capsys):
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    out = tmp_path / "results.json"
    with httpx.Client(transport=httpx.MockTransport(refuse)) as client:
        code = cr.main(["--group", GROUP, "--out", str(out)], client=client)
    err = capsys.readouterr().err
    assert code == cr.EXIT_NOT_WRITTEN and not out.exists()
    assert "ConnectError" in err and "uv run cqa-serve" in err


def test_records_are_read_from_every_organiser_shape(tmp_path):
    records = [{"conversation_id": str(i)} for i in range(4)]
    for body in (records, {"records": records}, {"isSuccess": True, "data": {"records": records}}):
        path = tmp_path / "x.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        assert cr.read_records(path, None) == records
        assert cr.read_records(path, 2) == records[:2]
    path.write_text("{}", encoding="utf-8")
    with pytest.raises(cr.RunFailed):
        cr.read_records(path, None)


def test_argument_rules():
    with pytest.raises(SystemExit):
        cr.parse_args(["--group", "G", "--limit", "3"])  # --limit without --from-json
    with pytest.raises(SystemExit):
        cr.parse_args(["--group", "G", "--from-json", "x.json", "--export-only"])
    args = cr.parse_args(["--group", "G"])
    assert args.base_url == "http://127.0.0.1:8000/api" and args.out == cr.DEFAULT_OUT
    assert (args.mode, args.role, args.retries, args.timeout_minutes) == ("reuse", "controller", 1, 40.0)
