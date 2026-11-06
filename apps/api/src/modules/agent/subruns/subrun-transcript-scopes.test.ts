// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sub-run's hidden transcript and its sub_run card summary quote what the
// child read. Each transcript row carries the child's accumulated scopes at
// write time, and when the summary is written the card is re-tagged with the
// union of its tag and the child's final scopes; the terminal sub_run:update
// event carries that tag so delivery can hide the summary from members lacking it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { z } from "zod"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { creditBalances, threads as kernelThreads, modelPricing } from "~/db/schema/kernel"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"
import { createSubAgentDefinition } from "~/modules/agent/subruns/sub-agent-definitions"
import { startSubrunWorker } from "~/modules/agent/subruns/subrun-worker"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const READ = "srt:deals:read"
const TEST_TIMEOUT_MS = 60_000

let orgId: string
let userId: string
let parentThreadId: string
let agentType: string

function actor(): UserContext {
  return { actorType: "user", userId, orgId, scopes: [READ], dimensionGrants: {} }
}

// The child's model: calls the named tools of its catalog in order, ends the
// step (the worker persists each step's transcript row from onStepFinish), then answers.
function childCalls(sdkNames: string[], text: string) {
  return ((params: {
    tools?: Record<string, { execute: (a: unknown) => Promise<unknown> }>
    onStepFinish?: (step: unknown) => Promise<void> | void
  }) => ({
    fullStream: (async function* () {
      const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> = []
      const toolResults: Array<{ toolCallId: string; result: unknown }> = []
      for (const [i, name] of sdkNames.entries()) {
        const t = params.tools?.[name]
        if (!t) throw new Error(`${name} is not in the sub-run catalog`)
        const toolCallId = `srt-call-${i}`
        toolCalls.push({ toolCallId, toolName: name, input: {} })
        toolResults.push({ toolCallId, result: await t.execute({}) })
      }
      await params.onStepFinish?.({
        text,
        toolCalls,
        toolResults,
        usage: { inputTokens: 1, outputTokens: 1 },
      })
      yield { type: "text-delta", text }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })) as never
}

async function waitForRows<T>(read: () => Promise<T[]>, n: number): Promise<T[]> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const rows = await read()
    if (rows.length >= n || Date.now() > deadline) return rows
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_ANTHROPIC_API_KEY = "sk-srt-stub"
})

afterAll(async () => {
  if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
  else delete process.env.LIAISON_ANTHROPIC_API_KEY
  await releaseTestLock()
})

