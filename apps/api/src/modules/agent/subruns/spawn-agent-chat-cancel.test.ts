// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A chat turn that spawned a sub-agent and is awaiting it can be stopped by the person. The
// stop reaches the spawn_agent tool call as the AI SDK's `abortSignal`; the sub-run it is
// waiting on must end with it (status `cancelled`) and the call must settle promptly, rather
// than the sub-run running on, unowned, until its own timeout.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  agentRuns,
  creditBalances,
  threads as kernelThreads,
  modelPricing,
} from "~/db/schema/kernel"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const SUBRUN_TIMEOUT_MS = 20_000
const TEST_TIMEOUT_MS = 90_000

let orgId: string
let userId: string
let parentThreadId: string
let agentType: string
let subRunStarted: () => void
let subRunStartedP: Promise<void>

function actor(): UserContext {
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: ["kernel:agents:spawn", "kernel:contacts:read"],
    dimensionGrants: {},
  }
}

// A chat turn's frame, as runAgentChat builds it: a root, no agent_runs row.
function chatTurn(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

// The sub-run's model: a long step that only ends when its own run is aborted.
function longSubRunStream() {
  return ((params: { abortSignal?: AbortSignal }) => ({
    fullStream: (async function* () {
      subRunStarted()
      await new Promise<void>((resolve) => {
        if (params.abortSignal?.aborted) return resolve()
        params.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
      })
      throw new Error(String(params.abortSignal?.reason ?? "aborted"))
      // biome-ignore lint/correctness/noUnreachable: generator shape
      yield { type: "finish", finishReason: "stop" }
    })(),
  })) as never
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-chat-cancel-stub"
})

afterAll(async () => {
  if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  await releaseTestLock()
})

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  await withSystemDb("chat-cancel-seed", async (db) => {
    await db
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5-subrun",
        displayName: "Subrun Haiku",
        inputCostPerM: "1.00",
        outputCostPerM: "5.00",
        contextWindow: 200000,
        autoEligible: true,
        tierMinimum: "starter",
      })
      .onConflictDoNothing()
    await db
      .insert(creditBalances)
      .values({ orgId, includedBalance: "10.00000000", purchasedBalance: "0", currency: "EUR" })
      .onConflictDoNothing()
  })
  const [t] = await withPrivilegedDb(orgId, "chat-cancel-thread", (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `cc-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  parentThreadId = t.id
  agentType = `cc-${crypto.randomUUID().slice(0, 6)}`
  await createSubAgentDefinition({
    orgId,
    creatorScopes: ["kernel:agents:spawn", "kernel:contacts:read"],
    agentType,
    whenToUse: "chat cancel test",
    scopeCeiling: ["kernel:contacts:read"],
    toolAllowlist: [],
    systemPrompt: "Work for a long time.",
  })
  const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
  await registerKernelAgentTools(orgId)
  subRunStartedP = new Promise<void>((r) => {
    subRunStarted = r
  })
  AgentServiceTestAccess.setStreamText(longSubRunStream())
  await startSubrunWorker()
})

afterEach(() => {
  AgentServiceTestAccess.setStreamText()
  toolRegistry.deleteByPrefix([orgId])
})

describe("spawn_agent from a chat turn: stopping the turn", () => {
  it(
    "cancels the awaited sub-run and settles the call",
    async () => {
      const tools = buildToolSet(
        orgId,
        actor(),
        parentThreadId,
        ALL_DEFERRED_TOOLS_UNLOCKED,
        "agent",
        chatTurn(),
      )
      const spawn = tools.kernel__spawn_agent as {
        execute: (
          a: unknown,
          o: { abortSignal: AbortSignal; toolCallId: string },
        ) => Promise<unknown>
      }
      expect(spawn).toBeDefined()

      const turnStop = new AbortController()
      const call = spawn.execute(
        {
          subagent_type: agentType,
          description: "long research",
          prompt: "Research this for a long while.",
          continue_on_error: true,
          timeout_ms: SUBRUN_TIMEOUT_MS,
        },
        { abortSignal: turnStop.signal, toolCallId: "call-chat-cancel" },
      )
      const settled = call.then(
        () => "settled" as const,
        () => "settled" as const,
      )

      await subRunStartedP
      const stoppedAt = Date.now()
      turnStop.abort("user_stop")

      // The call must settle well before the sub-run's own timeout would end it.
      const outcome = await Promise.race([
        settled,
        new Promise<"still_waiting">((r) => setTimeout(() => r("still_waiting"), 5_000)),
      ])
      const waitedMs = Date.now() - stoppedAt

      // Let the sub-run end (at worst by its own timeout) before reading its row.
      await settled
      const [run] = await withPrivilegedDb(orgId, "chat-cancel-verify", (tx) =>
        tx
          .select({ status: agentRuns.status, errorCode: agentRuns.errorCode })
          .from(agentRuns)
          .where(eq(agentRuns.parentThreadId, parentThreadId)),
      )

      expect({ outcome, waitedUnder5s: waitedMs < 5_000 }).toEqual({
        outcome: "settled",
        waitedUnder5s: true,
      })
      expect(run?.status).toBe("cancelled")
    },
    TEST_TIMEOUT_MS,
  )
})
