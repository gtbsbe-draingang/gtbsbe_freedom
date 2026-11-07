"""Exact scoring: the test vectors T1-T4 of section 6 of the front-end design, plus the edges.

The official checklist seed is built inline here (stream B does not wait for the seeding task).
Fingerprints are dummies: scoring never reads them.
"""

import ast
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest

import app.scoring as scoring_module
from app.models import ChecklistVersion, Criterion, Section, StepAnswer
from app.scoring import Scored, fraction, round2, score, validate_answer

D = Decimal


# --- builders ------------------------------------------------------------------------------


def crit(
    id: str,
    section_id: str,
    order: int,
    weight,
    *,
    answer_type: str = "yes_no",
    steps: list[int] | None = None,
    na: bool = False,
    kind: str = "scored",
    kinds: list[str] | None = None,
) -> Criterion:
    return Criterion(
        id=id,
        section_id=section_id,
        order=order,
        title=f"title {id}",
        wording=f"wording {id}",
        answer_type=answer_type,
        scale_steps=[{"value": v, "label": f"step {v}"} for v in steps or []],
        weight=weight,
        na_allowed=na,
        kind=kind,
        kinds=kinds or [],
        fingerprint=f"fp-{id}",
    )


def checklist(
    criteria: list[Criterion], sections: list[tuple[str, int]] | None = None
) -> ChecklistVersion:
    if sections is None:
        sections = [(sid, i) for i, sid in enumerate(dict.fromkeys(c.section_id for c in criteria))]
    return ChecklistVersion(
        checklist_id="test",
        version=1,
        name="test checklist",
        sections=[Section(id=sid, title=sid, order=order) for sid, order in sections],
        criteria=criteria,
    )


def official_criteria() -> list[Criterion]:
    return [
        crit("c01", "start", 1, 10),
        crit("c02", "start", 2, 15, na=True),
        crit("c03", "safety", 3, 20, na=True),
        crit("c04", "safety", 4, 20, answer_type="scale", steps=[0, 5, 10, 15, 20], na=True),
        crit("c05", "conduct", 5, 15),
        crit("c06", "conduct", 6, 15, answer_type="scale", steps=[0, 4, 7, 10]),
        crit("c07", "conduct", 7, 5, na=True),
        crit(
            "c08",
            "gross",
            8,
            0,
            kind="gross_error",
            kinds=["insult", "paid_service_outside_company", "confidential_disclosure"],
        ),
    ]


@pytest.fixture
def official() -> ChecklistVersion:
    return checklist(official_criteria())


def answers(**spec) -> dict:
    """c01="yes", c04=15 (a step), c08=("yes", ["insult"]) -> the shape score() takes."""
    out = {}
    for cid, value in spec.items():
        kinds: list[str] = []
        if isinstance(value, tuple):
            value, kinds = value
        out[cid] = (StepAnswer(step=value) if isinstance(value, int) else value, kinds)
    return out


ALL_YES = {
    "c01": "yes",
    "c02": "yes",
    "c03": "yes",
    "c04": 20,
    "c05": "yes",
    "c06": 10,
    "c07": "yes",
    "c08": "no",
}


def with_(base: dict, **changes) -> dict:
    return answers(**{**base, **changes})


# --- the four test vectors of the design --------------------------------------------------


def test_T1_all_yes_100(official):
    result = score(official, answers(**ALL_YES))
    assert result.total == D("100.00")
    assert result.gross_error.flag is False
    assert result.gross_error.kinds == []


def test_T2_na_redistribution(official):
    result = score(
        official,
        answers(c01="yes", c02="na", c03="na", c04=15, c05="yes", c06=7, c07="na", c08="no"),
    )
    assert result.total == D("84.17")

    points = {cid: r[0] for cid, r in result.results.items()}
    weights = {cid: r[1] for cid, r in result.results.items()}
    assert points["c01"] == D("16.67")
    assert points["c04"] == D("25.00")
    assert points["c05"] == D("25.00")
    assert points["c06"] == D("17.50")
    assert weights["c01"] == D("16.67")
    assert weights["c04"] == D("33.33")
    assert weights["c05"] == D("25.00")
    assert weights["c06"] == D("25.00")

    # The exact effective weights add up to exactly 100 (the rounded ones are for display).
    exact_weights = [w for _, w in result.exact_results.values() if w is not None]
    assert sum(exact_weights) == Fraction(100)
    assert result.exact_total == Fraction(505, 6)

    by_id = {s.section_id: s for s in result.sections}
    assert [s.section_id for s in result.sections] == ["start", "safety", "conduct", "gross"]
    assert (by_id["start"].points, by_id["start"].available, by_id["start"].percent) == (
        D("16.67"),
        D("16.67"),
        D("100.00"),
    )
    assert (by_id["safety"].points, by_id["safety"].available, by_id["safety"].percent) == (
        D("25.00"),
        D("33.33"),
        D("75.00"),
    )
    assert (by_id["conduct"].points, by_id["conduct"].available, by_id["conduct"].percent) == (
        D("42.50"),
        D("50.00"),
        D("85.00"),
    )


