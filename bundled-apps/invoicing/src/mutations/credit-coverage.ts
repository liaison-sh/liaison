// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: credit note coverage and the one-invoice-per-order guard.

import { formatMoneyMinor } from "../money"
import { type MutationsDb, toBigInt } from "./shared"

// ── Credit note coverage (one-invoice-per-order guard) ─────────────────────
//
// Shared by draftsCreate and invoiceCreateAndIssue (assertNoLiveInvoiceForOrder, below) so the
// two never carry their own drifting copy again — invoiceCreateAndIssue used to keep a stale
// duplicate that blocked on ANY existing document for the order, credit noted or not.
//
// An issued invoice that has since been fully credit noted must stop holding the
// one-invoice-per-order guard: the correct flow for a modified/cancelled Shopify
// order is credit note the original, then issue a NEW invoice with the updated
// items, and the old guard blocked exactly that ("already_invoiced") because it
// counted ANY existing row for the order, credited or not.
//
// Resolved as the UNION of two sources: the invoice's OWN lifecycle_log
// `credit_note_issued` entries (each carrying the credit note's id, fetched by
// id — cheap, exact, never a table scan), and any document of type credit_note
// whose `external_refs.original_document_id` back-links to the invoice. The
// lifecycle_log alone is not durable enough: an invoice credit noted before
// this union existed, or a crash between creditNoteCreateAndIssue issuing the
// credit note and its SEPARATE write of the invoice's lifecycle_log, both leave
// the marker missing while a real credit note exists — which would otherwise
// block that order's replacement invoice forever. The back-link candidates are
// never fetched with their own query: callers pass in the same document set
// they already loaded scoped by shopify_order_id (a credit note issued against
// an order-linked invoice inherits that order's shopify_order_id — see
// creditNoteCreateAndIssue), so this stays a lookup over rows already in hand,
// never an unbounded scan. A DRAFT credit note never counts, only an issued one.

/** Sum, in minor units (absolute value), the ISSUED credit notes that reverse `invoiceRow`.
 *  `candidateDocs`, when given, is scanned for credit notes whose
 *  `external_refs.original_document_id` equals `invoiceRow.id` — the durable-link fallback for a
 *  missing/lost lifecycle_log marker (see the comment above). Callers pass the document set they
 *  already fetched for the order; this never issues its own query for that lookup. */
export async function creditedTotalMinor(
  db: Pick<MutationsDb, "findOne">,
  invoiceRow: { id?: string; lifecycle_log: Array<Record<string, unknown>> },
  candidateDocs?: Array<Record<string, unknown>>,
): Promise<bigint> {
  const creditNoteIds = new Set<string>()
  for (const entry of invoiceRow.lifecycle_log) {
    if (String(entry.event ?? "") !== "credit_note_issued") continue
    const id = entry.credit_note_id
    if (typeof id === "string" && id) creditNoteIds.add(id)
  }
  if (invoiceRow.id && candidateDocs) {
    for (const doc of candidateDocs) {
      if (doc.type !== "credit_note") continue
      const refs = (doc.external_refs as Record<string, unknown> | undefined) ?? {}
      // The column is the link; external_refs carries it for rows written before the column.
      if ((doc.original_document_id ?? refs.original_document_id) === invoiceRow.id) {
        creditNoteIds.add(String(doc.id))
      }
    }
  }
  // Resolve each credit note from `candidateDocs` FIRST — the set the caller already fetched for
  // the order in ONE query — and only fall back to a per-id `findOne` for an id genuinely NOT in
  // that set. A credit note issued against an order-linked invoice always inherits that invoice's
  // shopify_order_id (creditNoteCreateAndIssue), so in the ordinary case it is always already in
  // candidateDocs and this loop issues ZERO extra queries. Before, every credit note id hit its
  // own `findOne` unconditionally, widening the pre-existing concurrent-request race window on
  // shopify_order_id (assertNoLiveInvoiceForOrder) by one extra read per credit note on the order;
  // now the window only opens for an id the candidate set genuinely does not carry.
  const byId = new Map<string, Record<string, unknown>>()
  for (const doc of candidateDocs ?? []) {
    byId.set(String(doc.id), doc)
  }
  let total = 0n
  for (const id of creditNoteIds) {
    const row =
      byId.get(id) ?? ((await db.findOne("documents", id)) as Record<string, unknown> | null)
    if (!row) continue
    if (row.type !== "credit_note") continue
    if (String(row.status ?? "draft") === "draft") continue
    const grand = toBigInt(row.grand_total_minor)
    total += grand < 0n ? -grand : grand
  }
  return total
}

