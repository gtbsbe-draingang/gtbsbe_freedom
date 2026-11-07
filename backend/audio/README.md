# Audio integration and acceptance status

The runtime endpoint streams from the organizer through our origin and forwards
Range requests. It caches only resolved URLs in memory, for at most 3000 seconds
and 128 entries. Expired 403/404/410 responses trigger one fresh resolution.
Only length/range headers pass through; links, cookies and upstream errors do
not. `httpx` request logging redacts URLs. Audio files are not cached by the API.

Install CPU dependencies after `uv sync --frozen` with
`uv pip install -r requirements-audio.txt`. They are separately constrained;
they are not yet part of the shared uv lockfile. No GPU or hosted model is needed
for these measurements. `audio.fetch_dev` is an explicit development-only
download tool; keep its output under the ignored `data/audio/` directory.

`audio.analyse(transcript, samples, sr)` returns shared `AudioOffset` and
`VoiceMeasurement` objects. `audio.process_call(id)` resolves and decodes in
memory, has a 60-second processing deadline and 128 MiB download cap, then calls
`app.store.save_audio_results`. Failures are contained so imports can finish.
The deadline cancels awaiting CPU work; an already running worker thread may
finish afterward. It does not write late results to storage.

B must provide `get_conversation`, `get_audio_url`, and `save_audio_results`
in `app.store`, and schedule processing after imports. Storage is absent from
the fetched B branch, so live browser playback and persistence remain unverified.

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
