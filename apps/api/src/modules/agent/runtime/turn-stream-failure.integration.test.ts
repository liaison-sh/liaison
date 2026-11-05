// SPDX-License-Identifier: FSL-1.1-ALv2
// A provider that stops answering in the middle of a step, through the real
// agent loop (invokeAgentForThread's consumer, runAgentChat, the tool bridge,
// the effect ledger, the journal and the resume) with the scripted provider:
// only the model's tokens are scripted, and a `streamFailure` step breaks its
// stream off the way a dropped upstream does (an in-band error, no finish).
//
//  - broken off once: the turn is handed off at its last complete step, the
//    resume runs the cut step again, and the turn ends `done` with one reply
//    that holds nothing of the cut step, and the complete step's write is not
//    run again;
//  - broken off every time: after its re-runs the turn ends `failed`, and the
//    reply says the provider stopped responding and to continue;
//  - stopped by its own deadline after writing some text: the reply keeps the
//    text and says it ran out of time, and the turn is `failed`, not `done`;
//  - a turn with no budget of its own runs on a progress deadline: steps that
//    keep completing run past the step limit in total, and only a step that
//    makes no progress for the limit stops it (turn-deadline.ts).
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { AGENT_NOTICE_STORED_LINES } from "@liaison/shared"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agents, creditBalances, modelPricing, threadParticipants } from "~/db/schema/kernel"
import * as eventBusModule from "~/infra/events/event-bus"
import {
  clearScriptedTurns,
  setScriptedTurn,
} from "~/modules/agent/providers/scripted-model-provider"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { TurnHandoffTestAccess } from "~/modules/agent/runtime/turn-handoff"
import { resumeTurn } from "~/modules/agent/runtime/turn-resume"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const ORIG_PROVIDER = process.env.LIAISON_MODEL_PROVIDER

/** A write that counts in this process: how many times it really ran. */
const COUNTER = "kernel__test_stream_failure_counter"
const counted = new Map<string, number>()

/** What the cut step streamed before its provider broke off. */
const PARTIAL = "Running the lookup the refusal asked"

let owner: minimal.Session
let agentId: string
let threadId: string
let ownerScopes: string[] = []

async function freshThread(): Promise<void> {
  threadId = await minimal.thread(owner.orgId, owner.userId)
  await withPrivilegedDb(owner.orgId, "test:stream-failure-seat", (tx) =>
    tx.insert(threadParticipants).values({
      threadId,
      agentId,
      orgId: owner.orgId,
      participantType: "agent",
    }),
  )
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() > end) return v
    await Bun.sleep(50)
  }
}

/** The person's message, then the turn that answers it, as a thread mention runs it. */
async function runTurn(content: string, budget?: { timeoutMs: number }): Promise<string> {
  const msg = await withPrivilegedDb(owner.orgId, "test:stream-failure-msg", (tx) =>
    sendMessage(tx as unknown as RlsClient, {
      requiredScopes: [],
      orgId: owner.orgId,
      userId: owner.userId,
      threadId,
      content,
      authorType: "user",
    }),
  )
  if (!msg) throw new Error("could not post into the test thread")
  await invokeAgentForThread(
    threadId,
    msg.id,
    {
      userId: owner.userId,
      orgId: owner.orgId,
      scopes: ownerScopes,
      dimensionGrants: {},
    },
    owner.orgId,
    false,
    budget,
  )
  const [row] = await sql<{ id: string }[]>`
    SELECT id FROM kernel.agent_turns WHERE thread_id = ${threadId} ORDER BY created_at DESC LIMIT 1`
  if (!row) throw new Error("the turn opened no record")
  return row.id
}

const turnRow = async (turnId: string) => {
  const [row] = await sql<
    {
      state: string
      step_count: number
      attempt: number
      failure_reason: string | null
      error_code: string | null
    }[]
  >`SELECT state, step_count, attempt, failure_reason, error_code
    FROM kernel.agent_turns WHERE id = ${turnId}`
  return row
}

const agentReplies = async () =>
  sql<{ content: string }[]>`
    SELECT content FROM kernel.messages
    WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`

/** The live frames this thread's turn broadcast, by action. */
const streamActions = (): string[] =>
  broadcastSpy.mock.calls
    .map(([event]) => event as { entity?: string; action?: string; entityId?: string })
    .filter((e) => e.entity === "agent_stream" && e.entityId === threadId)
    .map((e) => e.action ?? "")