// EXPLICIT allowlist of invoice statuses that mean "genuinely issued, sent to the customer" — see
// state.ts TABLE for the real invoice transition graph. "draft" and "pending_approval" were never
// sent to the customer; "voided"/"cancelled" are already dead. Gating a credit note on
// `status !== "draft"` (the old check) let a `pending_approval` invoice through, so a caller could
// credit-note a document nobody had actually sent yet. Shared by creditNoteCreateAndIssue (below)
// and onShopifyOrderCancelled so no caller can issue a credit note against a non-issued document.
// `fulfilled` is an issued, paid Shopify invoice whose order shipped (reconcile-shopify-payments.ts):
// it is credited, cancelled and reissued like a paid one.
export const ISSUED_INVOICE_STATUSES: ReadonlySet<string> = new Set([
  "issued",
  "fulfilled",
  "paid",
  "overdue",
  "refunded",
])

/** True once `invoiceRow`'s issued credit notes (lifecycle_log union back-link, see
 *  `creditedTotalMinor`) cover its full grand total (absolute value). */
export async function isFullyCredited(
  db: Pick<MutationsDb, "findOne">,
  invoiceRow: {
    id?: string
    lifecycle_log: Array<Record<string, unknown>>
    grand_total_minor: bigint
  },
  candidateDocs?: Array<Record<string, unknown>>,
): Promise<boolean> {
  const credited = await creditedTotalMinor(db, invoiceRow, candidateDocs)
  const invoiceTotal =
    invoiceRow.grand_total_minor < 0n ? -invoiceRow.grand_total_minor : invoiceRow.grand_total_minor
  return credited >= invoiceTotal
}

/** The invoice's issued credit notes, by their back-link: the candidates `creditedTotalMinor` reads. */
export async function creditNotesOf(
  db: Pick<MutationsDb, "findMany">,
  invoiceId: string,
): Promise<Array<Record<string, unknown>>> {
  return (await db.findMany("documents", {
    where: { original_document_id: invoiceId, type: "credit_note" },
    limit: 200,
  })) as Array<Record<string, unknown>>
}

/** Invoice statuses that can still be owed: one paid (and perhaps partly refunded) is not. */
const OWED_STATUSES = new Set(["issued", "overdue"])

/**
 * After a credit note against `invoiceId` issued: an invoice its issued credit notes now cover in
 * full is settled (`payment_status: "credited"`), so it is never overdue, chased or offered to mark
 * as paid. A partial credit leaves the invoice owed; what is due is its total less the credits
 * (the overdue scan says so). An invoice already paid or refunded is left as it is: what the customer is
 * owed back is the credit note's business. Returns the credited total and the amount still due.
 */
export async function settleAfterCredit(
  db: Pick<MutationsDb, "findOne" | "findMany" | "update">,
  invoiceId: string,
  actor: string | null,
  at: Date = new Date(),
): Promise<{ credited: bigint; due: bigint; settled: boolean } | null> {
  const [doc] = (await db.findMany("documents", { where: { id: invoiceId }, limit: 1 })) as Array<
    Record<string, unknown>
  >
  if (!doc || doc.type !== "invoice") return null
  // Only an invoice still owed is settled by a credit: one paid already is the credit note's own
  // business (what the customer is owed back), and is left as it is, before any other read.
  const owed =
    String(doc.payment_status ?? "unpaid") === "unpaid" && OWED_STATUSES.has(String(doc.status))
  if (!owed) return null
  const log = (Array.isArray(doc.lifecycle_log) ? doc.lifecycle_log : []) as Array<
    Record<string, unknown>
  >
  const credited = await creditedTotalMinor(
    db,
    { id: invoiceId, lifecycle_log: log },
    await creditNotesOf(db, invoiceId),
  )
  const grand = toBigInt(doc.grand_total_minor)
  const total = grand < 0n ? -grand : grand
  const due = credited >= total ? 0n : total - credited
  if (total === 0n || due > 0n) return { credited, due, settled: false }
  await db.update("documents", invoiceId, {
    payment_status: "credited",
    lifecycle_log: [
      ...log,
      {
        event: "settled_by_credit_note",
        actor,
        ts: at.toISOString(),
        credited_minor: credited.toString(),
      },
    ],
  })
  return { credited, due, settled: true }
}

