// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who a mail conversation is with: the first INBOUND sender that is not one of
// the org's own mailboxes. The conversation's `from_email` is the first
// message's sender, which on a thread we started is our own address; an
// inbound copy of our own mail (a forward, a CC to a shared box) is not the
// external participant either. The server (the agent's customer context) and
// the web (the mail customer card) both answer with this one function, so the
// card and the agent always look up the same person. Tickets have their own
// rule beside it (`ticketParticipantEmail`).

export interface MailParticipantMessage {
  direction: string
  fromEmail: string | null | undefined
  /** Ordering key; messages without one sort after dated ones, in input order. */
  sentAt?: string | Date | null
}

function time(value: string | Date | null | undefined): number {
  if (value === null || value === undefined) return Number.POSITIVE_INFINITY
  const t = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t
}

/** What counts as an address; callers that act on it pass a stricter rule. */
export type AddressRule = (email: string) => boolean

const hasAt: AddressRule = (email) => email.includes("@")

/** The external participant's address (lowercased), or null when there is none. */
export function firstExternalInboundSender(
  messages: readonly MailParticipantMessage[],
  ownAddresses: Iterable<string>,
  isAddress: AddressRule = hasAt,
): string | null {
  const own = new Set<string>()
  for (const a of ownAddresses) if (a) own.add(a.trim().toLowerCase())
  const ordered = messages
    .map((m, i) => ({ m, i, t: time(m.sentAt) }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
  for (const { m } of ordered) {
    if (m.direction !== "inbound") continue
    const email = m.fromEmail?.trim().toLowerCase()
    if (!email || !isAddress(email) || own.has(email)) continue
    return email
  }
  return null
}

export interface TicketParticipantSources {
  /** The ticket's stored requester. */
  requesterEmail: string | null | undefined
  /** The linked contact's address (the contact linked now, after any relink). */
  contactEmail: string | null | undefined
  /** The ticket's inbound messages; `sentAt` carries their received time. */
  inbound: readonly MailParticipantMessage[]
}

/**
 * Who a ticket is with: its requester, else the linked contact's address,
 * else the first inbound sender that is not one of the org's own addresses.
 * The tickets module's own COALESCE (requester_email, contact email, first
 * inbound sender) in this order; the server answers the customer card
 * (`tickets:get` participantEmail) and the agent's customer context with this
 * one function, so both always look up the same person. A candidate the
 * address rule refuses is skipped.
 */
export function ticketParticipantEmail(
  sources: TicketParticipantSources,
  ownAddresses: Iterable<string>,
  isAddress: AddressRule = hasAt,
): string | null {
  for (const candidate of [sources.requesterEmail, sources.contactEmail]) {
    const email = candidate?.trim().toLowerCase()
    if (email && isAddress(email)) return email
  }
  return firstExternalInboundSender(sources.inbound, ownAddresses, isAddress)
}
