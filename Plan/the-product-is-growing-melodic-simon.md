# ts-watch: Automated "Keep Up With ThoughtSpot" Pipeline

## Context

ThoughtSpot ships fast (SDK ~monthly, cloud releases ~monthly) and the playground drifts: the SDK is pinned at **1.49.0** while npm's latest is already **1.50.0** (2026-07-01) plus three 1.49.x patches; the 4,288-line TSE best-practices compendium (`docs/tse-best-practices.html`) and the app's embed catalog only update when someone remembers. The user wants this to stay current **with minimal human intervention**. Decisions made: the automation **opens a PR for review** (never touches main), covers **all three** scopes (compendium/doc updates, SDK version tracking, new-feature stubs), and runs as a **Claude scheduled cloud agent** (weekly routine via `/schedule`). Repo is on GitHub (`BibekTS/Vantage-Sales-Analytics`), `gh` is authenticated. Verified sources: npm registry works, `github.com/thoughtspot/visual-embed-sdk/releases` is 200, `developers.thoughtspot.com/docs/whats-new` is 200 (`/docs/changelog` 404s — encode fallback searching).

**Architecture in one line:** a weekly cloud routine runs a cheap deterministic detector script against a committed watermark file; if nothing changed it exits silently; if something changed it follows a committed playbook to apply surgical updates, runs `npm test`, and opens one PR per run on `ts-watch/YYYY-MM-DD`.

## Implementation (this session)

