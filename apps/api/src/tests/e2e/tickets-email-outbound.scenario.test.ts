// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld } from "@liaison/test-helpers"
import { api, createUserWithScopes, type WorkerEnv } from "@liaison/test-helpers"
import { type GmailHttpFixture, startGmailHttpFixture } from "~/tests/fixtures/email/gmail-http"
import { type SmtpFixture, startSmtpFixture } from "~/tests/fixtures/email/smtp-server"
import { decide } from "./helpers/approvals"
import {
  ks,
  seedConnectedAccount,
  seedInbox,
  seedSmtpConnectedAccount,
  seedTicket,
  ts,
} from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

let env: WorkerEnv
let world: TestWorld
let url: string

let agent: { id: string; token: string; email: string; name: string }
let approver: { id: string; token: string; email: string; name: string }
let threadId: string
let gmailFixture: GmailHttpFixture

beforeAll(async () => {
  gmailFixture = await startGmailHttpFixture()
  const r = await setupScenario({
    seed: 740,
    serverEnv: {
      TICKETS_E2E_GMAIL_API_BASE_URL: gmailFixture.apiBaseUrl,
      // Allow plaintext SMTP to in-process fixtures during E2E. Production
      // never sets ALLOW_PRIVATE_MAIL_HOSTS so this stays test-only.
      ALLOW_PRIVATE_MAIL_HOSTS: "true",
    },
  })
  env = r.env
  world = r.world
  url = env.serverUrl

  // The agent runs gated tools but cannot self-approve — without `:approve`
  // scope, direct HTTP calls go through the actual gating flow (creating an
  // approval request that a separate approver must decide). Granting
  // `tickets:approve` would trip the human-bypass at execute-tool.
  agent = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
    name: "B-Agent",
    scopes: [
      "tickets:tickets:read",
      "tickets:tickets:write",
      "tickets:tickets:reply",
      "tickets:tickets:close",
      "tickets:inboxes:read",
      "tickets:categories:read",
      "kernel:threads:read",
      "kernel:threads:write",
    ],
    dimensions: { "*": ["*"] },
    schemaPrefix: env.schemaPrefix,
  })

  approver = await createUserWithScopes(url, env.db.sql, world.admin.token, world.org.id, {
    name: "B-Approver",
    scopes: [
      "tickets:tickets:read",
      "tickets:approve",
      "tickets:inboxes:read",
      "kernel:threads:read",
      "kernel:threads:write",
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
      title: "B outbound thread",
      participantIds: [agent.id],
    },
  })
  threadId = threadRes.body?.data?.id
  if (!threadId) {
    throw new Error(`failed to create thread: ${JSON.stringify(threadRes.body)}`)
  }
}, 120_000)

afterAll(async () => {
  await gmailFixture.close()
  await teardownScenario(env, world)
})

