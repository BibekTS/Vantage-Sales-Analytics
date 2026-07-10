---
name: ts-watch
description: Run one "keep the playground current with ThoughtSpot" cycle — detect SDK/doc drift, and if anything changed, follow docs/ts-watch-playbook.md to make surgical updates and open a reviewable PR (never touches main; never auto-merges). Invoke as `/ts-watch` for a manual/supervised run. This is the local counterpart to the weekly scheduled cloud routine. Use when the user wants to check for ThoughtSpot SDK releases or doc changes, or refresh the playground against upstream.
---

# ts-watch — one drift-detection & update cycle

You are the **Research & Intelligence department**. Read `docs/ts-watch-playbook.md` first — it holds
all the repo-specific conventions, guardrails, and per-category procedures. This skill is the manual
entry point; the weekly cloud routine runs the same playbook unsupervised.

## Steps

0. **Dedupe FIRST.** `gh pr list --state open --json number,headRefName,url` — if a branch starting
   `ts-watch/` is already open, this run UPDATES that PR (check out its branch, push refinements);
   never open a second ts-watch PR. Drift persists until a human merges, so skipping this step means
   a duplicate PR every run.
1. **Detect.** Run `node scripts/check-ts-updates.mjs --json`.
   - Exit `0` → no drift; report "nothing to do" and stop.
   - Exit `1` → an INTEGRITY error (e.g. pin drift between `ts-sdk-version.json` and `js/embed.js`,
     or an unreadable watermark). Report it and stop — do not paper over it.
   - Exit `10` → drift detected; continue. Warnings in the output are non-fatal (a rate-limited or
     timed-out source was skipped this run) — mention them in the PR body.
2. **Categorize & act** on each change as DOC / SDK BUMP / FEATURE STUB per the playbook. Follow the
   hard guardrails: never touch `main`, `server.js` guards, `smoke-test.mjs` assertions, `.env*`, or
   the token-mint logic; keep doc edits surgical with sourced claims; keep stubs additive + draft.
   - **SDK bump:** check the changelog for breaking changes to the symbols `js/embed.js` imports; a
     breaking change → document the migration in the PR, do NOT bump. A clean bump edits
     `ts-sdk-version.json` + the `js/embed.js` URL + the `// TS-SDK-VERSION:` marker together (keep
     all three equal) and re-vendors only if `vendor/` exists.
3. **Update the watermark** `docs/.ts-watch.json` (hashes, `lastSeenNpmLatest`,
   `lastProcessedGithubRelease`, `lastRun`, `lastRunOutcome`) in the same change, and refresh the
   `docs/ts-watch-snapshots/<url-slug>.txt` extracted-text snapshots so the next run can diff what
   actually changed on a page (see the playbook's snapshot convention).
4. **Verify.** `npm test` must pass (it includes the SDK-pin-consistency check). Never weaken it.
5. **PR.** Branch `ts-watch/YYYY-MM-DD`; one PR titled `ts-watch: <digest>` with the digest, per-claim
   sources, SDK old→new + breaking assessment, full smoke output, and the reviewer checklist. It
   touches guard-protected paths — **leave it OPEN for human review; do not merge. Never add the
   `human-approved` label; never use `gh pr merge --admin`.** If unsupervised (cloud routine), stop
   after opening the PR and let the human CEO decide.

## Notes
- Locally, if the SpotterCode MCP doc tools are available, use them to double-check ThoughtSpot claims
  — but the cloud runner may not have them, so the playbook never depends on them.
- One PR per run, ever — step 0 is what enforces it.
