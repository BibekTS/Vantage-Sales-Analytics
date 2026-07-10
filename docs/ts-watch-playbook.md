# ts-watch playbook — keeping the playground current with ThoughtSpot

This is the **Research & Intelligence department's standing brief**. All repo-specific know-how for
tracking ThoughtSpot drift lives here so the scheduled routine's prompt stays short and conventions
can evolve without rescheduling. The `/ts-watch` skill and the weekly cloud routine both read this.

## Mission & guardrails

Keep the playground current — SDK version, drift in the tracked docs, and new embed features —
**with minimal human intervention**, by opening one reviewable PR per run. Hard guardrails:

- **Never push to `main`.** One PR per run on branch `ts-watch/YYYY-MM-DD`.
- **Never modify** `server.js` security guards, `scripts/smoke-test.mjs` assertions, `.env*`, or the
  token-minting logic. (These are protected paths — see `CLAUDE.md`.)
- **Compendium/doc edits are surgical** — smallest possible diff; every new claim carries an inline
  source URL; deprecations get a badge, never a deletion; never restructure anchor ids/TOC.
- **Feature stubs are additive-only** and marked draft.
- **`npm test` must pass** before the PR. Fix or revert your own breakage; never weaken a test.
- When ambiguous, **describe it in the PR body** rather than guessing in code.

## Repo map (what drifts, where the pins are)

- **SDK pin (single source):** `ts-sdk-version.json` → `.version`. `js/embed.js` carries the same
  version *literally* in its unpkg import URL (a static browser import can't read JSON), marked with
  `// TS-SDK-VERSION`. `scripts/vendor-sdk.mjs` reads the JSON. `scripts/smoke-test.mjs` asserts the
  JSON and `embed.js` agree — divergence is a hard test failure.
- **Watermark:** `docs/.ts-watch.json` — the diff baseline. Advances only when a human merges a
  ts-watch PR. `contentHashes` detect edits on unversioned doc pages; `skippedVersions` /
  `features.deferred` let a reviewer say "stop proposing this" by editing the file during review;
  `openPr` prevents duplicate PRs; `watchedUrls` lives here (not hardcoded) so the list self-heals
  when a docs page moves.
- **Drift-prone docs:** `docs/tse-best-practices.html` (the compendium), `docs/callback-action.md`,
  `docs/customize-export.md`, and the README trusted-auth section.
- **Detector:** `scripts/check-ts-updates.mjs` (`npm run check-ts-updates`). Detects only, never
  edits. Exit codes: `0` no changes (stop silently), `10` changes (act), `1` error (report, stop).

## Procedure per run

1. **Detect.** `node scripts/check-ts-updates.mjs --json`. Exit `0` → stop silently (if the
   watermark records an `openPr`, `gh pr view` it and push to that branch instead of opening a new
   one). Exit `1` → report the error and stop. Exit `10` → continue.
2. **Categorize** each detected change as **DOC**, **SDK BUMP**, or **FEATURE STUB** and handle per
   the sections below. A change you decide needs no action goes in a "Reviewed, no action" PR section.
3. **Update the watermark** (`docs/.ts-watch.json`) in the same PR: new hashes, `lastSeenNpmLatest`,
   `lastProcessedGithubRelease`, `lastRun`, `lastRunOutcome`.
4. **Verify.** `npm test` must pass.
5. **PR.** Branch `ts-watch/YYYY-MM-DD`, one PR titled `ts-watch: <digest>`, body = digest +
   per-claim sources + SDK old→new with breaking-change assessment + full smoke output + reviewer
   checklist. Leave it for human review — this touches protected paths and never auto-merges.

### SDK bump procedure

1. Read the changelog (`github.com/thoughtspot/visual-embed-sdk/releases`) for breaking changes to
   the **exact symbols the app imports** (in `js/embed.js`): `init, AuthType, AuthStatus, SearchEmbed,
   SpotterEmbed, LiveboardEmbed, AppEmbed, EmbedEvent, Page, HostEvent, Action, RuntimeFilterOp,
   CustomActionsPosition, CustomActionTarget` — plus the `EmbedEvent` listeners and `HostEvent`s in
   use (`UpdateRuntimeFilters`, `UpdateFilters`, `AIHighlights`, `Edit`, …).
2. **Breaking change to a used symbol → do NOT bump.** Document the required migration in the PR body
   and stop at a description. A clean bump: edit `ts-sdk-version.json` + the `js/embed.js` URL to the
   new version (keep them equal), re-vendor **only if** `vendor/` exists (`npm run vendor-sdk`), run
   `npm test`.
3. `npm test` is security-only — it cannot prove embeds render. The reviewer checklist MUST require a
   manual check against a live TS instance before merging an SDK bump.

### Compendium / doc edits

Surgical only. Reuse neighboring sections' markup/CSS. Every new claim carries an inline source URL.
Deprecations get a badge, never a deletion. Never restructure anchor ids or the TOC. The compendium
stays self-contained (it is the one file `server.js` serves from `docs/`).

### Feature stubs

The rail is data-driven in `js/app.js` (the `EMBEDS` / `RAIL_GROUPS` / `EMBED_BLURBS` structures). A
new-feature stub is purely additive: a rail entry with a `draft: true` marker (DRAFT badge) and an
inspector note citing the source doc URL. If unsure, list it under "Candidate features" in the PR
body instead of writing code. (A DRAFT-badge affordance in the rail builder is a small prerequisite —
add it in its own tiny PR the first time a stub is proposed; do not fold it into a feature stub.)

## Sources & 404 fallbacks

- npm: `https://registry.npmjs.org/@thoughtspot/visual-embed-sdk`
- GitHub releases: `https://api.github.com/repos/thoughtspot/visual-embed-sdk/releases`
- Docs: `https://developers.thoughtspot.com/docs/whats-new` (watched). If a watched URL 404s, the
  detector flags `moved: true` → **WebSearch** `site:developers.thoughtspot.com <topic>` for the
  successor and update `watchedUrls` in the watermark (self-healing). If the SpotterCode MCP doc
  tools are available (local runs), use them to verify claims — but never depend on them (the cloud
  runner may not have them).

## PR conventions

- Branch: `ts-watch/YYYY-MM-DD`. Title: `ts-watch: <one-line digest>`.
- Body: digest · per-claim → source map · SDK old→new + breaking assessment · full `npm test` output ·
  reviewer checklist ("verify embeds against a live TS instance — smoke does not cover rendering",
  "verify claims against cited sources", "finish or reject any DRAFT stubs").
- Update `docs/.ts-watch.json` in the same PR so the queue and the baseline move together.
