# Open items after stream C (#16–#23)

The evaluator code is done and tested (`uv run pytest evaluator/tests` from `backend/`, 300 pass).
What is left cannot be closed inside `backend/evaluator/`.

## 1. Needs teammate B (code outside `backend/evaluator/`)

| # | What | Why | Where it shows today |
|---|---|---|---|
| 1 | Add `"evaluator/tests"` to `testpaths` in `backend/pyproject.toml` | CI runs only `tests/`, so the evaluator suite is never run in CI | `uv run pytest -q` collects 49 tests, none of them evaluator tests |
| 2 | `uv add anthropic` | The SDK is not a dependency. `client.get_client` imports it lazily | `test_client.py` is skipped (`importorskip`); a real call fails on import |
| 3 | ~~`app/models.py` (#4)~~ merged. Left for C: PLAN step S13 (delete `_vendor.py`, simplify `_compat.py`) | `_compat` already imports `app.models` on main | `_vendor.py` is dead code until S13 |
| 4 | ~~`app.transcript.compute_facts`~~ merged; `evaluate` now calls `compute_facts(conv.transcript)` | Keep its signature `(list[Message]) -> Facts` stable | — |
| 5 | Set `evaluator.router.find_conversation = <lookup>` from B's conversation store | C owns no conversation storage | `GET /conversations/{id}/translation` answers 404 for every dialogue |
| 6 | Pass `EvaluateOptions(info_cache=...)` backed by B's store | Without it, dialog info is reused only within one in-memory `DictCache` | Re-runs across restarts pay for the info call again |
| 7 | `Criterion.fingerprint` must cover title, wording, scale steps, `na_allowed`, `na_condition`, kinds and guidance | `reuse_key` also hashes the rendered prompt blocks, but the fingerprint is the contract | A stale fingerprint with changed data could reuse an old result if rendering ever omits a field |
| 8 | Add `runs/` to the root `.gitignore` | `devrun --out runs/<name>.json` writes there | Run outputs could be committed by accident |
| 9 | Store second-opinion status (`pending`, `done`, `unavailable`) on the appeal object | C only returns the result or raises | No status in the UI yet |
| 10 | `contract/` JSON Schemas in this checkout | The S12 test should validate `evaluate` output against the contract | No contract check in `test_run.py` |

The router needs no mounting line: `app/main.py` already mounts any `<pkg>.router.router`.

## 2. Needs a real API key and a real DEV run (costs money; tests never do this)

| # | What | How |
|---|---|---|
| 1 | One real DEV run, with its total cost recorded in #20 and an average cost per dialogue for the README (#19) | `uv run python -m evaluator.devrun --data <dev.json> --checklist <official checklist JSON> --model <model> --out runs/dev-1.json` |
| 2 | Check the 10 expectations in `evaluator/dev_expectations.json` against the model (never run yet) | the same command with `--expectations-only` |
| 3 | Confirm masking does not change criterion 01 answers on DEV (#16) | Run c01 on DEV and read the answers for dialogues with operator self-introductions |
| 4 | Real translations of KZ and EN dialogues (#23) | `GET /conversations/{id}/translation?to=ru` once item 1.5 is wired |
| 5 | Second opinion on real DEV appeals (#22) | Once B's appeal flow calls `evaluator.second_opinion` |
| 6 | Dialog info filled for DEV dialogues (#21) | Comes with run 2.1 (`with_info=True` is the default) |

The official checklist as JSON (`checklists/official-chat-v1.json`) is not in this checkout. The run needs it.
Never commit `data/dev.json`, recordings of real dialogues, or anything with a signed URL (a `sig` query parameter).

## Open decision (team)

- Should a gross-error "no" with no evidence require `checked_range`? `checking.check_output` requires it
  now, following PLAN literally.
