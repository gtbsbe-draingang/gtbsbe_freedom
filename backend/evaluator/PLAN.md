# Evaluator (stream C): implementation plan

Folder: `backend/evaluator/`. Issues: #16 to #23 (label `C-evaluator`). Written 2026-11-07.

This file is the step-by-step plan and the API description. Code sketches and full test bodies live in the
private notes repo (clone it as `docs/`, see README): `docs/superpowers/plans/2026-11-07-stream-c-evaluator.md`
("the notes plan", its Tasks 1 to 12). Shared names: `docs/superpowers/plans/2026-11-07-shared-interfaces.md`.
HTTP contract: section 7 of `docs/superpowers/specs/2026-11-07-cqa-frontend-design.md` (the single source) and
`contract/` once stream A has created it. If this file and those disagree, stop and ask (see "Conflicts").

## Rules for every agent (mandatory)

1. **READ `backend/evaluator/MISTAKES.md` before starting any step.** Do not skip it, even for a small step.
2. **APPEND an entry to `backend/evaluator/MISTAKES.md` for every mistake you make** (wrong assumption, failed
   command, misread file, a contradiction found late, a test you had to rewrite because you misread the
   interface), in the format at the top of that file, **before ending your step**. No mistake is also a valid
   outcome; then write nothing.
3. **Re-check `MISTAKES.md` before marking a step done**, and confirm none of its "how to avoid" items was
   ignored.
4. Each step's acceptance checklist below includes "MISTAKES.md read at start / updated if any mistake". A step
   without that box ticked is not done.
5. Project rules (`CLAUDE.md`) apply to every step:
   - Never print, store, log or commit a signed URL (`sig=`) or any `audio_url`. Never commit `data/dev.json` or
     `data/audio/`.
   - No secrets in code. The model key comes from `ANTHROPIC_API_KEY` through `app.settings`.
   - Commits as `schlmpcs`, **no AI attribution** (no `Co-Authored-By`, no "Generated with"), even if a tool
     suggests one. One branch per issue, `c/<issue>-<slug>`, PR says `Fixes #<issue>`.
   - Tests never call the Claude API; CI has no key.
6. **Additive only.** A step may add modules, functions, optional parameters and exports. It must not rename,
   remove or change the meaning of anything an earlier step exported (listed under "Must not change").

**Common acceptance (every step):** from `backend/`: `uv run pytest evaluator/tests -q` is green, and
`git grep -n "sig=" -- . ':!evaluator/PLAN.md'` prints nothing, and
`git grep -n -E "sk-ant-|audio_url" -- evaluator evaluator/tests ':!evaluator/PLAN.md' ':!evaluator/MISTAKES.md'` prints nothing except the one allowed
`audio_url` mention in `devrun.py` (S8) that drops it.

## Status of inputs found while planning

- B's skeleton (`pyproject.toml`, `app/settings.py`, `app/db.py`, `app/errors.py`) is in PR #38
  (`b/3-skeleton`), not on `main` yet; `app/models.py` (#4) does not exist. The scaffold therefore ships the
  temporary model copy (`_vendor.py`) that S13 deletes.
- `contract/`, `checklists/official-chat-v1.json` and `data/dev.json` are not in this checkout. The checklist seed
  comes from stream A; DEV comes from the organisers via B's import. Only S8 needs them.
- Open issues: #16, #17, #18, #19, #20, #21, #22, #23 (all `OPEN`, bodies read, each has one comment pointing at
  the notes plan).

## Issue to step map

| Issue | Title | Milestone | Closed by |
|---|---|---|---|
| #16 | Personal-data masking | M1 | S1 |
| #17 | Evaluator core, one structured call per criterion | M1 | S2, S3, S6 (S13 follow-up; S12 adds the single entry point on top) |
| #18 | Answer checking and retry | M1 | S5, S6 |
| #19 | Reuse keys and cost logging | M1 | S4, S7 |
| #20 | Test harness and DEV run script | M1 | S8 |
| #21 | Not-scored dialog information | M2 | S9 |
| #22 | Second opinion on appeals | M2 | S10 |
| #23 | Translation on demand | M4 | S11 |

S12 (`evaluate()` entry point) and S13 (switch to `app.models`) are not named by any issue. Proposal: attach S12
to #17 as an extra checkbox, S13 as the existing "Task 12" follow-up of #17. Ask the team lead before opening a
new issue.

## Scaffold and parallel work map (read this first)

