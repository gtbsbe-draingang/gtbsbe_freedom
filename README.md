# CQA: Conversation Quality Analytics

A prototype for the Freedom Broker × Nazarbayev University Data Challenge. It scores support operators' chats and calls against a configurable checklist, explains every score with evidence from the dialog, and lets a score be appealed and reviewed.

**Status:** in development. The run steps for the jury are below. The results snapshot (`data/snapshot/cqa-snapshot.json`) is committed after the first real DEV run. Until then the first start has no stored results.

## Run it

All you need is `uv`. You do not need a model key to see the results.

1. **Install `uv`** (once). It downloads Python 3.12 by itself.
   - Windows PowerShell: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
   - macOS or Linux: `curl -LsSf https://astral.sh/uv/install.sh | sh`
2. **Start it.**
   ```sh
   cd backend
   uv run cqa-serve
   ```
   Then open <http://127.0.0.1:8000/>. The first start loads the results snapshot from `data/snapshot/` into a local database (`backend/cqa.db`). Everything that is already stored works without a key: the queue, scores with their evidence, appeals and decisions, comparisons, analytics and the CSV export. Add `--host` or `--port` to change the address.
3. **Optional: a `.env` file.** Copy `backend/.env.example` to `backend/.env`, then restart.
   - `ORGANIZER_API_URL`: the GET link from the guide. It lets you import a dataset group and brings back call playback.
   - `ANTHROPIC_API_KEY`: needed only for new evaluations (a new or reworded criterion, or a new dialogue).
4. **Models and cost.** Each criterion is judged by `claude-haiku-5-5`, unless its checklist names another model for it. `GET /api/config` lists the models and their prices.

   Measured average cost per evaluation: to be filled in after the DEV run

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

### Workflow

- Pick an open issue with your stream's label and assign yourself.
- Branch per issue, prefixed with your stream letter: `c/12-answer-checking`.
- Open a pull request into `main` that says `Fixes #12`. Keep it small. Nobody pushes straight to `main`.
- Milestones are the meeting points where streams depend on each other. Check them before starting something that waits on another stream.
- Never commit secrets, signed URLs (`sig=`), `data/dev.json` or call recordings. The model API key lives in your Keychain and reaches the app through `ANTHROPIC_API_KEY`.