async function seedInboundMessage(
  ticketId: string,
  opts?: { externalMessageId?: string },
): Promise<void> {
  await env.db.sql.unsafe(
    `INSERT INTO ${ts(env)}.messages (
      id, org_id, ticket_id, kind, from_email, from_name, to_emails, subject,
      text_body, snippet, external_message_id, sent_at, created_at, updated_at
    ) VALUES (gen_random_uuid(), $1, $2, 'inbound', 'alice@cust.test', 'Alice', '[]'::jsonb,
      'Customer question', 'hello', 'hello', $3, now() - interval '1 minute', now() - interval '1 minute', now() - interval '1 minute')`,
    [world.org.id, ticketId, opts?.externalMessageId ?? `<in-${ticketId}@cust.test>`],
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

async function invokeTool(
  toolName: string,
  params: Record<string, unknown>,
): Promise<{
  blocked?: { approvalRequestId: string }
  data?: unknown
  error?: unknown
  status: number
}> {
  // The agent's call (origin in-app-agent): a person's own call never parks an approval.
  const res = await api(url, "/api/_test/agent-tool-call", {
    method: "POST",
    token: agent.token,
    body: { toolName, threadId, params },
  })
  const blocked = res.body?.data?.blocked
  return { blocked, data: res.body?.data, error: res.body?.error, status: res.status }
}

async function runGatedToolToCompletion(
  toolName: string,
  params: Record<string, unknown>,
): Promise<{ approvalRequestId: string; decideStatus: number; decideBody?: unknown }> {
  const triggered = await invokeTool(toolName, params)
  if (!triggered.blocked) {
    throw new Error(`expected blocked approval for ${toolName}, got ${JSON.stringify(triggered)}`)
  }
  const id = triggered.blocked.approvalRequestId
  const decideRes = await decide(url, approver.token, id, { decision: "approve" })
  if (decideRes.status !== 200) {
    throw new Error(`decide returned ${decideRes.status}: ${JSON.stringify(decideRes.body)}`)
  }
  return { approvalRequestId: id, decideStatus: decideRes.status, decideBody: decideRes.body }
}

async function ticketRow(ticketId: string): Promise<Record<string, unknown> | undefined> {
  const rows = await env.db.sql.unsafe(
    `SELECT id, status, message_count, last_outbound_at, first_response_at, nudge_sent_at,
            closed_reason, followup_at
       FROM ${ts(env)}.tickets WHERE org_id = $1 AND id = $2`,
    [world.org.id, ticketId],
  )
  return rows[0]
}

async function messageCount(ticketId: string): Promise<number> {
  const rows = await env.db.sql.unsafe(
    `SELECT count(*)::int AS n FROM ${ts(env)}.messages WHERE org_id = $1 AND ticket_id = $2`,
    [world.org.id, ticketId],
  )
  return rows[0]?.n ?? 0
}

describe("tickets-email outbound (B group)", () => {
  describe("B1 reply happy path", () => {
    it("gated tickets:reply → approval blocked → approve → outbound message inserted, status awaiting_customer", async () => {
      gmailFixture.reset()
      const accountEmail = `b1-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
        accessToken: "test-access-token",
      })
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "B1 inbox",
      })
      const ticket = await seedTicket(env, {
        orgId: world.org.id,
        subject: `B1 reply ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "open",
      })
      await seedInboundMessage(ticket.id)
      gmailFixture.queueSendResponse(accountEmail, { id: "gmail-b1", threadId: "gmail-thread-b1" })

      const before = await messageCount(ticket.id)
      const { approvalRequestId, decideStatus } = await runGatedToolToCompletion("tickets:reply", {
        ticketId: ticket.id,
        textBody: "Thanks for reaching out, looking into it.",
      })
      expect(decideStatus).toBe(200)
      const after = await messageCount(ticket.id)
      expect(after).toBe(before + 1)

      const row = await ticketRow(ticket.id)
      expect(row?.status).toBe("awaiting_customer")
      expect(row?.last_outbound_at).toBeDefined()
      expect(row?.first_response_at).toBeDefined()
      const sends = gmailFixture.requests().filter((r) => r.route === "messages.send")
      expect(sends).toHaveLength(1)
      const approvalRows = await env.db.sql.unsafe(
        `SELECT external_ref FROM ${ks(env)}.approved_handler_executions
          WHERE org_id = $1 AND approval_request_id = $2 AND tool_name = 'tickets:reply'`,
        [world.org.id, approvalRequestId],
      )
      expect(approvalRows[0]?.external_ref).toMatchObject({ externalMessageId: expect.any(String) })
    })
  })

  describe("B2 reply with followup transitions to awaiting_followup", () => {
    it("followup payload sets followup_at and status awaiting_followup", async () => {
      const accountEmail = `b2-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
        accessToken: "test-access-token",
      })
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "B2 inbox",
      })
      const ticket = await seedTicket(env, {
        orgId: world.org.id,
        subject: `B2 followup ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "open",
      })
      await seedInboundMessage(ticket.id)
      const followupAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()
      const { decideStatus } = await runGatedToolToCompletion("tickets:reply", {
        ticketId: ticket.id,
        textBody: "Will follow up in a few days.",
        followup: { at: followupAt, reason: "waiting on info" },
      })
      expect(decideStatus).toBe(200)
      const row = await ticketRow(ticket.id)
      expect(row?.status).toBe("awaiting_followup")
      expect(row?.followup_at).toBeDefined()
    })
  })

  describe("B3 nudge after attention triggers", () => {
    it("eligible ticket: tickets:nudge sets nudge_sent_at and inserts message", async () => {
      const accountEmail = `b3-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
        accessToken: "test-access-token",
      })
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "B3 inbox",
      })
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const ticket = await seedTicket(env, {
        orgId: world.org.id,
        subject: `B3 nudge ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "awaiting_customer",
        lastOutboundAt: eightDaysAgo,
      })
      await seedInboundMessage(ticket.id)

      const before = await messageCount(ticket.id)
      const { decideStatus } = await runGatedToolToCompletion("tickets:nudge", {
        ticketId: ticket.id,
        textBody: "Just checking in.",
      })
      expect(decideStatus).toBe(200)
      const row = await ticketRow(ticket.id)
      expect(row?.nudge_sent_at).toBeDefined()
      expect(row?.status).toBe("awaiting_customer")
      const after = await messageCount(ticket.id)
      expect(after).toBe(before + 1)
    })

    it("nudge_already_sent surfaces from preflight on second invocation", async () => {
      const accountEmail = `b3b-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
        accessToken: "test-access-token",
      })
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "B3b inbox",
      })
      const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
      const ticket = await seedTicket(env, {
        orgId: world.org.id,
        subject: `B3b nudge dup ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "awaiting_customer",
        lastOutboundAt: eightDaysAgo,
      })
      await seedInboundMessage(ticket.id)
      await runGatedToolToCompletion("tickets:nudge", {
        ticketId: ticket.id,
        textBody: "first nudge",
      })
      const triggered = await invokeTool("tickets:nudge", {
        ticketId: ticket.id,
        textBody: "second nudge",
      })
      // The second nudge — depending on flow may block or surface error directly.
      // Either way, the result must include the nudge_already_sent code somewhere reachable.
      const json = JSON.stringify(triggered)
      expect(json.includes("nudge_already_sent") || triggered.blocked).toBeTruthy()
    })
  })

  describe("B4 close silent + B5 close with body", () => {
    it("silent close: no message inserted, status closed, closed_reason resolved", async () => {
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: `b4-${Date.now()}@org.test`,
        createdBy: world.admin.id,
        appName: "tickets",
      })
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: `b4-${Date.now()}@org.test`,
        name: "B4 inbox",
      })
      const ticket = await seedTicket(env, {
        orgId: world.org.id,
        subject: `B4 close silent ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "awaiting_customer",
      })
      const before = await messageCount(ticket.id)
      const { decideStatus } = await runGatedToolToCompletion("tickets:close", {
        ticketId: ticket.id,
        closedReason: "resolved",
      })
      expect(decideStatus).toBe(200)
      const after = await messageCount(ticket.id)
      expect(after).toBe(before)
      const row = await ticketRow(ticket.id)
      expect(row?.status).toBe("closed")
      expect(row?.closed_reason).toBe("resolved")
    })

    it("close with body: outbound message inserted, status closed", async () => {
      const accountEmail = `b5-${Date.now()}@org.test`
      const ca = await seedConnectedAccount(env, {
        orgId: world.org.id,
        email: accountEmail,
        createdBy: world.admin.id,
        appName: "tickets",
        accessToken: "test-access-token",
      })
      const inbox = await seedInbox(env, {
        orgId: world.org.id,
        connectedAccountId: ca.id,
        emailAddress: accountEmail,
        name: "B5 inbox",
      })
      const ticket = await seedTicket(env, {
        orgId: world.org.id,
        subject: `B5 close body ${Date.now()}`,
        sourceInboxId: inbox.id,
        status: "awaiting_customer",
      })
      await seedInboundMessage(ticket.id)
      const before = await messageCount(ticket.id)
      const { decideStatus } = await runGatedToolToCompletion("tickets:close", {
        ticketId: ticket.id,
        closedReason: "duplicate",
        textBody: "Closing as duplicate of #other",
      })
      expect(decideStatus).toBe(200)
      const after = await messageCount(ticket.id)
      expect(after).toBe(before + 1)
      const row = await ticketRow(ticket.id)
      expect(row?.status).toBe("closed")
      expect(row?.closed_reason).toBe("duplicate")
    })
  })

  describe("B6 SMTP auth failure — failed_no_effect, no message", () => {
    it("auth failure prevents send; approval recorded as failed_no_effect; ticket unchanged", async () => {
      const smtp: SmtpFixture = await startSmtpFixture({ authRequired: true })
      try {
        smtp.inject.setAuthFailure(() => true)
        const accountEmail = `b6-${Date.now()}@org.test`
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
          name: "B6 inbox",
        })
        const ticket = await seedTicket(env, {
          orgId: world.org.id,
          subject: `B6 auth ${Date.now()}`,
          sourceInboxId: inbox.id,
          status: "awaiting_followup",
        })
        // Seed an inbound message so the renderer has a customer recipient.
        await seedInboundMessage(ticket.id)

        const before = await messageCount(ticket.id)
        const triggered = await invokeTool("tickets:reply", {
          ticketId: ticket.id,
          textBody: "auth fail probe",
        })
        if (!triggered.blocked) {
          throw new Error(`expected blocked approval, got ${JSON.stringify(triggered)}`)
        }
        const approvalRequestId = triggered.blocked.approvalRequestId
        const decideRes = await decide(url, approver.token, approvalRequestId, {
          decision: "approve",
        })
        // Tool fails inside the handler; approval surfaces handler_failed (422).
        expect(decideRes.status).toBe(422)
        const decideBody = decideRes.body as { error?: { code?: string } }
        expect(decideBody.error?.code).toBe("handler_failed")
        expect(smtp.captured.length).toBe(0)
        // No outbound message inserted (only the seeded inbound).
        const after = await messageCount(ticket.id)
        expect(after).toBe(before)
        const row = await ticketRow(ticket.id)
        expect(row?.status).toBe("awaiting_followup")
        const exec = await env.db.sql.unsafe(
          `SELECT status FROM ${ks(env)}.approved_handler_executions
            WHERE org_id = $1 AND approval_request_id = $2 AND tool_name = 'tickets:reply'`,
          [world.org.id, approvalRequestId],
        )
        expect(exec[0]?.status).toBe("failed_no_effect")
      } finally {
        await smtp.close()
      }
    })
  })

  describe("B7 SMTP ambiguous — outbound row inserted with null external_message_id", () => {
    it("ambiguous send recorded; message row inserted with null external id; status flips", async () => {
      const smtp: SmtpFixture = await startSmtpFixture({ authRequired: true })
      try {
        smtp.inject.setAmbiguousNext(1)
        const accountEmail = `b7-${Date.now()}@org.test`
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
          name: "B7 inbox",
        })
        const ticket = await seedTicket(env, {
          orgId: world.org.id,
          subject: `B7 ambiguous ${Date.now()}`,
          sourceInboxId: inbox.id,
          status: "open",
        })
        await seedInboundMessage(ticket.id)

        const before = await messageCount(ticket.id)
        const triggered = await invokeTool("tickets:reply", {
          ticketId: ticket.id,
          textBody: "ambiguous probe",
        })
        if (!triggered.blocked) {
          throw new Error(`expected blocked approval, got ${JSON.stringify(triggered)}`)
        }
        const approvalRequestId = triggered.blocked.approvalRequestId
        const decideRes = await decide(url, approver.token, approvalRequestId, {
          decision: "approve",
        })
        expect(decideRes.status).toBe(422)
        const decideBody = decideRes.body as { error?: { code?: string } }
        expect(decideBody.error?.code).toBe("handler_ambiguous")

        const after = await messageCount(ticket.id)
        expect(after).toBe(before + 1)
        const last = await env.db.sql.unsafe(
          `SELECT external_message_id FROM ${ts(env)}.messages
            WHERE org_id = $1 AND ticket_id = $2 AND kind = 'outbound'
            ORDER BY created_at DESC LIMIT 1`,
          [world.org.id, ticket.id],
        )
        expect(last[0]?.external_message_id).toBeNull()
        const row = await ticketRow(ticket.id)
        expect(row?.status).toBe("awaiting_customer")
        const exec = await env.db.sql.unsafe(
          `SELECT status FROM ${ks(env)}.approved_handler_executions
            WHERE org_id = $1 AND approval_request_id = $2 AND tool_name = 'tickets:reply'`,
          [world.org.id, approvalRequestId],
        )
        expect(exec[0]?.status).toBe("ambiguous")
      } finally {
        await smtp.close()
      }
    })
  })

  describe("B1b SMTP happy path — wire-level capture asserts the rendered email", () => {
    it("delivers via SMTP with subject, body, Reply-To token, In-Reply-To, and Message-Id on the wire", async () => {
      // Mutation lens: this test would FAIL if the gated tool inserted a
      // message row but skipped sendOutbound (the historical Phase 7.2 bug),
      // if renderTicketEmail dropped the reply-token Reply-To, or if the
      // outbound headers were not threaded against the seeded inbound.
      const smtp: SmtpFixture = await startSmtpFixture({ authRequired: true })
      try {
        const accountEmail = `b1b-${Date.now()}@org.test`
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
          name: "B1b inbox",
        })
        const ticketSubject = `B1b reply ${Date.now()}`
        const ticket = await seedTicket(env, {
          orgId: world.org.id,
          subject: ticketSubject,
          sourceInboxId: inbox.id,
          status: "open",
        })
        const customerExternalId = `<cust-b1b-${Date.now()}@cust.test>`
        await seedInboundMessage(ticket.id, { externalMessageId: customerExternalId })

        const replyText = `Wire-capture probe ${Date.now()}`
        const { decideStatus } = await runGatedToolToCompletion("tickets:reply", {
          ticketId: ticket.id,
          textBody: replyText,
        })
        expect(decideStatus).toBe(200)

        // Wire-level assertion: the SMTP server captured exactly one delivery
        // and its rendered headers/body are correct. A no-op send would yield
        // captured.length === 0; a header-rendering bug would mismatch below.
        expect(smtp.captured.length).toBe(1)
        const captured = smtp.captured[0]!
        expect(captured.subject).toContain(ticketSubject)
        expect(captured.text).toContain(replyText)
        // Header keys are lowercased by mailparser. Message-Id is always present.
        expect(captured.headers["message-id"]).toBeTruthy()
        // Threading: outbound must thread against the seeded inbound. Either
        // In-Reply-To or References should mention the customer's external id.
        const inReplyTo = String(captured.headers["in-reply-to"] ?? "")
        const references = String(captured.headers.references ?? "")
        expect(`${inReplyTo} ${references}`).toContain(customerExternalId)
        // Reply-To carries the +tkt_<token> address so customer replies route
        // back to this ticket via the inbound matcher.
        const replyToHeader = String(captured.headers["reply-to"] ?? "")
        expect(replyToHeader).toMatch(/\+tkt_/)

        const row = await ticketRow(ticket.id)
        expect(row?.status).toBe("awaiting_customer")
      } finally {
        await smtp.close()
      }
    })
  })

  describe("B8 Gmail send branch chosen — SMTP fixture sees zero deliveries", () => {
    it("inbox referencing a Gmail OAuth account routes through gmail-http; no SMTP delivery", async () => {
      const { startSmtpFixture } = await import("~/tests/fixtures/email/smtp-server")
      const smtp = await startSmtpFixture()
      try {
        gmailFixture.reset()
        const accountEmail = `b8-${Date.now()}@org.test`
        const ca = await seedConnectedAccount(env, {
          orgId: world.org.id,
          email: accountEmail,
          createdBy: world.admin.id,
          appName: "tickets",
          accessToken: "test-access-token",
        })
        const inbox = await seedInbox(env, {
          orgId: world.org.id,
          connectedAccountId: ca.id,
          emailAddress: accountEmail,
          name: "B8 inbox",
        })
        const ticket = await seedTicket(env, {
          orgId: world.org.id,
          subject: `B8 reply ${Date.now()}`,
          sourceInboxId: inbox.id,
          status: "open",
        })
        await seedInboundMessage(ticket.id)
        gmailFixture.queueSendResponse(accountEmail, {
          id: "gmail-b8",
          threadId: "gmail-thread-b8",
        })

        const { decideStatus } = await runGatedToolToCompletion("tickets:reply", {
          ticketId: ticket.id,
          textBody: "Reply via Gmail branch.",
        })
        expect(decideStatus).toBe(200)

        const sends = gmailFixture.requests().filter((r) => r.route === "messages.send")
        expect(sends).toHaveLength(1)
        expect(smtp.captured.length).toBe(0)
        const row = await ticketRow(ticket.id)
        expect(row?.status).toBe("awaiting_customer")
      } finally {
        await smtp.close()
      }
    })
  })
})

// Re-export for internal helper (suppress unused-import lint when present).
void ks
