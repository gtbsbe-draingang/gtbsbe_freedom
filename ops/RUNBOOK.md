# Control-set runbook

Owner: the person presenting the demo. Record the frozen commit, checklist
versions, exact local model IDs and run time before the rehearsal. Never push
directly to `main`; submit feature branches and draft PRs for review.

## Before the control set arrives

1. Start from a clean clone of the integrated demo commit. Build/install steps
   must follow that commit's README. Confirm the committed `web/dist` opens
   without Node and the API and local inference servers are reachable.
2. Confirm the evaluator uses only local endpoints. The older plans mentioning
   hosted model API keys are superseded. Download weights in advance, record
   their revision/quantization, and check offline inference before the demo.
3. Inventory the actual GPU devices and memory with `nvidia-smi`. The limit is
   **140 GB aggregate VRAM**, with a target peak of at most 120 GB to leave
   headroom. Verify each GPU separately; aggregate memory is not automatically
   pooled. Run the chosen context length and concurrency under load. Reduce
   concurrency/context or change model placement if any device runs out of
   memory. Do not switch to a hosted provider as an automatic fallback.
4. Configure the organizer source privately on the backend. Never put signed
   organizer/player URLs into Git, screenshots, browser config, logs or issues.
   Confirm the UI receives only our relative audio endpoint.
5. Import DEV; verify 65 conversations (60 chats and 5 calls), with RU/KZ/EN
   counts 35/15/15. Confirm the official seed has c01–c08 and exact published
   wording/scales. Build the calls draft from that seed, validate it with A's
   loader, and publish it through the checklist flow.
6. Evaluate DEV with the actual local model. Verify `source=model`, job completion,
   required result fields and evidence indices. Inspect the accuracy report's
   `n`, `missing` and `disputed_excluded`; a null agreement or a mock run is not
   a model benchmark. Team review of the 520 draft labels is still required.
7. Play and seek all five calls in the browser. Independently annotate spoken
   starts and compare evidence jumps against the two-second target. Current
   Whisper diagnostics achieve only 71% on 137 matched lines and do not satisfy
   acceptance. Do not present the offsets as verified until this is fixed.
8. Confirm voice measurements are stored and the calls checklist can evaluate
   them. Unknown overlap is null; approximate pitch/rate are not emotion labels.
   Missing/uncertain evidence calls for review. N/A applies only when the
   configured criterion's applicability condition is met.
9. Run a dry run, rehearse the criterion swap below twice and time the complete
   five-minute demo. Record every failed step and its owner in the rehearsal log.

## When the control set arrives

1. In the import screen, enter the organizer-provided `group_id`. Import it and
   check the returned counts; keep group IDs separate from DEV even when raw
   conversation IDs repeat. If the API is unavailable, use the organizer-provided
   JSON upload flow. Do not invent a replacement control set.
2. Select the official checklist/version and the imported group. Run the dry run;
   check the number of model calls and reused results. Then start evaluation.
3. Monitor the job. For failures, inspect the redacted error code, correct the
   cause and use the job retry action (`POST /jobs/{id}/retry` in the agreed
   contract). Never count queued/failed items as completed evaluations.
4. Spot-check at least three dialogs, including one call: answer, scale value,
   evidence line/quote, N/A condition, total, gross-error flag and audio jump.
5. Evaluate the calls checklist on calls. If audio-dependent evidence is missing,
   mark the affected result for review; do not claim all scores are unaffected.
6. Use the integrated snapshot/export command from B's README (#15). Strip
   organizer URLs and do not include recordings. Open a PR with the frozen
   snapshot and its validation results. Do not push to `main`.

## Criterion-swap drill: UI only

1. Open **Чек-листы**, select the official checklist and choose **Сохранить как
   новый чек-лист**. Keep the original version unchanged.
2. Replace one criterion with the organizer's request. Check its new ID, wording,
   yes/no or scale answers, allowed values, weight and N/A condition. Admins can
   create arbitrary criteria; there is no fixed eight-criterion evaluation path.
3. Save/publish the new version. Run a dry run on the same group: the changed
   criterion must rerun, and unchanged criteria may reuse results only when their
   full reuse key still matches. A model/guidance change must invalidate reuse.
4. Run, open the old/new comparison and inspect the changed criterion's evidence
   and recalculated total. Explain any score delta using the saved definitions.
5. Confirm `/reports/accuracy` does not reuse official-v1 DEV references for the
   custom checklist. New criterion quality requires a separate reviewed set.

## Failure handling

| Failure | Action and honest fallback |
|---|---|
| Organizer API unavailable | Import only organizer-provided JSON; show the previously imported DEV set as DEV. |
| Local inference unavailable/OOM | Check local server health, per-device memory and concurrency; retry failed items. Use a labelled saved real run for demonstration. |
| Malformed or unsupported model answer | Keep the item failed/needs review; inspect schema and evidence validation, then retry. |
| Audio expired | Retry once through the backend resolver, then re-import if the player source expired. Show transcript/evidence with audio marked unavailable. |
| Poor audio alignment | Play manually and disclose that automatic jump accuracy is pending; do not claim the two-second target. |
| Accuracy reference mismatch | Show the correct version's report, or explicitly say the custom checklist has no reviewed benchmark yet. |
| Second opinion pending | Reviewer can decide with a written reason; do not present a missing second opinion as agreement. |
| Swap evaluation too slow | Show its dry run and the labelled rehearsal comparison; do not present it as the live control result. |

## Rehearsal record

Status: **not performed**. A code/test pass does not complete the rehearsal.

| Field | Fill during the live rehearsal |
|---|---|
| Commit / participants / date | Pending |
| Local models, GPU inventory and peak VRAM | Pending |
| Official/calls/custom checklist versions | Pending |
| Control import and retry checks | Pending |
| Five calls play/seek; manually checked alignment | Pending |
| Criterion-swap drills 1 and 2 durations | Pending |
| Full demo duration and failed steps | Pending |

Keep #30 open until the timed rehearsal is recorded. Keep #24–#29 open until
their individual acceptance conditions are met; PRs are drafts while dependencies
or human checks remain outstanding.
