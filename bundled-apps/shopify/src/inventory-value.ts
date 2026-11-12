// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `inventory_value` — total retail value of stock on hand across the whole catalog
// (BL-169 #2, impossible→works_today). Shopify exposes per-variant on-hand quantity +
// selling price but NO inventory-valuation aggregate and NO unit COST, so a "what is our
// inventory worth?" answer required iterating every variant — beyond a 10-step agent turn.
// This server-side tool does that iteration in ONE call: paginate productVariants, sum
// inventoryQuantity × price, and report the total + a per-SKU breakdown, honestly labelled
// RETAIL value (selling price, not COGS — no cost basis exists in Shopify).

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "./lib/get-client"

const VARIANTS_QUERY = `
  query InventoryValue($first: Int!, $after: String) {
    productVariants(first: $first, after: $after) {
      nodes { id sku title displayName price inventoryQuantity }
      pageInfo { hasNextPage endCursor }
    }
  }`

const SHOP_CURRENCY_QUERY = `query { shop { currencyCode } }`

const PAGE = 250
const MAX_VARIANTS = 2000 // bound the scan; flag `partial` if the catalog exceeds it

export interface VariantValuationInput {
  sku: string | null
  title: string | null
  displayName: string | null
  price: string | null
  inventoryQuantity: number | null
}

export interface InventoryValuation {
  totalInventoryValue: number
  basis: "retail"
  valuedVariants: number
  variantsScanned: number
  variantsMissingPrice: number
  topByValue: Array<{
    sku: string
    title: string
    onHand: number
    unitPrice: number
    value: number
  }>
}

/** Pure valuation: sum inventoryQuantity × price across variants. Variants with no
 *  parseable price are counted (variantsMissingPrice) and excluded; on-hand ≤ 0 adds
 *  nothing. Kept pure so the arithmetic is unit-testable without the live Shopify client. */
export function computeInventoryValue(variants: VariantValuationInput[]): InventoryValuation {
  let total = 0
  let valued = 0
  let missingPrice = 0
  const rows: InventoryValuation["topByValue"] = []
  for (const v of variants) {
    const onHand = typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : 0
    const price = v.price != null ? Number.parseFloat(v.price) : Number.NaN
    if (Number.isNaN(price)) {
      missingPrice++
      continue
    }
    if (onHand <= 0) continue
    const value = onHand * price
    total += value
    valued++
    rows.push({
      sku: v.sku ?? v.displayName ?? "(unknown)",
      title: v.title ?? v.displayName ?? "",
      onHand,
      unitPrice: price,
      value: Math.round(value * 100) / 100,
    })
  }
  rows.sort((a, b) => b.value - a.value)
  return {
    totalInventoryValue: Math.round(total * 100) / 100,
    basis: "retail",
    valuedVariants: valued,
    variantsScanned: variants.length,
    variantsMissingPrice: missingPrice,
    topByValue: rows.slice(0, 20),
  }
}

interface VariantsPage {
  productVariants?: {
    nodes?: VariantValuationInput[]
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
  }
}
interface ShopCurrency {
  shop?: { currencyCode?: string }
}

export async function inventory_value(
  _params: Record<string, unknown>,
  ctx: AppContext,
): Promise<unknown> {
  const client = await getShopifyClient(ctx)
  const collected: VariantValuationInput[] = []
  let cursor: string | null = null
  let truncated = false
  for (;;) {
    const data: VariantsPage = await client.query<VariantsPage>(VARIANTS_QUERY, {
      first: PAGE,
      after: cursor,
    })
    const nodes = data.productVariants?.nodes ?? []
    collected.push(...nodes)
    const pageInfo = data.productVariants?.pageInfo
    if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break
    if (collected.length >= MAX_VARIANTS) {
      truncated = true
      break
    }
    cursor = pageInfo.endCursor
  }

  let currency: string | null = null
  try {
    const shop: ShopCurrency = await client.query<ShopCurrency>(SHOP_CURRENCY_QUERY)
    currency = shop.shop?.currencyCode ?? null
  } catch {
    // currency is best-effort labelling; the numeric total stands without it
  }

  const valuation = computeInventoryValue(collected)
  return {
    ...valuation,
    currency,
    partial: truncated,
    note: truncated
      ? `scan bounded to ${MAX_VARIANTS} variants, so the total is a lower bound`
      : "RETAIL value: on-hand quantity × selling price across all locations. Shopify exposes no unit cost, so this is retail (sell-through) value, not COGS / cost-basis inventory value.",
  }
}
