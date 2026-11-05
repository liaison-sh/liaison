// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ticket-creation acknowledgement email (Task 2): send-once dedup via
// ack_sent_at, gating on the per-inbox ack_enabled flag (Task 1), and the
// no-recipient/no-inbox short circuits. `sendOutbound` is mocked (HERMETICITY:
// mock.module leaks past this file under bun's flat test process, so we spread
// the REAL module and restore it in afterAll — same pattern as
// inbound-attachments.integration.test.ts) so this exercises the REAL DB
// dedup/gating logic without a real SMTP/Gmail network call.

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import * as realSend from "~/apps/tickets/send"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { DurableConsumersTestAccess, durableConsumerCount } from "~/infra/events/durable-consumers"
import { _getGlobalHandlerCount, EventBusTestAccess } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import { REDIS_PREFIX, redisBullMQ } from "~/lib/redis"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { drainOutbox } from "~/tests/helpers/outbox"
import { ticketsReply } from "./tools"

// Eager snapshot: `realSend` is a LIVE namespace view, so mock.module patches
// it in place — spreading it inside the restore factory would re-install the
// mock. Snapshot the real exports BEFORE the mock so afterAll truly restores.
const realSendModule = { ...realSend }

const sendCalls: Array<{ to: unknown; subject: string; html?: string }> = []
let failNextSend = false
mock.module("~/apps/tickets/send", () => ({
  ...realSendModule,
  sendOutbound: async (email: { to: unknown; subject: string; html?: string }) => {
    if (failNextSend) {
      failNextSend = false
      throw new realSendModule.OutboundError("preflight_failed", "provider refused the message", {
        retryable: false,
      })
    }
    sendCalls.push({ to: email.to, subject: email.subject, html: email.html })
    return {
      externalMessageId: `<ack-${sendCalls.length}@test>`,
      deliveryState: "delivered" as const,
      rfc2822: "",
    }
  },
}))

afterAll(() => {
  mock.module("~/apps/tickets/send", () => realSendModule)
})

const { sendTicketAcknowledgement } = await import("./tools")
const { processInboundMessage } = await import("./inbound")
const { acknowledgeCommittedTicket } = await import("./ack-after-commit")

const rows = (r: unknown): any[] => (r as any).rows ?? r

let orgId: string
let userId: string
let accountId: string
let inboxId: string
let noAckInboxId: string

// Each test acknowledges the same customer address, so the per-recipient ack
// cap (a real limit) is reset between tests rather than shared across them.
beforeEach(async () => {
  if (!orgId) return
  const keys = await redisBullMQ.keys(`${REDIS_PREFIX}ratelimit:tickets:ack:*${orgId}*`)
  if (keys.length) await redisBullMQ.del(...keys)
})

beforeAll(async () => {
  const slug = `ack-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("ack-fixture", async (tx) => {
    orgId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Ack Test', ${slug}) RETURNING id`),
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
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name,
           reply_to_email, ack_enabled, sla_promise_phrase, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'Support', 'support@fabrikam.test',
                'Fabrikam Support', 'support@fabrikam.example', true, 'within 2 business days', true, now(), now())
        RETURNING id`),
    )[0].id
    noAckInboxId = rows(
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.inboxes
          (id, org_id, kind, connected_account_id, name, email_address, from_display_name,
           ack_enabled, is_default_for_create, created_at, updated_at)
        VALUES (gen_random_uuid(), ${orgId}, 'mailbox', ${accountId}, 'NoAck', 'noack@fabrikam.test',
                'No Ack Mailbox', false, false, now(), now())
        RETURNING id`),
    )[0].id
  })
  await ensureAppsForOrg(orgId, {})
})

async function createTicketWithInbox(
  sourceInboxId: string,
  opts: { withInbound?: boolean } = {},
): Promise<string> {
  const withInbound = opts.withInbound !== false
  return withPrivilegedDb(orgId, "ack-test-create", async (tx) => {
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
          ${Math.random().toString(36).slice(2, 12)}, ${sourceInboxId}, ${accountId},
          3600, now() + interval '1 hour', now(), 0,
          0, now(), now()
        )
        RETURNING id
      `),
    )
    const ticketId = ticketRows[0]!.id
    if (withInbound) {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages (
          id, org_id, ticket_id, kind, from_email, from_name, sent_at, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), ${orgId}, ${ticketId}, 'inbound', 'customer@example.com', 'Cust',
          now(), now(), now()
        )
      `)
    }
    return ticketId
  })
}

