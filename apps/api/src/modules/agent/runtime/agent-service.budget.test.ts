// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  AgentServiceTestAccess,
  invokeAgentForThread,
  resolveAgentBudget,
} from "~/modules/agent/runtime/agent-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// resolveAgentBudget(budget?) → { maxSteps, timeoutMs }, clamped via the existing
// spawn-agent clamp() against KERNEL_FLOORS/DEFAULTS/CEILINGS. Pure + exported so the
// budget policy is unit-testable without booting the model stream.
describe("resolveAgentBudget", () => {
  test("undefined budget defaults to STEP_LIMIT=40 / TIMEOUT_MS=300_000", () => {
    expect(resolveAgentBudget(undefined)).toEqual({ maxSteps: 40, timeoutMs: 300_000 })
  })
  test("partial budget keeps the other default", () => {
    expect(resolveAgentBudget({ maxSteps: 60 })).toEqual({ maxSteps: 60, timeoutMs: 300_000 })
    expect(resolveAgentBudget({ timeoutMs: 120_000 })).toEqual({ maxSteps: 40, timeoutMs: 120_000 })
  })
  test("a large-but-sub-ceiling sweep budget (200 steps) is honored, not clamped", () => {
    // The exhaustive-sweep budget lift: an opted-in heavy routine can request
    // up to the new ceiling without being floored back to the old 50.
    expect(resolveAgentBudget({ maxSteps: 200 })).toEqual({ maxSteps: 200, timeoutMs: 300_000 })
  })
  test("over-ceiling request is clamped to KERNEL_CEILINGS (400 steps / 600_000 ms)", () => {
    expect(resolveAgentBudget({ maxSteps: 999, timeoutMs: 9_999_999 })).toEqual({
      maxSteps: 400,
      timeoutMs: 600_000,
    })
  })
  test("below-floor request is clamped up to KERNEL_FLOORS (1 step / 1_000 ms)", () => {
    expect(resolveAgentBudget({ maxSteps: 0, timeoutMs: 10 })).toEqual({
      maxSteps: 1,
      timeoutMs: 1_000,
    })
  })
})

describe("invokeAgentForThread return contract", () => {
  let orgId: string
  let userId: string
  let threadId: string
  beforeAll(async () => {
    await acquireTestLock()
    const u = await minimal.orgAdmin((await createTestOrg()).id) // bootstrap admin owns a real org
    orgId = u.orgId
    userId = u.id
    threadId = await minimal.thread(orgId, userId) // seeds the threadParticipants row → guard passes
  })
  afterAll(async () => {
    AgentServiceTestAccess.setAgentRun(undefined)
    await releaseTestLock()
  })

  test("surfaces the finalized finishReason ('length' propagates, not void)", async () => {
    AgentServiceTestAccess.setAgentRun(async () => ({
      userMessageId: "m1",
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          finishReason: "length",
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        yield { type: "finish", finishReason: "length" }
      })(),
      finalize: async () => ({ messageId: "msg1", creditCost: "0", finishReason: "length" }),
      stepCtx: { stepBundleId: null },
    }))
    const out = await invokeAgentForThread(
      threadId,
      "22222222-2222-2222-2222-222222222222",
      { userId, orgId, scopes: ["*"], dimensionGrants: {} },
      orgId,
      true,
    )
    expect(out.finishReason).toBe("length") // the load-bearing assertion: the value, not the type
    expect(typeof out.turnsAdded).toBe("number")
  })

  test("a 'stop' finish surfaces as finishReason 'stop'", async () => {
    AgentServiceTestAccess.setAgentRun(async () => ({
      userMessageId: "m2",
      fullStream: (async function* () {
        yield {
          type: "finish-step",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        yield { type: "finish", finishReason: "stop" }
      })(),
      finalize: async () => ({ messageId: "msg2", creditCost: "0", finishReason: "stop" }),
      stepCtx: { stepBundleId: null },
    }))
    const out = await invokeAgentForThread(
      threadId,
      "33333333-3333-3333-3333-333333333333",
      { userId, orgId, scopes: ["*"], dimensionGrants: {} },
      orgId,
      true,
    )
    expect(out.finishReason).toBe("stop")
  })
})
