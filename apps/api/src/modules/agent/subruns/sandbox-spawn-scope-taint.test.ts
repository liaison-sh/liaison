// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope and taint across a sandbox app's ctx.agent.spawn. A sandboxed app's
// bridge callbacks run outside the calling turn's AsyncLocalStorage frame, so
// the bridge captures the frame's effective scope and taint snapshot when it is
// constructed (in-frame) and hands them to spawnAgent. Every test builds the
// bridge through the real constructor and calls agent_spawn with no frame
// active, as a worker-pool callback does.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import {
  agentRuns,
  creditBalances,
  threads as kernelThreads,
  messages,
  modelPricing,
  threadParticipants,
} from "~/db/schema/kernel"
import { registerJobWorker } from "~/infra/jobs/jobs"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import {
  type RunContext,
  runContextStore,
  runWithToolCallScopesBefore,
} from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { AGENT_SUBRUN_JOB_NAME, type SubRunJobPayload } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { runSubRun } from "~/modules/agent/subruns/subrun-worker"
import { toolRegistry } from "~/modules/apps/app-registries"
import { createRpcBridge, createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
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

const READ = "x4s:items:read"
const WRITE = "x4s:items:write"
const EXTRA = "x4s:secrets:read"
const SPAWN = "x4s:spawner:run"
const ACTOR_SCOPES = [READ, WRITE, EXTRA, SPAWN]
const OTHER_TABLE = "app_x4s.items"
const TEST_TIMEOUT_MS = 60_000

// Handlers that actually ran in the child, in order.
const ran: string[] = []
// What each tool call made by the child returned, in order.
const childResults: Array<{ name: string; result: unknown }> = []
// Every agent-subrun job payload spawnAgent enqueued, in order.
const payloads: SubRunJobPayload[] = []

let orgId: string
let userId: string
let threadId: string
let agentType: string
let appName: string

function actor(): UserContext {
  return { actorType: "user", userId, orgId, scopes: ACTOR_SCOPES, dimensionGrants: {} }
}

function manifest(): Record<string, unknown> {
  return {
    name: appName,
    trusted: true,
    capabilities: ["agent.spawn"],
    schema: {},
    events: { emits: [] },
    connections: {},
    network: { allowedDomains: [] },
  }
}

// agent_spawn never touches the bridge's transaction.
const unusedTx = {} as never

function buildBridge(): Record<string, any> {
  return createRpcBridge(
    appName,
    userId,
    orgId,
    unusedTx,
    manifest() as never,
    ACTOR_SCOPES,
    "user",
    undefined,
    { actor: actor(), threadId },
  )
}

function buildSessionBridge(): Record<string, any> {
  const session = {
    ctx: actor(),
    // A session bridge's calls run on RLS transactions of the actor, as in production.
    run: (fn: (tx: unknown) => Promise<unknown>) => withRlsContext(actor(), fn),
  }
  return createSessionRpcBridge(
    appName,
    userId,
    orgId,
    session as never,
    manifest() as never,
    ACTOR_SCOPES,
    "user",
    undefined,
    { actor: actor(), threadId },
  )
}

// Called with no ALS frame active, as a sandbox worker-pool callback is.
async function spawnThroughBridge(
  bridge: Record<string, any>,
): Promise<{ runId?: string; error?: { code?: string } }> {
  expect(runContextStore.getStore()).toBeUndefined()
  const env = JSON.parse(
    await bridge.agent_spawn(
      JSON.stringify({ subagentType: agentType, description: "x4s child", prompt: "write" }),
    ),
  ) as { runId?: string; error?: { code?: string } }
  if (env.runId) await bridge.agent_awaitRun(env.runId, JSON.stringify({ timeoutMs: 30_000 }))
  return env
}

async function childEffectiveScopes(runId: string): Promise<string[]> {
  const [row] = await withPrivilegedDb(orgId, "x4s-read-run", (tx) =>
    tx
      .select({ effectiveScopes: agentRuns.effectiveScopes })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1),
  )
  return row.effectiveScopes
}

