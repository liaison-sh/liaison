// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ═══════════════════════════════════════════════════════════════════════════
//  DURABLE MULTI-STEP AGENT RUNTIME — E2E SCENARIO (Module A, Tasks A1–A4)
// ═══════════════════════════════════════════════════════════════════════════
//
// What this proves end-to-end: a routine/agent task that needs MORE than one
// `invokeAgentForThread` turn's worth of model steps (the old STEP_LIMIT=10 /
// TIMEOUT_MS=60_000 single-turn cliff) is driven to completion by the routine
// supervisor across N bounded turns — instead of being cut off at 10 steps.
//
// SURFACE: the REAL production routine path. We drive `runRoutineTick` (the
// kernel:routine-tick worker body) with the REAL `runRoutineSupervisor` +
// REAL `invokeAgentForThread` wired exactly as `kernel-jobs.ts` wires them.
// The only seam is `AgentServiceTestAccess.setAgentRun`, which scripts the per-turn model
// stream shape (how many `finish-step`s, and the terminal `finishReason`) so
// each scenario can deterministically exercise length-continuation, natural
// stop, the maxTurns ceiling, the wall-clock deadline ceiling, and the
// per-continuation credit pre-check — without burning real model tokens.
//
// Observable assertions are REAL DB/return state, not "no throw":
//   • `routine_runs` rows persisted with status + `turns_added`
//   • the supervisor's `{ turnsAdded, finalFinishReason, stoppedBy }` outcome
//   • the routine prompt message persisted in the output thread
//   • `resolveAgentBudget` defaults are byte-identical for a short task
//
// Style mirrors agent-runtime.scenario.test.ts (the reference) and the
// in-process projects-agent-runtime.scenario.test.ts (which likewise drives
// the real agent service in-process against ~/db with a scripted stream).

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { messages, routineRuns, routines } from "~/db/schema/kernel"
import {
  runRoutineSupervisor,
  type SupervisorPolicy,
  type SupervisorResult,
} from "~/modules/agent/routines/routine-supervisor"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import {
  AgentServiceTestAccess,
  invokeAgentForThread,
  resolveAgentBudget,
} from "~/modules/agent/runtime/agent-service"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// ─── Scripted-stream helpers ─────────────────────────────────────────────────

interface ScriptedTurn {
  /** number of `finish-step` chunks this turn emits (logical model steps) */
  steps: number
  /** terminal finishReason — "length" => supervisor continues; else stops */
  finishReason: string
}

/**
 * Install a `AgentServiceTestAccess.setAgentRun` seam that replays `turns` in order: the Nth
 * call to `invokeAgentForThread` (i.e. the Nth supervisor turn) returns the Nth
 * scripted turn shape. The seam stands in for `runAgentChat`, so the REAL
 * `invokeAgentForThread` loop still iterates the `fullStream`, accumulates
 * steps, resolves the terminal `finishReason`, and reports `turnsAdded` from
 * the real `Math.max(1, steps.length)` path. The supervisor reads that
 * finishReason to decide continue-vs-stop.
 */
function scriptTurns(turns: ScriptedTurn[]): { invocations: () => number } {
  let call = 0
  AgentServiceTestAccess.setAgentRun(async () => {
    // Clamp to the last scripted turn if the supervisor ever over-runs the
    // script (it should not — every scenario scripts a terminating turn).
    const turn = turns[Math.min(call, turns.length - 1)]
    call += 1
    const { steps, finishReason } = turn
    return {
      userMessageId: `scripted-user-${call}`,
      fullStream: (async function* () {
        for (let s = 0; s < steps; s++) {
          yield {
            type: "finish-step",
            // Only the LAST step carries the turn's terminal reason; the
            // intermediate steps are tool-call continuations within the turn.
            finishReason: s === steps - 1 ? finishReason : "tool-calls",
            usage: { inputTokens: 0, outputTokens: 0 },
          }
        }
        yield { type: "finish", finishReason }
      })(),
      finalize: async () => ({
        messageId: `scripted-msg-${call}`,
        creditCost: "0",
        finishReason,
      }),
      stepCtx: { stepBundleId: null },
    }
  })
  return { invocations: () => call }
}

/**
 * The production invoker (copied verbatim from kernel-jobs.ts:165-228 modulo
 * test-injectable `now`/`checkCredits`/`policy`) — persists the routine prompt
 * as a user message under the owner's RLS context, then drives the task across
 * N bounded turns via the REAL supervisor + REAL invokeAgentForThread.
 */