def test_T3_gross_error_flag(official):
    result = score(
        official,
        answers(
            c01="no",
            c02="yes",
            c03="no",
            c04=10,
            c05="yes",
            c06=4,
            c07="yes",
            c08=("yes", ["insult"]),
        ),
    )
    assert result.total == D("51.00")
    assert result.gross_error.flag is True
    assert result.gross_error.kinds == ["insult"]


def test_T4_nothing_applicable():
    version = checklist(
        [
            crit("a", "main", 1, 10, na=True),
            crit("b", "main", 2, 0),  # weight 0: never applicable
            crit("g", "flags", 3, 0, kind="gross_error", kinds=["insult"]),
        ]
    )
    result = score(version, answers(a="na", b="yes", g="no"))
    assert result.total is None
    assert result.exact_total is None
    assert [s.section_id for s in result.sections] == ["main", "flags"]
    for section in result.sections:
        assert section.points is None
        assert section.available is None
        assert section.percent is None
    assert result.results == {"a": (None, None), "b": (None, None), "g": (None, None)}


# --- rounding and exactness ----------------------------------------------------------------


def test_T5_exact_half_up():
    # 201 * 100 / 20000 = 1.005 exactly. Floating point gives 1.00.
    version = checklist([crit("a", "s", 1, 201), crit("b", "s", 2, 19799)])
    result = score(version, answers(a="yes", b="no"))
    assert result.total == D("1.01")
    assert result.exact_total == Fraction(201, 200)


def test_weights_110_rescale(official):
    extra = official_criteria()
    extra.append(crit("c09", "conduct", 9, 10))
    version = checklist(extra)
    result = score(version, answers(**ALL_YES, c09="yes"))
    assert result.total == D("100.00")
    assert result.exact_total == Fraction(100)
    # the official seven scored criteria (100) plus 10: c01 now carries 10 * 100 / 110
    assert result.results["c01"] == (D("9.09"), D("9.09"))


def test_decimal_weights_are_exact():
    version = checklist([crit("a", "s", 1, D("0.1")), crit("b", "s", 2, D("0.2"))])
    result = score(version, answers(a="yes", b="no"))
    assert result.exact_total == Fraction(100, 3)
    assert result.total == D("33.33")


def test_all_no_is_zero_not_null(official):
    all_no = {
        **ALL_YES,
        **dict.fromkeys(("c01", "c02", "c03", "c05", "c07"), "no"),
        "c04": 0,
        "c06": 0,
    }
    result = score(official, answers(**all_no))
    assert result.total == D("0.00")
    assert result.total is not None
    assert all(s.percent == D("0.00") for s in result.sections if s.section_id != "gross")


def test_output_is_quantized_decimal(official):
    result = score(official, answers(**ALL_YES))
    assert isinstance(result.total, Decimal)
    assert result.total.as_tuple().exponent == -2
    assert str(result.total) == "100.00"
    for points, weight in result.results.values():
        for value in (points, weight):
            assert value is None or (isinstance(value, Decimal) and value.as_tuple().exponent == -2)


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (Fraction(5, 1000), "0.01"),  # exactly half: up
        (Fraction(4999, 1000000), "0.00"),
        (Fraction(-5, 1000), "-0.01"),  # exactly half: away from zero
        (Fraction(-4, 1000), "0.00"),  # no negative zero
        (Fraction(-1005, 1000), "-1.01"),
        (Fraction(1), "1.00"),
        (Fraction(0), "0.00"),
        (Fraction(2, 3), "0.67"),
        (Fraction(10**9 * 3 + 1, 3), "1000000000.33"),
    ],
)
def test_round2(value, expected):
    result = round2(value)
    assert isinstance(result, Decimal)
    assert str(result) == expected


