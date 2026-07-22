# Bootstrap prompt — stand up a self-improving agent "org" in any repo

This is a portable, copy-paste prompt that reproduces the **CEO + departments** operating model
this project runs on, in *another* repository. Paste the fenced block below into a fresh Claude
Code session **inside the target repo** and it will discover the stack and scaffold the whole org:
a constitution, six department agents, a CEO orchestrator skill, a governed backlog, three memory
stores, and a CI `guard` job.

**Configuration baked into this version:**
- **Full governance** — constitution + protected paths, CI `guard` job, `human-approved` label,
  three durable memory stores, an S/R/W/M backlog taxonomy.
- **Human-gated** — every cycle ends at an **open PR for your review**. Nothing auto-merges to `main`.
  (To later enable auto-merge of clean PRs, flip the autonomy rule in the generated `CLAUDE.md`
  and add an auto-merge step to the skill's SHIP phase.)

Optional: replace `<owner/repo>` on the first line if `gh` isn't already pointed at the right remote.

---

## The prompt

```text
You are bootstrapping a self-improving, multi-agent "organization" into THIS repository —
the same operating model a mature agent-run project uses to manage itself end to end:
find bugs, keep the code correct/efficient/performant, and fix issues through an automated
loop that ALWAYS stops at a pull request for human review (nothing auto-merges to main).

Target GitHub repo: <owner/repo>   (if blank, infer from `git remote -v`; if no remote, note it)

Work in PLAN-then-BUILD mode: first DISCOVER, then propose the scaffold, then create the files.
Do not modify product code during bootstrap — you are only adding the org's operating layer.

════════════════════════════════════════════════════════════════════════
STEP 0 — DISCOVER THE PROJECT (do this first; everything below is tailored to it)
════════════════════════════════════════════════════════════════════════
Detect and write down, from the actual repo (package.json / Makefile / pyproject / go.mod /
CI config / README):
  • Language(s), framework, package manager, and whether there's a build step.
  • The real commands for: install, run/dev, TEST, LINT/format, TYPECHECK, BUILD, and any
    smoke/e2e/health check. Use what exists — do NOT invent scripts. If a gate is missing
    (e.g. no tests), note it as a gap to add later, don't fake it.
  • The 3–8 most important entry points / modules and what each does (one line each).
  • The SECURITY/RISK surface: auth, secrets/.env, input sanitization, anything that fails
    OPEN vs fail-closed, deploy path (does merging main deploy to prod?).
  • Existing conventions (style, module system, error handling) so agents match them.
Summarize this back to me before creating files, and STOP if the repo is empty or you can't
find a test command — ask me how to verify changes.

════════════════════════════════════════════════════════════════════════
STEP 1 — THE CONSTITUTION:  ./CLAUDE.md
════════════════════════════════════════════════════════════════════════
Create CLAUDE.md — the durable, auto-loaded contract every agent reads first. Sections:
  1. What this is — one paragraph on the project + its stack.
  2. Run & verify — a table of the REAL commands from Step 0, and a "verification bar for ANY
     change" list (typically: lint/typecheck ∧ tests green ∧ build/smoke passes). Name them
     explicitly; state "never weaken a gate to pass."
  3. Architecture — the entry points/modules from Step 0, one line each.
  4. Critical rules — the invariants that, if violated, break the app (derive from Step 0's
     risk surface: e.g. "server fails closed", "all untrusted strings via textContent not
     innerHTML", "always destroy() before re-render" — whatever THIS repo's traps are).
  5. Protected paths — the files an autonomous agent must NOT change without a human:
     the security layer, test assertions, CI config, secrets/.env*, and CLAUDE.md ITSELF
     (so the rules can't self-amend). List them literally.
  6. How the org works — paste the "Operating model" block below, adapted.

  ▸ Operating model (put this in CLAUDE.md verbatim, adjusted to the repo):
    - Three standing goals, in precedence order: (1) improve the app — stability, features,
      refactors; (2) keep it current — track upstream/dependency drift; (3) improve the org
      itself — sharpen the agents/skills/gates; file a process item whenever a cycle exposes
      a gate that missed something or an ambiguous rule.
    - The CEO is the orchestrating session ONLY; it dispatches departments and does not do
      department work itself. Independent agents run in PARALLEL (one message, multiple
      spawns); dependent stages (research → design → build) stay sequential.
    - Departments = the named agents in .claude/agents/. Every change is a branch + PR with a
      verification-evidence section. NOTHING auto-merges — every PR stops for human review.
    - Three memory stores (see docs/org-memory/README.md): CLAUDE.md = Rules (human-approved
      PRs only), BACKLOG.md = Tasks (cycles change Status/notes/append rows ONLY), and
      docs/org-memory/ = Facts (written at the Records step, read before every task).
    - Protected-path safety: a CI `guard` job fails any PR touching a protected path unless a
      human adds the `human-approved` label. Agents NEVER add that label, NEVER use
      `gh pr merge --admin`, NEVER weaken the guard or any gate. A red guard means "hand to human."

════════════════════════════════════════════════════════════════════════
STEP 2 — THE DEPARTMENTS:  .claude/agents/*.md
════════════════════════════════════════════════════════════════════════
Create one markdown file per agent. Frontmatter: `name`, `description` (the description doubles
as the CEO's dispatch rule — "use this WHEN…"), and a `tools:` line that ENFORCES read-only vs
writer. Every agent's body starts with a boot sequence ("read CLAUDE.md, then
docs/org-memory/codebase.md before any work") and ends with a "Memory-worthy" hand-back section.

  • researcher   — tools: Read, Glob, Grep, Bash(read-only).  Runs BEFORE design. Maps the exact
                   files/functions/call-sites an item touches, flags risks, and — critically —
                   finds the existing helper to REUSE ("new code that duplicates a helper is a
                   review failure"). Returns a structured brief.
  • architect    — tools: Read, Glob, Grep.  Read-only DESIGN desk. Turns a backlog item + the
                   research brief into a plan: Approach (smallest change that meets the
                   acceptance criteria) · Ordered steps (per file, exact functions) · What NOT to
                   touch (protected paths; never mix a refactor with a behavior change) ·
                   Verification plan. It designs; it does not build.
  • implementer  — tools: (all — the ONLY writer).  Executes an approved plan ON A BRANCH (never
                   main), matches codebase style, runs the gates before handing back, records any
                   deviation from the plan. COMMITS its work to its branch before handing back —
                   UNCONDITIONALLY, green or red (a red gate is reported, not a reason to leave the
                   tree dirty) — never leaves the fix only in the shared working tree, and returns
                   the commit SHA. Stages only the paths its plan named: never `git add -A` /
                   `commit -am`, which sweeps a concurrent session's edits into its commit; if
                   `git status` shows untouched files, it stops and reports. Never adds the
                   human-approved label, never merges.
  • reviewer     — tools: Read, Glob, Grep, Bash.  ADVERSARIAL. "Assume the diff is wrong and hunt
                   the evidence." Spawned one-per-LENS (correctness / security / regression /
                   performance). Every finding needs a concrete FAILURE SCENARIO — one without is
                   an opinion, drop it. Grades findings CONFIRMED / PLAUSIBLE. Does NOT run the
                   port-binding gates (QA owns those). Reviews an IMMUTABLE artifact — the
                   implementer's commit SHA (`git show <SHA>:<path>`) or a saved patch — never the
                   live working tree; if it is reviewing a CHANGE and was given neither, it asks for
                   one before reviewing. CARVE-OUT: that rule is scoped to change review. When the
                   same agent is dispatched to HUNT an area (it is the bug-hunter fallback) there is
                   no diff and no SHA by definition — it reads the current code at the ref it was
                   given and hunts. It must never refuse a hunt for want of a SHA.
  • qa-verifier  — tools: Bash, Read, Glob, Grep.  The GATE. Runs the full bar in order
                   (lint/typecheck → tests → build/smoke → a feature-specific check from the
                   item's acceptance criteria) and reports output VERBATIM. Runs the bar in a
                   disposable worktree checked out at that SHA, so a mutation test (revert the fix,
                   prove the probe fails) never touches the shared checkout. Asks for a SHA if given
                   only a branch — never substitutes HEAD, never falls back to the shared checkout —
                   and asserts it is an ancestor of that branch. NOTE for the worktree recipe: an
                   agent's cwd and shell variables do NOT survive between Bash calls, so the setup
                   call must ECHO the absolute scratch path, every later command must be a
                   self-contained chain starting `cd <literal absolute path> && …`, and cleanup must
                   use `git -C <repo root> worktree remove --force <path> && git -C <repo root>
                   worktree prune` (cwd-independent, so it exits 0 from inside the deleted tree).
                   Verifies; never fixes, never weakens a test. If a gate is red, report precisely
                   and stop.
  • bug-hunter   — tools: Read, Glob, Grep, Bash.  DISCOVERY. Hunts NEW, unfiled bugs in an
                   assigned hunting-ground × lens (correctness / security / regression /
                   data-integrity / performance). Every finding carries a failure scenario +
                   drafted, testable acceptance criteria (so it can become a backlog row). Grades
                   CONFIRMED / PLAUSIBLE. Also reports "audited X, found clean."
  (Add a perf-focused lens to reviewer/bug-hunter since you specifically want efficiency/
   performance covered: allocations in hot paths, N+1 / repeated work, unbounded growth,
   blocking I/O, missing memoization/caching, bundle/asset weight.)

════════════════════════════════════════════════════════════════════════
STEP 3 — THE CEO ORCHESTRATOR SKILL:  .claude/skills/improve-cycle/SKILL.md
════════════════════════════════════════════════════════════════════════
Create a skill that codifies ONE improvement cycle. Frontmatter `name: improve-cycle` + a
`description` covering its invocation modes: `/improve-cycle` (top open backlog item),
`/improve-cycle <ID>` (a specific item), `/improve-cycle N` (N cycles; parallel git worktrees
when the items' product files are disjoint), `/improve-cycle discover` (hunt & FILE new bugs),
`/improve-cycle discover fix` (hunt, file, then fix). Body = these load-bearing rules + phases:

  Framing: "You are the CEO — an orchestrator, not a department. Your context is the org's
  scarcest resource; spend it on decisions, not department work." + "Parallel dispatch: agents
  with no data dependency launch in ONE message so they run concurrently (review lenses,
  discovery hunters, research fan-out, Review Board ∥ QA); dependent stages stay sequential." +
  "Serialize the gates: test/smoke commands bind fixed ports — only ONE agent runs server-bound
  gates at a time; parallel worktree implementers run the cheap syntax/lint gate only."

  Phase pipeline (numbered):
   1. PICK — read BACKLOG.md; reclaim dead in-progress rows; RE-VERIFY the item still applies
      against current code (findings go stale). If already satisfied → records-only PR marking it done.
   2. RESEARCH — spawn researcher(s) (fallback: Explore); fan out one per area for large items.
   3. DESIGN & BUILD — architect drafts the plan → you check it against acceptance criteria →
      create branch `improve/<ID>-<slug>`, mark the row in-progress ON THE BRANCH → implementer
      builds. Independent items → worktree-isolated implementers, one each.
   4. REVIEW ∥ QA — launch the Review Board (reviewer per lens, each told to REFUTE) AND
      qa-verifier together in one message — both given the implementer's commit SHA, not the
      working tree. Also run /code-review and /security-review if available.
      Fix every CONFIRMED finding (re-dispatch implementer), then RE-RUN QA — a diff that changed
      after verification is unverified. Express the re-run carve-out as an ALLOW-LIST, never a
      deny-list of "product paths" (a deny-list fails open — a post-QA edit to package.json or to
      the org's own .claude/* files would slip through un-reverified): a commit touching NOTHING
      EXCEPT the records files (BACKLOG.md, docs/org-memory/*) does not invalidate review or QA;
      EVERY other commit does, whatever it touches. There is no third category.
   5. QA BAR — lint/typecheck → tests → build/smoke → feature-specific check. Do not PR on red.
   6. RECORDS (before shipping, on the same branch) — update BACKLOG.md Status + commit it; fold
      every agent's Memory-worthy facts into docs/org-memory/codebase.md; append a one-line
      micro-retro to docs/org-memory/retros.md. Bright line: cycles may ONLY change Status,
      append notes, and append rows — never edit Priority/criteria or delete rows.
   7. SHIP — commit + push + open a PR with an evidence section (gate output, review outcome).
      STOP HERE. Do not merge. Set the row in-review and report to me. (Never add human-approved,
      never --admin.)
   8. MICRO-RETRO (mandatory) — one line: "did any agent/skill/rule mislead or slow this cycle?"
      Fix trivially in the same PR or file a process (M) row. "No friction" is a valid answer.

  Discovery mode: pick a hunting ground the backlog doesn't cover (skip recently-audited-clean
  ones per org-memory) → fan out bug-hunters in parallel, one per lens → dedupe + re-verify
  survivors → file CONFIRMED findings as new backlog rows via a RECORDS-ONLY PR (finding and
  fixing never share a diff). `discover fix` then waits for that PR to merge, pulls main, and runs
  phases 2–8 per finding. Plain `discover` stops after filing.

════════════════════════════════════════════════════════════════════════
STEP 4 — GOVERNANCE FILES
════════════════════════════════════════════════════════════════════════
  ▸ ./BACKLOG.md — a table: | ID | P | Item | Acceptance criteria | Status | Protected |.
    ID taxonomy MIRRORS the three standing goals: S = stability/features, R = refactors,
    W = keep-current/drift, M = org/process improvements. Priority P1–P4. Status values:
    open · in-progress · in-review · done. Header prose states the bright line (cycles change
    Status/notes/append rows only; Priority & criteria are the human's lever). Seed it with a
    few real rows from Step 0's findings (e.g. the missing-gate gap, obvious perf items).
  ▸ docs/org-memory/README.md — the memory model, with this table:
        | Store | Holds | Changed by |
        | CLAUDE.md | Rules (constitution) | human-approved PRs only (protected) |
        | BACKLOG.md | Tasks (work queue) | every cycle — Status/notes/new rows only |
        | docs/org-memory/ | Facts (discoveries) | every cycle, at the Records step |
     + conventions: read before work; write at Records time; one dated bullet per fact with
     `file:line` evidence + originating cycle/PR; delete when falsified; promote a hardened fact
     up into CLAUDE.md; keep it pruned (~120 lines).
  ▸ docs/org-memory/codebase.md — verified facts about the code, topical ## sections, entry
     format: `- YYYY-MM-DD (ID/PR): claim with file:line evidence`. Seed with Step 0 facts.
  ▸ docs/org-memory/retros.md — one line per cycle:
     `- YYYY-MM-DD <ID>: <friction observed> → <action or M-row filed>`.

════════════════════════════════════════════════════════════════════════
STEP 5 — THE MECHANICAL GATE:  .github/workflows/ci.yml
════════════════════════════════════════════════════════════════════════
Create (or extend) a CI workflow triggered on pull_request to main (INCLUDE the `labeled` /
`unlabeled` types so the guard re-evaluates when a human toggles the label) and push to main.
Jobs — use the REAL commands from Step 0:
  • test/lint/build jobs — run the project's actual gates. Mark them required.
  • guard job (pull_request only) — the governance gate:
      env: HUMAN_APPROVED = contains(pr.labels.*.name, 'human-approved')
      diff changed files vs origin/base; if any match a PROTECTED path
      (the security layer, test assertions, .github/workflows/*, .env*, CLAUDE.md — the exact
      list from Step 1) AND HUMAN_APPROVED != true → print the offending paths and exit 1.
Since NOTHING auto-merges in this setup, the CEO always stops at the PR; the guard simply makes it
impossible for an agent to quietly touch a protected file without a human noticing. Document in
CLAUDE.md: a PR is ready for a human to merge only when required checks are green ∧ review found no
CONFIRMED correctness bug ∧ guard is green. Agents never merge, never add the label, never --admin.

════════════════════════════════════════════════════════════════════════
STEP 6 — WRAP UP
════════════════════════════════════════════════════════════════════════
  • If the repo lacks a test or smoke command, add a minimal one now (or file it as the first
    S row) — the whole loop depends on a real verification bar.
  • Print a summary: every file created, the detected commands, the protected-path list, and the
    exact first command for me to run: `/improve-cycle discover` (hunt bugs & perf issues and
    file them) or `/improve-cycle` (work the top backlog item). Then STOP — do not start a cycle
    or open any PR until I tell you to.

Guardrails for the whole bootstrap: don't touch product code, don't invent commands that don't
exist, don't enable any auto-merge, and surface anything ambiguous instead of guessing.
```

---

## How this maps to this repo's org (the source it was generalized from)

| This project | Generalized in the prompt |
|---|---|
| `CLAUDE.md` constitution + protected paths | Step 1 (same, list derived per-repo) |
| `.claude/agents/{researcher,architect,implementer,reviewer,qa-verifier,bug-hunter}.md` | Step 2 (same six + a perf lens) |
| `.claude/skills/ceo-improve-cycle/SKILL.md` | Step 3 (same phase pipeline + discover/fix modes) |
| `BACKLOG.md` (S/R/W/M taxonomy, bright line) | Step 4 |
| `docs/org-memory/{README,codebase,retros}.md` (3-store model) | Step 4 |
| `.github/workflows/ci.yml` `guard` job + `human-approved` label | Step 5 |
| Auto-merge clean PRs (Vercel deploy) | **Removed** — every PR stops for human review |

## Verifying the scaffold after you run it

1. **Files exist:** `CLAUDE.md`, `.claude/agents/*.md` (6), `.claude/skills/improve-cycle/SKILL.md`,
   `BACKLOG.md`, `docs/org-memory/{README,codebase,retros}.md`, `.github/workflows/ci.yml`.
2. **Gates are real:** the commands named in `CLAUDE.md` and `ci.yml` actually run in that repo.
3. **Dry-run the loop:** `/improve-cycle discover` should fan out bug-hunters, file findings as
   backlog rows via a records-only PR, and STOP (no fix, no merge). Then `/improve-cycle discover fix`
   on a small finding should produce one verified PR left open for review.
4. **Guard works:** open a PR that edits a protected path without the `human-approved` label — the
   `guard` job must fail; a human adding the label turns it green.
