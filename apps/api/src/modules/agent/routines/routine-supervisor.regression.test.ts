// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { routineRuns, routines } from "~/db/schema/kernel"
import { runRoutineTick } from "~/modules/agent/routines/routine-worker"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let userId: string
let threadId: string
beforeAll(async () => {
  await acquireTestLock()
  const u = await minimal.orgAdmin((await createTestOrg()).id)
  orgId = u.orgId
  userId = u.id
  threadId = await minimal.thread(orgId, userId)
})
afterAll(async () => {
  AgentServiceTestAccess.setAgentRun(undefined)
  await releaseTestLock()
})

describe("durable runtime: a >10-step task completes across turns", () => {
  test("supervisor drives the agent past one 10-step turn to natural stop", async () => {
    // Script the run-seam so EACH invocation reports 10 steps then 'length' for the
    // first two turns and 'stop' on the third → 30 logical steps across 3 turns,
    // exceeding the single-turn STEP_LIMIT=10 the old path capped at.
    let turn = 0
    AgentServiceTestAccess.setAgentRun(async () => {
      turn += 1
      const last = turn >= 3
      const reason = last ? "stop" : "length"
      return {
        userMessageId: `m${turn}`,
        fullStream: (async function* () {
          for (let s = 0; s < 10; s++)
            yield {
              type: "finish-step",
              finishReason: s === 9 ? reason : "tool-calls",
              usage: { inputTokens: 0, outputTokens: 0 },
            }
          yield { type: "finish", finishReason: reason }
        })(),
        finalize: async () => ({ messageId: `done${turn}`, creditCost: "0", finishReason: reason }),
        stepCtx: { stepBundleId: null },
      }
    })

    // Seed a recurring routine bound to threadId.
    const [r] = await withSystemDb("t", (db) =>
      db
        .insert(routines)
        .values({
          orgId,
          ownerUserId: userId,
          name: `long-batch-${Date.now()}`,
          description: "d",
          kind: "recurring",
          cron: "0 9 * * *",
          timezone: "Europe/Paris",
          prompt: "Process every record in the batch.",
          scopes: [],
          outputThreadId: threadId,
          createdByActorType: "user",
          createdByUserId: userId,
        })
        .returning(),
    )

    const result = await runRoutineTick({
      orgId,
      routineId: r.id,
      scheduledAt: new Date().toISOString(),
      // Inject the supervisor-backed invoker exactly as kernel-jobs does, but with
      // the scripted run-seam above driving 3 turns. turnsAdded MUST be ≥ 3 (one
      // per turn), proving the single-turn 10-step cliff was crossed.
      agentInvoker: async ({ orgId: o, ownerUserId, threadId: tid, prompt, scopes }) => {
        const { runRoutineSupervisor } = await import("~/modules/agent/routines/routine-supervisor")
        const { sendMessage } = await import("~/modules/threads/message")
        const { withRlsContext } = await import("~/db/rls")
        const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
        let messageId = ""
        await withRlsContext(
          { actorType: "user", userId: ownerUserId, orgId: o, scopes, dimensionGrants: {} },
          async (tx) => {
            const m = await sendMessage(tx, {
              requiredScopes: [],
              threadId: tid,
              userId: ownerUserId,
              orgId: o,
              content: prompt,
            })
            messageId = m!.id
          },
        )
        const res = await runRoutineSupervisor({
          invokeTurn: ({ perTurnBudget }) =>
            invokeAgentForThread(
              tid,
              messageId,
              { userId: ownerUserId, orgId: o, scopes, dimensionGrants: {} },
              o,
              true,
              perTurnBudget,
            ),
          checkCredits: async () => null,
          now: () => Date.now(),
          policy: {
            maxTurns: 8,
            perTurnBudget: { maxSteps: 10, timeoutMs: 60_000 },
            deadlineMs: 540_000,
          },
        })
        // ≥3 turns proves the single-turn 10-step cliff was crossed.
        expect(res.turnsAdded).toBeGreaterThanOrEqual(3)
        return { turnsAdded: res.turnsAdded }
      },
    })
    // A recurring routine reports the `succeeded` RoutineRunStatus token.
    expect(result.status).toBe("succeeded")
    const runs = await withSystemDb("t", (db) =>
      db.select().from(routineRuns).where(eq(routineRuns.routineId, r.id)),
    )
    expect(runs.length).toBeGreaterThan(0)
  })
})
