# Audio integration and acceptance status

The runtime endpoint streams from the organizer through our origin and forwards
Range requests. It caches only resolved URLs in memory, for at most 3000 seconds
and 128 entries. Expired 403/404/410 responses trigger one fresh resolution.
Only length/range headers pass through; links, cookies and upstream errors do
not. `httpx` request logging redacts URLs. Audio files are not cached by the API.

Install with `uv sync --frozen`. CPU audio dependencies are pinned in the shared
`uv.lock`. No GPU or hosted model is needed
for these measurements. `audio.fetch_dev` is an explicit development-only
download tool; keep its output under the ignored `data/audio/` directory.

`audio.analyse(transcript, samples, sr)` returns shared `AudioOffset` and
`VoiceMeasurement` objects. `audio.process_call(id)` resolves and decodes in
memory, has a 60-second processing deadline and 128 MiB download cap, then calls
`app.store.save_audio_results`. Failures are contained so imports can finish.
The deadline cancels awaiting CPU work; an already running worker thread may
finish afterward. It does not write late results to storage.

B's `app.store` now provides `get_conversation`, `get_audio_url`, and
`save_audio_results`; the latest shared backend has been merged into this branch.
The import hook schedules audio processing. All five cached DEV recordings were
processed with the locked environment and persisted through B's real SQLite
store in an isolated verification database: 374 offsets and 130 operator
measurements. This verifies decoding, analysis and persistence, not alignment
accuracy or browser playback.

### Listening check (#28)

A person listened to 30 lines sampled from the five DEV calls (6 per call,
`tests/manual/alignment_check.py`, seed 28) on 7 November: **29 of 30 started within about
2 s** of where playback started (the miss was `p4-ru-002` line 21). Some passing lines have
transcript text that the organisers' recognition got wrong; their timing was still right.
That check tested the **previous** method (length guess plus faster-whisper snapping), which
#93 replaced with the recogniser-free method below.

The **#93 method** was checked the same way on the same 30 lines on 7 November: **28 of 30
start within about 2 s**. The misses are `p4-ru-001` line 18 (1.7 s later than the old method
put it) and `p4-ru-002` line 21 (missed by both). Offsets and voice measurements are therefore
published by default; `CQA_AUDIO_ALIGNMENT=off` turns them off and clears stored ones.

### Browser playback check (#27)

Run on 2026-11-07 with Chrome 156 (headless) against the real API and the five
private DEV recordings, the organiser's player and MP3 host replaced by a local
replay (`tests/manual/audio_browser_server.py`, then
`CHROME=<path> node web/test/e2e/audio.mjs` from the repo root). All five calls
(312 to 620 s long) loaded metadata, played, sought to 30 s and resumed from
there. Range requests returned 206 for `bytes=1024-2047` and `bytes=-512` and
416 past the end. Each call's first MP3 link was answered as expired and the
endpoint resolved a fresh one exactly once. This checks the browser and our
endpoint, not the live organiser links or the product UI's player.

Offsets use transcript timing, recording pauses and speech activity only; no
speech recogniser runs in the product (#93). They are estimates. Mono audio does
not establish which speakers overlap; the public measurements return
`overlap=null`. Pitch and rate depend on the estimated span and must not be
treated as reliable emotion or interruption labels.

How lines are placed (`audio.offsets`): recording clock from the system events,
then a per-call delay for human lines and a separate one for the bot (humans end
about +4 s after their timestamp, the bot about 1 s before), then each start is
the speech onset nearest "end minus length at 15.4 characters a second", not
before the same speaker's previous line ended. Speech activity (`audio.vad`) is
voiced (Praat pitch) and at least 6 dB above the noise floor.

Diagnostic on 2026-11-07 (#93): reference starts from a whole-call alignment of
the transcript to Whisper-small word timings, run offline and not shipped; 168
lines whose words matched clearly.

| Method | Median | Within 1 s | Within 2 s | Maximum |
|---|---:|---:|---:|---:|
| Before #93 (one delay, energy, 13 c/s) | 1.00 s | 50% | 76% | 20 s |
| #93 | 0.48 s | 71% | 86% | 9 s |
| #93, speaking rate refitted leaving each call out | 0.47 s | 71% | 86% | 9 s |

Per call (within 2 s): p4-ru-001 92%, -002 97%, -003 78%, -004 83%, -005 79%.
What remains are lines said slowly with long pauses (34 characters over 11 s),
which length cannot predict. The reference is a recogniser, not human ground
truth, and covers only matched lines; the listening check above (28 of 30) is the
independent check.

The earlier `calls_v1.json` used invented IDs and was not derived from A's seed;
it has been removed. Once A's authoritative seed is available, generate a draft:

```sh
uv run python -m audio.build_calls_seed ../checklists/official-chat-v1.json ../checklists/calls_v1.json
```

The builder copies c01–c08 scoring fields/model choices, adapts voice wording,
and adds c09. Run A's authoritative loader/contract validation, check the shared
fields against the actual seed, and publish through the normal versioned flow.
Synthetic fixture tests do not replace that integration check. Thresholds have
not been validated on the five calls. Keep #27–#29 open until playback, seeking,
human alignment, stored measurements and checklist evaluation all pass.
