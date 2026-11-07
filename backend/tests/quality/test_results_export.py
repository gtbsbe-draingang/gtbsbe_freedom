"""The organisers' results file (appendix «Как сдать результаты», JSON 1.0)."""
import copy
import json

from app.models import Conversation, CriterionResult, Evaluation, Evidence, Message, StepAnswer
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
