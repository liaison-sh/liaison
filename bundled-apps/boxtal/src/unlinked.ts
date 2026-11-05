// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Orders that are shippable but INVISIBLE to the prep worklist.
//
// The To-prepare worklist is derived from ISSUED GOODS INVOICES carrying a
// shopify_order_id (see queues.ts toPrepareList -> worklistCandidates /
// orders.ts openOrdersScan). That is one
// row source and only one, so an unfulfilled order with no invoice cannot
// produce a row of ANY state: not ready, not needs_fix, not even an excluded
// line. It is structurally absent, with no counter and no reason shown
// (a dealer's B2B order on payment terms sat
// unshippable and unseen because auto-invoicing fires on PAYMENT and a
// terms customer never reaches `PAID`).
//
// This module is the missing counter-check, deliberately kept OUTSIDE the row
// pipeline. It does NOT synthesise PrepRows: every downstream tool
// (shipment_draft_*, prep_select_offer, create_shipment) keys on a real
// `document_ref`, so a row without one would be a control the operator can
// press and nothing can act on. Instead it answers one question honestly --
// "what is shippable that this worklist cannot show you?" -- and names the
// action that would bring each order in.

import type { BoxtalToolCtx } from "./ctx"

/** Cap on the Shopify scan. Well above any realistic unfulfilled backlog. */
const SCAN_LIMIT = 250

export interface UnlinkedOrderRow {
  /** Numeric Shopify order id (what invoicing links documents by). */
  order_id: string
  /** Human order name, e.g. "#3362" -- the reference everyone actually quotes. */
  order_name: string | null
  customer: string
  destination: string | null
  placed_at: string | null
  financial_status: string | null
  tags: string[]
  /** Why this order cannot appear in the worklist. */
  reason: string
  /** The concrete thing that would bring it in. */
  action: string
}

export interface UnlinkedOrdersResult {
  rows: UnlinkedOrderRow[]
  /** How many shippable orders the worklist cannot show. The number worth a badge. */
  total: number
  /** True when the Shopify scan hit its cap, so `total` is a floor, not a count. */
  truncated: boolean
  checked_at: string
}

interface ShopifyOrderish {
  id?: string
  name?: string
  attributes?: {
    financialStatus?: string | null
    fulfillmentStatus?: string | null
    cancelledAt?: string | null
    createdAt?: string | null
    tags?: string[] | null
    customer?: { displayName?: string | null } | null
    shippingAddress?: { countryCode?: string | null; country?: string | null } | null
    totalPrice?: string | null
  } | null
}

/** Numeric id out of a gid or a bare number; null when neither. */
function numericOrderId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw)
  if (typeof raw !== "string" || raw === "") return null
  const m = raw.match(/(\d+)\s*$/)
  return m ? m[1]! : null
}

/**
 * Shippable orders the worklist cannot show.
 *
 * Two subtractions, in this order, because they answer different questions:
 *   1. `prep_meta` -- orders the worklist ALREADY knows about. Cheap, local,
 *      and covers everything that has ever been synced (including rows the
 *      operator excluded, which are known, not missing).
 *   2. `invoicing:documents_for_orders` on whatever survives -- the
 *      AUTHORITATIVE "does an invoice exist" check. Without it a freshly
 *      invoiced order that has not been prep_synced yet would be reported as
 *      missing, which would train the operator to ignore this list.
 */
export async function unlinkedOrdersList(
  ctx: BoxtalToolCtx,
  input: { limit?: number } = {},
): Promise<UnlinkedOrdersResult> {
  const checked_at = new Date().toISOString()
  const limit = Math.max(1, Math.min(input.limit ?? SCAN_LIMIT, SCAN_LIMIT))

  const env = await ctx.executeTool("shopify:orders_search", {
    query: "fulfillment_status:unfulfilled",
    limit,
  })
  if (env.status !== "completed" || env.result == null) {
    // Fail SOFT: a Shopify outage must not break the worklist this hangs off.
    // Reporting zero would be a lie, so say the check did not run.
    return { rows: [], total: 0, truncated: false, checked_at }
  }
  const raw = env.result as { results?: ShopifyOrderish[] } | ShopifyOrderish[]
  const orders: ShopifyOrderish[] = Array.isArray(raw) ? raw : (raw.results ?? [])

  // A cancelled order is not shipping work. Mirrors order-shippability.ts, which
  // the row pipeline already applies -- this list must not be laxer than the
  // worklist it complements, or it becomes a source of phantom work.
  const live = orders.filter((o) => !o.attributes?.cancelledAt)

  const byId = new Map<string, ShopifyOrderish>()
  for (const o of live) {
    const id = numericOrderId(o.id)
    if (id) byId.set(id, o)
  }
  if (byId.size === 0) {
    return { rows: [], total: 0, truncated: orders.length >= limit, checked_at }
  }

  // 1. Everything the worklist already knows about.
  const metaRows = (await ctx.db.findMany("prep_meta", { limit: 2000 })) as Array<{
    shopify_order_id?: string | null
  }>
  const known = new Set<string>()
  for (const m of metaRows) {
    const id = numericOrderId(m.shopify_order_id)
    if (id) known.add(id)
  }
  const candidates = [...byId.keys()].filter((id) => !known.has(id))
  if (candidates.length === 0) {
    return { rows: [], total: 0, truncated: orders.length >= limit, checked_at }
  }

  // 2. Authoritative invoice check on what is left.
  let invoiced = new Set<string>()
  const docEnv = await ctx.executeTool("invoicing:documents_for_orders", {
    shopify_order_ids: candidates,
  })
  if (docEnv.status === "completed" && docEnv.result != null) {
    const res = docEnv.result as { links?: Array<{ shopify_order_id?: string | number | null }> }
    invoiced = new Set(
      (res.links ?? [])
        .map((l) => numericOrderId(l.shopify_order_id))
        .filter((v): v is string => v !== null),
    )
  } else {
    // Invoicing unreachable: we cannot prove an invoice is absent, and claiming
    // "no invoice issued" on an order that has one would send the operator to
    // create a duplicate. Report nothing rather than something wrong.
    return { rows: [], total: 0, truncated: orders.length >= limit, checked_at }
  }

  const rows: UnlinkedOrderRow[] = []
  for (const id of candidates) {
    if (invoiced.has(id)) continue
    const o = byId.get(id)!
    const a = o.attributes ?? {}
    rows.push({
      order_id: id,
      order_name: o.name ?? null,
      customer: a.customer?.displayName ?? "",
      destination: a.shippingAddress?.countryCode ?? a.shippingAddress?.country ?? null,
      placed_at: a.createdAt ?? null,
      financial_status: a.financialStatus ?? null,
      tags: Array.isArray(a.tags) ? a.tags : [],
      reason: "No invoice issued for this order, so it cannot appear in the worklist",
      action:
        "Issue the goods invoice for this order (invoicing: invoice_create_and_issue), then Pull orders",
    })
  }

  // Oldest first: an order invisible for three weeks matters more than one
  // placed this morning.
  rows.sort((x, y) => (x.placed_at ?? "").localeCompare(y.placed_at ?? ""))
  return { rows, total: rows.length, truncated: orders.length >= limit, checked_at }
}
