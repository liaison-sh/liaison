// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The marker that lets the mailbox sync recognise Liaison's OWN outbound mail
// coming back at it.
//
// The ticket mailbox sync deliberately lists the WHOLE mailbox (`q: after:<ts>`,
// no `in:inbox` filter) so nothing is missed, which means every reply we send
// is also seen again as a Sent copy and classified `outbound`. The only dedupe
// key was an exact `external_message_id` match, and Gmail REWRITES the
// `Message-ID` we render — so the stored id never equalled the delivered one and
// every outbound reply was stored twice. Prod, org-wide, from 2026-07-27:
// duplicate outbound rows tracked the sent count exactly (12/12, 24/24, 3/3).
//
// Reading the delivered `Message-ID` back after sending (see
// `GmailSendResult.rfc822MessageId`) fixes the key itself and is the primary
// defence. This marker is the second one, and it is deterministic rather than
// heuristic: a custom `X-` header survives Gmail's rewriting, so a synced
// message carrying it is provably a copy of mail WE sent through the tickets
// app. That beats the obvious alternative of matching on a body hash inside a
// time window, which would silently drop a genuine second identical reply.
//
// Safe to drop unconditionally because the send path always records the message
// itself: `sendOutbound` runs first and `insertOutboundMessage` immediately
// after, in the same handler. Mail sent by a human directly from the mailbox
// carries no marker and is still ingested as outbound, which is correct.

import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "~/lib/env"

/** Header stamped on every ticket email we send. Value: `<ticket id>.<mac>`. */
export const SELF_SEND_HEADER = "X-Liaison-Ticket"

function macFor(ticketId: string): string {
  return createHmac("sha256", env.JWT_SECRET)
    .update(`liaison:self-send-marker:v1:${ticketId}`)
    .digest("hex")
    .slice(0, 32)
}

/**
 * The marker value for a ticket's outbound mail: the ticket id and a keyed MAC
 * of it. A bare header would let any sender silence their own mail (or someone
 * else's) by adding it; only mail we sent carries a valid MAC.
 */
export function selfSendMarkerFor(ticketId: string): string {
  return `${ticketId}.${macFor(ticketId)}`
}

/**
 * True when a parsed message carries our marker with a valid MAC, i.e. it is our own Sent copy
 * being re-ingested. Header lookup is case-insensitive: MIME header names are
 * case-insensitive and providers normalise them differently.
 */
export function isSelfSendEcho(headers: Record<string, string | string[]> | undefined): boolean {
  if (!headers) return false
  const wanted = SELF_SEND_HEADER.toLowerCase()
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first !== "string") continue
    const dot = first.trim().lastIndexOf(".")
    if (dot <= 0) continue
    const id = first.trim().slice(0, dot)
    const mac = Buffer.from(first.trim().slice(dot + 1))
    const expected = Buffer.from(macFor(id))
    if (mac.length === expected.length && timingSafeEqual(mac, expected)) return true
  }
  return false
}
