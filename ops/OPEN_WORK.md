# Stream D: work left after the issues were closed

The code for issues #24 and #26 to #30 is on `main` (PR #56, #69) or in PR #70. Each issue
below was closed with what remains written here, so nothing is lost. #25 stays open on the
reviewer's request until the team approves the interpretations.

| Issue | Done | Left to do | Who / where |
|---|---|---|---|
| #24 Reference answers | 520 draft labels, review CSV tools, planted check (26 of 26) | Team review of all 520; 41 stay disputed and out of the agreement until then | Team; `data/reference/README.md` |
| #25 Interpretations | Proposals for c01, c03, c06, c07 in `official-chat` v2 | Team yes or no on each, c07 first (34 labels). Then set `disputed: false` on the agreed labels | Team; stays open |
| #26 Accuracy and model choice | `/api/reports/accuracy` on the real store, latest real run per dialogue, null for empty cohorts; model selection rule | One DEV run with the configured model on `official-chat` v2, then read the report and pick per-criterion defaults; put the numbers on deck slide 06 | Whoever runs the demo machine; needs the model key |
| #27 Call audio | Streaming with Range and expiry retry; browser check passed on all 5 calls | Nothing | Closed by PR #56 |
| #28 Line-to-audio offsets | No recogniser: per-speaker delay, voiced speech, onset search (#93; 86% of 168 lines within 2 s against an offline Whisper reference); opt-in switch `CQA_AUDIO_ALIGNMENT=on` | Listening check: `backend/tests/manual/alignment_check.py` makes a page with 30 samples. If at least 27 are "yes", turn the switch on for the demo (it is what makes the `p4-ru-001` jump on deck slide 03 work) | Anyone with the private recordings, 5 minutes |
| #29 Voice measurements, «Звонки» | Measurements code; `checklists/calls_v1.json` generated and seeded | Measurements are published only with the #28 switch on; run «Звонки» on the 5 calls with the configured model and look at c09 | After #28 |
| #30 Runbook and demo | `ops/RUNBOOK.md`, `ops/DEMO.md` | One timed rehearsal of the 5-minute demo; fill in the rehearsal record in the runbook | Team, before the defence |

## Commands

```sh
# #28 listening check (from backend/, private data stays local)
uv sync --frozen
uv run python tests/manual/alignment_check.py --audio-dir ../data/audio --dev ../data/dev.json --out /tmp/cqa-align
# open /tmp/cqa-align/alignment-check.html, mark 30 rows, download the results

# demo with offsets on, once the check passes
CQA_AUDIO_ALIGNMENT=on uv run cqa-serve
```
