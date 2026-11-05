// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who a ticket is FOR.
//
// A ticket stores its requester (the person it was opened for) and a list of
// participants (addresses the requester copied in). Replies go to them, and
// only they may join the thread through a weak matching key (a subject handle
// such as `[#ticket-12]`, a contact + subject match, or the form API's external
// reference). Anyone else who names the handle is a stranger: their message
// opens a NEW ticket linked to the old one. The newest sender, and the
// sender-controlled Date header, decide nothing.

import { isStrictEmail } from "@liaison/api-connector-core/contract"
import { ticketParticipantEmail } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { SenderAuth } from "~/lib/email/sender-auth"

type Executor = { execute: (query: ReturnType<typeof drizzleSql>) => Promise<unknown> }

/** Upper bound on stored participants per ticket. */
export const MAX_TICKET_PARTICIPANTS = 20

export type TicketParties = {
  requester: string | null
  participants: string[]
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase()
  return e?.includes("@") ? e : null
}

function asAddressList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) {
    const e = normalizeEmail(typeof v === "string" ? v : undefined)
    if (e && !out.includes(e)) out.push(e)
  }
  return out
}

/**
 * The stored requester and participants of a ticket. A ticket from before the
 * requester column existed (or one created without it) falls back to the
 * sender of its EARLIEST inbound message by received time: the person who
 * opened it, never the newest sender.
 */
export async function loadTicketParties(
  db: Executor,
  orgId: string,
  ticketId: string,
): Promise<TicketParties> {
  const rows = extractRows<{
    requester_email: string | null
    participant_emails: unknown
    first_sender: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT t.requester_email, t.participant_emails,
        (SELECT m.from_email FROM ${ticketsRel("messages")} m
          WHERE m.org_id = t.org_id AND m.ticket_id = t.id AND m.kind = 'inbound'
            AND m.from_email IS NOT NULL AND m.from_email <> ''
          ORDER BY m.received_at ASC, m.id ASC LIMIT 1) AS first_sender
      FROM ${ticketsRel("tickets")} t
      WHERE t.id = ${ticketId} AND t.org_id = ${orgId}
      LIMIT 1
    `),
  )
  const row = rows[0]
  if (!row) return { requester: null, participants: [] }
  const requester = normalizeEmail(row.requester_email) ?? normalizeEmail(row.first_sender)
  const participants = asAddressList(row.participant_emails).filter((p) => p !== requester)
  return { requester, participants }
}

/** Whether `email` is the requester or a participant of the ticket. */
export function isTicketParty(parties: TicketParties, email: string | null | undefined): boolean {
  const e = normalizeEmail(email)
  if (!e) return false
  return e === parties.requester || parties.participants.includes(e)
}

/** Every address the org's ticket inboxes send or receive as, lowercased. */
async function ownInboxAddresses(db: Executor, orgId: string): Promise<Set<string>> {
  const rows = extractRows<{
    email_address: string | null
    reply_from_email: string | null
    reply_to_email: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT email_address, reply_from_email, reply_to_email
      FROM ${ticketsRel("inboxes")} WHERE org_id = ${orgId}
    `),
  )
  const out = new Set<string>()
  for (const r of rows) {
    for (const a of [r.email_address, r.reply_from_email, r.reply_to_email]) {
      const e = normalizeEmail(a)
      if (e) out.add(e)
    }
  }
  return out
}

/** Inbound messages the participant rule looks at, earliest received first. */
const PARTICIPANT_INBOUND_LIMIT = 50

/**
 * Who a ticket is WITH, for the customer card (`tickets:get`
 * `participantEmail`) and the agent's customer context: the requester, else
 * the linked contact's address, else the first inbound sender (by received
 * time) that is not one of the org's inboxes (`ticketParticipantEmail`). Only
 * a plain addr-spec is ever returned. The ticket, its contact and its
 * messages are read with the caller's handle: under the actor's RLS, a ticket
 * or contact the actor cannot see yields nothing.
 */
