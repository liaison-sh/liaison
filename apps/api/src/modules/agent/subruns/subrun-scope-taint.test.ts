// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope taint across the spawn boundary. A parent turn that read scoped data must not launder
// it through a spawned sub-run into a sink with no requiredScopes-aware read predicate: the
// child starts tainted with what the parent had touched before the spawning call, and its own
// tool calls record into, and are checked against, its own accumulator exactly as a chat turn's.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { creditBalances, threads as kernelThreads, modelPricing } from "~/db/schema/kernel"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { AGENT_SUBRUN_JOB_NAME, spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { runSubRun, startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** The refusal shape, whatever scopes the turn happened to carry (the message names them). */
// The child's write never runs. The bridge defers it to the dispatch (scope-taint.ts, rule 8),
// which would park it for an approver holding the taint; nobody here may approve it, so the
// dispatch refuses it with the same code, naming the remedy.
const taintBlocked = () =>
  expect.objectContaining({
    error: expect.stringContaining("E_SCOPE_TAINT_BLOCKED"),
  })

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const READ = "x4t:items:read"
const WRITE = "x4t:items:write"
const SPAWN = "x4t:spawner:run"
const OTHER_TABLE = "app_x4t.items"
const TEST_TIMEOUT_MS = 60_000

// Handlers that actually ran, in order, across parent and child.
const ran: string[] = []
// What each tool call made by the child returned, in order.
const childResults: Array<{ name: string; result: unknown }> = []

let orgId: string
let userId: string
let parentThreadId: string
let agentType: string

function actor(): UserContext {
  return { actorType: "user", userId, orgId, scopes: [READ, WRITE, SPAWN], dimensionGrants: {} }
}

function spawnChild() {
  return spawnAgent({
    parentRun: { id: null, threadId: parentThreadId, actor: actor(), nestingDepth: 0 },
    subagentType: agentType,
    description: "scope taint child",
    prompt: "write the item",
  })
}

