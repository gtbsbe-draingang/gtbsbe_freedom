# Rules for this project

## What this is

Freedom Broker × Nazarbayev University Data Challenge: a 24-hour prototype of
**Conversation Quality Analytics (CQA)**. A user configures a checklist, runs an evaluation
of an operator's dialogue, sees per-criterion answers, scores, explanations and the evidence
line; files an appeal; a reviewer confirms or changes the score and the total is recalculated.

- Brief (Russian): `CQA_Hackathon_Student_Guide_v3.pdf`. The defence is 5 minutes and is a
  live demo of the UI (see its page 4).
- Data: `data/dev.json`, the DEV set: 65 dialogues, 60 chats and 5 voice calls, in RU 35, KZ 15
  and EN 15. Speakers are `client`, `operator`, `bot` and `system`. Chat timestamps are `MM:SS`,
  call timestamps are ISO 8601 with a time zone. Only calls have `audio_url`. Keep the original
  timestamps.
- Official checklist: `CQA_Chat_Quality_Checklist 1.pdf` (8 criteria, weights, scales, N/A
  rules, rounding). It is the default, word for word. Agreed extras: `EXTRA_FEATURES.md`.
- Designs: `docs/superpowers/specs/2026-11-07-cqa-design.md` (whole system: backend, evaluator,
  quality, team split) and `docs/superpowers/specs/2026-11-07-cqa-frontend-design.md` (front
  end). **Section 7 of the front-end design is the single API contract**; `contract/` holds its
  JSON Schemas and example payloads, which the UI's mock adapter and the backend's models are
  both tested against.
- Brand reference: `Data 2 (1) 1.pdf` (Freedom brand slides, exported from Figma).
- Repo: `github.com/gtbsbe-draingang/gtbsbe_freedom` (team org; private until submission, the
  user decides when it opens). Commit as `schlmpcs`, no AI attribution.

## Secrets: the organisers' URLs

The organisers' data URL and every call's `audio_url` in `data/dev.json` are signed Power
Automate URLs (a `sig` in the query string). Never print them, never put them in code, the
bundle, logs or commits. Data and audio reach the browser only through our backend.
The raw `data/dev.json` and `data/audio/` (real customer calls) are never committed. Committed
data (the snapshot for the jury, the checklist seed, reference answers) must contain no signed
URL: drop `audio_url` and check for `sig=` before committing.

## Hard rule: the UI must stay integrable with Dynamics 365

The brief asks for the interface in HTML, CSS and JavaScript, structured so it can later
become an HTML component of Dynamics 365. Every UI change must keep all of the following
true. A change that breaks one is not done, even if the feature works.

It must stay possible to ship the UI three ways without rewriting it: as Dynamics **web
resources** (files uploaded into Dynamics and shown on a form), as an **iframe** of our hosted
page on a form, and later wrapped as a **PCF** component.

1. **Static files only, relative paths.** The shipped UI is `index.html` plus as few files as
   possible (one bundled JS file, one CSS file, SVG icons). A build step is fine if its output
   is plain static files. No server-rendered pages, no absolute paths, no paths that assume
   the site root.
2. **Only web-resource file types.** Web resources accept HTML, CSS, JS, XML, XSL, RESX and
   images (PNG, JPG, GIF, ICO, SVG). There are **no font or JSON types**: embed the font into
   the CSS as base64, and ship config or sample data as JS modules or fetch it from the API.
3. **Survives Strict CSP.** No inline `<script>`, no `style="..."` in markup or HTML strings,
   no `onclick=` or other inline handlers, no `javascript:` URLs, no `eval` or `new Function`.
   Set dynamic styles through classes or `element.style`/CSS variables from JS. The dev server
   sends a strict Content-Security-Policy header (`default-src 'self'`, no `unsafe-inline`,
   no `unsafe-eval`, `connect-src` and `media-src` = self plus the API origin, `font-src` and
   `img-src` = self plus `data:`) so a violation shows up at once. The font stack falls back to
   the system sans-serif in case a host blocks the inlined font.
