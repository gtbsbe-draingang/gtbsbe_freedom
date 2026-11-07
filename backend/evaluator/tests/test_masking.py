import pytest

from evaluator.masking import PLACEHOLDERS, mask_text, mask_transcript
from evaluator.testing import make_conv

N = PLACEHOLDERS["name"]


@pytest.mark.parametrize(
    "src, want",
    [
        ("Здравствуйте, меня зовут Айгерим, чем помочь?", f"Здравствуйте, меня зовут {N}, чем помочь?"),
        ("Добрый день! Я Алия, специалист.", f"Добрый день! Я {N}, специалист."),
        ("здравствуйте, я Марат", f"здравствуйте, я {N}"),
        ("Сәлем, мен Нұрланмын", f"Сәлем, мен {N}"),
        ("Менің атым Айгүл", f"Менің атым {N}"),
        ("Hello, I'm Daniel from support", f"Hello, I'm {N} from support"),
        ("Hello, I’m Daniel", f"Hello, I’m {N}"),
        ("I am Olivia", f"I am {N}"),
        ("My name is Peter.", f"My name is {N}."),
    ],
)
def test_names_masked(src, want):
    assert mask_text(src) == want


@pytest.mark.parametrize(
    "src",
    [
        "Я Вам перезвоню",
        "Я Вас понял",
        "Я Вашу заявку передал",
        "я ноутбука не вижу",
        "Мен Сізге көмектесемін",
        "I am AIM certified",
        "I'm Sorry for the delay",
        "I am here",
        "Мен Алматыдан",
        "Здравствуйте, [Имя скрыто] на связи",
        "Меня зовут [Имя скрыто]",
    ],
)
def test_non_names_untouched(src):
    assert mask_text(src) == src


def test_name_placeholder_keeps_introduction():
    out = mask_text("Меня зовут Айгерим")
    assert out.startswith("Меня зовут ") and N in out


def test_phone_card_iin_email_iban():
    assert mask_text("звоните +7 701 123 45 67") == f"звоните {PLACEHOLDERS['phone']}"
    assert mask_text("8 (701) 123-45-67") == PLACEHOLDERS["phone"]
    assert mask_text("87011234567") == PLACEHOLDERS["phone"]
    assert mask_text("карта 4400 1234 5678 9012") == f"карта {PLACEHOLDERS['card']}"
    assert mask_text("4400123456789012") == PLACEHOLDERS["card"]
    assert mask_text("ИИН 900101300123") == f"ИИН {PLACEHOLDERS['iin']}"
    assert mask_text("пишите ivan.p@mail.example.kz пожалуйста") == f"пишите {PLACEHOLDERS['email']} пожалуйста"
    assert mask_text("счёт KZ12 345A 0000 1234 5678") == f"счёт {PLACEHOLDERS['account']}"
    assert mask_text("KZ12345A000012345678") == PLACEHOLDERS["account"]


def test_plain_numbers_kept():
    s = "Заявка 12345 на сумму 150000 тенге, 2 раза, в 2026 году"
    assert mask_text(s) == s


def test_transcript_indices_speakers_kept_and_no_mutation():
    conv = make_conv([("operator", "Меня зовут Алия"), ("client", "мой +77011234567"), ("bot", "ok")], language="RU")
    before = [m.model_dump() for m in conv.transcript]
    out = mask_transcript(conv.transcript)
    assert [m.model_dump() for m in conv.transcript] == before
    assert len(out) == 3
    assert [m.speaker for m in out] == ["operator", "client", "bot"]
    assert [m.timestamp for m in out] == [m.timestamp for m in conv.transcript]
    assert out[0].text == f"Меня зовут {N}" and out[1].text == f"мой {PLACEHOLDERS['phone']}"
    assert out[2].text == "ok"


# --- fix round A -------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "src, want",
    [
        ("Меня зовут Алия Ерболатовна", f"Меня зовут {N}"),
        ("Меня зовут Алия Ерболатовна Сатпаева, чем помочь?", f"Меня зовут {N}, чем помочь?"),
        ("Меня зовут Алия. Чем помочь?", f"Меня зовут {N}. Чем помочь?"),
        ("Меня зовут Алия Чем помочь", f"Меня зовут {N} Чем помочь"),
        ("My name is Daniel Brown, how can I help?", f"My name is {N}, how can I help?"),
        ("my name is john", f"my name is {N}"),
        ("меня зовут айгерим", f"меня зовут {N}"),
        ("менің атым нұрлан", f"менің атым {N}"),
        ("Привет, я Алия, специалист", f"Привет, я {N}, специалист"),
        ("Я Алия специалист банка", f"Я {N} специалист банка"),
        ("I'm Daniel from support", f"I'm {N} from support"),
    ],
)
def test_names_round_a(src, want):
    assert mask_text(src) == want


@pytest.mark.parametrize(
    "src",
    [
        "Я Могу помочь",
        "Я Могу, конечно",
        "Я Хочу уточнить",
        "Я Постараюсь помочь",
        "Я Не вижу заявку",
        "Я Помогу вам",
        "I'm Trying to help",
        "I'm Looking at it",
        "I'm Not sure",
        "я Сейчас проверю",
    ],
)
def test_bare_cue_verbs_not_names(src):
    assert mask_text(src) == src


def test_later_mentions_in_same_text_masked():
    assert mask_text("Я Анна. Анна, вы тут?") == f"Я {N}. {N}, вы тут?"


def test_later_mentions_across_transcript_masked():
    conv = make_conv(
        [("operator", "Здравствуйте, я Алия, чем помочь?"), ("client", "Алия, мне нужен счёт"), ("operator", "Алия слушает")]
    )
    out = mask_transcript(conv.transcript)
    assert [m.text for m in out] == [f"Здравствуйте, я {N}, чем помочь?", f"{N}, мне нужен счёт", f"{N} слушает"]
    assert conv.transcript[1].text == "Алия, мне нужен счёт"


def test_no_name_no_global_masking():
    conv = make_conv([("operator", "Здравствуйте"), ("client", "Алия мне не знакома")])
    assert [m.text for m in mask_transcript(conv.transcript)] == ["Здравствуйте", "Алия мне не знакома"]
