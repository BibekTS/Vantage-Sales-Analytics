---
name: ceo-improve-cycle
description: Run one continuous-improvement cycle on the ThoughtSpot Embed Playground — the CEO reads BACKLOG.md, dispatches the departments (Research → Engineering → Review Board → QA → Operations → Records), and ships a verified PR. Invoke as `/ceo-improve-cycle` (top open backlog item), `/ceo-improve-cycle <ID>` (a specific item like S1), or `/ceo-improve-cycle N` to run N cycles back-to-back. Use when the user wants to work the backlog, ship the next improvement, or run the org's loop.
---

# ceo-improve-cycle — one turn of the continuous-improvement loop

You are the **CEO**. This skill runs one full cycle for the repo `BibekTS/Vantage-Sales-Analytics`.
Read `CLAUDE.md` first (rules, verification bar, protected paths). Then execute the departments in
order. Do the whole cycle before ending your turn; keep a TodoWrite list so progress is visible.

**Argument:** `$ARGUMENTS` may be a backlog ID (`S1`), a count (`3` = run three cycles),
`discover` (hunt for NEW bugs instead of building — see "Discovery mode" below), or empty (take
the highest-priority `open` item). If it is a count, repeat this whole playbook that many times,
re-reading `BACKLOG.md` each time.

## 1. CEO — pick the work
- Read `BACKLOG.md`. Choose the item (arg, or top `open` by priority). An item stuck `in-progress`
  with NO matching open PR is a dead cycle's leftover — treat it as `open` and reclaim it. If
  nothing is open, report that the backlog is clear and stop.
- **Re-verify the item still applies** — several findings predate later fixes. If the current code
  already satisfies the acceptance criteria, ship a **records-only PR**: branch
  `records/<ID>-verified-done` off latest `main`, set the row to `done` with a one-line note and
  the commit ref, open the PR (`BACKLOG.md` is not guard-protected, so it auto-merges under the
  normal conditions). Never leave the Status edit uncommitted — the remote queue would still say
  `open` and every future cycle would re-pick the item. Then stop or move to the next item (if
  running a count).

The department agents live in `.claude/agents/` — `researcher`, `architect`, `implementer`,
`reviewer`, `qa-verifier`. If a named agent is unavailable (e.g. a fresh clone before agent
discovery), fall back to the built-ins noted per step.

## 2. Research & Intelligence — brief the area
- For anything non-trivial, spawn the **`researcher`** agent (fallback: built-in `Explore`) to map
  the exact functions, files, and call sites the item touches, and to surface existing utilities to
  reuse (do NOT write new code that duplicates an existing helper). Skip only for small,
  precisely-known edits.

## 3. Engineering — design & build
- Spawn the **`architect`** agent (fallback: built-in `Plan`) with the Research brief for a concrete
  implementation plan (files, functions, the reuse points). Review it against the acceptance criteria.
- Create a branch: `improve/<ID>-<slug>` off the latest `main` (`git fetch && git checkout -b …`).
  Only NOW mark the item `in-progress` in `BACKLOG.md`, so the edit lives on the branch — marking
  it before branching leaves a dirty tree that can collide with pulling the latest `main`.
- Implement: work the branch directly, or delegate to the **`implementer`** agent (fallback:
  `general-purpose`) with the approved plan. For parallel/independent items use **worktree
  isolation**. Follow every rule in `CLAUDE.md` (state.js sanitize discipline, `textContent`
  not `innerHTML`, `embed.destroy()` before re-render, numeric/UTC date epochs, `pushRuntimeFilters`).

## 4. Review Board — audit before shipping
- Run `/code-review` (medium or higher) on the diff. Fix every **confirmed** correctness finding.
- If the diff touches auth, serialization, the server, or anything security-adjacent, also run
  `/security-review`.
- For higher assurance on risky changes, spawn **`reviewer`** agents — one per lens (correctness /
  security / regression) — prompted to REFUTE the diff, before accepting it as clean.

