# Five-minute live demo

Prerequisites: use the frozen integrated commit and the checks in RUNBOOK.md.
Have a labelled saved real-model run ready. UI click labels below follow the
agreed design; verify them against the built UI during rehearsal. No timed
rehearsal has been completed yet.

| Time | Presenter actions | What to verify/show | If unavailable |
|---|---|---|---|
| 0:00–1:00 | Open the DEV queue, filter a language/channel, open `p1-ru-010`. | Transcript, criterion answers, total and original messages. State that inference runs locally. | Open the labelled saved DEV run; do not call it live evaluation. |
| 1:00–1:40 | Open `p1-ru-022`; select the gross-error result, then its evidence. | Gross-error flag and the exact supporting line. | Highlight the line manually and disclose the jump failure. |
| 1:40–2:15 | Open `p1-ru-025`, inspect applicability and scoring. | Demonstrate N/A only on a confirmed N/A criterion. Its c02 interpretation is disputed, so do not promise c02 will show N/A. Select a team-reviewed alternative during rehearsal if needed. | Show another reviewed N/A result, clearly naming that dialog. |
| 2:15–3:00 | Open `p4-ru-001`; play, seek and click an evidence line. | Audio from our origin and the measured start, with alignment status stated accurately. Show the calls checklist only if its seed and measurements are integrated. | Show transcript/evidence and manual playback. Automatic alignment remains unverified. |
| 3:00–4:00 | As **Контролёр**, appeal a criterion; switch to **Проверяющий**, inspect evidence/second opinion and record a reasoned decision. | Before/after answer and recalculated total, with an audit trail. Suggested rehearsal case: `p1-ru-001`, c07, which remains disputed until team interpretation is agreed. | Decide from the evidence if the second opinion is pending; explain that it is pending. |
| 4:00–5:00 | In **Чек-листы**, copy the checklist, replace a criterion, save a new version; dry run, evaluate and open comparison. | Admin-created criterion, new ID/definition, selective rerun and changed result/total. | Show the live dry run plus a clearly labelled rehearsal comparison if inference exceeds the remaining time. |

Do not edit source code during the criterion swap. Do not change published
versions in place. The fixed DEV reference set is not evidence that arbitrary
new criteria are accurate. If asked about model choice, show measured local
benchmarks only; the 140 GB memory ceiling is a deployment constraint, not proof
of fit or speed. The emotion-head smoke results are pipeline checks, not demo
quality scores.

After rehearsal, record the actual time and failures in RUNBOOK.md, attach
redacted evidence to the relevant issue, and update the chosen N/A/appeal cases.
