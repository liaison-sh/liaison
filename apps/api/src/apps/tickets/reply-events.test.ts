// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ticketsReply must queue a live-update event for the outbound message it
// inserts AND for the ticket status change — queueEvent -> the transactional
// outbox -> the WS broadcast is the ONLY path a client learns about a new
// message (no DB triggers/CDC). Without it, an agent's own reply never echoed
// back into the open ticket detail view until a manual reload.
//
// `sendOutbound` is mocked (HERMETICITY: mock.module leaks past this file
// under bun's flat test process, so we spread the REAL module and restore it
// in afterAll — same pattern as ack.test.ts / inbound-attachments.integration.test.ts)
// so this exercises the REAL DB event-queuing without a real SMTP/Gmail call.

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as realSend from "~/apps/tickets/send"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

// Eager snapshot: `realSend` is a LIVE namespace view, so mock.module patches
// it in place — spreading it inside the restore factory would re-install the
// mock. Snapshot the real exports BEFORE the mock so afterAll truly restores.
const realSendModule = { ...realSend }

let sendCounter = 0
let lastEmail: { html: string; text?: string } | undefined
mock.module("~/apps/tickets/send", () => ({
  ...realSendModule,
  sendOutbound: async (email: { subject: string; html: string; text?: string }) => {
    lastEmail = email
    return {
      externalMessageId: `<reply-${++sendCounter}@test>`,
      deliveryState: "delivered" as const,
      rfc2822: "",
    }
  },
}))

afterAll(() => {
  mock.module("~/apps/tickets/send", () => realSendModule)
})

const { ticketsReply } = await import("./tools")

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string
let accountId: string
let inboxId: string

beforeAll(async () => {
  const slug = `reply-events-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("reply-events-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Reply Events Test', ${slug}) RETURNING id`),
    )[0].id
    userId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`u-${slug}@x.test`}, 'A', 'active', 'h', 1, 1) RETURNING id`),
    )[0].id
    accountId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by, access_token_encrypted)
        VALUES (gen_random_uuid(), ${orgId}, 'tickets', 'gmail', 'org', null, 'oauth2', 'support@fabrikam.test', 'active', ${userId}, 'enc')
        RETURNING id`),
    )[0].id
    inboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Support', 'support@fabrikam.test', 'Fabrikam Support', true, now(), now())
        RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

async function createTicketWithInbound(): Promise<string> {
  return withPrivilegedDb(orgId, "reply-events-create", async (tx) => {
    const handle = `ticket_${Math.random().toString(36).slice(2, 8)}`
    const ticketRows = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.tickets (
          id, org_id, handle, subject, status, priority, channel, sensitivity,
          reply_token, source_inbox_id, source_account_id,
          sla_target_seconds, sla_deadline, sla_active_started_at, sla_elapsed_seconds,
          message_count, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${handle}, 'Need help', 'open', 'normal', 'email', 'internal',
          ${Math.random().toString(36).slice(2, 12)}, ${inboxId}, ${accountId},
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id
      `),
    )
    const ticketId = ticketRows[0]!.id
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.messages (
        id, org_id, ticket_id, kind, from_email, from_name, sent_at, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', 'customer@example.com', 'Cust',
        now(), now(), now()
      )
    `)
    return ticketId
  })
}

