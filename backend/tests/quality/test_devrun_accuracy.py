"""#73: an evaluator.devrun report scored against the references with the shared accuracy code."""
import json

from quality import devrun_accuracy as da


def test_devrun_report_is_scored_like_the_api(tmp_path):
    reference = {"checklist_id": "official-chat", "version": 2, "labels": [
        {"conversation_id": "a", "criterion_id": "c01", "answer": "yes"},
        {"conversation_id": "a", "criterion_id": "c04", "answer": {"step": 15}},
        {"conversation_id": "b", "criterion_id": "c01", "answer": "no"},
        {"conversation_id": "b", "criterion_id": "c07", "answer": "yes", "disputed": True},
        {"conversation_id": "c", "criterion_id": "c01", "answer": "yes"},
    ]}
    path = tmp_path / "labels.json"
    path.write_text(json.dumps(reference), encoding="utf-8")
    row = lambda k, a: {"criterion_id": k, "answer": a, "model": "claude-haiku-5-5", "explanation": "e", "confidence": "high"}
    report = {"model": None, "totals": {"calls": 3, "failures": 0, "cost_usd": "0.01"}, "conversations": {
        "DEV:a": {"results": [row("c01", "yes"), row("c04", {"step": 20})]},
        "DEV:b": {"results": [row("c01", "no"), row("c07", "no")]}}}
    records = [{"conversation_id": c, "channel": ch, "language": "RU", "transcript": []}
               for c, ch in (("a", "agent chat"), ("b", "voice call"), ("c", "agent chat"))]
    doc = da.build(report, records, path)
    r = doc["report"]
    assert r["overall"] == {"agreement": 0.6667, "n": 3}
    assert (r["disputed_excluded"], r["missing"]) == (1, 1)  # c has no run: missing, not a disagreement
    assert r["disagreements"] == [{"conversation": "DEV:a", "conversation_id": "a", "criterion_id": "c04",
                                   "reference": {"step": 15}, "evaluated": {"step": 20}}]
    assert {x["channel"]: x["n"] for x in r["by_channel"]} == {"agent chat": 2, "voice call": 1}
    assert doc["run"]["conversations"] == 2 and doc["references"]["checklist"] == "official-chat v2"
