// SPDX-License-Identifier: FSL-1.1-ALv2
// Tiny GraphQL client used by the dev-store setup scripts. Talks directly to
// Shopify Admin GraphQL via fetch — no Liaison kernel involved.
//
// Reads env vars on demand (so each script can fail with a clear "missing X"
// before any HTTP). Pinned to a single API version per .env.test.

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Loads `liaison/.env.test` into process.env if any SHOPIFY_* var is missing.
 * Bun only auto-loads `.env.test` when CWD is `liaison/`; users running these
 * scripts from elsewhere (e.g. the monorepo root) would otherwise hit
 * "missing env vars". Resolves the path from this file's location, walking up
 * to the liaison/ root so the loader works regardless of where the script is run.
 */
function ensureEnvLoaded(): void {
  if (process.env.SHOPIFY_OAUTH_CLIENT_ID) return // already loaded
  // This file lives at: liaison/bundled-apps/shopify/scripts/_shopify-client.ts
  // Walk up three levels (scripts/ → shopify/ → bundled-apps/) to reach liaison/.
  const here = import.meta.dirname ?? new URL(".", import.meta.url).pathname
  const candidate = resolve(here, "..", "..", "..", ".env.test")
  if (!existsSync(candidate)) return // let downstream fail with clearer message
  const text = readFileSync(candidate, "utf8")
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    // Strip simple surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

export interface ShopifyEnv {
  domain: string
  offlineToken: string
  apiVersion: string
  clientId: string
  clientSecret: string
}

export function loadShopifyEnv(opts?: { requireToken?: boolean }): ShopifyEnv {
  ensureEnvLoaded()
  const domain = process.env.SHOPIFY_DEV_STORE_DOMAIN
  const offlineToken = process.env.SHOPIFY_DEV_STORE_OFFLINE_TOKEN
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-01"
  const clientId = process.env.SHOPIFY_OAUTH_CLIENT_ID
  const clientSecret = process.env.SHOPIFY_OAUTH_CLIENT_SECRET

  const missing: string[] = []
  if (!domain) missing.push("SHOPIFY_DEV_STORE_DOMAIN")
  if (opts?.requireToken !== false && !offlineToken) missing.push("SHOPIFY_DEV_STORE_OFFLINE_TOKEN")
  if (!clientId) missing.push("SHOPIFY_OAUTH_CLIENT_ID")
  if (!clientSecret) missing.push("SHOPIFY_OAUTH_CLIENT_SECRET")
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars in liaison/.env.test: ${missing.join(", ")}.\n` +
        `The token comes from bundled-apps/shopify/scripts/acquire-offline-token.ts (run it with --mint).`,
    )
  }

  return {
    domain: domain as string,
    offlineToken: (offlineToken ?? "") as string,
    apiVersion,
    clientId: clientId as string,
    clientSecret: clientSecret as string,
  }
}

export interface GraphqlResponse<T> {
  data?: T
  errors?: Array<{ message: string; path?: string[]; extensions?: Record<string, unknown> }>
  extensions?: { cost?: { actualQueryCost?: number; throttleStatus?: { currentlyAvailable?: number } } }
}

export async function graphql<T = unknown>(
  env: ShopifyEnv,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResponse<T>> {
  const url = `https://${env.domain}/admin/api/${env.apiVersion}/graphql.json`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": env.offlineToken,
    },
    body: JSON.stringify({ query, variables: variables ?? {} }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Shopify GraphQL HTTP ${res.status}: ${body.slice(0, 500)}`)
  }
  const json = (await res.json()) as GraphqlResponse<T>
  if (json.errors && json.errors.length > 0) {
    const msg = json.errors.map((e) => e.message).join("; ")
    throw new Error(`Shopify GraphQL errors: ${msg}`)
  }
  return json
}

/**
 * Throttle-aware wrapper that backs off when the leaky-bucket says we're low.
 * Refill is ~50pt/s on standard stores; 1500ms cushion is conservative.
 */
export async function graphqlThrottled<T>(
  env: ShopifyEnv,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResponse<T>> {
  const result = await graphql<T>(env, query, variables)
  const available = result.extensions?.cost?.throttleStatus?.currentlyAvailable
  if (typeof available === "number" && available < 200) {
    await new Promise((r) => setTimeout(r, 1500))
  }
  return result
}
