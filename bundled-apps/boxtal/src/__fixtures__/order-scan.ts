// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test bridge for the ORDER-DRIVEN worklist scan.
//
// The worklist used to be enumerated from `invoicing:documents_search`, so every test ctx in this
// app stubs that one target and hands back invoice fixtures. The rework enumerates OPEN SHOPIFY
// ORDERS and joins their documents, so the same fixtures now have to reach the scan through
// `shopify:orders_search` + `invoicing:documents_for_orders`.
//
// This helper synthesises exactly that pair from an invoice fixture list, so a test keeps
// expressing its intent as "these invoices exist" while exercising the real scan path. Nothing here
// is production code: it is the fixture adapter, one per repo, so the shape lives in one place.

import type { CrossAppEnvelope } from "../ctx"

export interface FixtureInvoice {
  id: string
  number?: string | null
  channel?: string | null
  counterparty_name?: string | null
  counterparty_country?: string | null
  shopify_order_id?: string | null
  scope?: string | null
  status?: string | null
  type?: string | null
  [k: string]: unknown
}

export interface SyntheticOrder {
  id: string
  order_id: string
  name: string
  hit: Record<string, unknown>
  links: Array<Record<string, unknown>>
}

/** What `shopify:orders_search` returns on a real hit besides the country: the ship-to street/city/
 *  zip and the customer's email (bundled-apps/shopify/src/reads.ts maps exactly these onto the hit).
 *  A fixture without them is not a smaller order, it is an order with an incomplete customer, which
 *  is a DIFFERENT case: the document paths refuse to issue to a recipient with no address or email. */
const DEFAULT_SHIP_TO = {
  street: "12 rue de la Paix",
  city: "Paris",
  zip: "75002",
}

export interface OrderScanStubOptions {
  /** Extra open orders with NO document at all (the un-invoiced rows the rework exists for). */
  extraOrders?: Array<{
    order_id: string
    name?: string
    customer?: string
    country?: string
    financialStatus?: string | null
    fulfillmentStatus?: string | null
    cancelledAt?: string | null
    tags?: string[]
    createdAt?: string
    lineItems?: Array<{
      sku?: string | null
      title?: string | null
      quantity?: number
      variant_id?: string | null
    }>
    shippingAddress?: Record<string, string | null>
  }>
  /** Per-invoice document overrides, keyed by invoice id (e.g. `{ "inv-2": { scope: "software" } }`). */
  documentOverrides?: Record<string, Record<string, unknown>>
  /** Drop the default ship-to street/city/zip and the customer email from every synthesized order,
   *  so a test can exercise the incomplete-recipient path. */
  withoutShipTo?: boolean
  /** Per-invoice ORDER overrides, keyed by invoice id: the order name, tags, dates and the
   *  refund/cancel facts the shippability filter reads. */
  orderOverrides?: Record<
    string,
    {
      name?: string
      tags?: string[]
      createdAt?: string
      financialStatus?: string | null
      fulfillmentStatus?: string | null
      cancelledAt?: string | null
      lineItems?: Array<{ sku?: string | null; title?: string | null; quantity?: number }>
      shippingAddress?: Record<string, string | null>
    }
  >
  /** Make the order scan fail, to exercise the fail-soft path. */
  ordersSearchFails?: boolean
  /** Make the document join fail (invoicing not installed). */
  documentsForOrdersFails?: boolean
  /** Report the scan as truncated (a nextCursor the caller will follow). */
  truncatedAt?: number
}

/** Each documented `fulfillment_status` search term, and the `displayFulfillmentStatus` values it
 *  matches (shopify.dev, Admin GraphQL `orders` query). */
const FULFILLMENT_TERMS: Record<string, Set<string>> = {
  unfulfilled: new Set(["UNFULFILLED"]),
  unshipped: new Set([
    "UNFULFILLED",
    "PARTIALLY_FULFILLED",
    "IN_PROGRESS",
    "PENDING_FULFILLMENT",
    "OPEN",
  ]),
  partial: new Set(["PARTIALLY_FULFILLED"]),
  on_hold: new Set(["ON_HOLD"]),
  scheduled: new Set(["SCHEDULED"]),
  request_declined: new Set(["REQUEST_DECLINED"]),
  fulfilled: new Set(["FULFILLED"]),
  shipped: new Set(["FULFILLED"]),
}

