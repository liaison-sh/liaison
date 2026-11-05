// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Order-level MAJORITY-value SKU classing for metrics reporting (hardware /
// accessory / software / B2B). Config-driven — the reference store's config is a
// `-B2B` SKU suffix + an explicit SKU list; other customers configure their
// own. DISTINCT from P3's per-line-item conversion-feed classing
// (commerce.purchase_attribution.sku_class_breakdown) — that classing is
// exact, per line item, and feeds the conversion pixel; this classing
// approximates at the ORDER level for metrics/reporting only and is always
// lineage-flagged as an approximation. Never share the two classing paths
// (R7) — this module must not import from, or be imported by, any P3/
// conversion-feed code.

export type SkuClass = "hardware" | "accessory" | "software" | "b2b"

export interface SkuClassingConfig {
  /** SKU suffix that marks an order as B2B (e.g. "-B2B"). Checked first — a B2B suffix wins regardless of other hints. */
  b2bSuffix: string
  /** Explicit SKU list -> class, for anything the suffix rule doesn't cover. */
  skuClassMap: Record<string, SkuClass>
  /** Default class for an unrecognized SKU. */
  defaultClass: SkuClass
}

export const DEFAULT_SKU_CLASSING_CONFIG: SkuClassingConfig = {
  b2bSuffix: "-B2B",
  skuClassMap: {},
  defaultClass: "hardware",
}


