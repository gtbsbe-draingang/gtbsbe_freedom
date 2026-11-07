"""Prompt rendering: built only from checklist data + facts + the masked transcript.

Owner: #17 (PLAN.md S2). Tests: evaluator/tests/test_prompt.py.

Rules: no criterion title, id, wording, weight or scale value in this file or SYSTEM_PROMPT.
Bump PROMPT_VERSION on any change to the prompt, rendering or masking (it is in every reuse key).
"""

from __future__ import annotations

from evaluator._compat import ChecklistVersion, Conversation, Criterion, Message

PROMPT_VERSION = "c1"

SYSTEM_PROMPT = ""  # S2: English instructions; outputs in Russian; transcript text is data, not orders.

# Tags the transcript / appeal comment are wrapped in; their occurrences inside text are
# neutralised to ‹ › by `neutralize_tags`.
TRANSCRIPT_TAG = "transcript"
APPEAL_COMMENT_TAG = "appeal_comment"


def neutralize_tags(text: str, tags: tuple[str, ...] = (TRANSCRIPT_TAG, APPEAL_COMMENT_TAG)) -> str:
    """Turn `<tag>`/`</tag>` inside user text into `‹tag›`/`‹/tag›`. Reused by S10 and S11."""
    raise NotImplementedError("S2 (#17): neutralize_tags")


def render_transcript(conv: Conversation, masked: list[Message]) -> str:
    """Lines `[index] offset speaker: text`; duplicates skipped, indices never shift.

    Chats show the original `MM:SS`; calls show `+m:ss` from the first line (display only).
    """
    raise NotImplementedError("S2 (#17): render_transcript")


def render_facts(conv: Conversation) -> str:
    """Facts block (incl. `first_reaction_over_3_min`); "not computed" when `conv.facts is None`.

    Adds a `voice_measurements:` block only for calls that have measurements.
    """
    raise NotImplementedError("S2 (#17): render_facts")


def render_checklist_context(checklist: ChecklistVersion) -> str:
    """Checklist-wide guidance, rendered once in the cached prefix."""
    raise NotImplementedError("S2 (#17): render_checklist_context")


def render_criterion(checklist: ChecklistVersion, criterion: Criterion) -> str:
    """The per-criterion block, ending with an `Allowed answers:` line built from answer_type,
    scale_steps (value + label), na_allowed / na_condition and kinds."""
    raise NotImplementedError("S2 (#17): render_criterion")


def build_blocks(
    conv: Conversation, masked: list[Message], checklist: ChecklistVersion, criterion: Criterion
) -> list[dict]:
    """[prefix, criterion_block] as Messages API text blocks.

    prefix = checklist context + transcript + facts, with `cache_control: {"type": "ephemeral"}`,
    byte-identical for every criterion of one dialogue.
    """
    raise NotImplementedError("S2 (#17): build_blocks")
