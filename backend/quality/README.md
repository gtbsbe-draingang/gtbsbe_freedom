# Accuracy against a versioned reference

`GET /api/reports/accuracy` reports agreement on the DEV references for
`official-chat` version 2. References and conversation/checklist/evaluation storage
are integrated. Mock runs are filtered before selecting the latest completed model
run. The router is discovered automatically by `app.main`.
Other groups or checklist versions return `reference_mismatch`: admin-created
criteria need their own reviewed references, never recycled DEV scores.

Only completed evaluations with `source=model` count. The latest such evaluation
per conversation is selected, and its original `answer` is compared, before any
human decision. Missing results are reported separately, disputed labels are
excluded, and empty cohorts have null agreement. The current reference draft
still needs team review. A mixed-model report describes the deployed mixture;
compare models using separate, paired evaluation cohorts through
`accuracy_report`, not by mixing their runs in the same report.

`choose_model` accepts arbitrary local model IDs. It requires equal complete
cohorts and planted-violation checks. No recommendation is made for missing or
incomplete evidence. A passing baseline stays selected within 0.03 agreement;
otherwise the challenger must also pass its planted checks. `write_models`
changes only model fields on an unpublished seed copy; publish any live change
as a new checklist version through the normal admin flow.

One DEV run has been measured against the references: the 7 November run (Claude Haiku 5.5, 65 dialogues) agrees with 79.75% of the 479 undisputed labels and catches 21 of the 25 planted violations (`data/reference/agreement-dev-2026-11-07.json`, made with `python -m quality.devrun_accuracy`). It is one model, so no per-criterion model choice has been made and no defaults have changed.
The user requires fully local inference with a total VRAM ceiling of 140 GB;
the server and its GPU topology are not yet available here. The older hosted
model comparison in #26 is superseded by that requirement. Record actual model
IDs, quantization, context length, concurrency, per-GPU/aggregate peak memory,
latency and complete cohort coverage before selecting defaults. Keep deployment
headroom; 140 GB aggregate does not guarantee that a model fits on any one GPU.

The shared backend still contains legacy hosted-provider settings. This Stream D
change does not implement C's local evaluator adapter; that integration is a
deployment blocker. Do not describe the complete application as local-ready
until the evaluator and configuration have been switched and tested offline.
