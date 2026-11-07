"""Personal-data masking: nothing personal reaches the model.

Owner: #16 (PLAN.md S1). Tests: evaluator/tests/test_masking.py.

Order: email, IBAN (KZ\\d{2}...), card, 12-digit IIN, phone, then names. Names: RU «Меня зовут / Я X»,
KZ «Мен X(+suffix) / менің атым X», EN «I'm / I am / My name is X» -> `[ИМЯ]`. Leave `[Имя скрыто]`
and non-names («Вам», «AIM», «ноутбука») untouched. Any change here bumps `prompt.PROMPT_VERSION`.
"""

from __future__ import annotations

import re

from evaluator._compat import Message

PLACEHOLDERS: dict[str, str] = {
    "name": "[ИМЯ]",
    "phone": "[ТЕЛЕФОН]",
    "card": "[КАРТА]",
    "iin": "[ИИН]",
    "account": "[СЧЁТ]",
    "email": "[EMAIL]",
}


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_IBAN = re.compile(r"\bKZ\d{2}(?: ?[0-9A-Z]{4}){4}\b", re.I)
_CARD = re.compile(r"(?<![\d-])(?:\d{4}[ -]?){3}\d{4}(?![\d-])")
_IIN = re.compile(r"(?<!\d)\d{12}(?!\d)")
_PHONE = re.compile(r"(?<![\w+])(?:\+7|8|7)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)")

_CYR_UP, _CYR_LOW = "А-ЯЁӘҒҚҢӨҰҮІҺ", "а-яёәғқңөұүіһ"
_CYR_NAME = rf"[{_CYR_UP}][{_CYR_LOW}'-]+"
_EN_NAME = r"[A-Z][a-z'-]+"
_ANY_WORD = rf"[A-Za-z{_CYR_UP}{_CYR_LOW}'-]{{2,}}"
# Polite «Вы»/«Сіз» forms and common English words that follow the cue but are not names.
_NOT_RU = r"(?!(?:Вы|Вам|Вас|Вами|Ваш\w*)(?![\w])|Сіз\w*)"
_NOT_EN = r"(?!(?:Sorry|Happy|Glad|Sure|Afraid|Here|Calling|Writing|Not|Ready|Fine|Back)\b)"
# After a bare «Я» / «I'm» the next capitalised word is often a verb or filler, not a name:
# first-person verbs end in у/ю, English participles in -ing, plus a short stoplist.
_NOT_BARE = (
    r"(?!(?:Не|Ни|Уже|Только|Сейчас|Рад|Рада|Готов|Готова|Понял|Поняла|Вижу|Постараюсь|Просто|Всегда|Тоже|Также"
    r"|Тут|Здесь|Бот|AIM|Not|Just|Here|Sorry|Happy|Glad|Sure|Afraid|Ready|Fine|Back|Still|Also|Always)\b)"
    r"(?![A-Za-zА-ЯЁа-яё'-]*(?:у|ю|ing)\b)"
)
# A bare cue counts only if the name is followed by end, punctuation, another capitalised word or a role word.
_BARE_TAIL = (
    r"(?=\s*(?:$|[,.!?;:—–)-]|\s[A-ZА-ЯЁ]|\s+(?:специалист|оператор|менеджер|консультант|ассистент|из|на\s+связи"
    r"|from|your|the|here|with|at|and|will|and)\b))"
)
_STARTERS = r"(?!(?:Чем|Что|Как|Если|Я|Вы|Добрый|Здравствуйте|Подскажите|Слушаю|Hello|How|What|Can|Thank)\b)"
_MORE_RU = rf"(?:[ ]+{_STARTERS}{_CYR_NAME}){{0,2}}"
_MORE_EN = rf"(?:[ ]+(?!(?:How|What|Can|Thank|Hello|I)\b){_EN_NAME}){{0,2}}"

# Each pattern's group 1 is the name run; the cue stays, the run becomes [ИМЯ].
_NAMES = [
    # explicit cues: lowercase names count too
    re.compile(rf"(?i:меня\s+зовут|менің\s+(?:атым|есімім)|\bатым|\bmy\s+name\s+is)\s+{_NOT_RU}{_NOT_EN}"
               rf"((?:{_CYR_NAME}|{_EN_NAME}|(?-i:[a-z{_CYR_LOW}'-]{{2,}})){_MORE_RU}{_MORE_EN})"),
    # bare «Я X» / «I'm X» / «I am X»
    re.compile(rf"(?i:\bя)\s+{_NOT_RU}{_NOT_BARE}({_CYR_NAME}){_BARE_TAIL}"),
    re.compile(rf"(?i:\bi['’]m|\bi\s+am)\s+{_NOT_EN}{_NOT_BARE}({_EN_NAME}{_MORE_EN}){_BARE_TAIL}"),
    re.compile(rf"(?i:\bмен)\s+((?=[{_CYR_UP}])[{_CYR_UP}{_CYR_LOW}'-]*?(?:мын|мін|пын|пін|бын|бін))(?![\w])"),
]


def _numbers(text: str) -> str:
    for pattern, key in ((_EMAIL, "email"), (_IBAN, "account"), (_CARD, "card"), (_IIN, "iin"), (_PHONE, "phone")):
        text = pattern.sub(PLACEHOLDERS[key], text)
    return text


def _introduced(text: str) -> set[str]:
    """Single name tokens (3+ letters) introduced in `text` by a cue."""
    found: set[str] = set()
    for pattern in _NAMES:
        for m in pattern.finditer(text):
            found.update(t for t in m.group(1).split() if len(t) >= 3)
    return found


def _mask(text: str, names: set[str]) -> str:
    text = _numbers(text)
    for pattern in _NAMES:
        text = pattern.sub(lambda m: m.group(0).replace(m.group(1), PLACEHOLDERS["name"]), text)
    if names:
        alt = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
        text = re.sub(rf"(?<![\w\[])(?:{alt})(?![\w\]])", PLACEHOLDERS["name"], text)
    return text


def mask_text(text: str) -> str:
    """Replace personal data in one message text with PLACEHOLDERS values. Names introduced in
    the text are masked everywhere in it."""
    return _mask(text, _introduced(text))


def mask_transcript(messages: list[Message]) -> list[Message]:
    """Same length, order and indices; only `text` changes. The input is never mutated.
    A name introduced in any message is masked wherever it appears later (or earlier)."""
    names: set[str] = set()
    for m in messages:
        names |= _introduced(m.text)
    return [m.model_copy(update={"text": _mask(m.text, names)}) for m in messages]
