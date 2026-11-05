// SPDX-License-Identifier: FSL-1.1-ALv2
import { htmlToText } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { displayHandleOfRow, loadSegmentConfig } from "~/apps/tickets/display-handle"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows } from "~/db"
import type { EnrichmentHelpers } from "~/modules/search/enrichment"
import { registerSearchEnrichment } from "~/modules/search/enrichment"

/**
 * Unified-search enrichment for the `tickets:ticket` searchable entity
 * (§3.1 of the unified-search spec). The manifest doc only ever carried
 * subject + handle, so a customer's name/email or their message text never
 * matched global search — the reproduced "nachumi" gap. This hook builds the
 * extra searchable text that `doc-builder.ts` appends into the document's
 * `body`: the linked contact's name + email, then every message's text,
 * newest-first, truncated to a fixed byte budget.
 *
 * Truncation: Meili's per-attribute position limit makes an oversized body
 * silently unsearchable past the cap, so this caps at 30,000 bytes and orders
 * newest-first — the most likely-relevant text survives the cut.
 */
const BODY_BYTE_BUDGET = 30_000

/** Truncate a string to at most `budget` UTF-8 bytes without splitting a
 * multibyte character mid-sequence. Approximated via `.length` slicing (per
 * the spec's explicit allowance) with a final byte-length check that backs
 * off one character at a time only in the rare case the approximation
 * overshoots (surrogate pairs / multibyte tails). */
function truncateToByteBudget(text: string, budget: number): string {
  if (Buffer.byteLength(text, "utf8") <= budget) return text
  // First pass: character-length slice as a fast approximation (ASCII-heavy
  // support text makes this exact in the overwhelmingly common case).
  let candidate = text.slice(0, budget)
  while (candidate.length > 0 && Buffer.byteLength(candidate, "utf8") > budget) {
    candidate = candidate.slice(0, -1)
  }
  return candidate
}

/**
 * Normalize an email subject to its conversation root: strip reply/forward
 * prefixes (Re:, Fwd:, Fw:, AW:, TR:, SV:, with optional [n] counters),
 * repeatedly, then lowercase and collapse whitespace. "Re: Re: Request to
 * Return ORDER #2936" and "Request to Return ORDER #2936" normalize to the
 * same root, so per-reply ticket fragments of one conversation share a
 * dedupe key.
 */
export function normalizeSubjectRoot(subject: string): string {
  let s = subject.trim()
  const prefix = /^(re|fwd?|aw|tr|sv)(\[\d+\])?\s*:\s*/i
  while (prefix.test(s)) s = s.replace(prefix, "")
  return s.toLowerCase().replace(/\s+/g, " ").trim()
}

/**
 * Conversation-identity dedupe key for a ticket document: same contact + same
 * normalized subject root = same logical conversation, however many ticket
 * rows a mail sync or import fragmented it into. Human-facing search surfaces
 * collapse docs sharing this key to one hit (Meili `distinct`); the inbox
 * id-resolution path deliberately does NOT dedupe (hiding real ticket rows
 * from a work list would hide actionable items). A ticket with no contact or
 * an empty subject gets NO shared key (dedupes with nothing).
 */
export function ticketDedupeKey(row: Record<string, unknown>): string | null {
  const contactId = row.contact_id as string | null | undefined
  const subject = typeof row.subject === "string" ? normalizeSubjectRoot(row.subject) : ""
  if (!contactId || subject.length === 0) return null
  return `tickets:ticket:${contactId}:${subject}`
}

async function buildTicketEnrichmentBody(
  row: Record<string, unknown>,
  helpers: EnrichmentHelpers,
): Promise<string | null> {
  const ticketId = row.id as string | undefined
  const contactId = row.contact_id as string | null | undefined
  const parts: string[] = []

  if (contactId) {
    const contactRow = await helpers.withPrivilegedRead("tickets:search-enrichment:contact", (tx) =>
      tx.execute(drizzleSql`
        SELECT name, email FROM ${kernelRel("contacts")}
        WHERE id = ${contactId} AND org_id = ${helpers.orgId}
        LIMIT 1
      `),
    )
    const contact = extractRows<{ name: string | null; email: string | null }>(contactRow)[0]
    // Deleted/absent contact -> skip silently (bare-UUID cross-schema
    // reference tolerates dangling ids today, same as elsewhere in tickets).
    if (contact) {
      const bits = [contact.name, contact.email].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      )
      if (bits.length > 0) parts.push(bits.join(" "))
    }
  }

  if (ticketId) {
    const messagesRow = await helpers.withPrivilegedRead(
      "tickets:search-enrichment:messages",
      (tx) =>
        tx.execute(drizzleSql`
          SELECT text_body, html_body FROM ${ticketsRel("messages")}
          WHERE ticket_id = ${ticketId} AND org_id = ${helpers.orgId}
          ORDER BY sent_at DESC
        `),
    )
    const messages = extractRows<{ text_body: string | null; html_body: string | null }>(
      messagesRow,
    )
    for (const m of messages) {
      // text_body is the primary source; fall back to html_body stripped of
      // tags ONLY when text_body is null/empty — parity with what a user can
      // actually read (closing the same text_body-only gap the 0019 SQL
      // matcher helper had).
      const text = m.text_body?.trim()
        ? m.text_body
        : m.html_body?.trim()
          ? htmlToText(m.html_body)
          : null
      if (text) parts.push(text)
    }
  }

  if (parts.length === 0) return null
  // Concatenated newest-first: contact identity first (always relevant),
  // then messages in the newest-first order the query already returned.
  return truncateToByteBudget(parts.join("\n"), BODY_BYTE_BUDGET)
}

let registered = false

/**
 * Register the tickets search enrichment hook. Idempotent — safe to call
 * more than once (e.g. across test file reloads); only the first call
 * actually registers. Invoked once at process boot from
 * `infra/boot-phase10.ts`, alongside the other tickets-specific durable
 * consumers/workers, before `registerIndexerConsumer()` so the hook is live
 * before any indexer job that might consult it.
 */
export function registerTicketsSearchEnrichment(): void {
  if (registered) return
  registered = true
  registerSearchEnrichment("tickets", "ticket", async (row, helpers) => {
    const body = await buildTicketEnrichmentBody(row, helpers)
    // The document shows the DISPLAY handle (`ticket-B2B-12`); the stored
    // `ticket-12` joins the body so an old id still finds the ticket.
    const stored = String(row.handle ?? "")
    const display = displayHandleOfRow(row, await loadSegmentConfig(helpers.orgId))
    if (display === stored) return { bodyExtra: body, dedupeKey: ticketDedupeKey(row) }
    return {
      handle: display,
      bodyExtra: [stored, body].filter(Boolean).join("\n"),
      dedupeKey: ticketDedupeKey(row),
    }
  })
}
