# Reference answers for DEV

`dev_labels.json` holds our reference answers for the 65 DEV dialogs and the 8 criteria of the official checklist (`official-chat` v1, criteria `c01` to `c08`): 520 answers. They are our references, not the organisers' ground truth, and the UI says so.

They were drafted by Claude Opus 5.5 in Claude Code (subscription, no API cost) from the transcripts, following stream D plan Task 2, and now go to the team for review (Task 8, issue #24). They feed the accuracy report and the model choice (#26).

## Format

```json
{"conversation_id": "p1-ru-003", "criterion_id": "c04", "answer": {"step": 10}, "kinds": [],
 "note": "Где тариф, ответил [#12]; вопрос о комиссии [#13] остался без ответа.", "disputed": false}
```

- `answer` is `yes`, `no`, `na` or `{"step": value}`, as in the contract.
- `kinds` is filled only for `c08` = yes: `insult`, `paid_service_outside_company` or `confidential_disclosure`.
- `note` is Russian, at most 200 characters, cites lines as `[#index]` (the index in the transcript) and quotes at most 60 characters in «». No links.
- `disputed: true` marks an answer that depends on an open question of #25, numbered as in the plan: (1) `c07` goodbye without a summary or offer of help, (2) `c03` when identification is declined or deferred, (3) the 3-minute threshold in `c06`, (4) the first reply on a garbled call. Disputed labels are left out of the agreement and counted separately.

Check it from `backend/`:

```sh
uv run python -m quality.reference_tools validate ../data/reference/dev_labels.json --seed ../checklists/official-chat-v1.json --dev ../data/dev.json
uv run python -m quality.reference_tools export-csv ../data/reference/dev_labels.json /tmp/labels.csv   # for the review
uv run python -m quality.reference_tools import-csv /tmp/labels.csv ../data/reference/dev_labels.json
uv run pytest tests/quality
```

## Readings applied (input for #25)

| Question | Reading used in the draft | Labels it touches |
|---|---|---|
| c01 | Yes needs a greeting and the operator's name in the first operator message. An informal greeting with no name is No. On calls `[Имя скрыто]` counts as the name. | 5 No (ru-014, kz-008, en-015, two calls) |
| (4) c01 on calls | A garbled first line with no visible greeting or name: No, disputed, to be checked against the recording. | p4-ru-002, p4-ru-005 |
| c02 | N/A when the client's messages, including those to the bot, already hold what is needed and the answer uses them. Yes when something was missing and the operator asked first. No when the operator asks for what the client already wrote, or answers on a guess. | 42 N/A |
| (2) c03 | Identification declined or deferred, nothing account specific disclosed: N/A, disputed. Other reading: Yes. | p1-ru-002, p4-ru-005 |
| c03 and c08 | An account fact told to an unverified client is c03 No **and** c08 Yes `confidential_disclosure`, as the plan's planted list expects. c08 gives no points, so this flags the dialog without counting twice. | ru-009, kz-015, en-014 |
| c04 | A wrong first suggestion that is corrected, with the request then resolved, keeps 20; the slip is scored in c02 and c06. | ru-016, kz-005, en-015 |
| c06 | 4: the client has to re-ask or re-explain because of a wrong, vague or off-target reply. 7: one slip, such as asking once for something already given. 0: contradictory replies. | 15 at 4, 5 at 7, 1 at 0 |
| (3) c06 | Over 3 minutes to the first reaction, or an unwarned wait over 3 minutes, would cap c06 at 7. No DEV chat crosses it (slowest first reaction 134 s, longest wait 132 s), so no label depends on it. | none |
| (1) c07 | Read strictly: Yes needs a summary or next step, or an offer of more help, **and** a goodbye. A bare thanks and goodbye is No, disputed. A closing that waves away an open question is No. | 34 disputed No |
| c07 | N/A when the client leaves, the line drops, or the client hangs up right after their own last line. The operator closing the chat with no goodbye is No. | 7 N/A |

Question (1) is the biggest: if the team reads `c07` leniently, the 34 disputed `c07` No labels become Yes.

Two more are disputed because the text itself is ambiguous: `p1-ru-025` `c02` (the operator asked «С чем помочь?», which is Yes by the wording; the design's example uses N/A) and `p1-kz-014` `c04` and `c06` («Иә» may answer the Kazakh question, which would be a contradiction, or confirm the bot).

## Planted violations

`backend/quality/planted.py` lists them (design section 4, plan Task 8); `tests/quality/test_planted.py` checks that every one matches this file. All 26 match.

## Totals with these answers

Using the official procedure (N/A weight redistributed, half up rounding): mean 81.36, 12 of 65 dialogs at 100.00, lowest `p1-ru-018` at 12.50. Eight dialogs carry the gross-error flag.
