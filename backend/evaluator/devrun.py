"""DEV run script: run the evaluator on DEV on purpose (costs money; tests never do).

Owner: #20 (PLAN.md S8). Tests: test_devrun.py (replays evaluator/tests/recorded/).

    uv run python -m evaluator.devrun --data ../data/dev.json \\
        --checklist ../checklists/official-chat-v1.json --model claude-haiku-5-5 \\
        [--ids p1-ru-014,...] [--criteria c01,...] [--expectations-only] [--record DIR] \\
        --out runs/<name>.json

Prints per-criterion answers, needs_review count, failures, total cost. Exit 1 on any failed
expectation or JudgmentFailed. Loading DEV drops `audio_url` (the only allowed mention in C's code)
and marks exact consecutive duplicates. Record only synthetic chats, never p4-* calls.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path
from typing import Any

from evaluator import client
from evaluator._compat import ChecklistVersion, Conversation, Message
from evaluator.run import EvaluateOptions, evaluate

EXPECTATIONS_PATH = Path(__file__).with_name("dev_expectations.json")


@dataclass(frozen=True)
class Expectation:
    conversation_id: str
    criterion_id: str
    answer: str  # "yes" | "no" | "na" | "step:<value>"
    note: str = ""


def load_dev_conversations(path: Path, group_id: str = "DEV") -> list[Conversation]:
    """DEV file (the organisers' envelope `data.records`, or a bare list) -> Conversations with
    id `{group_id}:{conversation_id}`. the audio link is dropped; a message that repeats the previous
    one exactly (same speaker and text) gets duplicate=True, its index is kept."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict):  # organisers' envelope: {"error", "isSuccess", "data": {"records": [...]}}
        data = data.get("data", data)
        data = data["records"] if isinstance(data, dict) else data
    out: list[Conversation] = []
    for rec in data:
        msgs: list[Message] = []
        for m in rec["transcript"]:
            prev = msgs[-1] if msgs else None
            dup = prev is not None and (prev.speaker, prev.text) == (m["speaker"], m["text"])
            msgs.append(Message(timestamp=m["timestamp"], speaker=m["speaker"], text=m["text"], duplicate=dup))
        out.append(
            Conversation(
                id=f"{group_id}:{rec['conversation_id']}",
                conversation_id=rec["conversation_id"],
                group_id=group_id,
                channel=rec["channel"],
                language=rec["language"],
                transcript=msgs,
            )
        )
    return out


def load_expectations(path: Path = EXPECTATIONS_PATH) -> list[Expectation]:
    """JSON list of {conversation_id, criterion_id, answer, note?}."""
    return [Expectation(**e) for e in json.loads(Path(path).read_text(encoding="utf-8"))]


def _answer_str(answer: object) -> str:
    return f"step:{answer['step']}" if isinstance(answer, dict) else str(answer)


def check_expectations(run: dict, expectations: list[Expectation]) -> list[str]:
    """Messages for failed expectations; empty when all pass.

    `run` = {"conversations": {conversation_id: {"results": [{"criterion_id", "answer"}, ...]}}}
    (answer: "yes" | "no" | "na" | {"step": value}). A conversation or criterion absent from the run
    fails; a caller that ran a subset passes only the expectations it meant to run.
    """
    failed: list[str] = []
    for e in expectations:
        conv = run.get("conversations", {}).get(e.conversation_id)
        if conv is None:
            failed.append(f"{e.conversation_id} {e.criterion_id}: conversation not in run")
            continue
        got = {r["criterion_id"]: _answer_str(r["answer"]) for r in conv.get("results", [])}
        label = f"{e.conversation_id} {e.criterion_id}"
        if e.criterion_id not in got:
            failed.append(f"{label}: expected {e.answer}, no result")
        elif got[e.criterion_id] != e.answer:
            failed.append(f"{label}: expected {e.answer}, got {got[e.criterion_id]}" + (f" ({e.note})" if e.note else ""))
    return failed


class _Slot:
    """One reserved place in the recording; filled when the response arrives."""

    def __init__(self) -> None:
        self.entry: dict[str, Any] | None = None


class _RecordingEndpoint:
    def __init__(self, real: Any, slots: list[_Slot]) -> None:
        self._real, self._slots = real, slots

    async def create(self, **kwargs: Any) -> Any:
        slot = _Slot()
        self._slots.append(slot)  # request order, so replay is deterministic under parallel calls
        resp = await self._real.create(**kwargs)
        text = next((b.text for b in reversed(resp.content) if getattr(b, "type", "") == "text"), "")
        u = resp.usage
        slot.entry = {
            "text": text,
            "stop_reason": resp.stop_reason,
            "usage": [u.input_tokens, u.cache_creation_input_tokens or 0, u.cache_read_input_tokens or 0, u.output_tokens],
            "model": resp.model,
        }
        return resp


class _Recorder:
    """Wraps the real SDK client; keeps every response in `slots` (only text, stop reason, usage, model)."""

    def __init__(self, real: Any) -> None:
        from types import SimpleNamespace

        self.slots: list[_Slot] = []
        self.messages = _RecordingEndpoint(real.messages, self.slots)
        self.beta = SimpleNamespace(messages=_RecordingEndpoint(real.beta.messages, self.slots))


def _judgment_row(j: Any) -> dict:
    d = j.model_dump(mode="json", by_alias=True, exclude={"calls"})
    return {k: d[k] for k in ("criterion_id", "answer", "kinds", "needs_review", "confidence", "model", "explanation", "evidence",
                               "na_reason", "coaching")}


async def run(
    conversations: list[Conversation],
    checklist_path: Path,
    *,
    model: str | None = None,
    criteria: list[str] | None = None,
    record_dir: Path | None = None,
    with_info: bool = True,
) -> dict:
    """Evaluate each conversation in turn. Returns the shape check_expectations reads:
    {"conversations": {id: {"results": [{criterion_id, answer, ...}], "failures": [...], "info", "cost_usd",
    "needs_review"}}, "totals": {...}}. Costs money with a real client; tests replay recordings."""
    checklist = ChecklistVersion.model_validate_json(Path(checklist_path).read_text(encoding="utf-8"))
    recorder = None
    if record_dir is not None:
        recorder = _Recorder(client.get_client())
        client.set_client(recorder)
        Path(record_dir).mkdir(parents=True, exist_ok=True)
    out: dict[str, Any] = {}
    total, n_calls, n_failures, n_review = Decimal(0), 0, 0, 0
    try:
        for conv in conversations:
            start = len(recorder.slots) if recorder else 0
            r = await evaluate(conv, checklist, EvaluateOptions(model=model, criteria=criteria, with_info=with_info))
            out[conv.id] = {
                "results": [_judgment_row(j) for j in r.results],
                "failures": [f.model_dump() for f in r.failures],
                "info": r.info.model_dump() if r.info else None,
                "info_error": r.info_error,
                "cost_usd": str(r.cost_usd),
                "needs_review": r.needs_review,
            }
            total += r.cost_usd
            n_calls += len(r.calls)
            n_failures += len(r.failures)
            n_review += sum(j.needs_review for j in r.results)
            if recorder:
                entries = [s.entry for s in recorder.slots[start:] if s.entry]
                name = conv.conversation_id
                (Path(record_dir) / f"{name}.json").write_text(json.dumps(entries, ensure_ascii=False, indent=1), encoding="utf-8")
    finally:
        if recorder:
            client.set_client(None)
    return {
        "model": model,
        "conversations": out,
        "totals": {"calls": n_calls, "failures": n_failures, "needs_review": n_review, "cost_usd": str(total)},
    }


def _split(value: str | None) -> list[str] | None:
    return [v for v in value.split(",") if v] if value else None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="evaluator.devrun", description=__doc__.splitlines()[0])
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--checklist", type=Path, required=True)
    ap.add_argument("--model")
    ap.add_argument("--ids", help="comma-separated conversation ids (without the group prefix)")
    ap.add_argument("--criteria", help="comma-separated criterion ids")
    ap.add_argument("--expectations-only", action="store_true")
    ap.add_argument("--expectations", type=Path, default=EXPECTATIONS_PATH)
    ap.add_argument("--record", type=Path)
    ap.add_argument("--out", type=Path)
    args = ap.parse_args(argv)

    from app.db import migrate

    migrate()  # the c_llm_calls table; the app does this on startup, a script run must too
    convs = load_dev_conversations(args.data)
    expectations = load_expectations(args.expectations)
    ids, criteria = _split(args.ids), _split(args.criteria)
    with_info = True
    if args.expectations_only:
        wanted = {e.conversation_id for e in expectations}
        convs = [c for c in convs if c.id in wanted]
        criteria = sorted({e.criterion_id for e in expectations})
        with_info = False
    if ids:
        convs = [c for c in convs if c.conversation_id in ids]
        if not args.expectations_only:  # a subset run only answers for its own conversations
            expectations = [e for e in expectations if e.conversation_id in {c.id for c in convs}]
    if not convs:
        print("no conversations to run (check --data, --ids and the expectations)")
        return 1
    try:
        result = asyncio.run(
            run(convs, args.checklist, model=args.model, criteria=criteria, record_dir=args.record, with_info=with_info)
        )
    except client.ModelKeyMissing:
        print("ANTHROPIC_API_KEY is not set")
        return 2

    for cid, c in result["conversations"].items():
        answers = " ".join(f"{r['criterion_id']}={_answer_str(r['answer'])}" for r in c["results"])
        print(f"{cid}: {answers}" + (" [needs_review]" if c["needs_review"] else ""))
        for f in c["failures"]:
            print(f"  FAILED {f['criterion_id']}: {f['reason']}")
    failed = check_expectations(result, expectations)
    t = result["totals"]
    print(f"conversations={len(convs)} calls={t['calls']} needs_review={t['needs_review']} "
          f"failures={t['failures']} cost_usd={t['cost_usd']}")
    print(f"expectations: {len(expectations) - len(failed)} ok, {len(failed)} failed")
    for m in failed:
        print("  " + m)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({**result, "failed_expectations": failed}, ensure_ascii=False, indent=1), encoding="utf-8")
    return 1 if failed or t["failures"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