### 1. Single source of truth for the SDK version
The pin lives in two places that can diverge: [js/embed.js:24](js/embed.js#L24) (unpkg URL) and [scripts/vendor-sdk.mjs:19](scripts/vendor-sdk.mjs#L19).
- New `ts-sdk-version.json`: `{ "version": "1.49.0" }`.
- `scripts/vendor-sdk.mjs`: read the version from that JSON instead of the hardcoded const.
- `js/embed.js`: keep the literal URL (static browser import — can't read JSON), add a `// TS-SDK-VERSION` marker comment.
- Consistency enforced by the detector script (and a new smoke-test check): grep `visual-embed-sdk@(\d+\.\d+\.\d+)` out of embed.js and assert it equals the JSON. Divergence = hard failure.

### 2. Watermark file: `docs/.ts-watch.json` (committed)
Makes runs idempotent/diff-based; only advances when a human merges the PR. Schema:
```json
{
  "schemaVersion": 1,
  "lastRun": "2026-07-06",
  "lastRunOutcome": "pr-opened | no-changes | error",
  "sdk": { "pinnedVersion": "1.49.0", "lastSeenNpmLatest": "1.49.0",
           "lastProcessedGithubRelease": "v1.49.0", "skippedVersions": [] },
  "releaseNotes": {
    "watchedUrls": ["https://developers.thoughtspot.com/docs/whats-new",
                    "https://docs.thoughtspot.com/cloud/latest/rn-cloud"],
    "contentHashes": { "<url>": "sha256:..." }
  },
  "features": { "stubbed": [], "deferred": [] },
  "openPr": null
}
```
Key semantics: `contentHashes` detect changes on unversioned doc pages; `skippedVersions`/`deferred` let the human say "stop proposing this" by editing the file during PR review; `openPr` prevents duplicate PRs when one sits unmerged; `watchedUrls` lives in the watermark (not hardcoded) so the URL list is self-healing when docs pages move. Note: `server.js` serves only the single compendium file from `docs/`, so the watermark is not web-exposed.

### 3. Detector script: `scripts/check-ts-updates.mjs` (new)
Zero-dependency Node ≥18, matching existing `scripts/*.mjs` style. **Detects only, never edits.** Steps:
1. Load watermark + `ts-sdk-version.json`; run the pin-consistency check against `js/embed.js`.
2. npm: `GET https://registry.npmjs.org/@thoughtspot/visual-embed-sdk` → `dist-tags.latest` + versions/dates published since the pin (from the `time` map).
3. GitHub: `GET https://api.github.com/repos/thoughtspot/visual-embed-sdk/releases?per_page=10` → tags + changelog bodies newer than watermark (warn, don't fail, on 403 rate-limit).
4. Docs pages: fetch each `watchedUrls` entry, strip tags/whitespace, sha256, compare to `contentHashes`; report changed/unchanged/404 (`moved: true` on 404 → agent must WebSearch for the successor page).
5. Output human summary; `--json` emits a machine block. Exit codes: `0` no changes, `10` changes detected, `1` error — the routine short-circuits on exit 0.
- Add `"check-ts-updates": "node scripts/check-ts-updates.mjs"` to package.json scripts.

### 4. Playbook: `docs/ts-watch-playbook.md` (new)
All repo-specific know-how lives here so the routine prompt stays short and conventions can evolve without rescheduling. Sections:
1. **Mission & guardrails** (verbatim, see §6).
2. **Repo map**: pin locations, vendor procedure (`npm run vendor-sdk` only if `vendor/` exists), watermark semantics, drift-prone docs (`tse-best-practices.html`, `callback-action.md`, `customize-export.md`, README trusted-auth section).
3. **SDK bump procedure**: edit JSON + embed.js URL → re-vendor if vendored → `npm test` → check the changelog for breaking changes to the exact symbols the app imports (`init, AuthType, SearchEmbed, SearchBarEmbed, SpotterEmbed, LiveboardEmbed, AppEmbed, EmbedEvent, Page, HostEvent, Action, RuntimeFilterOp, CustomActionsPosition, CustomActionTarget`) and the 11 EmbedEvent listeners / 2 HostEvents in use (enumerated). Breaking symbol → do NOT bump; document the migration in the PR instead.
4. **Compendium editing rules**: surgical edits only; reuse neighboring sections' CSS/markup; every new claim carries an inline source URL; deprecations get a badge, never deleted; never restructure anchor ids/TOC; file stays self-contained.
5. **Feature-stub procedure**: rail driven by `EMBEDS`/`RAIL_GROUPS`/`EMBED_BLURBS` in js/app.js (~lines 18/33/40); walkthrough of adding an entry (rail → inspector → `doRender` branch in embed.js); stubs get `draft: true` (DRAFT badge), an inspector note citing the source doc URL, and must be purely additive.
6. **Source list & 404 fallbacks** (WebSearch `site:developers.thoughtspot.com <topic>`; use SpotterCode MCP doc tools if available, never depend on them).
7. **PR conventions**: branch `ts-watch/YYYY-MM-DD`, digest body template, watermark updated in the same PR.

### 5. Small code prep
- **DRAFT badge**: in the rail builder in js/app.js (~line 448), render a badge when an `EMBEDS` entry has `draft: true`; add the CSS class. Doing it now means stub PRs never touch shared rendering code.
- **Smoke-test check**: pin-consistency assertion added to `scripts/smoke-test.mjs`.
- **Local command**: `.claude/commands/ts-watch.md` — "Read docs/ts-watch-playbook.md and execute a ts-watch run" — the manual fallback when cloud scheduling is down or a run needs supervision (and locally the SpotterCode MCP doc tools improve accuracy).

### 6. The scheduled routine (via `/schedule`, weekly, cron `0 7 * * 1` Monday 07:00)
Prompt (condensed): read the playbook → run `check-ts-updates.mjs --json`; exit 0 → stop silently → if watermark records an open PR, `gh pr view` and push to that branch instead of opening a new one → categorize changes as **DOC** (surgical doc edits, every claim sourced; irrelevant notes go in a "Reviewed, no action" PR section), **SDK BUMP** (playbook §3; breaking → document, don't bump), or **FEATURE STUB** (playbook §5; unsure → "Candidate features" section instead of code) → update watermark → `npm test` must pass (fix/revert own breakage; never weaken tests) → branch, push, one PR titled `ts-watch: <digest>` with: digest, per-claim sources, SDK old→new + breaking-change assessment, full smoke-test output, reviewer checklist ("verify embeds against a live TS instance — smoke test does not cover rendering", "verify claims against cited sources", "finish/reject drafts").

**Hard guardrails** (in prompt + playbook): never push to main; never modify server.js security guards, smoke-test assertions, `.env*`, or token-minting logic; compendium edits surgical; stubs additive-only; always run `npm test` before the PR; when ambiguous, describe in the PR body rather than guessing in code.

## Verification

1. **Detector**: `node scripts/check-ts-updates.mjs` with the watermark seeded to current-truth values. Since 1.50.0 is already out, it should exit `10` and report the 1.49.0→1.50.0 delta correctly; then seed `lastSeenNpmLatest: "1.50.0"` + fresh hashes and confirm exit `0`.
2. **Pin check**: temporarily mismatch the JSON vs embed.js in a scratch copy → detector errors; `npm test` still 20/20 + new check passes on the real tree.
3. **Full dry run, locally**: run `/ts-watch` in a fresh session with the watermark rewound (SDK 1.48.x, one stale hash) so all three categories fire; confirm a sensible PR: right branch name, both pins bumped in agreement, sources cited, smoke output in body, watermark updated. Close or merge that PR deliberately. (The real 1.49.0→1.50.x delta makes this a genuine first run, not a synthetic one.)
4. **Cloud smoke**: create the routine via `/schedule`, trigger a run-now, confirm the cloud runner reaches npm/GitHub/docs and opens the PR; then enable the weekly cron.
5. **Steady state**: after the first scheduled no-change run, confirm no PR/branch was created.

## Risks (accepted, mitigated)

- **Hallucinated compendium claims** (worst case): every claim requires an inline source URL + PR-body claim→source map + surgical diffs, so review catches it.
- **`npm test` is security-only** — it cannot prove embeds render. The PR reviewer checklist explicitly requires a manual check against a live TS instance before merging an SDK bump. (Future hardening: a Node `import()` of the new `tsembed.es.js` asserting the 14 imported symbols exist.)
- **Doc URL churn**: hash detection + 404→WebSearch + self-healing `watchedUrls` in the watermark.
- **Duplicate PRs**: `openPr` field + `gh pr view` check.

## Files

| File | Change |
|---|---|
| `scripts/check-ts-updates.mjs` | new — detector, exit-code contract |
| `docs/ts-watch-playbook.md` | new — conventions for the routine |
| `docs/.ts-watch.json` | new — watermark |
| `ts-sdk-version.json` | new — single pin source |
| `scripts/vendor-sdk.mjs` | read version from JSON |
| `js/embed.js` | marker comment on the import line |
| `js/app.js` + `css/styles.css` | DRAFT badge in rail builder |
| `scripts/smoke-test.mjs` | pin-consistency check |
| `package.json` | `check-ts-updates` script |
| `.claude/commands/ts-watch.md` | new — local fallback command |
| (via `/schedule`) | weekly routine, cron `0 7 * * 1` |
