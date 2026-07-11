---
name: ceo-improve-cycle
description: Run one continuous-improvement cycle on the ThoughtSpot Embed Playground — the CEO orchestrates the departments (Research → Engineering → Review Board ∥ QA → Records → Operations), dispatching independent agents in parallel, and ships a verified PR. Invoke as `/ceo-improve-cycle` (top open backlog item), `/ceo-improve-cycle <ID>` (a specific item like S1), `/ceo-improve-cycle N` (N cycles, parallel worktrees when items are independent), `/ceo-improve-cycle discover` (hunt for new bugs and file them), or `/ceo-improve-cycle discover fix` (hunt, file, then fix the confirmed findings). Use when the user wants to work the backlog, ship the next improvement, hunt bugs, or run the org's loop.
---

# ceo-improve-cycle — one turn of the continuous-improvement loop

You are the **CEO** — an orchestrator, not a department. This skill runs one full cycle for the
repo `BibekTS/Vantage-Sales-Analytics`. Read `CLAUDE.md` first (rules, verification bar, protected
paths), then the org memory (`docs/org-memory/codebase.md` + `retros.md` — facts and friction from
prior cycles). Then dispatch the departments. Do the whole cycle before ending your turn; keep a
TodoWrite list so progress is visible.

**The CEO delegates.** Your context is the org's scarcest resource — spend it on decisions
(picking work, judging findings, arbitrating between departments, merging), not on doing
department work. Research, design, building, reviewing, and verifying go to the named agents;
the CEO itself touches only glue: branching, `BACKLOG.md`/org-memory records, commits, PR and
merge operations. Direct hands-on work is the exception, reserved for edits too trivial to brief
(a one-line records fix), never the default.

**Parallel dispatch.** Agents with no data dependency between them launch **in a single message**
(multiple Agent calls) so they run concurrently — never serially await one independent agent
before starting the next. In this playbook that means: Review Board lenses (always), discovery
hunters (always), research fan-out across areas for a large item, and Review Board ∥ QA after a
build. Dependent stages (research → plan → build) stay sequential.

**Serialize the gates.** `npm test` (port 34917) and `npm run boot-check` (port 34921) bind
hardcoded localhost ports — two concurrent runs collide with `EADDRINUSE` and produce phantom
reds (see org-memory "Gates"; M8 tracks making them parallel-safe). Only ONE agent runs the
server-bound gates at any moment: in the Review Board ∥ QA phase the suite belongs to QA
(reviewers inspect, they don't start servers), and parallel worktree implementers run only the
ESM parse — the CEO has `qa-verifier` run the full bar serially, branch by branch.

**Argument:** `$ARGUMENTS` may be a backlog ID (`S1`), a count (`3` = run three cycles),
`discover` (hunt for NEW bugs — see "Discovery mode"), `discover fix` (hunt, then immediately fix
the confirmed findings — see "Discovery mode"), or empty (take the highest-priority `open` item).
If it is a count, run that many cycles, re-reading `BACKLOG.md` each time — and when the picked
items are **independent** (their researcher briefs prove disjoint **product** files — the records
files `BACKLOG.md` and `docs/org-memory/*`, which every branch edits, don't count), run their
Engineering→QA phases in parallel worktrees, one branch + PR per item, instead of back-to-back.
Items whose product-file sets overlap stay sequential. Merge parallel PRs **one at a time**: the
shared records files make same-position append conflicts likely, so after each merge rebase the
next branch on the updated `main` (`git pull --rebase origin main`, re-resolve the records
appends, push) before merging it.

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
`reviewer`, `qa-verifier`, `bug-hunter`. If a named agent is unavailable (e.g. a fresh clone
before agent discovery), fall back to the built-ins noted per step. Every agent reads the org
memory before working and reports **Memory-worthy** facts back; the CEO persists those at the
Records step (step 6).

## 2. Research & Intelligence — brief the area
- For anything non-trivial, spawn the **`researcher`** agent (fallback: built-in `Explore`) to map
  the exact functions, files, and call sites the item touches, and to surface existing utilities to
  reuse (do NOT write new code that duplicates an existing helper). Skip only for small,
  precisely-known edits.
- For a large item spanning multiple subsystems, fan out **several researchers in parallel** (one
  message), one per area, and merge the briefs yourself.

## 3. Engineering — design & build
- Spawn the **`architect`** agent (fallback: built-in `Plan`) with the Research brief for a concrete
  implementation plan (files, functions, the reuse points). Review it against the acceptance criteria.
- Create a branch: `improve/<ID>-<slug>` off the latest `main` (`git fetch && git checkout -b …`).
  Only NOW mark the item `in-progress` in `BACKLOG.md`, so the edit lives on the branch — marking
  it before branching leaves a dirty tree that can collide with pulling the latest `main`.
- Implement: delegate to the **`implementer`** agent (fallback: `general-purpose`) with the
  approved plan — the CEO does not build (glue-level records edits excepted). For
  parallel/independent items use **worktree isolation**, one implementer per item. The
  implementer follows every rule in `CLAUDE.md` (state.js sanitize discipline, `textContent`
  not `innerHTML`, `embed.destroy()` before re-render, numeric/UTC date epochs, `pushRuntimeFilters`).

## 4. Review Board ∥ QA — audit and verify in parallel
Once the diff is in hand, launch the Review Board and QA **together, in one message** — they are
independent reads of the same diff:
- **Review Board:** spawn **`reviewer`** agents, one per applicable lens (correctness always;
  security when the diff touches auth, serialization, the server, or DOM sinks; regression when it
  touches existing behavior) — all in the same message, each prompted to REFUTE the diff. Also run
  `/code-review` (medium or higher). For security-adjacent diffs, add `/security-review`.
- **QA (the gate):** delegate to the **`qa-verifier`** agent, capturing output for the PR body.

Fix every **confirmed** correctness finding (dispatch the implementer again), then **re-run QA** —
a diff that changed after verification is unverified.

## 5. QA — the bar the qa-verifier runs
1. **ESM parse** — copy each changed `js/*.js` to `.mjs` and `node --check`.
2. **`npm test`** — all checks green. Never weaken an assertion; never hardcode the check count.
3. **`npm run boot-check`** — the headless frontend gate (tool shell mounts, 0 JS errors, only the
   known `/favicon.ico` 404). Then add the item's **feature-specific** check (e.g. for an XSS fix,
   inject a payload and assert it does not execute).

If any gate fails, fix and re-run. Do not proceed to a PR on red.

## 6. Records — update the queue AND the memory BEFORE shipping
- On the SAME branch, update `BACKLOG.md`: set the item's Status (`done` pending merge, or
  `in-review`) with a one-line outcome. Commit it so the queue and the code merge together —
  a squash-merged branch is gone; a Records commit made after merging is lost and the item
  would be re-picked forever.
