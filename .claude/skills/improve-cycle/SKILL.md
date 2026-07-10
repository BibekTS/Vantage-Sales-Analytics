---
name: improve-cycle
description: Run one continuous-improvement cycle on the ThoughtSpot Embed Playground — the CEO reads BACKLOG.md, dispatches the departments (Research → Engineering → Review Board → QA → Operations → Records), and ships a verified PR. Invoke as `/improve-cycle` (top open backlog item), `/improve-cycle <ID>` (a specific item like S1), or `/improve-cycle N` to run N cycles back-to-back. Use when the user wants to work the backlog, ship the next improvement, or run the org's loop.
---

# improve-cycle — one turn of the continuous-improvement loop

You are the **CEO**. This skill runs one full cycle for the repo `BibekTS/Vantage-Sales-Analytics`.
Read `CLAUDE.md` first (rules, verification bar, protected paths). Then execute the departments in
order. Do the whole cycle before ending your turn; keep a TodoWrite list so progress is visible.

**Argument:** `$ARGUMENTS` may be a backlog ID (`S1`), a count (`3` = run three cycles), or empty
(take the highest-priority `open` item). If it is a count, repeat this whole playbook that many
times, re-reading `BACKLOG.md` each time.

## 1. CEO — pick the work
- Read `BACKLOG.md`. Choose the item (arg, or top `open` by priority). If none are open, report that
  the backlog is clear and stop.
- Mark it `in-progress` in `BACKLOG.md` (a working-tree edit; committed later on the branch).
- **Re-verify the item still applies** — several findings predate later fixes. If the current code
  already satisfies the acceptance criteria, mark it `done` with the commit ref and either stop or
  move to the next item (if running a count).

## 2. Research & Intelligence — brief the area
- For anything non-trivial, spawn an `Explore` agent to map the exact functions, files, and call
  sites the item touches, and to surface existing utilities to reuse (do NOT write new code that
  duplicates an existing helper). Skip only for small, precisely-known edits.

## 3. Engineering — design & build
- Spawn a `Plan` agent with the Research brief for a concrete implementation plan (files, functions,
  the reuse points). Review it against the acceptance criteria.
- Create a branch: `improve/<ID>-<slug>` off the latest `main` (`git fetch && git checkout -b …`).
- Implement. For parallel/independent items use **worktree isolation**; a single-item cycle can work
  the branch directly. Follow every rule in `CLAUDE.md` (state.js sanitize discipline, `textContent`
  not `innerHTML`, `embed.destroy()` before re-render, numeric/UTC date epochs, `pushRuntimeFilters`).

## 4. Review Board — audit before shipping
- Run `/code-review` (medium or higher) on the diff. Fix every **confirmed** correctness finding.
- If the diff touches auth, serialization, the server, or anything security-adjacent, also run
  `/security-review`.
- For higher assurance on risky changes, adversarially verify the top findings (spawn skeptic agents
  prompted to refute each) before accepting the diff as clean.

## 5. QA — prove it works (the gate)
Run all three, capture the output for the PR body:
1. **ESM parse** — copy each changed `js/*.js` to `.mjs` and `node --check`, or rely on the boot.
2. **`npm test`** — must be green (22/22 today). Never weaken an assertion.
3. **Headless boot** — start the server, load http://localhost:3000 in headless Chrome
   (puppeteer-core + system Chrome, `createRequire` at the project root). Assert the tool shell
   mounts, **0 JS errors**, only the known `/favicon.ico` 404. Add the item's **feature-specific**
   check here (e.g. for an XSS fix, inject a payload and assert it does not execute).

If any gate fails, fix and re-run. Do not proceed to a PR on red.

## 6. Operations — ship
- Commit (message ends with the `Co-Authored-By: Claude Fable 5` trailer), push, and open a PR with
  an **evidence section**: paste the smoke result, the headless summary, and the review outcome. PR
  body ends with the `🤖 Generated with [Claude Code]` line.
- Wait for CI (`CI / smoke`) to report.
- **Auto-merge if ALL hold:** CI green ∧ code review found no confirmed correctness bug ∧ the diff
  touches **no protected path** (`server.js`, `js/state.js`, `scripts/smoke-test.mjs`, `.env*`,
  `.github/workflows/*`, `CLAUDE.md`, `BACKLOG.md` priority edits). Merge with `gh pr merge --squash`.
- **Otherwise** (protected path, red CI, or any unresolved finding): leave the PR open, set status
  `in-review` in the backlog, and **report to the user** what needs their decision. Do not merge.

## 7. Records — close the loop
- Update `BACKLOG.md`: set the item `done` (or `in-review`) with a one-line outcome + PR link.
  Commit that to the same branch/PR so the queue and the code move together.
- If the work surfaced new issues, append them as new backlog rows.
- Report a concise summary: what shipped, the evidence, and the next open item the CEO would pick.

## Guardrails
- One item per cycle unless explicitly batching. Small, reviewable diffs.
- Never weaken `npm test` or the server's fail-closed guards to make something pass.
- When genuinely blocked on a product decision (not a mechanical choice), stop and ask — don't guess
  in code.
