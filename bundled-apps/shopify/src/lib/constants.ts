// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared Shopify constants. Kept in one place so the connect path
// (`connection.ts`) and the read/self-heal path (`get-client.ts`) agree on the
// Admin API version and the shop-domain shape — a drift between them once let
// the self-heal write a row the connect path would not have.

import manifest from "../../app.manifest.json"

/** Shopify Admin API version every client + metadata write pins to. Declared on the
 *  manifest's `shop` connection, which the generated shopify.app.toml also reads for
 *  its webhook API version, so the two can never drift. */
export const API_VERSION: string = (() => {
  const v = (manifest as { connections?: { shop?: { apiVersion?: unknown } } }).connections?.shop
    ?.apiVersion
  if (typeof v !== "string" || !/^\d{4}-\d{2}$/.test(v)) {
    throw new Error("shopify manifest: connections.shop.apiVersion must be YYYY-MM")
  }
  return v
})()

/** Canonical `<store>.myshopify.com` shop-domain shape. */
export const SHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i

/** The OAuth scopes the CURRENT manifest requests — the reference the Settings
 *  panel compares a connection's GRANTED scopes against, so a grant that
 *  predates a scope addition (e.g. read_all_orders / read_reports in 0.1.7)
 *  surfaces as "permissions update required" instead of degrading silently.
 *  Sourced from the manifest itself so the two can never drift. */
export const REQUIRED_OAUTH_SCOPES: string[] =
  (manifest as { connections?: { shop?: { scopes?: string[] } } }).connections?.shop?.scopes ?? []

/** The OAuth scopes a connection's install metadata RECORDS as granted. Empty when the grant was
 *  never recorded (a connection that predates granted-scope tracking): callers treat empty as
 *  "unknown", never as "nothing granted". */
export function recordedGrantedScopes(
  meta: { grantedOAuthScopes?: unknown } | null | undefined,
): string[] {
  const raw = meta?.grantedOAuthScopes
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string") : []
}

/** Whether a recorded grant holds `scope`. Shopify NORMALIZES the grant it reports: `write_X` implies
 *  `read_X`, so the token response omits the read scope even though it is held. A literal set lookup
 *  would flag every read scope as missing on every connection. */
export function grantSatisfies(granted: ReadonlySet<string>, scope: string): boolean {
  return (
    granted.has(scope) ||
    (scope.startsWith("read_") && granted.has(`write_${scope.slice("read_".length)}`))
  )
}
