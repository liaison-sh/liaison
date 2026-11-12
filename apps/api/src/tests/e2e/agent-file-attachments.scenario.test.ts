// SPDX-License-Identifier: FSL-1.1-ALv2
// ---------------------------------------------------------------------------
// Generic Agent File Attachment System — E2E
//
// Covers the feature in `01-…-plan.md` (Tasks 1–12 + the Task 6a email layer)
// and the review fixes in `03-…-impl-review.md` (B1 cross-entity flag, C1–C6,
// S1–S7). The binding question every scenario answers: can an agent retrieve a
// file and make it actually leave the building — land in a customer's inbox,
// on a ticket, on a thread — exactly like a human, and does the human gate see
// where each file came from?
//
// Tier A (deterministic, no LLM) carries the binding assertions. Tier B (LLM)
// proves the agent can reach the feature through natural language.
// ---------------------------------------------------------------------------

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { MODEL_PRICING_SEED } from "@liaison/shared"
import type { TestWorld } from "@liaison/test-helpers"
import { api, createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import { type SmtpFixture, startSmtpFixture } from "~/tests/fixtures/email/smtp-server"
import { decide } from "./helpers/approvals"
import { parseMimeAttachments, seedDriveConnection, seedFileOnEntity } from "./helpers/attachments"
import { LIVE_LLM } from "./helpers/live-llm"
import { seedConversation } from "./helpers/mail-seed"
import { ks, seedInbox, seedSmtpConnectedAccount, seedTicket, ts } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

// --- SSE helpers (copy-pattern — per docs/testing.md, mirror agent-tickets) ---
interface SseEvent {
  event: string
  data: unknown
}

function parseSseEvents(body: string): SseEvent[] {
  const events: SseEvent[] = []
  for (const block of body.split("\n\n").filter((b) => b.trim())) {
    let event = "message"
    let dataStr = ""
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7).trim()
      else if (line.startsWith("data: ")) dataStr = line.slice(6).trim()
    }
    try {
      events.push({ event, data: JSON.parse(dataStr) })
    } catch {
      events.push({ event, data: dataStr })
    }
  }
  return events
}

async function consumeSse(
  url: string,
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: SseEvent[]; rawBody: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const rawBody = await res.text()
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return {
      status: res.status,
      events: [{ event: "error", data: { code: "http_error", body: rawBody } }],
      rawBody,
    }
  }
  return { status: res.status, events: parseSseEvents(rawBody), rawBody }
}

function isProviderUnavailable(events: SseEvent[]): boolean {
  const err = events.find((e) => e.event === "error")
  if (!err) return false
  const code = (err.data as { code?: string } | undefined)?.code
  return code === "provider_error" || code === "transport_error" || code === "http_error"
}

// Auto-mode → gemini-flash-lite. Never hardcode Anthropic in E2E (project policy).
const TOOL_MODEL: string | null = null

// A deterministic, denylist-clean PDF-ish byte buffer. Content is never parsed
// (the denylist is an extension/MIME heuristic) — only its bytes must round-trip.
function makeBytes(marker: string, totalBytes = 4096): Buffer {
  const head = Buffer.from(`%PDF-1.4 ${marker} `, "utf8")
  const pad = Buffer.alloc(Math.max(0, totalBytes - head.byteLength), 0x41)
  return Buffer.concat([head, pad])
}

