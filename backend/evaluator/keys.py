"""Reuse keys: pay for each judgment once.

Owner: #19 (PLAN.md S4). Tests: test_keys.py.

reuse_key = sha256(canonical JSON {PROMPT_VERSION, model, criterion.fingerprint, checklist.guidance,
transcript_hash, facts, voice_measurements}), 64 hex. NOT weight, order, rounding.
The 4-argument signature is shared with B; never reorder.
"""

from __future__ import annotations

from evaluator._compat import ChecklistVersion, Conversation, Criterion


def transcript_hash(conv: Conversation) -> str:
    """sha256 hex of the transcript (timestamp, speaker, text, duplicate per line)."""
    raise NotImplementedError("S4 (#19): transcript_hash")


def reuse_key(conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, model: str) -> str:
    """64-hex key; same inputs -> same key. See module docstring for what is in it."""
    raise NotImplementedError("S4 (#19): reuse_key")
