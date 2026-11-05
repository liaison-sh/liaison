// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import {
  agentRuns,
  appsActiveVersion,
  appsInstalled,
  creditBalances,
  threads as kernelThreads,
  modelPricing,
  users,
} from "~/db/schema/kernel"
import * as agentServiceModule from "~/modules/agent/runtime/agent-service"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import * as subRunAwaitModule from "~/modules/agent/subruns/subrun-await"
import { awaitSubRunResult } from "~/modules/agent/subruns/subrun-await"
import { startSubrunWorker, sweepStuckSubRuns } from "~/modules/agent/subruns/subrun-worker"
import * as appsInitModule from "~/modules/apps/init"
import * as minimal from "~/seed/tiers/minimal"
import { stubStreamText } from "~/tests/helpers/agent-stub"
import { createTestOrg } from "~/tests/helpers/org"
import { seededApps } from "~/tests/helpers/seeded-app-rows"
import { waitFor } from "~/tests/helpers/wait-for"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SEEDED = seededApps()

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function userActor(orgId: string, userId: string, scopes: string[]): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

async function installTestApp(grantedScopes: string[]): Promise<string> {
  const appName = SEEDED.track(`subrun-${crypto.randomUUID().slice(0, 8)}`)
  await withSystemDb("subrun-install-app", async (db) => {
    const [admin] = await db.select({ id: users.id }).from(users).limit(1)
    if (!admin) throw new Error("installTestApp: no user found")
    await db.insert(appsInstalled).values({
      name: appName,
      version: "1.0.0",
      sourceUrl: `file:///tmp/${appName}.liaisonapp`,
      sha256: "0".repeat(64),
      grantedScopes,
      installedBy: admin.id,
    })
    await db
      .insert(appsActiveVersion)
      .values({ name: appName, version: "1.0.0" })
      .onConflictDoUpdate({ target: appsActiveVersion.name, set: { version: "1.0.0" } })
  })
  return appName
}