## 5. QA — prove it works (the gate)
Delegate to the **`qa-verifier`** agent (or run yourself), capturing output for the PR body:
1. **ESM parse** — copy each changed `js/*.js` to `.mjs` and `node --check`.
2. **`npm test`** — all checks green. Never weaken an assertion; never hardcode the check count.
3. **`npm run boot-check`** — the headless frontend gate (tool shell mounts, 0 JS errors, only the
   known `/favicon.ico` 404). Then add the item's **feature-specific** check (e.g. for an XSS fix,
   inject a payload and assert it does not execute).

If any gate fails, fix and re-run. Do not proceed to a PR on red.

## 6. Records — update the queue BEFORE shipping
- On the SAME branch, update `BACKLOG.md`: set the item's Status (`done` pending merge, or
  `in-review`) with a one-line outcome. Commit it so the queue and the code merge together —
  a squash-merged branch is gone; a Records commit made after merging is lost and the item
  would be re-picked forever.
- **Bright line:** a cycle may only change the Status column, append outcome notes, and append new
  rows. Never change Priority values, edit acceptance criteria, or delete rows — that is the human
  CEO's lever.
- If the work surfaced new app issues, append them as S-rows. **If the PROCESS misbehaved** — a gate
  missed something, a rule was ambiguous, effort was duplicated, a skill or agent instruction was
  wrong or unclear — append an M-row (goal 3: the org improves itself). The org's own machinery
  (`.claude/skills/*`, `.claude/agents/*`, `docs/*-playbook.md`, `BACKLOG.md`) is deliberately NOT
  guard-protected: improvements to it ship through the same branch-and-PR flow as app code.

## 7. Operations — ship
- Commit (message ends with the `Co-Authored-By: Claude Fable 5` trailer), push, and open a PR with
  an **evidence section**: paste the smoke result, the boot-check summary, and the review outcome.
  PR body ends with the `🤖 Generated with [Claude Code]` line.
- Wait for the required checks: `smoke`, `esm-parse`, `guard` (plus advisory `boot`).
- **Auto-merge if ALL hold:** every required check green ∧ code review found no confirmed
  correctness bug ∧ `guard` passed WITHOUT the `human-approved` label. Merge with
  `gh pr merge --squash`. Remember: **merging deploys to production (Vercel)**.
- **Otherwise** (guard red = protected path, any red check, or an unresolved finding): leave the PR
  open, make sure the backlog row says `in-review`, and **report to the user** what needs their
  decision. **Never add the `human-approved` label yourself, never use `gh pr merge --admin`.**
- After a merge: if running multiple cycles, `git checkout main && git pull` before the next pick so
  cycle N+1 reads the post-merge queue.

## 8. Report
- A concise summary: what shipped, the evidence, any M-items filed, and the next open item the CEO
  would pick.
- **Micro-retro (mandatory):** one line answering "did any skill, agent definition, or playbook
  instruction mislead, block, or slow this cycle?" If yes: fix it in this same PR when trivial
  (those files are not guard-protected), otherwise file an M-row. "No friction" is a valid answer;
  silence is not.

## Discovery mode (`/ceo-improve-cycle discover`)

The seeded audit items drain over time; discovery restocks the queue. A discovery cycle FINDS
bugs, it does not fix them — finding and fixing stay in separate cycles so every diff stays small
and reviewable.

1. **Pick a hunting ground** the backlog doesn't already cover: an app area (a `js/*.js` module or
   subsystem), the diff range since the last discovery run, or one `CLAUDE.md` critical rule to
   audit everywhere it applies.
2. **Fan out `reviewer` agents**, one per lens (correctness / security / regression), each prompted
   to find NEW failures with a concrete failure scenario. A finding without a failure scenario is
   an opinion — drop it.
3. **Dedupe and verify**: discard findings that duplicate an existing BACKLOG row or each other,
   then re-verify each survivor against the current code (the reviewer may have read stale context).
4. **Records**: append the confirmed findings as S-rows with testable acceptance criteria, via a
   records-only PR (same flow as an already-satisfied item in step 1).
5. **Report** what was hunted, what was found, what was filed — and the micro-retro.

## Guardrails
- One item per cycle unless explicitly batching. Small, reviewable diffs.
- Never weaken `npm test`, `boot-check`, the `guard` job, or the server's fail-closed guards.
- Never add the `human-approved` label; never bypass a red required check.
- When genuinely blocked on a product decision (not a mechanical choice), stop and ask — don't guess
  in code.
