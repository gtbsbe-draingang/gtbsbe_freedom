"""The organisers' results file (appendix «Как сдать результаты», JSON 1.0)."""
import copy
import json

from app.models import CheckedRange, Conversation, CriterionResult, Evaluation, Evidence, Message, StepAnswer
from quality import results_export as rx

# The appendix's own example, word for word in structure: its 85.38 must come out of the values.
APPENDIX = {
    "schema_version": "1.0", "team_name": "Название команды", "model": {"mode": "local", "name": "Название модели"},
    "results": [{
        "conversation_id": "demo-001", "status": "ok",
        "criteria": [
            {"criterion_id": "contact", "value": True, "rationale": "x", "evidence_turns": [4]},
            {"criterion_id": "discovery", "value": None, "rationale": "x", "evidence_turns": [1]},
            {"criterion_id": "identification", "value": None, "rationale": "x", "evidence_turns": [1]},
            {"criterion_id": "consultation", "value": 15, "rationale": "x", "evidence_turns": [5, 6]},
            {"criterion_id": "empathy", "value": True, "rationale": "x", "evidence_turns": [4, 5]},
            {"criterion_id": "dialogue", "value": 7, "rationale": "x", "evidence_turns": [5, 6]},
            {"criterion_id": "closure", "value": True, "rationale": "x", "evidence_turns": [8]},
            {"criterion_id": "critical", "value": False, "rationale": "x", "evidence_turns": [4, 5, 6, 8]},
        ],
        "score": {"final_score": 85.38, "critical_flag": False},
    }, {"conversation_id": "demo-002", "status": "error", "criteria": [], "score": None,
        "error": "Не удалось получить ответ модели."}],
}


def test_the_appendix_example_validates_and_its_score_recomputes():
    assert rx.validate(APPENDIX, expect=2) == []
    assert rx.expected_score(APPENDIX["results"][0]["criteria"]) == 85.38


def test_validation_catches_each_rule():
    def broken(change):
        doc = copy.deepcopy(APPENDIX)
        change(doc)
        return rx.validate(doc)
    first = lambda d: d["results"][0]
    crit = lambda d, code: next(c for c in first(d)["criteria"] if c["criterion_id"] == code)
    assert broken(lambda d: crit(d, "dialogue").update(value=False))  # 0 == False must not pass
    assert broken(lambda d: crit(d, "dialogue").update(value=5))
    assert broken(lambda d: crit(d, "contact").update(value=None))  # contact has no N/A
    assert broken(lambda d: crit(d, "consultation").update(value=True))
    assert broken(lambda d: first(d)["criteria"].pop())
    assert broken(lambda d: first(d)["score"].update(critical_flag=True))
    assert broken(lambda d: first(d)["score"].update(final_score=85.0))
    assert broken(lambda d: crit(d, "contact").update(evidence_turns=[0]))  # numbering starts at 1
    assert broken(lambda d: d["results"].append(copy.deepcopy(d["results"][0])))  # duplicate id
    assert broken(lambda d: d["results"][1].update(score=0))  # an error is never a zero score
    assert broken(lambda d: d["model"].update(mode="cloud"))
    assert rx.validate(APPENDIX, expect=10) == ["2 records, expected 10"]


def run(conv_id, *, source="model", status="done", created="2026-11-07T10:00:00Z", c04=15, total="85.38", ev_id=None):
    answers = {"c01": "yes", "c02": "na", "c03": "na", "c04": StepAnswer(step=c04), "c05": "yes",
               "c06": StepAnswer(step=7), "c07": "yes", "c08": "no"}
    results = [CriterionResult(criterion_id=k, answer=a, explanation=f"  пояснение\n{k} ", confidence="high",
                               points=None, effective_weight=None, model="claude-haiku-5-5",
                               evidence=[Evidence(message_index=3, quote="q", role="supports"),
                                         Evidence(message_index=0, quote="q", role="expected_here")])
               for k, a in answers.items()] if status == "done" else []
    return Evaluation(id=ev_id or f"{conv_id}-{source}-{status}-{created}", created_at=created, conversation=conv_id,
                      checklist_id="official-chat", version=1, status=status, source=source,
                      model="claude-haiku-5-5", results=results,
                      original_total=total if status == "done" else None, final_total=total if status == "done" else None)