function makeProductionInvoker(args: {
  policy: SupervisorPolicy
  checkCredits?: () => Promise<string | null>
  now?: () => number
  onResult?: (res: SupervisorResult) => void
}) {
  return async (input: {
    orgId: string
    ownerUserId: string
    threadId: string
    prompt: string
    scopes: string[]
  }): Promise<{ turnsAdded: number }> => {
    let messageId = ""
    await withRlsContext(
      {
        actorType: "user",
        userId: input.ownerUserId,
        orgId: input.orgId,
        scopes: input.scopes,
        dimensionGrants: {},
      },
      async (tx) => {
        const msg = await sendMessage(tx, {
          requiredScopes: [],
          threadId: input.threadId,
          userId: input.ownerUserId,
          orgId: input.orgId,
          content: input.prompt,
        })
        if (!msg) throw new Error("routine sendMessage returned null")
        messageId = msg.id
      },
    )
    const res = await runRoutineSupervisor({
      invokeTurn: ({ perTurnBudget }) =>
        invokeAgentForThread(
          input.threadId,
          messageId,
          {
            userId: input.ownerUserId,
            orgId: input.orgId,
            scopes: input.scopes,
            dimensionGrants: {},
          },
          input.orgId,
          true, // background: routine tick
          perTurnBudget,
        ),
      checkCredits: args.checkCredits ?? (async () => null),
      now: args.now ?? (() => Date.now()),
      policy: args.policy,
    })
    args.onResult?.(res)
    return { turnsAdded: res.turnsAdded }
  }
}

// ─── DB helpers ──────────────────────────────────────────────────────────────

async function seedRecurringRoutine(
  orgId: string,
  ownerUserId: string,
  outputThreadId: string,
  prompt: string,
): Promise<string> {
  const [r] = await withSystemDb("seed-routine", (db) =>
    db
      .insert(routines)
      .values({
        orgId,
        ownerUserId,
        name: `durable-runtime-${crypto.randomUUID().slice(0, 8)}`,
        description: "durable multi-step runtime e2e",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "Europe/Paris",
        prompt,
        scopes: [],
        outputThreadId,
        createdByActorType: "user",
        createdByUserId: ownerUserId,
      })
      .returning({ id: routines.id }),
  )
  return r.id
}

async function getRunsForRoutine(routineId: string) {
  return withSystemDb("read-runs", (db) =>
    db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId)),
  )
}

// ═══════════════════════════════════════════════════════════════════════════