describe("sendTicketAcknowledgement", () => {
  it("caps acknowledgements per recipient: a flood of tickets for one address sends only a few", async () => {
    const results = []
    for (let i = 0; i < 4; i++) {
      results.push(await sendTicketAcknowledgement(await createTicketWithInbox(inboxId), orgId))
    }
    expect(results.filter((r) => "sent" in r && r.sent).length).toBeLessThan(4)
    expect(results.at(-1)).toMatchObject({ ok: true, sent: false, reason: "rate_limited" })
  })

  it("an acknowledgement to an unverified address does not echo the request's subject", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    const before = sendCalls.length
    await sendTicketAcknowledgement(ticketId, orgId, { unverifiedRecipient: true })
    expect(sendCalls.length).toBe(before + 1)
    expect(sendCalls.at(-1)?.subject).not.toContain("Need help")
  })

  it("sends the acknowledgement and stamps ack_sent_at", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    const before = sendCalls.length
    const result = await sendTicketAcknowledgement(ticketId, orgId)
    expect(result).toMatchObject({ ok: true, sent: true })
    expect(sendCalls.length).toBe(before + 1)

    const row = extractRows<{ ack_sent_at: Date | null }>(
      await withPrivilegedDb(orgId, "ack-test-check", (tx) =>
        tx.execute(
          drizzleSql`SELECT ack_sent_at FROM app_tickets.tickets WHERE id = ${ticketId}::uuid`,
        ),
      ),
    )[0]
    expect(row?.ack_sent_at).toBeTruthy()
  })

  it("an acknowledgement is not a reply: the ticket stays in Needs attention", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    await withPrivilegedDb(orgId, "ack-test-inbound-at", (tx) =>
      tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET last_inbound_at = now() - interval '1 minute', last_message_at = now() - interval '1 minute' WHERE id = ${ticketId}::uuid`,
      ),
    )
    const result = await sendTicketAcknowledgement(ticketId, orgId)
    expect(result).toMatchObject({ ok: true, sent: true })

    const row = extractRows<{ last_outbound_at: Date | null; first_response_at: Date | null }>(
      await withPrivilegedDb(orgId, "ack-test-outbound-at", (tx) =>
        tx.execute(
          drizzleSql`SELECT last_outbound_at, first_response_at FROM app_tickets.tickets WHERE id = ${ticketId}::uuid`,
        ),
      ),
    )[0]
    expect(row?.last_outbound_at).toBeNull()
    expect(row?.first_response_at).toBeNull()

    const { searchTickets } = await import("./search")
    const res = await withSystemDb("ack-test-needs-attention", (tx) =>
      searchTickets(tx as never, orgId, { smartFilter: "needs-attention", limit: 100 } as never),
    )
    const ids = res.items.map((r) => String((r as Record<string, unknown>).id))
    expect(ids).toContain(ticketId)
  })

  it("is send-once: a second call is a no-op (already_sent), even though the first call already stamped it", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    const first = await sendTicketAcknowledgement(ticketId, orgId)
    expect(first).toMatchObject({ ok: true, sent: true })
    const before = sendCalls.length

    const second = await sendTicketAcknowledgement(ticketId, orgId)
    expect(second).toMatchObject({ ok: true, sent: false, reason: "already_sent" })
    expect(sendCalls.length).toBe(before) // no additional send
  })

  it("skips sending (ack_disabled) when the source inbox has ack_enabled=false", async () => {
    const ticketId = await createTicketWithInbox(noAckInboxId)
    const before = sendCalls.length
    const result = await sendTicketAcknowledgement(ticketId, orgId)
    expect(result).toMatchObject({ ok: true, sent: false, reason: "ack_disabled" })
    expect(sendCalls.length).toBe(before)
  })

  it("skips sending (no_recipient) when the ticket has no inbound customer message", async () => {
    const ticketId = await createTicketWithInbox(inboxId, { withInbound: false })
    const result = await sendTicketAcknowledgement(ticketId, orgId)
    expect(result).toMatchObject({ ok: true, sent: false, reason: "no_recipient" })
  })

  it("skips sending (no_inbox) when the ticket has no source inbox", async () => {
    const ticketId = await withPrivilegedDb(orgId, "ack-test-no-inbox", async (tx) => {
      const handle = `ticket_${Math.random().toString(36).slice(2, 8)}`
      const r = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO app_tickets.tickets (
            id, org_id, handle, subject, status, priority, channel, sensitivity,
            reply_token, sla_target_seconds, sla_deadline, sla_active_started_at,
            sla_elapsed_seconds, message_count, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${orgId}, ${handle}, 'No inbox ticket', 'open', 'normal', 'manual', 'internal',
            ${Math.random().toString(36).slice(2, 12)}, 3600, now() + interval '1 hour', now(),
            0, 0, now(), now()
          )
          RETURNING id
        `),
      )
      return r[0]!.id
    })
    const result = await sendTicketAcknowledgement(ticketId, orgId)
    expect(result).toMatchObject({ ok: true, sent: false, reason: "no_inbox" })
  })

  it("returns not_found for an unknown ticket id", async () => {
    const result = await sendTicketAcknowledgement(crypto.randomUUID(), orgId)
    expect(result).toMatchObject({ error: { code: "not_found" } })
  })

  // A French org's customer got "We have received your request and will get
  // back to you within 2 business days." under a French header: the default
  // body, and the inbox's DEFAULT promise phrase, were English literals.
  it("the default acknowledgement speaks the org's language when the ticket has none", async () => {
    await withSystemDb("ack-fr-org", (tx) =>
      tx.execute(
        drizzleSql`UPDATE kernel.organizations SET default_locale = 'fr-FR' WHERE id = ${orgId}`,
      ),
    )
    try {
      const ticketId = await createTicketWithInbox(inboxId)
      await sendTicketAcknowledgement(ticketId, orgId)
      const html = sendCalls[sendCalls.length - 1]!.html ?? ""
      expect(html).toContain(
        "Nous avons bien reçu votre demande et vous répondrons sous 2 jours ouvrés.",
      )
      expect(html).toContain("Référence du ticket")
      expect(html).not.toMatch(/We have received|business days|Ticket reference/)
    } finally {
      await withSystemDb("ack-en-org", (tx) =>
        tx.execute(
          drizzleSql`UPDATE kernel.organizations SET default_locale = 'en-US' WHERE id = ${orgId}`,
        ),
      )
    }
  })

  it("the sent acknowledgement email is addressed to the ticket's inbound customer", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    await sendTicketAcknowledgement(ticketId, orgId)
    const last = sendCalls[sendCalls.length - 1]!
    expect(JSON.stringify(last.to)).toContain("customer@example.com")
  })

  // Task 2: the persisted ack message row is durably marked so the frontend
  // can hide it from the rendered conversation (DTO field `isAcknowledgement`).
  it("stamps the persisted ack message row with is_acknowledgement = true", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    await sendTicketAcknowledgement(ticketId, orgId)
    const row = extractRows<{ is_acknowledgement: boolean }>(
      await withPrivilegedDb(orgId, "ack-test-marker", (tx) =>
        tx.execute(
          drizzleSql`SELECT is_acknowledgement FROM app_tickets.messages
                     WHERE ticket_id = ${ticketId}::uuid AND kind = 'outbound'
                     ORDER BY sent_at DESC LIMIT 1`,
        ),
      ),
    )[0]
    expect(row?.is_acknowledgement).toBe(true)
  })

  // Regression (Task 1): a web-form ticket's first (and only) inbound message
  // has an empty external_message_id — nothing arrived over email to thread
  // against. Once the create-time acknowledgement sends, the ticket's most
  // RECENT message is that ack (a system send with no from_email). Replying
  // afterwards must still resolve the customer's real address as `To:`
  // (previously it silently emptied `To:` and Gmail rejected the send with a
  // 400 — send_preflight_failed).
  it("replying to a web-form ticket succeeds after its ack has sent, even though the inbound message has no external_message_id", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    const ack = await sendTicketAcknowledgement(ticketId, orgId)
    expect(ack).toMatchObject({ ok: true, sent: true })

    const before = sendCalls.length
    const result = await withPrivilegedDb(orgId, "ack-test-reply", async (tx) => {
      const ctx = { tx: tx as never, orgId, actor: { actorType: "user" as const, userId } }
      return ticketsReply({ ticketId, textBody: "Following up on your request." }, ctx)
    })
    expect("ok" in result && result.ok).toBe(true)
    expect(sendCalls.length).toBe(before + 1)
    const last = sendCalls[sendCalls.length - 1]!
    expect(JSON.stringify(last.to)).toContain("customer@example.com")
    expect(JSON.stringify(last.to)).not.toContain('"email":""')
  })
})

