// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The persisted shape of a reply in a shared thread. A model that narrates
// between tools ("I'll read the task first", "Retrying with the parent id")
// had every line joined into the one message posted to the room, so the
// teammates read the agent's working notes. A shared thread now stores the
// final step only; a private agent chat keeps every line, drawn where it was
// written. The turn is real: invokeAgentForThread consumes the stream, runs the
// tool through the turn's tool set, and the row asserted on is the stored one.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import crypto from "node:crypto"
import { simulateReadableStream, streamText } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { z } from "zod"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import * as eventBusModule from "~/infra/events/event-bus"
import {
  AgentServiceTestAccess,
  invokeAgentForThread,
  rerunAgentTurn,
} from "~/modules/agent/runtime/agent-service"
import { toolRegistry } from "~/modules/apps/app-registries"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-shared-thread-reply"
const TOOL = "str__probeTool"
const SCOPE = "str:probe:read"
const NARRATION = "I'll read the task first, then break it into subtasks.\n\n"
const ANSWER = "Three subtasks are filed under the task."

const CHIPS = "kernel__suggest_next_steps"
const CLOSED =
  "The retainer bills 4,950.00 a month for 44 hours, 112.50 an hour, and 120.00 above that. " +
  "I can open the project, pull the billing history, or ask an admin for the access you need."

type MockStep = Array<{ text: string } | { call: string; input?: unknown }>

/** The turn run by the real loop on a scripted model: its stop conditions and tools are the product's. */
function scriptedTurn(steps: MockStep[]) {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  }
  let n = 0
  const model = new MockLanguageModelV4({
    doStream: steps.map((step) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start" as const, warnings: [] },
          ...step.flatMap((part): unknown[] => {
            const id = `p${n++}`
            if ("call" in part) {
              return [
                {
                  type: "tool-call" as const,
                  toolCallId: id,
                  toolName: part.call,
                  input: JSON.stringify(part.input ?? {}),
                },
              ]
            }
            return [
              { type: "text-start" as const, id },
              { type: "text-delta" as const, id, delta: part.text },
              { type: "text-end" as const, id },
            ]
          }),
          {
            type: "finish" as const,
            finishReason: step.some((p) => "call" in p)
              ? { unified: "tool-calls" as const, raw: "TOOL" }
              : { unified: "stop" as const, raw: "STOP" },
            usage,
          },
        ],
      }),
    })) as never,
  })
  const run = ((opts: Parameters<typeof streamText>[0]) =>
    streamText({ ...opts, model })) as typeof streamText
  return { model, run }
}

const chips = (label: string) => ({ call: CHIPS, input: { steps: [{ label }] } })

type StreamTools = Record<string, { execute?: (args: unknown) => Promise<unknown> }>

