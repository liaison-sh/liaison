// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared lookup for "every billing document Shopify order X carries."
//
// A credit note now inherits its original invoice's `shopify_order_id`
// (creditNoteCreateAndIssue, mutations.ts) so the one-invoice-per-order guard
// can find it by a scoped query. That inheritance means a plain
// `where: { shopify_order_id }` fetch also returns the order's credit notes,
// which are reversals, not billing documents for the live order. Three
// consumers independently hit this bug (shopify-order-paid.ts,
// shopify-refund-created.ts, shopify-order-updated.ts) before it was
// centralised here — route every consumer that wants only the order's live
// billing documents through this helper instead of re-deriving the filter.
//
// A quote is excluded for the same reason: it is an offer, never a bill, and
// convertViaShopifyDraftOrder (mutations.ts) writes shopify_order_id back onto
// the SOURCE quote once its Shopify draft order completes, so a converted
// quote row carries the same order id the webhook it feeds is about to bill.
//
// Callers that deliberately DO want credit notes included (the
// assertNoLiveInvoiceForOrder guard in mutations.ts, and the
// documents_for_orders read in reads.ts) keep their own query — see the
// comments at those call sites for why.

export interface BillingDocumentsDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      limit?: number
    },
  ): Promise<unknown[]>
}

const DEFAULT_LIMIT = 50

/**
 * Fetch the documents linked to a Shopify order by its top-level
 * `shopify_order_id` column, excluding credit notes (reversals, not bills)
 * and quotes (an offer, never a bill: convertViaShopifyDraftOrder in
 * mutations.ts writes shopify_order_id back onto the SOURCE quote once its
 * Shopify draft order completes, so a converted quote row carries the same
 * order id the webhook it feeds is about to bill). Returns raw rows; callers
 * map them into their own shape.
 */
export async function findBillingDocumentsForOrder(
  db: BillingDocumentsDb,
  shopifyOrderId: string,
  limit: number = DEFAULT_LIMIT,
): Promise<Array<Record<string, unknown>>> {
  const rows = await db.findMany("documents", {
    where: { shopify_order_id: shopifyOrderId },
    limit,
  })
  return (rows as Array<Record<string, unknown>>).filter(
    (r) => r.type !== "credit_note" && r.type !== "quote",
  )
}