beforeEach(async () => {
  orgId = (await createTestOrg()).id
  userId = (await minimal.person(orgId, { role: "admin" })).id
  await withSystemDb("srt-seed-pricing", async (db) => {
    await db
      .insert(modelPricing)
      .values({
        provider: "anthropic",
        modelId: "claude-haiku-4-5-srt",
        displayName: "Subrun transcript Haiku",
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
  const [t] = await withPrivilegedDb(orgId, "srt-parent-thread", (tx) =>
    tx
      .insert(kernelThreads)
      .values({
        orgId,
        handle: `srt-${crypto.randomUUID().slice(0, 8)}`,
        type: "thread",
        createdBy: userId,
      })
      .returning({ id: kernelThreads.id }),
  )
  parentThreadId = t.id
  agentType = `srt-${crypto.randomUUID().slice(0, 6)}`
  await createSubAgentDefinition({
    orgId,
    creatorScopes: [READ],
    agentType,
    whenToUse: "transcript scope test",
    scopeCeiling: [READ],
    toolAllowlist: ["srt:scoped_read"],
    systemPrompt: "Read the deal.",
  })
  toolRegistry.set([orgId, "srt", "scoped_read"], {
    appName: "srt",
    name: "scoped_read",
    description: "reads a deal",
    requiredScopes: [READ],
    readOnly: true,
    params: z.object({}).passthrough(),
    handler: async () => ({ deal: "Deal 42 closes Friday at 1.2M" }),
  })
  await startSubrunWorker()
})

afterEach(() => {
  AgentServiceTestAccess.setStreamText()
  toolRegistry.deleteByPrefix([orgId])
})

describe("sub-run transcript and card carry the child's scopes", () => {
  it(
    "each transcript row is tagged with the child's accumulated scopes at write time",
    async () => {
      AgentServiceTestAccess.setStreamText(
        childCalls(["srt__scoped_read"], "Deal 42 closes Friday"),
      )
      const handle = await spawnAgent({
        parentRun: { id: null, threadId: parentThreadId, actor: actor(), nestingDepth: 0 },
        subagentType: agentType,
        description: "transcript scopes",
        prompt: "look up the deal",
      })
      const result = await handle.awaitResult()
      expect(result.ok).toBe(true)

      const [run] = await sql<{ thread_id: string }[]>`
        SELECT thread_id FROM kernel.agent_runs WHERE id = ${handle.runId}`
      const rows = await waitForRows(
        () => sql<{ author_type: string; content: string; required_scopes: string[] }[]>`
          SELECT author_type, content, required_scopes FROM kernel.messages
          WHERE thread_id = ${run?.thread_id ?? ""} ORDER BY created_at`,
        2,
      )
      // The prompt is the parent's own words, written before the child read anything.
      expect(rows.find((r) => r.author_type === "user")?.required_scopes).toEqual([])
      // The step that called the scoped tool quotes what it read.
      const step = rows.find((r) => r.author_type === "agent")
      expect(step?.content).toContain("Deal 42")
      expect(step?.required_scopes).toEqual([READ])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "the card is re-tagged with the child's final scopes and the done event carries that tag",
    async () => {
      AgentServiceTestAccess.setStreamText(
        childCalls(["srt__scoped_read"], "Deal 42 closes Friday"),
      )
      const handle = await spawnAgent({
        parentRun: { id: null, threadId: parentThreadId, actor: actor(), nestingDepth: 0 },
        subagentType: agentType,
        description: "card scopes",
        prompt: "look up the deal",
      })
      await handle.awaitResult()

      const [card] = await sql<{ required_scopes: string[] }[]>`
        SELECT required_scopes FROM kernel.messages
        WHERE thread_id = ${parentThreadId} AND metadata ->> 'kind' = 'sub_run'
          AND metadata -> 'subRun' ->> 'runId' = ${handle.runId}`
      expect(card?.required_scopes).toEqual([READ])

      // AFTER the awaited result, not with it. `handle.awaitResult()` resolves
      // on publishSubRunResult, which the worker calls BEFORE emitSubRunStatus
      // queues the terminal frame on the outbox: the two are separate
      // transactions and the second one is deliberately best-effort. Reading
      // the outbox the instant the result lands is therefore a race that the
      // single-file run happened to win and a directory run lost, which is what
      // made this the only flaky oracle on the branch. Wait for the row the way
      // the transcript assertion above already waits for its messages.
      const [done] = await waitForRows(
        () => sql<{ payload: { data: Record<string, unknown> } }[]>`
          SELECT payload FROM kernel.pending_events
          WHERE org_id = ${orgId} AND payload ->> 'entity' = 'sub_run'
            AND payload ->> 'entityId' = ${handle.runId}
            AND payload -> 'data' ->> 'status' = 'done'`,
        1,
      )
      expect(done?.payload.data.summary).toBe("Deal 42 closes Friday")
      expect(done?.payload.data.requiredScopes).toEqual([READ])
    },
    TEST_TIMEOUT_MS,
  )

  it(
    "Invariant K: a mail tool's drafted text stays out of the hidden transcript",
    async () => {
      AgentServiceTestAccess.setStreamText(((params: {
        onStepFinish?: (step: unknown) => Promise<void> | void
      }) => ({
        fullStream: (async function* () {
          await params.onStepFinish?.({
            text: "Replied.",
            toolCalls: [
              {
                toolCallId: "srt-mail",
                toolName: "mail__reply",
                input: { textBody: "OBSIDIANSUBRUNDRAFT" },
              },
            ],
            toolResults: [{ toolCallId: "srt-mail", result: { textBody: "OBSIDIANSUBRUNRESULT" } }],
            usage: { inputTokens: 1, outputTokens: 1 },
          })
          yield { type: "text-delta", text: "Replied." }
          yield {
            type: "finish-step",
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: "stop",
          }
          yield { type: "finish", finishReason: "stop" }
        })(),
      })) as never)
      const handle = await spawnAgent({
        parentRun: { id: null, threadId: parentThreadId, actor: actor(), nestingDepth: 0 },
        subagentType: agentType,
        description: "mail redaction",
        prompt: "reply to it",
      })
      await handle.awaitResult()
      const [run] = await sql<{ thread_id: string }[]>`
        SELECT thread_id FROM kernel.agent_runs WHERE id = ${handle.runId}`
      const rows = await waitForRows(
        () => sql<{ metadata: { toolCalls?: Array<Record<string, unknown>> } | null }[]>`
          SELECT metadata FROM kernel.messages
          WHERE thread_id = ${run?.thread_id ?? ""} AND author_type = 'agent'
          ORDER BY created_at`,
        1,
      )
      const calls = rows[0]?.metadata?.toolCalls ?? []
      expect(calls.map((c) => c.toolName)).toEqual(["mail__reply"])
      expect(calls[0]?.args).toMatchObject({ redacted: true, redactedFields: ["textBody"] })
      expect(calls[0]?.result).toMatchObject({ redacted: true })
      expect(JSON.stringify(calls)).not.toContain("OBSIDIANSUBRUN")
    },
    TEST_TIMEOUT_MS,
  )
})