// A narrowed agent turn that read scoped data and is now running the app tool
// (declared SPAWN) whose handler builds the bridge.
function taintedNarrowedTurn(): { frame: RunContext; scopesBefore: string[] } {
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected([READ])
  const scopesBefore = turnScopeAccumulator.snapshot()
  turnScopeAccumulator.recordInjected([SPAWN])
  const runId = crypto.randomUUID()
  return {
    frame: {
      runId,
      parentRunId: null,
      rootRunId: runId,
      nestingDepth: 0,
      effectiveScope: [READ, WRITE, SPAWN],
      turnScopeAccumulator,
    },
    scopesBefore,
  }
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

function registerTools(): void {
  const anyParams = z.object({}).passthrough()
  const tool = (
    name: string,
    extra: { requiredScopes: string[]; readOnly?: boolean; writesToTable?: string },
  ) =>
    toolRegistry.set([orgId, "x4s", name], {
      appName: "x4s",
      name,
      description: `sandbox spawn taint test tool ${name}`,
      params: anyParams,
      handler: async () => {
        ran.push(name)
        return { ok: true, ran: name }
      },
      ...extra,
    })
  tool("other_write", { requiredScopes: [WRITE], writesToTable: OTHER_TABLE })
}

async function seedPricingAndCredits(): Promise<void> {
  await withSystemDb("x4s-seed-pricing", async (db) => {
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
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-x4s-stub"
})

afterAll(async () => {
  if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  await releaseTestLock()
})

beforeEach(async () => {
  ran.length = 0
  childResults.length = 0
  payloads.length = 0
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  appName = `x4s-${crypto.randomUUID().slice(0, 8)}`
  await seedPricingAndCredits()
  const [t] = await withPrivilegedDb(orgId, "x4s-thread", (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `x4s-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  threadId = t.id
  agentType = `x4s-${crypto.randomUUID().slice(0, 6)}`
  await createSubAgentDefinition({
    orgId,
    creatorScopes: ACTOR_SCOPES,
    agentType,
    whenToUse: "sandbox spawn taint test",
    scopeCeiling: [READ, WRITE, EXTRA],
    toolAllowlist: ["x4s:other_write"],
    systemPrompt: "Write the item.",
  })
  registerTools()
  // The production handler, recording each payload it receives.
  registerJobWorker<SubRunJobPayload>("kernel", AGENT_SUBRUN_JOB_NAME, async (payload) => {
    payloads.push(payload)
    await runSubRun(payload.runId, payload.orgId, payload.parentTaintScopes)
  })
  AgentServiceTestAccess.setStreamText(childCalls(["x4s__other_write"]))
})

afterEach(() => {
  AgentServiceTestAccess.setStreamText()
  toolRegistry.deleteByPrefix([orgId])
})

describe("sandbox agent_spawn: scope and taint of the child", () => {
  it(
    "root spawn: a trusted app spawning outside any frame gets an untainted child that writes a non-enforcing table",
    async () => {
      const bridge = buildBridge()

      const env = await spawnThroughBridge(bridge)

      expect(env.error).toBeUndefined()
      expect(payloads.map((p) => p.parentTaintScopes)).toEqual([[]])
      expect(childResults).toEqual([
        { name: "x4s__other_write", result: { ok: true, ran: "other_write" } },
      ])
      expect(ran).toEqual(["other_write"])
    },
    TEST_TIMEOUT_MS,
  )

  for (const [label, build] of [
    ["createRpcBridge", buildBridge],
    ["createSessionRpcBridge", buildSessionBridge],
  ] as const) {
    it(
      `${label}: a spawn from an app tool inside a tainted narrowed turn carries the turn's snapshot and effective scope`,
      async () => {
        const { frame, scopesBefore } = taintedNarrowedTurn()
        const bridge = runContextStore.run(frame, () =>
          runWithToolCallScopesBefore(scopesBefore, () => build()),
        )

        const env = await spawnThroughBridge(bridge)

        expect(env.error).toBeUndefined()
        // The earlier read plus the calling app tool's own scope: that tool read the data too.
        expect(payloads.map((p) => p.parentTaintScopes)).toEqual([[READ, SPAWN]])
        const effective = await childEffectiveScopes(env.runId as string)
        expect(effective).not.toContain(EXTRA)
        expect(effective.every((s) => [READ, WRITE, SPAWN].includes(s))).toBe(true)
        expect(childResults).toEqual([{ name: "x4s__other_write", result: taintBlocked() }])
        expect(ran).toEqual([])
      },
      TEST_TIMEOUT_MS,
    )
  }

  for (const [label, build] of [
    ["createRpcBridge", buildBridge],
    ["createSessionRpcBridge", buildSessionBridge],
  ] as const) {
    it(
      `${label}: an app tool with scope X that spawns on an otherwise untainted turn gives a child tainted with X`,
      async () => {
        const turnScopeAccumulator = createTurnScopeAccumulator()
        const scopesBefore = turnScopeAccumulator.snapshot()
        // The bridge records the calling app tool's scope before the tool runs.
        turnScopeAccumulator.recordInjected([SPAWN])
        const runId = crypto.randomUUID()
        const frame: RunContext = {
          runId,
          parentRunId: null,
          rootRunId: runId,
          nestingDepth: 0,
          effectiveScope: [READ, WRITE, SPAWN],
          turnScopeAccumulator,
        }
        const bridge = runContextStore.run(frame, () =>
          runWithToolCallScopesBefore(scopesBefore, () => build()),
        )

        const env = await spawnThroughBridge(bridge)

        expect(env.error).toBeUndefined()
        expect(payloads.map((p) => p.parentTaintScopes)).toEqual([[SPAWN]])
        expect(childResults).toEqual([{ name: "x4s__other_write", result: taintBlocked() }])
        expect(ran).toEqual([])
      },
      TEST_TIMEOUT_MS,
    )
  }

  it(
    "the sub_run card posted in the parent thread carries the parent turn's taint plus the child's scopes once done, and RLS hides it from a member lacking them",
    async () => {
      const lackerId = (await minimal.person(orgId)).id
      await withPrivilegedDb(orgId, "x4s-members", (tx) =>
        tx.insert(threadParticipants).values([
          { threadId, userId, orgId, role: "admin" },
          { threadId, userId: lackerId, orgId, role: "member" },
        ]),
      )
      const { frame, scopesBefore } = taintedNarrowedTurn()
      const bridge = runContextStore.run(frame, () =>
        runWithToolCallScopesBefore(scopesBefore, () => buildBridge()),
      )

      const env = await spawnThroughBridge(bridge)

      expect(env.error).toBeUndefined()
      const cards = (
        await withPrivilegedDb(orgId, "x4s-cards", (tx) =>
          tx
            .select({
              id: messages.id,
              requiredScopes: messages.requiredScopes,
              metadata: messages.metadata,
            })
            .from(messages)
            .where(eq(messages.threadId, threadId)),
        )
      ).filter((m) => (m.metadata as { kind?: string } | null)?.kind === "sub_run")
      // Written with the parent turn's taint; once the child is done its summary
      // quotes the child's output, so the card also carries the child's scopes.
      // The child's WRITE scope classifies no data (scope-taint.ts, rule 5): it lands on its
      // read sibling, READ, already on the card.
      expect(cards.map((c) => c.requiredScopes)).toEqual([[READ, SPAWN].sort()])

      const visibleIds = (viewer: string, scopes: string[]) =>
        withRlsContext(
          { actorType: "user", userId: viewer, orgId, scopes, dimensionGrants: {} },
          async (tx) =>
            (
              await tx
                .select({ id: messages.id })
                .from(messages)
                .where(eq(messages.threadId, threadId))
            ).map((r) => r.id),
        )
      expect(await visibleIds(userId, ACTOR_SCOPES)).toContain(cards[0]?.id)
      expect(await visibleIds(lackerId, [])).not.toContain(cards[0]?.id)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "fail closed: a bridge built in a frame without an accumulator gives the child the parent's full scope as taint",
    async () => {
      const runId = crypto.randomUUID()
      const bare: RunContext = { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0 }
      const bridge = runContextStore.run(bare, () => buildBridge())

      const env = await spawnThroughBridge(bridge)

      expect(env.error).toBeUndefined()
      // The parent's full scope, projected (scope-taint.ts, rule 5): WRITE lands on READ.
      expect(payloads.map((p) => p.parentTaintScopes)).toEqual([
        ACTOR_SCOPES.filter((s) => s !== WRITE).sort(),
      ])
      expect(childResults).toEqual([{ name: "x4s__other_write", result: taintBlocked() }])
      expect(ran).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "fail closed: a captured empty effective scope leaves the child nothing",
    async () => {
      const { frame, scopesBefore } = taintedNarrowedTurn()
      const bridge = runContextStore.run({ ...frame, effectiveScope: [] }, () =>
        runWithToolCallScopesBefore(scopesBefore, () => buildBridge()),
      )

      const env = await spawnThroughBridge(bridge)

      expect(env.error?.code).toBe("E_ROLE_UNAVAILABLE")
      expect(payloads).toEqual([])
    },
    TEST_TIMEOUT_MS,
  )
})
