// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K on POST /api/agent/chat, through the real route and the real mail
// tools: a mail tool's args and result from a mailbox under the encryption regime
// reach neither `kernel.messages.metadata.toolCalls`, nor the SSE body, nor the
// `agent_stream` frames, nor the stream registry a late joiner replays. The model
// is the only thing stubbed: it calls the tools the turn was really given, so the
// outputs below are what the handlers really return.
//
// Every negative assertion is preceded by a positive one, so a turn that called
// nothing cannot pass.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { modelPricing, userMailboxIdentities } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { flushEventHandlers, onEvent } from "~/infra/events/event-bus"
import { MailPlaintextRedactionTestAccess } from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { getLiveAgentStream } from "~/modules/agent/runtime/stream-registry"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { seedContext } from "~/seed/context"
import { insertUnarmedMail } from "~/seed/factories/mail/conversations"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const BODY = "OBSIDIANBODYPHRASE"
const SUBJECT = "OBSIDIANSUBJECTPHRASE"
const SENDER = "obsidian-sender@redact.test"
const DRAFT = "OBSIDIANDRAFTPHRASE"
const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

type ToolSet = Record<string, { execute: (input: unknown, opts: unknown) => Promise<unknown> }>
type StoredCall = { toolCallId: string; toolName: string; args: any; result: any }

/** What the real tool returned, before any sink: the test's non-vacuity. */
const rawOutputs = new Map<string, unknown>()
const frames: Array<{ threadId: string; action: string; data: Record<string, unknown> }> = []