- **Persist memory on the same branch:** fold every agent's Memory-worthy facts into
  `docs/org-memory/codebase.md` (dated, file:line, deduped against what's already there — update
  or delete entries the cycle falsified), and append the cycle's micro-retro line to
  `docs/org-memory/retros.md`. Knowledge that stays in a report dies with the session.
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

## Discovery mode (`/ceo-improve-cycle discover` and `discover fix`)

The seeded audit items drain over time; discovery restocks the queue. Finding and fixing never
share a diff — a discovery PR files rows, each fix ships as its own small, reviewable PR. With
the `fix` argument the same run chains straight into fixing, so hunt-and-fix is one command.

1. **Pick a hunting ground** the backlog doesn't already cover: an app area (a `js/*.js` module or
   subsystem), the diff range since the last discovery run, or one `CLAUDE.md` critical rule to
   audit everywhere it applies. Check `docs/org-memory/codebase.md` first — grounds recorded as
   recently audited-clean are wasted hunts.
2. **Fan out `bug-hunter` agents in parallel — one message, one hunter per lens** (correctness /
   security / regression / data-integrity; fallback: built-in `Explore`), each assigned the
   ground and its single lens. Every finding needs a concrete failure scenario — a finding without
   one is an opinion and gets dropped.
3. **Dedupe and verify**: discard findings that duplicate an existing BACKLOG row or each other,
   then re-verify each survivor against the current code (the hunter may have read stale context).
4. **Records**: append the confirmed findings as S-rows with testable acceptance criteria, via a
   records-only PR (same flow as an already-satisfied item in step 1). Persist the hunt's
   Memory-worthy facts — including grounds that came back clean — per step 6.
5. **`fix` argument only — chain into fix cycles:** wait for the records PR to actually **merge**
   (records-only, so it auto-merges under the normal conditions), then `git checkout main &&
   git pull` so the new rows exist on `main` before any fix branch is cut — branching earlier
   strands the `in-progress` Status edit and duplicates rows. Then run the standard playbook
   (steps 2–8) on each newly-filed finding, highest priority first. Independent findings
   (disjoint product files — records files don't count, see "Parallel dispatch") get parallel
   worktrees, one implementer, one branch, one PR each, merged one at a time with rebases in
   between; overlapping ones go sequentially. Plain `discover` stops after filing.
6. **Report** what was hunted, what was found, what was filed (and, with `fix`, what shipped) —
   and the micro-retro.

## Guardrails
- One item per cycle unless explicitly batching. Small, reviewable diffs.
- Never weaken `npm test`, `boot-check`, the `guard` job, or the server's fail-closed guards.
- Never add the `human-approved` label; never bypass a red required check.
- When genuinely blocked on a product decision (not a mechanical choice), stop and ask — don't guess
  in code.
