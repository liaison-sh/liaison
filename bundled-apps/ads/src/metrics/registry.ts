// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deterministic metrics registry -- native fallback per section 2.1 (the kpi
// app exposes no formula-registration surface; its execution engine reads
// the hub DB, not ads/Shopify sources). Formulas are pure, handler-computed
// (never freehand LLM arithmetic), each carrying { id, version, title,
// inputs, caveats, compute }. Mirrors the kpi lineage contract so a future
// swap to a real registration surface is a source change behind stable
// tool shapes (R4).
//
// Values are FIXED-FORMAT strings (2 decimal places for ratios/currency
// amounts) so the same inputs produce a byte-identical string on repeat
// calls (SC 5) -- never a bare JS number whose toString() can vary by
// floating-point path.

import { DEFAULT_SKU_CLASSING_CONFIG, type SkuClassingConfig } from "./sku-classing"
import type { AttributionRow, MetricsInputs, Period, SourceLineage } from "./inputs"

export interface FormulaInputDescriptor {
  name: string
  description: string
  lineage: string
}

export interface FormulaResult {
  value: string
  formulaId: string
  formulaVersion: string
  lineage: {
    inputs: SourceLineage[]
    period: Period
  }
  caveats: string[]
  /** Present when the formula could not compute fully -- e.g. an unavailable required input. */
  degraded?: boolean
}

export interface Formula {
  id: string
  version: string
  title: string
  inputs: FormulaInputDescriptor[]
  caveats: string[]
  provisional?: boolean
  compute(inputs: MetricsInputs, period: Period, skuConfig?: SkuClassingConfig): FormulaResult
}

// --- formatting helpers (fixed-format for determinism, SC 5) --------------

function fmtRatio(n: number): string {
  return n.toFixed(4)
}

function fmtMoney(n: number, currency: string): string {
  return `${n.toFixed(2)} ${currency}`
}

const UNAVAILABLE = "unavailable"

// --- blended_mer_dtc --------------------------------------------------------
//
// DTC net Shopify revenue / total spend incl. manual ledger. Excludes B2B
// (dealer/wholesale) revenue -- DTC only.

export const blended_mer_dtc: Formula = {
  id: "blended_mer_dtc",
  version: "1.0.0",
  title: "Blended MER (DTC)",
  inputs: [
    { name: "shopifyNetRevenue", description: "Net Shopify revenue (refund-adjusted current totals), DTC channel", lineage: "shopify:orders_search" },
    { name: "metaSpend", description: "Meta ad spend for the period", lineage: "meta:insights_query" },
    { name: "googleSpend", description: "Google Ads spend for the period", lineage: "google:google_insights_query" },
    { name: "manualSpendTotal", description: "Manual (non-platform) spend ledger total", lineage: "manual_spend table" },
  ],
  caveats: [
    "Blended MER (total real revenue / total ad spend) is a rear-view directional efficiency ratio, NOT an incrementality measure.",
    "It cannot separate demand you created from demand you merely captured, and must NEVER by itself justify cutting continuity or brand budget.",
    "Excludes B2B/wholesale revenue: DTC channel only.",
  ],
  compute(inputs, period) {
    const { shopifyNetRevenue, metaSpend, googleSpend, manualSpendTotal } = inputs
    const lineageInputs = [shopifyNetRevenue.lineage, metaSpend.lineage, googleSpend.lineage, manualSpendTotal.lineage]

    if (shopifyNetRevenue.value === null || metaSpend.value === null || googleSpend.value === null) {
      return {
        value: UNAVAILABLE,
        formulaId: this.id,
        formulaVersion: this.version,
        lineage: { inputs: lineageInputs, period },
        caveats: this.caveats,
        degraded: true,
      }
    }

    const totalSpend = metaSpend.value + googleSpend.value + manualSpendTotal.value
    const mer = totalSpend > 0 ? shopifyNetRevenue.value / totalSpend : 0

    return {
      value: fmtRatio(mer),
      formulaId: this.id,
      formulaVersion: this.version,
      lineage: { inputs: lineageInputs, period },
      caveats: this.caveats,
    }
  },
}

