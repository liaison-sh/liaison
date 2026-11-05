// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step B3 of the inbound matcher: contact + normalized-subject fallback.
// A reply whose RFC 5322 threading headers reference messages we never stored
// (canonical case: a customer replying to a pre-migration helpdesk email whose
// Message-IDs are absent from the import) must thread onto the existing ticket
// for the same contact + subject on the same inbox, instead of opening a
// context-less duplicate ticket.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { normalizeReplySubject, processInboundMessage } from "~/apps/tickets/inbound"
import { extractRows, sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { ensureAppsForOrg } from "~/modules/apps/init"

describe("normalizeReplySubject", () => {
  it("strips a single Re: prefix and lowercases", () => {
    expect(normalizeReplySubject("Re: AcmeSound demo ne se relance pas")).toEqual({
      normalized: "acmesound demo ne se relance pas",
      isReply: true,
    })
  })

  it("strips stacked, mixed-language prefixes (Re: TR: Fwd:)", () => {
    expect(normalizeReplySubject("RE: TR: Fwd: Order stuck in customs")).toEqual({
      normalized: "order stuck in customs",
      isReply: true,
    })
  })

  it("strips bracketed reply counters (Re[2]:)", () => {
    expect(normalizeReplySubject("Re[2]: Firmware update fails")).toEqual({
      normalized: "firmware update fails",
      isReply: true,
    })
  })

  it("collapses internal whitespace", () => {
    expect(normalizeReplySubject("Re:  Broken   pad\tresponse").normalized).toBe(
      "broken pad response",
    )
  })

  it("reports a prefix-less subject as NOT a reply", () => {
    expect(normalizeReplySubject("AcmeSound demo ne se relance pas")).toEqual({
      normalized: "acmesound demo ne se relance pas",
      isReply: false,
    })
  })

  it("does not treat a word starting with 're' as a prefix", () => {
    expect(normalizeReplySubject("Returning my unit")).toEqual({
      normalized: "returning my unit",
      isReply: false,
    })
  })

  it("handles null/empty subjects", () => {
    expect(normalizeReplySubject(null)).toEqual({ normalized: "", isReply: false })
    expect(normalizeReplySubject("Re: ")).toEqual({ normalized: "", isReply: true })
  })
})

// ---------------------------------------------------------------------------
// Integration: real DB, full matcher path.
// ---------------------------------------------------------------------------

const ORG_ID = "00000000-0000-0000-0000-0000000b3000"
const INBOX_ID = "00000000-0000-0000-0000-0000000b3001"
const OTHER_INBOX_ID = "00000000-0000-0000-0000-0000000b3002"
const CONTACT_ID = "00000000-0000-0000-0000-0000000b3003"
const CONTACT_EMAIL = "pascal@customer.test"
const SUBJECT = "acmesound demo ne se relance pas"

const inboxRow = {
  id: INBOX_ID,
  org_id: ORG_ID,
  email_address: "support@b3fallback.test",
} as const

let seq = 0
function replyEmail(overrides: Record<string, unknown> = {}) {
  seq += 1
  return {
    messageId: `<b3-reply-${seq}-${Date.now()}@customer.test>`,
    // References a helpdesk Message-ID that exists in NO stored message —
    // Steps A/B/B2 must all miss.
    inReplyTo: "<legacy-thread@email.freshdesk.test>",
    references: ["<legacy-thread@email.freshdesk.test>"],
    from: { email: CONTACT_EMAIL, name: "Pascal" },
    to: [{ email: "support@b3fallback.test" }],
    cc: [],
    subject: `Re: ${SUBJECT}`,
    textBody: "Merci de votre réponse.",
    htmlBody: null,
    sentAt: new Date().toISOString(),
    headers: {},
    ...overrides,
  } as never
}

async function seedTicket(params: {
  id: string
  subject: string
  contactId?: string | null
  inboxId?: string
  lastMessageAt?: string
}): Promise<void> {
  await withSystemDb("b3-fallback-seed", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO app_tickets.tickets
        (id, org_id, handle, subject, channel, reply_token, sla_target_seconds, sla_deadline,
         status, contact_id, source_inbox_id, last_message_at)
      VALUES
        (${params.id}, ${ORG_ID}, ${`b3-${params.id.slice(-4)}-${seq++}`}, ${params.subject},
         'email', ${`b3tok${params.id.slice(-6)}${seq}`}, 3600, now() + interval '1 day',
         'open', ${params.contactId === undefined ? CONTACT_ID : params.contactId},
         ${params.inboxId ?? INBOX_ID},
         ${params.lastMessageAt ?? new Date().toISOString()})
    `)
  })
}

async function runMatcher(raw: never) {
  return withSystemDb("b3-fallback-run", async (tx) =>
    processInboundMessage(raw, inboxRow as never, { orgId: ORG_ID, db: tx as never }),
  )
}

describe("processInboundMessage — Step B3 contact+subject fallback", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'B3FallbackOrg', 'b3-fallback-org') ON CONFLICT DO NOTHING`
    // The tickets tables are completed from the app's manifest when the app
    // registers (inboxes.default_audience, tickets.audience, the message
    // attribution columns): the migrations alone create an older shape. Register
    // the apps as an org's setup does, so this file does not depend on another
    // file having registered them in the same database first.
    await ensureAppsForOrg(ORG_ID)
    // createTicket (the Step C fallthrough) needs the org's SLA settings.
    const { ticketsSettingsDefaults } = await import("@liaison/shared")
    await sql`
      UPDATE kernel.organizations
      SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('tickets', ${JSON.stringify(ticketsSettingsDefaults)}::jsonb)
      WHERE id = ${ORG_ID}`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email) VALUES (${CONTACT_ID}, ${ORG_ID}, 'b3-pascal', 'Pascal', ${CONTACT_EMAIL}) ON CONFLICT DO NOTHING`
    await sql`
      INSERT INTO app_tickets.inboxes (id, org_id, connected_account_id, name, email_address)
      VALUES (${INBOX_ID}, ${ORG_ID}, gen_random_uuid(), 'B3 Support', 'support@b3fallback.test'),
             (${OTHER_INBOX_ID}, ${ORG_ID}, gen_random_uuid(), 'B3 Other', 'other@b3fallback.test')
      ON CONFLICT DO NOTHING`
  }, 120_000)

  afterAll(async () => {
    await sql`DELETE FROM app_tickets.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.tickets WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM app_tickets.inboxes WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG_ID}`
  })

  it("threads a headerless reply onto the same contact+subject ticket (appended, not created)", async () => {
    const ticketId = "00000000-0000-0000-0000-0000000b3100"
    await seedTicket({ id: ticketId, subject: SUBJECT })

    const result = await runMatcher(replyEmail())
    expect(result).toMatchObject({ outcome: "appended", ticketId })

    const messages = extractRows<{ ticket_id: string }>(
      await sql`SELECT ticket_id FROM app_tickets.messages WHERE org_id = ${ORG_ID} AND ticket_id = ${ticketId}`,
    )
    expect(messages.length).toBe(1)
  })

  it("matches even when the stored subject itself carries a Re: prefix", async () => {
    const ticketId = "00000000-0000-0000-0000-0000000b3101"
    await seedTicket({ id: ticketId, subject: `RE: ${SUBJECT}` })
    // Retire the ticket from the previous test so it can't win on recency.
    await sql`UPDATE app_tickets.tickets SET last_message_at = now() - interval '90 days' WHERE id = '00000000-0000-0000-0000-0000000b3100'`

    const result = await runMatcher(replyEmail())
    expect(result).toMatchObject({ outcome: "appended", ticketId })
  })

  it("creates a NEW ticket when the sender is a different contact", async () => {
    const result = await runMatcher(
      replyEmail({ from: { email: "stranger@elsewhere.test", name: "Stranger" } }),
    )
    expect(result).toMatchObject({ outcome: "created" })
  })

  it("creates a NEW ticket when the subject has no reply prefix", async () => {
    const result = await runMatcher(replyEmail({ subject: SUBJECT }))
    expect(result).toMatchObject({ outcome: "created" })
  })

  it("creates a NEW ticket when the normalized subject is too short to trust", async () => {
    const shortId = "00000000-0000-0000-0000-0000000b3102"
    await seedTicket({ id: shortId, subject: "hello" })
    const result = await runMatcher(replyEmail({ subject: "Re: hello" }))
    expect(result).toMatchObject({ outcome: "created" })
  })

  it("ignores matching tickets whose last activity is outside the 60-day window", async () => {
    const staleId = "00000000-0000-0000-0000-0000000b3103"
    const staleSubject = "pressure calibration drifts on pad 7"
    await seedTicket({
      id: staleId,
      subject: staleSubject,
      lastMessageAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
    })
    const result = await runMatcher(replyEmail({ subject: `Re: ${staleSubject}` }))
    expect(result).toMatchObject({ outcome: "created" })
    expect((result as { ticketId?: string }).ticketId).not.toBe(staleId)
  })

  it("does not cross inboxes: a match on another inbox does not capture the reply", async () => {
    const otherInboxTicket = "00000000-0000-0000-0000-0000000b3104"
    const crossSubject = "midi channel remap question"
    await seedTicket({ id: otherInboxTicket, subject: crossSubject, inboxId: OTHER_INBOX_ID })
    const result = await runMatcher(replyEmail({ subject: `Re: ${crossSubject}` }))
    expect(result).toMatchObject({ outcome: "created" })
    expect((result as { ticketId?: string }).ticketId).not.toBe(otherInboxTicket)
  })

  it("prefers the MOST RECENTLY ACTIVE match when several tickets share the subject", async () => {
    const olderId = "00000000-0000-0000-0000-0000000b3105"
    const newerId = "00000000-0000-0000-0000-0000000b3106"
    const dupSubject = "sustain pedal not detected"
    await seedTicket({
      id: olderId,
      subject: dupSubject,
      lastMessageAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString(),
    })
    await seedTicket({
      id: newerId,
      subject: dupSubject,
      lastMessageAt: new Date(Date.now() - 1 * 24 * 3600 * 1000).toISOString(),
    })
    const result = await runMatcher(replyEmail({ subject: `Re: ${dupSubject}` }))
    expect(result).toMatchObject({ outcome: "appended", ticketId: newerId })
  })

  it("still prefers a real threading-header match over the subject fallback", async () => {
    // Two tickets: the subject-fallback candidate, and a different ticket whose
    // stored message carries the referenced Message-ID. Step B must win.
    const subjectMatchId = "00000000-0000-0000-0000-0000000b3107"
    const headerMatchId = "00000000-0000-0000-0000-0000000b3108"
    const subj = "arpeggiator stuck notes in split mode"
    await seedTicket({ id: subjectMatchId, subject: subj })
    await seedTicket({ id: headerMatchId, subject: "completely different thread" })
    const extId = `<b3-known-${Date.now()}@customer.test>`
    await withSystemDb("b3-fallback-msg-seed", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO app_tickets.messages (id, org_id, ticket_id, kind, external_message_id, sent_at)
        VALUES (gen_random_uuid(), ${ORG_ID}, ${headerMatchId}, 'outbound', ${extId}, now())
      `)
    })
    const result = await runMatcher(
      replyEmail({ subject: `Re: ${subj}`, inReplyTo: extId, references: [extId] }),
    )
    expect(result).toMatchObject({ outcome: "appended", ticketId: headerMatchId })
  })
})
