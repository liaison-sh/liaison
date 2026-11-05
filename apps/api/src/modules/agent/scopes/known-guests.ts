// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Calendar guests the organisation already knows.
//
// Google shows a guest the event, its title and description, in their own calendar even when no
// invitation mail is sent. An agent that invites an address nobody in the organisation has dealt
// with therefore asks for an approval first (host-approval-gates.ts). An address is known when it
// is:
//   - an active member of the organisation;
//   - a saved contact;
//   - the requester or a participant of one of the organisation's tickets;
//   - on a mail thread the organisation took part in (one of its mailboxes sent a message there);
//   - a contact or domain staff marked trusted (kernel.trusted_senders, never a public mail
//     provider's domain).
//
// Fails closed: an address the checks cannot establish is unknown.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { trustedAmong } from "~/modules/contacts/trusted-senders"

/** The addresses in an attendee list (strings or `{ email }`), lower-cased; null when malformed. */
export function attendeeAddresses(value: unknown): string[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    const email =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? (item as { email?: unknown }).email
          : undefined
    if (typeof email !== "string") return null
    const e = email.trim().toLowerCase()
    if (e && !out.includes(e)) out.push(e)
  }
  return out
}

/** The attendees an existing event already has (by our id or Google's); [] when not found. */
async function storedAttendees(orgId: string, eventId: unknown): Promise<string[]> {
  if (typeof eventId !== "string" || !eventId) return []
  const c = drizzleSql.raw(schemaRef("app_calendar"))
  const rows = await withPrivilegedDb(orgId, "known-guests-event", async (tx) => {
    const [exists] = extractRows<{ t: string | null }>(
      await tx.execute(
        drizzleSql`SELECT to_regclass(${`${schemaRef("app_calendar")}.events`}) AS t`,
      ),
    )
    if (!exists?.t) return []
    return extractRows<{ attendees: unknown }>(
      await tx.execute(drizzleSql`
        SELECT attendees FROM ${c}.events
        WHERE org_id = ${orgId}::uuid AND (id::text = ${eventId} OR google_event_id = ${eventId})
        LIMIT 1`),
    )
  })
  return attendeeAddresses(rows[0]?.attendees) ?? []
}

/** Which of these addresses the organisation knows (see the list at the top of this file). */
export async function knownAddresses(orgId: string, addresses: string[]): Promise<Set<string>> {
  const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))]
  if (wanted.length === 0) return new Set()
  const k = drizzleSql.raw(schemaRef("kernel"))
  const tickets = `${schemaRef("app_tickets")}.tickets`
  const mailMessages = `${schemaRef("app_mail")}.messages`
  const rows = await withPrivilegedDb(orgId, "known-guests", async (tx) => {
    const [present] = extractRows<{ tickets: string | null; mail: string | null }>(
      await tx.execute(
        drizzleSql`SELECT to_regclass(${tickets}) AS tickets, to_regclass(${mailMessages}) AS mail`,
      ),
    )
    const list = drizzleSql`ARRAY[${drizzleSql.join(
      wanted.map((e) => drizzleSql`${e}`),
      drizzleSql`, `,
    )}]::text[]`
    const ticketClause = present?.tickets
      ? drizzleSql`OR EXISTS (
          SELECT 1 FROM ${drizzleSql.raw(tickets)} t
          WHERE t.org_id = ${orgId}::uuid
            AND (lower(t.requester_email) = a.email
              OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(t.participant_emails) p
                         WHERE lower(p) = a.email)))`
      : drizzleSql``
    // A mail thread counts when one of the org's mailboxes wrote in it: an address that only ever
    // wrote TO the organisation is a stranger the organisation never answered.
    const mailClause = present?.mail
      ? drizzleSql`OR EXISTS (
          SELECT 1 FROM ${drizzleSql.raw(mailMessages)} m
          WHERE m.org_id = ${orgId}::uuid
            AND (lower(m.from_address->>'email') = a.email
              OR EXISTS (SELECT 1 FROM jsonb_array_elements(
                           CASE WHEN jsonb_typeof(m.to_addresses) = 'array' THEN m.to_addresses ELSE '[]'::jsonb END
                           || CASE WHEN jsonb_typeof(m.cc_addresses) = 'array' THEN m.cc_addresses ELSE '[]'::jsonb END) r
                         WHERE lower(r->>'email') = a.email))
            AND EXISTS (SELECT 1 FROM ${drizzleSql.raw(mailMessages)} o
                        WHERE o.org_id = m.org_id AND o.conversation_id = m.conversation_id
                          AND o.direction = 'outbound'))`
      : drizzleSql``
    return extractRows<{ email: string }>(
      await tx.execute(drizzleSql`
        SELECT a.email FROM unnest(${list}) AS a(email)
        WHERE EXISTS (SELECT 1 FROM ${k}.users u
                      WHERE u.org_id = ${orgId}::uuid AND u.status = 'active'
                        AND lower(u.email) = a.email)
           OR EXISTS (SELECT 1 FROM ${k}.contacts c
                      WHERE c.org_id = ${orgId}::uuid AND lower(c.email) = a.email)
           ${ticketClause}
           ${mailClause}`),
    )
  })
  const known = new Set(rows.map((r) => r.email))
  const rest = wanted.filter((a) => !known.has(a))
  for (const a of await trustedAmong(orgId, rest)) known.add(a)
  return known
}

/**
 * The guests a calendar write invites that the organisation does not know. A new event invites
 * every attendee it names; an edit invites only the addresses it adds (one already on the event is
 * not a new invitation, and an edit that leaves the guest list alone invites nobody). Null when
 * the attendee list is malformed: the caller then asks for approval.
 */
export async function unknownInvitedGuests(
  toolName: string,
  params: unknown,
  orgId: string,
): Promise<string[] | null> {
  const p = (params ?? {}) as { attendees?: unknown; eventId?: unknown }
  const named = attendeeAddresses(p.attendees)
  if (named === null) return null
  let invited = named
  if (toolName === "calendar:update_event") {
    if (p.attendees === undefined || p.attendees === null) return []
    const before = new Set(await storedAttendees(orgId, p.eventId))
    invited = named.filter((a) => !before.has(a))
  }
  if (invited.length === 0) return []
  const known = await knownAddresses(orgId, invited)
  return invited.filter((a) => !known.has(a))
}