async function makeParentThread(orgId: string, userId: string): Promise<string> {
  const [t] = await withPrivilegedDb(orgId, "subrun-parent-thread", async (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `pt-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  return t.id
}

async function seedPricingAndCredits(orgId: string): Promise<void> {
  await withSystemDb("subrun-seed-pricing", async (db) => {
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
      .values({
        orgId,
        includedBalance: "10.00000000",
        purchasedBalance: "0",
        currency: "EUR",
      })
      .onConflictDoNothing()
  })
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-subrun-stub"
})

afterAll(async () => {
  await SEEDED.cleanup()
  if (ORIG_ANTHROPIC_KEY !== undefined) {
    process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  } else {
    delete process.env.LIAISON_ANTHROPIC_API_KEY
  }
  await releaseTestLock()
})

afterEach(() => {
  AgentServiceTestAccess.setStreamText()
})

describe("subrun worker — end-to-end", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    await seedPricingAndCredits(orgId)
  })

  it("runs a sub-run to completion, persists output, and awaitResult returns ok=true", async () => {
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate the ticket.",
    })

    AgentServiceTestAccess.setStreamText(
      stubStreamText.respondWithFinalize({
        draft: "Refund per ToS §4.2.",
        confidence: 0.87,
      }) as never,
    )

    await startSubrunWorker()

    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "JIRA-1234",
      prompt: "Investigate this ticket.",
      input: { ticketId: "JIRA-1234" },
      outputSchema: {
        type: "object",
        required: ["draft", "confidence"],
        properties: {
          draft: { type: "string" },
          confidence: { type: "number" },
        },
      },
    })

    const result = await awaitSubRunResult(handle.runId, orgId, {
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(true)
    expect(result.output).toEqual({
      draft: "Refund per ToS §4.2.",
      confidence: 0.87,
    })

    // Persisted row state
    const [row] = await withPrivilegedDb(orgId, "verify-done", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, handle.runId)).limit(1),
    )
    expect(row.status).toBe("done")
    expect(row.output).toEqual({
      draft: "Refund per ToS §4.2.",
      confidence: 0.87,
    })
    expect(row.finishedAt).toBeTruthy()
  })

  it("sub-run prepareStep clips stale tool results (intra-run micro-compaction), allowlist path included", async () => {
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate the ticket.",
      // Explicit allowlist: the catalog is the working set — no discovery
      // gating — but stale-result clipping must still apply.
      toolAllowlist: ["kernel:finalize"],
    })

    let captured: {
      prepareStep?: (o: unknown) => { activeTools?: string[]; messages?: unknown[] }
    } | null = null
    const inner = stubStreamText.respondWithFinalize({ draft: "d", confidence: 1 })
    AgentServiceTestAccess.setStreamText(((params: never) => {
      captured = params
      return inner(params)
    }) as never)
    await startSubrunWorker()

    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "JIRA-1",
      prompt: "Investigate.",
      input: { ticketId: "JIRA-1" },
      outputSchema: {
        type: "object",
        required: ["draft", "confidence"],
        properties: { draft: { type: "string" }, confidence: { type: "number" } },
      },
    })
    const result = await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 10_000 })
    expect(result.ok).toBe(true)
    expect(captured).not.toBeNull()
    expect(typeof captured!.prepareStep).toBe("function")

    const toolMsg = (id: string) => ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "x",
          output: { type: "json", value: { blob: "z".repeat(60_000) } },
        },
      ],
    })
    // Two stale results: clips wait for a batch of STALE_CLIP_BATCH_CHARS
    // (stale-result-clipper.ts), which one 60k result alone does not reach.
    const stepMessages = [
      toolMsg("old"),
      toolMsg("old2"),
      toolMsg("r1"),
      toolMsg("r2"),
      toolMsg("r3"),
      toolMsg("r4"),
    ]
    const stepN = captured!.prepareStep!({ steps: [], stepNumber: 5, messages: stepMessages })
    // Allowlist path: no discovery gating (activeTools absent)...
    expect(stepN.activeTools).toBeUndefined()
    // ...but the stale results ARE clipped; the recent four ride verbatim.
    expect(JSON.stringify(stepN.messages![0]).length).toBeLessThan(20_000)
    expect(JSON.stringify(stepN.messages![0])).toContain("truncated by the platform")
    // (the newest one carries the rolling cache mark, on a copy)
    expect(JSON.stringify(stepN.messages![1]).length).toBeLessThan(20_000)
    expect(JSON.stringify(stepN.messages![2]).length).toBeGreaterThan(60_000)
    expect((stepN.messages![5] as { content: unknown }).content).toBe(stepMessages[5]?.content)
  })

  // AI SDK 7 reports cache reads in usage.inputTokenDetails; the sub-run's
  // runaway guard read the removed flat `cachedInputTokens` and budgeted every
  // cached token as uncached (a 100k-token step with 90k from cache counted as
  // 100k), so a cache-friendly sub-run hit the 1.5M cap ten times too early.
  it("budgets only the uncached input of a step against the runaway cap", async () => {
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate.",
    })
    const guard = spyOn(agentServiceModule, "runawayGuardDecision")
    const inner = stubStreamText.respondWithFinalize({ draft: "d", confidence: 1 })
    AgentServiceTestAccess.setStreamText(((params: {
      onStepFinish?: (s: unknown) => Promise<void>
    }) =>
      inner({
        ...params,
        // A research step (no finalize) with a mostly cached prompt, then the
        // stub's own finalize step.
        onStepFinish: async (step: unknown) => {
          await params.onStepFinish?.({
            toolCalls: [],
            usage: {
              inputTokens: 100_000,
              outputTokens: 5,
              inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 90_000 },
            },
          })
          await params.onStepFinish?.(step)
        },
      } as never)) as never)
    try {
      await startSubrunWorker()
      const parentThreadId = await makeParentThread(orgId, userId)
      const handle = await spawnAgent({
        parentRun: {
          id: null,
          threadId: parentThreadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "JIRA-2",
        prompt: "Investigate.",
        input: { ticketId: "JIRA-2" },
        outputSchema: {
          type: "object",
          required: ["draft", "confidence"],
          properties: { draft: { type: "string" }, confidence: { type: "number" } },
        },
      })
      await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 10_000 })
      expect(guard).toHaveBeenCalled()
      expect(guard.mock.calls[0]?.[0]).toBe(10_000)
    } finally {
      guard.mockRestore()
    }
  })

  it("hydrates the org's installed app tools (ensureAppsForOrg) BEFORE building the sub-run toolset", async () => {
    // Regression for the sub-run no-op root cause: the worker built the sub-run's
    // toolset WITHOUT first hydrating the org's installed apps into this process,
    // so a sub-run whose org wasn't already loaded got a toolset MISSING its app
    // tools (tickets/boxtal/knowledge) and reported "the required tools are not
    // currently available" → empty no-op. The chat agent calls ensureAppsForOrg
    // before buildToolSet; the worker must too. Spy proves it is invoked with the
    // run's orgId during the sub-run (and idempotency keeps it cheap when already
    // hydrated).
    const spy = spyOn(appsInitModule, "ensureAppsForOrg")
    try {
      const appName = await installTestApp(["mcp:jira:read"])
      const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
      await createSubAgentDefinition({
        orgId,
        appName,
        agentType,
        whenToUse: "test",
        scopeCeiling: ["mcp:jira:read"],
        systemPrompt: "Investigate.",
      })

      AgentServiceTestAccess.setStreamText(
        stubStreamText.cleanStopWithText("Read the ticket.") as never,
      )
      await startSubrunWorker()

      spy.mockClear()
      const parentThreadId = await makeParentThread(orgId, userId)
      const handle = await spawnAgent({
        parentRun: {
          id: null,
          threadId: parentThreadId,
          actor: userActor(orgId, userId, ["mcp:jira:*"]),
          nestingDepth: 0,
        },
        subagentType: agentType,
        description: "hydrate-apps",
        prompt: "go",
        // hybrid (no schema) — the spawn fan-out shape this fix is for.
      })

      const result = await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 10_000 })
      expect(result.ok).toBe(true)
      // The worker hydrated THIS org's apps before assembling the sub-run toolset.
      expect(spy.mock.calls.some((c) => c[0] === orgId)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("fails the run with schema_failure when the model never finalizes", async () => {
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate.",
    })

    AgentServiceTestAccess.setStreamText(stubStreamText.neverFinalize() as never)
    await startSubrunWorker()

    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "JIRA-no-final",
      prompt: "Investigate.",
      outputSchema: {
        type: "object",
        required: ["draft"],
        properties: { draft: { type: "string" } },
      },
    })

    const result = await awaitSubRunResult(handle.runId, orgId, {
      continueOnError: true,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("schema_failure")
  })

  it("a HYBRID (no-schema) sub-run that exhausts its step budget returns ok:false (no false-success empty stub)", async () => {
    // Regression for the spawn fan-out FALSE-SUCCESS defect: before the fix, the
    // budget-exhaustion failure detection (timeout/credits/step_limit) was guarded
    // by `if (run.outputSchema)`, so a HYBRID sub-run that ran out of step budget
    // fell through to the success path and published `ok:true` with whatever text
    // it had accumulated — an empty/garbage stub a fanning-out parent then counted
    // as a completed unit, fabricating "all N drafted". The fix applies the same
    // abort-reason detection to hybrid runs, so a budget-exhausted sub-run surfaces
    // `ok:false` (step_limit) and the parent can honestly exclude it.
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate.",
    })

    // Emits 2 steps + some text + a `length` finish (the AI SDK budget signal).
    AgentServiceTestAccess.setStreamText(stubStreamText.lengthFinishNoFinalize(2) as never)
    await startSubrunWorker()

    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "hybrid-budget-exhausted",
      prompt: "Draft a reply.",
      // NO outputSchema — this is the hybrid path the defect lived on.
      maxSteps: 1,
    })

    const result = await awaitSubRunResult(handle.runId, orgId, {
      continueOnError: true,
      timeoutMs: 10_000,
    })
    // The load-bearing assertions: NOT a false ok:true empty stub.
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("step_limit")

    const [row] = await withPrivilegedDb(orgId, "verify-hybrid-step-limit", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, handle.runId)).limit(1),
    )
    expect(row.status).toBe("failed")
  })

  it("a HYBRID (no-schema) sub-run that stops voluntarily WITH output still succeeds with ok:true (no false-failure)", async () => {
    // The complement: a hybrid run that ends with a CLEAN stop (not an abort) AND
    // produced real text is a NORMAL completion — the fixes must not regress the
    // legitimate hybrid success path. `cleanStopWithText` emits non-empty text +
    // a `stop` finish with no finalize.
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Summarize.",
    })

    AgentServiceTestAccess.setStreamText(
      stubStreamText.cleanStopWithText("Drafted the reply.") as never,
    )
    await startSubrunWorker()

    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "hybrid-clean-stop",
      prompt: "Summarize the ticket.",
      // NO outputSchema, generous budget — a clean voluntary stop WITH output.
      maxSteps: 25,
    })

    const result = await awaitSubRunResult(handle.runId, orgId, { timeoutMs: 10_000 })
    expect(result.ok).toBe(true)
    expect(result.output).toBe("Drafted the reply.")

    const [row] = await withPrivilegedDb(orgId, "verify-hybrid-clean-stop", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, handle.runId)).limit(1),
    )
    expect(row.status).toBe("done")
  })

  it("a HYBRID (no-schema) sub-run that stops cleanly but produces NO output returns ok:false (empty no-op excluded)", async () => {
    // Regression for the second spawn fan-out false-success defect: a sub-agent
    // that spawned, did nothing useful (no draft, no text — the judge's "~47
    // completion tokens, no approval created" no-op), and stopped cleanly used to
    // publish ok:true with an empty-string output, which a fanning-out parent
    // counted as a finished unit → over-stated count ("all 12 drafted"). The fix
    // fails an empty-output hybrid stop as ok:false (empty_output) so the parent
    // excludes it. `neverFinalize` emits a clean stop with NO text.
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Draft.",
    })

    AgentServiceTestAccess.setStreamText(stubStreamText.neverFinalize() as never)
    await startSubrunWorker()

    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "hybrid-empty-noop",
      prompt: "Draft a reply.",
      // NO outputSchema, generous budget — a clean stop that produced nothing.
      maxSteps: 25,
    })

    const result = await awaitSubRunResult(handle.runId, orgId, {
      continueOnError: true,
      timeoutMs: 10_000,
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("empty_output")

    const [row] = await withPrivilegedDb(orgId, "verify-hybrid-empty-noop", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, handle.runId)).limit(1),
    )
    expect(row.status).toBe("failed")
  })

  it("awaitResult returns even when completion races subscribe (M5 race fallback)", async () => {
    const appName = await installTestApp(["mcp:jira:read"])
    const agentType = `inv-${crypto.randomUUID().slice(0, 6)}`
    await createSubAgentDefinition({
      orgId,
      appName,
      agentType,
      whenToUse: "test",
      scopeCeiling: ["mcp:jira:read"],
      systemPrompt: "Investigate.",
    })

    AgentServiceTestAccess.setStreamText(stubStreamText.respondWithFinalize({ ok: true }) as never)
    await startSubrunWorker()

    const parentThreadId = await makeParentThread(orgId, userId)
    const handle = await spawnAgent({
      parentRun: {
        id: null,
        threadId: parentThreadId,
        actor: userActor(orgId, userId, ["mcp:jira:*"]),
        nestingDepth: 0,
      },
      subagentType: agentType,
      description: "race",
      prompt: "go",
      outputSchema: {
        type: "object",
        required: ["ok"],
        properties: { ok: { type: "boolean" } },
      },
    })

    // Wait for the worker to complete (the row is terminal) BEFORE we call
    // awaitSubRunResult — exercising the DB-poll race fallback.
    await waitFor(
      async () => {
        const [row] = await withPrivilegedDb(orgId, "race-wait-done", (tx) =>
          tx
            .select({ status: agentRuns.status })
            .from(agentRuns)
            .where(eq(agentRuns.id, handle.runId))
            .limit(1),
        )
        return row?.status === "done"
      },
      { label: "the sub-run to finish" },
    )

    const result = await awaitSubRunResult(handle.runId, orgId, {
      timeoutMs: 5_000,
    })
    expect(result.ok).toBe(true)
    expect(result.output).toEqual({ ok: true })
  })
})

describe("subrun worker — retry idempotency (I-REL-11)", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    await seedPricingAndCredits(orgId)
  })

  async function seedTerminalRun(status: "done" | "failed"): Promise<string> {
    const threadId = await makeParentThread(orgId, userId)
    const runId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "seed-terminal-run", async (tx) => {
      await tx.insert(agentRuns).values({
        id: runId,
        orgId,
        rootRunId: runId,
        threadId,
        actor: userActor(orgId, userId, []) as never,
        status,
        prompt: "already finished",
        output: status === "done" ? { draft: "done already" } : null,
        summary: status === "done" ? "done already" : null,
        errorCode: status === "failed" ? "schema_failure" : null,
        errorMessage: status === "failed" ? "prior failure" : null,
        creditCost: "3.50",
        usagePromptTokens: 100,
        usageCompletionTokens: 50,
        maxSteps: 10,
        timeoutMs: 30_000,
        schemaRetryBudget: 1,
        finishedAt: new Date(),
      })
    })
    return runId
  }

  it("does not re-run or mutate an already-done run, and republishes its result", async () => {
    const { runSubRun } = await import("~/modules/agent/subruns/subrun-worker")
    const runId = await seedTerminalRun("done")

    // A retry / duplicate enqueue lands here; the terminal guard must short-circuit.
    await runSubRun(runId, orgId)

    const [row] = await withPrivilegedDb(orgId, "verify-untouched", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
    )
    // Status, output, and credit cost are unchanged — no re-run, no re-charge.
    expect(row.status).toBe("done")
    expect(row.output).toEqual({ draft: "done already" })
    expect(Number(row.creditCost)).toBe(3.5)
    expect(row.attemptCount).toBe(0)

    // The prior result is republished so a late awaiter still resolves.
    const result = await awaitSubRunResult(runId, orgId, { timeoutMs: 5_000 })
    expect(result.ok).toBe(true)
    expect(result.output).toEqual({ draft: "done already" })
  })

  it("does not re-run an already-failed run", async () => {
    const { runSubRun } = await import("~/modules/agent/subruns/subrun-worker")
    const runId = await seedTerminalRun("failed")

    await runSubRun(runId, orgId)

    const [row] = await withPrivilegedDb(orgId, "verify-failed-untouched", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
    )
    expect(row.status).toBe("failed")
    expect(row.errorCode).toBe("schema_failure")
    expect(row.attemptCount).toBe(0)
  })
})

describe("subrun worker — taint propagation to parent", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
  })

  async function makeHiddenThread(tainted: boolean): Promise<string> {
    const [t] = await withPrivilegedDb(orgId, "make-hidden-thread", (tx) =>
      tx
        .insert(kernelThreads)
        .values({
          orgId,
          handle: `sr-${crypto.randomUUID().slice(0, 8)}`,
          type: "subrun",
          hiddenFromList: true,
          tainted,
          createdBy: userId,
        })
        .returning({ id: kernelThreads.id }),
    )
    return t.id
  }

  it("taints the parent thread when the hidden subrun thread is tainted", async () => {
    const { propagateTaintToParent } = await import("~/modules/agent/subruns/subrun-worker")
    const parentThreadId = await makeParentThread(orgId, userId)
    const hiddenThreadId = await makeHiddenThread(true)

    await propagateTaintToParent(orgId, hiddenThreadId, parentThreadId)

    const [parent] = await withPrivilegedDb(orgId, "verify-parent-taint", (tx) =>
      tx
        .select({ tainted: kernelThreads.tainted })
        .from(kernelThreads)
        .where(eq(kernelThreads.id, parentThreadId)),
    )
    expect(parent.tainted).toBe(true)
  })

  it("leaves the parent thread untainted when the hidden subrun thread is clean", async () => {
    const { propagateTaintToParent } = await import("~/modules/agent/subruns/subrun-worker")
    const parentThreadId = await makeParentThread(orgId, userId)
    const hiddenThreadId = await makeHiddenThread(false)

    await propagateTaintToParent(orgId, hiddenThreadId, parentThreadId)

    const [parent] = await withPrivilegedDb(orgId, "verify-parent-clean", (tx) =>
      tx
        .select({ tainted: kernelThreads.tainted })
        .from(kernelThreads)
        .where(eq(kernelThreads.id, parentThreadId)),
    )
    expect(parent.tainted).toBe(false)
  })

  it("is a no-op for root spawns with no parent thread", async () => {
    const { propagateTaintToParent } = await import("~/modules/agent/subruns/subrun-worker")
    const hiddenThreadId = await makeHiddenThread(true)
    // Must not throw when there is no parent surface thread.
    await propagateTaintToParent(orgId, hiddenThreadId, null)
  })
})

describe("subrun worker — stuck-run hardening (B12b)", () => {
  let orgId: string
  let userId: string

  beforeEach(async () => {
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId, { role: "admin" })).id
    await seedPricingAndCredits(orgId)
  })

  /** Seed an agent_runs row directly with caller-controlled lifecycle fields. */
  async function seedRun(opts: {
    status: "queued" | "running"
    subagentType?: string | null
    timeoutMs?: number
    startedAt?: Date | null
  }): Promise<string> {
    const threadId = await makeParentThread(orgId, userId)
    const runId = crypto.randomUUID()
    await withPrivilegedDb(orgId, "seed-run", async (tx) => {
      await tx.insert(agentRuns).values({
        id: runId,
        orgId,
        rootRunId: runId,
        threadId,
        actor: userActor(orgId, userId, []) as never,
        status: opts.status,
        subagentType: opts.subagentType ?? null,
        prompt: "do the thing",
        maxSteps: 10,
        timeoutMs: opts.timeoutMs ?? 30_000,
        schemaRetryBudget: 1,
        startedAt: opts.startedAt === undefined ? null : opts.startedAt,
      })
    })
    return runId
  }

  it("does not wedge the run when markRunFailed throws — error is caught/logged and runSubRun resolves", async () => {
    const { runSubRun } = await import("~/modules/agent/subruns/subrun-worker")

    // A queued run with a null subagent_type: runSubRun marks it running, then
    // the try-block immediately throws E_UNKNOWN_AGENT_TYPE, hitting the catch
    // that calls markRunFailed. Force markRunFailed to throw by making its
    // publishSubRunResult call reject — the new guard must swallow + log it so
    // runSubRun still resolves rather than rejecting and leaving the loop dead.
    const spy = spyOn(subRunAwaitModule, "publishSubRunResult").mockRejectedValue(
      new Error("redis publish exploded"),
    )
    try {
      const runId = await seedRun({ status: "queued", subagentType: null })

      // The key guarantee: runSubRun does NOT reject even though the failure-
      // recording path threw.
      await expect(runSubRun(runId, orgId)).resolves.toBeUndefined()
      expect(spy).toHaveBeenCalled()

      // markRunFailed's DB write lands before the throwing publish, so the row is
      // already out of `running`; regardless, the run is not silently wedged.
      const [row] = await withPrivilegedDb(orgId, "verify-not-wedged", (tx) =>
        tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
      )
      expect(row.status).not.toBe("running")
    } finally {
      spy.mockRestore()
    }
  })

  it("sweep transitions a running row past its timeout to failed/timeout", async () => {
    // started 10s ago with a 1s timeout → well past budget.
    const runId = await seedRun({
      status: "running",
      timeoutMs: 1_000,
      startedAt: new Date(Date.now() - 10_000),
    })

    await sweepStuckSubRuns()

    const [row] = await withPrivilegedDb(orgId, "verify-swept", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
    )
    expect(row.status).toBe("failed")
    expect(row.errorCode).toBe("timeout")
    expect(row.finishedAt).toBeTruthy()
  })

  it("sweep leaves a fresh running row (within its timeout) untouched", async () => {
    // Just started with a generous timeout → not yet eligible.
    const runId = await seedRun({
      status: "running",
      timeoutMs: 600_000,
      startedAt: new Date(),
    })

    await sweepStuckSubRuns()

    const [row] = await withPrivilegedDb(orgId, "verify-fresh-untouched", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
    )
    expect(row.status).toBe("running")
    expect(row.errorCode).toBeNull()
  })

  it("sweep publishes a result so an awaiting parent resolves immediately", async () => {
    const runId = await seedRun({
      status: "running",
      timeoutMs: 1_000,
      startedAt: new Date(Date.now() - 10_000),
    })

    // A parent already blocked on awaitSubRunResult; the sweep's publish wakes it.
    const awaited = awaitSubRunResult(runId, orgId, { continueOnError: true, timeoutMs: 10_000 })
    // Give the awaiter a moment to subscribe before the sweep publishes.
    await new Promise((resolve) => setTimeout(resolve, 100))

    await sweepStuckSubRuns()

    const result = await awaited
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("timeout")
  })
})
