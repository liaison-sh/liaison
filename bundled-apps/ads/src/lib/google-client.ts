// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Google Ads REST API client — the single outbound HTTP path for the Google
// Ads arm of the ads app. All Google Ads read handlers compose calls through
// `gaqlSearch`. Never import node:* or npm SDKs.

import { parseGoogleAdsError } from "./google-error"

// ─── Version pin ────────────────────────────────────────────────────────────

// The current stable Google Ads API major. Confirmed 2026-10-31 via
// developers.google.com/google-ads/api/docs/release-notes: v26 (v26.1,
// 2026-10-28) is the latest; the v25 and v26 breaking changes touch none of the
// resources, fields or mutates this app uses (lifecycle goals, incentives,
// hotel bid modifiers, Local Services, reach planning). It is the stable major (v18 is long since sunset — the API keeps three
// majors live at a time and sunsets the oldest with each new release).
// Single constant; never scatter version literals across the app. Confirm
// the latest GA version at build time if this drifts; never target a `vNbeta`.
export const GOOGLE_ADS_API_VERSION = "v26"

export const GOOGLE_ADS_BASE = "https://googleads.googleapis.com"

// ─── Micros conversion ────────────────────────────────────────────────────────

// Google Ads money fields (cost_micros, amount_micros, conversions_value)
// are integer micros. Convert with microsToMajor at the tool boundary only —
// never rescale by 100 (that is the Meta minor-unit path; Google is micros).
export const MICROS = 1_000_000

export function microsToMajor(micros: number): number {
  return micros / MICROS
}

// ─── Fetch shape ──────────────────────────────────────────────────────────────

// Deliberately the loose handler/sandbox shape (mirrors MetaFetch in
// meta-client.ts) — assignable from the real AppContext["fetch"] without
// narrowing every ctx interface + test mock.
export type GoogleFetch = (
  url: string,
  opts?: Record<string, unknown>,
) => Promise<unknown>

interface FetchResult {
  status: number
  headers?: Record<string, string>
  body: string
}

/** Strip dashes from a Google Ads customer id (URL path + login-customer-id header never carry dashes). */
function stripDashes(raw: string): string {
  return raw.replace(/-/g, "")
}

/** The request headers. Never `developer-token` (see gaqlSearch). */
function adsHeaders(token: string, loginCustomerId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "login-customer-id": loginCustomerId,
    "Content-Type": "application/json",
  }
}

// ─── searchStream batch shape ──────────────────────────────────────────────────

interface SearchStreamBatch {
  results?: unknown[]
}

export interface GaqlSearchOptions {
  customerId: string
  query: string
  token: string
  loginCustomerId: string
}

/**
 * GAQL search via `googleAds:searchStream` — the pinned default read path
 * (per P4 blueprint §5). Returns the full result set flattened across
 * batches. Every call carries:
 *   Authorization: Bearer <token>
 *   login-customer-id: <loginCustomerId> (digits only, no dashes)
 *   Content-Type: application/json
 * and NEVER a developer-token header. Developer tokens were retired on
 * 2026-09-09: access levels now belong to the Google Cloud project of the OAuth
 * client, the header is "optional and ignored", and Google will start
 * rejecting it in a future major version
 * (developers.google.com/google-ads/api/docs/api-policy/developer-token). A
 * legacy token in an old config is accepted and ignored.
 * customerId goes in the URL path (digits only, dashes stripped), not a header.
 */
export async function gaqlSearch(
  fetch: GoogleFetch,
  opts: GaqlSearchOptions,
): Promise<unknown[]> {
  const customerId = stripDashes(opts.customerId)
  const loginCustomerId = stripDashes(opts.loginCustomerId)
  const url = `${GOOGLE_ADS_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:searchStream`

  const result = (await fetch(url, {
    method: "POST",
    headers: adsHeaders(opts.token, loginCustomerId),
    body: JSON.stringify({ query: opts.query }),
  })) as FetchResult

  if (result.status < 200 || result.status >= 300) {
    throw parseGoogleAdsError(result.body, result.status)
  }

  const batches = JSON.parse(result.body) as SearchStreamBatch[]
  const rows: unknown[] = []
  for (const batch of Array.isArray(batches) ? batches : []) {
    if (Array.isArray(batch?.results)) rows.push(...batch.results)
  }
  return rows
}

// ─── mutate (campaigns:mutate — used by google_pause) ─────────────────────────

export interface GoogleMutateOptions {
  customerId: string
  path: string // e.g. "campaigns:mutate", "adGroups:mutate", "adGroupAds:mutate"
  operations: unknown[]
  token: string
  loginCustomerId: string
}

/** POST a mutate request (e.g. campaigns:mutate) with the same headers as gaqlSearch. */
export async function googleAdsMutate(
  fetch: GoogleFetch,
  opts: GoogleMutateOptions,
): Promise<unknown> {
  const customerId = stripDashes(opts.customerId)
  const loginCustomerId = stripDashes(opts.loginCustomerId)
  const url = `${GOOGLE_ADS_BASE}/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/${opts.path}`

  const result = (await fetch(url, {
    method: "POST",
    headers: adsHeaders(opts.token, loginCustomerId),
    body: JSON.stringify({ operations: opts.operations }),
  })) as FetchResult

  if (result.status < 200 || result.status >= 300) {
    throw parseGoogleAdsError(result.body, result.status)
  }

  return JSON.parse(result.body)
}
