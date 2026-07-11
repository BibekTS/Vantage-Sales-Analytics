# codebase.md — verified facts about the code

One bullet per fact: date · evidence (`file:line`) · which cycle/PR established it. Read this
before researching, reviewing, or hunting — do not re-derive or re-file what's here. Delete
entries when falsified; promote to `CLAUDE.md` when they harden into rules.

## XSS surface

- 2026-07-10 (S1, PR #12): the four untrusted-string sinks — `logEvent()` and `toast()` in
  `js/app.js`, `chipsEditor` and `appendLog` in `js/auth.js` — are verified `textContent`-safe.
  A headless XSS probe in `scripts/boot-check.mjs` (hash→chips and mint→event-log paths) guards
  them; both sinks were mutation-tested.
- 2026-07-10 (S1 research → filed as S9): `el(tag, cls, html)` (app.js:261, auth.js:72) passes its
  third arg through `innerHTML`. Two call sites feed it a variable that is today always a
  literal/enum but would become a sink if ever fed TS/user data: `accordion(title,…)` (app.js:931)
  and `el('span','act-name', a)` (app.js:1266). Never pass TS/link-derived strings as the third
  arg — omit it and set `textContent` after. All four file:line cites independently re-verified
  2026-07-10 (M7 review) — exact.

## Filters & rendering

- 2026-07-08 (commit f7d439f, PR #4): `pushRuntimeFilters()` + `appliedRuntimeCols` landed,
  claiming to supersede the S5 filter-clobbering finding (`cfbApply()`/`applyLiveFilters()`/
  `cfbBuild` wiping each other). **Not yet re-verified** — S5 is still open; verify before
  building on this claim.

## Gates

- 2026-07-10 (M7 review): `scripts/smoke-test.mjs:23` (PORT 34917) and `scripts/boot-check.mjs:31`
  (PORT 34921) hardcode their server ports with no env override — the server-bound gates are NOT
  safe to run concurrently on one machine (parallel worktrees, or a reviewer running the suite
  alongside QA, collide with `EADDRINUSE` and produce phantom reds). Only one agent runs them at
  a time; M8 tracks making them parallel-safe.

## Upstream / SDK

- 2026-07-10 (W2): the ts-watch detector reports SDK versions 1.49.1–1.50.0 newer than the pinned
  1.49.0. Bump procedure is in `docs/ts-watch-playbook.md`; W2 is the open item.