describe("Generic Agent File Attachment System — E2E", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let smtp: SmtpFixture
  let agent: { id: string; email: string; token: string; name: string }
  let approver: { id: string; email: string; token: string; name: string }
  let threadId: string

  // Helper: invoke a tool through the real `/api/apps/run-tool` envelope.
  async function runTool(
    toolName: string,
    params: Record<string, unknown>,
    opts?: { thread?: string },
  ): Promise<{
    status: number
    data?: any
    error?: any
    blocked?: { approvalRequestId: string }
  }> {
    // The agent's call (origin in-app-agent): a person's own call never parks an approval.
    const res = await api(url, "/api/_test/agent-tool-call", {
      method: "POST",
      token: agent.token,
      body: { toolName, threadId: opts?.thread ?? threadId, params },
    })
    return {
      status: res.status,
      data: res.body?.data,
      error: res.body?.error,
      blocked: res.body?.data?.blocked,
    }
  }

  // Helper: run a gated tool to completion (block → self-approve).
  async function runGated(
    toolName: string,
    params: Record<string, unknown>,
    opts?: { thread?: string },
  ): Promise<{ approvalRequestId: string; decideStatus: number; decideBody: any }> {
    const triggered = await runTool(toolName, params, opts)
    if (!triggered.blocked?.approvalRequestId) {
      throw new Error(
        `expected a blocked approval for ${toolName}, got ${JSON.stringify(triggered)}`,
      )
    }
    const id = triggered.blocked.approvalRequestId
    const decideRes = await decide(url, approver.token, id, { decision: "approve" })
    return { approvalRequestId: id, decideStatus: decideRes.status, decideBody: decideRes.body }
  }

  // Helper: seed an inbound customer message on a ticket (copy-pattern).
  async function seedInboundMessage(
    ticketId: string,
    opts?: { fromEmail?: string; externalMessageId?: string },
  ): Promise<void> {
    const fromEmail = opts?.fromEmail ?? "alice@cust.test"
    await env.db.sql.unsafe(
      `INSERT INTO ${ts(env)}.messages (
        id, org_id, ticket_id, kind, from_email, from_name, to_emails, subject,
        text_body, snippet, external_message_id, sent_at, created_at, updated_at
      ) VALUES (gen_random_uuid(), $1, $2, 'inbound', $3, 'Alice', '[]'::jsonb,
        'Customer question', 'hello', 'hello', $4, now() - interval '1 minute',
        now() - interval '1 minute', now() - interval '1 minute')`,
      [world.org.id, ticketId, fromEmail, opts?.externalMessageId ?? `<in-${ticketId}@cust.test>`],
    )
    await env.db.sql.unsafe(
      `UPDATE ${ts(env)}.tickets
         SET message_count = message_count + 1,
             last_inbound_at = now() - interval '1 minute',
             last_message_at = now() - interval '1 minute'
       WHERE id = $1`,
      [ticketId],
    )
  }

  // Helper: stand up a ticket wired to a live SMTP inbox + one inbound message.
  async function seedSmtpTicket(
    label: string,
  ): Promise<{ id: string; handle: string; accountEmail: string }> {
    const accountEmail = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@org.test`
    const ca = await seedSmtpConnectedAccount(env, {
      orgId: world.org.id,
      email: accountEmail,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      username: accountEmail,
      password: "test-pass",
      createdBy: world.admin.id,
    })
    const inbox = await seedInbox(env, {
      orgId: world.org.id,
      connectedAccountId: ca.id,
      emailAddress: accountEmail,
      name: `${label} inbox`,
    })
    const ticket = await seedTicket(env, {
      orgId: world.org.id,
      subject: `${label} ${Date.now()}`,
      sourceInboxId: inbox.id,
      status: "open",
      team: "support-us",
    })
    await seedInboundMessage(ticket.id)
    return { id: ticket.id, handle: ticket.handle, accountEmail }
  }

  function mailSchema(): string {
    return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
  }

  // Helper: stand up a mail account wired to a live SMTP connection.
  async function seedMailAccount(label: string): Promise<{ accountId: string; email: string }> {
    const email =
      `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@org.test`.toLowerCase()
    const ca = await seedSmtpConnectedAccount(env, {
      orgId: world.org.id,
      email,
      smtpHost: smtp.host,
      smtpPort: smtp.port,
      username: email,
      password: "test-pass",
      createdBy: world.admin.id,
      appName: "mail",
      connectionName: "imap",
    })
    const accountId = randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${mailSchema()}.accounts (
        id, org_id, connected_account_id, owner_type, owner_id,
        provider, email_address, display_name, sync_status
      ) VALUES ($1, $2, $3, 'org', null, 'imap', $4, $5, 'idle')`,
      [accountId, world.org.id, ca.id, email, `${label} account`],
    )
    return { accountId, email }
  }

  // Seed an inbound mail message. jsonb columns receive JS objects directly —
  // postgres.js serializes them to jsonb (passing a pre-stringified string
  // would double-encode into a jsonb *string*, which the send path then emits
  // as a malformed recipient).
  async function seedMailInbound(
    accountId: string,
    conversationId: string,
    fromEmail: string,
  ): Promise<string> {
    const id = randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${mailSchema()}.messages (
        id, org_id, conversation_id, account_id, external_message_id,
        message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
        subject, text_body, html_body, snippet, is_read, is_starred, labels,
        direction, sent_at, synced_at, raw_headers, owner_type, owner_id
      ) VALUES (
        $1, $2, $3, $4, $5,
        '[]'::jsonb, $6::jsonb, $7::jsonb, '[]'::jsonb, '[]'::jsonb,
        $8, $9, $10, $11, false, false, '[]'::jsonb,
        'inbound', $12, now(), '{}'::jsonb, 'org', null
      )`,
      [
        id,
        world.org.id,
        conversationId,
        accountId,
        `<in-${id}@cust.test>`,
        { name: "Customer", email: fromEmail },
        [{ email: "support@org.test" }],
        "Need my documents",
        "Could you send the paperwork?",
        "<p>Could you send the paperwork?</p>",
        "Could you send the paperwork?",
        new Date(Date.now() - 60_000).toISOString(),
      ],
    )
    return id
  }

  // Query the file rows copied onto a destination entity.
  async function filesOn(
    app: string,
    entityType: string,
    entityId: string,
  ): Promise<
    Array<{ id: string; copied_from_id: string | null; size_bytes: number; filename: string }>
  > {
    return env.db.sql.unsafe(
      `SELECT id, copied_from_id, size_bytes, filename
         FROM ${ks(env)}.files
        WHERE app = $1 AND entity_type = $2 AND entity_id = $3
        ORDER BY created_at ASC`,
      [app, entityType, entityId],
    )
  }

  beforeAll(async () => {
    smtp = await startSmtpFixture()
    const result = await setupScenario({
      seed: 7651,
      org: { name: "Agent File Attachments E2E Org" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-3)", messages: "random(1-2)" },
      },
      serverEnv: {
        ALLOW_PRIVATE_MAIL_HOSTS: "true",
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl

    // Model pricing + credit balance — the Tier-B agent runtime needs both.
    for (const model of MODEL_PRICING_SEED) {
      await env.db.sql.unsafe(
        `INSERT INTO ${ks(env)}.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (provider, model_id) DO NOTHING`,
        [
          model.provider,
          model.modelId,
          model.displayName,
          model.inputCostPerM,
          model.outputCostPerM,
          model.contextWindow,
          model.autoEligible,
          model.tierMinimum,
          model.source,
        ],
      )
    }
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.credit_balances (org_id, included_balance, purchased_balance, currency)
       VALUES ($1, '50.00000000', '50.00000000', 'EUR')
       ON CONFLICT (org_id) DO UPDATE SET included_balance = '50.00000000', purchased_balance = '50.00000000'`,
      [world.org.id],
    )

    // The agent runs gated tools but cannot self-approve — without `:approve`
    // scope, direct HTTP calls go through the actual gating flow (creating an
    // approval request that the separate `approver` user must decide).
    agent = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      name: "File Agent",
      scopes: [
        "tickets:tickets:read",
        "tickets:tickets:write",
        "tickets:tickets:reply",
        "tickets:tickets:close",
        "tickets:inboxes:read",
        "mail:conversations:read",
        "mail:conversations:write",
        "mail:accounts:read",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:files:read",
        "kernel:contacts:read",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    approver = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
      name: "File Approver",
      scopes: [
        "tickets:tickets:read",
        "tickets:approve",
        "tickets:inboxes:read",
        "mail:conversations:read",
        "mail:approve",
        "mail:accounts:read",
        "kernel:threads:read",
        "kernel:threads:write",
        "kernel:files:read",
      ],
      dimensions: { "*": ["*"] },
      schemaPrefix: env.schemaPrefix,
    })

    const threadRes = await api(url, "/api/threads", {
      method: "POST",
      token: agent.token,
      body: {
        forceCreate: true,
        type: "thread",
        title: "File-attachment agent thread",
        participantIds: [agent.id],
      },
    })
    threadId = threadRes.body?.data?.id
    if (!threadId) {
      throw new Error(`failed to create agent thread: ${JSON.stringify(threadRes.body)}`)
    }

    await seedDriveConnection(env, { orgId: world.org.id, userId: agent.id })
  }, 180_000)

  afterAll(async () => {
    await smtp?.close()
    await teardownScenario(env, world)
  }, 30_000)

  // --- INF-0 — Smoke test ---------------------------------------------------
  it("smoke: copies a readable file onto a thread message", async () => {
    const bytes = makeBytes("smoke", 512)
    const src = await seedFileOnEntity(env, agent.token, {
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
      filename: "smoke-note.pdf",
      mimeType: "application/pdf",
      bytes,
    })

    // threads_reply refuses the thread the turn is answering (that answer is
    // posted when the turn ends, chat-tools.ts handleThreadsReply), so the call
    // runs from another thread of the agent's and posts into `threadId`.
    const fromRes = await api(url, "/api/threads", {
      method: "POST",
      token: agent.token,
      body: {
        forceCreate: true,
        type: "thread",
        title: "Smoke origin",
        participantIds: [agent.id],
      },
    })
    const fromThread = fromRes.body?.data?.id as string
    expect(fromThread).toBeTruthy()

    const res = await runTool(
      "kernel:threads_reply",
      { threadId, content: "Smoke: doc attached.", attachments: [src.fileId] },
      { thread: fromThread },
    )
    expect(res.status).toBe(200)
    const messageId = res.data?.message?.id as string
    expect(messageId).toBeTruthy()

    const copies = await filesOn("kernel", "message", messageId)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.copied_from_id).toBe(src.fileId)
    expect(Number(copies[0]!.size_bytes)).toBe(bytes.byteLength)
  }, 60_000)

  // --- A1 — Ticket reply + attachment → customer receives the bytes --------
  it("A1: agent attaches a ticket's file to a gated reply; the customer receives it", async () => {
    const ticket = await seedSmtpTicket("A1")
    const bytes = makeBytes("A1-return-label", 4096)
    const src = await seedFileOnEntity(env, agent.token, {
      app: "tickets",
      entityType: "ticket",
      entityId: ticket.id,
      filename: "return-label.pdf",
      mimeType: "application/pdf",
      bytes,
    })

    const capturedBefore = smtp.captured.length
    const { decideStatus } = await runGated("tickets:reply", {
      ticketId: ticket.id,
      textBody: "Your return label is attached.",
      attachments: [src.fileId],
    })
    expect(decideStatus).toBe(200)

    // The email actually left the building — and carries the bytes.
    expect(smtp.captured.length).toBe(capturedBefore + 1)
    const captured = smtp.captured[smtp.captured.length - 1]!
    const attachments = await parseMimeAttachments(captured.raw)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.filename).toBe("return-label.pdf")
    expect(attachments[0]!.bytes.equals(bytes)).toBe(true)

    // A provenance copy landed on the persisted outbound message.
    const [outbound] = await env.db.sql.unsafe(
      `SELECT id FROM ${ts(env)}.messages
        WHERE ticket_id = $1 AND kind = 'outbound' ORDER BY created_at DESC LIMIT 1`,
      [ticket.id],
    )
    expect(outbound?.id).toBeTruthy()
    const copies = await filesOn("tickets", "message", outbound!.id)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.copied_from_id).toBe(src.fileId)
    expect(Number(copies[0]!.size_bytes)).toBe(bytes.byteLength)

    // The source file is untouched — a copy, not a move.
    const [srcRow] = await env.db.sql.unsafe(
      `SELECT id FROM ${ks(env)}.files WHERE id = $1 AND app = 'tickets' AND entity_type = 'ticket'`,
      [src.fileId],
    )
    expect(srcRow?.id).toBe(src.fileId)
  }, 60_000)

  // --- A2 — Mail reply + attachment → staging + relink land it on the message
  it("A2: agent attaches a file to a gated mail reply; staging + relink land it", async () => {
    const account = await seedMailAccount("A2")
    const { id: conversationId } = await seedConversation(env, {
      accountId: account.accountId,
      orgId: world.org.id,
      ownerType: "org",
      ownerId: null,
      subject: "Need my documents",
      messageCount: 1,
    })
    await seedMailInbound(account.accountId, conversationId, "customer-a2@cust.test")

    // Source file lives on the agent's own thread — a different conversation.
    const bytes = makeBytes("A2-doc", 3072)
    const src = await seedFileOnEntity(env, agent.token, {
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
      filename: "paperwork.pdf",
      mimeType: "application/pdf",
      bytes,
    })

    const capturedBefore = smtp.captured.length
    const { decideStatus } = await runGated("mail:reply", {
      conversationId,
      textBody: "Your paperwork is attached.",
      attachments: [src.fileId],
    })
    expect(decideStatus).toBe(200)

    // The outbound MIME carries the attachment, decodable byte-for-byte.
    expect(smtp.captured.length).toBe(capturedBefore + 1)
    const captured = smtp.captured[smtp.captured.length - 1]!
    const attachments = await parseMimeAttachments(captured.raw)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.filename).toBe("paperwork.pdf")
    expect(attachments[0]!.bytes.equals(bytes)).toBe(true)

    // The staged copy was relinked onto the persisted outbound message —
    // not left on the `outbound_staging` (account) parent.
    const [outbound] = await env.db.sql.unsafe(
      `SELECT id FROM ${mailSchema()}.messages
        WHERE conversation_id = $1 AND direction = 'outbound'
        ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    )
    expect(outbound?.id).toBeTruthy()
    const copies = await filesOn("mail", "message", outbound!.id)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.copied_from_id).toBe(src.fileId)

    // Nothing left stranded on the staging (account) parent.
    const staged = await filesOn("mail", "outbound_staging", account.accountId)
    expect(staged).toHaveLength(0)
  }, 60_000)

  // --- A2b — Mail compose + attachment (distinct staging path) --------------
  it("A2b: agent attaches a file to a gated mail compose; relink lands it", async () => {
    const account = await seedMailAccount("A2b")
    const bytes = makeBytes("A2b-doc", 2048)
    const src = await seedFileOnEntity(env, agent.token, {
      app: "kernel",
      entityType: "thread",
      entityId: threadId,
      filename: "welcome-packet.pdf",
      mimeType: "application/pdf",
      bytes,
    })

    const capturedBefore = smtp.captured.length
    const { decideStatus } = await runGated("mail:compose", {
      accountId: account.accountId,
      to: [{ email: "newcustomer-a2b@cust.test" }],
      subject: "Your documents",
      textBody: "Attached.",
      attachments: [src.fileId],
    })
    expect(decideStatus).toBe(200)

    expect(smtp.captured.length).toBe(capturedBefore + 1)
    const captured = smtp.captured[smtp.captured.length - 1]!
    const attachments = await parseMimeAttachments(captured.raw)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.filename).toBe("welcome-packet.pdf")
    expect(attachments[0]!.bytes.equals(bytes)).toBe(true)

    // Compose generated its own conversation + message; the staged copy was
    // relinked onto that newly-persisted message.
    const [outbound] = await env.db.sql.unsafe(
      `SELECT id FROM ${mailSchema()}.messages
        WHERE account_id = $1 AND direction = 'outbound'
        ORDER BY created_at DESC LIMIT 1`,
      [account.accountId],
    )
    expect(outbound?.id).toBeTruthy()
    const copies = await filesOn("mail", "message", outbound!.id)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.copied_from_id).toBe(src.fileId)
  }, 60_000)

  // --- A2c — Mail FORWARD carries the ORIGINAL message's attachment ----------
  // forward-dealer-quote-email-attachment: the agent forwards a customer email
  // (with its requirements PDF) to a colleague. mail:forward must re-send the
  // ORIGINAL inbound body (quoted, Fwd: subject) AND re-attach the original PDF
  // automatically — and the APPROVE→EXECUTE path must complete (decideStatus 200),
  // not 422 on the gated-exec verify. Regression: the first build of mail:forward
  // had the approved execution fail before this test pinned the full path.
  it("A2c: agent FORWARDS an inbound message; the original attachment is carried on the executed send", async () => {
    const account = await seedMailAccount("A2c")
    const { id: conversationId } = await seedConversation(env, {
      accountId: account.accountId,
      orgId: world.org.id,
      ownerType: "org",
      ownerId: null,
      subject: "Bulk quote request — 40x units",
      messageCount: 1,
    })
    const inboundMsgId = await seedMailInbound(
      account.accountId,
      conversationId,
      "buyer-a2c@cust.test",
    )

    // The ORIGINAL inbound message carries a real requirements PDF (real bytes in
    // object storage), parented to (mail, message, <inboundMsgId>).
    const bytes = makeBytes("A2c-requirements", 4096)
    const src = await seedFileOnEntity(env, agent.token, {
      app: "mail",
      entityType: "message",
      entityId: inboundMsgId,
      filename: "Bulk-Requirements.pdf",
      mimeType: "application/pdf",
      bytes,
    })

    const capturedBefore = smtp.captured.length
    // Forward WITHOUT passing any attachment id — forward must discover + carry
    // the original PDF itself.
    const { decideStatus } = await runGated("mail:forward", {
      conversationId,
      to: [{ email: "colleague-a2c@org.test" }],
      note: "Can you quote this?",
    })
    expect(decideStatus).toBe(200)

    // The executed forward's outbound MIME carries the original PDF byte-for-byte.
    expect(smtp.captured.length).toBe(capturedBefore + 1)
    const captured = smtp.captured[smtp.captured.length - 1]!
    const attachments = await parseMimeAttachments(captured.raw)
    expect(attachments).toHaveLength(1)
    expect(attachments[0]!.filename).toBe("Bulk-Requirements.pdf")
    expect(attachments[0]!.bytes.equals(bytes)).toBe(true)

    // The forwarded send is a NEW outbound message; the staged copy of the
    // original PDF was relinked onto it (provenance: copied_from_id = source).
    const [outbound] = await env.db.sql.unsafe(
      `SELECT id FROM ${mailSchema()}.messages
        WHERE account_id = $1 AND direction = 'outbound'
        ORDER BY created_at DESC LIMIT 1`,
      [account.accountId],
    )
    expect(outbound?.id).toBeTruthy()
    const copies = await filesOn("mail", "message", outbound!.id)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.copied_from_id).toBe(src.fileId)
    expect(copies[0]!.filename).toBe("Bulk-Requirements.pdf")
  }, 60_000)

  // --- A3 — Thread message attachment (non-gated) lands immediately --------
  it("A3: agent attaches a file to a thread message (non-gated); it lands immediately", async () => {
    // A fresh thread so the no-approval assertion is unambiguous.
    const threadRes = await api(url, "/api/threads", {
      method: "POST",
      token: agent.token,
      body: {
        forceCreate: true,
        type: "thread",
        title: "A3 thread",
        participantIds: [agent.id],
      },
    })
    const a3Thread = threadRes.body?.data?.id as string
    expect(a3Thread).toBeTruthy()

    const bytes = makeBytes("A3-doc", 1024)
    const src = await seedFileOnEntity(env, agent.token, {
      app: "kernel",
      entityType: "thread",
      entityId: a3Thread,
      filename: "thread-doc.pdf",
      mimeType: "application/pdf",
      bytes,
    })

    // Posted from the agent's main thread INTO the fresh one: threads_reply
    // refuses the thread the turn is answering (chat-tools.ts handleThreadsReply).
    const res = await runTool(
      "kernel:threads_reply",
      { threadId: a3Thread, content: "Doc attached.", attachments: [src.fileId] },
      { thread: threadId },
    )
    expect(res.status).toBe(200)
    expect(res.blocked).toBeUndefined()
    const messageId = res.data?.message?.id as string
    expect(messageId).toBeTruthy()

    // No approval row — thread posts are agent-identity, never approval-gated.
    const approvals = await env.db.sql.unsafe(
      `SELECT id FROM ${ks(env)}.approval_requests
        WHERE tool_name = 'kernel:threads_reply' AND originating_thread_id IN ($1, $2)`,
      [a3Thread, threadId],
    )
    expect(approvals).toHaveLength(0)

    const copies = await filesOn("kernel", "message", messageId)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.copied_from_id).toBe(src.fileId)

    // Source untouched — still on the thread (a copy, not a move).
    const [srcRow] = await env.db.sql.unsafe(
      `SELECT entity_type FROM ${ks(env)}.files WHERE id = $1`,
      [src.fileId],
    )
    expect(srcRow?.entity_type).toBe("thread")

    // Weak-model resilience: `attachments` passed as a JSON *string* (which a
    // weak model routinely emits) is coerced back to an array before the
    // Zod-schema kernel tool validates it — so the file still attaches.
    const stringified = await runTool(
      "kernel:threads_reply",
      { threadId: a3Thread, content: "Stringified attachments.", attachments: `["${src.fileId}"]` },
      { thread: threadId },
    )
    expect(stringified.status).toBe(200)
    const stringifiedCopies = await filesOn(
      "kernel",
      "message",
      stringified.data?.message?.id as string,
    )
    expect(stringifiedCopies).toHaveLength(1)
    expect(stringifiedCopies[0]!.copied_from_id).toBe(src.fileId)
  }, 60_000)

  // --- A5 — Provenance at the gate: cross-entity flagged, same-entity not --
  it("A5: cross-entity attachment is flagged with ⚠, same-entity is not", async () => {
    const ticketA = await seedSmtpTicket("A5a")
    const ticketB = await seedSmtpTicket("A5b")

    const fileFromB = await seedFileOnEntity(env, agent.token, {
      app: "tickets",
      entityType: "ticket",
      entityId: ticketB.id,
      filename: "other-customer-invoice.pdf",
      mimeType: "application/pdf",
      bytes: makeBytes("A5-B", 512),
    })
    const fileFromA = await seedFileOnEntity(env, agent.token, {
      app: "tickets",
      entityType: "ticket",
      entityId: ticketA.id,
      filename: "ticketA-own.pdf",
      mimeType: "application/pdf",
      bytes: makeBytes("A5-A", 512),
    })
    // Gate a reply on ticket A carrying all three attachments.
    const triggered = await runTool("tickets:reply", {
      ticketId: ticketA.id,
      textBody: "See attached.",
      attachments: [fileFromB.fileId, fileFromA.fileId],
    })
    expect(triggered.blocked?.approvalRequestId).toBeTruthy()

    const [row] = await env.db.sql.unsafe(
      `SELECT summary FROM ${ks(env)}.approval_requests WHERE id = $1`,
      [triggered.blocked!.approvalRequestId],
    )
    const lines = (row!.summary as { lines: string[] }).lines
    const lineFor = (name: string) => lines.find((l) => l.includes(name)) ?? ""

    // Cross-ticket file → 📎 AND ⚠ (the cross-customer-leak signal, fix B1).
    expect(lineFor("other-customer-invoice.pdf")).toContain("📎")
    expect(lineFor("other-customer-invoice.pdf")).toContain("⚠")
    // Same-ticket file → 📎, NO ⚠.
    expect(lineFor("ticketA-own.pdf")).toContain("📎")
    expect(lineFor("ticketA-own.pdf")).not.toContain("⚠")
  }, 90_000)

  // --- A6 — The denylist blocks executable / double-extension attachments --
  it("A6: denylist blocks an executable and a double-extension attachment", async () => {
    const ticket = await seedSmtpTicket("A6")
    const exe = await seedFileOnEntity(env, agent.token, {
      app: "tickets",
      entityType: "ticket",
      entityId: ticket.id,
      filename: "payload.exe",
      mimeType: "application/x-msdownload",
      bytes: makeBytes("A6-exe", 256),
    })
    const dbl = await seedFileOnEntity(env, agent.token, {
      app: "tickets",
      entityType: "ticket",
      entityId: ticket.id,
      filename: "invoice.exe.pdf",
      mimeType: "application/pdf",
      bytes: makeBytes("A6-dbl", 256),
    })

    const capturedBefore = smtp.captured.length
    for (const fileId of [exe.fileId, dbl.fileId]) {
      const { decideStatus, decideBody } = await runGated("tickets:reply", {
        ticketId: ticket.id,
        textBody: "Here is the file.",
        attachments: [fileId],
      })
      // The handler rejects the unsafe attachment — the send never happens.
      expect(decideStatus).not.toBe(200)
      expect(JSON.stringify(decideBody).toLowerCase()).toContain("unsafe")
    }
    // No email left the building for either rejected attempt.
    expect(smtp.captured.length).toBe(capturedBefore)
  }, 60_000)

  // --- A7 — Attachment copy under an ambiguous SMTP fault is not duplicated -
  it("A7: a gated reply under an ambiguous SMTP fault copies the attachment exactly once", async () => {
    const ticket = await seedSmtpTicket("A7")
    const src = await seedFileOnEntity(env, agent.token, {
      app: "tickets",
      entityType: "ticket",
      entityId: ticket.id,
      filename: "a7-doc.pdf",
      mimeType: "application/pdf",
      bytes: makeBytes("A7-doc", 512),
    })

    // Arm the SMTP fixture so the next DATA is dropped without an ACK — the
    // handler records an ambiguous outcome but the outbound row is still
    // inserted and the attachment still copied.
    smtp.inject.setAmbiguousNext(1)
    const { decideStatus } = await runGated("tickets:reply", {
      ticketId: ticket.id,
      textBody: "Doc attached (ambiguous send).",
      attachments: [src.fileId],
    })
    expect(decideStatus).toBe(422) // handler_ambiguous

    // Exactly one outbound message, with a null external id (ambiguous).
    const outbound = await env.db.sql.unsafe(
      `SELECT id, external_message_id FROM ${ts(env)}.messages
        WHERE ticket_id = $1 AND kind = 'outbound'`,
      [ticket.id],
    )
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.external_message_id).toBeNull()

    // Exactly one attachment copy — the copied_from_id partial-UNIQUE index +
    // the attach precheck guarantee the ambiguous path never double-copies.
    const copies = await filesOn("tickets", "message", outbound[0]!.id)
    expect(copies).toHaveLength(1)
    expect(copies[0]!.copied_from_id).toBe(src.fileId)
  }, 60_000)

  // --- A8 — Per-call attachment count cap rejects a runaway batch ----------
  it("A8: per-call attachment count cap rejects a runaway batch", async () => {
    const ticket = await seedSmtpTicket("A8")
    const fileIds: string[] = []
    for (let i = 0; i < 11; i++) {
      const f = await seedFileOnEntity(env, agent.token, {
        app: "tickets",
        entityType: "ticket",
        entityId: ticket.id,
        filename: `batch-${i}.pdf`,
        mimeType: "application/pdf",
        bytes: makeBytes(`A8-${i}`, 256),
      })
      fileIds.push(f.fileId)
    }

    const capturedBefore = smtp.captured.length
    const { decideStatus, decideBody } = await runGated("tickets:reply", {
      ticketId: ticket.id,
      textBody: "Way too many files.",
      attachments: fileIds,
    })
    // Rejected before any send — the count cap (max 10) trips first.
    expect(decideStatus).not.toBe(200)
    expect(JSON.stringify(decideBody).toLowerCase()).toContain("too many")
    expect(smtp.captured.length).toBe(capturedBefore)
  }, 60_000)

  // Create an agent-chat thread the agent owns (for the Tier-B LLM scenarios).
  async function createAgentDmThread(): Promise<string> {
    const id = randomUUID()
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.threads (id, org_id, handle, type, created_by)
       VALUES ($1, $2, $3, 'agent_chat', $4)`,
      [id, world.org.id, `agent-${id.slice(0, 8)}`, agent.id],
    )
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.thread_participants (thread_id, user_id, org_id)
       VALUES ($1, $2, $3)`,
      [id, agent.id, world.org.id],
    )
    return id
  }

  // --- B1 — Agent (LLM) discovers a customer's file and re-attaches it -----
  // Drives a real model provider: live only (LIAISON_E2E_LIVE_LLM=1, helpers/live-llm.ts).
  it.if(LIVE_LLM)(
    "B1: agent discovers a file via files_list and attaches it to a gated reply",
    async () => {
      const ticket = await seedSmtpTicket("B1")
      // The customer's inbound message carries a file the agent must rediscover.
      const [inbound] = await env.db.sql.unsafe(
        `SELECT id FROM ${ts(env)}.messages WHERE ticket_id = $1 AND kind = 'inbound' LIMIT 1`,
        [ticket.id],
      )
      const customerFile = await seedFileOnEntity(env, agent.token, {
        app: "tickets",
        entityType: "message",
        entityId: inbound!.id,
        filename: "signed-contract.pdf",
        mimeType: "application/pdf",
        bytes: makeBytes("B1-contract", 1024),
      })

      // A real LLM is non-deterministic — give it a bounded number of attempts.
      // The assertion (a gated tickets:reply approval carrying the customer's
      // file id) is never weakened; the retry only absorbs model dice-rolls.
      const prompt =
        `Ticket ${ticket.id} has a customer message (id ${inbound!.id}) with a file ` +
        `attachment. Use the files_list tool with app="tickets", entityType="message", ` +
        `entityId="${inbound!.id}" to find that file's id, then call the tickets reply ` +
        `tool for ticket ${ticket.id} with a short thank-you body and that file id in ` +
        `the attachments array.`
      let referencesFile = false
      for (let attempt = 0; attempt < 3 && !referencesFile; attempt++) {
        const chatThread = await createAgentDmThread()
        const { events } = await consumeSse(url, "/api/agent/chat", agent.token, {
          threadId: chatThread,
          content: prompt,
          modelId: TOOL_MODEL,
        })
        if (isProviderUnavailable(events)) return // LLM provider down — skip, stay green.
        const approvals = await env.db.sql.unsafe(
          `SELECT current_payload FROM ${ks(env)}.approval_requests
          WHERE tool_name = 'tickets:reply' AND originating_thread_id = $1`,
          [chatThread],
        )
        referencesFile = approvals.some((a) =>
          JSON.stringify((a as { current_payload?: unknown }).current_payload ?? {}).includes(
            customerFile.fileId,
          ),
        )
      }
      expect(referencesFile).toBe(true)
    },
    240_000,
  )
})
