// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `home_load` — backs the kernel-mounted Shopify Home tab.
//
// Returns three blocks the home UI renders:
//
//   connection.shopDomain     — straight read from `install_metadata`
//
//   recentOrders.orders[]     — last `recentLimit` orders. We call the
//                               existing `orders_search` GraphQL (no `query`)
//                               so the tool's projection rules stay the
//                               single source of truth for "what an order
//                               looks like in Liaison" — Home just slices a
//                               smaller subset of the same shape.
//
//   attention.*               — three categories: low inventory, unfulfilled
//                               past SLA, pending returns. Each is a
//                               GraphQL call shaped to the UI's read site
//                               (a flat row, not a deep entity tree). When
//                               a category errors we return an empty list
//                               for it so a partial outage doesn't blank
//                               the whole tab.
//
// All access is gated behind the `shopify:orders:read` scope at the manifest
// layer; this handler trusts the kernel's executeTool path to have already
// enforced it.
import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient, resolveInstallMetadata } from "../lib/get-client"

interface OrderLineItemEdge {
  node: {
    title?: string | null
    quantity?: number | null
    sku?: string | null
  }
}

interface OrderEdge {
  node: {
    id: string
    name: string
    createdAt?: string
    displayFulfillmentStatus?: string
    currentTotalPriceSet?: {
      presentmentMoney?: { amount: string; currencyCode: string }
    }
    customer?: { displayName?: string; email?: string } | null
    market?: { name?: string } | null
    lineItems?: { edges?: OrderLineItemEdge[] } | null
  }
}

interface UnfulfilledOrderEdge {
  node: {
    id: string
    name: string
    createdAt?: string
    customer?: { displayName?: string; email?: string } | null
    currentTotalPriceSet?: {
      presentmentMoney?: { amount: string; currencyCode: string }
    }
  }
}

interface LowInventoryEdge {
  node: {
    id: string
    sku?: string | null
    title?: string | null
    inventoryQuantity?: number | null
    product?: {
      id?: string
      title?: string
      productType?: string | null
    } | null
  }
}

