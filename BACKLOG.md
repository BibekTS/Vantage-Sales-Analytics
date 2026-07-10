# BACKLOG.md — the organization's task queue

This is the CEO's work queue and the **one lever the user pulls to steer the org**: edit priorities
here and the next `/ceo-improve-cycle` picks the top open item. Every item has concrete **acceptance
criteria** so an autonomous cycle knows when it is done.

**Three standing programs** (= the org's goals, see `CLAUDE.md`):
- **S/R items — improve the app** (stability fixes, features, refactoring)
- **W items — keep it current** (ThoughtSpot SDK/doc drift, via ts-watch)
- **M items — improve the org itself** (skills, playbooks, gates; file one whenever a cycle exposes
  a process failure)

**Statuses:** `open` · `in-progress` · `in-review` (PR open, awaiting human) · `done`.
**Priority:** P1 (do first) → P4 (someday). **Protected** items touch a guard-protected path (see
`CLAUDE.md`) and therefore **never auto-merge** — the cycle opens the PR and stops for human review.
**Cycles may only change the Status column, append outcome notes, and append rows.** Priority
changes, criteria edits, and row deletions are the human CEO's lever alone.

> Before starting any item, re-verify it against the current code — several findings below predate
> later fixes and may be partly or fully resolved. If an item is already fixed, mark it `done` with
> a one-line note pointing at the commit, and move on. That verification is itself part of the cycle.

| ID | P | Item | Acceptance criteria | Status | Protected |
|----|---|------|---------------------|--------|-----------|
| S1 | P1 | XSS: `innerHTML` with embed/TS/link-derived strings | `logEvent()` & `toast()` (app.js), `chipsEditor` & `appendLog` (auth.js) render untrusted strings via `textContent`/safe nodes; headless test proves a `<img onerror>` in a group name / event payload does not execute | open | — |
| S2 | P1 | confirm-host bypass via localStorage | A host arriving via `#s=` hash is NOT persisted to localStorage until the user clicks Connect; a second plain visit does not auto-connect to it. Covered by a state round-trip test | open | ⚠ state.js |
| S3 | P2 | Standalone Answer unreachable | An Answer picker exists in `sectionObject`; `discoverAnswers()`/`answerCache` are wired (not dead); selecting one renders `SearchEmbed({answerId,hideSearchBar:true})`. Headless-verified | open | — |
| S4 | P2 | No manual GUID entry in object pickers | `customSelect` accepts a typed GUID ("use this value") so a CORS-blocked instance can still be driven; matches the UI copy that says "paste a GUID" | open | — |
| S5 | P3 | Filter clobbering on liveboard-custom | Verify first: the 2026-07-08 `pushRuntimeFilters()`/`appliedRuntimeCols` work claims to supersede this. Confirm `cfbApply()`/`applyLiveFilters()`/`cfbBuild` no longer wipe each other's filters; if already fixed, mark done with the commit ref | open | — |
| S6 | P3 | Double embed render on boot | `setActive→render` and `connect→render` do not both fire a full embed render on first load; measured via a render counter in the headless test | open | — |
| S7 | P3 | Misc wiring loose ends | Verify each against current code: `searchTokenString` re-renders the embed; `__onFilterChanged` is defined (noted fixed later); Discovery bearer refreshes on autoLogin re-mint; trusted-auth Export path; not-logged-in overlay copy per auth type | open | — |
| S8 | P4 | Polish batch | Remove dead onboarding CSS; define/replace the undefined `--text` var in `.drill-bar`; auto-prefix `https://` on host input; add a copy-share-link affordance; Esc closes the open modal/overlay; drop the hardcoded seed `liveboardId` in config.js | open | — |
| W1 | P2 | Build the **ts-watch** pipeline | `scripts/check-ts-updates.mjs` detects SDK/doc drift with the exit-code contract; watermark, playbook, and `/ts-watch` skill exist; weekly cloud routine registered. See `docs/ts-watch-playbook.md` | done — PR #7 (29ba0f9) | ⚠ smoke-test.mjs |
| W2 | P2 | SDK bump 1.49.0 → 1.50.x | Detector already reports 4 newer versions (1.49.1–1.50.0). Follow the playbook's SDK-bump procedure: changelog check against the imported symbols, bump `ts-sdk-version.json` + `js/embed.js` together, full gates, PR with breaking-change assessment; reviewer verifies embeds against a live TS instance before merge | open | — |
| R1 | P3 | Refactor `js/app.js` (~5.5k lines) | Extract cohesive modules ONE PR at a time (e.g. the `cfb*` custom-filter-bar code, `sectionStyles`, the code generator), each behind the full gate (smoke + headless, no behavior change). Track sub-steps below | open | — |
| M1 | P3 | Promote the `boot` CI job to a required check | After ~3 consecutive green `boot` runs on real PRs (proving headless Chrome is stable on the runner), add `boot` to the required status checks alongside `smoke`/`esm-parse`/`guard`, and record the change here | open | ⚠ protection |
| M2 | P3 | First org retrospective | After the first 3 merged ceo-improve-cycle PRs: review them for process failures (gates that missed something, ambiguous rules, wasted agent effort), update `CLAUDE.md`/skills/playbook accordingly, and file follow-up M items. Recurs informally after every ~5 cycles | open | ⚠ CLAUDE.md |
| M3 | P4 | Doc-watch robustness | Evaluate the hash-based doc detection after 2–3 real ts-watch runs: false-positive rate (dynamic page churn), false-negative risk (client-rendered pages), and whether the `docs/ts-watch-snapshots/` diffing convention gives the agent enough context for surgical, sourced edits | open | — |
| M4 | P3 | Named department agents | The five departments exist as visible agent definitions in `.claude/agents/` (researcher, architect, implementer, reviewer, qa-verifier), tracked in git, and the ceo-improve-cycle playbook dispatches them by name with built-in fallbacks | done — this row's PR | — |

## Detail — R1 refactoring program (one module per cycle)

`js/app.js` is the monolith. Do not attempt a big-bang split. Each cycle extracts ONE cohesive
unit into its own ES module, imports it back, and proves **zero behavior change** via the headless
boot + smoke test. Candidate extractions, roughly in dependency order:

1. `cfb*` custom-filter-bar subsystem (largest, most self-contained: load/sort/metric/date/drag).
2. `sectionStyles` custom-styles studio (smart paste, lint, catalog, candidate picker).
3. The SDK-code generator (`generateCode` and its per-section emitters).
4. `apiCatalog` / APIs-Used panel.
5. Personal-Liveboards strip (`renderPersonalStrip`, `personalizeFlow`, etc.).

Each extraction: keep exports identical, move helpers with their only caller, no logic edits in the
same PR as the move. A behavior-changing follow-up, if needed, is a separate item.

## How to add an item

Append a row with a unique ID (S=app stability/feature, R=refactor, W=up-to-date, M=meta/org), a
priority, and **testable** acceptance criteria. If it touches a guard-protected path (`server.js`,
`js/state.js`, `scripts/smoke-test.mjs`, `.env*`, `.github/workflows/*`, `CLAUDE.md`), mark it
Protected so the cycle knows the PR will stop at the `guard` check for human review.
