---
name: executing
description: Land the plan — test first, one task per iteration, verified by a fresh skeptic per batch, committed with its SHA in a ledger that a compacted successor can resume from, with the long-running rules and a literal completion promise.
phase: execute
---

# Executing

## Depth by rung

- **R0 and R1**: do it yourself (or one implementer for files you have not read). Test first:
  write the test, watch it fail, implement, watch it pass, run the neighbouring suite, commit.
  Self-skeptic: apply the mutation your test claims to catch. `PROGRESS.md` gets one row.
- **R2 and R3**: the loop below with `LOOP-BRIEF.md` and `PROGRESS.md`. Independent tasks
  can run in parallel implementers launched in one message; dependent ones run in order.
- **R4**: the loop per phase, in waves; phase close at the end of each phase; the Stop hook
  is your loop driver and the completion promise is your stop condition.

## The two disciplines

You will be compacted without warning and you will not know what you lost. So:

1. **You are a dispatcher, not an implementer**, above R1. Your per-task context cost is one
   task spec out, one result summary back, one verdict. Never hold a whole plan, spec or diff
   in context; read the plan around the active task only.
2. **Write the ledger before you would need it, never after.** Update it at every landing.

## The loop brief

`LOOP-BRIEF.md` is short and static: branch and worktree names, build and test commands, the
box's quirks (which suite must run in chunks, which preset deadlocks), the model map for this
run, the job-slot rule, the completion promise, and the owner's dated rulings. Re-read it on
every entry.

## The ledger

`PROGRESS.md` holds what a successor needs and nothing else:

| Section | Holds |
|---|---|
| Cursor | current phase and task, what is next |
| Task rows | id · status · commit SHA · one-line note · attempts |
| Known-failure baseline | the failures inherited at the start, each attributed |
| Coordination notes | edits outside a task's allowlist |
| Deviations | where the implementation departed from the plan, and why (batched into an amendment at phase close) |
| Gate queue | open owner gates by id, what they block, what continues meanwhile |
| Box notes | commands, tool gaps, platform traps, the moment you learn them |

Timestamps come from the clock in the same step. Where the ledger and git disagree, git is
the truth: reconcile, note it, continue.

## One iteration, one task

1. **Pick** the next task from the cursor. One task, or one tightly coupled group that cannot
   be split. Never "a few to save time".
2. **Dispatch** an implementer with the task's what and how verbatim, its file allowlist, the
   test names and discriminators, the relevant grounding facts, the build and test commands
   from the box notes, and the model named (sonnet only when the plan fully determines the
   code, otherwise opus). It writes tests first, makes them pass, runs only its own targeted
   tests, commits with the task id as prefix, returns a done signal with the counts it saw or
   a stuck report. It never widens scope, weakens a test or improvises around a contradiction.
3. **Verify adversarially**, not delegable to the implementer: mechanically what you can (run
   the named tests, read the output), and a fresh opus skeptic per batch per the `reviewing`
   skill.
4. **Fix**: two fixer rounds per task, then take it over yourself.
5. **Land**: commit per task, tick the plan with the SHA, write the ledger, then the next
   task.

## Hard rules

- Verify the branch in the same command as the commit:
  `[ "$(git branch --show-current)" = <branch> ] && git commit …`. In a submodule tree, every
  submodule you touch. Never `git add -A`.
- One build at a time across you and every subagent; take the job-slot semaphore when the
  box has one, and a refusal is final.
- Builds and tests run in the foreground with a generous timeout while a Stop hook is armed.
  Anything over a minute otherwise runs detached and logs to a file, with a stall watchdog at
  a tenth of the expected duration; liveness is mtimes and log growth, never a report.
- Never claim a test result you did not see. Paste the counts.
- A flaky test is recorded as flaky, not as fixed. A pre-existing failure is attributed, then
  fixed; never dismissed.
- Do not fix unrelated breakage you stumble on: a coordination note, and keep going.
- Every landing is buildable. An iteration ends with the repo committed or with an explicit
  WIP note in the ledger.

## Phase close (R2 and above)

Run each step, and record N/A with a reason for any you skip; never tick a step you did not
run.

1. Ledger check: every task row has a status and a SHA.
2. The plan's validation commands, verbatim.
3. The phase e2e against the real application.
4. Gestalt gate where the phase built or changed a user-visible surface (`validating` skill).
5. One simplification pass over the phase diff: remove mechanisms the spec did not ask for,
   dead surface, disproportionate machinery; subtract, never add; behaviour unchanged.
6. Owner gates the phase owes, written as gate files, queued.
7. Deviations batched into one spec amendment.
8. The scoped gate (touched crates plus direct importers), once, started detached while the
   next phase begins, timeboxed at 30 minutes; decide CLOSE, DO NOT CLOSE or CLOSE WITH GAPS.

## Completion promise (R4)

The loop brief names a literal string emitted only when every success criterion is green and
every phase closed. Never emit it to escape a long build, a flaky test or fatigue. Blocked
means three distinct attempts including one root-cause investigation you did yourself, and it
is recorded as an OPEN id while work continues on everything it does not block.

## After compaction

Read `PROGRESS.md` first, then `LOOP-BRIEF.md`, then the current task. The cursor tells you
where you are. Artifacts that already exist on disk are reconciled with, never regenerated.

## Returning

`PHASE COMPLETE — <phase>, <n>/<n> tasks, close steps <list> (N/A: <list>), suite <counts>
vs baseline, head <sha>` or a stuck report `{stuck:true, task, attempted, blocker, lastError}`.
