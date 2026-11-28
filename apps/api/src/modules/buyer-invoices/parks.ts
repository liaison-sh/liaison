// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A paid Shopify order whose invoice is parked (an open invoicing deferred event: waiting on the
// buyer's e-invoicing data, a tax review, a render) has no document and no sale row yet, but the
// buyer has paid: the buyer invoices API shows it as a pending entry ("invoice on its way"). Its
// identity is the one the order carried when it was paid (its customer email and Shopify
// customer id, from the parked order payload), decided by the same `saleMatches` rule as every
// other sale. Nothing about the park itself (status, reason, blocker, row id) leaves this file.
//
// Pure: the store reads the rows (one issuer profile, open statuses only) and this file turns
// them into sales.
import type { BuyerIdentity } from "./match"

/** One open park of a Shopify order, as the store reads it. */
export interface ParkRow {
  /** The park's event id: the Shopify order id (decimal text) for an order park. */
  order_id: string
  /** The parked order payload (invoicing's OrderPaidPayload). */
  payload: unknown
  created_at: unknown
}

export interface ParkedSale {
  orderId: string
  name: string | null
  soldOn: string | null
  /** Decimal text, or null when the payload carries no amount. */
  totalMinor: string | null
  currency: string | null
  identity: BuyerIdentity
}

const ORDER_ID = /^[0-9]{1,20}$/

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : null

function dayOf(v: unknown): string | null {
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null
  return m ? (m[1] as string) : null
}

function minorText(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v)
  if (typeof v === "string" && /^-?[0-9]+$/.test(v.trim())) return v.trim()
  return null
}

function customerId(v: unknown): string | null {
  const t = typeof v === "number" ? String(v) : text(v)
  if (!t) return null
  const n = t.replace(/^gid:\/\/shopify\/Customer\//, "")
  return ORDER_ID.test(n) ? n : null
}

/**
 * The parked orders as sales, one per order. Several open parks of one order share ONE identity
 * over all of them, as an earlier order's invoices do: two different emails leave it with no
 * email, two different customer ids make it a conflict that matches nobody. A zero total (never
 * invoiced), a payload of another order or an event id that is not an order id gives nothing.
 */
export function parkedSales(rows: readonly ParkRow[]): ParkedSale[] {
  const byOrder = new Map<string, Array<{ p: Record<string, unknown>; created: unknown }>>()
  for (const r of rows) {
    if (!ORDER_ID.test(r.order_id)) continue
    const p = r.payload
    if (!p || typeof p !== "object" || Array.isArray(p)) continue
    const payload = p as Record<string, unknown>
    if (String(payload.id ?? "") !== r.order_id) continue
    const list = byOrder.get(r.order_id) ?? []
    list.push({ p: payload, created: r.created_at })
    byOrder.set(r.order_id, list)
  }
  const out: ParkedSale[] = []
  for (const [orderId, parks] of byOrder) {
    const emails = new Set<string>()
    const ids = new Set<string>()
    let name: string | null = null
    let soldOn: string | null = null
    let total: string | null = null
    let currency: string | null = null
    for (const { p, created } of parks) {
      const c = (p.customer ?? {}) as Record<string, unknown>
      const email = text(c.email)
      if (email) emails.add(email.toLowerCase())
      const id = customerId(c.id)
      if (id) ids.add(id)
      name ??= text(p.order_number)
      soldOn ??= dayOf(p.createdAt) ?? dayOf(created)
      total ??= minorText(p.total_price_minor)
      currency ??= text(p.currency)?.toUpperCase() ?? null
    }
    if (total !== null && BigInt(total) === 0n) continue
    out.push({
      orderId,
      name,
      soldOn,
      totalMinor: total,
      currency,
      identity: {
        email: emails.size === 1 ? ([...emails][0] as string) : null,
        shopifyCustomerId:
          ids.size === 1 ? ([...ids][0] as string) : ids.size > 1 ? "<conflict>" : null,
        hubUserId: null,
      },
    })
  }
  return out
}