def test_round2_half_up_negative():
    assert round2(Fraction(-1005, 1000)) == D("-1.01")


def test_scoring_module_never_uses_float():
    tree = ast.parse(Path(scoring_module.__file__).read_text())
    for node in ast.walk(tree):
        assert not (isinstance(node, ast.Name) and node.id == "float"), node.lineno
        assert not (isinstance(node, ast.Constant) and isinstance(node.value, float)), node.lineno


# --- per-criterion results ------------------------------------------------------------------


def test_every_criterion_has_a_result_and_na_and_gross_have_no_points(official):
    result = score(
        official,
        answers(c01="yes", c02="na", c03="na", c04=15, c05="yes", c06=7, c07="na", c08="no"),
    )
    assert set(result.results) == {f"c0{i}" for i in range(1, 9)}
    for cid in ("c02", "c03", "c07", "c08"):
        assert result.results[cid] == (None, None)
        assert result.exact_results[cid] == (None, None)


def test_zero_weight_scored_criterion_is_not_applicable():
    version = checklist([crit("a", "s", 1, 10), crit("z", "s", 2, 0)])
    result = score(version, answers(a="yes", z="yes"))
    assert result.results["z"] == (None, None)  # documented choice: None, never Decimal 0
    assert result.results["a"] == (D("100.00"), D("100.00"))
    assert result.total == D("100.00")
    only_zero = score(checklist([crit("z", "s", 1, 0)]), answers(z="yes"))
    assert only_zero.total is None


def test_gross_answer_never_changes_total(official):
    clean = score(official, answers(**ALL_YES))
    flagged = score(official, with_(ALL_YES, c08=("yes", ["insult"])))
    assert flagged.total == clean.total == D("100.00")
    assert flagged.gross_error.flag is True
    assert clean.gross_error.flag is False


def test_gross_section_has_no_points(official):
    result = score(official, with_(ALL_YES, c08=("yes", ["insult"])))
    gross = next(s for s in result.sections if s.section_id == "gross")
    assert (gross.points, gross.available, gross.percent) == (None, None, None)


def test_gross_kinds_union_in_order_without_duplicates():
    version = checklist(
        [
            crit("a", "s", 1, 10),
            crit("g1", "g", 2, 0, kind="gross_error", kinds=["insult", "leak"]),
            crit("g2", "g", 3, 0, kind="gross_error", kinds=["leak", "paid"]),
            crit("g3", "g", 4, 0, kind="gross_error", kinds=["other"]),
        ]
    )
    result = score(
        version,
        answers(
            a=("yes", ["ignored-kind-on-a-scored-criterion"]),
            g1=("yes", ["insult", "leak"]),
            g2=("yes", ["leak", "paid"]),
            g3=("no", ["not-counted"]),  # answered no: its kinds do not count
        ),
    )
    assert result.gross_error.flag is True
    assert result.gross_error.kinds == ["insult", "leak", "paid"]


def test_gross_with_na_does_not_flag():
    version = checklist(
        [
            crit("a", "s", 1, 10),
            crit("g", "g", 2, 0, kind="gross_error", kinds=["insult"], na=True),
        ]
    )
    result = score(version, answers(a="yes", g=("na", ["insult"])))
    assert result.gross_error.flag is False
    assert result.gross_error.kinds == []


def test_sections_are_ordered_by_order_field():
    version = checklist(
        [crit("a", "s1", 1, 10), crit("b", "s2", 2, 10)],
        sections=[("s2", 2), ("s1", 1)],
    )
    result = score(version, answers(a="yes", b="yes"))
    assert [s.section_id for s in result.sections] == ["s1", "s2"]


def test_section_without_applicable_criteria_is_all_none(official):
    # the whole "start" and "safety" sections are N/A; "conduct" alone carries the total
    result = score(
        official,
        answers(c01="yes", c02="na", c03="na", c04="na", c05="yes", c06=10, c07="yes", c08="no"),
    )
    by_id = {s.section_id: s for s in result.sections}
    assert (by_id["safety"].points, by_id["safety"].available, by_id["safety"].percent) == (
        None,
        None,
        None,
    )
    assert by_id["start"].percent == D("100.00")
    assert result.total == D("100.00")


def test_returns_scored(official):
    assert isinstance(score(official, answers(**ALL_YES)), Scored)


# --- validation -----------------------------------------------------------------------------


