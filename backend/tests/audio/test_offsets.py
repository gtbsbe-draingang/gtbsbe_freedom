from datetime import datetime, timedelta, timezone

import numpy as np

from audio.offsets import compute_offsets, recording_clock, parse_lines
from audio.vad import HOP

T0 = datetime(2026, 1, 1, 10, 0, 0, tzinfo=timezone(timedelta(hours=5)))


def ts(sec):
    return (T0 + timedelta(seconds=sec)).isoformat()


def synthetic_call(shift=4.4):
    """Lines spoken at known audio times; the transcript stamps each line's end, with a pause."""
    spoken = [  # (speaker, text, audio start, audio end)
        ("bot", "Добро пожаловать во Фридом брокер, для русского языка нажмите два.", 2.0, 7.0),
        ("operator", "Здравствуйте, меня зовут Алия, чем могу помочь?", 20.0, 23.5),
        ("client", "Здравствуйте, у меня не проходит приказ на покупку облигации.", 25.0, 29.5),
        ("operator", "Подскажите, пожалуйста, тикер облигации и текст ошибки.", 31.0, 35.0),
        ("client", "Тикер у меня есть, сейчас продиктую его вам полностью.", 37.0, 41.0),
    ]
    pause = (10.0, 22.0)  # transcript clock: recording paused for 12 s before the operator joined
    tr = [{"timestamp": ts(0), "speaker": "system", "text": "Запись и транскрибирование запущены."}]
    for sp, text, a, b in spoken:
        rec_end = b - shift
        t_end = rec_end if rec_end < pause[0] else rec_end + (pause[1] - pause[0])
        tr.append({"timestamp": ts(t_end), "speaker": sp, "text": text})
    tr.insert(2, {"timestamp": ts(pause[0]), "speaker": "system", "text": "Запись и транскрибирование приостановлены."})
    tr.insert(3, {"timestamp": ts(pause[1]), "speaker": "system", "text": "Запись и транскрибирование возобновлены."})
    dur = 45.0
    speech = np.zeros(int(dur / HOP), np.float32)
    for _, _, a, b in spoken:
        speech[int(a / HOP):int(b / HOP)] = 1
    return tr, speech, dur, spoken


def test_recording_clock_skips_the_pause():
    tr, *_ = synthetic_call()
    to_rec, start, pauses = recording_clock(parse_lines(tr))
    assert pauses == [(10.0, 22.0)]
    assert to_rec(30.0) == 18.0
    assert to_rec(15.0) is None  # inside the pause


def test_offsets_land_on_line_starts():
    tr, speech, dur, spoken = synthetic_call()
    offs, info = compute_offsets(tr, speech, dur)
    assert abs(info["shift_seconds"] - 4.4) <= 0.4
    by_index = {o["message_index"]: o["seconds"] for o in offs}
    spoken_idx = [i for i, m in enumerate(tr) if m["speaker"] != "system"]
    for i, (_, _, a, _) in zip(spoken_idx, spoken):
        assert abs(by_index[i] - a) <= 1.0, (i, by_index[i], a)


def test_lines_before_recording_get_no_offset():
    tr, speech, dur, _ = synthetic_call()
    early = [{"timestamp": ts(-20), "speaker": "operator", "text": "Алло, вы меня слышите?"}]
    offs, _ = compute_offsets(early + tr, speech, dur)
    assert 0 not in {o["message_index"] for o in offs}
