// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Merchant API client — the single outbound HTTP path for the Merchant
// Center arm of the ads app. Separate host from Google Ads; same Bearer token
// (the `google` OAuth2 connection's `content` scope), NO developer-token /
// login-customer-id headers (those are Google-Ads-only).
//
// IMPORTANT: unlike Google Ads, the Merchant API has NO single global version
// prefix. It is a family of independently-versioned sub-APIs mounted at
// different path segments, each with its own major version, e.g.:
//   /accounts/v1/...   (Accounts sub-API — aggregateProductStatuses lives here)
//   /products/v1/...   (Products sub-API — the products list lives here)
// `merchantFetch` therefore does NOT prepend a version — callers pass a path
// that already includes its own sub-API + version segment (e.g.
// "/accounts/v1/accounts/123/aggregateProductStatuses"), or pass `subApi` +
// `version` options and let this function assemble the path.
//
// Grounded in research-corpus §11: Merchant API (NOT the legacy Content API,
// dies 2026-08-18).

import { parseGoogleAdsError } from "./google-error"

export const MERCHANT_API_BASE = "https://merchantapi.googleapis.com"

export type MerchantFetch = (
  url: string,
  opts?: Record<string, unknown>,
) => Promise<unknown>

interface FetchResult {
  status: number
  headers?: Record<string, string>
  body: string
}

export interface MerchantFetchOptions {
  // Either pass a fully-qualified path (already carrying its own sub-API +
  // version segment, e.g. "/accounts/v1/accounts/123/aggregateProductStatuses"),
  // OR pass subApi + version and a version-less path and let this function
  // assemble `/{subApi}/{version}{path}`.
  path: string
  subApi?: string
  version?: string
  method?: "GET" | "POST"
  token: string
}

/** Single outbound HTTP path to the Merchant API. Bearer token only — no Ads headers. */
export async function merchantFetch(fetch: MerchantFetch, opts: MerchantFetchOptions): Promise<unknown> {
  const prefix = opts.subApi ? `/${opts.subApi}/${opts.version ?? "v1"}` : ""
  const url = `${MERCHANT_API_BASE}${prefix}${opts.path}`
  const result = (await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    },
  })) as FetchResult

  if (result.status < 200 || result.status >= 300) {
    // Merchant API uses the same Google error envelope shape as Google Ads
    // (top-level {code,status,message}); the GoogleAdsFailure detail block is
    // Ads-specific and simply won't be present, so the parser falls back to
    // the top-level message — still surfaces status+code correctly.
    throw parseGoogleAdsError(result.body, result.status)
  }

  return JSON.parse(result.body)
}

// ─── Product-data vs non-product-data issue taxonomy (spec SC-3) ──────────────

export type IssueClass = "product-data" | "non-product-data"

export interface IssueClassification {
  klass: IssueClass
}

// Seeded from research §8 / spec SC-3. PRODUCT-DATA issues are ones a Shopify
// product edit can fix (title, description, price mismatch, GTIN,
// availability). NON-PRODUCT-DATA issues are account/site-level and have no
// Shopify-side fix (landing page, shipping/tax settings, business
// verification, policy). Unknown codes default to non-product-data — safe,
// surfaced informationally, never auto-routed to a Shopify write.
const PRODUCT_DATA_PATTERNS = [
  /^title_/,
  /^description_/,
  /^price_/,
  /^gtin_/,
  /^mpn_/,
  /^availability_/,
  /^image_/,
  /^identifier_/,
  /^condition_/,
  /^brand_/,
]

const NON_PRODUCT_DATA_PATTERNS = [
  /^landing_page/,
  /^shipping_/,
  /^tax_/,
  /^account_/,
  /^policy_/,
  /^website_/,
  /^business_/,
  /^destination_/,
]

export function classifyIssue(code: string): IssueClassification {
  const c = code.toLowerCase()
  if (PRODUCT_DATA_PATTERNS.some((re) => re.test(c))) return { klass: "product-data" }
  if (NON_PRODUCT_DATA_PATTERNS.some((re) => re.test(c))) return { klass: "non-product-data" }
  // Unknown code — default non-product-data (never auto-routed to a Shopify write).
  return { klass: "non-product-data" }
}