describe("sendTicketAcknowledgement concurrency", () => {
  // Send-once is claimed BEFORE the send: two callers racing on one ticket
  // used to both read ack_sent_at IS NULL and both mail the customer.
  it("two concurrent calls send one acknowledgement", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    const before = sendCalls.length
    const results = await Promise.all([
      sendTicketAcknowledgement(ticketId, orgId),
      sendTicketAcknowledgement(ticketId, orgId),
    ])
    expect(sendCalls.length - before).toBe(1)
    expect(results.filter((r) => "sent" in r && r.sent).length).toBe(1)
  })

  it("a failed send releases the claim so a later attempt can send", async () => {
    const ticketId = await createTicketWithInbox(inboxId)
    failNextSend = true
    const failed = await sendTicketAcknowledgement(ticketId, orgId)
    expect("error" in failed).toBe(true)
    const claim = await withPrivilegedDb(orgId, "ack-claim-read", async (tx) =>
      extractRows<{ ack_sent_at: Date | null }>(
        await tx.execute(
          drizzleSql`SELECT ack_sent_at FROM app_tickets.tickets WHERE id = ${ticketId}`,
        ),
      ),
    )
    expect(claim[0]?.ack_sent_at ?? null).toBeNull()
    const retried = await sendTicketAcknowledgement(ticketId, orgId)
    expect("sent" in retried && retried.sent).toBe(true)
  })
})

