# Submission Security Audit: Issue #35

## Status and Scope

Audited on November 7, 2026, Asia/Almaty (UTC+05:00), against submission
HEAD `cc5ff85b6bef464dd444bacf99518487333ccb5a`. This is a point-in-time,
read-only security/submission inspection, except for this report. It is not
approval to publish. Snapshot and README work is tracked separately in #15.

**Readiness: BLOCKED pending data-publication clearance and owner actions.**
No actual credential or organizer signed URL was identified by the checks below.
That result does not establish that real-call content is safe to publish.

Repository: `gtbsbe-draingang/gtbsbe_freedom`.
Authenticated `gh repo view` returned `visibility: PRIVATE`, `isPrivate: true`,
default branch `main`. `gh issue view 35` returned OPEN with no comments.
Its unchecked completion condition is: repository public, link sent, final
commit pushed before stop-code. No evidence of organizer delivery was supplied.

## Method and Coverage

- Read the applicable root `CLAUDE.md` in this worktree and the source-data
  checkout. No nested `CLAUDE.md` was found in the submission worktree.
- Confirmed this is not a shallow clone. Enumerated all local branches,
  remote-tracking refs, tags, reflog-reachable objects, and linked worktree
  heads. Scanned every locally stored blob and commit, including otherwise
  unreachable objects, rather than only the current checkout or added lines.
- Final local inventory: 45 refs; 132 commits reachable with `git rev-list
  --all` and also with `--all --reflog`; 1,465 locally stored objects comprising
  630 blobs, 138 commits, and 697 trees. Blob/commit input totaled 11,219,976
  bytes. These counts reflect concurrent branch updates during the audit,
  not an immutable final submission snapshot.
- Read-only GitHub API enumeration returned 56 remote refs, including pull
  request heads and synthetic merge refs. Reviewed API-only commit metadata
  and complete recursive trees for merge commits
  `40f49d96bd8df6468ffa51a3fcca9498314c28d0`,
  `1d470c50bd7ac7d0d46ba2573aee80d045954832`, and
  `a50f95ece239d82bbc008173364ed56838f78a56`.
  Their trees contained 211, 217, and 178 blobs respectively; none of the tree
  responses was truncated, every blob was present locally and scanned, and
  every parent commit was present. Earlier observed PR #64 merge commit
  `88645ef28b70438026b97983c0b728b7b878e7ef` was also checked by API; its tree
  and parents were local. Synthetic merge refs changed during inspection.
- No installed `gitleaks`, `trufflehog`, or `detect-secrets` executable was
  available. Used in-memory Python standard-library scans over Git plumbing,
  JSON parsing, decoded URL/query parsing, and ZIP/XML inspection. Output was
  restricted to paths, hashes, line numbers, categories, counts, and booleans.
  Secret candidates, signed URLs, and customer utterances were not printed.
- Checked provider credential formats, private-key headers, JWTs, credential
  assignments, URL userinfo, signed query parameters including percent-encoded
  forms, environment/key/database/audio paths, and common email, phone,
  Kazakhstan IIN/IBAN and payment-card-like patterns. Inspected fixture and
  configuration context to distinguish test markers from actual credentials.
- Compared organizer audio URLs and the two distinct known signature values
  in the ignored DEV source/PDF link against stored objects, without printing
  those values. No exact known URL/signature match was found.
- Compared DEV transcript strings to stored blobs and structurally compared
  the committed six-record fixture to its ignored DEV source. Inspected the
  guide with `pdftotext` and its hyperlink metadata with `pdfinfo -url`, keeping
  the signed hyperlink out of output. Both local guide copies have SHA-256
  `8b2f79a685c6707749c780ee042d06c2bf4bff8741732698b4c8bac033ff1b5e`.
- Binary inspection found a WOFF2 font and a historical PPTX. The font was
  classified as a font, not exhaustively decoded; the PPTX ZIP's XML and
  relationship entries were inspected. No stored raw audio/PDF/database file
  or committed raw `data/dev.json` was found by path or binary-type checks.

Limitations: heuristic checks cannot prove absence of arbitrary credentials,
semantic personal information, or authorization restrictions. This was not an
application authorization/security test. GitHub issues other than #35, external
messages, releases, Actions logs/artifacts, LFS server objects, and attachments
were not audited. New files and ref updates after the scan require another pass.

## Findings

### 1. Real-call Transcript Requires Public-release Clearance

`backend/tests/fixtures/dev_subset.json` contains six DEV records: five chats
and one voice call. All six are exact source records after setting `audio_url`
to null. The voice-call record starts at line 443 and retains 45 transcript
turns. The generator at `backend/tests/fixtures/make_dev_subset.py` explicitly
copies source records and removes only the audio URL. Introduction commit:
`77bccef36908821c5bee7722055c0df0f1dc06e6` (November 7, 2026).

Guide page 1 identifies the 60 chats as synthetic and the five calls as real.
Therefore the chats must not be misreported as confirmed real-customer leaks,
but the unchanged real-call transcript is genuine organizer-provided call
content, not merely a synthetic test marker. No direct identifier was confirmed
by the pattern checks in this fixture; that does not establish permission to
publish the transcript. Organizer authorization or a documented safe-data
decision is required before publication. Removing only today's fixture would
not remove it from history or other refs. No removal or history rewrite was
performed by this audit.