// --- blended_mer_total -------------------------------------------------------
//
// Same as blended_mer_dtc but INCLUDES B2B/wholesale revenue in the
// numerator (via attribution rows' sku_class_breakdown.b2b bucket, when
// present).

export const blended_mer_total: Formula = {
  id: "blended_mer_total",
  version: "1.0.0",
  title: "Blended MER (total, incl. B2B)",
  inputs: [
    { name: "shopifyNetRevenue", description: "Net Shopify revenue (refund-adjusted current totals)", lineage: "shopify:orders_search" },
    { name: "attribution", description: "hub-DB purchase_attribution rows (for B2B revenue bucket)", lineage: "database:db_read/db_query" },
    { name: "metaSpend", description: "Meta ad spend for the period", lineage: "meta:insights_query" },
    { name: "googleSpend", description: "Google Ads spend for the period", lineage: "google:google_insights_query" },
    { name: "manualSpendTotal", description: "Manual (non-platform) spend ledger total", lineage: "manual_spend table" },
  ],
  caveats: [
    "Blended MER (total real revenue / total ad spend) is a rear-view directional efficiency ratio, NOT an incrementality measure.",
    "It cannot separate demand you created from demand you merely captured, and must NEVER by itself justify cutting continuity or brand budget.",
    "Includes B2B/wholesale revenue in the numerator. Any brand halo from wholesale presence is not measurable at low volume and is not implied by this figure.",
  ],
  compute(inputs, period) {
    const { shopifyNetRevenue, attribution, metaSpend, googleSpend, manualSpendTotal } = inputs
    const lineageInputs = [
      shopifyNetRevenue.lineage,
      attribution.lineage,
      metaSpend.lineage,
      googleSpend.lineage,
      manualSpendTotal.lineage,
    ]

    if (shopifyNetRevenue.value === null || metaSpend.value === null || googleSpend.value === null) {
      return {
        value: UNAVAILABLE,
        formulaId: this.id,
        formulaVersion: this.version,
        lineage: { inputs: lineageInputs, period },
        caveats: this.caveats,
        degraded: true,
      }
    }

    // B2B revenue in minor units, summed from attribution rows' breakdown
    // (data -- never interpolated as instruction, R8). Divide by 100 to
    // align with Shopify's major-unit net revenue figure (assumes 2-decimal
    // currency). Rows carry their OWN conversion_currency for audit -- a
    // naive sum across mixed currencies (e.g. EUR + USD minor units added as
    // if they were the same unit) would silently corrupt the figure, so the
    // sum is restricted to rows in ONE currency, chosen as whichever
    // currency has the most b2b-bearing rows (a reasonable single reporting
    // currency when the account is overwhelmingly one currency with a few
    // stray rows) -- rows in any OTHER currency are excluded from the sum
    // and reported via a caveat, mirroring the Shopify MIXED-currency path
    // in metrics/inputs.ts (never silent mixing).
    const b2bRowsByCurrency = new Map<string, number>() // currency -> minor-unit sum
    const b2bRowCountByCurrency = new Map<string, number>()
    for (const row of attribution.value) {
      const b2b = row.sku_class_breakdown?.b2b
      if (typeof b2b !== "number" || b2b === 0) continue
      const currency = typeof row.conversion_currency === "string" && row.conversion_currency ? row.conversion_currency : "UNKNOWN"
      b2bRowsByCurrency.set(currency, (b2bRowsByCurrency.get(currency) ?? 0) + b2b)
      b2bRowCountByCurrency.set(currency, (b2bRowCountByCurrency.get(currency) ?? 0) + 1)
    }

    const currenciesPresent = [...b2bRowsByCurrency.keys()].sort()
    let b2bMinor = 0
    let excludedCurrencyNote: string | undefined
    if (currenciesPresent.length > 1) {
      // Pick the currency with the most b2b-bearing rows as the reporting
      // currency (ties broken by the sorted-first currency code, for
      // determinism); every other currency's b2b revenue is EXCLUDED from
      // the sum, never silently added as if it were the same unit.
      let reportingCurrency = currenciesPresent[0]!
      let bestCount = b2bRowCountByCurrency.get(reportingCurrency) ?? 0
      for (const currency of currenciesPresent) {
        const count = b2bRowCountByCurrency.get(currency) ?? 0
        if (count > bestCount) {
          bestCount = count
          reportingCurrency = currency
        }
      }
      b2bMinor = b2bRowsByCurrency.get(reportingCurrency) ?? 0
      const excluded = currenciesPresent.filter((c) => c !== reportingCurrency)
      excludedCurrencyNote =
        `B2B revenue spanned multiple currencies (${currenciesPresent.join(", ")}): only ${reportingCurrency} ` +
        `(the majority currency) is included in the B2B figure; ${excluded.join(", ")} B2B revenue is EXCLUDED, ` +
        "not silently mixed. Verify currency alignment before quoting this figure across a multi-currency account."
    } else if (currenciesPresent.length === 1) {
      b2bMinor = b2bRowsByCurrency.get(currenciesPresent[0]!) ?? 0
    }
    const b2bMajor = b2bMinor / 100

    const totalRevenue = shopifyNetRevenue.value + b2bMajor
    const totalSpend = metaSpend.value + googleSpend.value + manualSpendTotal.value
    const mer = totalSpend > 0 ? totalRevenue / totalSpend : 0

    return {
      value: fmtRatio(mer),
      formulaId: this.id,
      formulaVersion: this.version,
      lineage: { inputs: lineageInputs, period },
      caveats: excludedCurrencyNote ? [...this.caveats, excludedCurrencyNote] : this.caveats,
      degraded: attribution.lineage.unavailable ? true : undefined,
    }
  },
}