function numericId(raw: unknown, fallback: string): string {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw)
  if (typeof raw === "string") {
    const m = raw.match(/(\d+)\s*$/)
    if (m) return m[1]!
  }
  return fallback
}

/** One open, unfulfilled, paid order per invoice fixture, plus any extra document-less orders. */
export function synthesizeOrders(
  invoices: FixtureInvoice[],
  opts: OrderScanStubOptions = {},
): SyntheticOrder[] {
  // A non-Shopify invoice (manual, repair, free-text) has no order behind it, so the order-driven
  // scan cannot see one. Mirrors production: the worklist is the set of open SHOPIFY orders.
  const out: SyntheticOrder[] = invoices
    .filter((inv) => inv.channel === undefined || inv.channel === null || inv.channel === "shopify")
    .map((inv, n) => {
      const orderId = numericId(inv.shopify_order_id, `90000${n}`)
      const over = opts.orderOverrides?.[inv.id] ?? {}
      const name = over.name ?? `#${1000 + n}`
      return {
        id: inv.id,
        order_id: orderId,
        name,
        hit: {
          id: `gid://shopify/Order/${orderId}`,
          entity: "order",
          title: name,
          name,
          currency: "EUR",
          attributes: {
            tags: over.tags ?? [],
            financialStatus: over.financialStatus === undefined ? "PAID" : over.financialStatus,
            fulfillmentStatus: over.fulfillmentStatus ?? "UNFULFILLED",
            cancelledAt: over.cancelledAt ?? null,
            createdAt: over.createdAt ?? `2026-07-0${(n % 9) + 1}T10:00:00.000Z`,
            shippingCountryCode: inv.counterparty_country ?? "FR",
            ...(opts.withoutShipTo
              ? {}
              : {
                  shippingAddress1: DEFAULT_SHIP_TO.street,
                  shippingCity: DEFAULT_SHIP_TO.city,
                  shippingZip: DEFAULT_SHIP_TO.zip,
                }),
            customer: {
              displayName: inv.counterparty_name ?? `Customer ${inv.id}`,
              ...(opts.withoutShipTo ? {} : { email: `order-${orderId}@example.com` }),
            },
            lineItems: over.lineItems ?? [],
          },
          ...(over.shippingAddress ? { shippingAddress: over.shippingAddress } : {}),
        },
        links: [
          {
            shopify_order_id: orderId,
            id: inv.id,
            number: inv.number ?? inv.id,
            type: inv.type ?? "invoice",
            scope: inv.scope ?? "goods",
            status: inv.status ?? "issued",
            payment_status: "paid",
            ...(opts.documentOverrides?.[inv.id] ?? {}),
          },
        ],
      }
    })
  for (const extra of opts.extraOrders ?? []) {
    out.push({
      id: `order-only-${extra.order_id}`,
      order_id: extra.order_id,
      name: extra.name ?? `#${extra.order_id}`,
      hit: {
        id: `gid://shopify/Order/${extra.order_id}`,
        entity: "order",
        title: extra.name ?? `#${extra.order_id}`,
        name: extra.name ?? `#${extra.order_id}`,
        currency: "EUR",
        attributes: {
          tags: extra.tags ?? [],
          financialStatus: extra.financialStatus === undefined ? "PAID" : extra.financialStatus,
          fulfillmentStatus: extra.fulfillmentStatus ?? "UNFULFILLED",
          cancelledAt: extra.cancelledAt ?? null,
          createdAt: extra.createdAt ?? "2026-07-15T10:00:00.000Z",
          shippingCountryCode: extra.country ?? "FR",
          ...(opts.withoutShipTo
            ? {}
            : {
                shippingAddress1: DEFAULT_SHIP_TO.street,
                shippingCity: DEFAULT_SHIP_TO.city,
                shippingZip: DEFAULT_SHIP_TO.zip,
              }),
          customer: {
            displayName: extra.customer ?? "Customer",
            ...(opts.withoutShipTo ? {} : { email: `order-${extra.order_id}@example.com` }),
          },
          lineItems: (extra.lineItems ?? []).map((l) => ({
            sku: l.sku ?? null,
            title: l.title ?? null,
            quantity: l.quantity ?? 1,
          })),
        },
        ...(extra.shippingAddress ? { shippingAddress: extra.shippingAddress } : {}),
        // `orders_get` carries the line items with their VARIANT (the search hit does not), which is
        // the reference the packing profiles and the customs overlay are keyed on.
        ...((extra.lineItems ?? []).some((l) => l.variant_id)
          ? {
              lineItems: (extra.lineItems ?? []).map((l) => ({
                title: l.title ?? null,
                quantity: l.quantity ?? 1,
                variant: { id: l.variant_id ?? null, sku: l.sku ?? null },
              })),
            }
          : {}),
      },
      links: [],
    })
  }
  return out
}

