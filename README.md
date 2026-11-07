# CQA: Conversation Quality Analytics

A prototype for the Freedom Broker × Nazarbayev University Data Challenge. It scores support operators' chats and calls against a configurable checklist, explains every score with evidence from the dialog, and lets a score be appealed and reviewed.

**Status:** in development. Run steps for the jury will be added here before the stop-code.

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
