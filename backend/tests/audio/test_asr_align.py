"""#28: snapping line starts to recognised words, and the opt-in switch for publishing them."""
import numpy as np

from audio import asr_align, pipeline


def words(*pairs):
    return [{"n": asr_align.norm(w), "s": s} for w, s in pairs]


HEARD = words(("алло", 1.0), ("здравствуйте", 2.0), ("компания", 2.6), ("фридом", 3.1), ("брокер", 3.4),
              ("меня", 3.9), ("зовут", 4.2), ("да", 9.0), ("слушаю", 9.4), ("вас", 9.8))


def test_match_start_finds_the_first_words_despite_recognition_errors():
    assert asr_align.match_start("Здравствуйте, компания Фридом Брокер, меня зовут [Имя скрыто]", HEARD, 0, 10) == 2.0
    assert asr_align.match_start("Компания федеброкер меня зовут", HEARD, 0, 10) == 2.6


def test_match_start_needs_two_words_and_stays_inside_the_window():
    assert asr_align.match_start("Да.", HEARD, 0, 10) is None  # one word is too little to trust
    assert asr_align.match_start("Здравствуйте, компания Фридом", HEARD, 5, 10) is None
    assert asr_align.match_start("Совсем другие слова здесь", HEARD, 0, 10) is None


def test_snap_spans_moves_only_matched_spoken_lines_and_never_past_the_end():
    spans = [
        {"message_index": 0, "speaker": "system", "text": "Агент присоединился", "start": 0.5, "end": 0.5},
        {"message_index": 1, "speaker": "operator", "text": "Здравствуйте, компания Фридом Брокер", "start": 3.5, "end": 5.0},
        {"message_index": 2, "speaker": "client", "text": "Да, слушаю вас", "start": 9.2, "end": 8.0},
        {"message_index": 3, "speaker": "client", "text": "Угу", "start": 12.0, "end": 12.5},
    ]
    out, moved = asr_align.snap_spans(spans, HEARD)
    assert [s["start"] for s in out] == [0.5, 2.0, 9.2, 12.0] and moved == 1
    assert spans[1]["start"] == 3.5  # input untouched


def test_refine_without_the_recogniser_keeps_spans(monkeypatch):
    monkeypatch.setattr(asr_align, "available", lambda: False)
    spans = [{"message_index": 1, "speaker": "operator", "text": "a b", "start": 1.0, "end": 2.0}]
    assert asr_align.refine(spans, np.zeros(16000, np.float32)) == (spans, {"asr": "not installed"})


def test_alignment_follows_the_switch_and_otherwise_the_recogniser(monkeypatch):
    monkeypatch.delenv("CQA_AUDIO_ALIGNMENT", raising=False)
    monkeypatch.setattr(asr_align, "available", lambda: False)
    assert not pipeline.alignment_enabled()  # the length guess alone was not what passed the check
    monkeypatch.setattr(asr_align, "available", lambda: True)
    assert pipeline.alignment_enabled()
    monkeypatch.setenv("CQA_AUDIO_ALIGNMENT", "off")
    assert not pipeline.alignment_enabled()
    monkeypatch.setattr(asr_align, "available", lambda: False)
    monkeypatch.setenv("CQA_AUDIO_ALIGNMENT", " ON ")
    assert pipeline.alignment_enabled()


async def test_switched_on_the_import_stores_offsets(client, monkeypatch):
    from app import store
    from app.models import AudioOffset, Conversation

    monkeypatch.setenv("CQA_AUDIO_ALIGNMENT", "on")
    conv = Conversation(id="DEV:call", conversation_id="call", group_id="DEV", channel="voice call",
                        language="RU", transcript=[])
    store.upsert_conversation(conv, "https://fixture.invalid/player/call")

    async def download(player):
        assert player == "https://fixture.invalid/player/call"
        return b"mp3"

    monkeypatch.setattr(pipeline, "_download", download)
    monkeypatch.setattr(pipeline, "decode", lambda data: (np.zeros(16000, np.float32), 16000))
    monkeypatch.setattr(pipeline, "analyse", lambda *a: ([AudioOffset(message_index=0, seconds=1.5)], []))
    await pipeline.process_call(conv.id)
    assert client.get("/api/conversations/DEV:call").json()["audio_offsets"] == [{"message_index": 0, "seconds": 1.5}]
