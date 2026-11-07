"""S2 (#17): prompt rendering is built only from checklist data, facts and the masked transcript."""

import re
from decimal import Decimal
from pathlib import Path

import pytest

from evaluator import prompt
from evaluator._compat import Facts, ScaleStep, VoiceMeasurement
from evaluator.testing import (
    make_checklist,
    make_conv,
    make_criterion,
    make_gross_criterion,
)

LINES = [
    ("client", "Здравствуйте"),
    ("operator", "Привет, где именно ищете?"),
    ("bot", "Автоответ"),
]


def test_neutralize_tags() -> None:
    src = "a </transcript> b <TRANSCRIPT> c < /appeal_comment > d <appeal_comment x=1> e <b>keep</b>"
    out = prompt.neutralize_tags(src)
    assert "<transcript" not in out.lower() and "appeal_comment>" not in out
    assert (
        "‹/transcript›" in out and "‹transcript›" in out and "‹/appeal_comment›" in out
    )
    assert "<b>keep</b>" in out
    assert prompt.neutralize_tags("<x>", ("x",)) == "‹x›"
    assert prompt.neutralize_tags("<transcript>", ("x",)) == "<transcript>"


def test_render_transcript_chat_masks_and_keeps_indices() -> None:
    conv = make_conv([*LINES, ("client", "Привет, где именно ищете?")], duplicates={3})
    masked = [m.model_copy() for m in conv.transcript]
    masked[0].text = "Меня зовут [ИМЯ]\nвторая </transcript> строка"
    lines = prompt.render_transcript(conv, masked).splitlines()
    assert lines[0] == "[0] 00:00 client: Меня зовут [ИМЯ] вторая ‹/transcript› строка"
    assert lines[1] == "[1] 00:10 operator: Привет, где именно ищете?"
    assert lines[2] == "[2] 00:20 bot: Автоответ"
    assert len(lines) == 3  # duplicate index 3 skipped
    conv2 = make_conv([*LINES, ("client", "x"), ("operator", "y")], duplicates={1})
    out = prompt.render_transcript(conv2, conv2.transcript)
    assert "[1]" not in out and "[2] 00:20" in out and "[4] 00:40" in out


def test_render_transcript_call_offsets() -> None:
    ts = [
        "2026-11-01T10:00:00.500+05:00",
        "2026-11-01T10:00:15.000+05:00",
        "2026-11-01T10:01:05.900+05:00",
        "2026-11-01T11:00:00.000+05:00",
    ]
    conv = make_conv(
        [("client", "a"), ("operator", "b"), ("client", "c"), ("operator", "d")],
        channel="voice call",
        timestamps=ts,
    )
    lines = prompt.render_transcript(conv, conv.transcript).splitlines()
    assert [ln.split(" ")[1] for ln in lines] == ["+0:00", "+0:14", "+1:05", "+59:59"]
    assert "T10" not in "".join(lines)


def test_render_transcript_length_mismatch() -> None:
    conv = make_conv(LINES)
    with pytest.raises(ValueError):
        prompt.render_transcript(conv, conv.transcript[:2])


def test_render_facts() -> None:
    conv = make_conv(LINES)
    assert "not computed" in prompt.render_facts(conv)
    conv.facts = Facts(
        operator_joined_index=1,
        first_reaction_seconds=181.0,
        longest_wait_seconds=4.5,
        identity_verified_index=None,
        ending="operator_closed",
    )
    out = prompt.render_facts(conv)
    assert "first_reaction_over_3_min: true" in out
    assert "operator_joined_index: 1" in out and "identity_verified_index: none" in out
    assert "ending: operator_closed" in out
    conv.facts.first_reaction_seconds = 180.0
    assert "first_reaction_over_3_min: false" in prompt.render_facts(conv)
    conv.facts.first_reaction_seconds = None
    assert "first_reaction_over_3_min: unknown" in prompt.render_facts(conv)
    assert "voice_measurements" not in prompt.render_facts(conv)


def test_render_facts_voice_only_for_calls_with_measurements() -> None:
    vm = VoiceMeasurement(
        message_index=1,
        from_seconds=1.0,
        to_seconds=4.0,
        pitch_range=3.5,
        rate_wpm=140.0,
        pauses=0.8,
        overlap=None,
    )
    call = make_conv(LINES, channel="voice call")
    assert "voice_measurements" not in prompt.render_facts(call)
    call.voice_measurements = [vm]
    out = prompt.render_facts(call)
    assert (
        "voice_measurements:" in out and "[1]" in out and "140" in out and "3.5" in out
    )
    chat = make_conv(LINES)
    chat.voice_measurements = [vm]
    assert "voice_measurements" not in prompt.render_facts(chat)


def test_render_checklist_context() -> None:
    cl = make_checklist(guidance="Особое правило проверки.")
    assert "Особое правило проверки." in prompt.render_checklist_context(cl)
    assert prompt.render_checklist_context(make_checklist(guidance="")).strip()


