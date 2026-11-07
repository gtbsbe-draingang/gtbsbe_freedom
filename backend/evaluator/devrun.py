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

from dataclasses import dataclass
from pathlib import Path

from evaluator._compat import Conversation

EXPECTATIONS_PATH = Path(__file__).with_name("dev_expectations.json")


@dataclass(frozen=True)
class Expectation:
    conversation_id: str
    criterion_id: str
    answer: str  # "yes" | "no" | "na" | "step:<value>"
    note: str = ""


def load_dev_conversations(path: Path, group_id: str = "DEV") -> list[Conversation]:
    raise NotImplementedError("S8 (#20): load_dev_conversations")


def load_expectations(path: Path = EXPECTATIONS_PATH) -> list[Expectation]:
    raise NotImplementedError("S8 (#20): load_expectations")


def check_expectations(run: dict, expectations: list[Expectation]) -> list[str]:
    """Messages for failed expectations; empty when all pass."""
    raise NotImplementedError("S8 (#20): check_expectations")


async def run(
    conversations: list[Conversation],
    checklist_path: Path,
    *,
    model: str | None = None,
    criteria: list[str] | None = None,
    record_dir: Path | None = None,
) -> dict:
    raise NotImplementedError("S8 (#20): run")


def main(argv: list[str] | None = None) -> int:
    raise NotImplementedError("S8 (#20): main")


if __name__ == "__main__":
    raise SystemExit(main())
