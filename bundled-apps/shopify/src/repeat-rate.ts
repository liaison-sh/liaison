// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `repeat_rate` — base-wide repeat-purchase rate (BL-169 #1, impossible→works_today).
// Shopify exposes per-customer order counts (customers_get) but NO base-wide aggregate, so
// "what share of customers come back for a second purchase?" required iterating the whole
// customer base — beyond a 10-step agent turn. This server-side tool does it in ONE call:
// paginate customers (Customer.numberOfOrders), count those with >1 order, return the
// repeat-purchase rate. NOTE the COHORT half of the ask ("repeat rate for customers who first
// bought during Black Friday vs Modular Expo") needs first-order-date cohorts for arbitrary
// historical event windows — not provided here (and the dogfood store carries no such
// historical cohort), so the agent reports the repeat_rate and bounds the cohort ask honestly.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "./lib/get-client"

const CUSTOMERS_QUERY = `
  query RepeatRate($first: Int!, $after: String) {
    customers(first: $first, after: $after) {
      nodes { id displayName numberOfOrders }
      pageInfo { hasNextPage endCursor }
    }
  }`

const PAGE = 250
const MAX_CUSTOMERS = 5000 // bound the scan; flag `partial` if the base exceeds it

export interface CustomerOrderCount {
  displayName: string | null
  numberOfOrders: number | string | null
}

export interface RepeatRateResult {
  totalCustomers: number
  repeatCustomers: number
  repeatRatePct: number
  sampleRepeatCustomers: Array<{ name: string; orders: number }>
}

/** Pure: count customers with >1 order and derive the repeat-purchase rate. Kept pure so
 *  the arithmetic is unit-testable without the live Shopify client. numberOfOrders may arrive
 *  as a string (GraphQL UnsignedInt64) — coerce. */
export function computeRepeatRate(customers: CustomerOrderCount[]): RepeatRateResult {
  let repeat = 0
  const sample: Array<{ name: string; orders: number }> = []
  for (const c of customers) {
    const orders =
      typeof c.numberOfOrders === "number"
        ? c.numberOfOrders
        : Number.parseInt(String(c.numberOfOrders ?? "0"), 10)
    if (Number.isFinite(orders) && orders > 1) {
      repeat++
      sample.push({ name: c.displayName ?? "(unknown)", orders })
    }
  }
  const total = customers.length
  sample.sort((a, b) => b.orders - a.orders)
  return {
    totalCustomers: total,
    repeatCustomers: repeat,
    repeatRatePct: total > 0 ? Math.round((1000 * repeat) / total) / 10 : 0,
    sampleRepeatCustomers: sample.slice(0, 20),
  }
}

interface CustomersPage {
  customers?: {
    nodes?: CustomerOrderCount[]
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  }
}

export async function repeat_rate(_params: Record<string, unknown>, ctx: AppContext): Promise<unknown> {
  const client = await getShopifyClient(ctx)
  const collected: CustomerOrderCount[] = []
  let cursor: string | null = null
  let truncated = false
  for (;;) {
    const data: CustomersPage = await client.query<CustomersPage>(CUSTOMERS_QUERY, {
      first: PAGE,
      after: cursor,
    })
    const nodes = data.customers?.nodes ?? []
    collected.push(...nodes)
    const pageInfo = data.customers?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    if (collected.length >= MAX_CUSTOMERS) {
      truncated = true
      break
    }
    cursor = pageInfo.endCursor
  }
  const result = computeRepeatRate(collected)
  return {
    ...result,
    partial: truncated,
    note: truncated
      ? `scan bounded to ${MAX_CUSTOMERS} customers, so repeatRatePct is over the scanned sample`
      : "repeat-purchase rate = share of customers with more than one order, computed over the whole customer base. A repeat-rate split by an arbitrary historical event window (e.g. Black Friday vs Modular Expo cohorts) is NOT provided: there is no first-order-date cohort tool and the store carries no such historical cohort; report this honestly rather than fabricating a cohort comparison.",
  }
}