/**
 * The stub for the three scan targets. Returns null for anything else so the caller's own routing
 * stays in charge.
 */
export function makeOrderScanStub(
  invoices: FixtureInvoice[],
  opts: OrderScanStubOptions = {},
): (target: string, args?: Record<string, unknown>) => CrossAppEnvelope | null {
  const orders = synthesizeOrders(invoices, opts)
  const byOrderId = new Map(orders.map((o) => [o.order_id, o]))
  return (target, args) => {
    if (target === "shopify:orders_search") {
      if (opts.ordersSearchFails) {
        return { status: "error", error: { code: "upstream", message: "Shopify is unreachable" } }
      }
      // Honour the query terms the worklist actually sends, so a test can express "this order is
      // fulfilled" (and therefore no longer shipping work) the way Shopify would.
      const query = typeof args?.query === "string" ? args.query : ""
      // `fulfillment_status:<value>` is a DISTINCT-VALUE filter on the real API, not "not fulfilled":
      // an ON_HOLD or PARTIALLY_FULFILLED order matches `on_hold` / `partial` and does NOT match
      // `unfulfilled`. Modelling it as "anything but FULFILLED" is what let the app ship a query
      // that silently dropped three states no test could see.
      const wanted = [...query.matchAll(/fulfillment_status:([a-z_]+)/g)].map((m) => m[1]!)
      const visible = orders.filter((o) => {
        const a = (o.hit as { attributes?: Record<string, unknown> }).attributes ?? {}
        if (
          wanted.length > 0 &&
          !wanted.some((v) =>
            FULFILLMENT_TERMS[v]?.has(String(a.fulfillmentStatus ?? "UNFULFILLED")),
          )
        )
          return false
        if (query.includes("status:open") && a.cancelledAt) return false
        return true
      })
      return {
        status: "completed",
        result: {
          results: visible.map((o) => o.hit),
          nextCursor: null,
          totalCount: visible.length,
        },
      }
    }
    if (target === "shopify:orders_get") {
      const id = numericId(args?.id, "")
      const found = byOrderId.get(id)
      // The real orders_get always carries both address keys (null when the order has none).
      return {
        status: "completed",
        result: found ? { shippingAddress: null, customerAddress: null, ...found.hit } : null,
      }
    }
    if (target === "invoicing:documents_for_orders") {
      if (opts.documentsForOrdersFails) {
        return {
          status: "error",
          error: { code: "not_installed", message: "invoicing is not installed" },
        }
      }
      const ids = Array.isArray(args?.shopify_order_ids)
        ? (args!.shopify_order_ids as string[])
        : []
      const links = ids.flatMap((id) => byOrderId.get(numericId(id, String(id)))?.links ?? [])
      return { status: "completed", result: { links } }
    }
    return null
  }
}

/** The order_key each invoice fixture ends up under, so a test can address the row it seeded. */
export function orderKeysFor(
  invoices: FixtureInvoice[],
  opts: OrderScanStubOptions = {},
): Map<string, string> {
  const out = new Map<string, string>()
  for (const o of synthesizeOrders(invoices, opts)) out.set(o.id, `so:${o.order_id}`)
  return out
}