interface ReturnEdge {
  node: {
    id: string
    status?: string
    requestedAt?: string
    order?: { name?: string } | null
    returnLineItems?: {
      edges?: Array<{
        node?: {
          returnReason?: string | null
        }
      }>
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GraphQL probes. Each one is intentionally narrow — we only ask for what
// the Home UI renders, so the throttle cost stays low even at high org
// volume.
// ─────────────────────────────────────────────────────────────────────────
const RECENT_ORDERS_QUERY = `
  query RecentOrders($first: Int!) {
    orders(first: $first, sortKey: CREATED_AT, reverse: true) {
      edges { node {
        id name createdAt displayFulfillmentStatus
        currentTotalPriceSet { presentmentMoney { amount currencyCode } }
        customer { displayName email }
        lineItems(first: 10) { edges { node { title quantity sku } } }
      } }
    }
  }
`

// `query: "fulfillment_status:unfulfilled created_at:<{cutoff}"` — Shopify's
// search syntax. The handler stamps the cutoff at call time.
const UNFULFILLED_PAST_SLA_QUERY = `
  query Unfulfilled($first: Int!, $query: String!) {
    orders(first: $first, query: $query, sortKey: CREATED_AT) {
      edges { node {
        id name createdAt
        customer { displayName email }
        currentTotalPriceSet { presentmentMoney { amount currencyCode } }
      } }
    }
  }
`

// `product_type:-giftcard` drops gift cards at the query layer — they have no
// physical stock so a "low inventory" reading on them is meaningless noise. The
// remaining demo/placeholder noise (a store's seeded sample products carry NO
// SKU) is filtered in the projection by SKU-presence: a low-stock ATTENTION
// list is about catalogued, trackable products, and an un-SKU'd variant is an
// uncatalogued placeholder, not a restock decision. See `isCataloguedVariant`.
const LOW_INVENTORY_QUERY = `
  query LowInventory($first: Int!) {
    productVariants(first: $first, query: "inventory_quantity:<=5 AND product_type:-giftcard") {
      edges { node {
        id sku title inventoryQuantity
        product { id title productType }
      } }
    }
  }
`

const PENDING_RETURNS_QUERY = `
  query PendingReturns($first: Int!) {
    returns(first: $first, query: "status:open OR status:requested", sortKey: CREATED_AT, reverse: true) {
      edges { node {
        id status requestedAt
        order { name }
        returnLineItems(first: 1) {
          edges { node { returnReason } }
        }
      } }
    }
  }
`

interface OrderLineItemSummary {
  sku: string | null
  title: string | null
  quantity: number
}

interface RecentOrderRow {
  id: string
  name: string
  customer: { displayName: string | null; email: string | null } | null
  market: string | null
  totalPrice: { amount: string; currencyCode: string } | null
  fulfillmentStatus: string | null
  placedAt: string | null
  // Compact line-item SKU summary so the Home order list answers "what's in each order"
  // (e.g. an unshipped-orders-by-SKU readout) without an orders_get drill-down per order.
  lineItems: OrderLineItemSummary[]
}

interface UnfulfilledOrderRow {
  orderId: string
  name: string
  customer: { displayName: string | null; email: string | null } | null
  placedAt: string
  hoursSincePlaced: number
  totalPrice: { amount: string; currencyCode: string } | null
}

interface LowInventoryRow {
  variantId: string
  productId: string
  productTitle: string
  variantTitle: string | null
  sku: string | null
  inventoryQuantity: number
  threshold: number
  location: string | null
}

interface PendingReturnRow {
  returnId: string
  orderName: string
  reason: string | null
  requestedAt: string
}

interface HomeBundle {
  connection: { shopDomain: string | null }
  attention: {
    lowInventory: LowInventoryRow[]
    unfulfilledOrders: UnfulfilledOrderRow[]
    pendingReturns: PendingReturnRow[]
  }
  recentOrders: { orders: RecentOrderRow[] }
}

// SLA threshold for "unfulfilled past SLA": orders older than this many hours
// without a fulfilled status. Mirrors `install_metadata.unfulfilledThresholdHours`
// for now; later we read the org-specific value once that's settled in spec.
const DEFAULT_SLA_HOURS = 24
const RECENT_LIMIT_DEFAULT = 20
const ATTENTION_LIMIT = 20

function hoursSince(iso: string | undefined): number {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return (Date.now() - t) / 3_600_000
}

// `_threshold` is the org's configured low-inventory threshold; Shopify's
// query syntax doesn't let us read it back per-variant, so we stamp the SAME
// threshold on every row for now. This is a UI hint, not authority — the
// `inventoryQuantity` is the truth and the UI surfaces both side-by-side
// ("2/10") so the operator can spot misconfigured thresholds at a glance.
function toLowInventoryRow(e: LowInventoryEdge, threshold: number): LowInventoryRow {
  return {
    variantId: e.node.id,
    productId: e.node.product?.id ?? "",
    productTitle: e.node.product?.title ?? "Product",
    variantTitle: e.node.title ?? null,
    sku: e.node.sku ?? null,
    inventoryQuantity: e.node.inventoryQuantity ?? 0,
    threshold,
    location: null,
  }
}

// A low-inventory ATTENTION row should be a catalogued, trackable product the
// operator can actually restock — not a store's seeded demo/sample product. The
// reliable, store-agnostic signal is SKU presence: every real catalogued variant
// carries a SKU, while Shopify's default sample products (gift cards, the demo
// snowboards, placeholder fixtures) ship with no SKU. Without this filter the
// attention list is dominated by demo noise (gift cards, snowboards, un-SKU'd
// placeholders), which both buries the real low-stock items AND tempts the agent
// to read the dev-store dashboard as if it were the org's order/product data.
function isCataloguedVariant(e: LowInventoryEdge): boolean {
  const sku = e.node.sku
  return typeof sku === "string" && sku.trim().length > 0
}

function toUnfulfilledRow(e: UnfulfilledOrderEdge): UnfulfilledOrderRow {
  const money = e.node.currentTotalPriceSet?.presentmentMoney ?? null
  return {
    orderId: e.node.id,
    name: e.node.name,
    customer: e.node.customer
      ? {
          displayName: e.node.customer.displayName ?? null,
          email: e.node.customer.email ?? null,
        }
      : null,
    placedAt: e.node.createdAt ?? new Date().toISOString(),
    hoursSincePlaced: hoursSince(e.node.createdAt),
    totalPrice: money,
  }
}

function toPendingReturnRow(e: ReturnEdge): PendingReturnRow {
  const firstLine = e.node.returnLineItems?.edges?.[0]?.node ?? null
  return {
    returnId: e.node.id,
    orderName: e.node.order?.name ?? "",
    reason: firstLine?.returnReason ?? null,
    requestedAt: e.node.requestedAt ?? new Date().toISOString(),
  }
}

function toRecentOrderRow(e: OrderEdge): RecentOrderRow {
  const money = e.node.currentTotalPriceSet?.presentmentMoney ?? null
  return {
    id: e.node.id,
    name: e.node.name,
    customer: e.node.customer
      ? {
          displayName: e.node.customer.displayName ?? null,
          email: e.node.customer.email ?? null,
        }
      : null,
    market: e.node.market?.name ?? null,
    totalPrice: money,
    fulfillmentStatus: e.node.displayFulfillmentStatus ?? null,
    placedAt: e.node.createdAt ?? null,
    lineItems: (e.node.lineItems?.edges ?? []).map((li) => ({
      sku: li.node.sku ?? null,
      title: li.node.title ?? null,
      quantity: li.node.quantity ?? 0,
    })),
  }
}

// Lower bound mirroring scan-unfulfilled.ts: ancient orders stuck in
// UNFULFILLED bookkeeping (pre-workflow history, digital goods) are not
// actionable from an attention list; the full backlog stays in Orders.
const UNFULFILLED_LOOKBACK_DAYS = 60

// Build the Shopify-style query string for "unfulfilled, placed before
// `cutoff`". Shopify's search uses `<` for "older than" on `created_at`
// when the date is ISO-formatted.
//
// `status:open` is load-bearing: cancelled and archived (closed) orders —
// including refunded ones — keep displayFulfillmentStatus UNFULFILLED
// forever, so without it the attention list fills with orders nobody can or
// should fulfill. Same guard as scan-unfulfilled.ts; keep the two in sync.
export function buildUnfulfilledQuery(slaHours: number): string {
  const nowMs = Date.now()
  const cutoff = new Date(nowMs - slaHours * 3_600_000).toISOString()
  const lookback = new Date(nowMs - UNFULFILLED_LOOKBACK_DAYS * 86_400_000).toISOString()
  return `status:open AND fulfillment_status:unfulfilled AND created_at:<'${cutoff}' AND created_at:>'${lookback}'`
}

export async function home_load(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<HomeBundle> {
  // 1. Connection — read install_metadata, deriving it in memory from the live
  //    connection in the connected-but-uninitialised case (lost
  //    `connected_account:create`) so a live connection never renders as a
  //    blank, "unconnected" Home tab. Never writes: home_load is a read.
  const meta = await resolveInstallMetadata(ctx)
  const shopDomain = meta?.shopDomain ?? null

  // Without a connected shop we can't query Shopify. Return an empty bundle.
  if (!shopDomain) {
    return {
      connection: { shopDomain: null },
      attention: { lowInventory: [], unfulfilledOrders: [], pendingReturns: [] },
      recentOrders: { orders: [] },
    }
  }

  const client = await getShopifyClient(ctx)
  const recentLimit =
    typeof params.recentLimit === "number"
      ? Math.min(50, params.recentLimit)
      : RECENT_ORDERS_LIMIT()
  const slaHours = typeof params.slaHours === "number" ? params.slaHours : DEFAULT_SLA_HOURS

  // 2. Run all four GraphQL probes in parallel. Each catches its own error
  //    so a partial outage doesn't blank the Home tab — the operator still
  //    sees the categories that succeeded.
  const [recentOrdersData, unfulfilledData, lowInventoryData, pendingReturnsData] =
    await Promise.all([
      safeQuery<{ orders?: { edges?: OrderEdge[] } }>(client, RECENT_ORDERS_QUERY, {
        first: recentLimit,
      }),
      safeQuery<{ orders?: { edges?: UnfulfilledOrderEdge[] } }>(
        client,
        UNFULFILLED_PAST_SLA_QUERY,
        { first: ATTENTION_LIMIT, query: buildUnfulfilledQuery(slaHours) },
      ),
      safeQuery<{ productVariants?: { edges?: LowInventoryEdge[] } }>(client, LOW_INVENTORY_QUERY, {
        first: ATTENTION_LIMIT,
      }),
      safeQuery<{ returns?: { edges?: ReturnEdge[] } }>(client, PENDING_RETURNS_QUERY, {
        first: ATTENTION_LIMIT,
      }),
    ])

  return {
    connection: { shopDomain },
    attention: {
      lowInventory: (lowInventoryData?.productVariants?.edges ?? [])
        .filter(isCataloguedVariant)
        .map((e) => toLowInventoryRow(e, 5)),
      unfulfilledOrders: (unfulfilledData?.orders?.edges ?? []).map(toUnfulfilledRow),
      pendingReturns: (pendingReturnsData?.returns?.edges ?? []).map(toPendingReturnRow),
    },
    recentOrders: {
      orders: (recentOrdersData?.orders?.edges ?? []).map(toRecentOrderRow),
    },
  }
}

function RECENT_ORDERS_LIMIT(): number {
  return RECENT_LIMIT_DEFAULT
}

// Run a GraphQL query and return `null` (silently) when it fails. The
// surface degrades to an empty list for that category rather than the whole
// home tab blanking out. Errors still reach the kernel log via the bundle's
// telemetry capture (the host bridge logs every failed call).
async function safeQuery<T>(
  client: { query: <R>(q: string, vars: Record<string, unknown>) => Promise<R> },
  query: string,
  vars: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await client.query<T>(query, vars)
  } catch {
    return null
  }
}
