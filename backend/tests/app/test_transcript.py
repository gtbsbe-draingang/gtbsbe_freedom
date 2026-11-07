"""Transcript normalization and computed facts (Task 5).

The expected numbers for the six DEV dialogues were checked by hand against data/dev.json; the
fixture (tests/fixtures/dev_subset.json) holds those six records without their signed audio URL.
"""

import hashlib
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import Message, dump
from app.transcript import (
    compute_facts,
    mark_duplicates,
    normalize_record,
    seconds,
    transcript_hash,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "dev_subset.json"


def record(conversation_id: str) -> dict:
    records = json.loads(FIXTURE.read_text(encoding="utf-8"))
    return next(r for r in records if r["conversation_id"] == conversation_id)


def conversation(conversation_id: str):
    return normalize_record(record(conversation_id), "DEV")[0]


def facts(conversation_id: str):
    result = conversation(conversation_id).facts
    assert result is not None
    return result


def lines(*triples: tuple[str, str, str]) -> list[Message]:
    return [Message(timestamp=t, speaker=s, text=x) for t, s, x in triples]


# --- facts on the DEV dialogues ------------------------------------------------------------


def test_fixture_has_no_signed_url():
    text = FIXTURE.read_text(encoding="utf-8")
    assert "sig=" not in text
    assert all(r["audio_url"] is None for r in json.loads(text))


def test_facts_p1_ru_001():
    f = facts("p1-ru-001")
    assert f.operator_joined_index == 9
    assert f.first_reaction_seconds == 37.0
    assert f.longest_wait_seconds == 36.0
    assert f.identity_verified_index is None
    assert f.ending == "normal"


def test_facts_p1_ru_010():
    f = facts("p1-ru-010")
    assert f.operator_joined_index == 10
    assert f.first_reaction_seconds == 88.0
    assert f.longest_wait_seconds == 84.0
    assert f.identity_verified_index == 14
    assert f.ending == "normal"


def test_facts_p1_ru_012():
    f = facts("p1-ru-012")
    assert f.operator_joined_index == 9
    assert f.first_reaction_seconds == 114.0
    assert f.longest_wait_seconds is None
    assert f.ending == "connection_lost"


def test_facts_p1_ru_025():
    f = facts("p1-ru-025")
    assert f.first_reaction_seconds == 97.0
    assert f.ending == "client_left"


def test_facts_p1_ru_018():
    f = facts("p1-ru-018")
    assert f.first_reaction_seconds == 96.0
    assert f.longest_wait_seconds == 40.0
    assert f.ending == "operator_closed"


def test_facts_p4_ru_001_call():
    c = conversation("p4-ru-001")
    f = c.facts
    assert f is not None
    # Line 8 ("Клиент переведен ...") is not a handover; line 10 ("Агент присоединился ...") is.
    assert c.transcript[10].text.startswith("Агент присоединился к разговору")
    assert f.operator_joined_index == 12
    assert f.first_reaction_seconds == pytest.approx(9.145, abs=1e-3)
    assert f.longest_wait_seconds == pytest.approx(32.7, abs=1e-3)
    # Microsecond precision, no float noise (9.144974000000005) in what the UI shows.
    assert f.first_reaction_seconds == 9.144974
    assert f.longest_wait_seconds == 32.700201
    # The ending is the system line 43, although line 44 is a client line.
    assert c.transcript[43].speaker == "system"
    assert c.transcript[44].speaker == "client"
    assert f.ending == "client_ended_call"


def test_duplicates_p4_ru_001():
    transcript = conversation("p4-ru-001").transcript
    assert transcript[20].duplicate is True
    assert transcript[19].duplicate is False
    assert sum(m.duplicate for m in transcript) == 1


def test_chats_have_no_duplicates():
    for cid in ("p1-ru-001", "p1-ru-010", "p1-ru-012", "p1-ru-018", "p1-ru-025"):
        assert not any(m.duplicate for m in conversation(cid).transcript), cid


# --- normalize_record ----------------------------------------------------------------------


def test_normalize_ids_and_audio():
    chat, chat_url = normalize_record(record("p1-ru-001"), "DEV")
    assert chat.id == "DEV:p1-ru-001"
    assert chat.conversation_id == "p1-ru-001"
    assert chat.group_id == "DEV"
    assert chat.channel == "agent chat"
    assert chat.language == "RU"
    assert chat.status == "new"
    assert chat.created_at is None
    assert chat.audio is None
    assert chat.audio_unavailable_reason == "none"
    assert chat_url is None

    call_record = {**record("p4-ru-001"), "audio_url": "https://x/y"}
    call, url = normalize_record(call_record, "DEV")
    assert call.id == "DEV:p4-ru-001"
    assert call.audio == "conversations/DEV:p4-ru-001/audio"
    assert call.audio_unavailable_reason is None
    assert url == "https://x/y"
    assert "https://x/y" not in json.dumps(dump(call), ensure_ascii=False)
    assert "https://x/y" not in call.model_dump_json()


def test_normalize_call_without_audio_url_needs_import():
    for url in (None, ""):
        call, second = normalize_record({**record("p4-ru-001"), "audio_url": url}, "DEV")
        assert second is None
        assert call.audio is None
        assert call.audio_unavailable_reason == "needs_import"


def test_normalize_keeps_the_input_untouched():
    rec = {**record("p4-ru-001"), "audio_url": "https://x/y"}
    before = json.dumps(rec, sort_keys=True)
    normalize_record(rec, "DEV")
    assert json.dumps(rec, sort_keys=True) == before


def test_normalize_keeps_original_timestamps_and_lines():
    c = conversation("p4-ru-001")
    source = record("p4-ru-001")["transcript"]
    assert len(c.transcript) == len(source)
    assert [m.timestamp for m in c.transcript] == [m["timestamp"] for m in source]
    assert [m.text for m in c.transcript] == [m["text"] for m in source]


def test_normalize_tolerates_missing_and_odd_transcript_fields():
    rec = {
        "conversation_id": "x-1",
        "channel": "agent chat",
        "language": "EN",
        "audio_url": None,
        "transcript": [
            {"timestamp": "00:01", "speaker": "client", "text": None},
            {"speaker": "agent", "text": "hi"},
            "not an object",
        ],
    }
    c, _ = normalize_record(rec, "G")
    assert [(m.timestamp, m.speaker, m.text) for m in c.transcript] == [
        ("00:01", "client", ""),
        ("", "agent", "hi"),
        ("", "", "not an object"),
    ]
    assert c.facts is not None
    assert normalize_record({**rec, "transcript": None}, "G")[0].transcript == []


@pytest.mark.parametrize("field", ["conversation_id", "channel", "language"])
def test_normalize_rejects_a_record_without_required_field(field: str):
    rec = {k: v for k, v in record("p1-ru-001").items() if k != field}
    with pytest.raises(ValidationError):
        normalize_record(rec, "DEV")


# --- Review Focus 4: empty and odd input ---------------------------------------------------


def test_empty_transcript_facts_null():
    f = compute_facts([])
    assert f.operator_joined_index is None
    assert f.first_reaction_seconds is None
    assert f.longest_wait_seconds is None
    assert f.identity_verified_index is None
    assert f.ending == "normal"
    assert seconds([]) == []
    assert mark_duplicates([]) == []


def test_unknown_speaker_and_timestamp():
    transcript = lines(
        ("00:00", "client", "Нужен оператор"),
        ("00:10", "system", "Эскалация на оператора."),
        ("yesterday", "agent", "Здравствуйте"),  # unknown speaker: kept, not an operator
        ("00:50", "operator", "Здравствуйте, меня зовут Алия"),
        ("01:20", "client", "Спасибо"),
        ("01:50", "operator", "Пожалуйста"),
    )
    assert transcript[2].speaker == "agent"
    assert seconds(transcript)[2] is None
    f = compute_facts(transcript)
    assert f.operator_joined_index == 3
    assert f.first_reaction_seconds == 40.0
    assert f.longest_wait_seconds == 30.0
    assert f.ending == "normal"


def test_unparsable_time_skips_only_the_pairs_that_need_it():
    transcript = lines(
        ("00:00", "system", "Chat transferred to an agent."),
        ("??", "client", "Hello"),
        ("00:20", "operator", "Hi"),  # the client line has no time: no pair
        ("00:30", "client", "Question"),
        ("01:10", "operator", "Answer"),  # 40 s
    )
    f = compute_facts(transcript)
    assert f.first_reaction_seconds == 20.0
    assert f.longest_wait_seconds == 40.0


# --- seconds -------------------------------------------------------------------------------


def stamps(*timestamps: str) -> list[Message]:
    return [Message(timestamp=t, speaker="client", text="x") for t in timestamps]


def test_seconds_clock_formats_are_absolute():
    assert seconds(stamps("00:00", "00:05", "01:05", "1:02:05", "125:30")) == [
        0.0,
        5.0,
        65.0,
        3725.0,
        7530.0,
    ]


def test_seconds_iso_is_relative_to_first_iso_line():
    got = seconds(
        stamps(
            "2026-11-03T13:10:00.0000000+00:00",
            "2026-11-03T13:10:09.1450000+00:00",
            "2026-11-03T18:10:30+05:00",  # same instant as 13:10:30Z
        )
    )
    assert got[0] == 0.0
    assert got[1] == pytest.approx(9.145, abs=1e-6)
    assert got[2] == pytest.approx(30.0, abs=1e-6)


def test_seconds_base_is_the_first_parsable_iso_line():
    got = seconds(stamps("garbage", "2026-11-03T13:10:05Z", "2026-11-03T13:10:08Z"))
    assert got == [None, 0.0, 3.0]


def test_seconds_naive_iso_is_read_as_utc():
    got = seconds(stamps("2026-11-03T13:10:00", "2026-11-03T13:10:07+00:00"))
    assert got == [0.0, 7.0]


@pytest.mark.parametrize(
    "bad",
    ["yesterday", "", "99", "1:2", "00:75", "2026-13-45T00:00:00Z", "2026-11-03", "12:34:56:78", " "],
)
def test_seconds_garbage_is_none(bad: str):
    assert seconds(stamps(bad)) == [None]


# --- mark_duplicates -----------------------------------------------------------------------


def test_mark_duplicates_only_exact_consecutive_repeats():
    transcript = lines(
        ("00:01", "client", "a"),
        ("00:01", "client", "a"),  # duplicate
        ("00:01", "client", "a"),  # duplicate of the line before it
        ("00:02", "client", "a"),  # other timestamp
        ("00:02", "operator", "a"),  # other speaker
        ("00:02", "operator", "b"),  # other text
        ("00:01", "client", "a"),  # equal to a line far above, not to the one before
    )
    assert [m.duplicate for m in mark_duplicates(transcript)] == [
        False,
        True,
        True,
        False,
        False,
        False,
        False,
    ]


def test_mark_duplicates_returns_new_messages_and_leaves_input_alone():
    transcript = lines(("00:01", "client", "a"), ("00:01", "client", "a"))
    marked = mark_duplicates(transcript)
    assert [m.duplicate for m in transcript] == [False, False]
    assert [m.duplicate for m in marked] == [False, True]
    assert [m.duplicate for m in mark_duplicates(marked)] == [False, True]


# --- facts: patterns, endings, edge cases --------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Эскалация на оператора.",
        "Чат операторға жіберілді.",
        "Chat transferred to an agent.",
        "Агент присоединился к разговору с клиентом.",
    ],
)
def test_every_handover_text_is_recognised(text: str):
    f = compute_facts(
        lines(
            ("00:00", "client", "help"),
            ("00:10", "system", text),
            ("00:25", "operator", "hello"),
        )
    )
    assert f.operator_joined_index == 2
    assert f.first_reaction_seconds == 15.0


