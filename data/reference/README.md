# Reference answers for DEV

`dev_labels.json` holds our reference answers for the 65 DEV dialogs and the 8 criteria of the official checklist: 520 answers. They are our references, not the organisers' ground truth, and the UI must say so.

They were drafted by Claude Opus 5.5 in Claude Code (subscription, no API cost) from the transcripts, then go to the team for review (issue #24). They feed the accuracy report and the model choice (#26).

## Format

```json
{"conversation_id": "p1-ru-003", "criterion_id": "04", "answer": {"step": 10}, "kinds": [],
 "note": "tariff location answered; the commission question was never answered", "disputed": false}
```

- `answer` is `yes`, `no`, `na` or `{"step": value}`, as in the contract.
- `kinds` is filled only for 08 = yes: `outside_paid_service` or `insult`. **These names must match the gross-error kinds in the official seed (#5)**; rename here if the seed uses others.
- `note` is a short reason with short quotes. A tag in brackets, such as `[07a]`, names the rule below that decided the answer, so a rule change can be applied to every label it touches.
- `disputed: true` marks an answer that depends on an open interpretation question or on audio we have not checked yet.
- The file has no signed URLs. Check for `sig=` before every commit.

## Rules used (proposal for #25)

These are the readings applied to every dialog. The official `wording` stays verbatim; the agreed rules go into each criterion's `guidance` in the seed.

| Tag | Criterion | Rule | Labels it decides |
|---|---|---|---|
| 01 | 01 | Yes needs a greeting and the operator's name (or self-introduction) in the operator's first message. An informal greeting with no name is No. On calls `[Имя скрыто]` counts as the name. | 5 No |
| 01c | 01 | Calls: when the first operator line is garbled and shows no greeting or no name, answer No with low confidence and check the recording. | p4-ru-002, p4-ru-005 (disputed) |
| 02a | 02 | N/A when the client's messages, including those to the bot, already hold what is needed and the answer uses them. Yes when something was missing and the operator asked for it before answering. No when the operator asks for what the client already wrote, or answers on a guess. | 42 N/A |
| 03a | 03 | The client declines identification, or the protected action is deferred, and nothing account specific is disclosed: N/A. Alternative reading: Yes. | p1-ru-002, p4-ru-005 (disputed) |
| 03b | 03 | Any account specific fact stated before identification is No, even if the operator says no check is needed. | ru-009, kz-015, en-014 |
| 04a | 04 | A wrong first suggestion that is corrected, with the request then fully resolved, keeps 20. The misstep is scored in 02 and 06. | ru-016, kz-005, en-015 |
| 06 | 06 | 4: the client has to re-ask or re-explain because of a wrong, vague or off-target reply. 7: one noticeable slip (the operator asks once for something already given) and the dialog goes on. 0: contradictory replies make the course unclear. | 15 at 4, 5 at 7, 1 at 0 |
| 06t | 06 | First reaction over 3 minutes after the handover, or an unwarned wait over 3 minutes, caps 06 at 7. No DEV chat crosses it: the slowest first reaction is 134 s and the longest wait 132 s. | none in DEV |
| 07a | 07 | Read strictly: Yes needs a summary or next step, or an offer of more help, **and** a goodbye. A bare thanks and goodbye ("Пожалуйста. Хорошего вечера!", "Glad you got in. Have a good day!") is No. A closing that waves away an open question is No. | 34 No |
| 07b | 07 | N/A when the client leaves, the connection drops, or the client hangs up right after their last line, before the operator could close. The operator closing the chat with no goodbye is No. | 7 N/A |
| 08a | 08 | Telling an unverified client about their own account is a 03 failure, not a gross error. Gross "confidential disclosure" is reserved for other people's data, internal information or credentials. Alternative reading: Yes. | ru-009, kz-015, en-014 (disputed) |

The biggest single decision is **07a**: 34 of the 46 No answers on 07 come from it. If the team reads 07 leniently, flip every label tagged `[07a]` that has a bare goodbye to Yes.

## Disputed (10)

| Dialog | Criterion | Why |
|---|---|---|
| p1-ru-002 | 03 | rule 03a |
| p1-ru-025 | 02 | operator asked "С чем помочь?" for the missing request, so Yes by the wording; the design's worked example uses N/A |
| p1-kz-014 | 04, 06 | "Иә, ... ағылшын тілінде беріледі": "Иә" may answer the Kazakh question (contradiction) or confirm the bot (no problem) |
| p1-ru-009, p1-kz-015, p1-en-014 | 08 | rule 08a |
| p4-ru-002 | 01 | no greeting in the transcript; check the audio |
| p4-ru-005 | 01 | name not recognisable in the transcript; check the audio |
| p4-ru-005 | 03 | rule 03a |

## Planted violations (design section 4)

Every one is reflected: no greeting or name (01 No: ru-014, kz-008, en-015); account details before identification (03 No: ru-009, kz-015, en-014); private paid offers and money to a personal card (08 Yes: ru-022, ru-023, kz-013, en-013); the insult (08 Yes: ru-029); wrong or contradictory answers (ru-018 04 = 0 and 06 = 0; kz-014 disputed); ignored follow-up questions (04 = 10: ru-003, ru-007, en-007); ignoring what the client wrote (02 No: ru-026); vague instructions fixed after a re-ask (06 = 4: ru-005, kz-005); closed without a goodbye (07 No: ru-018, ru-026, kz-005); client left or connection lost (07 N/A: ru-025, ru-012, kz-011, en-009).

## Totals with these answers

Using the official procedure (N/A weight redistributed, half up rounding to two decimals): mean 81.36, 12 of 65 dialogs at 100.00, lowest p1-ru-018 at 12.50. Five dialogs carry the gross-error flag.