async function pendingEventsFor(orgId: string): Promise<Array<Record<string, unknown>>> {
  const r = await withPrivilegedDb(orgId, "reply-events-check", (tx) =>
    tx.execute(drizzleSql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId}::uuid
      ORDER BY seq ASC
    `),
  )
  return extractRows<{ payload: Record<string, unknown> }>(r).map((row) => row.payload)
}

describe("ticketsReply — live-update events (queueEvent)", () => {
  it("queues a tickets/message:create event carrying the same shape the frontend reconciles against", async () => {
    const ticketId = await createTicketWithInbound()
    // ticketsReply's own preflight reads (loadTicket, recipient lookup) only need
    // SELECT visibility — run the whole call under withPrivilegedDb (bypasses RLS,
    // same as every other real-DB tools test in this suite) so `ctx.tx` is a live
    // client for the full call, including the nested withCtxPrivileged send/insert.
    const result = await withPrivilegedDb(orgId, "reply-events-call", async (tx) => {
      const ctx = { tx: tx as never, orgId, actor: { actorType: "user" as const, userId } }
      return ticketsReply({ ticketId, textBody: "We are looking into it." }, ctx)
    })
    expect("ok" in result && result.ok).toBe(true)

    const events = await pendingEventsFor(orgId)
    const messageEvent = events.find(
      (e) =>
        e.app === "tickets" &&
        e.entity === "message" &&
        e.action === "create" &&
        (e.data as { ticketId?: string })?.ticketId === ticketId,
    )
    expect(messageEvent).toBeTruthy()
    const data = messageEvent!.data as Record<string, unknown>
    expect(data.ticketId).toBe(ticketId)
    expect(data.kind).toBe("outbound")
    expect(data.textBody).toBe("We are looking into it.")
    expect(data.orgId).toBe(orgId)
    expect(typeof data.id).toBe("string")
  })

  it("queues a tickets/ticket:update event carrying the new status", async () => {
    const ticketId = await createTicketWithInbound()
    await withPrivilegedDb(orgId, "reply-events-call", async (tx) => {
      const ctx = { tx: tx as never, orgId, actor: { actorType: "user" as const, userId } }
      return ticketsReply({ ticketId, textBody: "Following up." }, ctx)
    })

    const events = await pendingEventsFor(orgId)
    const ticketEvent = events.find(
      (e) =>
        e.app === "tickets" &&
        e.entity === "ticket" &&
        e.action === "update" &&
        (e.data as { ticketId?: string })?.ticketId === ticketId,
    )
    expect(ticketEvent).toBeTruthy()
    const data = ticketEvent!.data as { ticketId: string; changes: { status: string } }
    expect(data.ticketId).toBe(ticketId)
    expect(data.changes.status).toBe("awaiting_customer")
  })
})

describe("ticketsReply — what the customer receives", () => {
  async function reply(textBody: string) {
    const ticketId = await createTicketWithInbound()
    await withPrivilegedDb(orgId, "reply-body-call", async (tx) => {
      const ctx = { tx: tx as never, orgId, actor: { actorType: "user" as const, userId } }
      return ticketsReply({ ticketId, textBody }, ctx)
    })
    const stored = await withPrivilegedDb(orgId, "reply-body-check", (tx) =>
      tx.execute(drizzleSql`
        SELECT html_body, text_body FROM app_tickets.messages
        WHERE ticket_id = ${ticketId} AND kind = 'outbound'`),
    )
    return {
      email: lastEmail!,
      row: extractRows<{ html_body: string; text_body: string }>(stored)[0]!,
    }
  }

  it("sends a markdown body as formatted email with a clean text part", async () => {
    const { email, row } = await reply("Merci **beaucoup** pour ++votre++ retour.\n\n- un\n- deux")
    expect(email.html).toContain("<strong>beaucoup</strong>")
    expect(email.html).toContain("<u>votre</u>")
    expect(email.html).toMatch(/<ul style="margin:0 0 1em;padding-left:1.5em">/)
    expect(email.text).toStartWith("Merci beaucoup pour votre retour.\n\n- un\n- deux")
    expect(email.text).not.toContain("**")
    // The conversation shows what the customer got; the source stays as written.
    expect(row.html_body).toContain("<strong>beaucoup</strong>")
    expect(row.text_body).toBe("Merci **beaucoup** pour ++votre++ retour.\n\n- un\n- deux")
  })

  it("sends a plain-text body exactly as before", async () => {
    // Bullets, numbering, indentation and blank lines are what was typed, not
    // formatting: the text part is the body byte for byte, the HTML its lines.
    const body = "Bonjour,\n\n* étape 5*3\n1) snake_case\n    indenté\n\n\nAlex"
    const { email } = await reply(body)
    expect(email.text).toStartWith(`${body}\n\n`)
    expect(email.html).toContain(
      "<p>Bonjour,<br /><br />* étape 5*3<br />1) snake_case<br />    indenté<br /><br /><br />Alex</p>",
    )
  })
})