describe("Durable Multi-Step Agent Runtime Scenario", () => {
  let orgId: string
  let userId: string
  let outputThreadId: string

  beforeAll(async () => {
    await acquireTestLock()
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    orgId = u.orgId
    userId = u.id
    // The routine owner must be a participant of the output thread or
    // sendMessage returns null inside the invoker.
    outputThreadId = await minimal.thread(orgId, userId)
  }, 30_000)

  afterEach(() => {
    AgentServiceTestAccess.setAgentRun(undefined)
  })

  afterAll(async () => {
    AgentServiceTestAccess.setAgentRun(undefined)
    await releaseTestLock()
  }, 15_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  A3 — happy path: a >10-step task completes across N bounded turns
  // ═════════════════════════════════════════════════════════════════════════

  it("A3: a >10-step task drives to completion across N bounded turns (finishReason stop, all turns counted)", async () => {
    // Script 3 turns of 10 steps each: turns 1 & 2 report `length` (the
    // single-turn budget was exhausted → keep going), turn 3 reports `stop`
    // (the task is actually done). 30 logical steps total — three times the
    // old STEP_LIMIT=10 single-turn cliff.
    const script = scriptTurns([
      { steps: 10, finishReason: "length" },
      { steps: 10, finishReason: "length" },
      { steps: 10, finishReason: "stop" },
    ])

    let supervised: SupervisorResult | undefined
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Process every record in the large batch.",
    )

    const result = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => [],
      checkCredits: async () => null,
      agentInvoker: makeProductionInvoker({
        policy: {
          maxTurns: 8,
          perTurnBudget: { maxSteps: 10, timeoutMs: 60_000 },
          deadlineMs: 540_000,
        },
        onResult: (r) => {
          supervised = r
        },
      }),
    })

    // The real worker reports a recurring routine's terminal status.
    expect(result.status).toBe("succeeded")

    // The supervisor crossed the single-turn cliff: it re-invoked while the
    // model kept saying `length` and stopped on the first non-`length` finish.
    expect(supervised).toBeDefined()
    if (!supervised) throw new Error("supervisor result missing")
    expect(supervised.stoppedBy).toBe("completion")
    expect(supervised.finalFinishReason).toBe("stop")
    // 3 turns × ≥1 turnAdded each (real invokeAgentForThread reports
    // Math.max(1, steps.length) = 10 per turn).
    expect(supervised.turnsAdded).toBeGreaterThanOrEqual(3)
    // Exactly three model invocations — no over-run past the natural stop.
    expect(script.invocations()).toBe(3)

    // REAL DB state: a routine_runs row persisted with the summed turnsAdded.
    const runs = await getRunsForRoutine(routineId)
    expect(runs.length).toBe(1)
    const run = runs[0]
    expect(run.status).toBe("succeeded")
    expect(run.turnsAdded).toBe(supervised.turnsAdded)
    expect(run.turnsAdded ?? 0).toBeGreaterThanOrEqual(3)

    // REAL DB state: the routine prompt was persisted into the output thread.
    const msgs = await withSystemDb("read-msgs", (db) =>
      db
        .select({ content: messages.content, authorType: messages.authorType })
        .from(messages)
        .where(eq(messages.threadId, outputThreadId)),
    )
    const promptMsg = msgs.find((m) => m.content === "Process every record in the large batch.")
    expect(promptMsg).toBeDefined()
    expect(promptMsg?.authorType).toBe("user")
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  A1 — budget defaults unchanged for a short task (one turn)
  // ═════════════════════════════════════════════════════════════════════════

  it("A1: a short task that finishes in one turn under the default per-invocation budget", async () => {
    // The default (absent budget) resolves to today's STEP_LIMIT/TIMEOUT_MS.
    // Assert the pure policy function AND the runtime behavior agree.
    expect(resolveAgentBudget(undefined)).toEqual({ maxSteps: 40, timeoutMs: 300_000 })

    // A single 2-step turn that ends naturally with `stop`. The supervisor
    // must not re-invoke — one turn, one stop.
    const script = scriptTurns([{ steps: 2, finishReason: "stop" }])

    let supervised: SupervisorResult | undefined
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Summarize today's inbox in one line.",
    )

    const result = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => [],
      checkCredits: async () => null,
      agentInvoker: makeProductionInvoker({
        policy: {
          maxTurns: 8,
          perTurnBudget: { maxSteps: 10, timeoutMs: 60_000 },
          deadlineMs: 540_000,
        },
        onResult: (r) => {
          supervised = r
        },
      }),
    })

    expect(result.status).toBe("succeeded")
    expect(supervised).toBeDefined()
    if (!supervised) throw new Error("supervisor result missing")
    // Single turn, natural stop, no continuation.
    expect(script.invocations()).toBe(1)
    expect(supervised.stoppedBy).toBe("completion")
    expect(supervised.finalFinishReason).toBe("stop")

    const runs = await getRunsForRoutine(routineId)
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe("succeeded")
    // One turn ran; turnsAdded == steps in that turn (>= 1).
    expect(runs[0].turnsAdded ?? 0).toBeGreaterThanOrEqual(1)
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  A4 — maxTurns ceiling halts a model that never says "stop"
  // ═════════════════════════════════════════════════════════════════════════

  it("A4: maxTurns ceiling halts a runaway that always reports length", async () => {
    // A pathological model that NEVER finishes: every turn reports `length`.
    // Without the ceiling this is an infinite loop. The supervisor must stop
    // at exactly maxTurns and surface stoppedBy='maxTurns'.
    const MAX_TURNS = 4
    const script = scriptTurns([{ steps: 3, finishReason: "length" }])

    let supervised: SupervisorResult | undefined
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Loop forever over an unbounded stream.",
    )

    const result = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => [],
      checkCredits: async () => null,
      agentInvoker: makeProductionInvoker({
        policy: {
          maxTurns: MAX_TURNS,
          perTurnBudget: { maxSteps: 3, timeoutMs: 60_000 },
          deadlineMs: 540_000,
        },
        onResult: (r) => {
          supervised = r
        },
      }),
    })

    // The worker treats a halted-but-not-errored run as a successful tick
    // (the supervisor returns normally; nothing threw). The CEILING — not an
    // infinite loop — is the property under test.
    expect(result.status).toBe("succeeded")
    expect(supervised).toBeDefined()
    if (!supervised) throw new Error("supervisor result missing")
    expect(supervised.stoppedBy).toBe("maxTurns")
    expect(supervised.finalFinishReason).toBe("length")
    // Invoked exactly maxTurns times — never one more.
    expect(script.invocations()).toBe(MAX_TURNS)

    const runs = await getRunsForRoutine(routineId)
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe("succeeded")
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  A4 — deadline/wall-clock ceiling halts a runaway before maxTurns
  // ═════════════════════════════════════════════════════════════════════════

  it("A4: wall-clock deadline ceiling halts a long run before exhausting maxTurns", async () => {
    // A model that keeps reporting `length`, but the wall clock crosses the
    // deadline first. We inject a monotonic clock that advances 200_000ms per
    // read so the deadline (300_000ms) trips on the second between-turn check,
    // BEFORE maxTurns (8) would. Proves deadlineMs bounds wall time, and stays
    // under the 600s routine lock TTL (so a long run can't outlive its lock).
    const script = scriptTurns([{ steps: 5, finishReason: "length" }])

    // The supervisor reads now() once up-front (`start`) and once per loop
    // iteration for the between-turn deadline check. Each read advances the
    // injected clock by 200_000ms. Sequence:
    //   start = now() @0
    //   turn0: check @200k → 200k - 0 = 200k < 300k (ok) → invoke (call 1)
    //   turn1: check @400k → 400k - 0 = 400k >= 300k (deadline) → STOP
    // So exactly 1 invocation lands before the wall-clock ceiling trips —
    // well short of maxTurns=8.
    let clock = -200_000
    const injectedNow = () => {
      clock += 200_000
      return clock
    }

    let supervised: SupervisorResult | undefined
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "A genuinely long batch that would run for minutes.",
    )

    const result = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => [],
      checkCredits: async () => null,
      agentInvoker: makeProductionInvoker({
        policy: {
          maxTurns: 8,
          perTurnBudget: { maxSteps: 5, timeoutMs: 60_000 },
          deadlineMs: 300_000,
        },
        now: injectedNow,
        onResult: (r) => {
          supervised = r
        },
      }),
    })

    expect(result.status).toBe("succeeded")
    expect(supervised).toBeDefined()
    if (!supervised) throw new Error("supervisor result missing")
    expect(supervised.stoppedBy).toBe("deadline")
    // Halted by the wall clock after a single invocation — well short of
    // maxTurns=8. The point is the deadline, not maxTurns, ended the run.
    expect(script.invocations()).toBe(1)
    expect(script.invocations()).toBeLessThan(8)
  }, 60_000)

  // ═════════════════════════════════════════════════════════════════════════
  //  A4 — per-continuation credit pre-check pauses on exhaustion
  // ═════════════════════════════════════════════════════════════════════════

  it("A4: per-continuation credit pre-check pauses the loop when credit drains between turns", async () => {
    // The within-turn checkMidStep guards inside a single turn; the supervisor
    // adds a BETWEEN-turn credit re-check. Fund the first 2 between-turn checks,
    // then report exhaustion → the loop pauses with stoppedBy='credits' even
    // though the model would happily keep emitting `length`.
    const script = scriptTurns([{ steps: 4, finishReason: "length" }])

    let creditChecks = 0
    const checkCredits = async (): Promise<string | null> => {
      creditChecks += 1
      // Funded for checks #1 and #2 (allowing 2 turns), exhausted on check #3.
      return creditChecks >= 3 ? "Credit pre-check denied" : null
    }

    let supervised: SupervisorResult | undefined
    const routineId = await seedRecurringRoutine(
      orgId,
      userId,
      outputThreadId,
      "Keep going as long as there is credit.",
    )

    const result = await runRoutineTick({
      orgId,
      routineId,
      scheduledAt: new Date().toISOString(),
      loadOwnerScopes: async () => [],
      checkCredits: async () => null, // routine-level pre-check funded; the
      // BETWEEN-turn check is the supervisor's own (below).
      agentInvoker: makeProductionInvoker({
        policy: {
          maxTurns: 8,
          perTurnBudget: { maxSteps: 4, timeoutMs: 60_000 },
          deadlineMs: 540_000,
        },
        checkCredits,
        onResult: (r) => {
          supervised = r
        },
      }),
    })

    expect(result.status).toBe("succeeded")
    expect(supervised).toBeDefined()
    if (!supervised) throw new Error("supervisor result missing")
    expect(supervised.stoppedBy).toBe("credits")
    // Two turns ran (checks #1, #2 funded), the third check paused the loop
    // before a third invocation.
    expect(script.invocations()).toBe(2)
    expect(creditChecks).toBe(3)
    // turnsAdded reflects the 2 completed turns, not the would-be third.
    expect(supervised.turnsAdded).toBeGreaterThanOrEqual(2)

    const runs = await getRunsForRoutine(routineId)
    expect(runs.length).toBe(1)
    expect(runs[0].turnsAdded).toBe(supervised.turnsAdded)
  }, 60_000)
})
