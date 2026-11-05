// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Recipient-based inbox dispatch.
 *
 * Until now one connected mailbox meant one inbox: `loadInboxByAccountId`
 * resolved the sync account's inbox and every message from that sync landed in
 * it (`sync.ts`). That forces one paid mailbox per published address.
 *
 * This module lifts that: several published addresses (Google Groups, Workspace
 * aliases, or any alias/forwarder) can deliver into ONE synced mailbox, and each
 * is routed to its own `kind='api'` inbox — which already carries the per-desk
 * `default_team`, `from_display_name` and `reply_from_email` (the From identity
 * replies go out under, resolved in `tools.ts`). The routing key is that same
 * published address, so the address a customer writes to and the address they
 * get a reply from are the same value, by construction.
 *
 * SAFETY POSTURE — the whole point of this file:
 *
 *   An unrecognised recipient falls back to the SYNC inbox, never to a guess.
 *
 * There is no fuzzy matching, no "closest desk", no domain-only fallback. A
 * misroute here is not a cosmetic bug: it puts one shopping centre's customer
 * in another centre's queue and answers them under the wrong programme's
 * identity. An unrouted ticket in the default inbox with a null team is visible
 * and triageable by a human; a confidently misrouted one is not.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"
import type { ParsedEmail } from "~/lib/email/types"

/** An inbox that can be a dispatch target, plus the fields the ticket inherits. */
export type RoutableInbox = {
  id: string
  org_id: string
  kind?: string | null
  /** Mailbox inboxes only — the synced account's own address. */
  email_address: string | null
  /** API inboxes — the published address this bucket answers for. */
  reply_from_email?: string | null
  default_team?: string | null
  default_audience?: string | null
  default_sensitivity?: "internal" | "confidential" | "restricted" | null
}

export type InboxDispatch = {
  inbox: RoutableInbox
  /** The recipient address that selected this inbox; null when nothing matched. */
  matchedOn: string | null
}

/**
 * The address an inbox answers for. An API bucket's identity is its
 * `reply_from_email` (it has no `email_address` — the schema CHECK forbids it);
 * a mailbox inbox answers for its own address.
 */
export function routingAddressOf(inbox: RoutableInbox): string | null {
  const addr = inbox.reply_from_email?.trim() || inbox.email_address?.trim()
  return addr ? addr.toLowerCase() : null
}

/**
 * Strip sub-addressing before comparing: a reply lands on
 * `passage-du-havre+tkt_abc@…` but the inbox is registered as
 * `passage-du-havre@…`. Note the ticket-token match runs FIRST in the inbound
 * pipeline, so this mostly matters for a customer writing fresh to a
 * plus-address; getting it right costs one line and removes a silent miss.
 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase()
  const at = trimmed.lastIndexOf("@")
  if (at <= 0) return trimmed
  const local = trimmed.slice(0, at)
  const domain = trimmed.slice(at + 1)
  const plus = local.indexOf("+")
  return plus > 0 ? `${local.slice(0, plus)}@${domain}` : trimmed
}

/**
 * Every address this message was addressed to, most-authoritative first.
 *
 * `To` leads because that is where the published address sits in the ordinary
 * case (a customer writing to `best@…`). `Cc` follows. The receiving server's
 * `Delivered-To` comes last, the weakest signal, but the only one present when
 * the published address was BCC'd.
 */
export function collectRecipients(raw: ParsedEmail): string[] {
  const out: string[] = []
  const push = (value: string | undefined | null): void => {
    if (!value) return
    const normalized = normalizeAddress(value)
    if (normalized.includes("@") && !out.includes(normalized)) out.push(normalized)
  }

  for (const a of raw.to ?? []) push(a.email)
  for (const a of raw.cc ?? []) push(a.email)

  // Only the receiving server's own `Delivered-To` (the topmost one) is trusted
  // to say where the provider delivered the message. `X-Original-To`,
  // `X-Forwarded-To` and any further `Delivered-To` lines are copied from the
  // message as the sender wrote it, so a sender could name any published desk
  // address in them and pick which desk, team and reply identity the ticket
  // lands in. With a Google Group or an alias, `Delivered-To` typically names the
  // backing mailbox and only matters when the published address was BCC'd.
  const delivered = raw.deliveredTo?.[0]
  if (delivered) {
    // These headers carry a bare address, but be tolerant of `Name <addr>`.
    const angled = /<([^>]+)>/.exec(String(delivered))
    push(angled?.[1] ?? String(delivered))
  }
  return out
}

/**
 * Pick the inbox this message belongs to.
 *
 * Deterministic: recipients are scanned in authority order and the first one
 * matching a candidate wins, so the same message always routes the same way
 * regardless of candidate ordering. The sync inbox is never a match target —
 * it is the fallback, and matching it would make every message "routed" to the
 * bucket that carries no desk identity.
 */
export function resolveInboxForMessage(
  raw: ParsedEmail,
  syncInbox: RoutableInbox,
  candidates: readonly RoutableInbox[],
): InboxDispatch {
  const byAddress = new Map<string, RoutableInbox>()
  for (const candidate of candidates) {
    if (candidate.id === syncInbox.id) continue
    const address = routingAddressOf(candidate)
    // First registration wins — a duplicated routing address is a config error,
    // and silently preferring the later row would make routing depend on row
    // order. Deterministic beats clever.
    if (address && !byAddress.has(address)) byAddress.set(address, candidate)
  }
  if (byAddress.size === 0) return { inbox: syncInbox, matchedOn: null }

  for (const recipient of collectRecipients(raw)) {
    const hit = byAddress.get(recipient)
    if (hit) return { inbox: hit, matchedOn: recipient }
  }
  return { inbox: syncInbox, matchedOn: null }
}

/**
 * Load the org's live dispatch candidates. Archived inboxes are excluded — an
 * archived desk must stop capturing mail, not keep silently swallowing it.
 */
export async function loadRoutingCandidates(ctx: {
  db: { execute: (q: ReturnType<typeof drizzleSql>) => Promise<unknown> }
  orgId: string
}): Promise<RoutableInbox[]> {
  const rows = await ctx.db.execute(drizzleSql`
    SELECT id, org_id, kind, email_address, reply_from_email,
           default_team, default_audience, default_sensitivity
    FROM ${ticketsRel("inboxes")}
    WHERE org_id = ${ctx.orgId}
      AND archived_at IS NULL
      AND COALESCE(reply_from_email, email_address) IS NOT NULL
  `)
  return extractRows<RoutableInbox>(rows)
}
