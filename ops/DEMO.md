# Five-minute live demo

The brief (guide p. 4) fixes the order: 1 min interface and dialogue, 2 min evaluation (reasoning,
jump to the line, N/A, total), 1 min appeal to decision to new total, 1 min changed criterion
applied. Inside each block the strongest point goes first (#74): verified quotes and exact
scoring, the Dynamics form, the appeal with a second opinion, the versioned re-run whose
weight-only dry run makes zero model calls.

**Before:** the frozen commit from a clean clone (RUNBOOK.md), DEV imported and evaluated with the
real model (not the mock: the UI must not show «демо-оценка»), browser at 1400 px, a second tab
with `dynamics-mock.html`. Model: Claude Haiku 5.5 through the Claude API; never call it local.
The numbers below come from the 7 November DEV run; check them on the demo database during the
rehearsal and update this file if they differ.

| Time | Do | Say / show | If it fails |
|---|---|---|---|
| 0:00–0:20 | Open the `dynamics-mock.html` tab: CQA inside a mock Dynamics form, 600 px column, strict CSP. | "Это уже компонент формы Dynamics 365: статические файлы, строгий CSP, контекст из формы." | Skip; slide 05 has the screenshot. |
| 0:20–1:00 | Main tab: queue, filter RU, open `p1-ru-010`. | Transcript with bot and system lines as context, facts panel ("не влияет на оценку"), the model name and the cost per evaluation. | Open any other evaluated chat. |
| 1:00–1:40 | In `p1-ru-010`, click a criterion's evidence link. | The quoted line is highlighted: every quote is checked against the transcript before it is shown. Points, weight and the total next to it. | Point at the line and its number by hand. |
| 1:40–2:15 | Open `p1-ru-025`. | c03, c04 and c07 are N/A; their weight goes to the applicable criteria and the total is 100.00. Do not promise N/A on c02 there (disputed, #25). | Explain with slide 04's worked example. |
| 2:15–2:40 | Open `p1-ru-022`. | Gross error (money to a personal card): the flag is separate and does not change the total (25.63). | Show the c08 row and its evidence. |
| 2:40–3:00 | Open `p4-ru-001`, click an evidence line. | The player jumps to the moment in the recording, streamed through our backend; checked by ear on 30 lines, 28 within about 2 s (#28). | Skip the call; show the transcript and play the recording by hand. |
| 3:00–4:00 | Open `p1-ru-026`. Role **Контролёр**: appeal c04 (the model gave 5) with "ответа по существу нет". Role **Проверяющий**: read the second opinion, set 0 with a reason. | The total goes from 26.25 to 20.00 (16 of 80 applicable points); the old and new answer and the decision stay in the history. | If the second opinion is still running, decide from the evidence and say it is pending. |
| 4:00–5:00 | **Чек-листы**: copy the official checklist; change only a weight and run the dry run (0 model calls); then replace one criterion, apply to a few chats, open the comparison. | Only the changed criterion is re-asked; everything else is reused by fingerprint. Before and after totals side by side. | Show the dry run, then a labelled saved comparison. |

Do not edit source code or a published version during the swap. The reference agreement
(80.66% on 517 labels, `data/reference/agreement-dev-2026-11-07.json`) is agreement with our own draft answers,
not with the organisers; say so if it comes up.

## Rehearsal

Not done yet. Run the table end to end with a timer on the frozen commit, write each step's real
time and every failure into the rehearsal record in RUNBOOK.md, and fix this file.

`node test/e2e/run.mjs dynamics` (from `web/`, with `CHROME=<path>` on Windows) passed on main `77bebda`: the UI inside the mock Dynamics form, 0 CSP violations. In mock mode it reads `data/dev.json` and
`data/audio/`, which are never committed, so copy them in locally first. Rerun it after every `web/dist` rebuild.
