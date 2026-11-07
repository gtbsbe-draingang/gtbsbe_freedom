# Reference answers for DEV

`dev_labels.json` holds our reference answers for the 65 DEV dialogs and the 8 criteria of the official checklist (`official-chat` v1, criteria `c01` to `c08`): 520 answers. They are our references, not the organisers' ground truth, and the UI says so.

These are draft labels from the transcripts, not human-reviewed ground truth. Team review is still pending (Task 8, issue #24). All 520 labels need review, including the 479 not currently marked disputed. They support the provisional accuracy report and model comparison (#26); they do not yet establish evaluator accuracy.

## Format

```json
{"conversation_id": "p1-ru-003", "criterion_id": "c04", "answer": {"step": 10}, "kinds": [],
 "note": "Где тариф, ответил [#12]; вопрос о комиссии [#13] остался без ответа.", "disputed": false}
```

- `answer` is `yes`, `no`, `na` or `{"step": value}`, as in the contract.
- `kinds` is filled only for `c08` = yes: `insult`, `paid_service_outside_company` or `confidential_disclosure`.
- `note` is Russian, at most 200 characters, cites lines as `[#index]` (the index in the transcript) and quotes at most 60 characters in «». No links.
- `disputed: true` marks an answer whose reading the team has not settled. Disputed labels are left out of the agreement and counted separately. The four #25 questions are now settled in the seed (below); three labels remain disputed.

Check it from `backend/`:

```sh
uv run python -m quality.reference_tools validate ../data/reference/dev_labels.json --seed ../checklists/official-chat-v1.json --dev ../data/dev.json
uv run python -m quality.reference_tools export-csv ../data/reference/dev_labels.json /tmp/labels.csv   # for the review
uv run python -m quality.reference_tools import-csv /tmp/labels.csv ../data/reference/dev_labels.json
uv run pytest tests/quality
```

## Readings applied (#25)

The four #25 questions are written into the official seed as per-criterion `guidance` that starts with «Уточнение команды: ». The official `wording` is unchanged. Guidance is part of the criterion fingerprint, so evaluations made before this change are not reused. The team can still overrule any of these; if it does, change the seed guidance and these labels together.

| Question | Decision (in the seed) | Labels it touches |
|---|---|---|
| (1) c07 | A polite goodbye after the client has confirmed the answer or the fix is Yes: the confirmed answer is the summary. No when there is no goodbye, or the goodbye leaves a client question or complaint unanswered. | 34 labels move from disputed No to Yes |
| (2) c03 | Identification declined or deferred, no account data disclosed and no protected action: N/A. Data disclosed or an action taken without verification: No. | p1-ru-002, p4-ru-005 stay N/A, no longer disputed |
| (3) c06 | The official checklist excludes the 3-minute first-reaction threshold, so response time alone never lowers the level. Only an explicit wait without a warning blocks level 10. | none |
| (4) c01 on calls | The first reply is the operator's first line after joining. Judge from the transcript text: the greeting and the introduction (a name or `[Имя скрыто]`) must both be readable; if either is missing, No. | p4-ru-002, p4-ru-005 stay No, no longer disputed |

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

## Planted violations

`backend/quality/planted.py` lists them (design section 4, plan Task 8); `tests/quality/test_planted.py` checks that every one matches this file. All 26 match.

## Totals with these answers

Using the official procedure (N/A weight redistributed, half up rounding): mean 85.21, 40 of 65 dialogs at 100.00, lowest `p1-ru-018` at 12.50 (after the #25 decisions; before them: mean 81.36, 12 at 100.00). Eight dialogs carry the gross-error flag.