@pytest.mark.parametrize(
    "text",
    ["Личность клиента подтверждена.", "Клиенттің жеке басы расталды.", "Customer identity verified."],
)
def test_every_identity_text_is_recognised(text: str):
    f = compute_facts(lines(("00:00", "client", "hi"), ("00:05", "system", text)))
    assert f.identity_verified_index == 1


@pytest.mark.parametrize(
    ("text", "ending"),
    [
        ("Оператор закрыл чат.", "operator_closed"),
        ("Оператор чатты жапты.", "operator_closed"),
        ("Agent closed the chat.", "operator_closed"),
        ("Клиент покинул чат.", "client_left"),
        ("Customer left the chat.", "client_left"),
        ("Соединение с клиентом прервано.", "connection_lost"),
        ("Клиентпен байланыс үзілді.", "connection_lost"),
        ("Connection to customer lost.", "connection_lost"),
        ("Клиент завершил разговор.", "client_ended_call"),
        ("Что-то другое.", "normal"),
    ],
)
def test_every_ending_text_is_recognised(text: str, ending: str):
    f = compute_facts(lines(("00:00", "client", "hi"), ("00:05", "system", text)))
    assert f.ending == ending


def test_last_matching_ending_wins():
    f = compute_facts(
        lines(
            ("00:00", "system", "Соединение с клиентом прервано."),
            ("00:05", "system", "Клиент покинул чат."),
            ("00:09", "system", "Запись возобновлена."),
        )
    )
    assert f.ending == "client_left"