def conversation(cid, group="CTRL"):
    lines = [Message(timestamp=f"00:0{i}", speaker="client" if i % 2 else "operator", text=f"line {i}") for i in range(6)]
    return Conversation(id=f"{group}:{cid}", conversation_id=cid, group_id=group, channel="agent chat",
                        language="RU", transcript=lines)


def test_export_from_the_real_store(client, tmp_path):
    from app import store
    for cid in ("chat-1", "chat-2", "chat-3", "chat-4"):
        store.upsert_conversation(conversation(cid), None)
    store.upsert_conversation(conversation("other", group="DEV"), None)
    store.insert_evaluation(run("CTRL:chat-1"))
    store.insert_evaluation(run("CTRL:chat-1", source="mock", created="2026-11-08T10:00:00Z", c04=0, total="1.00"))
    store.insert_evaluation(run("CTRL:chat-2", status="failed"))
    store.insert_evaluation(run("CTRL:chat-3", source="mock"))
    store.insert_evaluation(run("DEV:other"))

    doc = rx.build(store, "CTRL", "official-chat", 1, team="gtbsbe", mode="external_api")
    assert rx.validate(doc, expect=4) == []
    assert doc["model"] == {"mode": "external_api", "name": "claude-haiku-5-5"}
    by = {r["conversation_id"]: r for r in doc["results"]}
    assert list(by) == ["chat-1", "chat-2", "chat-3", "chat-4"]  # original ids, group order, nothing dropped
    ok = by["chat-1"]
    assert ok["status"] == "ok" and ok["score"] == {"final_score": 85.38, "critical_flag": False}
    assert [c["criterion_id"] for c in ok["criteria"]] == list(rx.CODES.values())
    values = {c["criterion_id"]: c["value"] for c in ok["criteria"]}
    assert values == {"contact": True, "discovery": None, "identification": None, "consultation": 15,
                      "empathy": True, "dialogue": 7, "closure": True, "critical": False}  # the newer mock is ignored
    assert ok["criteria"][0]["evidence_turns"] == [1, 4] and ok["criteria"][0]["rationale"] == "пояснение c01"
    assert by["chat-2"]["status"] == "error" and "ошибкой" in by["chat-2"]["error"]
    assert by["chat-3"]["status"] == "error" and "мок" in by["chat-3"]["error"]
    assert by["chat-4"] == {"conversation_id": "chat-4", "status": "error", "criteria": [], "score": None,
                            "error": "Диалог не оценён: нет запуска модели по этому чек-листу."}


def skipped(criterion_id="c07", *, rng=None, evidence=(), answer="no"):
    """A result where the operator skipped the action: no lines to quote, only what was checked."""
    return CriterionResult(criterion_id=criterion_id, answer=answer, explanation="не сделал", confidence="high",
                           points=None, effective_weight=None, model="claude-haiku-5-5", evidence=list(evidence),
                           checked_range=None if rng is None else CheckedRange(**{"from": rng[0], "to": rng[1]}))


def test_a_skipped_action_points_at_the_operator_lines_it_checked():
    lines = conversation("chat-1").transcript  # operator at 0, 2, 4; client at 1, 3, 5
    assert rx.evidence_turns(skipped(rng=(1, 4)), lines) == [3, 5]  # 1-based, over the full array
    assert rx.evidence_turns(skipped(rng=(3, 3)), lines) == [4]  # only a client line: the range itself
    assert rx.evidence_turns(skipped(rng=(-2, 99)), lines) == [1, 3, 5]  # clipped to the transcript
    assert rx.evidence_turns(skipped(rng=(7, 9)), lines) == []  # nothing of it exists
    assert rx.evidence_turns(skipped(rng=(4, 2)), lines) == []  # a reversed range is not guessed at
    assert rx.evidence_turns(skipped(), lines) == []  # neither evidence nor range: no turns invented
    assert rx.evidence_turns(skipped(answer="na"), lines) == []


def test_a_range_without_operator_lines_is_given_whole():
    lines = [Message(timestamp=f"00:0{i}", speaker=s, text=f"line {i}")
             for i, s in enumerate(["client", "bot", "system", "client", "operator"])]
    assert rx.evidence_turns(skipped(rng=(0, 3)), lines) == [1, 2, 3, 4]
    assert rx.evidence_turns(skipped(rng=(0, 4)), lines) == [5]