// The child's model: calls the named tools of its own catalog in order, then stops with text.
function childCalls(sdkNames: string[]) {
  return ((params: { tools?: Record<string, { execute: (a: unknown) => Promise<unknown> }> }) => ({
    fullStream: (async function* () {
      for (const name of sdkNames) {
        const t = params.tools?.[name]
        if (!t) throw new Error(`${name} is not in the sub-run catalog`)
        childResults.push({ name, result: await t.execute({}) })
      }
      yield { type: "text-delta", text: "done" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })) as never
}

// A chat turn: a frame carrying a scope accumulator, as runAgentChat builds it.
function parentTurn(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

function callInTurn(frame: RunContext, sdkName: string): Promise<unknown> {
  const tools = buildToolSet(
    orgId,
    actor(),
    parentThreadId,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    frame,
  )
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the parent catalog`)
  return (t as { execute: (a: unknown) => Promise<unknown> }).execute({})
}

function registerTools(): void {
  const anyParams = z.object({}).passthrough()
  const tool = (
    name: string,
    extra: { requiredScopes: string[]; readOnly?: boolean; writesToTable?: string },
  ) =>
    toolRegistry.set([orgId, "x4t", name], {
      appName: "x4t",
      name,
      description: `scope taint test tool ${name}`,
      params: anyParams,
      handler: async () => {
        ran.push(name)
        return { ok: true, ran: name }
      },
      ...extra,
    })
  tool("scoped_read", { requiredScopes: [READ], readOnly: true })
  tool("other_write", { requiredScopes: [WRITE], writesToTable: OTHER_TABLE })
  // A read-only tool that dispatches a sub-run, as an app declaring agent.spawn does through ctx.agent.spawn.
  // Read-only, so a tainted parent passes its own taint check and reaches spawnAgent.
  toolRegistry.set([orgId, "x4t", "spawner"], {
    appName: "x4t",
    name: "spawner",
    description: "scope taint test tool spawner",
    requiredScopes: [SPAWN],
    readOnly: true,
    params: anyParams,
    handler: async () => {
      ran.push("spawner")
      const handle = await spawnChild()
      return handle.awaitResult()
    },
  })
}

async function seedPricingAndCredits(): Promise<void> {
  await withSystemDb("x4t-seed-pricing", async (db) => {
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
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-x4t-stub"
})

afterAll(async () => {
  if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  await releaseTestLock()
})

beforeEach(async () => {
  ran.length = 0
  childResults.length = 0
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  await seedPricingAndCredits()
  const [t] = await withPrivilegedDb(orgId, "x4t-parent-thread", (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `x4t-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  parentThreadId = t.id
  agentType = `x4t-${crypto.randomUUID().slice(0, 6)}`
  await createSubAgentDefinition({
    orgId,
    creatorScopes: [READ, WRITE, SPAWN],
    agentType,
    whenToUse: "scope taint test",
    scopeCeiling: [READ, WRITE],
    toolAllowlist: ["x4t:scoped_read", "x4t:other_write"],
    systemPrompt: "Write the item.",
  })
  registerTools()
  await startSubrunWorker()
})

afterEach(() => {
  AgentServiceTestAccess.setStreamText()
  toolRegistry.deleteByPrefix([orgId])
})

describe("sub-run scope taint", () => {
  it(
    "a parent turn that read scoped data spawns a sub-run whose write to a non-enforcing table is refused",
    async () => {
      const turn = parentTurn()
      await callInTurn(turn, "x4t__scoped_read")
      AgentServiceTestAccess.setStreamText(childCalls(["x4t__other_write"]))

      const result = (await callInTurn(turn, "x4t__spawner")) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(childResults).toEqual([{ name: "x4t__other_write", result: taintBlocked() }])
      expect(ran).toEqual(["scoped_read", "spawner"])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "an untainted parent's sub-run writes normally, the spawning call's own scope does not taint the child",
    async () => {
      AgentServiceTestAccess.setStreamText(childCalls(["x4t__other_write"]))

      const result = (await callInTurn(parentTurn(), "x4t__spawner")) as { ok: boolean }

      expect(result.ok).toBe(true)
      expect(childResults).toEqual([
        { name: "x4t__other_write", result: { ok: true, ran: "other_write" } },
      ])
      expect(ran).toEqual(["spawner", "other_write"])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "a sub-run's own scoped read taints its later write",
    async () => {
      AgentServiceTestAccess.setStreamText(childCalls(["x4t__scoped_read", "x4t__other_write"]))

      await callInTurn(parentTurn(), "x4t__spawner")

      expect(childResults).toEqual([
        { name: "x4t__scoped_read", result: { ok: true, ran: "scoped_read" } },
        { name: "x4t__other_write", result: taintBlocked() },
      ])
      expect(ran).toEqual(["spawner", "scoped_read"])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "a spawn outside any turn is a root run: the child starts clean and writes normally",
    async () => {
      AgentServiceTestAccess.setStreamText(childCalls(["x4t__other_write"]))

      const handle = await spawnChild()
      await handle.awaitResult()

      expect(childResults).toEqual([
        { name: "x4t__other_write", result: { ok: true, ran: "other_write" } },
      ])
      expect(ran).toEqual(["other_write"])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "fail closed: a frame without an accumulator gives an undeterminable parent taint",
    async () => {
      AgentServiceTestAccess.setStreamText(childCalls(["x4t__other_write"]))
      const bare = { ...parentTurn(), turnScopeAccumulator: undefined } as RunContext

      const handle = await runContextStore.run(bare, () => spawnChild())
      await handle.awaitResult()

      expect(childResults).toEqual([{ name: "x4t__other_write", result: taintBlocked() }])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "fail closed: a sub-run job that carries no parent snapshot is treated as tainted",
    async () => {
      AgentServiceTestAccess.setStreamText(childCalls(["x4t__other_write"]))
      // Park the job so the run is driven below without the payload spawnAgent enqueued.
      registerJobWorker("kernel", AGENT_SUBRUN_JOB_NAME, async () => {})
      const handle = await runContextStore.run(parentTurn(), () => spawnChild())

      await runSubRun(handle.runId, orgId)

      expect(childResults).toEqual([{ name: "x4t__other_write", result: taintBlocked() }])
      expect(ran).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