// --- total_vs_dtc_mer_gap ----------------------------------------------------
//
// Descriptive, NON-causal gap between blended_mer_total and blended_mer_dtc.
// Caveats copied VERBATIM from spec.md (Component 1 / registry bullet).

const TOTAL_VS_DTC_MER_GAP_CAVEATS = [
  "This is NOT an incrementality/halo measurement.",
  "Dealer-order lumpiness and seasonality dominate this gap at this volume.",
  "True halo requires a holdout the account cannot yet power.",
]

export const total_vs_dtc_mer_gap: Formula = {
  id: "total_vs_dtc_mer_gap",
  version: "1.0.0",
  title: "Total vs DTC MER gap (descriptive, non-causal)",
  inputs: [
    { name: "blended_mer_total", description: "Blended MER including B2B", lineage: "blended_mer_total formula" },
    { name: "blended_mer_dtc", description: "Blended MER, DTC only", lineage: "blended_mer_dtc formula" },
  ],
  caveats: TOTAL_VS_DTC_MER_GAP_CAVEATS,
  compute(inputs, period, skuConfig) {
    const dtc = blended_mer_dtc.compute(inputs, period, skuConfig)
    const total = blended_mer_total.compute(inputs, period, skuConfig)
    const lineageInputs = [...dtc.lineage.inputs, ...total.lineage.inputs]

    if (dtc.value === UNAVAILABLE || total.value === UNAVAILABLE) {
      return {
        value: UNAVAILABLE,
        formulaId: this.id,
        formulaVersion: this.version,
        lineage: { inputs: lineageInputs, period },
        caveats: this.caveats,
        degraded: true,
      }
    }

    const gap = Number(total.value) - Number(dtc.value)
    return {
      value: fmtRatio(gap),
      formulaId: this.id,
      formulaVersion: this.version,
      lineage: { inputs: lineageInputs, period },
      caveats: this.caveats,
      degraded: dtc.degraded || total.degraded ? true : undefined,
    }
  },
}