export async function loadTicketParticipantEmail(
  db: Executor,
  orgId: string,
  ticketId: string,
): Promise<string | null> {
  const [ticket] = extractRows<{ requester_email: string | null; contact_email: string | null }>(
    await db.execute(drizzleSql`
      SELECT t.requester_email, ct.email AS contact_email
      FROM ${ticketsRel("tickets")} t
      LEFT JOIN ${kernelRel("contacts")} ct ON ct.id = t.contact_id AND ct.org_id = t.org_id
      WHERE t.id = ${ticketId} AND t.org_id = ${orgId}
      LIMIT 1
    `),
  )
  if (!ticket) return null
  const inbound = extractRows<{ from_email: string | null; received_at: string | Date | null }>(
    await db.execute(drizzleSql`
      SELECT m.from_email, m.received_at FROM ${ticketsRel("messages")} m
      WHERE m.org_id = ${orgId} AND m.ticket_id = ${ticketId} AND m.kind = 'inbound'
        AND m.from_email IS NOT NULL AND m.from_email <> ''
      ORDER BY m.received_at ASC, m.id ASC
      LIMIT ${PARTICIPANT_INBOUND_LIMIT}
    `),
  )
  return ticketParticipantEmail(
    {
      requesterEmail: ticket.requester_email,
      contactEmail: ticket.contact_email,
      inbound: inbound.map((m) => ({
        direction: "inbound",
        fromEmail: m.from_email,
        sentAt: m.received_at,
      })),
    },
    // The org's own inbox addresses are configuration, read whole whatever the
    // caller may see: they only exclude, never reveal.
    await withPrivilegedDb(orgId, "tickets-participant-own-inboxes", (tx) =>
      ownInboxAddresses(tx, orgId),
    ),
    isStrictEmail,
  )
}

/**
 * Record the addresses a trusted sender copied in (To and Cc, minus our own
 * mailboxes). No-op unless `sender` is already the requester or a participant
 * AND the receiving provider authenticated the sender: a forged From of the
 * requester must not be able to copy an outsider into every later reply.
 */
export async function addParticipantsFromTrustedSender(
  db: Executor,
  orgId: string,
  ticketId: string,
  sender: string | null | undefined,
  senderAuth: SenderAuth,
  candidates: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  if (senderAuth !== "pass") return
  const parties = await loadTicketParties(db, orgId, ticketId)
  if (!isTicketParty(parties, sender)) return
  const own = await ownInboxAddresses(db, orgId)
  const add: string[] = []
  for (const c of candidates) {
    const e = normalizeEmail(c)
    if (!e || own.has(e) || e.includes("+tkt_")) continue
    if (e === parties.requester || parties.participants.includes(e) || add.includes(e)) continue
    add.push(e)
  }
  if (add.length === 0) return
  const next = [...parties.participants, ...add].slice(0, MAX_TICKET_PARTICIPANTS)
  if (next.length === parties.participants.length) return
  await db.execute(drizzleSql`
    UPDATE ${ticketsRel("tickets")}
    SET participant_emails = ${JSON.stringify(next)}::jsonb, updated_at = now()
    WHERE id = ${ticketId} AND org_id = ${orgId}
  `)
}

/**
 * An internal note on a NEW ticket saying why it exists next to an earlier one:
 * a stranger named the earlier ticket's reference, so they were not let into
 * its thread. Never part of what a customer is sent.
 */
export async function recordRelatedTicketNote(
  db: Executor,
  orgId: string,
  ticketId: string,
  reference: string,
): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO ${ticketsRel("messages")} (
      id, org_id, ticket_id, kind, text_body, snippet, sent_at, created_at, updated_at
    ) VALUES (
      gen_random_uuid(), ${orgId}, ${ticketId}, 'note',
      ${`This message named ${reference} but its sender is not the requester or a participant of that ticket, so it was opened as a new ticket instead of joining that conversation. Nothing from the earlier ticket was shared with the sender.`},
      ${`Referenced ${reference}; opened as a new ticket.`},
      now(), now(), now()
    )
  `)
}
