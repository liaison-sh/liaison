// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sales an issuer profile knows about, with the buyer identity captured when each was sold.
// A sale is the unit a buyer reads its documents by (the buyer invoices API matches a request to
// sales, never to a document directly): its invoices carry `documents.sale_id`, and its credit
// notes are found through the invoice they correct. A sale paid but not invoiced yet (a review, a
// catch-up, an approval) is a `pending` row with no document.
//
// The identity is written once, from the source, at the moment of the sale: an email (trimmed,
// lower case, nothing else folded) and the strong ids the source holds (a Shopify customer id for
// an order placed with an account, the buyer's user id of a custom checkout). A later edit of the
// contact never changes who a sale belongs to.

import type { IssueDb } from "./issue"

export type SaleState = "pending" | "issued" | "void"

export interface SaleRecord {
  issuer_profile_id: string
  /** `shopify`, `hub`, or the providing app's name. */
  stream: string
  /** Unique within the stream: a Shopify order id, a PaymentIntent id. */
  external_id: string
  /** What the buyer's side calls the sale (`source.ref` of the API). Defaults to external_id. */
  source_ref?: string | null
  /** The human order name ("#3655"), when the source has one. */
  source_name?: string | null
  /** YYYY-MM-DD: the sale date in the issuer's zone. */
  sold_on: string
  buyer: {
    email?: string | null
    shopify_customer_id?: string | null
    hub_user_id?: string | null
  }
  total_minor?: bigint | number | string | null
  currency?: string | null
  state?: SaleState
}

/** The normalised email of a sale or a request: trimmed and lower-cased, nothing else folded. */
export function normaliseBuyerEmail(v: string | null | undefined): string | null {
  const t = (v ?? "").trim().toLowerCase()
  return t === "" ? null : t
}

/** A Shopify customer id as decimal text: a `gid://shopify/Customer/<n>` is cut to its number. */
export function normaliseShopifyCustomerId(v: string | number | null | undefined): string | null {
  if (v == null) return null
  const t = String(v)
    .trim()
    .replace(/^gid:\/\/shopify\/Customer\//, "")
  return /^[0-9]{1,20}$/.test(t) ? t : null
}

function strongOrNull(v: string | null | undefined): string | null {
  const t = (v ?? "").trim()
  return t === "" ? null : t
}

/**
 * Record a sale, or return the one already recorded under the same (issuer, stream, external
 * id). An existing row keeps the identity it was recorded with; only its state, total and
 * currency move forward (pending -> issued, never back).
 */
export async function recordSale(
  db: Pick<IssueDb, "findMany" | "insert" | "update">,
  sale: SaleRecord,
): Promise<{ sale_id: string; created: boolean }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sale.sold_on)) {
    throw new Error(`sold_on "${sale.sold_on}" is not a YYYY-MM-DD date`)
  }
  const key = {
    issuer_profile_id: sale.issuer_profile_id,
    stream: sale.stream,
    external_id: sale.external_id,
  }
  const existing = (await db.findMany("sales", { where: key, limit: 1 })) as Array<
    Record<string, unknown>
  >
  const total = sale.total_minor == null ? null : String(sale.total_minor)
  const row = existing[0]
  if (row) {
    const id = String(row.id)
    const patch: Record<string, unknown> = {}
    if (sale.state && sale.state !== row.state && row.state !== "issued") patch.state = sale.state
    if (total != null && row.total_minor == null) patch.total_minor = total
    if (sale.currency && !row.currency) patch.currency = sale.currency.toUpperCase()
    if (Object.keys(patch).length) await db.update("sales", id, patch)
    return { sale_id: id, created: false }
  }
  const inserted = (await db.insert("sales", {
    ...key,
    source_ref: sale.source_ref ?? sale.external_id,
    source_name: sale.source_name ?? null,
    sold_on: sale.sold_on,
    buyer_email: normaliseBuyerEmail(sale.buyer.email),
    shopify_customer_id: normaliseShopifyCustomerId(sale.buyer.shopify_customer_id),
    hub_user_id: strongOrNull(sale.buyer.hub_user_id),
    total_minor: total,
    currency: sale.currency ? sale.currency.toUpperCase() : null,
    state: sale.state ?? "pending",
  })) as { id?: unknown } | null
  if (!inserted?.id) throw new Error("the sale row was not written")
  return { sale_id: String(inserted.id), created: true }
}

/** Mark the sale issued and point each of its invoices at it. Credit notes need nothing: they
 *  are found through the invoice they correct. */
export async function attachDocumentsToSale(
  db: Pick<IssueDb, "update">,
  saleId: string,
  documentIds: readonly string[],
): Promise<void> {
  for (const id of documentIds) await db.update("documents", id, { sale_id: saleId })
  await db.update("sales", saleId, { state: "issued" })
}