The scaffold (branch `c/scaffold`, built on B's `b/3-skeleton`, PR #38) already created **every module, every
public signature and the shared test helpers**. Bodies raise `NotImplementedError("S<n> (#<issue>): ...")`.
An issue's job is to replace those bodies and add its own test file, nothing else. This overrides the "Files:
create ..." lines of S1 to S12 where they name a file that now exists.

**Already final (do not re-create):** `_vendor.py`, `_compat.py`, `__init__.py` (full public surface),
`schemas.py` (all output models; only `json_schema_for` is open), `client.ModelKeyMissing`,
`client.JudgmentFailed`, `client.get_client`/`set_client`, `checking.Problem` + code constants + `FATAL_CODES`,
`run.py` types + `DictCache`, both migrations (`c_001_llm_calls` in `cost.py`, `c_002_translations` in
`translation.py`), `router.router` (endpoint answers 501 until #23).

**Stream C touches only `backend/evaluator/`.** Tests live in `backend/evaluator/tests/` (own `conftest.py`
with the same settings isolation as B's `tests/conftest.py`). Run them with `uv run pytest evaluator/tests`
from `backend/`; replace `tests/evaluator` with `evaluator/tests` in every command below. Two things outside
the folder are hand-offs to B, never edits by C: (1) add `"evaluator/tests"` to `testpaths` in
`pyproject.toml` so CI runs them; (2) `uv add anthropic` (needed from S3 on; `client.get_client` imports it
lazily, so the scaffold runs without it).

**Frozen surface:** `evaluator/tests/test_scaffold.py` pins every public signature (`FROZEN`). Additive changes
(new function, new trailing optional parameter) add a line to `FROZEN` in the same PR. Renames need the team.

**Shared test helpers:** `evaluator/testing.py` (importable as `evaluator.testing` from tests and from `devrun`). Factories `make_conv`, `make_criterion`,
`make_gross_criterion`, `make_checklist` (8 criteria shaped like the official one), `make_record`,
`VALID_C01_NO`; fakes `ScriptedCalls`, `FakeAsyncAnthropic`, `text_response`, `status_error`, `from_recorded`
(S8). Fixtures in `evaluator/tests/conftest.py`: `scripted`, `fake_anthropic`, `api_key`, `db`.

**Two fakes, so callers do not wait for S3:** every module calls the model only as
`client.call_structured(...)` (module attribute, `from evaluator import client`), never
`from evaluator.client import call_structured`. The `scripted` fixture swaps that attribute, so S6, S9, S10 and
S11 test against scripted outputs without a working client. Only S3 uses `fake_anthropic`.

### Who owns which file (one owner per file = no merge conflicts)

| Issue / step | Fills in | Own test file |
|---|---|---|
| #16 S1 | `masking.py` | `test_masking.py` |
| #17 S2 | `prompt.py` | `test_prompt.py` |
| #17 S3 | `schemas.json_schema_for`, `client.call_structured`, `cost.call_cost` | `test_schemas.py`, `test_client.py`, `test_cost_formula.py` |
| #19 S4 | `keys.py` | `test_keys.py` |
| #18 S5 | `checking.py` | `test_checking.py` |
| #19 S7 | `cost.log_calls`, `cost.total_cost` | `test_cost_log.py` |
| #17/#18 S6 | `judge.py` (+ the `log_calls` call) | `test_judge.py` |
| #21 S9 | `info.py` | `test_info.py` |
| #22 S10 | `second_opinion.py` | `test_second_opinion.py` |
| #23 S11 | `translation.py`, `router.py` | `test_translation.py`, `test_router.py` |
| #20 S8 | `devrun.py`, `dev_expectations.json`, `testing.from_recorded`, `evaluator/tests/recorded/` | `test_devrun.py` |
| S12 | `run.evaluate` | `test_run.py` |
| S13 | delete `_vendor.py`, simplify `_compat.py` | (whole suite) |

`test_cost.py` is split into `test_cost_formula.py` (S3) and `test_cost_log.py` (S7) so the two never touch the
same file. Shared files (`testing.py`, `conftest.py`, `schemas.py`, `__init__.py`, `test_scaffold.py`): add only,
in small separate hunks; never reformat them.

### Waves (what can start when)

```
Wave 1, start now, all in parallel:   #16 S1   #17 S2   #17 S3   #19 S4   #18 S5   #19 S7
                                      #23 S11 storage + router error paths (load/save_translation, 404/422)
                                      #20 S8 loader part (load_dev_conversations, expectations, from_recorded)
Wave 2, needs the wave-1 pieces named: S6 judge      <- S1 mask, S2 build_blocks, S4 reuse_key, S5 check_output, S7 log_calls
                                      #21 S9 info   <- S1, S2 render_transcript/render_facts
                                      #22 S10       <- S2 build_blocks/neutralize_tags, S5 check_answer
                                      #23 S11 translate <- S1, S2 neutralize_tags
Wave 3:                               S12 evaluate  <- S6, S9      #20 S8 run/main <- S12 (or S6)
Any time after B's #4 merges:         S13
```

Wave-2 tests use `scripted` for the model, but call the real wave-1 functions; start a wave-2 branch from
`main` once its inputs are merged (or stack it on their branches and rebase).

## Conflicts and open questions (flagged, not silently resolved)

1. **Entry point shape.** The brief asks for `evaluate(dialogue, checklist, options) -> Evaluation`. The shared
   interfaces give B the `Evaluation` (totals, sections, carry-forward, appeals) and say C "doesn't construct"
   it; C exports `judge_criterion`, `dialog_info`, `second_opinion`. **Resolution in this plan:** S12 adds
   `evaluate()` as a thin additive wrapper that returns an `EvaluatorRun` (judgments + info + cost, no totals).
   B keeps calling `judge_criterion` in its own job loop; nothing of B changes. If the team wants `evaluate()`
   to return the contract `Evaluation` with totals, that needs B's `app.scoring` and is a separate decision.
2. **Reuse key contents.** Issue #19 and design 7.3 define the key as fingerprint + transcript hash + model +
   prompt version. The shared-interfaces file (and B's plan) add the checklist's shared `guidance`, the facts and
   the voice measurements, so a change in any of them invalidates results. This plan follows shared-interfaces
   (stricter). Effect: a weight-only change still makes zero calls (weight is not in the fingerprint).
3. **Field names.** Design 7.1 still says `line_id`, `from_line`, `Да/Нет`, `binary`/`flag`. Contract names win
   (design 9.3 says so): `message_index`, `checked_range {from, to}`, `yes|no|na|{step}`,
   `answer_type yes_no|scale`, `kind scored|gross_error`.
4. **#17 "Depends on #4, #5"** (B's models and the checklist seed). The notes plan removes the hard dependency
   with a temporary vendored copy (S1) and needs the seed only in S8. Kept that way.
5. **#16 sits in M1 but depends on #4**: same remedy as 4.
6. **#22** says `second_opinion_status` pending, done or unavailable: that status belongs to B's appeal object.
   C only returns a `SecondOpinion` or raises (`ModelKeyMissing`, `JudgmentFailed`); B maps both to
   `unavailable`. Not a conflict, but do not put the status in C.
7. **Quote matching library.** The notes plan adds `rapidfuzz`. "Prefer stdlib" suggests `difflib`. S5 starts with
   `difflib.SequenceMatcher`; adopt `rapidfuzz` only if the S5 tests fail without it, and log why in MISTAKES.md
   or the PR. This changes no interface.
8. **Model-API details** (beta header `server-side-fallback-2026-07-01`, `output_config`, `effort`, `httpx2` in
   the fake) come from the notes plan and the `claude-api` skill. Re-verify them against the `claude-api` skill in
   S3 before coding; fix this file if the skill says otherwise.
9. **Determinism.** The models run adaptive thinking and may not accept `temperature`; identical input can give
   different text. Determinism is therefore provided by reuse keys (same key, same stored judgment), not by
   re-generation. State this to the team; do not promise bit-identical re-runs.
10. **Recorded responses (#20) are committed.** They must come from synthetic chats only (never `p4-*` calls) and
    contain no `sig=`.

---

# API description: the single entry point

Everything the rest of the system needs is importable from one package: `from evaluator import ...`. The
**one entry point** is `evaluate()`; the three finer functions B already plans to call remain public.

## Public surface (`backend/evaluator/__init__.py`)

```python
# errors
class ModelKeyMissing(Exception): ...
class JudgmentFailed(Exception):
    reason: str; retryable: bool; request_id: str | None
    def __init__(self, reason: str, *, retryable: bool = False, request_id: str | None = None): ...

# the single entry point (S12)
async def evaluate(dialogue: Conversation, checklist: ChecklistVersion,
                   options: EvaluateOptions | None = None) -> EvaluatorRun

# building blocks (S4 to S10), the ones stream B calls directly
def reuse_key(conv: Conversation, checklist: ChecklistVersion, criterion: Criterion, model: str) -> str
async def judge_criterion(conv, checklist, criterion, *, model: str) -> Judgment
async def dialog_info(conv) -> tuple[DialogInfo, list[LLMCallRecord]]
async def second_opinion(conv, checklist, criterion, result: CriterionResult, comment: str) \
        -> tuple[SecondOpinion, list[LLMCallRecord]]
# plus evaluator.router.router (S11): GET /conversations/{conversation}/translation?to=ru
```

All model types (`Conversation`, `ChecklistVersion`, `Criterion`, `Judgment`, `Evidence`, `CheckedRange`,
`StepAnswer`, `Answer`, `DialogInfo`, `LLMCallRecord`, `SecondOpinion`, `CriterionResult`) are the shared
Pydantic v2 models from `app.models` (owned by B). The evaluator imports them through `evaluator._compat` and
never redefines them.

## Types added by C (S12)

```python
class EvaluateOptions(BaseModel):           # all optional; defaults give "evaluate everything, reuse nothing"
    model: str | None = None                # force one model for all criteria; None = criterion.model or settings.default_model
    criteria: list[str] | None = None       # subset of Criterion.id; None = all
    with_info: bool = True                  # also run dialog_info (extra B); never affects anything else
    mode: Literal["reuse", "full"] = "reuse"   # "full" ignores the cache
    cache: JudgmentCache | None = None      # see below; None = no reuse across calls

class JudgmentCache(Protocol):              # B's judgments table implements this; C ships an in-memory dict version for tests
    def get(self, key: str) -> Judgment | None: ...
    def put(self, key: str, judgment: Judgment) -> None: ...

class Failure(BaseModel):
    criterion_id: str
    reason: str                              # JudgmentFailed.reason, e.g. "rate_limited", "invalid_answer", "max_tokens"
    retryable: bool
    request_id: str | None = None

class EvaluatorRun(BaseModel):
    conversation: str                        # Conversation.id, "{group_id}:{conversation_id}"
    checklist_id: str
    version: int
    source: Literal["model"] = "model"       # contract field Evaluation.source
    results: list[Judgment]                  # checklist order; failed criteria are absent (see failures)
    failures: list[Failure] = []
    reused: list[str] = []                   # criterion ids served from the cache (no call)
    info: DialogInfo | None = None           # None when with_info=False or it failed
    info_error: str | None = None
    calls: list[LLMCallRecord] = []          # model calls made by THIS run only (cache hits add none)
    cost_usd: Decimal                        # sum of calls[].cost_usd, USD, 6 decimals; 0 when nothing was called
    needs_review: bool                       # any result.needs_review
```

`evaluate()` does: (1) raise `ModelKeyMissing` if a call is needed and no key is set (all-reused is fine);
(2) fill `dialogue.facts` through `app.transcript.compute_facts` if it is `None` (on a copy, the input is never
mutated); (3) for each selected criterion compute `reuse_key`, take cache hits; (4) run the first missing
criterion alone, then the rest in parallel under `asyncio.Semaphore(settings.max_parallel_calls)` (so later
calls read the prompt cache the first one wrote); (5) run `dialog_info` if wanted; (6) collect. Per-criterion
`JudgmentFailed` goes into `failures`, the run continues. It does **not** score, round, redistribute N/A weight,
carry appeals or store anything except through the optional `cache`: those are B's.

## Input conventions

| Field | Type | Unit / format | Null? |
|---|---|---|---|
| `Conversation.id` | str | `{group_id}:{conversation_id}` | no |
| `Conversation.channel` | `"agent chat"` or `"voice call"` | exact organiser strings | no |
| `Conversation.language` | `"RU"`, `"KZ"`, `"EN"` | upper case | no |
| `Conversation.transcript[i].timestamp` | str | **original, never rewritten**: chats `MM:SS`; calls ISO 8601 with zone and fractional seconds | no |
| `...speaker` | `client`, `operator`, `bot`, `system` (unknown kept) | | no |
| `...duplicate` | bool | exact consecutive repeat; left out of the prompt, **index kept** | no |
| `Conversation.facts` | `Facts` | seconds as float | yes (then computed) |
| `Conversation.voice_measurements` | list | pitch in semitones, rate in words/min, pauses and overlap in seconds | empty list |
| `Conversation.audio_url` | never present | secret, stays in B's store | n/a |
| `Criterion.weight`, `ChecklistVersion.rounding`, `order` | | **ignored by C** (arithmetic is B's) | |

The evaluator reads from a criterion only: `title`, `wording`, `answer_type`, `scale_steps[].value/label`,
`na_allowed`, `na_condition`, `kind`, `kinds`, `guidance`, `model`, `fingerprint`; and from the checklist:
`guidance`, `id`, `version`. **No criterion text, weight or scale value is written in Python code.**

## Output conventions (field for field with contract section 7, `Evaluation.results[]`)

`Judgment` carries exactly these contract result fields: `criterion_id`, `answer`, `kinds[]`, `explanation`,
`evidence[]`, `checked_range`, `na_reason`, `confidence`, `needs_review`, `coaching`, plus `model`, `reuse_key`,
`calls[]` (extra, allowed by the contract). B adds `points`, `effective_weight`, `reused`, `carried_decision`,
`final_answer`.

| Field | Type | Rules |
|---|---|---|
| `answer` | `"yes"`, `"no"`, `"na"`, or `{"step": <value>}` | `yes`/`no` only for `yes_no` and `gross_error`; `na` only if `na_allowed`; a step is the step's **value** (e.g. 15), never its position. Internally the model answers `answer:"step"` + `step:int`, mapped to `StepAnswer(step=value)`. |
| `kinds` | list of str | gross-error criterion only; each from `Criterion.kinds` (official: `insult`, `paid_service_outside_company`, `confidential_disclosure`); empty unless answer is `yes` |
| `explanation` | str, Russian | style: «Завершение — Нет. После ответа … Основание — …»; non-empty |
| `evidence[]` | `{message_index:int, quote:str, role}` | `message_index` = 0-based index into the **original** `Conversation.transcript`; `role` `supports` or `expected_here` |
| `checked_range` | `{from:int, to:int}` or null | inclusive message indices; required when an expected action is missing (`expected_here` evidence, or `no` with no evidence) |
| `na_reason` | str or null | required iff answer is `na`; names the N/A condition |
| `confidence` | `low`, `medium`, `high` | `low` forces `needs_review` |
| `needs_review` | bool | set after a failed retry that left only non-fatal problems, or on low confidence |
| `coaching` | str (Russian) or null | for `no` or a non-top step: what to improve + a better wording |
| `DialogInfo` | `{topic, mood_start, mood_end, outcome}` | `topic` Russian, at most 8 words; moods from {спокойный, обеспокоенный, раздражённый, довольный, нейтральный}; `outcome` in {resolved, passed_to_specialists, unresolved, client_left}; never affects the score |
| `cost_usd` | Decimal | USD, 6 decimals; cache writes at input x 1.25, cache reads at input x 0.10; prices from `settings.prices` |

JSON serialisation: `model_dump(mode="json")`; `Decimal` becomes a string, `from_` is emitted as `from`
(`by_alias=True`).

### Evidence-line reference format

A reference is only `message_index` (0-based, original transcript, duplicates keep their index). The UI shows
the original `timestamp` of that message (chat `MM:SS`, call ISO 8601) and, for calls, jumps the audio through
`audio_offsets`. The model never writes timestamps. In the prompt, chat lines show the timestamp as given and
call lines show `+m:ss` from the first line (display only); `[ИМЯ]`-style masking placeholders may appear in a
quote and still match (S5).

### How the official checklist maps on it

Scoring is B's; the evaluator only needs the data shape:

| Official | Evaluator sees |
|---|---|
| 01, 02, 03, 05, 07 (Да/Нет, some with N/A) | `answer_type yes_no`, `na_allowed` + `na_condition` from the seed |
| 04 (levels 0/5/10/15/20, N/A), 06 (0/4/7/10) | `answer_type scale`, `scale_steps[{value,label}]` |
| 08 Грубые ошибки (flag, no points) | `kind gross_error`, `kinds[3]`, `weight 0`; answer `yes` + kinds, or `no` |
| N/A redistribution, half-up rounding to 2 decimals, critical flag not changing the total, test vectors T1 to T4 | B's `app.scoring`; not in C |
| Checklist `guidance` (official p. 3) | rendered once in the cached prompt prefix; part of the reuse key |

A copied checklist with one replaced criterion (the live-swap demo) needs no code change: all wording comes
from the `ChecklistVersion`.

## Languages

RU, KZ and EN dialogues are sent as they are (masked); the system prompt is English, outputs
(`explanation`, `coaching`, `topic`, second-opinion `reasoning`) are Russian. Translation (S11) produces Russian
only (`to=ru`); a RU dialogue returns the original with no call. Masking understands RU, KZ (including the
suffix «Нұрланмын») and EN introductions, and treats `[Имя скрыто]` as a given name.

## Error handling

| Situation | What happens |
|---|---|
| No `ANTHROPIC_API_KEY` | `ModelKeyMissing` before any work (B turns it into 409 `model_key_missing`). `evaluate()` raises only if a call is actually needed. |
| Refusal, `max_tokens`, schema-invalid JSON | `JudgmentFailed("refusal:<cat>" / "max_tokens" / "schema", retryable=False)` |
| Answer invalid after one retry (fatal: answer not allowed, N/A not allowed, step not in scale, kinds) | `JudgmentFailed("invalid_answer", retryable=False)` |
| Evidence wrong after one retry (bad index/quote, missing range) | not an error: bad items dropped, `needs_review=True` |
| 429, 5xx, connection or timeout | `JudgmentFailed("rate_limited" / "server_error" / "connection", retryable=True)`; the SDK already retried 4 times |
| 400, 401/403, 404 | `JudgmentFailed("bad_request" / "auth" / "model_not_found", retryable=False)` |
| Failure inside `evaluate()` | stored in `EvaluatorRun.failures`; the other criteria still return |

The key is never logged or printed; exceptions carry `request_id`, never request bodies.

## Determinism and caching

- `reuse_key = sha256(canonical JSON of {prompt version, model, criterion fingerprint, checklist guidance,
  transcript hash, facts, voice measurements})`, 64 hex chars. Weight, order and `rounding` are not in it.
- Same key means the stored `Judgment` is reused with no call. Changing `PROMPT_VERSION` (any change to the
  system prompt, rendering or masking) invalidates everything on purpose.
- Prompt caching: the checklist context, the transcript and the facts form a stable first block with
  `cache_control: ephemeral`; the per-criterion text is the second block.
- Every call is logged in `c_llm_calls` (purpose, model, tokens, cost, latency, reuse key).

## Configuration (no secrets in code)

The evaluator adds **no settings of its own**. It reads B's `app.settings.get_settings()`:

| Env var | Meaning | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | model key (`SecretStr`), from the Keychain, never in files | none |
| `DEFAULT_MODEL` | `claude-haiku-5-5` unless a criterion sets `model` | `claude-haiku-5-5` |
| `MAX_PARALLEL_CALLS` | semaphore size | 8 |
| `DB_PATH` | SQLite file (`c_llm_calls`, `c_translations`) | `cqa.db` |
| prices | `settings.prices`, USD per 1M tokens | haiku 0.10 / 0.50, sonnet 2.00 / 10.00 |

Fixed in code on purpose (not config): `PROMPT_VERSION`, effort per call kind (`medium` criteria and second
opinion, `low` info and translation), `max_tokens=16000`, SDK `max_retries=4`, `timeout=60`.

---

# Steps

Each step lists: goal, issue, files, interface added, acceptance, and what it must not change. Order matters:
after every step the evaluator package imports and its suite is green.

Branch/PR per issue as in rule 5. Where one issue spans several steps, use one branch and one PR per step
(`c/17-prompt`, `c/17-client`, ...) or one PR for the whole issue; either way each step is green on its own.

## S1: Scaffold, shared-model shim, personal-data masking

- **Goal:** no personal data reaches the model; the package exists and imports.
- **Issue:** #16. **Depends on:** B's skeleton (#3) on `main` (or branch from B's `b/3-...`).
- **Files:** create `evaluator/__init__.py` (empty `__all__`), `_vendor.py` (copy of the shared models block,
  line 1 `# TEMPORARY: delete in S13`), `_compat.py` (try `app.models`, fall back to `_vendor`), `masking.py`;
  tests `evaluator/tests/conftest.py` (`make_conv`), `test_masking.py`. `uv add` nothing yet.
- **Interface added:** `masking.PLACEHOLDERS`, `mask_text(text) -> str`,
  `mask_transcript(messages) -> list[Message]` (same length, order and indices; only `text` changes; input not
  mutated); `conftest.make_conv(lines, *, channel, language, timestamps, duplicates)` with `id="DEV:test"`.
  Every later module imports models from `evaluator._compat` only.
- **Rules:** email, IBAN (`KZ\d{2}...`), card, 12-digit IIN, phone, then names. Names: RU «Меня зовут / Я X»,
  KZ «Мен X(+suffix) / менің атым X», EN «I'm / I am / My name is X»; placeholder `[ИМЯ]`; leave `[Имя скрыто]`
  and non-names («Вам», «AIM», «ноутбука») untouched. Placeholders keep the fact that a name was given
  (criterion 01).
- **Acceptance:** `cd backend && uv run pytest evaluator/tests/test_masking.py -v` passes the notes-plan Task 1
  tests (RU/KZ/EN intros, non-names kept, numbers, email, transcript indices and speakers kept, no mutation).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** nothing exists yet. Do not import `app.models` anywhere except `_compat.py`.

## S2: Prompt rendering

- **Goal:** the prompt is built only from checklist data + computed facts + the masked transcript.
- **Issue:** #17.
- **Files:** `prompt.py`; `evaluator/tests/test_prompt.py`; add `make_criterion`, `make_checklist` to `conftest.py`.
- **Interface added:** `PROMPT_VERSION = "c1"` (bump on any change to prompt, rendering or masking),
  `SYSTEM_PROMPT`, `render_transcript(conv, masked)`, `render_facts(conv)`, `render_checklist_context(checklist)`,
  `render_criterion(checklist, criterion)`, `build_blocks(conv, masked, checklist, criterion) -> [prefix, criterion_block]`
  (prefix has `cache_control: ephemeral` and is identical for all criteria of one dialogue).
- **Behaviour:** line format `[index] offset speaker: text`; duplicates skipped without shifting indices; call
  offsets `+m:ss`; `<transcript>`/`<appeal_comment>` tags inside text neutralised with `‹ ›`; facts include
  `first_reaction_over_3_min`; `voice_measurements:` block only for calls with measurements (reaches every
  criterion); `Allowed answers:` line built from `answer_type`, `scale_steps`, `na_allowed`/`na_condition`,
  `kinds`; the system prompt contains no criterion title, id or weight.
- **Acceptance:** `uv run pytest evaluator/tests/test_prompt.py -v` (tests of notes-plan Task 2).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** S1 functions and signatures; `mask_transcript` output shape.

## S3: Output schemas, client wrapper, cost formula

- **Goal:** one structured Claude call that either returns a validated object or raises `JudgmentFailed`.
- **Issue:** #17 (the fake client also starts #20; the cost formula is shared with #19).
- **Files:** `schemas.py`, `client.py`, `cost.py` (formula only); `evaluator/tests/fakes.py`, `test_schemas.py`,
  `test_client.py`, `test_cost.py`. `uv add anthropic`.
- **First action:** invoke the `claude-api` skill and re-verify item 8 of "Conflicts" (structured output
  parameters, effort values, fallback beta, stop reasons, error classes). Update this file if anything differs.
- **Interface added:** `schemas.CriterionOutput`, `OutEvidence`, `OutRange` (all `extra="forbid"`),
  `json_schema_for(model)`; `client.ModelKeyMissing`, `client.JudgmentFailed`, `get_client()`, `set_client()`,
  `async call_structured(*, purpose, model, effort, system, blocks, output_type, reuse_key=None, max_tokens=16000)
  -> (output, LLMCallRecord)`; `cost.call_cost(model, *, input_tokens, cache_write_tokens, cache_read_tokens,
  output_tokens) -> Decimal`; test fakes `FakeAsyncAnthropic`, `text_response`, `status_error`.
- **Behaviour:** official SDK only; no prefill, no forced tool choice, no `thinking` parameter; error mapping
  table as in "Error handling"; `LLMCallRecord.input_tokens` includes cache write and read tokens.
- **Acceptance:** `uv run pytest evaluator/tests/test_cost.py evaluator/tests/test_schemas.py evaluator/tests/test_client.py -v`
  (notes-plan Task 3, includes refusal, max_tokens, schema, 429, 401, no key).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** S1/S2 names. `JudgmentFailed` signature is final here (`reason, *, retryable, request_id`).

## S4: Reuse keys

- **Goal:** pay for each judgment once.
- **Issue:** #19.
- **Files:** `keys.py`, `evaluator/tests/test_keys.py`; export `reuse_key` from `__init__.py`.
- **Interface added:** `transcript_hash(conv) -> str`; `reuse_key(conv, checklist, criterion, model) -> str`
  (64 hex; inputs as in "Determinism and caching").
- **Acceptance:** `uv run pytest evaluator/tests/test_keys.py -v`: same inputs same key; weight-only change same
  key; fingerprint, model, checklist guidance, transcript text or facts change gives a new key.
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** `PROMPT_VERSION` name and location (S2). The 4-argument signature is shared with B; do not
  reorder.

## S5: Answer checking

- **Goal:** evidence that can be trusted.
- **Issue:** #18.
- **Files:** `checking.py`, `evaluator/tests/test_checking.py`.
- **Interface added:** `Problem`, `FATAL_CODES`, `normalize`, `quote_matches(quote, original, masked)`,
  `check_answer(answer, step, kinds, criterion) -> list[Problem]` (fatal checks only; reused by S10),
  `check_output(out, criterion, conv, masked) -> list[Problem]`. Problem codes (exact): `answer_not_allowed`,
  `na_not_allowed`, `step_not_in_scale`, `kinds_not_allowed`, `kinds_missing`, `index_out_of_range`,
  `quote_mismatch`, `checked_range_missing`, `checked_range_invalid`, `na_reason_missing`, `explanation_missing`.
- **Behaviour:** normalise case, `ё`, punctuation, spaces; a quote may match the original or the masked text
  (`[ИМЯ]`); fuzzy for quotes of 12+ characters (`difflib` first, see Conflicts 7); a step is judged by value
  (`step: 2` on 0/4/7/10 is `step_not_in_scale`).
- **Acceptance:** `uv run pytest evaluator/tests/test_checking.py -v` (notes-plan Task 5 list: exact, case/punct/ё,
  masked, invented, typo, step position, type mismatch, N/A, kinds, index, range, reason, valid output).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** `CriterionOutput` fields (S3). `Problem.code` strings are consumed by S6 and S10.

## S6: `judge_criterion` with one retry

- **Goal:** the core call: one criterion of one dialogue to a checked `Judgment`.
- **Issues:** #17 and #18.
- **Files:** `judge.py`, `evaluator/tests/test_judge.py`; export `ModelKeyMissing`, `JudgmentFailed`,
  `judge_criterion` from `__init__.py`.
- **Interface added:** `async judge_criterion(conv, checklist, criterion, *, model) -> Judgment`;
  `to_judgment(...)`; `EFFORT_CRITERION = "medium"`.
- **Flow:** `get_client()` first (so `ModelKeyMissing` precedes any work), mask, build blocks, call, check; on
  problems one retry with a third block listing them (first two blocks identical, cache kept); still fatal ->
  `JudgmentFailed("invalid_answer")`; otherwise drop the bad evidence items and set `needs_review`; low
  confidence sets `needs_review`; map `step` to `StepAnswer`, `OutRange` to `CheckedRange`. Cost logging is a
  TODO until S7.
- **Acceptance:** `uv run pytest evaluator/tests -v` (notes-plan Task 6: valid first try, retry then ok, still-bad
  evidence flagged, still-invalid raises, low confidence, step mapping, masked text only, no key before any
  call). Runs on the official checklist and on a copy with one replaced criterion (use `make_checklist`).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** S2 to S5 exports; the `Judgment` shape (shared model).

## S7: Cost logging

- **Goal:** know what an evaluation costs.
- **Issue:** #19.
- **Files:** extend `cost.py`; edit `judge.py` (call `log_calls`, remove the TODO); `evaluator/tests/test_cost.py`;
  `db` fixture in `conftest.py`.
- **Interface added:** migration `c_001_llm_calls` via `app.db.register_migration`; `log_calls(records, *,
  conversation, criterion_id)`; `total_cost(records) -> Decimal`. Costs stored as strings.
- **Acceptance:** `uv run pytest evaluator/tests/test_cost.py -v`: rows written; exact sum; a `judge_criterion`
  logs its calls with `conversation == "DEV:test"` and `criterion_id == "c01"`. Re-running unchanged work through
  `reuse_key` caching makes zero calls (covered again in S12).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** `call_cost` signature and results; `judge_criterion` signature and return value.

## S8: Test harness and DEV run script

- **Goal:** test without spending money; run DEV on purpose.
- **Issue:** #20. **Needs:** `checklists/official-chat-v1.json` (stream A), `data/dev.json` (fetched through B).
- **Files:** `devrun.py`, `dev_expectations.json`, `evaluator/tests/recorded/` (3 files), `test_devrun.py`; extend
  `fakes.py` with `from_recorded`; add `runs/` to `.gitignore`.
- **First action:** verify the DEV structure with
  `python3 -c "import json;d=json.load(open('../data/dev.json'));..."` printing only keys, types, speakers and
  timestamp samples, never `audio_url` (expect: records with `conversation_id`, `channel`, `language`,
  `transcript[{timestamp,speaker,text}]`, `audio_url`). Log differences in MISTAKES.md.
- **Interface added:** `Expectation`, `load_dev_conversations(path, group_id="DEV")` (drops `audio_url`, marks
  consecutive duplicates), `load_expectations`, `check_expectations`, `async run(...)`,
  `main(argv) -> int` and the CLI `uv run python -m evaluator.devrun --data ... --checklist ... --model ...
  [--ids] [--criteria] [--expectations-only] [--record DIR] --out runs/<name>.json` (prints per-criterion answers,
  `needs_review` count, failures, total cost; exit 1 on any failed expectation or `JudgmentFailed`).
- **Recording:** only synthetic chats (`p1-ru-014`, `p1-ru-022`, `p1-ru-025`), never `p4-*`; check recorded files
  for `sig=` and `audio_url` before commit.
- **Acceptance:** `uv run pytest evaluator/tests -v` green with no key (CI). Then, once, with a key: the
  `--expectations-only` run on Haiku exits 0 (about 18 calls, about $0.01); write pass count and cost as a
  comment on #20. A failing expectation is fixed in the prompt (bump `PROMPT_VERSION`), not in the expectation,
  unless the team agrees.
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green; `git grep -n "sig="` empty in `evaluator/tests/recorded`
- **Must not change:** any public signature from S1 to S7 (the script only calls them). Bumping
  `PROMPT_VERSION` is allowed and expected.

## S9: Not-scored dialogue information

- **Goal:** topic, moods and outcome on every card (extra B).
- **Issue:** #21 (M2).
- **Files:** `info.py`, additions to `schemas.py` (`InfoOutput`), `__init__.py` export, `test_info.py`.
- **Interface added:** `async dialog_info(conv) -> tuple[DialogInfo, list[LLMCallRecord]]` on
  `settings.default_model`, effort `low`, masked transcript + facts, logs with `criterion_id=None`.
  The schema must not use `maxLength` (the API rejects it; Pydantic validates locally).
- **Acceptance:** `uv run pytest evaluator/tests/test_info.py -v` (maps output, effort low, no `maxLength`,
  `ModelKeyMissing`). Real run: `info` filled for DEV dialogs (record cost in the issue).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** `judge_criterion`, `reuse_key` and the criterion prompt (info must not enter any
  reuse key or score).

## S10: Second opinion on appeals

- **Goal:** advise the reviewer (extra 6); the reviewer still decides.
- **Issue:** #22 (M2).
- **Files:** `second_opinion.py`, `SecondOpinionOutput` in `schemas.py`, `__init__.py` export, `test_second_opinion.py`.
- **Interface added:** `async second_opinion(conv, checklist, criterion, result, comment) ->
  tuple[SecondOpinion, list[LLMCallRecord]]`; model `criterion.model or default_model`; the S2 prefix block is
  reused (cache), plus a third block with the original answer, explanation, evidence quotes and the comment
  inside `<appeal_comment>`; one retry through `check_answer`, then `JudgmentFailed("invalid_answer")`.
- **Acceptance:** `uv run pytest evaluator/tests/test_second_opinion.py -v` (valid, step mapped, comment tag
  injection neutralised, retry, raises twice, no key). Real: second opinion on DEV appeals, appeals still work
  without a key (B maps `ModelKeyMissing`/`JudgmentFailed` to `unavailable`; C never touches the status).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** `check_answer` behaviour (S5), `build_blocks` output for existing callers.

## S11: Translation on demand and its endpoint

- **Goal:** a reviewer who does not read Kazakh can follow a KZ dialogue (extra 5).
- **Issue:** #23 (M4).
- **Files:** `translation.py`, `router.py`, `TranslationOutput` in `schemas.py`, `test_translation.py`,
  `test_router.py`.
- **Interface added:** `async translate(conv, to="ru") -> (list[str], list[LLMCallRecord])` (one string per
  transcript line; RU returns originals with no call; duplicates copy their source line; one retry then
  `JudgmentFailed("translation_incomplete")`); migration `c_002_translations`; `router.router` with
  `GET /conversations/{conversation}/translation?to=ru` returning
  `{"conversation": "<id>", "to": "ru", "messages": [{"message_index": 0, "text": "..."}]}` (contract
  `translation`). Errors: 422 `unsupported_language`, 404 `not_found`, 409 `model_key_missing` (nothing cached),
  502 `model_failed`. A stored translation is returned without a call. Original text is never replaced.
- **Hand-off:** tell B in the PR that `app/main.py` needs the one-line `include_router(evaluator.router.router,
  prefix=settings.base_path)`; C does not edit `main.py`.
- **Acceptance:** `uv run pytest evaluator/tests/test_translation.py evaluator/tests/test_router.py -v`; KZ and
  EN DEV dialogues translate to Russian (manual, one real run).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** `c_001_llm_calls` schema; other routers; the contract `translation` shape.

## S12: The single entry point `evaluate()`

- **Goal:** the whole evaluator usable through one call with consistent types (see "API description").
- **Issue:** none (proposed as an extra checkbox on #17). Can be built as soon as S6 is merged; S9 makes
  `with_info` meaningful. Placed here so earlier steps stay untouched.
- **Files:** `run.py` (`EvaluateOptions`, `JudgmentCache`, `Failure`, `EvaluatorRun`, `evaluate`, an in-memory
  `DictCache` for tests), export from `__init__.py`, `evaluator/tests/test_run.py`, README snippet in
  `evaluator/__init__.py` docstring (not a new .md file).
- **Behaviour:** exactly the six points under "Types added by C". The first criterion runs alone, the rest in
  parallel under the semaphore. `facts` filled via `app.transcript.compute_facts` when `None` (lazy import; if
  B's #8 is not on `main`, leave `facts=None` and render "not computed"). The input `Conversation` is never
  mutated. `mode="full"` ignores the cache but still writes it.
- **Acceptance:** `uv run pytest evaluator/tests/test_run.py -v` covers: official checklist -> 8 results in
  checklist order; second run with a `DictCache` -> `calls == []`, `cost_usd == 0`, `reused` = all ids; a copy
  with one replaced criterion -> only that criterion called; one criterion failing (`JudgmentFailed`) -> others
  returned, `failures` filled; no key and cold cache -> `ModelKeyMissing`; no key and warm cache -> works;
  `criteria=[...]` subset; `with_info=False`; `json.dumps(run.model_dump(mode="json", by_alias=True))` contains
  no `audio_url`; `run.results[i].model_dump(mode="json")` validates against the `contract/` evaluation result
  schema if `contract/` exists (add that check then; otherwise note it in the PR).
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** every earlier export. `evaluate()` must call `judge_criterion`/`dialog_info`, not
  re-implement them; B's job loop keeps working unchanged.

## S13: Switch to `app.models`

- **Goal:** remove the temporary shim once B's models are on `main` (#4; `compute_facts` after B's #8).
- **Issue:** #17 follow-up (notes-plan Task 12). Do it at any time after B's #4 merges.
- **Files:** delete `_vendor.py`; make `_compat.py` a plain `from app.models import ...`; import
  `app.transcript.compute_facts` directly in `devrun.py` and `run.py`.
- **Acceptance:** from `backend/`: `uv run pytest -v` (all streams) green. If a field differs from
  `app.models`, change the evaluator to match `app.models`, not the reverse.
  - [ ] MISTAKES.md read at start / updated if any mistake
  - [ ] common acceptance green
- **Must not change:** any public signature or field name of the evaluator.

---

## Hand-offs to other streams (do not edit their files)

- **B:** `include_router(evaluator.router.router)` (S11). Job loop order: first criterion alone, then the rest in
  parallel (also what `evaluate()` does). `judge_criterion` is passed `model = criterion.model or default_model`.
  Optional: implement `JudgmentCache` on the `judgments` table to use `evaluate()` in jobs.
- **A:** nothing; field names match section 7. If `contract/` examples disagree with "Output conventions", ask A.
- **D:** accuracy runs use `devrun` outputs (`runs/*.json`); prompt changes bump `PROMPT_VERSION` and invalidate
  stored results, so announce them.
