// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The false approval claim guard (false-approval-guard.ts), through a real
// turn: invokeAgentForThread consumes the stream and the row asserted on is
// the stored reply. The model is scripted, one script per model run.
//
// Measured failure: asked to book an order's shipment "as one approval for me
// to review", a weak model loaded the gated tool, fetched quotes, and ended the
// turn with "booked for its label, pending your approval" without ever calling
// the gated tool. No approval existed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { threadParticipants, threads } from "~/db/schema/kernel"
import { agents } from "~/db/schema/kernel/agents"
import { AgentServiceTestAccess, invokeAgentForThread } from "~/modules/agent/runtime/agent-service"
import { FALSE_APPROVAL_NOTE } from "~/modules/agent/runtime/false-approval-claim"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY
const MODEL_ID = "claude-haiku-4-5-false-approval"

const FALSE_CLAIM =
  "Order #1097 is booked for its label, pending your approval. Staged, one approval."
const CORRECTED = "I have not submitted the shipment yet: I only fetched carrier quotes."

type Chunk = Record<string, unknown>
type Run = { chunks: Chunk[]; beforeEnd?: () => Promise<void> }

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

/** A run that calls one tool returning `output`, then writes `text`. */
const toolThenAnswer = (output: unknown, text: string): Run => ({
  chunks: [
    { type: "tool-call", toolCallId: "call-fa-0", toolName: "boxtal__create_shipment", input: {} },
    {
      type: "tool-result",
      toolCallId: "call-fa-0",
      toolName: "boxtal__create_shipment",
      input: {},
      output,
    },
    finishStep("tool-calls"),
    { type: "text-delta", text },
    finishStep("stop"),
    { type: "finish", finishReason: "stop" },
  ],
})

/** Plays one run per model call, and records each call's messages. */
function scripted(runs: Run[]) {
  const calls: Array<Array<{ role: string; content: unknown }>> = []
  const fn = (opts: { messages: Array<{ role: string; content: unknown }> }) => {
    const run = runs[calls.length]
    calls.push(opts.messages)
    if (!run) throw new Error(`unexpected model run #${calls.length}`)
    const text = run.chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => c.text as string)
      .join("")
    return {
      fullStream: (async function* () {
        for (const c of run.chunks) {
          if (c.type === "finish" && run.beforeEnd) await run.beforeEnd()
          yield c
        }
      })(),
      responseMessages: Promise.resolve([{ role: "assistant", content: [{ type: "text", text }] }]),
    }
  }
  return { fn, calls }
}

describe("a false approval claim gets one correction", () => {
  let orgId: string
  let userId: string
  let actor: UserContext

  async function seedChat(): Promise<string> {
    return withPrivilegedDb(orgId, "test-fa-thread", async (tx) => {
      const [t] = await tx
        .insert(threads)
        .values({
          orgId,
          handle: `fa-${crypto.randomUUID().slice(0, 8)}`,
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
    const msg = await withPrivilegedDb(orgId, "test-fa-msg", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        requiredScopes: [],
        orgId,
        userId,
        threadId,
        content: "Book the shipment for order #1097 as one approval for me to review.",
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
      { content: string; metadata: { timeline?: unknown[]; falseApprovalCorrected?: boolean } }[]
    >`SELECT content, metadata FROM kernel.messages
      WHERE thread_id = ${threadId} AND author_type = 'agent' ORDER BY created_at`
    if (rows.length !== 1) throw new Error(`expected one agent reply, saw ${rows.length}`)
    return { reply: rows[0], calls: script.calls }
  }

  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    userId = (await minimal.person(orgId)).id
    const { scopes } = await withPrivilegedDb(orgId, "test-fa-actor", (tx) =>
      loadEffectivePermissions(tx, userId, orgId),
    )
    actor = { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
    await withPrivilegedDb(orgId, "test-fa-agent", (tx) =>
      tx.insert(agents).values({
        orgId,
        kind: "personal",
        handle: `@fa-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId: userId,
        scopeCeiling: [],
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

  test("a claim with no approval parked runs one correction, and the correction is the stored answer", async () => {
    const threadId = await seedChat()
    const { reply, calls } = await turn(threadId, [answer(FALSE_CLAIM), answer(CORRECTED)])

    expect(calls.length).toBe(2)
    // The continuation carries the turn's own answer, then the runtime note last.
    const second = calls[1]
    expect(second[second.length - 1]).toEqual({ role: "user", content: FALSE_APPROVAL_NOTE })
    expect(JSON.stringify(second[second.length - 2])).toContain("pending your approval")
    // One answer: the correction, without the false text.
    expect(reply.content).toBe(CORRECTED)
    expect(JSON.stringify(reply.metadata.timeline ?? [])).not.toContain("pending your approval")
    expect(reply.metadata.falseApprovalCorrected).toBe(true)
  })

  test("a second false claim after the correction triggers nothing more", async () => {
    const threadId = await seedChat()
    const again = "Staged for your approval, nothing more to do."
    const { reply, calls } = await turn(threadId, [answer(FALSE_CLAIM), answer(again)])

    expect(calls.length).toBe(2)
    expect(reply.content).toBe(again)
  })

  test("a turn that parked an approval triggers nothing", async () => {
    const threadId = await seedChat()
    const parked = {
      blocked: true,
      status: "pending_approval",
      approvalRequestId: crypto.randomUUID(),
      approvalHandle: "request-424242",
    }
    const text = "The label is staged: request-424242 is pending your approval."
    const { reply, calls } = await turn(threadId, [toolThenAnswer(parked, text)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(text)
    expect(reply.metadata.falseApprovalCorrected).toBeUndefined()
  })

  test("an approval parked out of the stream (a sub-agent, a bundle) counts as parked", async () => {
    const threadId = await seedChat()
    const run = answer("The sub-agent staged the shipment for your approval.")
    run.beforeEnd = () => insertApproval(threadId, "request-515151")
    const { calls } = await turn(threadId, [run])

    expect(calls.length).toBe(1)
  })

  test("a reply quoting an earlier approval of the thread by its handle triggers nothing", async () => {
    const threadId = await seedChat()
    await insertApproval(threadId, "request-616161")
    const text = "request-616161 is still pending your approval."
    const { reply, calls } = await turn(threadId, [answer(text)])

    expect(calls.length).toBe(1)
    expect(reply.content).toBe(text)
  })

  test("a handle no call returned and the thread does not have is corrected", async () => {
    const threadId = await seedChat()
    const { reply, calls } = await turn(threadId, [
      answer("Done, see request-717171."),
      answer(CORRECTED),
    ])

    expect(calls.length).toBe(2)
    expect(reply.content).toBe(CORRECTED)
  })
})