def test_only_system_lines_set_facts():
    f = compute_facts(
        lines(
            ("00:00", "client", "Эскалация на оператора."),
            ("00:01", "bot", "Личность клиента подтверждена."),
            ("00:02", "operator", "Клиент покинул чат."),
        )
    )
    assert f.identity_verified_index is None
    assert f.ending == "normal"
    assert f.first_reaction_seconds is None  # no handover
    assert f.operator_joined_index == 2  # no handover: the first operator line


def test_first_handover_and_first_identity_win():
    f = compute_facts(
        lines(
            ("00:00", "system", "Эскалация на оператора."),
            ("00:10", "system", "Агент присоединился к разговору."),
            ("00:20", "operator", "hi"),
            ("00:30", "system", "Личность клиента подтверждена."),
            ("00:40", "system", "Customer identity verified"),
        )
    )
    assert f.first_reaction_seconds == 20.0  # from the first handover line
    assert f.identity_verified_index == 3


def test_operator_before_handover_is_the_fallback_but_has_no_reaction_time():
    f = compute_facts(
        lines(
            ("00:00", "operator", "hello"),
            ("00:10", "system", "Эскалация на оператора."),
            ("00:20", "client", "bye"),
        )
    )
    assert f.operator_joined_index == 0
    assert f.first_reaction_seconds is None  # negative: not a reaction time
    assert f.longest_wait_seconds is None