def test_validate_answer(official):
    c = {x.id: x for x in official.criteria}
    assert validate_answer(c["c01"], "na") == "na_not_allowed"
    assert validate_answer(c["c04"], StepAnswer(step=12)) == "step_not_in_scale"
    assert validate_answer(c["c01"], StepAnswer(step=5)) == "bad_answer"
    assert validate_answer(c["c04"], "yes") == "bad_answer"


def test_validate_answer_accepts_valid_answers(official):
    c = {x.id: x for x in official.criteria}
    assert validate_answer(c["c01"], "yes") is None
    assert validate_answer(c["c01"], "no") is None
    assert validate_answer(c["c02"], "na") is None
    assert validate_answer(c["c04"], StepAnswer(step=0)) is None
    assert validate_answer(c["c04"], StepAnswer(step=20)) is None
    assert validate_answer(c["c04"], "na") is None
    assert validate_answer(c["c06"], "na") == "na_not_allowed"
    assert validate_answer(c["c08"], "no") is None


def test_validate_answer_unknown_literal_is_bad_answer(official):
    c = {x.id: x for x in official.criteria}
    assert validate_answer(c["c01"], "maybe") == "bad_answer"  # type: ignore[arg-type]
    assert validate_answer(c["c04"], "maybe") == "bad_answer"  # type: ignore[arg-type]
    assert validate_answer(c["c01"], None) == "bad_answer"  # type: ignore[arg-type]
    assert validate_answer(c["c01"], {"step": 5}) == "bad_answer"  # type: ignore[arg-type]


def test_validate_answer_scale_without_steps():
    c = crit("a", "s", 1, 10, answer_type="scale", steps=[])
    assert validate_answer(c, StepAnswer(step=0)) == "step_not_in_scale"


@pytest.mark.parametrize(
    ("cid", "answer", "code"),
    [
        ("c01", "na", "na_not_allowed"),
        ("c04", StepAnswer(step=12), "step_not_in_scale"),
        ("c01", StepAnswer(step=5), "bad_answer"),
        ("c04", "yes", "bad_answer"),
        ("c01", "maybe", "bad_answer"),
    ],
)
def test_score_raises_value_error_with_the_code(official, cid, answer, code):
    given = answers(**ALL_YES)
    given[cid] = (answer, [])
    with pytest.raises(ValueError) as caught:
        score(official, given)
    assert caught.value.args == (code,)
    assert str(caught.value) == code
    assert caught.value.code == code
    assert caught.value.criterion_id == cid


def test_score_rejects_missing_answer(official):
    given = answers(**ALL_YES)
    del given["c03"]
    with pytest.raises(ValueError, match="missing_answer") as caught:
        score(official, given)
    assert caught.value.criterion_id == "c03"


def test_score_rejects_answer_for_unknown_criterion(official):
    given = answers(**ALL_YES, c99="yes")
    with pytest.raises(ValueError, match="unknown_criterion") as caught:
        score(official, given)
    assert caught.value.criterion_id == "c99"


# --- fraction -------------------------------------------------------------------------------


def test_fraction(official):
    c = {x.id: x for x in official.criteria}
    assert fraction(c["c01"], "yes") == Fraction(1)
    assert fraction(c["c01"], "no") == Fraction(0)
    assert fraction(c["c02"], "na") is None
    assert fraction(c["c04"], StepAnswer(step=15)) == Fraction(3, 4)
    assert fraction(c["c04"], StepAnswer(step=0)) == Fraction(0)
    assert fraction(c["c04"], StepAnswer(step=20)) == Fraction(1)
    assert fraction(c["c06"], StepAnswer(step=7)) == Fraction(7, 10)
    assert isinstance(fraction(c["c06"], StepAnswer(step=4)), Fraction)


def test_fraction_validates_like_validate_answer(official):
    c = {x.id: x for x in official.criteria}
    with pytest.raises(ValueError, match="na_not_allowed"):
        fraction(c["c01"], "na")
    with pytest.raises(ValueError, match="bad_answer"):
        fraction(c["c04"], "yes")
    with pytest.raises(ValueError, match="step_not_in_scale"):
        fraction(c["c04"], StepAnswer(step=3))


def test_fraction_of_a_scale_with_no_positive_top_step_is_an_error():
    c = crit("a", "s", 1, 10, answer_type="scale", steps=[0])
    with pytest.raises(ValueError, match="bad_scale"):
        fraction(c, StepAnswer(step=0))
