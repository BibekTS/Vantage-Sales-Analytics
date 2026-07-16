# retros.md — the micro-retro log

One line per cycle: `- YYYY-MM-DD <cycle/ID>: <friction observed> → <action taken or M-row filed>`.
"No friction" entries are valid and worth recording — they establish that the process worked.
This log is the raw material for org retrospectives (BACKLOG M2).

- 2026-07-10 (M6): pre-dating this file — stranded BACKLOG Status edits and re-picked items led to
  the records-only-PR rule and the mandatory micro-retro → shipped as M6 (PR #10).
- 2026-07-10 (M7): retros before this date lived only in cycle reports and were lost with the
  session → this file created; the Records step now persists each micro-retro here.
- 2026-07-10 (M7): adversarial review of the org-v2 diff itself caught four structural defects
  pre-merge (gate-port races under the new parallelism, records-file append conflicts across
  parallel branches, an ambiguous "once the records PR is in", README contradicting itself on who
  merges to production) → all fixed in-PR; M8 filed for parallel-safe gate ports. Process changes
  deserve the same adversarial review as code.
- 2026-07-10 (M7): two interactive sessions shared one working tree — this session branch-switched
  and stashed a live S2 cycle's WIP mid-flight before noticing; state was restored and the M7 work
  moved to an isolated worktree → reinforced in the skill: sessions/agents that build in parallel
  ALWAYS take a worktree, never the shared checkout.
- 2026-07-13 (S3): the cycle adopted a dead cycle's uncommitted WIP found in the shared checkout
  (a full S3 implementation, no commit/PR, backlog still `open`). Routing it through research +
  3 adversarial lenses + `/code-review` + QA (rather than trusting or discarding it) paid off: the
  correctness lens caught an `answerList` stale-on-host-switch bug, and — critically — the fix for
  THAT (a `connect()` reset) *introduced* a last-write-wins race that only `/code-review` then
  caught. Lesson: a correctness fix is itself an unverified diff; re-review after fixing, don't just
  re-run gates. No process/skill friction — the playbook's fix→re-verify loop worked as written.
- 2026-07-13 (discover, parallel hunt ∥ drain): ran a find-only discovery hunt (4 lenses over the
  embed/runtime-filter ground) concurrently with an active S3 drain — safe because hunters are
  read-only and QA owned the gate ports. Multi-lens paid off twice: the correctness + data-integrity
  lenses independently confirmed the same cfb string-epoch bug (S14), and the regression lens REFUTED
  the correctness lens's low-confidence `onDone`-re-push suspicion by proving idempotency (dropped it
  pre-filing). Friction: the S3 drain committed + merged (#17) mid-hunt under the shared checkout, so
  the CEO re-read git state before filing and branched the records PR off the *post-#17* main — the
  worktree discipline held. Filed S13–S17. No skill change needed.