def test_evidence_lines_win_over_the_checked_range():
    lines = conversation("chat-1").transcript
    cited = [Evidence(message_index=4, quote="q", role="expected_here"), Evidence(message_index=1, quote="q", role="supports")]
    assert rx.evidence_turns(skipped(rng=(0, 5), evidence=cited), lines) == [2, 5]
    stale = [Evidence(message_index=40, quote="q", role="supports")]  # out of range: no valid turn, so the range
    assert rx.evidence_turns(skipped(rng=(0, 3), evidence=stale), lines) == [1, 3]


def test_the_checked_range_survives_the_store_and_backs_final_answers_too(client):
    from app import store
    store.upsert_conversation(conversation("chat-1"), None)
    ev = run("CTRL:chat-1")
    ev.results[6] = skipped(rng=(1, 5))  # closure: the operator never said goodbye
    ev.results[6].final_answer = "yes"  # a reviewer disagreed; the checked lines stay the same
    ev.original_total = "77.69"  # closure no: 50.5 of 65; the final total keeps the fixture's 85.38
    store.insert_evaluation(ev)
    for answers in ("original", "final"):
        doc = rx.build(store, "CTRL", "official-chat", 1, team="gtbsbe", mode="external_api", answers=answers)
        closure = next(c for c in doc["results"][0]["criteria"] if c["criterion_id"] == "closure")
        assert closure["evidence_turns"] == [3, 5]
        assert closure["value"] is (answers == "final")
        assert rx.validate(doc, expect=1) == []


def test_cli_writes_utf8_json_and_fails_on_a_wrong_count(client, tmp_path, capsys):
    from app import store
    store.upsert_conversation(conversation("chat-1"), None)
    store.insert_evaluation(run("CTRL:chat-1"))
    out = tmp_path / "results" / "prod" / "results.json"
    assert rx.main(["--group", "CTRL", "--out", str(out), "--expect", "1"]) == 0
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert doc["results"][0]["conversation_id"] == "chat-1" and "пояснение" in out.read_text(encoding="utf-8")
    assert rx.main(["--group", "CTRL", "--out", str(out), "--expect", "10"]) == 1
    assert "expected 10" in capsys.readouterr().err


def test_turns_from_text_reads_line_citations_only():
    text = ("Оператор в первом сообщении (индекс 9) поздоровался; клиент (сообщение 0) описал проблему, "
            "сообщения 13, 16 и 18 ведут диалог, ответы (21, 23) понятны, реплика [4]; сообщения 5–7. "
            "Первая реакция 57 секунд, порог 3 минуты, сообщение 99 вне диалога.")
    assert rx.turns_from_text(text, 30) == [1, 5, 6, 7, 8, 10, 14, 17, 19, 22, 24]


def test_from_devrun_builds_a_valid_file_in_dataset_order():
    rows = lambda: [{"criterion_id": k, "answer": a, "model": "claude-haiku-5-5",
                     "explanation": f"{k}: см. сообщение 2 и реплику [0]."}
                    for k, a in zip(rx.CODES, ["yes", "na", "na", {"step": 15}, "yes", {"step": 7}, "yes", "no"])]
    report = {"model": None, "conversations": {
        "DEV:b": {"results": rows(), "failures": []},
        "DEV:a": {"results": rows()[:-1], "failures": [{"criterion_id": "c08", "reason": "x"}]}}}
    records = [{"conversation_id": c, "transcript": [{"speaker": "client", "text": "t"}] * 3} for c in ("a", "b", "c")]
    doc = rx.from_devrun(report, records, team="gtbsbe", mode="external_api")
    assert rx.validate(doc, expect=3) == []
    assert [r["conversation_id"] for r in doc["results"]] == ["a", "b", "c"]
    assert [r["status"] for r in doc["results"]] == ["error", "ok", "error"]
    ok = doc["results"][1]
    assert ok["score"] == {"final_score": 85.38, "critical_flag": False}
    assert ok["criteria"][0]["evidence_turns"] == [1, 3]
    assert doc["model"]["name"] == "claude-haiku-5-5"
