// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shop as a `revenue-stream@1` provider. Every `orders/create` delivery keeps the normalized
// order (`sale_snapshots`, one row per order, the last delivery wins) and emits `sale:paid`; the
// consumer (invoicing) then reads the sale through the contract: `rs_sale_get` maps the kept
// order to a `Sale` (lib/sale.ts), `rs_sales_list` lists the orders received in a window.
//
// The order a webhook delivered is what the sale says, because Shopify's REST order reads are not
// available on every store (webhooks.ts, `po_number`): the GraphQL `orders_get` read stays the
// consumer's own enrichment, as before. `sale:paid` is emitted for every created order, paid or
// not, exactly when `order:created` was: the sale's `paid.status` says whether it was paid, and
// the invoice of an unpaid order issues as due, as it always did.

import type { AppContext } from "@liaison/app-sdk"
import type { Sale } from "@liaison/app-sdk/contracts"
import { type NormalizedOrder, saleFromOrder } from "./lib/sale"

const TABLE = "sale_snapshots"
const PAGE = 100

type Row = Record<string, unknown>

function isoOf(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === "string" && v !== "") return new Date(v).toISOString()
  return new Date(0).toISOString()
}

/** Keep the order a delivery carried; returns when it was received (the event's `occurred_at`). */
export async function recordSaleSnapshot(
  ctx: AppContext,
  order: NormalizedOrder & { orderId: string },
): Promise<string> {
  const rows = (await ctx.db.findMany(TABLE, {
    where: { orderId: order.orderId },
    limit: 1,
  })) as Row[]
  const existing = rows[0]
  // A redelivery keeps the first reception instant: the sale was made once.
  const receivedAt = existing ? isoOf(existing.receivedAt) : new Date().toISOString()
  const fields = {
    shopDomain: String(order.shopDomain ?? ""),
    customerId: order.customer?.id ? String(order.customer.id) : null,
    order,
  }
  if (existing) {
    await ctx.db.update(TABLE, String(existing.id), fields)
    return receivedAt
  }
  try {
    await ctx.db.insert(TABLE, {
      orderId: order.orderId,
      receivedAt: new Date(receivedAt),
      ...fields,
    })
  } catch (err) {
    // A concurrent delivery of the same order wrote it first.
    const again = (await ctx.db.findMany(TABLE, {
      where: { orderId: order.orderId },
      limit: 1,
    })) as Row[]
    if (!again[0]) throw err
    await ctx.db.update(TABLE, String(again[0].id), fields)
    return isoOf(again[0].receivedAt)
  }
  return receivedAt
}

/** A customer's data deletion: their kept orders go. */
export async function forgetSaleSnapshotsOf(ctx: AppContext, customerId: string): Promise<void> {
  for (;;) {
    const rows = (await ctx.db.findMany(TABLE, {
      where: { customerId },
      limit: PAGE,
    })) as Row[]
    for (const r of rows) await ctx.db.delete(TABLE, String(r.id))
    if (rows.length < PAGE) return
  }
}

function saleOf(row: Row): Sale {
  return saleFromOrder(row.order as NormalizedOrder, isoOf(row.receivedAt))
}

/** `revenue-stream@1` `sale_get`. */
export async function rs_sale_get(
  params: { external_id?: string },
  ctx: AppContext,
): Promise<{ found: false } | { found: true; sale: Sale }> {
  const id = String(params?.external_id ?? "").trim()
  if (id === "") return { found: false }
  const rows = (await ctx.db.findMany(TABLE, { where: { orderId: id }, limit: 1 })) as Row[]
  return rows[0] ? { found: true, sale: saleOf(rows[0]) } : { found: false }
}

/** `revenue-stream@1` `sales_list`: orders received in `[paid_from, paid_to)`, oldest first. */
export async function rs_sales_list(
  params: { paid_from?: string; paid_to?: string; cursor?: string | null },
  ctx: AppContext,
): Promise<{ sales: Sale[]; next: string | null }> {
  const from = new Date(String(params?.paid_from ?? ""))
  const to = new Date(String(params?.paid_to ?? ""))
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { sales: [], next: null }
  const offset = Math.max(0, Number.parseInt(String(params?.cursor ?? "0"), 10) || 0)
  const rows = (await ctx.db.findMany(TABLE, {
    where: { receivedAt: { gte: from.toISOString(), lt: to.toISOString() } },
    orderBy: { receivedAt: "asc" },
    limit: PAGE,
    offset,
  })) as Row[]
  return {
    sales: rows.map(saleOf),
    next: rows.length === PAGE ? String(offset + PAGE) : null,
  }
}
