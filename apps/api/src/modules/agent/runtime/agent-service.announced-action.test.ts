// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The announced action nudge (announced-action-claim.ts, wired through the
// false approval guard's continuation in agent-service.ts), through a real
// turn: invokeAgentForThread consumes the stream and the row asserted on is
// the stored reply. The model is scripted, one script per model run.
//
// Measured failure: asked to book a shipment, a weak model answered "I'll
// book the shipment now." and ended the turn without a tool call, so nothing
// was booked and the person waited.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { ANNOUNCED_ACTION_NOTE } from "~/modules/agent/runtime/announced-action-claim"
import { serverT } from "~/modules/i18n/server-i18n"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-announced-action"

const ANNOUNCEMENT = "Colissimo is the cheapest at 12.40 EUR. I'll book the shipment now."
const FOLLOW_UP = "I searched for a shipping tool: none is connected here, so I cannot book it."

type Chunk = Record<string, unknown>
type ModelOpts = {
  messages: Array<{ role: string; content: unknown }>
  prepareStep?: (options: unknown) => { toolChoice?: string } | undefined
  tools?: Record<string, { execute?: (input: unknown, o: unknown) => Promise<unknown> }>
}
type Run = {
  chunks: Chunk[] | ((opts: ModelOpts) => Promise<Chunk[]>)
  beforeEnd?: () => Promise<void>
}

const finishStep = (finishReason: string): Chunk => ({
  type: "finish-step",
  usage: { inputTokens: 10, outputTokens: 1 },
  finishReason,
})

/** A run that writes `text` and stops. */
const answer = (text: string): Run => ({
  chunks: [
    { type: "text-delta", text },
    finishStep("stop"),
    { type: "finish", finishReason: "stop" },
  ],
})

/** The turn's tool executions, by name. */
const executed: string[] = []

/** A run that EXECUTES the turn's real `toolName` tool, then writes `text`. */
const realToolThenAnswer = (toolName: string, input: unknown, text: string): Run => ({
  chunks: async (opts) => {
    const tool = opts.tools?.[toolName]
    if (!tool?.execute) throw new Error(`the continuation has no executable ${toolName}`)
    const output = await tool.execute(input, { toolCallId: "call-aa-1", messages: opts.messages })
    executed.push(toolName)
    return [
      { type: "tool-call", toolCallId: "call-aa-1", toolName, input },
      { type: "tool-result", toolCallId: "call-aa-1", toolName, input, output },
      finishStep("tool-calls"),
      { type: "text-delta", text },
      finishStep("stop"),
      { type: "finish", finishReason: "stop" },
    ]
  },
})

/** Plays one run per model call, and records each call's messages. */
function scripted(runs: Run[]) {
  const calls: Array<Array<{ role: string; content: unknown }>> = []
  /** Each call's tool choice for its first step, as its step hook sets it. */
  const firstToolChoice: Array<string | undefined> = []
  const fn = (opts: ModelOpts) => {
    const run = runs[calls.length]
    calls.push(opts.messages)
    firstToolChoice.push(opts.prepareStep?.({ stepNumber: 0, steps: [], messages: [] })?.toolChoice)
    if (!run) throw new Error(`unexpected model run #${calls.length}`)
    const chunks = typeof run.chunks === "function" ? run.chunks(opts) : Promise.resolve(run.chunks)
    const text = chunks.then((cs) =>
      cs
        .filter((c) => c.type === "text-delta")
        .map((c) => c.text as string)
        .join(""),
    )
    return {
      fullStream: (async function* () {
        for (const c of await chunks) {
          if (c.type === "finish" && run.beforeEnd) await run.beforeEnd()
          yield c
        }
      })(),
      responseMessages: text.then((t) => [
        { role: "assistant", content: [{ type: "text", text: t }] },
      ]),
    }
  }
  return { fn, calls, firstToolChoice }
}

