# Reference answers for DEV

`dev_labels.json` holds our reference answers for the 65 DEV dialogs and the 8 criteria of the official checklist (`official-chat` **v2**, criteria `c01` to `c08`): 520 answers. They are our references, not the organisers' ground truth, and the UI says so.

These are draft labels from the transcripts, not human-reviewed ground truth. Team review is still pending (Task 8, issue #24). All 520 labels need review, including the 479 not currently marked disputed. They support the provisional accuracy report and model comparison (#26); they do not yet establish evaluator accuracy.

## Format

```json
{"conversation_id": "p1-ru-003", "criterion_id": "c04", "answer": {"step": 10}, "kinds": [],
 "note": "Где тариф, ответил [#12]; вопрос о комиссии [#13] остался без ответа.", "disputed": false}
```

- `answer` is `yes`, `no`, `na` or `{"step": value}`, as in the contract.
- `kinds` is filled only for `c08` = yes: `insult`, `paid_service_outside_company` or `confidential_disclosure`.
- `note` is Russian, at most 200 characters, cites lines as `[#index]` (the index in the transcript) and quotes at most 60 characters in «». No links.
- `disputed: true` marks an answer whose reading the team has not settled. All 41 disputed labels remain excluded: 38 affected by the unapproved #25 interpretations and three other ambiguous labels. Publishing a version does not constitute team approval.

Check it from `backend/`:

```sh
uv run python -m quality.reference_tools validate ../data/reference/dev_labels.json --seed ../checklists/official-chat-v2.json --dev ../data/dev.json
uv run python -m quality.reference_tools export-csv ../data/reference/dev_labels.json /tmp/labels.csv   # for the review
uv run python -m quality.reference_tools import-csv /tmp/labels.csv ../data/reference/dev_labels.json
uv run pytest tests/quality
```

## Proposed Readings (#25)

The four #25 questions are published as a new immutable version, `checklists/official-chat-v2.json`: v1 with per-criterion `guidance` that starts with «Уточнение команды: » on c01, c03, c06 and c07. v1 stays exactly as published, and a database that already holds v1 keeps it; startup adds v2 next to it. The official `wording` is unchanged. Guidance is part of the criterion fingerprint, so v1 judgments of those four criteria are not reused for v2 (the other four can be). The labels are for v2, and the accuracy report defaults to v2. The app's default checklist is still v1 (`DEFAULT_CHECKLIST_VERSION` in `backend/app/settings.py`); moving it to v2 is stream B's call. If the team overrules a decision, publish v3 and relabel; never edit a published version.

These are proposals, not approved scoring policy. Keep #25 open and all 38 affected labels disputed until the team decides. To populate the report, explicitly evaluate DEV with `checklist_id=official-chat, version=2`; existing v1 evaluations never count toward this v2 report. All 520 labels still require human review under #24.

| Question | Proposal (in v2, pending approval) | Labels it touches |
|---|---|---|
| (1) c07 | A polite goodbye after the client has confirmed the answer or the fix is Yes: the confirmed answer is the summary. No when there is no goodbye, or the goodbye leaves a client question or complaint unanswered. | 34 proposed Yes labels stay disputed |
| (2) c03 | Identification declined or deferred, no account data disclosed and no protected action: N/A. Data disclosed or an action taken without verification: No. | p1-ru-002, p4-ru-005 stay disputed N/A |
| (3) c06 | The official checklist excludes the 3-minute first-reaction threshold, so response time alone never lowers the level. Only an explicit wait without a warning blocks level 10. | none |
| (4) c01 on calls | The first reply is the operator's first line after joining. Judge from the transcript text: the greeting and the introduction (a name or `[Имя скрыто]`) must both be readable; if either is missing, No. | p4-ru-002, p4-ru-005 stay disputed No |

Other readings used in the draft:

| Criterion | Reading | Labels it touches |
|---|---|---|
| c01 | Yes needs a greeting and the operator's name in the first operator message. An informal greeting with no name is No. | 3 planted No (ru-014, kz-008, en-015) |
| c02 | N/A when the client's messages, including those to the bot, already hold what is needed and the answer uses them. Yes when something was missing and the operator asked first. No when the operator asks for what the client already wrote, or answers on a guess. | 42 N/A |
| c03 and c08 | An account fact told to an unverified client is c03 No **and** c08 Yes `confidential_disclosure`, as the planted list expects. c08 gives no points, so this flags the dialog without counting twice. | ru-009, kz-015, en-014 |
| c04 | A wrong first suggestion that is corrected, with the request then resolved, keeps 20; the slip is scored in c02 and c06. | ru-016, kz-005, en-015 |
| c06 | 4: the client has to re-ask or re-explain because of a wrong, vague or off-target reply. 7: one slip, such as asking once for something already given. 0: contradictory replies. | 15 at 4, 5 at 7, 1 at 0 |
| c07 | N/A when the client leaves, the line drops, or the client hangs up right after their own last line. The operator closing the chat with no goodbye is No. | 7 N/A |

Three labels stay disputed because the text itself is ambiguous: `p1-ru-025` `c02` (the operator asked «С чем помочь?», which is Yes by the wording; the design's example uses N/A) and `p1-kz-014` `c04` and `c06` («Иә» may answer the Kazakh question, which would be a contradiction, or confirm the bot). They stay out of the agreement until the team review (#24).

All 520 labels still need the team review (#24). New admin-created criteria need their own reviewed labels.

## Measured agreement: the 7 November DEV run

`agreement-dev-2026-11-07.json` compares the 65-dialogue run of 7 November (PR #60: Claude Haiku 5.5, official checklist v1, 613 calls, 0 failures, $0.2685) with these labels, using the same code as `/api/reports/accuracy`. It is agreement with our own draft references, not with the organisers' ground truth.

| | Agreement | Labels |
|---|---|---|
| **Overall** | **79.75%** | 479 (41 disputed excluded, 0 missing) |
| c01 Установление контакта | 93.65% | 63 |
| c02 Выявление потребности | 70.31% | 64 |
| c03 Идентификация | 68.25% | 63 |
| c04 Консультация | 68.75% | 64 |
| c05 Эмпатия | 92.31% | 65 |
| c06 Ведение диалога | 68.75% | 64 |
| c07 Завершение | 80.65% | 31 |
| c08 Грубые ошибки | 95.38% | 65 |
| RU / KZ / EN | 79.15% / 81.82% / 79.09% | 259 / 110 / 110 |
| Chats / calls | 81.26% / 61.11% | 443 / 36 |

The run was graded on v1 and the labels are for v2. v2 only adds guidance on c01, c03, c06 and c07, and every label that guidance affects is disputed, so the undisputed labels mean the same under both.

Planted violations: the run catches 21 of 25. It misses both planted confidential disclosures as gross errors (`p1-kz-015`, `p1-en-014`: it marks c03 No but c08 No), scores `p1-ru-026` c04 at 5 instead of 0, and answers `p1-kz-011` c07 No instead of N/A.

On the disputed labels the model sides with the #25 proposals: c07 Yes on 32 of the 34 bare goodbyes, c01 No on both call openings, c03 N/A on one of the two.

`review-2026-11-07.csv` is the review sheet: the 97 disagreements first, then the 41 disputed labels, each with our note and the model's explanation and empty `decision` and `reviewer` columns. Reviewing those 138 rows first is the fastest way through #73; the other 382 labels already agree with the model, which makes them likely but not certainly right.

## Planted violations

`backend/quality/planted.py` lists them (design section 4, plan Task 8); `tests/quality/test_planted.py` checks that every one matches this file. All 25 match.

## Totals with these answers

Including the disputed proposed answers and using the official procedure: mean 85.21, 40 of 65 dialogs at 100.00, lowest `p1-ru-018` at 12.50. These are provisional draft totals, not validated accuracy or approved #25 decisions. Eight dialogs carry the gross-error flag.
