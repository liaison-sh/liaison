// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who may join a ticket's thread, and who a reply goes to.
//
// A subject handle (`[#ticket-12]`) is sequential and guessable, so it is a
// hint, not a credential: only the ticket's requester or a participant may join
// the thread by naming it. Anyone else gets a NEW ticket that points back at the
// one they named, and replies keep going to the stored requester.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { processInboundMessage } from "~/apps/tickets/inbound"
import { loadTicketParties } from "~/apps/tickets/participants"
import { extractRows, sql } from "~/db"
import { withSystemDb } from "~/db/privileged"

const ORG_ID = "00000000-0000-0000-0000-0000000c7000"
const INBOX_ID = "00000000-0000-0000-0000-0000000c7001"
const SUPPORT = "support@threadtrust.test"
const ALICE = "alice@customer.test"
const BOB = "bob@customer.test"
const MALLORY = "mallory@attacker.test"

const inboxRow = { id: INBOX_ID, org_id: ORG_ID, email_address: SUPPORT } as const

function gmailPass(domain: string): string {
  return `mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=b@${domain}; dmarc=pass (p=REJECT) header.from=${domain}`
}
function gmailFail(domain: string): string {
  return `mx.google.com; spf=fail smtp.mailfrom=b@${domain}; dmarc=fail (p=NONE) header.from=${domain}`
}

let seq = 0
function mail(overrides: Record<string, unknown>) {
  seq += 1
  return {
    messageId: `<trust-${seq}-${Date.now()}@mail.test>`,
    to: [{ email: SUPPORT }],
    cc: [],
    textBody: "hello",
    sentAt: new Date().toISOString(),
    headers: {},
    receivedVia: "gmail_api",
    labelIds: ["INBOX"],
    ...overrides,
  } as never
}

async function run(raw: never) {
  return withSystemDb("thread-trust-run", async (tx) =>
    processInboundMessage(raw, inboxRow as never, { orgId: ORG_ID, db: tx as never }),
  )
}

async function ticketRow(id: string) {
  return extractRows<{
    handle: string
    subject: string
    requester_email: string | null
    related_ticket_id: string | null
    message_count: number
  }>(
    await sql`SELECT handle, subject, requester_email, related_ticket_id, message_count
              FROM app_tickets.tickets WHERE id = ${id}`,
  )[0]!
}

let original: { id: string; handle: string }