/** A model that calls real tools of the turn, then answers. */
function callingRealTools(calls: Array<{ toolName: string; input: unknown }>) {
  return (params: { tools: ToolSet }) => ({
    fullStream: (async function* () {
      let n = 0
      for (const call of calls) {
        const toolCallId = `call-${crypto.randomUUID()}-${n++}`
        const tool = params.tools[call.toolName]
        if (!tool) throw new Error(`the turn was not given ${call.toolName}`)
        yield { type: "tool-call", toolCallId, toolName: call.toolName, input: call.input }
        const output = await tool.execute(call.input, { toolCallId, messages: [] })
        rawOutputs.set(toolCallId, output)
        yield { type: "tool-result", toolCallId, toolName: call.toolName, output }
      }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "tool-calls",
      }
      yield { type: "text-delta", text: "Done." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  })
}

describe("Invariant K on the chat route", () => {
  let orgId: string
  let userId: string
  let bearer: string
  let readyConversation: string
  let gapConversation: string
  let orgConversation: string

  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    orgId = (await createTestOrg()).id
    const owner = await minimal.person(orgId, { role: "admin" })
    userId = owner.id
    const message = (body: string) => ({
      direction: "inbound" as const,
      fromName: "Sender",
      fromEmail: SENDER,
      toName: "Owner",
      toEmail: "owner@redact.test",
      hoursAgo: 1,
      body,
    })
    const conversation = (key: string, box: string) => ({
      key,
      box,
      subject: `${SUBJECT} ${key}`,
      status: "open",
      labels: ["INBOX"],
      isRead: false,
      isStarred: false,
      messages: [message(`${BODY} ${key}`)],
    })
    // Mail arrives while the mailboxes are unarmed, then the owner enrols: the
    // plaintext columns stay populated until the purge, which is the dual-read
    // window this redaction exists for.
    const { accountIds, conversationIds } = await insertUnarmedMail(
      seedContext({ orgId, now: new Date() }),
      {
        domain: "redact.test",
        mailboxes: [
          { box: "ready", ownerUserId: userId, email: "ready@redact.test", displayName: "R" },
          { box: "gap", ownerUserId: userId, email: "gap@redact.test", displayName: "G" },
          { box: "org", ownerUserId: null, email: "org@redact.test", displayName: "O" },
        ],
        conversations: [
          conversation("ready", "ready"),
          conversation("gap", "gap"),
          conversation("org", "org"),
        ],
      },
    )
    ;[readyConversation, gapConversation, orgConversation] = conversationIds as [
      string,
      string,
      string,
    ]
    const ecdh = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])
    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair
    await withSystemDb("chat-redaction-fixture", async (tx) => {
      await tx.insert(userMailboxIdentities).values({
        orgId,
        userId,
        keyId: 1,
        ecdhPublicKey: Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey)),
        signPublicKey: Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey)),
        keyringAttestation: Buffer.from("attestation"),
        status: "active",
      } as never)
      await tx.execute(drizzleSql`
        UPDATE ${MAIL}.accounts SET encryption_state = 'ready'
         WHERE id = ${accountIds[0] as string}::uuid`)
      await tx
        .insert(modelPricing)
        .values({
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
          displayName: "Claude Haiku 4.5",
          inputCostPerM: "1.00",
          outputCostPerM: "5.00",
          contextWindow: 200000,
          autoEligible: true,
          tierMinimum: "starter",
        } as never)
        .onConflictDoNothing()
    })
    bearer = (await minimal.sessionOf(owner)).bearer
    MailPlaintextRedactionTestAccess.resetCache()
    onEvent(
      async (event) => {
        if (event.entity !== "agent_stream") return
        const data = (event.data ?? {}) as Record<string, unknown>
        frames.push({ threadId: String(data.threadId ?? ""), action: event.action, data })
      },
      { delivery: "per-replica" },
    )
  }, 120_000)

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await shutdownSandboxPool()
    if (ORIG_ANTHROPIC_KEY !== undefined) process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
    else delete process.env.LIAISON_ANTHROPIC_API_KEY
    await releaseTestLock()
  })

  /** One real turn through the route. What the row, the SSE and the frames ended up holding. */
  async function turn(calls: Array<{ toolName: string; input: unknown }>) {
    rawOutputs.clear()
    const threadId = await minimal.thread(orgId, userId)
    AgentServiceTestAccess.setStreamText(callingRealTools(calls) as never)
    const res = await app.request("/api/agent/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ threadId, content: "look at this mail" }),
    })
    expect(res.status).toBe(200)
    const sse = await res.text()
    for (let i = 0; i < 200; i++) {
      await flushEventHandlers()
      if (frames.some((f) => f.threadId === threadId && f.action === "done")) break
      await new Promise((r) => setTimeout(r, 10))
    }
    const [row] = await sql<{ metadata: { toolCalls?: StoredCall[] } }[]>`
      SELECT metadata FROM kernel.messages
       WHERE thread_id = ${threadId} AND author_type = 'agent'
       ORDER BY created_at DESC LIMIT 1`
    const stored = row?.metadata?.toolCalls ?? []
    const wire = frames.filter((f) => f.threadId === threadId)
    const replay = await getLiveAgentStream(threadId).catch(() => null)
    return {
      stored,
      sse,
      wire,
      everywhere: JSON.stringify({ stored, sse, wire, replay }),
      raw: JSON.stringify([...rawOutputs.values()]),
    }
  }

  it("a ready mailbox's read: the handler returns an envelope, and not even that is kept", async () => {
    const { stored, sse, wire, raw, everywhere } = await turn([
      { toolName: "mail__read", input: { conversationId: readyConversation } },
    ])
    // Non-vacuity: the call ran, was stored and was streamed.
    expect(stored.map((c) => c.toolName)).toEqual(["mail__read"])
    expect(sse).toContain("mail__read")
    expect(wire.map((f) => f.action)).toContain("tool_result")
    // The handler itself holds the body back for a mailbox at `ready`...
    expect(raw).toContain(SENDER)
    expect(raw).not.toContain(BODY)
    // ...and what it does return (who wrote, to whom) stays out, as on the thread path.
    expect(stored[0]?.result?.redacted).toBe(true)
    expect(everywhere).not.toContain(SENDER)
    expect(everywhere).not.toContain(BODY)
  }, 60_000)

  it("an enrolled owner's mailbox not yet at `ready`: the real plaintext stays out", async () => {
    const { stored, sse, wire, raw, everywhere } = await turn([
      { toolName: "mail__read", input: { conversationId: gapConversation } },
    ])
    expect(stored.map((c) => c.toolName)).toEqual(["mail__read"])
    expect(sse).toContain("mail__read")
    expect(wire.map((f) => f.action)).toContain("tool_result")
    // The handler keys on the state column and hands back the dual-read columns.
    expect(raw).toContain(BODY)
    expect(raw).toContain(SUBJECT)
    expect(stored[0]?.result?.redacted).toBe(true)
    expect(everywhere).not.toContain(BODY)
    expect(everywhere).not.toContain(SUBJECT)
  }, 60_000)

  it("a drafted reply: the body stays out, the ids and the approval stay in", async () => {
    const { stored, sse, wire, everywhere } = await turn([
      {
        toolName: "mail__reply",
        input: { conversationId: readyConversation, textBody: `${DRAFT} the reply` },
      },
    ])
    expect(stored.map((c) => c.toolName)).toEqual(["mail__reply"])
    expect(sse).toContain("mail__reply")
    expect(wire.map((f) => f.action)).toContain("tool_call")
    expect(stored[0]?.args?.conversationId).toBe(readyConversation)
    expect(stored[0]?.args?.redacted).toBe(true)
    expect(stored[0]?.args?.redactedFields).toEqual(["textBody"])
    expect(everywhere).not.toContain(DRAFT)
  }, 60_000)

  it("a shared mailbox's read stays whole in the row and on the wire", async () => {
    const { stored, wire, everywhere } = await turn([
      { toolName: "mail__read", input: { conversationId: orgConversation } },
    ])
    expect(stored.map((c) => c.toolName)).toEqual(["mail__read"])
    expect(stored[0]?.result?.redacted).toBeUndefined()
    expect(JSON.stringify(stored[0]?.result)).toContain(`${BODY} org`)
    expect(JSON.stringify(wire.filter((f) => f.action === "tool_result"))).toContain(`${BODY} org`)
    expect(everywhere).toContain(SENDER)
  }, 60_000)
})
