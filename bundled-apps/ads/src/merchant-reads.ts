// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Merchant API read tools for the ads app. Both handlers resolve the
// token from the `google` OAuth2 connection + the Merchant account id from
// the `google-config` credentials connection, and call merchantFetch.
//
// The Merchant API has NO single global version — each sub-API is versioned
// independently. merchant_feed_status calls the Accounts sub-API
// (GET /accounts/v1/accounts/{merchantId}/aggregateProductStatuses);
// merchant_product_issues calls the Products sub-API
// (GET /products/v1/accounts/{merchantId}/products). Verified against
// developers.google.com/merchant/api 2026-07-07.
//
// merchant_product_issues tags every disapproval product-data vs
// non-product-data (spec SC-3): product-data issues carry a Shopify-edit hint
// (data only — the agent PROPOSES a shopify:products_update, never calls it
// from here); non-product-data issues carry an informational string built
// from the issue's detail/documentation/resolution (v1 has NO
// recommendedAction field), with no tool path.

import { GoogleConfigError, getMerchantClient } from "./lib/google-config"
import { classifyIssue, merchantFetch } from "./lib/merchant-client"

interface MerchantReadCtx {
  connections: unknown
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && v !== "") return Number(v)
  return 0
}

// ─── merchant_feed_status ──────────────────────────────────────────────────────
//
// GET /accounts/v1/accounts/{merchantId}/aggregateProductStatuses
// Response: { aggregateProductStatuses: [ { reportingContext, countryCode,
//   stats: { activeCount, disapprovedCount, pendingCount, expiringCount },
//   itemLevelIssues: [ { code, numProducts, ... } ] }, ... ] }
// One entry per (reportingContext, countryCode) pair — iterate and sum.

interface AggregateProductStatusStats {
  activeCount?: string | number
  disapprovedCount?: string | number
  pendingCount?: string | number
  expiringCount?: string | number
}

interface AggregateProductStatusItemIssue {
  code?: string
  numProducts?: string | number
}

interface AggregateProductStatusEntry {
  reportingContext?: string
  countryCode?: string
  stats?: AggregateProductStatusStats
  itemLevelIssues?: AggregateProductStatusItemIssue[]
}

interface AggregateProductStatusesResponse {
  aggregateProductStatuses?: AggregateProductStatusEntry[]
}

export async function merchant_feed_status(
  _params: Record<string, never>,
  ctx: MerchantReadCtx,
): Promise<unknown> {
  let client: Awaited<ReturnType<typeof getMerchantClient>>
  try {
    client = await getMerchantClient(ctx)
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      return { error: { code: "google_not_connected", message: err.message } }
    }
    throw err
  }
  const { auth, config } = client
  if (!config.merchantId) {
    return {
      error: {
        code: "merchant_not_configured",
        message:
          "No Merchant Center account id is configured (google-config merchantId is empty). Merchant Center is optional: add the id in the ads app's Google Ads Config connection to enable feed reads.",
      },
    }
  }

  const resp = (await merchantFetch(ctx.fetch, {
    // Sub-API is issueresolution (NOT accounts): verified live 2026-07-07 —
    // /accounts/v1/.../aggregateProductStatuses is an HTML 404, while
    // /issueresolution/v1/... routes (401 when unauthenticated).
    path: `/issueresolution/v1/accounts/${config.merchantId}/aggregateProductStatuses`,
    auth,
  })) as AggregateProductStatusesResponse

  const entries = resp.aggregateProductStatuses ?? []

  let approved = 0
  let disapproved = 0
  let pending = 0
  let expiring = 0
  // One labeled row per (reportingContext, country) with a real issue count —
  // the raw response carries one entry per context x country combination,
  // most of them empty; unlabeled zero rows are noise for the agent.
  const by_destination: Array<{ destination: string; country?: string; num_items: number }> = []

  for (const entry of entries) {
    approved += asNumber(entry.stats?.activeCount)
    disapproved += asNumber(entry.stats?.disapprovedCount)
    pending += asNumber(entry.stats?.pendingCount)
    expiring += asNumber(entry.stats?.expiringCount)
    const issueItems = (entry.itemLevelIssues ?? []).reduce(
      (acc, issue) => acc + asNumber(issue.numProducts),
      0,
    )
    if (issueItems > 0) {
      by_destination.push({
        destination: entry.reportingContext ?? "UNKNOWN",
        ...(entry.countryCode ? { country: entry.countryCode } : {}),
        num_items: issueItems,
      })
    }
  }
  by_destination.sort((a, b) => b.num_items - a.num_items)

  return {
    total: approved + disapproved,
    approved,
    disapproved,
    pending,
    expiring,
    by_destination,
  }
}

