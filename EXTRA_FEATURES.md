# Extra features

Everything in this file goes **beyond what the CQA task requires**. The required scope is set by the task guide (`CQA_Hackathon_Student_Guide_v3.pdf`) and the official checklist (`CQA_Chat_Quality_Checklist 1.pdf`).

None of these extras changes the official score. The official checklist stays the default, word for word, with its own rules and rounding.

Agreed on 2026-11-07.

## A. Our own checklist for calls: «Звонки»

- The 8 official criteria with wording adapted for voice ("in the first reply" becomes "at the start of the call"), plus a 9th criterion: **Интонация и темп речи**.
- Intonation is scored from measured signs, not by listening. The operator's parts are cut out of the recording using the transcript timestamps. For each part we measure pitch range, speaking rate, pauses and talking over the client. Claude turns these numbers into a score on the scale and links each finding to the moment in the audio.
- Limits: the recordings are mono phone audio, the operator's parts are separated only approximately, and DEV has only 5 calls to calibrate on. The UI presents the result as "measured signs + model judgment".
- Claude only: the Claude API does not accept audio, so the measuring is done in our own code.

## B. Information that doesn't affect the score

Shown on every card, for chats and calls:

- the topic of the request
- the client's mood at the start and at the end
- the outcome: resolved, passed to specialists, unresolved, or the client left
- the first-reaction time after the handover, calculated in code and checked against the checklist's 3-minute threshold

## 1. Before/after comparison of checklist versions

- Every criterion result is stored with a fingerprint: the criterion definition (text, answer type, scale, N/A rule), the transcript, and the model.
- Saving a changed checklist creates a new version. The old version and its results stay untouched.
- The user chooses which dialogs to apply the new version to: the control set, DEV, or a selection. Never all dialogs by default.
- Only what changed is re-run:
  - unchanged criteria reuse their stored answers, with no model call
  - a new or reworded criterion, or a changed scale or N/A rule, gets one model call per dialog for that criterion only
  - a weight-only change needs no model call; totals are recalculated in code
- The comparison screen shows a summary ("12 of 40 dialogs changed, average −3.5") and a table of dialog, old total, new total and change. Clicking a row opens the card with both versions side by side.
- Reusing answers keeps the comparison clean: borderline answers on untouched criteria can't flip at random, so every difference comes from the change itself.
- A separate, explicit "re-evaluate everything" action exists for when the model or prompts change.

## 2. Accuracy report

- DEV gets reference answers for every criterion, drafted with Opus in Claude Code (subscription, no API cost) and reviewed by us.
- The app's evaluator is measured against them: agreement per criterion, per language and per channel.
- Shown in the UI. Also used to choose between Haiku 5.5 and Sonnet 5.5 for the app, criterion by criterion.

## 3. Coaching for the operator

For every failed criterion: what to improve, plus a better way to phrase the exact reply that failed. Produced in the same model call as the criterion result.

## 4. Analytics view

Results grouped by criterion, language and channel: which criteria fail most, how many critical errors there are, and where they occur. There is no per-operator view: the data has no operator IDs (names appear in chat greetings but are hidden in calls).

## 5. Translation toggle

KZ and EN transcripts and evidence can be shown translated, for a reviewer who doesn't read the language. The original text always stays visible alongside.

## 6. Second opinion on appeals

When an appeal arrives, the model re-reads the disputed criterion together with the operator's comment and suggests a decision with its reasoning. The reviewer still makes and records the decision.

## 7. Call player linked to the transcript

While the recording plays, the current line is highlighted. Clicking a line jumps the audio to it. The link between transcript time and audio time is calibrated, because the recordings are paused during the phone menu.

## 8. Hiding personal data before it goes to the model

Phone numbers, card and account numbers, and names are masked before the transcript is sent to Claude. The original stays in our storage and in the UI.

## 9. Export to Excel/CSV

Results per dialog and per criterion, plus the total and the critical-error flag, ready for a supervisor.

## Deliberately not doing

- live scoring during a chat
- real logins (the task says none are needed; a role switcher stands in)
- a real Dynamics 365 deployment (the task asks only for a structure that can be adapted)
