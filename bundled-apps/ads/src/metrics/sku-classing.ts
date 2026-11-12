// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Order-level classing for metrics reporting (hardware / accessory / software
// / B2B). B2B is a fact about the ORDER, not about a sku: an order is B2B when
// it is placed for a Shopify B2B company, or carries one of the org's B2B order
// tags, or (legacy, for stores that once sold wholesale through suffixed sku
// variants) a line sku ends with one of the org's B2B sku suffixes. The shopify
// app decides it from the org's settings and puts the verdict on every order
// search hit (`attributes.b2bOrder`); `orderHitIsB2b` reads it, and only falls
// back to the hit's own signals (company, default tag, default suffix) for a
// hit from an older shopify bundle that carries no verdict.
//
// A B2B order is B2B as a whole. The product classes (hardware / accessory /
// software) apply to the other orders, per sku, from the per-order
// sku_class_breakdown that the hub writes into commerce.purchase_attribution
// (exact, per line item, it also feeds the conversion pixel). The order-level
// majority-value classing here is an approximation for metrics/reporting only
// and is always lineage-flagged as such. Never share the two classing paths
// (R7): this module must not import from, or be imported by, conversion-feed
// code.

export type SkuClass = "hardware" | "accessory" | "software" | "b2b"

export interface SkuClassingConfig {
  /**
   * Fallback only, for an order hit that carries no `b2bOrder` verdict: the
   * order tags that mark an order B2B (compared without case).
   */
  b2bOrderTags: string[]
  /** Fallback only (legacy): the sku suffix that marks an order B2B (e.g. "-B2B"). */
  b2bSuffix: string
  /** Explicit SKU list -> class, for anything the order-level B2B rule doesn't cover. */
  skuClassMap: Record<string, SkuClass>
  /** Default class for an unrecognized SKU. */
  defaultClass: SkuClass
}

export const DEFAULT_SKU_CLASSING_CONFIG: SkuClassingConfig = {
  b2bOrderTags: ["B2B"],
  b2bSuffix: "-B2B",
  skuClassMap: {},
  defaultClass: "hardware",
}

/** The parts of a `shopify:orders_search` hit the B2B rule reads. */
export interface OrderHitB2bSignals {
  id?: string | null
  attributes?: {
    b2bOrder?: { b2b?: unknown } | null
    b2bCompany?: unknown
    tags?: unknown
    lineItems?: unknown
  } | null
}

/**
 * Is this order B2B? The shopify app's verdict (`attributes.b2bOrder.b2b`)
 * wins. Without one: a company buyer, a B2B order tag, or a line sku with the
 * B2B suffix (the config's fallback values).
 */
export function orderHitIsB2b(
  hit: OrderHitB2bSignals | null | undefined,
  config: SkuClassingConfig = DEFAULT_SKU_CLASSING_CONFIG,
): boolean {
  const attrs = hit?.attributes ?? {}
  const verdict = attrs.b2bOrder
  if (verdict && typeof verdict.b2b === "boolean") return verdict.b2b
  if (attrs.b2bCompany) return true
  const b2bTags = config.b2bOrderTags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)
  const tags = Array.isArray(attrs.tags) ? attrs.tags : []
  if (tags.some((t) => typeof t === "string" && b2bTags.includes(t.trim().toLowerCase())))
    return true
  const suffix = config.b2bSuffix.trim().toLowerCase()
  if (!suffix) return false
  const lines = Array.isArray(attrs.lineItems) ? attrs.lineItems : []
  return lines.some((l) => {
    const sku = l && typeof l === "object" ? (l as { sku?: unknown }).sku : null
    return typeof sku === "string" && sku.trim().toLowerCase().endsWith(suffix)
  })
}

/**
 * The numeric Shopify order id from a gid (`gid://shopify/Order/123`) or a
 * plain id (`123`), so search hits and attribution rows join on one key.
 */
export function shopifyOrderKey(id: unknown): string | null {
  if (typeof id !== "string" && typeof id !== "number") return null
  const m = /(\d+)\s*$/.exec(String(id))
  return m ? m[1]! : null
}