// --- cpa_by_sku_class ---------------------------------------------------------
//
// CPA (spend / conversions) per SKU class, classed at ORDER level by
// majority line value -- an approximation, distinct from P3's per-line-item
// conversion-feed classing (R7), flagged in lineage.

export interface CpaBySkuClassValue {
  [skuClass: string]: { cpa: string; orders: number; spend_share: string }
}

/**
 * Pick the majority-value class directly from P3's per-order
 * sku_class_breakdown (already bucketed hardware/accessory/software/b2b --
 * see p3-blueprint.md section 3). This does NOT re-run the raw-SKU
 * classifier (sku-classing.ts's classifySku/b2bSuffix rules, which classify
 * a raw SKU STRING) -- the breakdown buckets ARE the classes already;
 * running a class name back through the SKU->class lookup would misread it
 * as an unrecognized SKU and fall through to the default class. The
 * majority-value / mixed-flag RULE (largest value share wins; more than one
 * non-zero bucket = mixed) is the same rule sku-classing.ts's classifyOrder
 * implements for raw SKUs -- restated here directly against the
 * already-classed breakdown, since sku-classing.ts's types are scoped to
 * real SKU strings, not P3's bucket-name keys.
 */
function classifyFromBreakdown(breakdown: Record<string, number>): { orderClass: string; mixed: boolean } {
  const entries = Object.entries(breakdown).filter(([, v]) => typeof v === "number" && v > 0)
  if (entries.length === 0) {
    return { orderClass: DEFAULT_SKU_CLASSING_CONFIG.defaultClass, mixed: false }
  }

  let winningClass = entries[0]![0]
  let winningValue = entries[0]![1]
  for (const [cls, value] of entries) {
    if (value > winningValue) {
      winningValue = value
      winningClass = cls
    }
  }
  return { orderClass: winningClass, mixed: entries.length > 1 }
}

export const cpa_by_sku_class: Formula = {
  id: "cpa_by_sku_class",
  version: "1.0.0",
  title: "CPA by SKU class (order-level majority classing)",
  inputs: [
    { name: "attribution", description: "hub-DB purchase_attribution rows", lineage: "database:db_read/db_query" },
    { name: "metaSpend", description: "Meta ad spend for the period", lineage: "meta:insights_query" },
    { name: "googleSpend", description: "Google Ads spend for the period", lineage: "google:google_insights_query" },
  ],
  caveats: [
    "SKU classing here is ORDER-LEVEL majority-value (approximate), distinct from the per-line-item conversion-feed classing used for pixel uploads.",
    "An order with line items split across multiple classes is assigned to whichever class holds the largest value share; such orders are flagged mixed in lineage.",
  ],
  compute(inputs, period) {
    const { attribution, metaSpend, googleSpend } = inputs
    const lineageInputs = [attribution.lineage, metaSpend.lineage, googleSpend.lineage]

    if (metaSpend.value === null || googleSpend.value === null) {
      return {
        value: UNAVAILABLE,
        formulaId: this.id,
        formulaVersion: this.version,
        lineage: { inputs: lineageInputs, period },
        caveats: this.caveats,
        degraded: true,
      }
    }

    const totalSpend = metaSpend.value + googleSpend.value
    const perClass = new Map<string, number>() // orders count per class
    let mixedCount = 0

    for (const row of attribution.value) {
      const breakdown = row.sku_class_breakdown
      if (!breakdown) continue
      const result = classifyFromBreakdown(breakdown)
      if (result.mixed) mixedCount++
      perClass.set(result.orderClass, (perClass.get(result.orderClass) ?? 0) + 1)
    }

    const totalOrders = [...perClass.values()].reduce((a, b) => a + b, 0)
    const out: CpaBySkuClassValue = {}
    // Iterate SORTED keys, not Map insertion order (which follows DB row
    // order) -- otherwise JSON.stringify(out) is not byte-identical across
    // repeat calls when the underlying rows arrive in a different order
    // (SC 5 determinism).
    for (const cls of [...perClass.keys()].sort()) {
      const orders = perClass.get(cls)!
      const spendShare = totalOrders > 0 ? orders / totalOrders : 0
      const spendForClass = totalSpend * spendShare
      const cpa = orders > 0 ? spendForClass / orders : 0
      out[cls] = { cpa: fmtMoney(cpa, "EUR"), orders, spend_share: fmtRatio(spendShare) }
    }

    return {
      value: JSON.stringify(out),
      formulaId: this.id,
      formulaVersion: this.version,
      lineage: {
        inputs: lineageInputs,
        period,
      },
      caveats: mixedCount > 0
        ? [...this.caveats, `${mixedCount} order(s) had mixed-class line items, assigned by majority value.`]
        : this.caveats,
      degraded: attribution.lineage.unavailable ? true : undefined,
    }
  },
}