/** Narrates, calls the probe tool, then answers in a second step. */
function narratingStream() {
  return (opts: { tools?: StreamTools }) => ({
    fullStream: (async function* () {
      const toolDef = opts.tools?.[TOOL]
      if (!toolDef?.execute) throw new Error(`${TOOL} is not in the turn tool set`)
      yield { type: "text-delta", text: NARRATION }
      yield { type: "tool-call", toolCallId: "call-str-0", toolName: TOOL, input: {} }
      const output = await toolDef.execute({})
      yield { type: "tool-result", toolCallId: "call-str-0", toolName: TOOL, input: {}, output }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "tool-calls",
      }
      yield { type: "text-delta", text: ANSWER }
      yield {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })
}

describe("a reply in a shared thread is the final answer only", () => {
  let orgId: string

  async function actorFor(userId: string): Promise<UserContext> {
    const { scopes } = await withPrivilegedDb(orgId, "test-str-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
  }

  async function seedThread(type: string, createdBy: string, participantIds: string[]) {
    return withPrivilegedDb(orgId, "test-str-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({ orgId, handle: `str-${crypto.randomUUID().slice(0, 8)}`, type, createdBy })
        .returning({ id: threads.id })
      for (const userId of participantIds) {
        await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      }
      return t.id
    })
  }

  async function seedPersonalAgent(ownerUserId: string): Promise<string> {
    const [agent] = await withPrivilegedDb(orgId, "test-str-agent", (tx) =>
      tx
        .insert(agents)
        .values({
          orgId,
          kind: "personal",
          handle: `@str-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Liaison",
          ownerUserId,
          scopeCeiling: [SCOPE],
        })
        .returning({ id: agents.id }),
    )
    if (!agent) throw new Error("no agent was seeded")
    return agent.id
  }

  /**
   * One real turn; returns the stored agent reply's content and timeline, and
   * the `agent_stream` frames the room's sockets were handed for it.
   */
  async function turn(
    threadId: string,
    actor: UserContext,
    stream: unknown = narratingStream(),
    background = false,
  ) {
    const msg = await withPrivilegedDb(orgId, "test-str-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: actor.userId,
        threadId,
        content: "@Liaison break this task into subtasks",
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("the requester could not post into the test thread")
    AgentServiceTestAccess.setStreamText(stream as never)
    const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral")
    let sent: Parameters<typeof eventBusModule.broadcastEphemeral>[0][] = []
    try {
      await invokeAgentForThread(threadId, msg.id, actor, orgId, background)
    } finally {
      sent = broadcastSpy.mock.calls.map(([event]) => event)
      broadcastSpy.mockRestore()
      AgentServiceTestAccess.setStreamText()
    }
    const frames = sent.filter(
      (event) => event.entity === "agent_stream" && event.entityId === threadId,
    )
    const streamed = frames
      .filter((event) => event.action === "delta")
      .map((event) => {
        const data = event.data as { delta?: unknown } | undefined
        return typeof data?.delta === "string" ? data.delta : ""
      })
      .join("")
    const toolCalls = frames.filter((event) => event.action === "tool_call").length
    const rows = await sql<{ content: string; metadata: { timeline?: unknown[] } | null }[]>`
      SELECT content, metadata FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
    if (rows.length !== 1) throw new Error(`expected one agent reply, saw ${rows.length}`)
    return { ...rows[0], streamed, toolCalls }
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    toolRegistry.set([orgId, "str", "probeTool"], {
      appName: "str",
      name: "probeTool",
      description: "Shared thread reply probe",
      requiredScopes: [SCOPE],
      handler: async () => ({ ok: true }),
      params: z.object({}),
    })
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'Claude Haiku Shared Reply', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([orgId, "str"])
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("a thread with a teammate in it stores the answer without the narration", async () => {
    const asker = (await minimal.person(orgId)).id
    await minimal.grantScope(asker, SCOPE)
    const teammate = (await minimal.person(orgId)).id
    // The room floor is every participant's grants: the teammate holds the scope too.
    await minimal.grantScope(teammate, SCOPE)
    await seedPersonalAgent(asker)
    const threadId = await seedThread("thread", asker, [asker, teammate])

    const reply = await turn(threadId, await actorFor(asker))

    expect(reply.content).toBe(ANSWER)
    const timelineText = JSON.stringify(reply.metadata?.timeline ?? [])
    expect(timelineText).not.toContain("read the task first")
    expect(timelineText).toContain("call-str-0")
    // The live stream: the room's sockets never receive the narration, while
    // the tool row and the answer still stream to them.
    expect(reply.streamed).toBe(ANSWER)
    expect(reply.toolCalls).toBe(1)
  })

  test("a private agent chat keeps the narration, drawn between the tools", async () => {
    const asker = (await minimal.person(orgId)).id
    await minimal.grantScope(asker, SCOPE)
    await seedPersonalAgent(asker)
    const threadId = await seedThread("agent_chat", asker, [asker])

    const reply = await turn(threadId, await actorFor(asker))

    expect(reply.content).toBe(NARRATION + ANSWER)
    expect(JSON.stringify(reply.metadata?.timeline ?? [])).toContain("read the task first")
    // The live stream is unchanged too: every line, as it is written.
    expect(reply.streamed).toBe(NARRATION + ANSWER)
    expect(reply.toolCalls).toBe(1)
  })

  /** A thread with a teammate, or the person's own chat, and the turn run in it by the real loop. */
  async function closedTurn(shared: boolean, steps: MockStep[], unwatched = false) {
    const asker = (await minimal.person(orgId)).id
    await minimal.grantScope(asker, SCOPE)
    const others = shared ? [(await minimal.person(orgId)).id] : []
    for (const other of others) await minimal.grantScope(other, SCOPE)
    await seedPersonalAgent(asker)
    const threadId = await seedThread(shared ? "thread" : "agent_chat", asker, [asker, ...others])
    const { model, run } = scriptedTurn(steps)
    const reply = await turn(threadId, await actorFor(asker), run, unwatched)
    return { reply, calls: model.doStreamCalls.length }
  }

  for (const shared of [true, false]) {
    test(`an answer closed by its next steps is the whole reply, ${shared ? "with a teammate" : "in private"}`, async () => {
      const { reply, calls } = await closedTurn(shared, [
        [{ text: CLOSED }, chips("Open the project")],
        [{ text: "To recap what I wrote above." }],
      ])
      expect(reply.content).toBe(CLOSED)
      expect(reply.streamed).toBe(CLOSED)
      expect(calls).toBe(1)
      expect(JSON.stringify(reply.metadata?.timeline ?? [])).toContain("4,950.00")
    })

    test(`it stays when the steps were refused, ${shared ? "with a teammate" : "in private"}`, async () => {
      const bad = { call: CHIPS, input: { steps: [{ label: "Open it", prompt: "other words" }] } }
      const { reply } = await closedTurn(shared, [
        [{ text: CLOSED }, bad],
        [chips("Open the project")],
        [{ text: "To recap what I wrote above." }],
      ])
      expect(reply.content).toBe(CLOSED)
      expect(reply.streamed).toBe(CLOSED)
    })
  }

  test("a short answer before its next steps is not lost, and a silent step is not asked again", async () => {
    const { reply, calls } = await closedTurn(true, [
      [{ text: "Yes, it went out on Monday." }, chips("Open it")],
      [],
    ])
    expect(reply.content).toBe("Yes, it went out on Monday.")
    expect(reply.streamed).toBe("Yes, it went out on Monday.")
    expect(calls).toBe(2)
  })

  test("work before the answer stays out of the room, the answer and its steps stay in", async () => {
    const { reply } = await closedTurn(true, [
      [{ text: NARRATION }, { call: TOOL }],
      [{ text: CLOSED }, chips("Open the project")],
    ])
    expect(reply.content).toBe(CLOSED)
    expect(JSON.stringify(reply.metadata?.timeline ?? [])).not.toContain("read the task first")
  })

  test("a run nobody watches keeps its answer when its next steps are refused", async () => {
    const { reply } = await closedTurn(
      true,
      [[{ text: CLOSED }, chips("Open the project")], [chips("Open the project")]],
      true,
    )
    expect(reply.content).toBe(CLOSED)
  })

  test("the answer asked for again to be shared is whole too, without the work before it", async () => {
    const asker = (await minimal.person(orgId)).id
    await minimal.grantScope(asker, SCOPE)
    const teammate = (await minimal.person(orgId)).id
    await minimal.grantScope(teammate, SCOPE)
    const agentId = await seedPersonalAgent(asker)
    const threadId = await seedThread("thread", asker, [asker, teammate])
    const { run } = scriptedTurn([
      [{ text: NARRATION }, { call: TOOL }],
      // A rerun answers and offers nothing: its steps are refused, and it says no more.
      [{ text: CLOSED }, chips("Open the project")],
      [],
    ])
    const msg = await withPrivilegedDb(orgId, "test-str-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId: asker,
        threadId,
        content: "@Liaison what does the retainer bill?",
        authorType: "user",
      }),
    )
    AgentServiceTestAccess.setStreamText(run as never)
    try {
      const reply = await rerunAgentTurn({
        orgId,
        threadId,
        turnId: msg?.id ?? "",
        requesterId: asker,
        agentId,
        effectiveScope: [SCOPE],
      })
      expect(reply.content).toBe(CLOSED)
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
  })
})
