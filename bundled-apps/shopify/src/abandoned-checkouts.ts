// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `abandoned_checkouts_list` — retrieve abandoned customer checkouts for cart recovery
// (BL-169 #3, impossible→works_today). None of the other Shopify tools expose abandoned
// checkouts (draft_orders are SELLER-initiated quotes, NOT abandoned customer carts), so
// "pull this week's abandoned checkouts for a recovery campaign" was impossible. This tool
// reads Shopify's `abandonedCheckouts` connection server-side: value, customer, line items,
// and the recovery URL per checkout, optionally bounded to a recent window.
//
// DATA NOTE: abandoned checkouts are created by Shopify ONLY from real buyer abandonment
// (a shopper reaches checkout with contact info and does not complete) — they cannot be
// created via the Admin API, so a store with no recent abandonment legitimately returns an
// EMPTY list. The agent must report that honestly ("no abandoned checkouts this week") and
// must NOT fabricate carts or pass off draft_orders / recent orders as abandoned checkouts.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "./lib/get-client"

const ABANDONED_QUERY = `
  query AbandonedCheckouts($first: Int!, $after: String) {
    abandonedCheckouts(first: $first, after: $after, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        createdAt
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { displayName email }
        lineItems(first: 20) { nodes { title quantity } }
        abandonedCheckoutUrl
      }
      pageInfo { hasNextPage endCursor }
    }
  }`

const PAGE = 250
const MAX_CHECKOUTS = 1000 // bound the scan; flag `partial` if the store exceeds it

export interface RawLineItem {
  title?: string | null
  quantity?: number | null
}
export interface RawAbandonedCheckout {
  id?: string | null
  createdAt?: string | null
  totalPriceSet?: { shopMoney?: { amount?: string | null; currencyCode?: string | null } | null } | null
  customer?: { displayName?: string | null; email?: string | null } | null
  lineItems?: { nodes?: RawLineItem[] | null } | null
  abandonedCheckoutUrl?: string | null
}

export interface AbandonedCheckout {
  id: string
  createdAt: string | null
  totalValue: number
  currency: string | null
  customerName: string | null
  customerEmail: string | null
  lineItems: Array<{ title: string; quantity: number }>
  recoveryUrl: string | null
}

export interface AbandonedCheckoutsResult {
  checkouts: AbandonedCheckout[]
  total: number
  totalRecoverableValue: number
  currency: string | null
}

/** Pure: normalize the raw checkout nodes, optionally drop those older than `sinceMs`
 *  (epoch-ms cutoff), and sum the recoverable value. Kept pure so the window + totalling
 *  logic is unit-testable without the live Shopify client and without Date.now(). */
export function summarizeAbandonedCheckouts(
  raw: RawAbandonedCheckout[],
  sinceMs?: number,
): AbandonedCheckoutsResult {
  const checkouts: AbandonedCheckout[] = []
  let totalValue = 0
  let currency: string | null = null
  for (const c of raw) {
    if (!c?.id) continue
    const createdAt = c.createdAt ?? null
    if (sinceMs !== undefined && createdAt) {
      const t = Date.parse(createdAt)
      if (Number.isFinite(t) && t < sinceMs) continue
    }
    const money = c.totalPriceSet?.shopMoney
    const value = Number.parseFloat(String(money?.amount ?? "0")) || 0
    currency = currency ?? money?.currencyCode ?? null
    totalValue += value
    checkouts.push({
      id: c.id,
      createdAt,
      totalValue: value,
      currency: money?.currencyCode ?? null,
      customerName: c.customer?.displayName ?? null,
      customerEmail: c.customer?.email ?? null,
      lineItems: (c.lineItems?.nodes ?? [])
        .filter((li): li is RawLineItem => !!li && typeof li.title === "string")
        .map((li) => ({ title: String(li.title), quantity: Number(li.quantity ?? 0) || 0 })),
      recoveryUrl: c.abandonedCheckoutUrl ?? null,
    })
  }
  return {
    checkouts,
    total: checkouts.length,
    totalRecoverableValue: Math.round(totalValue * 100) / 100,
    currency,
  }
}

interface AbandonedPage {
  abandonedCheckouts?: {
    nodes?: RawAbandonedCheckout[]
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  }
}

export async function abandoned_checkouts_list(
  params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  // Optional recency window: `sinceDays` (default 30) bounds the list to recently-abandoned
  // checkouts. The cutoff is computed from the newest checkout's createdAt (no Date.now() in
  // the bundle sandbox), falling back to no-filter when the store is empty.
  const sinceDaysRaw = params.sinceDays
  const sinceDays =
    typeof sinceDaysRaw === "number" && sinceDaysRaw > 0
      ? sinceDaysRaw
      : typeof sinceDaysRaw === "string" && Number.parseInt(sinceDaysRaw, 10) > 0
        ? Number.parseInt(sinceDaysRaw, 10)
        : 30

  const client = await getShopifyClient(ctx)
  const collected: RawAbandonedCheckout[] = []
  let cursor: string | null = null
  let truncated = false
  for (;;) {
    const data: AbandonedPage = await client.query<AbandonedPage>(ABANDONED_QUERY, {
      first: PAGE,
      after: cursor,
    })
    const nodes = data.abandonedCheckouts?.nodes ?? []
    collected.push(...nodes)
    const pageInfo = data.abandonedCheckouts?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    if (collected.length >= MAX_CHECKOUTS) {
      truncated = true
      break
    }
    cursor = pageInfo.endCursor
  }

  // Derive the window cutoff from the newest checkout (results are CREATED_AT desc), so the
  // sandbox needs no clock. If the store has none, there is nothing to bound.
  let sinceMs: number | undefined
  const newest = collected[0]?.createdAt
  if (newest) {
    const newestMs = Date.parse(newest)
    if (Number.isFinite(newestMs)) sinceMs = newestMs - sinceDays * 24 * 60 * 60 * 1000
  }

  const result = summarizeAbandonedCheckouts(collected, sinceMs)
  return {
    ...result,
    sinceDays,
    partial: truncated,
    note:
      result.total === 0
        ? "No abandoned checkouts found for this window: the store has none to recover right now. Report this honestly; do NOT fabricate carts and do NOT pass off draft_orders (seller quotes) or recent completed orders as abandoned checkouts."
        : `Abandoned customer checkouts in the last ${sinceDays} days, newest first, with the recovery URL per checkout. draft_orders are seller-created quotes and are NOT included.`,
  }
}