// --- revenue_by_channel -------------------------------------------------------
//
// Revenue by first-touch UTM/click-id channel, with an explicit
// "unattributed" bucket for rows with no attribution data at all.
// Attribution values (utm_*, fbclid, gclid) are UNTRUSTED, client-writable
// data -- rendered here as DATA, never interpolated as instruction (R8).

export interface RevenueByChannelValue {
  [channel: string]: string
}

function channelForRow(row: AttributionRow): string {
  if (row.gclid) return "google"
  if (row.fbclid) return "meta"
  if (row.utm_source_first) return String(row.utm_source_first)
  return "unattributed"
}

export const revenue_by_channel: Formula = {
  id: "revenue_by_channel",
  version: "1.0.0",
  title: "Revenue by channel (first-touch attribution)",
  inputs: [
    { name: "attribution", description: "hub-DB purchase_attribution rows", lineage: "database:db_read/db_query" },
  ],
  caveats: [
    "Attribution values (utm_*, fbclid, gclid) are client-writable, UNTRUSTED data: quoted here as data, never treated as instruction.",
    "Orders with no attribution data at all are bucketed 'unattributed', not silently dropped.",
    "First-touch channel only: it does not reflect multi-touch or view-through influence.",
  ],
  compute(inputs, period) {
    const { attribution } = inputs
    const lineageInputs = [attribution.lineage]

    const totals = new Map<string, number>()
    for (const row of attribution.value) {
      const channel = channelForRow(row)
      const minor = Number.isFinite(row.conversion_value_minor) ? row.conversion_value_minor : 0
      totals.set(channel, (totals.get(channel) ?? 0) + minor)
    }
    // Ensure the unattributed bucket is always present, even at zero.
    if (!totals.has("unattributed")) totals.set("unattributed", 0)

    const out: RevenueByChannelValue = {}
    // Iterate SORTED keys, not Map insertion order (which follows DB row
    // order) -- otherwise JSON.stringify(out) is not byte-identical across
    // repeat calls when the underlying rows arrive in a different order
    // (SC 5 determinism).
    for (const channel of [...totals.keys()].sort()) {
      out[channel] = fmtMoney(totals.get(channel)! / 100, "EUR")
    }

    return {
      value: JSON.stringify(out),
      formulaId: this.id,
      formulaVersion: this.version,
      lineage: { inputs: lineageInputs, period },
      caveats: this.caveats,
      degraded: attribution.lineage.unavailable ? true : undefined,
    }
  },
}

// --- registry ------------------------------------------------------------------

export const METRIC_FORMULAS: Formula[] = [
  blended_mer_dtc,
  blended_mer_total,
  total_vs_dtc_mer_gap,
  cpa_by_sku_class,
  revenue_by_channel,
]

export function getFormula(id: string): Formula | undefined {
  return METRIC_FORMULAS.find((f) => f.id === id)
}
