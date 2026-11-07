# CQA: Conversation Quality Analytics

A prototype for the Freedom Broker × Nazarbayev University Data Challenge. It scores support operators' chats and calls against a configurable checklist, explains every score with evidence from the dialog, and lets a score be appealed and reviewed.

**Status:** the backend serves the static UI, but required frontend workflows are still in development (see `HANDOVER.md` and #33/#36). The real DEV evaluation is complete (65 dialogues; see #20 and PR #60), but its results snapshot (`data/snapshot/cqa-snapshot.json`) has not yet been committed. A fresh clone currently starts without stored results. Issue #15 remains open until the snapshot and clean-clone verification are complete.

## Run it

All you need is `uv` and internet access for the first dependency installation. It installs Python 3.12; Node is not needed because `web/dist/` is committed. You do not need a model key to browse stored results, once a snapshot is present.

1. **Install `uv`** (once). It downloads Python 3.12 by itself.
   - Windows PowerShell: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - macOS or Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. **Start it.**
   ```sh
   cd backend
   uv run cqa-serve
   ```
   Then open <http://127.0.0.1:8000/>. When present, the first start loads the results snapshot from `data/snapshot/` into a local database (`backend/cqa.db`). Everything that is already stored works without a key: the queue, scores with their evidence, appeals and decisions, comparisons, analytics and the CSV export. New evaluations that cannot reuse stored judgments return `409 model_key_missing`; uncached translation and model second opinions also need a key. Add `--host` or `--port` to change the address.
3. **Optional: a `.env` file.** Copy `backend/.env.example` to `backend/.env`, then restart.
   - `ORGANIZER_API_URL`: the GET link from the guide. It lets you import a dataset group and brings back call playback.
   - `ANTHROPIC_API_KEY`: needed only for new evaluations (a new or reworded criterion, or a new dialogue).
4. **Models and cost.** The real DEV run used `claude-haiku-5-5` with the official eight-criterion checklist. `claude-sonnet-5-5` is also configured; each criterion can select its own model. Dialogue information and translation use the default model; an appeal's second opinion uses the criterion's model. Scores, rounding and N/A redistribution are computed in Python, not by the model.

   The run reported in PR #60 and issue #20 on November 7, 2026 evaluated all **65 DEV dialogues**, made **613 calls**, had **zero failed criteria**, and passed **all 10 hand-written expectations**. Reported total cost: **$0.27**, or **about $0.00415 per dialogue**, in about 11 minutes. This is one observed run, not a guaranteed price or an independent accuracy measurement. Its raw report is private and has not yet been imported into this checkout.

   `GET /api/config` exposes the configured accounting rates in USD per million tokens: Haiku input $0.10 / output $0.50; Sonnet input $2.00 / output $10.00. These are the rates used by this application, not a promise about future provider billing. Cost calculation uses actual token usage, including prompt-cache writes at 1.25x input and reads at 0.10x input. An unchanged judgment or weight-only change reuses cached answers with no new criterion calls. New wording, transcripts, models or uncached translations can incur additional cost. Paid call records are stored locally in `c_llm_calls`.

5. **Privacy.** This repo holds no signed links and no call recordings. The snapshot has no audio links, and your link and key stay in `backend/.env`, which git ignores. Dialogue text goes to the Claude API only when you set a key. Three things then send it: a new evaluation, the second opinion on an appeal, and a translation. Without a key, no dialogue text leaves your machine.

## For the team

### Getting started

```sh
git clone https://github.com/gtbsbe-draingang/gtbsbe_freedom.git
cd gtbsbe_freedom
git clone https://github.com/gtbsbe-draingang/gtbsbe_freedom-notes.git docs   # private specs and plans
cp docs/source/*.pdf .                                                        # task guide and official checklist
```

Then fetch the DEV data into `data/dev.json`, as described in `docs/README.md`. Read `CLAUDE.md` (project rules for every agent) and your stream's part of the design in `docs/superpowers/specs/`.

### Streams

| Label | Stream | Folder |
|---|---|---|
| `A-frontend` | Front end (Dynamics-ready UI) | `web/` |
| `B-backend` | Backend platform: storage, import, scoring, jobs, appeals, comparisons, snapshot | `backend/app/` |
| `C-evaluator` | Evaluator: prompts, answer checking, reuse, cost | `backend/evaluator/` |
| `D-quality-calls` | Reference answers, accuracy, model choice, call audio, «Звонки» checklist | `backend/quality/`, `backend/audio/`, `data/reference/`, `checklists/` |

The single API contract is section 7 of `docs/superpowers/specs/2026-11-07-cqa-frontend-design.md`, with JSON Schemas and examples in `contract/`.

### Jury snapshot

On the machine holding the real evaluated database, export all stored results:

```sh
cd backend
uv run cqa-snapshot
```

For a database elsewhere, set `DB_PATH` to its absolute path before running the command. The export includes stored DEV and control groups, completed evaluations, checklist versions, appeals and judgment reuse caches. It excludes jobs, recording links and audio files; it refuses signed-link markers and checklist seed mismatches. Export after the control-set run as well. Do not use synthetic test results as the real DEV snapshot.

Review and commit `data/snapshot/cqa-snapshot.json` on a branch, then verify that commit from a fresh clone without a `.env` file or model key:

```sh
git clone --branch <snapshot-branch> https://github.com/gtbsbe-draingang/gtbsbe_freedom.git cqa-jury-check
cd cqa-jury-check/backend
uv run cqa-serve --port 8001
```

Ensure the shell has no `ANTHROPIC_API_KEY` or `ORGANIZER_API_URL` configured. Check that `/api/config` reports `model_key_configured: false`, the queue shows every exported dialogue and its scores, appeals can be filed and decided, and a genuinely new criterion gives a clear missing-key response. Without re-importing the organizers' group using your own URL, call playback is unavailable by design. Cached translation is available only when its table was registered for snapshot export. Do not delete an existing working database to simulate a fresh clone.

### Verification

```sh
cd backend
uv run pytest -q
cd ../web
npm ci
npm run check
```

Backend tests isolate keys, signed URLs and databases and do not make paid model calls. The adapter-to-FastAPI checklist regression also needs Node, and skips explicitly if it is unavailable. Frontend browser tests use a mock adapter; they do not replace a real-backend demo check for #33. `npm run check` requires a locally installed Chrome/Chromium browser and the private DEV data locally, or its directory set through `CQA_DATA_DIR`. Any change under `web/` must also rebuild the committed distribution with `npm run build`.

### Workflow

- Pick an open issue with your stream's label and assign yourself.
- Branch per issue, prefixed with your stream letter: `c/12-answer-checking`.
- Open a pull request into `main` that says `Fixes #12`. Keep it small. Nobody pushes straight to `main`.
- Milestones are the meeting points where streams depend on each other. Check them before starting something that waits on another stream.
- Never commit secrets, signed URLs (`sig=`), `data/dev.json` or call recordings. The model API key lives in your Keychain and reaches the app through `ANTHROPIC_API_KEY`.
