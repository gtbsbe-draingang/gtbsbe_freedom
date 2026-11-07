"""Reuse keys: pay for each judgment once.

Owner: #19 (PLAN.md S4). Tests: test_keys.py.

reuse_key = sha256(canonical JSON {PROMPT_VERSION, model, criterion.fingerprint, checklist.guidance,
transcript_hash, facts, voice_measurements}), 64 hex. plus the rendered checklist context and criterion block. NOT weight, order, rounding.
The 4-argument signature is shared with B; never reorder.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from evaluator import prompt
from evaluator._compat import ChecklistVersion, Conversation, Criterion


def _sha(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def transcript_hash(conv: Conversation) -> str:
    """sha256 hex of the transcript (timestamp, speaker, text, duplicate per line)."""
    return _sha([[m.timestamp, m.speaker, m.text, m.duplicate] for m in conv.transcript])


def reuse_key(conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, model: str) -> str:
    """64-hex key; same inputs -> same key. See module docstring for what is in it."""
    return _sha(
        {
            "prompt_version": prompt.PROMPT_VERSION,
            "model": model,
            "fingerprint": criterion.fingerprint,
            "guidance": checklist.guidance,
            # What the model is actually shown, so wording / N/A / name edits can never reuse a stale
            # result even when B's fingerprint misses them. Weight and order are not rendered.
            "context": prompt.render_checklist_context(checklist),
            "criterion_block": prompt.render_criterion(checklist, criterion),
            "transcript": transcript_hash(conv),
            "facts": conv.facts.model_dump(mode="json") if conv.facts else None,
            "voice": [v.model_dump(mode="json") for v in conv.voice_measurements],
        }
    )


def info_key(conv: Conversation, model: str) -> str:
    """64-hex key of the not-scored dialogue info: prompt version, model, transcript, facts."""
    return _sha(
        {
            "kind": "info",
            "prompt_version": prompt.PROMPT_VERSION,
            "model": model,
            "transcript": transcript_hash(conv),
            "facts": conv.facts.model_dump(mode="json") if conv.facts else None,
        }
    )
