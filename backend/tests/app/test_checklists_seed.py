"""Criterion fingerprints and the official seed (Task 3).

The fingerprint tests need nothing but the code. The seed tests read stream A's
checklists/official-chat-v1.json and are skipped until that file is on this branch.
"""

import hashlib
import json
import re
from pathlib import Path

import pytest

from app import checklists
from app.checklists import criterion_fingerprint, load_seed
from app.models import Criterion

REPO_ROOT = Path(__file__).resolve().parents[3]
SEED = REPO_ROOT / "checklists" / "official-chat-v1.json"

# The cross-stream test vector: stream A's web/ fingerprint.js must produce the same hash.
VECTOR_CRITERION = {
    "title": "Установление контакта",
    "wording": "Да — оператор поздоровался на языке клиента и представился в первом ответе.",
    "answer_type": "yes_no",
    "scale_steps": [],
    "na_allowed": False,
    "na_condition": None,
    "kind": "scored",
    "kinds": [],
    "guidance": None,
}
VECTOR_FINGERPRINT = "ace5cc7a0b747465ba875ad6dbd6a653dcac2d04490a4c66304a7a6bd339516b"


def make_criterion(**overrides) -> Criterion:
    fields = {
        **VECTOR_CRITERION,
        "id": "c01",
        "section_id": "start",
        "order": 1,
        "weight": 10,
        "model": None,
        "fingerprint": "placeholder",
    }
    return Criterion(**{**fields, **overrides})


# --- criterion_fingerprint -----------------------------------------------------------------


def test_fingerprint_cross_stream_vector() -> None:
    assert criterion_fingerprint(VECTOR_CRITERION) == VECTOR_FINGERPRINT


def test_fingerprint_of_a_criterion_matches_the_vector() -> None:
    assert criterion_fingerprint(make_criterion()) == VECTOR_FINGERPRINT


def test_fingerprint_is_sha256_of_canonical_json() -> None:
    canonical = json.dumps(
        VECTOR_CRITERION, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    assert criterion_fingerprint(VECTOR_CRITERION) == hashlib.sha256(canonical).hexdigest()


def test_fingerprint_ignores_weight_order_model() -> None:
    base = criterion_fingerprint(make_criterion())
    other = make_criterion(
        id="c99", section_id="elsewhere", order=7, weight=55, model="claude-sonnet-5-5",
        fingerprint="something else",
    )  # fmt: skip
    assert criterion_fingerprint(other) == base
    as_dict = {**VECTOR_CRITERION, "weight": 3, "order": 9, "model": "m", "id": "x", "section_id": "y"}
    assert criterion_fingerprint(as_dict) == base


def test_fingerprint_changes_with_wording() -> None:
    changed = {**VECTOR_CRITERION, "wording": VECTOR_CRITERION["wording"] + " "}
    assert criterion_fingerprint(changed) != VECTOR_FINGERPRINT


def test_fingerprint_key_order_irrelevant() -> None:
    reordered = dict(reversed(list(VECTOR_CRITERION.items())))
    assert list(reordered) != list(VECTOR_CRITERION)
    assert criterion_fingerprint(reordered) == VECTOR_FINGERPRINT


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("title", "Другое название"),
        ("answer_type", "scale"),
        ("scale_steps", [{"value": 0, "label": "Нет"}, {"value": 5, "label": "Да"}]),
        ("na_allowed", True),
        ("na_condition", "N/A — нечего оценивать."),
        ("kind", "gross_error"),
        ("kinds", ["insult"]),
        ("guidance", "Пример разбора."),
    ],
)
def test_fingerprint_changes_with_every_field_it_covers(field: str, value) -> None:
    assert criterion_fingerprint({**VECTOR_CRITERION, field: value}) != VECTOR_FINGERPRINT


def test_fingerprint_sees_scale_step_value_and_label() -> None:
    steps = [{"value": 0, "label": "Нет"}, {"value": 5, "label": "Да"}]
    base = criterion_fingerprint({**VECTOR_CRITERION, "scale_steps": steps})
    relabelled = [steps[0], {"value": 5, "label": "Почти"}]
    revalued = [steps[0], {"value": 6, "label": "Да"}]
    reordered = [steps[1], steps[0]]
    assert criterion_fingerprint({**VECTOR_CRITERION, "scale_steps": relabelled}) != base
    assert criterion_fingerprint({**VECTOR_CRITERION, "scale_steps": revalued}) != base
    assert criterion_fingerprint({**VECTOR_CRITERION, "scale_steps": reordered}) != base