/**
 * The one-invoice-per-order guard, shared by draftsCreate and invoiceCreateAndIssue so the two
 * can never drift apart again. Ignores credit note documents for the order, ignores a fully
 * credited invoice (see isFullyCredited/creditedTotalMinor above for the union rule), and blocks
 * on a live invoice (naming the remaining amount when it is only partially credited) or an
 * existing draft. Throws an Error whose message starts "already_invoiced: " when blocked;
 * callers translate that into their own return shape (draftsCreate lets it propagate, invoiceCreateAndIssue
 * catches it into a typed error result).
 */
export async function assertNoLiveInvoiceForOrder(
  db: Pick<MutationsDb, "findMany" | "findOne">,
  shopifyOrderId: string,
  opts: {
    /** An issued invoice that a credit note committed together with the new invoice fully
     *  reverses (order_reissue_apply): it is skipped, as it would be once credited. */
    creditedInSameCommit?: string
  } = {},
): Promise<void> {
  const existing = (await db.findMany("documents", {
    where: { shopify_order_id: shopifyOrderId },
    limit: 20,
  })) as Array<Record<string, unknown>>
  for (const dup of existing) {
    // A credit note carrying the same order id is a reversal, not a duplicate invoice: it
    // must never block a new one.
    if (dup.type === "credit_note") continue
    const status = String(dup.status ?? "draft")
    if (
      opts.creditedInSameCommit &&
      String(dup.id) === opts.creditedInSameCommit &&
      status !== "draft"
    ) {
      continue
    }
    const label = dup.number
      ? `${String(dup.id)} / ${String(dup.number)}`
      : `${String(dup.id)}, still a draft`
    if (status === "draft") {
      throw new Error(
        `already_invoiced: Shopify order ${shopifyOrderId} already has an invoice ` +
          `(document ${label}). ` +
          `One invoice per order: do NOT create another for this order (that would double bill the customer). ` +
          `If you need to change it, edit or discard the existing draft.`,
      )
    }
    // A live (issued/paid/pending_approval/refunded) invoice only blocks while it still holds
    // an uncredited balance: once its issued credit notes cover the full total, the order is
    // free for a replacement invoice (credit note, then reissue is the correct modify flow).
    const invoiceId = String(dup.id)
    const lifecycle = (dup.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
    const invoiceTotal = toBigInt(dup.grand_total_minor)
    const fullyCredited = await isFullyCredited(
      db,
      { id: invoiceId, lifecycle_log: lifecycle, grand_total_minor: invoiceTotal },
      existing,
    )
    if (fullyCredited) continue
    const credited = await creditedTotalMinor(
      db,
      { id: invoiceId, lifecycle_log: lifecycle },
      existing,
    )
    const currency = String(dup.currency ?? "EUR")
    const absTotal = invoiceTotal < 0n ? -invoiceTotal : invoiceTotal
    const partialNote =
      credited > 0n
        ? ` that is only partially credit noted: ${formatMoneyMinor(absTotal - credited, currency)} of ${formatMoneyMinor(absTotal, currency)} still stands`
        : ""
    throw new Error(
      `already_invoiced: Shopify order ${shopifyOrderId} already has an invoice ` +
        `(document ${label})${partialNote}. ` +
        `One invoice per order: do NOT create another for this order (that would double bill the customer). ` +
        `To change it, credit note the existing invoice and reissue with the updated items, ` +
        `or edit or discard the existing draft.`,
    )
  }
}
