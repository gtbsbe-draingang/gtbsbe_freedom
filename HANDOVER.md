# Frontend Handover

As inspected on 2026-11-07 at `cc5ff85`, for issue #32 (stream A).
This file belongs in the main repository because `docs/` is ignored and is a
separate private notes repository. It describes the current implementation, not
the full planned demo. #31 is closed; #36 remains open.

## Start And Check

Backend-served UI, using the committed static build (no Node needed):

```sh
cd backend
uv run cqa-serve
```

Open `http://127.0.0.1:8000/`. The backend serves `web/dist/` and `/api` on the
same origin. Its default SQLite database is `backend/cqa.db`. Startup seeds the
official checklist and restores `data/snapshot/cqa-snapshot.json` only when the
database has no conversations and that snapshot exists. This worktree has no
`data/` directory, so a fresh start has no stored results. An empty queue tries
to import DEV automatically; this requires `ORGANIZER_API_URL` in `backend/.env`.
Use `backend/.env.example` as the configuration reference, never as a place for
real credentials. New model work requires `ANTHROPIC_API_KEY`; stored results
do not. Stream B owns backend startup and snapshot delivery (#15).

Frontend development requires Node >=22:

```sh
cd web
npm ci
npm run dev
```

Open `http://127.0.0.1:5173/`. This watch server defaults to **mock**, not HTTP.
It serves private DEV inputs from `data/dev.json` and `data/audio/`, or from the
directory named by `CQA_DATA_DIR`. It binds to loopback and rejects foreign Host
headers. Do not expose it publicly. Missing DEV input causes a visible import
error; this server does not substitute the real dataset automatically.

For separate frontend/backend development, start the backend on 8000 and use:

```sh
cd web
npm run dev -- --api http --api-origin http://127.0.0.1:8000
```

Set backend `CORS_ORIGINS='["http://127.0.0.1:5173"]'` before starting it.
There is no dev-server API proxy. `--api-origin` configures the API URL and the
dev server's CSP. Use another port with `--port` if occupied, and update CORS.

```sh
cd web
npm test
npm run e2e
npm run check:dist
```

Browser tests require Chrome/Chromium (`CHROME` overrides its executable path)
and private DEV data for data-dependent scenarios. They use headless Chrome
DevTools Protocol against the mock, not a live backend. `npm run check` runs all
three checks. E2E and dist checks build in temporary directories. After changing
`web/src/` or `web/static/`, run `npm run build` and include `web/dist/` in the PR.

## Implementation Map

| Area | Current state / entry point |
| --- | --- |
| Runtime | `web/src/main.js` exports `window.CQA`; `app.js` mounts the app, store and adapters. |
| Navigation and state | `ui/router.js`, `ui/shell.js`, `state/store.js`; hash routes, no server routing dependency. |
| Workspace | `ui/queue.js`, `ui/transcript.js`, `ui/scorecard.js`: filters, search, selection, transcript, evidence jumps, scores, evaluation polling and failed-job retry. |
| Non-workspace views | Checklist editor, appeals/detail, comparison, analytics and accuracy are placeholder views unless supplied through the `views` mount option. |
| Appeals | Scorecard shows existing appeal/decision state; its dispute button only shows a placeholder toast. No submission drawer or reviewer decision UI yet. |
| Loading and batch | Queue auto-imports DEV on empty. User-selected group import, JSON upload and selected-row batch controls are not implemented UI workflows. |
| Translation and audio | Adapter methods/contracts exist, but the transcript UI does not implement translation controls or audio playback. |
| Styles and strings | `src/styles/` is scoped under `.cqa`; `src/i18n/ru.js` is the current UI language. |

## Real And Mock Integration

- `web/src/api/index.js` is the only adapter factory. All fetch calls stay within
  `src/api/`. Production `web/static/config.js` (copied to dist) sets
  `window.CQA_CONFIG = { api: "http", apiBase: "api" }`. The base is runtime
  configuration, not a compiled backend origin.
- `context.js` resolves mount options before URL parameters before config.
  Supported context includes `api`, `apiBase`, `conversationId`, `role`, `theme`
  and `mode`. A conversation ID implies embedded mode. Language selection is not
  implemented, despite being part of the longer-term host-context requirement.
- `api/http.js` implements config, import/upload, conversations, translation,
  checklists/versions, evaluations/jobs, appeals/decisions, comparison, accuracy,
  analytics and CSV URL methods. Mutating POST bodies receive the current role.
  IDs are URL-encoded; use the full `{group_id}:{conversation_id}` identity.
- Checklist writes wrap the draft in `{role, checklist}` to match FastAPI.
  `backend/tests/app/test_frontend_checklist_contract.py` serializes requests
  with this real JavaScript adapter and submits them to the assembled backend,
  checking create, version increment, lineage and official-seed immutability.
  Appeal conversation/evaluation filters, decision kinds and analytics filters
  are still not forwarded by the adapter; coordinate those separately in #33.
- `api/mock/` implements the same interface with deterministic synthetic grading,
  delayed jobs and second opinions. It is not a real evaluator. State lives under
  localStorage key `cqa-mock-v1`, falling back to memory. Remove only that key to
  reset mock state. DEV conversation objects are volatile, but derived mock state
  can persist; do not use a shared browser profile for private-data demos.
- Mock DEV import fetches the local private file when configured. Other groups,
  or a mock without `devDataUrl`, use bundled examples, not organiser data.
  Fault injection and `window.__cqaTest` are enabled by the dev server, not the
  shipped config; keep these test hooks out of deployment configuration.

## Contract And Backend Pointers

The agreed API contract is section 7 of
`docs/superpowers/specs/2026-11-07-cqa-frontend-design.md`; the task plan is
`docs/superpowers/plans/2026-11-07-cqa-frontend.md`. Neither is present in this
worktree. Follow README's private-notes checkout instructions to obtain them.
Tracked, directly available references:

- `contract/schemas/`, `contract/examples/`: JSON shapes and representative
  payloads; `checklists/official-chat-v1.json`: locked official seed.
- `web/test/unit/contract.test.mjs`, `http-api.test.mjs`, `mock-api.test.mjs`:
  schema validation, HTTP request mapping and mock behavior. HTTP tests inject
  fetch; they do not establish live integration readiness.
- `backend/app/models.py`, `backend/app/routes/`, `backend/evaluator/router.py`:
  actual payload models and route implementations. Running backend exposes
  `/api/openapi.json`; Swagger/ReDoc pages are disabled under the strict CSP.
- `POST /api/evaluations` returns a job (201), or a dry-run estimate (200).
  Poll `GET /api/jobs/{id}`; retry unfinished work with its `/retry` POST.
  Read stored evaluations separately. `POST /api/appeals` returns an appeal
  (201); poll it for second opinion. Its `/decision` POST returns the
  recalculated **evaluation**, not the appeal. Errors use `{error, message}`;
  the adapter additionally distinguishes network, timeout and bad-response errors.

## Dynamics Constraints

Keep the output plain static HTML/JS/CSS/images with relative resource paths.
No separate font or JSON web resources: the font is embedded in CSS and config
is external JS. Preserve strict CSP: no inline scripts/styles/handlers, eval,
or additional network access outside the adapter. Keep CSS component-scoped,
600 px frames usable, embedded light theme as default, and no separate login.

`window.CQA.mount(element, options)` returns `open`, `setRole`, `setTheme` and
`destroy`. A same-origin Dynamics web-resource form script obtains the content
window through `formContext.getControl(...).getContentWindow()` and calls
`win.CQA.setClientApiContext(Xrm, formContext)`. The default record field is
`cqa_conversationid`, configurable by `dynamicsConversationField`. Never read
`parent.Xrm`. Currently this bridge reads only the conversation ID; it does not
map host identity, role or language, and no `Xrm.WebApi` adapter exists.

`web/static/dynamics-mock.html` is the 600 px iframe proof page; check it under
the dev server's strict CSP with `npm run e2e -- dynamics`. It is not a real
Dynamics deployment or PCF wrapper. A cross-origin hosted iframe needs a
separately validated context bridge, not direct content-window scripting.
Backend `CORS_ORIGINS` and `FRAME_ANCESTORS` accept configurable JSON arrays;
the default frame policy allows self only. Backend HTML currently permits only
self for connect/media, so split-origin hosting also needs a deliberate CSP
configuration at the serving layer, not just CORS. Keep same-origin backend
serving as the default.

## Remaining Work And Evidence

1. Finish #36: appeal submission/review, group loading/upload, checklist editor
   with locked-official copy lineage, and before/after comparison. Then complete
   the remaining reports, translation/audio and batch workflows as scoped.
2. Stream D's `backend/audio/` and `backend/quality/` packages are absent here.
   The HTTP audio URL helper does not prove a working audio endpoint, and
   `/api/reports/accuracy` has no implementation in the currently present routers.
   Coordinate those contracts before demonstrating these features.
3. Roles are prototype request fields and a UI selector, not authenticated
   authorization. Real Dynamics hosting, identity mapping, framing/CORS/CSP,
   deployment paths and any PCF wrapper still need tenant-level validation.
4. Verify the complete UI against the live backend and a sanitized results
   snapshot. No end-to-end live-backend or paid model run was performed for this
   handover. Never print or commit credentials, organiser URLs, signed audio
   URLs, raw DEV input or recordings. Browser data/audio must use backend paths
   in production; the loopback mock server is development-only.
5. Verification with `CQA_DATA_DIR` pointing to the existing private local data:
   `npm run check` passed all 306 unit tests, all 11 browser scenarios and the
   dist freshness check. Browser scenarios include 600 px layouts and the
   Dynamics iframe; zero CSP violations were reported. Without that private
   data, data-dependent browser scenarios fail rather than inventing results.
   The new adapter-to-FastAPI checklist regression also passes. These checks
   do not establish that the complete demo works on stored real evaluations.

The original UI PR is already merged. Link the published notes and the follow-up
PR on #32 to finish the handover deliverable; #36 and #33 remain separate open
feature/integration acceptance work, not completed by this document.