def test_waits_start_after_the_handover_and_stay_unanswered_until_an_operator_line():
    f = compute_facts(
        lines(
            ("00:00", "client", "q"),  # before the handover: the bot's phase
            ("00:05", "bot", "a"),
            ("00:10", "system", "Chat transferred to an agent."),
            ("00:15", "client", "first"),  # unanswered, counts from here
            ("00:30", "client", "second"),  # same wait: the first unanswered line counts
            ("00:30", "bot", "wait"),  # a bot line does not answer
            ("01:05", "operator", "hi"),  # 50 s
            ("01:10", "client", "third"),
            ("01:20", "operator", "ok"),  # 10 s
            ("01:30", "client", "unanswered at the end"),
        )
    )
    assert f.operator_joined_index == 6
    assert f.first_reaction_seconds == 55.0
    assert f.longest_wait_seconds == 50.0


def test_without_handover_the_waits_start_at_the_first_operator_line():
    f = compute_facts(
        lines(
            ("00:00", "client", "q"),
            ("01:00", "operator", "a"),  # joined; the earlier client line is not scanned
            ("01:10", "client", "q2"),
            ("01:40", "operator", "a2"),  # 30 s
        )
    )
    assert f.operator_joined_index == 1
    assert f.first_reaction_seconds is None
    assert f.longest_wait_seconds == 30.0


def test_negative_gap_from_out_of_order_times_is_none():
    f = compute_facts(
        lines(
            ("05:00", "system", "Эскалация на оператора."),
            ("05:30", "client", "q"),
            ("00:10", "operator", "a"),
        )
    )
    assert f.operator_joined_index == 2
    assert f.first_reaction_seconds is None
    assert f.longest_wait_seconds is None


def test_facts_ignore_surrounding_whitespace_in_system_text():
    f = compute_facts(lines(("00:00", "system", "  Оператор закрыл чат.\n")))
    assert f.ending == "operator_closed"


# --- transcript_hash -----------------------------------------------------------------------


def test_transcript_hash_is_the_sha256_of_canonical_json():
    transcript = lines(("00:00", "client", "привет"), ("00:01", "bot", 'a "b"'))
    canonical = (
        '[{"speaker":"client","text":"привет","timestamp":"00:00"},'
        '{"speaker":"bot","text":"a \\"b\\"","timestamp":"00:01"}]'
    )
    assert transcript_hash(transcript) == hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    assert len(transcript_hash(transcript)) == 64


def test_transcript_hash_ignores_duplicate_flag():
    plain = lines(("00:01", "client", "a"), ("00:01", "client", "a"))
    marked = mark_duplicates(plain)
    assert marked[1].duplicate is True
    assert transcript_hash(marked) == transcript_hash(plain)


def test_transcript_hash_changes_with_content_and_order():
    a = lines(("00:00", "client", "x"), ("00:01", "bot", "y"))
    assert transcript_hash(a) == transcript_hash(list(a))
    assert transcript_hash(a) != transcript_hash(list(reversed(a)))
    assert transcript_hash(a) != transcript_hash(lines(("00:00", "client", "x"), ("00:01", "bot", "z")))
    assert transcript_hash(a) != transcript_hash(lines(("00:00", "client", "x"), ("00:02", "bot", "y")))
    assert transcript_hash(a) != transcript_hash(lines(("00:00", "client", "x"), ("00:01", "operator", "y")))
    assert transcript_hash([]) == hashlib.sha256(b"[]").hexdigest()