DEV text also occurs in historical `data/reference/dev_labels.json` reachable
from `origin/gyat`, including seven long source-message matches. Review these
reference excerpts under the same publication decision. Their customer-data
status must not be inferred solely from their use as expected answers.

### 2. Unrelated Historical Project Material Is Reachable

`origin/gyat` includes ancestor `187264bd5434a251eaf3dd94f9abf45539e7b59d`
(June 17, 2026), containing unrelated `Desktop/aspan/`, `Desktop/freedomcase/`,
and `Desktop/sales/clone/` project trees. Historical material includes
`Desktop/aspan/logs/proposal_runs.jsonl`, configuration, workflow definitions,
and `Desktop/aspan/templates/aspan_template.pptx`. Commit
`4856f7dbcc37d74a943881e0ff5cb013df481ba8` removes this material from later
trees but does not make the ancestor inaccessible.

No actual credential or confirmed personal identifier was established in these
files. A numeric identifier candidate in the proposal log was a floating-point
annual-savings field, not an IIN. Nevertheless, project ownership and permission
to disclose this unrelated material remain unverified. The owner should resolve
that exposure before changing visibility. Current `main` cleanliness alone is
not sufficient. No refs were deleted or rewritten.

### 3. Credential and Raw-media Checks Found No Actual Leak

Credential-like literals resolved to explicit test sentinels, blank example
settings, configuration variable names, or browser-storage/reuse keys. The
provider-key-shaped test value in `backend/tests/app/test_skeleton.py:33` is an
intentional fake, not an observed live key. Signature-like test URLs and literal
`sig=` guards/documentation are not evidence of organizer URL leakage. Parsed
signature candidates had no unresolved realistic long signature value.

`backend/.env.example` has blank `ANTHROPIC_API_KEY` and `ORGANIZER_API_URL`.
Historical `Desktop/aspan/.env.example` has a placeholder key, not a confirmed
credential. No non-example environment file was found in inspected history.
Common PII-pattern hits in evaluator masking/judging tests were synthetic test
inputs, not established customer identities. Ordinary Git author emails were
treated as commit metadata, not customer data or credentials.

The source checkout's ignored `data/dev.json` and five MP3 files under
`data/audio/` exist locally but were not found as raw committed artifacts.
The ignored organizer PDF itself contains a signed data hyperlink; keep that
PDF excluded from publication. Do not infer that ignoring a local file alone
proves historical safety; historical objects were checked separately above.

### 4. Deadline, Contact, and Submission Actions Remain Unverified

Primary evidence: `CQA_Hackathon_Student_Guide_v3.pdf`, page 4, section 04:

- Control transcripts are opened 23 hours after the event starts.
- Stop-code is 24 hours after the event starts. Freeze the final commit; the
  jury checks that version. Processing data and changing the checklist through
  the frozen interface are allowed afterward.
- Before stop-code, commit the solution to an open Git repository, send its
  link to organizers in advance, and provide clear README startup steps.
- Exact defense scheduling and team count will be announced separately.

Issue #35 repeats the public-repository/link/final-commit requirements and cites
guide page 4. Neither it nor the inspected guide establishes an exact event
start timestamp, absolute stop-code date/time, named recipient, email address,
or submission channel. Do not invent a November 7 or November 8 deadline from
the current date or commit timestamps. Obtain the official start/timezone and
organizer recipient/channel, then record the absolute T+24h deadline and proof
of link delivery. No organizer was contacted during this audit.

## Readiness Checklist

- [x] Inspect issue #35 and verify repository visibility without changing it.
- [x] Scan all locally stored Git blobs/commits and account for observed remote
  pull-request merge trees, beyond current-branch history.
- [x] Distinguish synthetic test credentials/signature markers from live leaks.
- [x] Check raw DEV/audio/environment paths and ignored source material.
- [ ] Resolve publication permission for the real-call transcript and historical
  DEV-derived reference excerpts, including every ref/history that retains them.
- [ ] Resolve ownership/publication permission for unrelated `origin/gyat` history.
- [ ] Finish and validate the snapshot and README. No frozen
  snapshot was present at audited HEAD; this report does not certify new exports.
- [ ] Re-scan the final snapshot, tracked/untracked additions, final frozen commit,
  all refs, and any newly generated merge trees after concurrent work settles.
- [ ] Confirm official start timestamp/timezone, absolute stop-code deadline,
  and exact organizer recipient/channel from authoritative event evidence.
- [ ] Owner explicitly approves and performs public visibility change only after
  the data/history decisions; independently verify anonymous repository access.
- [ ] Authorized person sends the link in advance and retains delivery evidence.
- [ ] Authorized person commits/pushes the frozen solution before the confirmed
  deadline and records its SHA; satisfy and close issue #35 only with evidence.

This audit did not publish the repository, contact organizers, rewrite history,
commit, push, or post to issues. It did not change the snapshot or README.
