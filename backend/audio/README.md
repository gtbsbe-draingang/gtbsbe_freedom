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

The import no longer produces offsets or voice measurements (PR #56 review): they
stay withheld until alignment passes an independent check, and migration
`d_001_withhold_unvalidated_audio` clears stored ones. Playback is unchanged.

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

Offsets still use transcript timing, recording pauses and speech energy.
They are estimates. Mono audio does not establish which speakers overlap;
the public measurements return `overlap=null`. Pitch and rate depend on the
estimated span and must not be treated as reliable emotion or interruption labels.

The cached Whisper-small diagnostic on 2026-11-07, against commit `11237d2`,
compared 137 matched lines:

| Call | Matched lines | Median absolute difference | Within 2 seconds | Maximum |
|---|---:|---:|---:|---:|
| p4-ru-001 | 18 | 0.73 s | 72% | 10.6 s |
| p4-ru-002 | 29 | 0.80 s | 83% | 5.7 s |
| p4-ru-003 | 23 | 1.96 s | 52% | 10.4 s |
| p4-ru-004 | 35 | 1.00 s | 80% | 19.7 s |
| p4-ru-005 | 32 | 0.87 s | 62% | 20.5 s |

Overall: median 1.00 s, 71% within 2 s. This is a heuristic text match to ASR,
not human ground truth, and covers only matched lines. Issue #28 does not pass
acceptance. Listen and annotate starts independently, then improve local forced
alignment before claiming the 2-second target. Do not tune and report on the
same reference offsets without separating validation.

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
