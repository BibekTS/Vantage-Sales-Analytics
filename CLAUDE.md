# CLAUDE.md — Project constitution & agent onboarding

Every agent (CEO session or worker) auto-loads this file. It is the shared, durable knowledge
that makes stateless agents work as one organization. Read it before touching anything.

## What this is

A **tool-first ThoughtSpot Visual Embed SDK playground**: connect → pick an embed → tweak options
→ copy runnable SDK code. Every setup is a shareable link. Vanilla HTML/CSS/ES modules, **no build
step, no framework**. An Express server (`server.js`) mints trusted-auth tokens and proxies a few
REST calls. Repo: `BibekTS/Vantage-Sales-Analytics` on GitHub; `gh` is authenticated.

## Run & verify

| Command | Purpose |
|---|---|
| `npm start` | Server + frontend on http://localhost:3000 (also powers Trusted Auth) |
| `npm run dev` | Same, auto-restart |
| `npm test` | **The QA gate.** Boots the server, asserts security guards + static restrictions (22 checks) |
| `npm run doctor` | Verify Trusted Auth end-to-end (mints a real test token) |
| `npm run setup` | Create `.env` from template |
| `npm run vendor-sdk` | Self-host the pinned SDK into `vendor/` |

**The verification bar for ANY code change (all three, every time):**
1. **ESM parse** — each `js/*.js` is a browser ES module; a package without `"type":"module"`, so
   `node --check *.js` mis-parses them as CommonJS. Syntax-check by copying to `.mjs` first, or rely
   on the headless boot (below), which actually imports them.
2. **Smoke test** — `npm test` must stay green (currently 22/22). Never weaken an assertion to pass.
3. **Headless boot** — load http://localhost:3000 in headless Chrome (puppeteer-core is installed;
   system Chrome at `/Applications/Google Chrome.app/...`; use `createRequire` pointed at the project
   root — `NODE_PATH` does not work for ESM). Assert the tool shell mounts and there are **zero** JS
   errors. The only allowed console 404 is the pre-existing `/favicon.ico` on the restricted static
   server. `/verify` and the improve-cycle skill automate this.

## Architecture (files)

- `js/state.js` — ONE `state` object → URL hash (`#s=`, base64url) + localStorage + share link.
  Everything decoded from a link runs through `sanitize()` (whitelist keys, coerce types, cap
  lengths, strip `__proto__/constructor/prototype`, `validHost()`). **Secrets are never serialized.**
- `js/discovery.js` — REST discovery (org, worksheets, liveboards, vizzes, answers, column values).
- `js/embed.js` — SDK wrapper `initSDK()` + `doRender()`. SDK pinned at `visual-embed-sdk@1.49.0`.
- `js/auth.js` — trusted-auth token-claims playground + live inspector.
- `js/invoice-pdf.js` — Callback-action handler: viz rows → paginated client-side PDF.
- `js/app.js` — the controller (~5.5k lines): connection, rail, render, the single contextual
  inspector, SDK-code generator, event log. **This monolith is a standing refactor target.**
- `server.js` — token service + filter proxy + static host. **Fail-closed** (see rules).
- `scripts/` — `smoke-test.mjs` (the gate), `doctor.mjs`, `setup.mjs`, `vendor-sdk.mjs`.

## Critical rules (violate these and you break the app)

- Always `embed.destroy()` before re-render.
- **Standalone saved Answer** = `SearchEmbed({ answerId, hideSearchBar:true })`, NOT
  `LiveboardEmbed`+vizId. A saved answer cannot be embedded as an individual viz.
- **Date runtime-filter epochs must be NUMBERS (not strings) and UTC** (not local midnight).
  Coerce at trigger time — state stores strings.
- **`HostEvent.UpdateRuntimeFilters` APPENDS**, it does not replace. Route through
  `pushRuntimeFilters()`; to clear a column, resend it with `values:[]`. Runtime filters ≠ visible
  Liveboard filters (`HostEvent.UpdateFilters`), and they are **not a security boundary**.
- All state changes go through `state.js` (`setState`/sanitize). New state keys need a default,
  a sanitize branch (with caps + proto-guard), and a `mergeKnown` line, or shared links break.
- All TS/shared-link-derived strings into the DOM use `textContent`, never `innerHTML` (XSS).
- **Server is fail-closed:** JIT (`auto_create`) refused unless `TS_ALLOW_JIT=true`; browser
  `group_identifiers` refused unless allowlisted; `/api/filter-values` forwards the caller's bearer
  and never mints; static serving is restricted to frontend assets. `npm test` asserts all of this.
- `window.TS_CONFIG` is a `let` seed in `config.js`, not a const.

## How the organization works (see BACKLOG.md for the queue)

The **CEO** is the driving session (on-demand, or the weekly ts-watch cloud clone). It reads
`BACKLOG.md`, dispatches a cycle, and updates the backlog. Departments = subagents/tools:
Research (`Explore`), Engineering (`Plan` + worktree-isolated implementers), Review Board
(`/code-review`, `/security-review`), QA (`npm test` + headless boot + CI), Operations
(`/schedule`, `/loop`, `gh` merge). The cycle is codified in `/improve-cycle`.

**Every change is a branch + PR** with a verification-evidence section. A PR auto-merges only when:
CI is green ∧ code review found no confirmed correctness bug ∧ the diff touches **no protected path**.

**Protected paths — never auto-merged, always human review:**
`server.js`, `js/state.js` (the sanitize/security layer), `scripts/smoke-test.mjs`, `.env*`,
`.github/workflows/*`, `CLAUDE.md`, and priority edits to `BACKLOG.md`. These are the security
boundary and the org's own constitution.