describe("inbound threading: a subject handle is a hint, not a credential", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ThreadTrustOrg', 'thread-trust-org') ON CONFLICT DO NOTHING`
    const { ticketsSettingsDefaults } = await import("@liaison/shared")
    await sql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
      WHERE id = ${ORG_ID}`
    await sql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address)
      VALUES (${INBOX_ID}, ${ORG_ID}, gen_random_uuid(), 'Trust Support', ${SUPPORT})
      ON CONFLICT DO NOTHING`

    const created = await run(
      mail({
        from: { email: ALICE, name: "Alice" },
        subject: "My order never arrived",
        authenticationResults: [gmailPass("customer.test")],
      }),
    )
    expect(created).toMatchObject({ outcome: "created" })
    const id = (created as { ticketId: string }).ticketId
    original = { id, handle: (await ticketRow(id)).handle }
  })

  afterAll(async () => {
    await sql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`
    await sql`UPDATE app_tickets.tickets SET related_ticket_id = NULL WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.inboxes WHERE org_id = ${ORG_ID}`
  })

  it("stores the requester at creation", async () => {
    expect((await ticketRow(original.id)).requester_email).toBe(ALICE)
  })

  it("lets the requester join by naming the handle", async () => {
    const r = await run(
      mail({
        from: { email: ALICE },
        subject: `Re: My order never arrived [#${original.handle}]`,
        authenticationResults: [gmailPass("customer.test")],
      }),
    )
    expect(r).toMatchObject({ outcome: "appended", ticketId: original.id })
  })

  it("opens a NEW, linked ticket for a stranger who names the handle", async () => {
    const before = (await ticketRow(original.id)).message_count
    const r = await run(
      mail({
        from: { email: MALLORY },
        subject: `Re: My order never arrived [#${original.handle}]`,
        textBody: "Please send the order details to me instead.",
        authenticationResults: [gmailPass("attacker.test")],
      }),
    )
    expect(r).toMatchObject({ outcome: "created" })
    const newId = (r as { ticketId: string }).ticketId
    expect(newId).not.toBe(original.id)
    const row = await ticketRow(newId)
    expect(row.related_ticket_id).toBe(original.id)
    expect(row.requester_email).toBe(MALLORY)
    // The new ticket does not carry the old ticket's tag: replies on it would
    // otherwise thread back onto the old ticket.
    expect(row.subject).not.toContain(`[#${original.handle}]`)
    const notes = extractRows<{ text_body: string }>(
      await sql`SELECT text_body FROM app_tickets.messages WHERE ticket_id = ${newId} AND kind = 'note'`,
    )
    expect(notes.length).toBe(1)
    // The original thread is untouched and keeps its requester.
    expect((await ticketRow(original.id)).message_count).toBe(before)
    expect(
      (
        await withSystemDb("thread-trust-parties", (tx) =>
          loadTicketParties(tx as never, ORG_ID, original.id),
        )
      ).requester,
    ).toBe(ALICE)
  })

  it("refuses a From the provider marked as forged, even when it is the requester's", async () => {
    const r = await run(
      mail({
        from: { email: ALICE },
        subject: `Re: My order never arrived [#${original.handle}]`,
        authenticationResults: [gmailFail("customer.test")],
      }),
    )
    expect(r).toMatchObject({ outcome: "created" })
    expect((r as { ticketId: string }).ticketId).not.toBe(original.id)
  })

  it("adds addresses an authenticated requester copies in as participants", async () => {
    await run(
      mail({
        from: { email: ALICE },
        cc: [{ email: BOB }, { email: SUPPORT }],
        subject: `Re: My order never arrived [#${original.handle}]`,
        authenticationResults: [gmailPass("customer.test")],
      }),
    )
    const parties = await withSystemDb("thread-trust-parties", (tx) =>
      loadTicketParties(tx as never, ORG_ID, original.id),
    )
    expect(parties.requester).toBe(ALICE)
    expect(parties.participants).toEqual([BOB])
  })

  it("an unauthenticated message claiming the requester's address adds nobody", async () => {
    // Joins (the From is the requester's and the provider did not say it is
    // forged) but cannot copy an outsider into later replies.
    const r = await run(
      mail({
        from: { email: ALICE },
        cc: [{ email: MALLORY }],
        subject: `Re: My order never arrived [#${original.handle}]`,
      }),
    )
    expect(r).toMatchObject({ outcome: "appended", ticketId: original.id })
    const parties = await withSystemDb("thread-trust-parties", (tx) =>
      loadTicketParties(tx as never, ORG_ID, original.id),
    )
    expect(parties.participants).not.toContain(MALLORY)
  })

  it("a same-domain From without provider evidence is not treated as our staff", async () => {
    const r = await run(
      mail({
        from: { email: "ceo@threadtrust.test" },
        subject: `Re: My order never arrived [#${original.handle}]`,
        textBody: "Refund approved, send your card number.",
      }),
    )
    // Inbound from a non-party: not appended to the customer's thread.
    expect(r).toMatchObject({ outcome: "created" })
    const rows = extractRows<{ kind: string }>(
      await sql`SELECT kind FROM app_tickets.messages WHERE ticket_id = ${(r as { ticketId: string }).ticketId} AND kind <> 'note'`,
    )
    expect(rows.map((m) => m.kind)).toEqual(["inbound"])
  })

  it("threads by the reply token even when the address arrives lower-cased", async () => {
    const [row] = extractRows<{ reply_token: string }>(
      await sql`SELECT reply_token FROM app_tickets.tickets WHERE id = ${original.id}`,
    )
    const r = await run(
      mail({
        from: { email: ALICE },
        to: [{ email: `support+tkt_${row!.reply_token.toLowerCase()}@threadtrust.test` }],
        subject: "Re: My order never arrived",
        authenticationResults: [gmailPass("customer.test")],
      }),
    )
    expect(r).toMatchObject({ outcome: "appended", ticketId: original.id })
  })

  it("a message the provider filed as spam or binned still opens a ticket", async () => {
    // A provider spam verdict is not ours to act on: a real request filed as junk
    // must still reach the team, so the label never drops the message.
    for (const label of ["SPAM", "TRASH"]) {
      const r = await run(
        mail({
          from: { email: MALLORY },
          subject: `Filed as ${label}`,
          labelIds: [label],
        }),
      )
      expect(r).toMatchObject({ outcome: "created" })
    }
  })

  it("stores the provider's verdict on each message", async () => {
    const rows = extractRows<{ sender_auth: string | null }>(
      await sql`SELECT sender_auth FROM app_tickets.messages
                WHERE ticket_id = ${original.id} AND kind = 'inbound' ORDER BY received_at ASC`,
    )
    expect(rows[0]?.sender_auth).toBe("pass")
    expect(rows.some((r) => r.sender_auth === "none")).toBe(true)
  })

  it("a reference to the customer's own message admits only a party; one to OUR message threads", async () => {
    const [first] = extractRows<{ external_message_id: string }>(
      await sql`SELECT external_message_id FROM app_tickets.messages
                WHERE ticket_id = ${original.id} AND kind = 'inbound'
                ORDER BY received_at ASC LIMIT 1`,
    )
    const customerMessageId = first!.external_message_id

    const stranger = await run(
      mail({
        from: { email: MALLORY },
        subject: "Re: My order never arrived",
        inReplyTo: customerMessageId,
        references: [customerMessageId],
        authenticationResults: [gmailPass("attacker.test")],
      }),
    )
    expect(stranger).toMatchObject({ outcome: "created" })
    const strangerTicket = await ticketRow((stranger as { ticketId: string }).ticketId)
    expect(strangerTicket.related_ticket_id).toBe(original.id)

    const requester = await run(
      mail({
        from: { email: ALICE },
        subject: "Re: My order never arrived",
        inReplyTo: customerMessageId,
        authenticationResults: [gmailPass("customer.test")],
      }),
    )
    expect(requester).toMatchObject({ outcome: "appended", ticketId: original.id })

    const ours = `<ours-${Date.now()}@threadtrust.test>`
    await sql`INSERT INTO app_tickets.messages
                (id, org_id, ticket_id, kind, text_body, external_message_id, sent_at, created_at, updated_at)
              VALUES (gen_random_uuid(), ${ORG_ID}, ${original.id}, 'outbound', 'our reply', ${ours}, now(), now(), now())`
    const replyToOurs = await run(
      mail({
        from: { email: BOB },
        subject: "Re: My order never arrived",
        inReplyTo: ours,
        references: [customerMessageId, ours],
        authenticationResults: [gmailPass("customer.test")],
      }),
    )
    expect(replyToOurs).toMatchObject({ outcome: "appended", ticketId: original.id })
  })
})