4. **One data adapter.** All data access goes through one module (`api.js` or similar). No
   `fetch` anywhere else. Today it calls our backend. Inside Dynamics it either keeps calling
   our backend or switches to `Xrm.WebApi`, and only that module changes. The API base URL is
   set at runtime, not baked into the bundle.
5. **Context comes from outside.** The dialogue ID, the user's role and the language come from
   URL parameters, or from Xrm and formContext handed in through one exported function that
   a Dynamics form script calls via `getContentWindow()`. Never use `parent.Xrm`, never
   hard-code IDs.
6. **Scoped styles.** Every rule lives under the component's root class. No global selectors
   on `html`, `body` or bare elements, no resets that leak out. The standalone page may style
   its own `body`.
7. **Works in a narrow frame.** Usable from 600 px wide (a form tab). Panes collapse instead
   of overflowing.
8. **Light theme by default when embedded**, dark theme available. No login of our own: in
   Dynamics the user is already signed in. Appeal and review are separate actions in the UI.
9. **Backend is ready for it.** CORS allowed origins are configurable (Dynamics origins such
   as `https://*.crm*.dynamics.com`). Our hosted page can be framed by Dynamics
   (`frame-ancestors` configurable).
10. **Keep a proof.** Keep a page that shows the UI inside a mock Dynamics form iframe, served
    with the strict CSP, and check it after UI changes.

Sources: Microsoft Learn, "Web resources in model-driven apps", "getContentWindow (Client API
reference)" and "Content security policy" (Power Platform admin).

## Design language

Freedom's design language, not a copy of any Freedom page. The layout is ours, built for the
CQA flow (queue → transcript → scorecard). Values come from bankffin.kz's CSS, fbroker.kz's
CSS and the brand slides.

- **Font:** CoFo Sans (variable font from fbroker.kz; has every Kazakh letter). Bold italic
  for accent words. Tabular figures only on numbers (the font's `tnum` also widens spaces).
- **Green does a job:** `#4FB84E` only for active and selected states; `#2A8640` for green text
  on light (4.6:1 contrast). Light-theme green tag: `#DDF6CE` background with `#1E6B30` text.
- **Shapes:** tags and filters are full pills (100px); cards 16px corners; controls 12px;
  icon buttons in round grey circles; active nav item has a green underline.
- **One brand moment per screen:** a dark green glowing panel (`#0B231E` → `#041311`) with a
  mint (`#74FA97`) number and a green-to-teal button (`#60D080` → `#64D9C4`). On the
  evaluation screen this is the total score.
- **Themes (from the bank site's own variables):** light page `#F5F6F7`, cards `#FFFFFF`, text
  `#191919`, secondary text `#737373`, lines `#D1D1D1`. Dark page `#191919`, cards `#282828`,
  text `rgba(255,255,255,.87)`, secondary text `#B7BBBD`, lines `#454545`.
- Approved mockup: `.superpowers/brainstorm/*/content/design-language-v2.html`.

## Repo hygiene

- Never committed (in `.gitignore`): `.superpowers/`, `docs/`, `data/dev.json`, `data/audio/`,
  the organisers' PDFs, `node_modules/`.
- `web/dist/` **is** committed: the jury runs the frozen commit without Node. Rebuild it with
  `npm run build` in every pull request that changes `web/`.
- No AI attribution anywhere (commits, PRs, README).

## Git: never push to `main`

- **Never push to `main`.** Not directly, not with `--force`, not by merging locally and
  pushing. A change reaches `main` only through a pull request that a teammate merges.
- Work on one branch per issue, named with the stream letter (`d/24-reference-answers`),
  and push only that branch.
- Create every branch from a fresh `origin/main` (`git fetch`, then
  `git switch -c <branch> origin/main`), never from whatever happens to be checked out.
- Check `git branch --show-current` before every commit and push. If it says `main`, stop
  and move the work to a branch.
