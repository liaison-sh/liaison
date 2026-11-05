// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B12 — Unfulfilled-order scanner.
//
// Queries Shopify for orders older than `unfulfilledThresholdHours` whose
// `displayFulfillmentStatus` is `UNFULFILLED`. Previously this emitted one
// `order:unfulfilled` event PER matched order, which the attention translator
// turned into one row per order — on a store with a real backlog that's
// dozens to hundreds of unread attention rows from a single hourly scan (107
// in one day on a staging org). Instead, emit ONE aggregate
// `orders:unfulfilled_digest` event per scan summarizing the whole backlog.
// The digest uses a stable `entityId` ("unfulfilled-orders") so the
// translator's idempotent upsert (keyed on user/app/entity_type/entity_id/kind
// for UNREAD rows) refreshes the same row in place scan over scan instead of
// stacking a new one.
//
// Errors are swallowed so a single scan failure does not break the cron loop.
import type { AppContext } from "@liaison/app-sdk"
import { emitEvent } from "../lib/emit"
import { ensureInstallMetadata, getShopifyClient } from "../lib/get-client"

interface OrderNode {
  id?: string
  name?: string | null
  createdAt?: string | null
  displayFulfillmentStatus?: string | null
  currencyCode?: string | null
  presentmentCurrencyCode?: string | null
  tags?: string[] | null
}

// `Order.market` does not exist on Admin API 2026-04 — requesting it makes the
// whole query fail ("Field 'market' doesn't exist on type 'Order'") and the
// scan silently emits nothing. The metadata fallback below already derives the
// market axis without it (tags/"default"), matching reads.ts normalizeOrder.
const QUERY = `
  query UnfulfilledOrders($query: String!) {
    orders(first: 100, query: $query) {
      edges {
        node {
          id name createdAt displayFulfillmentStatus
          currencyCode presentmentCurrencyCode
          tags
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`

/** Only orders created within this window count toward the digest. */
const UNFULFILLED_LOOKBACK_DAYS = 60

function shortId(gid?: string): string {
  if (!gid) return ""
  const m = gid.match(/\/(\w+)$/)
  return m ? m[1]! : gid
}

export async function scanUnfulfilledOrdersJob(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<{ matched: number }> {
  // The job path, not a read, so it persists the connected-but-uninitialised
  // heal: an hourly cron converges a lost connect event within the hour.
  const row = await ensureInstallMetadata(ctx)
  if (!row?.shopDomain) return { matched: 0 }
  // Do not scan after an uninstall — the connection is no longer valid and
  // repeating API calls would generate noise and potential auth errors.
  if (row.connectionStatus === "disconnected") return { matched: 0 }
  const threshold = row.unfulfilledThresholdHours ?? 24
  let client
  try {
    client = await getShopifyClient(ctx)
  } catch {
    return { matched: 0 }
  }
  // Single source of truth for the SLA boundary: anchor the cutoff once and use
  // the SAME instant both to build the Shopify query (`created_at:<cutoff`) and
  // to derive each order's age for the emitted payload. Previously the handler
  // re-derived `ageHours` against a fresh `Date.now()` and dropped
  // `ageHours < threshold` — a redundant second filter whose `Math.floor`
  // rounding plus the elapsed time between query-build and re-check could
  // silently drop boundary orders that the Shopify query had correctly matched.
  const nowMs = Date.now()
  const cutoffMs = nowMs - threshold * 3600 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()
  // Lower bound: a store's historical orders can sit UNFULFILLED forever
  // (pre-workflow history, digital goods never marked fulfilled). Without a
  // lookback the digest reports years-old orders ("oldest 33585h") that no
  // one is going to action from an attention feed. Recent misses are the
  // alertable ones; the full backlog stays visible in the Orders view.
  const lookbackIso = new Date(nowMs - UNFULFILLED_LOOKBACK_DAYS * 86_400_000).toISOString()
  // `status:open` excludes cancelled AND archived (closed) orders. Without it
  // the digest counted every cancelled/refunded order still carrying
  // UNFULFILLED bookkeeping status -- on the reference store that was 114 phantom
  // "orders needing action", none of which a human could or should fulfill.
  const query = `status:open fulfillment_status:unfulfilled created_at:<${cutoffIso} created_at:>${lookbackIso}`

  let edges: Array<{ node: OrderNode }>
  try {
    const data = await client.query<{ orders?: { edges?: Array<{ node: OrderNode }> } }>(QUERY, { query })
    edges = data.orders?.edges ?? []
  } catch (err) {
    ctx.logger.warn(`[scan-unfulfilled] ${(err as Error).message}`)
    return { matched: 0 }
  }

  // Age relative to the same cutoff anchor used to query Shopify. The Shopify
  // query already enforced `created_at < cutoff`, so every returned order is
  // at least `threshold` hours old; no second threshold filter here.
  const aged = edges
    .filter((edge) => !!edge.node.createdAt)
    .map((edge) => {
      const node = edge.node
      const ageHours = Math.floor((nowMs - new Date(node.createdAt as string).getTime()) / 3600 / 1000)
      return { name: node.name ?? shortId(node.id), ageHours }
    })
    .sort((a, b) => b.ageHours - a.ageHours)

  const matched = aged.length
  if (matched === 0) {
    // Emit the zero-count digest anyway: the manifest translation's
    // `resolveWhen {count: 0}` marks the previous digest row read, so a
    // backlog that drains (or turns out to be all cancelled/archived orders)
    // clears itself from the feed instead of sitting unread forever.
    await emitEvent(ctx, {
      entity: "orders",
      action: "unfulfilled_digest",
      entityId: "unfulfilled-orders",
      data: { count: 0, thresholdHours: threshold, oldestAgeHours: 0, orderNames: [] },
    })
    return { matched: 0 }
  }

  const oldestAgeHours = aged[0]!.ageHours
  const orderNames = aged.slice(0, 5).map((o) => o.name)

  // One aggregate digest per scan, not one event per order. Axis metadata
  // (market/currency) cannot apply here — the digest spans every matched
  // order regardless of market/currency, so it is omitted. Users with a
  // market- or currency-narrowed subscription rule on this kind will not
  // receive the digest; acceptable since the alternative (per-order events)
  // is exactly the spam this replaces.
  await emitEvent(ctx, {
    entity: "orders",
    action: "unfulfilled_digest",
    entityId: "unfulfilled-orders",
    data: {
      count: matched,
      thresholdHours: threshold,
      oldestAgeHours,
      orderNames,
    },
  })
  return { matched }
}
