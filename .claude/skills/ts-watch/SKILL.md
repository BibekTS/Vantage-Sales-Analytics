---
name: ts-watch
description: Run one "keep the playground current with ThoughtSpot" cycle — detect SDK/doc drift, and if anything changed, follow docs/ts-watch-playbook.md to make surgical updates and open a reviewable PR (never touches main; never auto-merges). Invoke as `/ts-watch` for a manual/supervised run. This is the local counterpart to the weekly scheduled cloud routine. Use when the user wants to check for ThoughtSpot SDK releases or doc changes, or refresh the playground against upstream.
---

# ts-watch — one drift-detection & update cycle

You are the **Research & Intelligence department**. Read `docs/ts-watch-playbook.md` first — it holds
all the repo-specific conventions, guardrails, and per-category procedures. This skill is the manual
entry point; the weekly cloud routine runs the same playbook unsupervised.

## Steps

1. **Detect.** Run `node scripts/check-ts-updates.mjs --json`.
   - Exit `0` → no drift. If the watermark (`docs/.ts-watch.json`) records an `openPr`, `gh pr view`
     it and report status; otherwise report "nothing to do" and stop.
   - Exit `1` → a real error (e.g. pin drift between `ts-sdk-version.json` and `js/embed.js`). Report
     it and stop — do not paper over it.
   - Exit `10` → drift detected; continue.
2. **Categorize & act** on each change as DOC / SDK BUMP / FEATURE STUB per the playbook. Follow the
   hard guardrails: never touch `main`, `server.js` guards, `smoke-test.mjs` assertions, `.env*`, or
   the token-mint logic; keep doc edits surgical with sourced claims; keep stubs additive + draft.
   - **SDK bump:** check the changelog for breaking changes to the symbols `js/embed.js` imports; a
     breaking change → document the migration in the PR, do NOT bump. A clean bump edits
     `ts-sdk-version.json` + the `js/embed.js` URL together (keep them equal) and re-vendors only if
     `vendor/` exists.
3. **Update the watermark** `docs/.ts-watch.json` (hashes, `lastSeenNpmLatest`,
   `lastProcessedGithubRelease`, `lastRun`, `lastRunOutcome`) in the same change.
4. **Verify.** `npm test` must pass (it now includes the SDK-pin-consistency check). Never weaken it.
5. **PR.** Branch `ts-watch/YYYY-MM-DD`; one PR titled `ts-watch: <digest>` with the digest, per-claim
   sources, SDK old→new + breaking assessment, full smoke output, and the reviewer checklist. This
   touches protected paths — **leave it for human review; do not merge.** If unsupervised (cloud
   routine), stop after opening the PR and let the human CEO decide.

## Notes
- Locally, if the SpotterCode MCP doc tools are available, use them to double-check ThoughtSpot claims
  — but the cloud runner may not have them, so the playbook never depends on them.
- One PR per run. If a `ts-watch/*` PR is already open (watermark `openPr`), push to it instead of
  opening a duplicate.