// The acknowledgement of a ticket opened by inbound mail goes out only once the
// ticket has COMMITTED. Every caller runs `processInboundMessage` inside its own
// outer transaction (the mail sync bridge, a sandboxed handler), so the ack used
// to run while the ticket was still invisible to its own connection: it
// answered "ticket not found" for every new ticket and the customer never got
// the mail. The request now rides the ticket's `ticket:create` event.
describe("inbound ticket acknowledgement after commit", () => {
  const gmailPass = (domain: string) => ({
    receivedVia: "gmail_api" as const,
    authenticationResults: [`mx.google.com; dmarc=pass (p=REJECT) header.from=${domain}`],
    labelIds: ["INBOX"],
  })
  let seq = 0
  function mail(
    from: string,
    auth: Record<string, unknown>,
    opts: { sentAt?: string; to?: string } = {},
  ) {
    seq += 1
    return {
      messageId: `<ack-commit-${seq}-${Date.now()}@mail.test>`,
      from: { email: from, name: "Customer" },
      to: [{ email: opts.to ?? "support@fabrikam.test" }],
      cc: [],
      subject: `Order question ${seq}`,
      textBody: "hello",
      sentAt: opts.sentAt ?? new Date().toISOString(),
      headers: {},
      ...auth,
    } as never
  }
  const inbox = (id = inboxId, address = "support@fabrikam.test") => ({
    id,
    org_id: orgId,
    email_address: address,
  })

  /** Ingest the way the mail sync bridge does: inside an OUTER privileged transaction. */
  async function ingestInsideOuterTx(
    raw: never,
    opts: { inboxId?: string; inboxAddress?: string; noAcknowledgement?: boolean } = {},
  ): Promise<string> {
    const result = await withPrivilegedDb(orgId, "ack-after-commit-test", (db) =>
      processInboundMessage(raw, inbox(opts.inboxId, opts.inboxAddress) as never, {
        db: db as never,
        orgId,
        ...(opts.noAcknowledgement ? { noAcknowledgement: true } : {}),
      }),
    )
    if (!("outcome" in result) || result.outcome !== "created") {
      throw new Error(`expected a created ticket, got ${JSON.stringify(result)}`)
    }
    return result.ticketId
  }

  async function ackSentAt(ticketId: string): Promise<Date | null> {
    return withPrivilegedDb(orgId, "ack-after-commit-read", async (tx) => {
      const r = extractRows<{ ack_sent_at: Date | null }>(
        await tx.execute(
          drizzleSql`SELECT ack_sent_at FROM app_tickets.tickets WHERE id = ${ticketId}`,
        ),
      )
      return r[0]?.ack_sent_at ?? null
    })
  }

  // Through the REAL subscriber registration (not a test-local `onEvent`), so
  // removing the registration from event-subscribers.ts fails these tests.
  let globalHandlersBefore = 0
  let durableConsumersBefore = 0
  beforeAll(() => {
    globalHandlersBefore = _getGlobalHandlerCount()
    durableConsumersBefore = durableConsumerCount()
    registerEventSubscribers()
  })
  afterAll(() => {
    EventBusTestAccess.truncateGlobalHandlers(globalHandlersBefore)
    if (durableConsumersBefore === 0) DurableConsumersTestAccess.reset()
  })

  // The mock numbers each send's message id by its position in `sendCalls`, so
  // the list is never cleared: each test counts the sends it adds.
  let sendsBefore = 0
  beforeEach(async () => {
    await drainOutbox()
    sendsBefore = sendCalls.length
  })

  it("acknowledges a new ticket ingested inside an outer transaction once it commits", async () => {
    const ticketId = await ingestInsideOuterTx(
      mail("shopper@shopper.test", gmailPass("shopper.test")),
    )
    await drainOutbox()
    expect(await ackSentAt(ticketId)).not.toBeNull()
    expect(sendCalls.length - sendsBefore).toBe(1)
  })

  it("does not acknowledge a sender the provider did not authenticate", async () => {
    const ticketId = await ingestInsideOuterTx(
      mail("stranger@unverified.test", { receivedVia: "gmail_api", labelIds: ["INBOX"] }),
    )
    await drainOutbox()
    expect(await ackSentAt(ticketId)).toBeNull()
    expect(sendCalls.length - sendsBefore).toBe(0)
  })

  it("does not acknowledge mail sent long before it was ingested", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const ticketId = await ingestInsideOuterTx(
      mail("late@shopper.test", gmailPass("shopper.test"), { sentAt: threeDaysAgo }),
    )
    await drainOutbox()
    expect(await ackSentAt(ticketId)).toBeNull()
    expect(sendCalls.length - sendsBefore).toBe(0)
  })

  it("does not acknowledge mail ingested by a first (backfill) sync", async () => {
    const ticketId = await ingestInsideOuterTx(
      mail("backlog@shopper.test", gmailPass("shopper.test")),
      { noAcknowledgement: true },
    )
    await drainOutbox()
    expect(await ackSentAt(ticketId)).toBeNull()
    expect(sendCalls.length - sendsBefore).toBe(0)
  })

  it("does not acknowledge when the inbox has acknowledgements off", async () => {
    const ticketId = await ingestInsideOuterTx(
      mail("quiet@shopper.test", gmailPass("shopper.test"), { to: "noack@fabrikam.test" }),
      { inboxId: noAckInboxId, inboxAddress: "noack@fabrikam.test" },
    )
    await drainOutbox()
    expect(await ackSentAt(ticketId)).toBeNull()
    expect(sendCalls.length - sendsBefore).toBe(0)
  })

  it("does not acknowledge a ticket we opened by writing first", async () => {
    const ticketId = await ingestInsideOuterTx(
      mail("support@fabrikam.test", gmailPass("fabrikam.test"), { to: "buyer@shopper.test" }),
    )
    await drainOutbox()
    expect(await ackSentAt(ticketId)).toBeNull()
    expect(sendCalls.length - sendsBefore).toBe(0)
  })

  it("never acknowledges a no-reply style sender", async () => {
    for (const local of [
      "no-reply",
      "NoReply",
      "donotreply",
      "MAILER-DAEMON",
      "postmaster",
      "bounce",
    ]) {
      const ticketId = await ingestInsideOuterTx(
        mail(`${local}@shopper.test`, gmailPass("shopper.test")),
      )
      await drainOutbox()
      expect(await ackSentAt(ticketId)).toBeNull()
    }
    expect(sendCalls.length - sendsBefore).toBe(0)
  })

  it("does not acknowledge a ticket merged before the acknowledgement ran", async () => {
    const ticketId = await ingestInsideOuterTx(
      mail("merged@shopper.test", gmailPass("shopper.test")),
    )
    const targetId = await createTicketWithInbox(inboxId, { withInbound: false })
    await withPrivilegedDb(orgId, "ack-merge", async (tx) => {
      await tx.execute(
        drizzleSql`UPDATE app_tickets.tickets SET merged_into_ticket_id = ${targetId} WHERE id = ${ticketId}`,
      )
    })
    await drainOutbox()
    expect(await ackSentAt(ticketId)).toBeNull()
    expect(sendCalls.length - sendsBefore).toBe(0)
  })

  it("a redelivered creation event sends the acknowledgement once", async () => {
    const ticketId = await ingestInsideOuterTx(
      mail("twice@shopper.test", gmailPass("shopper.test")),
    )
    await drainOutbox()
    const redelivered = {
      app: "tickets",
      entity: "ticket",
      action: "create",
      entityId: ticketId,
      orgId,
      metadata: { acknowledgeAfterCommit: true },
    } as never
    await Promise.all([
      acknowledgeCommittedTicket(redelivered),
      acknowledgeCommittedTicket(redelivered),
    ])
    expect(sendCalls.length - sendsBefore).toBe(1)
  })

  it("never acknowledges a ticket whose transaction rolled back", async () => {
    const raw = mail("rollback@shopper.test", gmailPass("shopper.test"))
    const err = await withPrivilegedDb(orgId, "ack-after-commit-rollback", async (db) => {
      await processInboundMessage(raw, inbox() as never, { db: db as never, orgId })
      throw new Error("outer transaction fails after the ingest")
    }).catch((e: unknown) => e)
    expect((err as Error).message).toBe("outer transaction fails after the ingest")
    await drainOutbox()
    expect(sendCalls.length - sendsBefore).toBe(0)
  })
})