describe("a provider that stops answering mid-step", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    process.env.LIAISON_MODEL_PROVIDER = "scripted"
    owner = await minimal.adminSession((await createTestOrg()).id)
    agentId = await withPrivilegedDb(owner.orgId, "test:stream-failure-setup", async (tx) => {
      const [agent] = await tx
        .insert(agents)
        .values({
          orgId: owner.orgId,
          kind: "personal",
          handle: `@sf-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Sam",
          scopeCeiling: ["*"],
          ownerUserId: owner.userId,
        })
        .returning({ id: agents.id })
      await tx
        .insert(creditBalances)
        .values({
          orgId: owner.orgId,
          includedBalance: "10",
          purchasedBalance: "0",
          currency: "EUR",
        })
        .onConflictDoNothing()
      await tx
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          displayName: "Claude Haiku 4.5",
          inputCostPerM: "1",
          outputCostPerM: "5",
          contextWindow: 200000,
          autoEligible: true,
          tierMinimum: "starter",
        })
        .onConflictDoNothing()
      return agent.id
    })
    toolRegistry.set([owner.orgId, "kernel", "test_stream_failure_counter"], {
      appName: "kernel",
      name: "test_stream_failure_counter",
      description: "Test only: count one effect under key.",
      requiredScopes: ["kernel:agent:web"],
      params: z.object({ key: z.string() }),
      handler: async (raw: unknown) => {
        const { key } = z.object({ key: z.string() }).parse(raw)
        const count = (counted.get(key) ?? 0) + 1
        counted.set(key, count)
        return { key, count }
      },
    })
    const perms = await withPrivilegedDb(owner.orgId, "test:stream-failure-owner", (tx) =>
      loadEffectivePermissions(tx, owner.userId, owner.orgId),
    )
    ownerScopes = perms.scopes
  })

  afterEach(async () => {
    await clearScriptedTurns(threadId)
    TurnHandoffTestAccess.clear()
    AgentServiceTestAccess.setTurnDeadline()
    broadcastSpy.mockClear()
  })

  afterAll(async () => {
    toolRegistry.delete([owner.orgId, "kernel", "test_stream_failure_counter"])
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    if (ORIG_PROVIDER !== undefined) process.env.LIAISON_MODEL_PROVIDER = ORIG_PROVIDER
    else delete process.env.LIAISON_MODEL_PROVIDER
    broadcastSpy.mockRestore()
    await releaseTestLock()
  })

  it("runs the cut step again from the last complete one: one reply, nothing of the cut step, no write doubled", async () => {
    await freshThread()
    const done1 = `sf-once-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: COUNTER, args: { key: done1 } }] },
      // The answer step: the provider breaks it off mid-sentence once.
      { text: "It is recorded.", streamFailure: { times: 1, partial: PARTIAL } },
    ])
    const turnId = await runTurn("record it")

    // The first attempt stopped at its last complete step and handed off.
    const handed = await turnRow(turnId)
    expect({ state: handed.state, steps: handed.step_count }).toEqual({
      state: "handoff",
      steps: 1,
    })
    expect((await agentReplies()).length).toBe(0)
    // No failure reached the live view: the turn is not over.
    expect(streamActions()).not.toContain("error")
    expect(counted.get(done1)).toBe(1)

    expect(await resumeTurn(owner.orgId, turnId)).toBe("resumed")
    const done = await until(
      () => turnRow(turnId),
      (row) => row.state === "done",
    )
    expect({ state: done.state, steps: done.step_count, attempt: done.attempt }).toEqual({
      state: "done",
      steps: 2,
      attempt: 1,
    })
    // One reply, the answer, with nothing of the cut step's text.
    const replies = await agentReplies()
    expect(replies.map((m) => m.content)).toEqual(["It is recorded."])
    // The live view dropped the cut step's frames (the resume frame rewinds them).
    expect(streamActions()).toContain("resume")
    expect(streamActions()).not.toContain("error")
    // The complete step's write was not run again by the re-run: it is journaled.
    expect(counted.get(done1)).toBe(1)
  })

  it("after its re-runs, a provider that never answers fails the turn with a line that says to continue", async () => {
    await freshThread()
    const done1 = `sf-always-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: COUNTER, args: { key: done1 } }] },
      { text: "Never reached.", streamFailure: { times: 99, partial: PARTIAL } },
    ])
    const turnId = await runTurn("record it")
    expect((await turnRow(turnId)).state).toBe("handoff")
    // Re-run 1 breaks off as well and hands off again.
    expect(await resumeTurn(owner.orgId, turnId)).toBe("resumed")
    const again = await until(
      () => turnRow(turnId),
      (row) => row.state !== "running",
    )
    expect({ state: again.state, attempt: again.attempt }).toEqual({
      state: "handoff",
      attempt: 1,
    })
    // Re-run 2 is the last: the failure is the turn's answer.
    expect(await resumeTurn(owner.orgId, turnId)).toBe("resumed")
    const failed = await until(
      () => turnRow(turnId),
      (row) => row.state !== "running" && row.state !== "handoff",
    )
    expect({
      state: failed.state,
      attempt: failed.attempt,
      failureReason: failed.failure_reason,
    }).toEqual({ state: "failed", attempt: 2, failureReason: "turn" })

    const replies = await agentReplies()
    expect(replies.length).toBe(1)
    const reply = replies[0].content
    expect(reply).toContain(AGENT_NOTICE_STORED_LINES.provider_unavailable)
    expect(reply).toContain('Say "continue"')
    // The last attempt's cut text shows once, above the line; no earlier attempt's.
    expect(reply.split(PARTIAL).length - 1).toBe(1)
    expect(reply).not.toContain("Never reached.")
    // Three attempts, and the complete step's write still ran once.
    expect(counted.get(done1)).toBe(1)
  })

  it("a turn its explicit wall-clock budget stops after it wrote some text says it ran out of time and is not done", async () => {
    await freshThread()
    const key = `sf-deadline-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { text: "Running the lookup now.", toolCalls: [{ name: COUNTER, args: { key } }] },
      // The next step is still running when the turn's deadline passes.
      { text: "Too late.", delayMs: 4_000 },
    ])
    const turnId = await runTurn("look it up", { timeoutMs: 1_500 })

    const row = await turnRow(turnId)
    expect({
      state: row.state,
      failureReason: row.failure_reason,
      errorCode: row.error_code,
    }).toEqual({ state: "failed", failureReason: "turn", errorCode: "timeout" })
    const replies = await agentReplies()
    expect(replies.length).toBe(1)
    expect(replies[0].content.startsWith("Running the lookup now.\n\n⚠️ I ran out of time")).toBe(
      true,
    )
    expect(replies[0].content).toContain("Ask me to continue")
    expect(replies[0].content).not.toContain("Too late.")
  })

  it("a turn of steps that keep completing runs past the step limit in total and finishes", async () => {
    // The step limit is 1 s here; four steps of 0.5 s each take about 2 s.
    AgentServiceTestAccess.setTurnDeadline({ stepMs: 1_000, ceilingMs: 30_000 })
    await freshThread()
    // Three read-only steps, then the answer.
    const keys = [1, 2, 3].map((n) => `sf-progress-${n}-${crypto.randomUUID()}`)
    await setScriptedTurn(threadId, [
      ...keys.map((key) => ({
        toolCalls: [{ name: "kernel__tool_search", args: { query: key } }],
        delayMs: 500,
      })),
      { text: "All three are looked up.", delayMs: 500 },
    ])
    const started = Date.now()
    const turnId = await runTurn("look up three")
    expect(Date.now() - started).toBeGreaterThan(1_500)

    const row = await turnRow(turnId)
    expect({ state: row.state, steps: row.step_count }).toEqual({ state: "done", steps: 4 })
    expect((await agentReplies()).map((m) => m.content)).toEqual(["All three are looked up."])
  })

  it("a step that makes no progress for the step limit stops the turn visibly", async () => {
    AgentServiceTestAccess.setTurnDeadline({ stepMs: 1_000, ceilingMs: 30_000 })
    await freshThread()
    const key = `sf-stuck-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      {
        text: "Running the lookup now.",
        toolCalls: [{ name: COUNTER, args: { key } }],
        delayMs: 500,
      },
      // Stuck: no progress for three times the step limit.
      { text: "Too late.", delayMs: 3_000 },
    ])
    const turnId = await runTurn("look it up")

    const row = await turnRow(turnId)
    expect({
      state: row.state,
      failureReason: row.failure_reason,
      errorCode: row.error_code,
    }).toEqual({ state: "failed", failureReason: "turn", errorCode: "timeout" })
    const replies = await agentReplies()
    expect(replies.length).toBe(1)
    expect(replies[0].content).toStartWith(
      "Running the lookup now.\n\n⚠️ I ran out of time before I could write a final answer (this run's limit is 1s without progress in one step).",
    )
    expect(replies[0].content).toContain("Ask me to continue")
    expect(replies[0].content).not.toContain("Too late.")
  })
})