def test_fingerprint_of_a_scale_criterion_equals_its_dict() -> None:
    steps = [{"value": 0, "label": "Нет"}, {"value": 5, "label": "Да"}]
    criterion = make_criterion(answer_type="scale", scale_steps=steps)
    # Extra keys on a step (a UI row id, say) are not part of the fingerprint.
    noisy = [{**s, "id": i} for i, s in enumerate(steps)]
    as_dict = {**VECTOR_CRITERION, "answer_type": "scale", "scale_steps": noisy}
    assert criterion_fingerprint(criterion) == criterion_fingerprint(as_dict)


def test_fingerprint_dict_may_omit_the_fields_the_model_defaults() -> None:
    minimal = {
        "title": VECTOR_CRITERION["title"],
        "wording": VECTOR_CRITERION["wording"],
        "answer_type": "yes_no",
        "na_allowed": False,
    }
    assert criterion_fingerprint(minimal) == VECTOR_FINGERPRINT


def test_fingerprint_dict_missing_a_required_field_is_an_error() -> None:
    incomplete = {k: v for k, v in VECTOR_CRITERION.items() if k != "wording"}
    with pytest.raises(ValueError, match="wording"):
        criterion_fingerprint(incomplete)


# --- the official seed ---------------------------------------------------------------------


def collapse(text: str) -> str:
    return " ".join(text.split())


def strip_na_prefix(text: str) -> str:
    return re.sub(r"^N/A\s+—\s+", "", collapse(text))


needs_seed = pytest.mark.skipif(not SEED.exists(), reason="waiting for stream A seed")

EXPECTED_WORDING = {
    "c01": "Да — оператор поздоровался на языке клиента и представился в первом ответе.",
    "c02": "Да — оператор учёл известные детали и уточнил недостающее до ответа.",
    "c03": "Да — проверка личности подтверждена до раскрытия данных или защищённого действия.",
    "c04": "Оцените ответ или следующий шаг по шкале на стр. 2.",
    "c05": "Да — оператор вежлив и, если клиент выразил недовольство или описал неудобство, "
    "отреагировал на конкретную проблему.",
    "c06": "Оцените ясность, порядок ответов и предупреждение об ожидании по шкале на стр. 2.",
    "c07": "Да — оператор подвёл итог или предложил дальнейшую помощь и попрощался.",
    "c08": "Да — выявлено оскорбление клиента, предложение платной услуги в обход компании "
    "или раскрытие конфиденциальной информации.",
}
EXPECTED_NA_CONDITIONS = {
    "c02": "данных для ответа хватало с самого начала.",
    "c03": "запрос не требовал идентификации.",
    "c04": "чат закончился до того, как клиент сформулировал запрос.",
    "c07": "чат оборвался до возможности его завершить.",
}
EXPECTED_TITLES_WEIGHTS = {
    "c01": ("Установление контакта", 10),
    "c02": ("Выявление потребности", 15),
    "c03": ("Идентификация", 20),
    "c04": ("Корректная и полная консультация", 20),
    "c05": ("Эмпатия и клиентоориентированность", 15),
    "c06": ("Управление диалогом, скорость и грамотность", 15),
    "c07": ("Завершение", 5),
    "c08": ("Грубые ошибки", 0),
}
EXPECTED_SCALES = {
    "c04": {
        20: "Все существенные вопросы закрыты или дан корректный следующий шаг.",
        15: "Основной вопрос решён, пропущена второстепенная деталь.",
        10: "Часть запроса закрыта, существенный вопрос остался открытым.",
        5: "Есть общая подсказка, но клиенту всё ещё непонятно, как действовать.",
        0: "Ответа по существу нет или ключевая рекомендация ошибочна.",
    },
    "c06": {
        10: "Ответы ясные и связные. Если было явное ожидание, оператор предупредил.",
        7: "Один заметный сбой, но клиент может понять ответ и продолжить.",
        4: "Клиенту приходится переспрашивать из-за формулировок или порядка ответов.",
        0: "Из-за бессвязных или противоречивых реплик ход диалога непонятен.",
    },
}


@pytest.fixture(scope="module")
def seed():
    return load_seed(SEED)


def by_id(seed, criterion_id: str):
    return next(c for c in seed.criteria if c.id == criterion_id)