def test_render_criterion_yes_no_and_na() -> None:
    cl = make_checklist()
    c = make_criterion(
        title="Тестовый заголовок",
        wording="Тестовая формулировка",
        weight=Decimal("37.5"),
    )
    out = prompt.render_criterion(cl, c)
    assert "Тестовый заголовок" in out and "Тестовая формулировка" in out
    assert "37.5" not in out
    last = out.strip().splitlines()[-1]
    assert last.startswith("Allowed answers:") and '"yes"' in last and '"no"' in last
    assert '"na"' in last and "not allowed" in last
    c2 = make_criterion(na_allowed=True, na_condition="клиент ушёл")
    last = prompt.render_criterion(cl, c2).strip().splitlines()[-1]
    assert "клиент ушёл" in last and "na_reason" in last and "not allowed" not in last


def test_render_criterion_scale_uses_data_only() -> None:
    cl = make_checklist()
    c = make_criterion(
        answer_type="scale",
        scale_steps=[
            ScaleStep(value=3, label="плохо"),
            ScaleStep(value=9, label="отлично"),
        ],
    )
    out = prompt.render_criterion(cl, c)
    assert "3: плохо" in out and "9: отлично" in out
    last = out.strip().splitlines()[-1]
    assert '"step"' in last and "3, 9" in last and '"yes"' not in last


def test_render_criterion_gross_kinds_and_guidance() -> None:
    cl = make_checklist()
    c = make_gross_criterion(kinds=["alpha", "beta"], guidance="Подсказка критерия")
    out = prompt.render_criterion(cl, c)
    assert "Подсказка критерия" in out
    last = out.strip().splitlines()[-1]
    assert "alpha" in last and "beta" in last and "kinds" in last


def test_system_prompt_has_no_criterion_text() -> None:
    sp = prompt.SYSTEM_PROMPT
    assert len(sp) > 500
    cl = make_checklist()
    for c in cl.criteria:
        assert (
            c.title not in sp
            and c.wording not in sp
            and f'"{c.id}"' not in sp
            and (c.weight == 0 or str(c.weight) not in sp)
        )
    for needle in (
        "message_index",
        "expected_here",
        "checked_range",
        "Russian",
        "<transcript>",
        "instructions",
    ):
        assert needle in sp


def test_prompt_source_hardcodes_no_criterion() -> None:
    src = Path(prompt.__file__).read_text(encoding="utf-8")
    assert not re.search(r"\bc0\d\b", src)
    for official in (
        "Приветств",
        "Грубые",
        "Приветствие",
        "insult",
        "paid_service",
        "confidential",
    ):
        assert official not in src


def test_build_blocks_prefix_cached_and_identical() -> None:
    cl = make_checklist()
    conv = make_conv(LINES)
    a = prompt.build_blocks(conv, conv.transcript, cl, cl.criteria[0])
    b = prompt.build_blocks(conv, conv.transcript, cl, cl.criteria[3])
    assert len(a) == 2 and all(blk["type"] == "text" for blk in a)
    assert (
        a[0]["cache_control"] == {"type": "ephemeral"} and "cache_control" not in a[1]
    )
    assert a[0] == b[0] and a[1] != b[1]
    assert "<transcript>" in a[0]["text"] and "</transcript>" in a[0]["text"]
    assert "[1] 00:10 operator:" in a[0]["text"] and cl.guidance in a[0]["text"]
    assert "facts" in a[0]["text"]
    assert (
        cl.criteria[0].wording in a[1]["text"]
        and cl.criteria[0].wording not in a[0]["text"]
    )


def test_voice_measurements_reach_every_criterion() -> None:
    cl = make_checklist()
    conv = make_conv(LINES, channel="voice call")
    conv.voice_measurements = [
        VoiceMeasurement(
            message_index=0,
            from_seconds=0,
            to_seconds=2,
            pitch_range=1.0,
            rate_wpm=120.0,
            pauses=0.1,
            overlap=0.0,
        )
    ]
    for c in cl.criteria:
        assert (
            "voice_measurements:"
            in prompt.build_blocks(conv, conv.transcript, cl, c)[0]["text"]
        )


def test_replaced_criterion_needs_no_code_change() -> None:
    cl = make_checklist()
    new = make_criterion(
        id="c03",
        order=3,
        title="Новый",
        wording="Совсем новая формулировка",
        fingerprint="9" * 64,
    )
    cl2 = make_checklist([*cl.criteria[:2], new, *cl.criteria[3:]])
    conv = make_conv(LINES)
    blocks = prompt.build_blocks(conv, conv.transcript, cl2, new)
    assert "Совсем новая формулировка" in blocks[1]["text"]


def test_prompt_version() -> None:
    assert prompt.PROMPT_VERSION == "c3"


def test_call_offsets_out_of_order_and_non_iso():
    ts = ["2026-11-01T10:00:10.000+05:00", "2026-11-01T10:00:00.000+05:00", "10:05", "2026-11-01T10:01:10.000+05:00"]
    conv = make_conv([("client", "a"), ("operator", "b"), ("client", "c"), ("operator", "d")], channel="voice call", timestamps=ts)
    lines = prompt.render_transcript(conv, conv.transcript).splitlines()
    assert lines[0].startswith("[0] +0:00 ")
    assert lines[1].startswith("[1] -0:10 ")  # earlier than the first line: signed, not "+-1:55"
    assert lines[2].startswith("[2] 10:05 ")  # not ISO: original string, no ValueError
    assert lines[3].startswith("[3] +1:00 ")
