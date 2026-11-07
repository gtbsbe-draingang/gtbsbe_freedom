import pytest

from evaluator import checking as ck
from evaluator.checking import check_answer, check_output, normalize, quote_matches
from evaluator.schemas import CriterionOutput
from evaluator.testing import (
    VALID_C01_NO,
    make_conv,
    make_criterion,
    make_gross_criterion,
)

CONV = make_conv(
    [
        ("client", "Мне нужен ноутбук"),
        ("operator", "Привет, где именно ищете?"),
        ("operator", "Меня зовут Алия, чем помочь?"),
        ("client", "ок"),
    ]
)
# masked by hand: this branch does not depend on masking.py
MASKED = [m.model_copy(update={"text": m.text.replace("Алия", "[ИМЯ]")}) for m in CONV.transcript]


def out(**kw) -> CriterionOutput:
    return CriterionOutput.model_validate({**VALID_C01_NO, **kw})


def codes(problems):
    return [p.code for p in problems]


def check(o, crit=None):
    return codes(check_output(o, crit or make_criterion(), CONV, MASKED))


# --- normalize / quote_matches ---------------------------------------------------------------
def test_normalize():
    assert normalize("  Ёлка,  ПРИВЕТ!! ") == "елка привет"


@pytest.mark.parametrize(
    "quote",
    [
        "Привет, где именно ищете?",
        "привет где именно ищете",
        "ПРИВЕТ, ГДЕ ИМЕННО ИЩЕТЕ!!!",
        "где именно",
        "Привет, где имено ищете?",  # typo, 12+ chars -> fuzzy
    ],
)
def test_quote_matches(quote):
    assert quote_matches(quote, "Привет, где именно ищете?", "Привет, где именно ищете?")


def test_yo_variants():
    assert quote_matches("все хорошо", "Всё хорошо", "Всё хорошо")


def test_quote_matches_masked_or_original():
    assert quote_matches("Меня зовут [ИМЯ]", "Меня зовут Алия", "Меня зовут [ИМЯ]")
    assert quote_matches("Меня зовут Алия", "Меня зовут Алия", "Меня зовут [ИМЯ]")


@pytest.mark.parametrize("quote", ["Добрый вечер, чем могу помочь вам сегодня", "", "!!!", "xyz"])
def test_invented_quote_rejected(quote):
    assert not quote_matches(quote, "Привет, где именно ищете?", "Привет, где именно ищете?")


def test_short_quote_no_fuzzy():
    assert not quote_matches("прибет", "Привет", "Привет")


# --- check_answer ----------------------------------------------------------------------------
def test_answer_ok():
    assert check_answer("yes", None, [], make_criterion()) == []
    assert check_answer("step", 7, [], make_criterion(answer_type="scale")) == []


def test_answer_type_mismatch():
    assert codes(check_answer("step", 1, [], make_criterion())) == [ck.ANSWER_NOT_ALLOWED]
    assert codes(check_answer("yes", None, [], make_criterion(answer_type="scale"))) == [ck.ANSWER_NOT_ALLOWED]


def test_na():
    assert codes(check_answer("na", None, [], make_criterion())) == [ck.NA_NOT_ALLOWED]
    assert check_answer("na", None, [], make_criterion(na_allowed=True)) == []
    scale = make_criterion(answer_type="scale", na_allowed=True)
    assert check_answer("na", None, [], scale) == []


def test_step_by_value_not_position():
    scale = make_criterion(answer_type="scale")  # 0/4/7/10
    assert codes(check_answer("step", 2, [], scale)) == [ck.STEP_NOT_IN_SCALE]
    assert codes(check_answer("step", None, [], scale)) == [ck.STEP_NOT_IN_SCALE]
    assert check_answer("step", 4, [], scale) == []


def test_kinds():
    g = make_gross_criterion()
    assert check_answer("no", None, [], g) == []
    assert check_answer("yes", None, ["insult"], g) == []
    assert codes(check_answer("yes", None, [], g)) == [ck.KINDS_MISSING]
    assert codes(check_answer("yes", None, ["rude"], g)) == [ck.KINDS_NOT_ALLOWED]
    assert codes(check_answer("no", None, ["insult"], g)) == [ck.KINDS_NOT_ALLOWED]
    assert codes(check_answer("yes", None, ["insult"], make_criterion())) == [ck.KINDS_NOT_ALLOWED]


def test_fatal_flag():
    p = check_answer("na", None, [], make_criterion())[0]
    assert p.fatal and not ck.Problem(ck.QUOTE_MISMATCH, "x").fatal


# --- check_output ----------------------------------------------------------------------------
def test_valid_output():
    assert check(out()) == []


def test_invented_index():
    o = out(evidence=[{"message_index": 9, "quote": "ок", "role": "supports"}])
    problems = check_output(o, make_criterion(), CONV, MASKED)
    assert codes(problems) == [ck.INDEX_OUT_OF_RANGE] and problems[0].evidence_index == 0
    assert check(out(evidence=[{"message_index": -1, "quote": "ок", "role": "supports"}])) == [ck.INDEX_OUT_OF_RANGE]


def test_wrong_quote_flags_only_bad_item():
    o = out(
        evidence=[
            {"message_index": 1, "quote": "Привет, где именно ищете?", "role": "supports"},
            {"message_index": 3, "quote": "Спасибо большое за помощь", "role": "supports"},
        ]
    )
    problems = check_output(o, make_criterion(), CONV, MASKED)
    assert codes(problems) == [ck.QUOTE_MISMATCH] and problems[0].evidence_index == 1


def test_masked_quote_accepted():
    o = out(evidence=[{"message_index": 2, "quote": "Меня зовут [ИМЯ]", "role": "supports"}])
    assert check(o) == []


def test_range_required_for_missing_action():
    expected = [{"message_index": 1, "quote": "где именно ищете", "role": "expected_here"}]
    assert check(out(evidence=expected)) == [ck.CHECKED_RANGE_MISSING]
    assert check(out(evidence=expected, checked_range={"from_index": 0, "to_index": 3})) == []
    assert check(out(evidence=[], checked_range=None)) == [ck.CHECKED_RANGE_MISSING]


@pytest.mark.parametrize("lo, hi", [(2, 1), (-1, 2), (0, 4)])
def test_range_invalid(lo, hi):
    assert check(out(checked_range={"from_index": lo, "to_index": hi})) == [ck.CHECKED_RANGE_INVALID]


def test_na_reason():
    c = make_criterion(na_allowed=True)
    o = out(answer="na", evidence=[], na_reason=None, checked_range=None)
    assert check(o, c) == [ck.NA_REASON_MISSING]
    assert check(out(answer="na", evidence=[], na_reason="условие N/A", checked_range=None), c) == []
    assert check(out(answer="na", evidence=[], na_reason="  ", checked_range=None), c) == [ck.NA_REASON_MISSING]


def test_na_not_allowed_in_output():
    o = out(answer="na", na_reason="r", evidence=[], checked_range=None)
    assert check(o) == [ck.NA_NOT_ALLOWED]


def test_explanation_missing():
    assert check(out(explanation="  ")) == [ck.EXPLANATION_MISSING]


def test_unknown_step_in_output():
    o = out(answer="step", step=2)
    assert ck.STEP_NOT_IN_SCALE in check(o, make_criterion(answer_type="scale"))
