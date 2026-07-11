# org-memory — the organization's shared working memory

The org's stateless agents share three durable stores, each with one job:

| Store | Holds | Changed by |
|---|---|---|
| `CLAUDE.md` | **Rules** — the constitution, critical invariants | Human-approved PRs only (guard-protected) |
| `BACKLOG.md` | **Tasks** — the work queue | Every cycle (Status/notes/new rows only) |
| `docs/org-memory/` | **Facts** — what cycles have discovered and verified | Every cycle, at the Records step |

This directory is the third store. It exists so that knowledge earned in one cycle (a verified
fact, a sharp edge, a gotcha that cost an hour) is never re-derived by the next. It travels with
the repo, so local sessions, worktree agents, and the weekly cloud routine all read the same brain.

## Files

- **`codebase.md`** — verified facts about the code: traps, sharp edges, supersession claims,
  verification results. The researcher/reviewer/bug-hunter read this FIRST to avoid re-deriving
  or re-filing what's known.
- **`retros.md`** — the micro-retro log: one line per cycle on process friction and what was done
  about it. The raw material for M-items and org retrospectives (BACKLOG M2).

## Conventions (all agents)

1. **Read before work.** Every department agent reads `codebase.md` at the start of its task;
   cite a remembered fact instead of re-deriving it.
2. **Write at Records time.** Read-only agents end their report with a **Memory-worthy** section;
   the CEO (or the implementer, on its branch) folds those into these files in the same PR as the
   work. Memory merges with the code that produced it.
3. **One bullet per fact**, dated, with `file:line` evidence and the cycle/PR that established it.
   Update in place when a fact changes; **delete it when falsified** — stale memory is worse than
   none.
4. **Facts, not rules.** If a fact hardens into a rule every agent must obey, promote it to
   `CLAUDE.md` via a guard-protected PR and remove it here.
5. **Size discipline.** Keep each file under ~120 lines. When it grows past that, prune: merge
   duplicates, drop entries superseded by code or promoted to the constitution.