def test_seed_location_is_the_repo_checklists_folder() -> None:
    assert checklists.OFFICIAL_SEED == SEED


@needs_seed
def test_seed_identity(seed) -> None:
    assert seed.id == "official-chat:1"
    assert seed.checklist_id == "official-chat"
    assert seed.version == 1
    assert seed.name == "Чек-лист качества чатов"
    assert seed.locked is True
    assert seed.channel == "any"
    assert seed.rounding == 2


@needs_seed
def test_seed_sections(seed) -> None:
    assert [(s.id, s.title) for s in seed.sections] == [
        ("start", "Начало и понимание запроса"),
        ("safety", "Безопасность и решение"),
        ("conduct", "Ведение и завершение диалога"),
        ("gross", "Грубые нарушения"),
    ]


@needs_seed
def test_seed_titles_weights(seed) -> None:
    assert [c.id for c in seed.criteria] == list(EXPECTED_TITLES_WEIGHTS)
    for criterion in seed.criteria:
        title, weight = EXPECTED_TITLES_WEIGHTS[criterion.id]
        assert collapse(criterion.title) == title
        assert criterion.weight == weight
    assert sum(c.weight for c in seed.criteria if c.kind == "scored") == 100


@needs_seed
def test_seed_na(seed) -> None:
    assert {c.id for c in seed.criteria if c.na_allowed} == {"c02", "c03", "c04", "c07"}


@needs_seed
def test_seed_wording_verbatim(seed) -> None:
    for criterion_id, expected in EXPECTED_WORDING.items():
        assert expected in collapse(by_id(seed, criterion_id).wording), criterion_id


@needs_seed
def test_seed_na_conditions_verbatim(seed) -> None:
    for criterion_id, expected in EXPECTED_NA_CONDITIONS.items():
        condition = by_id(seed, criterion_id).na_condition
        assert condition is not None, criterion_id
        assert strip_na_prefix(condition) == expected, criterion_id
    for criterion in seed.criteria:
        if criterion.id not in EXPECTED_NA_CONDITIONS:
            assert criterion.na_condition is None, criterion.id


@needs_seed
def test_seed_scale_steps(seed) -> None:
    for criterion_id, expected in EXPECTED_SCALES.items():
        steps = by_id(seed, criterion_id).scale_steps
        assert sorted(s.value for s in steps) == sorted(expected), criterion_id
        assert {s.value: collapse(s.label) for s in steps} == expected, criterion_id
    for criterion in seed.criteria:
        assert (criterion.answer_type == "scale") == (criterion.id in EXPECTED_SCALES), criterion.id


@needs_seed
def test_seed_gross_error(seed) -> None:
    gross = by_id(seed, "c08")
    assert gross.kind == "gross_error"
    assert gross.kinds == ["insult", "paid_service_outside_company", "confidential_disclosure"]


@needs_seed
def test_seed_guidance_verbatim(seed) -> None:
    guidance = collapse(seed.guidance)
    for expected in (
        "В этом задании порог первой реакции в 3 минуты, теги и вложения в оценку не входят.",
        "Общий вопрос о тарифах не требует идентификации.",
        "Достаточно самого предложения в переписке. Согласие клиента или перевод денег для отметки "
        "не требуются.",
        "Завершение — Нет. После ответа на вопрос оператор закрыл чат без прощания. "
        "Основание — последняя реплика оператора и сообщение о закрытии чата",
    ):
        assert expected in guidance


@needs_seed
def test_load_seed_fills_fingerprints(seed) -> None:
    prints = [c.fingerprint for c in seed.criteria]
    assert all(re.fullmatch(r"[0-9a-f]{64}", p) for p in prints)
    assert len(set(prints)) == len(prints)
    for criterion in seed.criteria:
        assert criterion.fingerprint == criterion_fingerprint(criterion)


@needs_seed
def test_seed_first_criterion_is_the_cross_stream_vector(seed) -> None:
    # c01 carries the #25 team guidance; without it, it is exactly the shared vector.
    c01 = by_id(seed, "c01")
    assert criterion_fingerprint(c01.model_copy(update={"guidance": None})) == VECTOR_FINGERPRINT
    assert c01.fingerprint == criterion_fingerprint(c01) != VECTOR_FINGERPRINT


@needs_seed
def test_seed_file_carries_no_signed_url() -> None:
    assert "sig=" not in SEED.read_text(encoding="utf-8")