// ─── merchant_product_issues ────────────────────────────────────────────────────
//
// GET /products/v1/accounts/{merchantId}/products
// Response: { products: [ { name, productStatus: { itemLevelIssues: [
//   { code, description, detail, resolution, documentation, ... } ] } }, ... ] }
// v1 has NO recommendedAction field — the informational string for
// non-product-data issues is built from detail/documentation/resolution.
// A fixture-compat fallback also reads a top-level itemLevelIssues[] (older
// test fixtures / a possible flattened shape) if productStatus is absent.

interface MerchantProductIssue {
  code?: string
  description?: string
  detail?: string
  resolution?: string
  documentation?: string
  recommendedAction?: string // fixture-compat only — not a real v1 field
}

interface MerchantProduct {
  productId?: string
  name?: string
  title?: string
  productStatus?: { itemLevelIssues?: MerchantProductIssue[] }
  itemLevelIssues?: MerchantProductIssue[] // fixture-compat fallback
}

interface MerchantProductsResponse {
  products?: MerchantProduct[]
}

interface ProductIssuesParams {
  limit?: number
}

/** Build the informational guidance string for a non-product-data issue (v1 has no recommendedAction). */
function informationalString(issue: MerchantProductIssue, code: string): string {
  return (
    issue.recommendedAction ??
    issue.detail ??
    issue.documentation ??
    issue.resolution ??
    issue.description ??
    `See Merchant Center for details on ${code}`
  )
}

export async function merchant_product_issues(
  params: ProductIssuesParams,
  ctx: MerchantReadCtx,
): Promise<unknown> {
  let client: Awaited<ReturnType<typeof getMerchantClient>>
  try {
    client = await getMerchantClient(ctx)
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      return { error: { code: "google_not_connected", message: err.message } }
    }
    throw err
  }
  const { auth, config } = client
  if (!config.merchantId) {
    return {
      error: {
        code: "merchant_not_configured",
        message:
          "No Merchant Center account id is configured (google-config merchantId is empty). Merchant Center is optional: add the id in the ads app's Google Ads Config connection to enable feed reads.",
      },
    }
  }

  const resp = (await merchantFetch(ctx.fetch, {
    path: `/products/v1/accounts/${config.merchantId}/products`,
    auth,
  })) as MerchantProductsResponse

  const rawProducts = resp.products ?? []
  const limited =
    typeof params.limit === "number" ? rawProducts.slice(0, params.limit) : rawProducts

  const products = limited.map((p) => {
    const rawIssues = p.productStatus?.itemLevelIssues ?? p.itemLevelIssues ?? []
    const issues = rawIssues.map((issue) => {
      const code = issue.code ?? "unknown"
      const { klass } = classifyIssue(code)
      const base = {
        code,
        klass,
        description: issue.description,
        detail: issue.detail,
      } as Record<string, unknown>

      if (klass === "product-data") {
        // Data-only hint — the agent proposes a shopify:products_update for
        // human review; this tool never calls that write itself.
        base.shopify_edit_hint = `Review and update the Shopify product's ${issue.description ?? code} via shopify__products_update (do not call it automatically)`
      } else {
        // Non-product-data — informational guidance built from
        // detail/documentation/resolution (v1 has no recommendedAction),
        // explicitly WITHOUT a tool path.
        base.recommended_action = informationalString(issue, code)
      }
      return base
    })

    return {
      product_id: p.productId ?? p.name,
      title: p.title,
      issues,
    }
  })

  return { products, count: products.length }
}