describe("an announced action with no tool call gets one nudge", () => {
  let orgId: string
  let userId: string
  let actor: UserContext

  async function seedChat(): Promise<string> {
    return withPrivilegedDb(orgId, "test-aa-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `aa-${crypto.randomUUID().slice(0, 8)}`,
          type: "agent_chat",
          createdBy: userId,
          agentModelId: MODEL_ID,
        })
        .returning({ id: threads.id })
      await tx.insert(threadParticipants).values({ threadId: t.id, userId, orgId })
      return t.id
    })
  }

  async function insertApproval(threadId: string, handle: string): Promise<void> {
    await sql`INSERT INTO kernel.approval_requests
      (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload, expires_at, requested_by)
      VALUES (${orgId}, ${handle}, ${threadId}, ${threadId}, 'boxtal:create_shipment', '{}'::jsonb, '{}'::jsonb,
        now() + interval '1 day', ${userId})`
  }

  /** One real turn; returns the stored reply and the model calls made. */
  async function turn(threadId: string, runs: Run[]) {
    const msg = await withPrivilegedDb(orgId, "test-aa-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId,
        threadId,
        content: "Book the shipment for order #1097 with Colissimo.",
        authorType: "user",
      }),
    )
    if (!msg) throw new Error("could not post into the test thread")
    const script = scripted(runs)
    AgentServiceTestAccess.setStreamText(script.fn as never)
    try {
      await invokeAgentForThread(threadId, msg.id, actor, orgId)
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
    const rows = await sql<
      {
        content: string
        metadata: {
          timeline?: Array<{ kind: string; toolCallId?: string; text?: string }>
          announcedActionCorrected?: boolean
          announcedActionCorrectionDropped?: boolean
          falseApprovalCorrected?: boolean
        }
      }[]
    >`SELECT content, metadata FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
    if (rows.length !== 1) throw new Error(`expected one agent reply, saw ${rows.length}`)
    return { reply: rows[0], calls: script.calls, firstToolChoice: script.firstToolChoice }
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId)).id
    const { scopes } = await withPrivilegedDb(orgId, "test-aa-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    actor = { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
    await withPrivilegedDb(orgId, "test-aa-agent", (tx) =>
      tx.insert(agents).values({
        orgId,
        kind: "personal",
        handle: `@aa-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId: userId,
        scopeCeiling: ["*"],
      }),
    )
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency)
      VALUES (${orgId}, '10.00000000', '0', 'EUR')
      ON CONFLICT (org_id) DO UPDATE SET included_balance = '10.00000000'`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', ${MODEL_ID}, 'False approval test', '1.00', '5.00', 200000, true, 'starter')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  test("an announcement with no tool call gets one nudge, and the follow-up tool call runs", async () => {
    const threadId = await seedChat()
    executed.length = 0
    const { reply, calls } = await turn(threadId, [
      answer(ANNOUNCEMENT),
      realToolThenAnswer("kernel__tool_search", { query: "create shipment" }, FOLLOW_UP),
    ])

    expect(calls.length).toBe(2)
    // The continuation carries the turn's own answer, then the nudge last.
    const second = calls[1]
    expect(second[second.length - 1]).toEqual({ role: "user", content: ANNOUNCED_ACTION_NOTE })
    expect(JSON.stringify(second[second.length - 2])).toContain("book the shipment now")
    // The follow-up's tool call executed and is part of the stored turn.
    expect(executed).toEqual(["kernel__tool_search"])
    expect(
      reply.metadata.timeline?.some((e) => e.kind === "tool" && e.toolCallId === "call-aa-1"),
    ).toBe(true)
    // One answer: the follow-up, without the empty announcement.
    expect(reply.content).toBe(FOLLOW_UP)
    expect(reply.metadata.announcedActionCorrected).toBe(true)
    expect(reply.metadata.falseApprovalCorrected).toBeUndefined()
  })

  test("a plan that ends on its own next step, whatever the verb, gets the nudge", async () => {
    // Measured: the plan ended "Let's do the scope lookup first." with no call.
    const threadId = await seedChat()
    executed.length = 0
    const plan =
      "The user wants a weekly Monday digest of open tickets. Cron 0 8 * * 1.\n\nLet's do the scope lookup first."
    const { reply, calls } = await turn(threadId, [
      answer(plan),
      realToolThenAnswer("kernel__tool_search", { query: "create routine" }, FOLLOW_UP),
    ])

    expect(calls.length).toBe(2)
    expect(calls[1][calls[1].length - 1]).toEqual({ role: "user", content: ANNOUNCED_ACTION_NOTE })
    expect(executed).toEqual(["kernel__tool_search"])
    expect(reply.content).toBe(FOLLOW_UP)
    expect(reply.metadata.announcedActionCorrected).toBe(true)
  })

  test("a plan written out as the answer, ending on a tool call it never made, gets the nudge", async () => {
    // Measured: asked for a weekly digest, a weak model wrote its plan as the
    // answer and ended the turn on "Let me call routine_tool_scopes." with no call.
    const threadId = await seedChat()
    executed.length = 0
    const plan =
      "The user wants a weekly Monday digest of open tickets. Cron 0 8 * * 1.\n\nScopes: tickets:tickets:read.\n\nLet me call routine_tool_scopes."
    const { reply, calls } = await turn(threadId, [
      answer(plan),
      realToolThenAnswer("kernel__tool_search", { query: "create routine" }, FOLLOW_UP),
    ])

    expect(calls.length).toBe(2)
    expect(calls[1][calls[1].length - 1]).toEqual({ role: "user", content: ANNOUNCED_ACTION_NOTE })
    expect(executed).toEqual(["kernel__tool_search"])
    expect(reply.content).toBe(FOLLOW_UP)
    expect(reply.metadata.announcedActionCorrected).toBe(true)
  })

  test("a correction that ends on its own plan again gets one more continuation whose first step calls a tool", async () => {
    // Measured: the correction answered "Let me call routine_tool_scopes. Then
    // create_routine. Let me do that." and the turn ended there, so no routine.
    const threadId = await seedChat()
    executed.length = 0
    const plan =
      "The user wants a weekly Monday digest of open tickets.\n\nLet's do the scope lookup and then create."
    const again =
      "Let me call routine_tool_scopes for tickets__search. Then create_routine. Let me do that."
    const { reply, calls, firstToolChoice } = await turn(threadId, [
      answer(plan),
      answer(again),
      realToolThenAnswer("kernel__tool_search", { query: "create routine" }, FOLLOW_UP),
    ])

    expect(calls.length).toBe(3)
    expect(firstToolChoice).toEqual([undefined, undefined, "required"])
    const third = calls[2]
    expect(third[third.length - 1]).toEqual({ role: "user", content: ANNOUNCED_ACTION_NOTE })
    expect(JSON.stringify(third[third.length - 2])).toContain("Let me do that")
    expect(executed).toEqual(["kernel__tool_search"])
    // The stored reply is the answer after the tool, without either plan.
    expect(reply.content).toBe(FOLLOW_UP)
    expect(reply.metadata.announcedActionCorrected).toBe(true)
  })

  test("the extra continuation's model call is metered with the turn", async () => {
    const threadId = await seedChat()
    executed.length = 0
    const metered = async () => {
      const [row] = await sql<{ input: string | null; output: string | null }[]>`
        SELECT sum(input_tokens)::text AS input, sum(output_tokens)::text AS output
        FROM kernel.credit_transactions WHERE org_id = ${orgId} AND model = ${MODEL_ID}`
      return { input: Number(row?.input ?? 0), output: Number(row?.output ?? 0) }
    }
    const before = await metered()
    const { reply, calls } = await turn(threadId, [
      answer(ANNOUNCEMENT),
      answer("Let me call routine_tool_scopes. Let me do that."),
      realToolThenAnswer("kernel__tool_search", { query: "create routine" }, FOLLOW_UP),
    ])
    expect(calls.length).toBe(3)
    // Four steps over three model calls, 10 input and 1 output token each.
    const after = await metered()
    expect({ input: after.input - before.input, output: after.output - before.output }).toEqual({
      input: 40,
      output: 4,
    })
    expect((reply.metadata as { usage?: unknown }).usage).toMatchObject({
      inputTokens: 40,
      outputTokens: 4,
    })
  })

  test("a correction that calls a tool and then ends on its plan gets one more continuation", async () => {
    const threadId = await seedChat()
    executed.length = 0
    const again = "I still need routine_tool_scopes. Let me do that."
    const { reply, calls, firstToolChoice } = await turn(threadId, [
      answer(ANNOUNCEMENT),
      realToolThenAnswer("kernel__tool_search", { query: "routine scopes" }, again),
      realToolThenAnswer("kernel__tool_search", { query: "create routine" }, FOLLOW_UP),
    ])

    expect(calls.length).toBe(3)
    expect(firstToolChoice[2]).toBe("required")
    expect(executed).toEqual(["kernel__tool_search", "kernel__tool_search"])
    expect(reply.content).toBe(FOLLOW_UP)
    expect(reply.content).not.toContain("Let me do that")
  })

  test("a third announcement triggers nothing more", async () => {
    const threadId = await seedChat()
    const again = "I'll book the shipment now, one moment."
    const third = "I'll book it right now."
    const { reply, calls } = await turn(threadId, [
      answer(ANNOUNCEMENT),
      answer(again),
      answer(third),
    ])

    expect(calls.length).toBe(3)
    expect(reply.content).toBe(third)
  })

  test("an offer that waits for the person triggers nothing", async () => {
    const threadId = await seedChat()
    const offer = "Colissimo is the cheapest at 12.40 EUR. Shall I book it?"
    const { reply, calls } = await turn(threadId, [answer(offer)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(offer)
    expect(reply.metadata.announcedActionCorrected).toBeUndefined()
  })

  test("an offer that waits on the person's input triggers nothing", async () => {
    const threadId = await seedChat()
    const offer =
      "No, the mailbox is not working: the IMAP host could not be resolved. Give me the correct IMAP and SMTP hosts and I'll update the mailbox."
    const { reply, calls } = await turn(threadId, [answer(offer)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(offer)
    expect(reply.metadata.announcedActionCorrected).toBeUndefined()
  })

  test("a correction that calls no tool yet reports an action done is dropped: the first answer stays", async () => {
    const threadId = await seedChat()
    const fabricated =
      "I just re-checked the shipping options: Colissimo is still the cheapest at 12.40 EUR."
    const { reply, calls } = await turn(threadId, [answer(ANNOUNCEMENT), answer(fabricated)])

    expect(calls.length).toBe(2)
    // The nudge forbids the claim in its own words.
    const note = calls[1][calls[1].length - 1] as { content: string }
    expect(note.content).toContain("never say you did, checked, re-checked or verified anything")
    // The stored reply never carries a claim of an action no tool took: the
    // first answer stays, followed by the platform's fixed line (no model text).
    expect(reply.content).toBe(
      `${ANNOUNCEMENT}\n\n${serverT("en", "kernel.agentNotice.actionNotRun")}`,
    )
    expect(reply.content).not.toContain("re-checked")
    expect(reply.metadata.timeline?.some((e) => e.text?.includes("re-checked"))).not.toBe(true)
    expect(reply.metadata.announcedActionCorrected).toBeUndefined()
    expect(reply.metadata.announcedActionCorrectionDropped).toBe(true)
  })

  test("the platform line after a dropped correction is in the conversation's language", async () => {
    const threadId = await seedChat()
    const annonce = "Colissimo est le moins cher à 12,40 EUR. Je vais réserver l'envoi maintenant."
    const invente = "Je viens de revérifier les tarifs : Colissimo reste le moins cher."
    const { reply } = await turn(threadId, [answer(annonce), answer(invente)])

    expect(reply.content).toBe(`${annonce}\n\n${serverT("fr", "kernel.agentNotice.actionNotRun")}`)
    expect(reply.metadata.announcedActionCorrectionDropped).toBe(true)
  })

  test("a correction that calls no tool and says plainly what it cannot do replaces the first answer", async () => {
    const threadId = await seedChat()
    const plain = "No shipping app is connected here, so I cannot book the shipment."
    const { reply } = await turn(threadId, [answer(ANNOUNCEMENT), answer(plain)])

    expect(reply.content).toBe(plain)
    expect(reply.metadata.announcedActionCorrected).toBe(true)
  })

  test("an announcement in a turn that parked an approval triggers nothing", async () => {
    const threadId = await seedChat()
    const run = answer(ANNOUNCEMENT)
    run.beforeEnd = () => insertApproval(threadId, "request-818181")
    const { calls } = await turn(threadId, [run])

    expect(calls.length).toBe(1)
  })
})
