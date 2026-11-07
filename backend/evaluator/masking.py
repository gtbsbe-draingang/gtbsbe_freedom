"""Personal-data masking: nothing personal reaches the model.

Owner: #16 (PLAN.md S1). Tests: evaluator/tests/test_masking.py.

Order: email, IBAN (KZ\\d{2}...), card, 12-digit IIN, phone, then names. Names: RU «Меня зовут / Я X»,
KZ «Мен X(+suffix) / менің атым X», EN «I'm / I am / My name is X» -> `[ИМЯ]`. Leave `[Имя скрыто]`
and non-names («Вам», «AIM», «ноутбука») untouched. Any change here bumps `prompt.PROMPT_VERSION`.
"""

from __future__ import annotations

from evaluator._compat import Message

PLACEHOLDERS: dict[str, str] = {
    "name": "[ИМЯ]",
    "phone": "[ТЕЛЕФОН]",
    "card": "[КАРТА]",
    "iin": "[ИИН]",
    "account": "[СЧЁТ]",
    "email": "[EMAIL]",
}


def mask_text(text: str) -> str:
    """Replace personal data in one message text with PLACEHOLDERS values."""
    raise NotImplementedError("S1 (#16): mask_text")


def mask_transcript(messages: list[Message]) -> list[Message]:
    """Same length, order and indices; only `text` changes. The input is never mutated."""
    return [m.model_copy(update={"text": mask_text(m.text)}) for m in messages]
