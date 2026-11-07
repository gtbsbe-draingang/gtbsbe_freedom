# MISTAKES.md: evaluator stream (C)

Every agent and person working on `backend/evaluator/PLAN.md` reads this file BEFORE starting a step,
appends an entry for every mistake they make (before ending the step), and re-checks it before marking
a step done. Never delete or edit old entries; add a new one.

## Entry format

```
### M<number> - <short title>
- Date: YYYY-MM-DD
- Step: <S-number or "planning">
- What happened: <the wrong assumption / failed command / misread file / late contradiction>
- Root cause: <why it happened>
- How to avoid it: <concrete check or habit>
```

## Entries

### M1 - Assumed the specs were in the working tree
- Date: 2026-11-07
- Step: planning
- What happened: `ls docs/superpowers/specs/` and `ls contract` failed ("No such file or directory"). The brief named those paths as inputs, but `docs/` is a separate private repo (gitignored) that is cloned by hand, and `contract/` has not been created yet by stream A.
- Root cause: Did not read the README's "Getting started" first; it says `docs/` is a clone of `gtbsbe_freedom-notes`.
- How to avoid it: Before reading any `docs/...` path, check `ls docs`; if it is missing, `git clone https://github.com/gtbsbe-draingang/gtbsbe_freedom-notes.git docs` (it is in `.gitignore`, so it never shows in `git status`). `contract/`, `checklists/` and `data/dev.json` do not exist yet in this checkout: do not assume them; Step S8 needs the checklist seed and `data/dev.json`.

### M2 - Read an issue without its body
- Date: 2026-11-07
- Step: planning
- What happened: `gh issue view N --comments` printed only the one-line comment ("Plan: ... Task N"), not the issue body (goal, scope, done-when, dependencies, milestone).
- Root cause: With `--comments`, `gh issue view` shows the comments instead of the body.
- How to avoid it: Read an issue with `gh issue view N --repo gtbsbe-draingang/gtbsbe_freedom --json title,body,milestone,labels -q '...'` and, separately, `--comments`.

### M3 - Could not peek at DEV data
- Date: 2026-11-07
- Step: planning
- What happened: The brief asked to peek at the structure of `data/dev.json`; the file is not in this checkout (`data/` does not exist), so field names, speakers and timestamp formats in PLAN.md come from design spec section 4 and the contract text, not from the file.
- Root cause: Raw data is never committed and has not been fetched on this machine.
- How to avoid it: S8 (first step that needs the real file) must verify the spec's description against the file with `python3 -c` printing only keys and types (never `audio_url` values) and log any difference here.

### M4 - Typed a Pydantic field with a plain Protocol
- Date: 2026-11-07
- Step: scaffold
- What happened: `EvaluateOptions.cache: JudgmentCache | None` with `arbitrary_types_allowed` failed at import: `SchemaError: 'cls' must be valid as the first argument to 'isinstance'`.
- Root cause: Pydantic validates arbitrary types with `isinstance`, which a non-runtime `typing.Protocol` does not support.
- How to avoid it: Mark a Protocol used as a Pydantic field type `@runtime_checkable` (done in `run.py`), and import the package once (`uv run python -c "import evaluator"`) right after adding a model.
