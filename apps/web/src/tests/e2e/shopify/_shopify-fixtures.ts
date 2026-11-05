// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 — Shared Playwright fixtures.
//
// REAL-SHOPIFY MODE: e2e tests run against the live development store
// (the store named by `SHOPIFY_DEV_STORE_DOMAIN`) using the offline OAuth token
// the operator acquired once via `scripts/acquire-offline-token.ts`. No
// mock server — every outbound Shopify Admin call from the bundle hits
// the real API. The store is seeded once via `scripts/dev-store-seed.ts`
// with deterministic fixtures (`marie@example.com` etc.) so assertions
// have stable data.
//
// REQUIRED ENV (from `liaison/.env.test`):
//   - SHOPIFY_DEV_STORE_DOMAIN
//   - SHOPIFY_DEV_STORE_OFFLINE_TOKEN
//   - SHOPIFY_WEBHOOK_SECRET
//   - SHOPIFY_API_VERSION
//
// When any of these is absent (CI without creds, fresh checkout), the
// fixture marks itself unavailable so the scenarios can self-skip with
// a clear message rather than hanging on a 401.
import { test as base } from "../fixtures/test"

export interface ShopifyRealConfig {
  shopDomain: string
  offlineToken: string
  webhookSecret: string
  apiVersion: string
  /** `https://{shop}.myshopify.com` — convenience for tests that need the URL form. */
  baseUrl: string
  /**
   * True only when ALL required env vars were present — i.e. the LIVE dev
   * store is reachable. Scenarios that make real outbound Shopify Admin
   * calls (search-merge against seeded customers, deep-link panels that
   * fetch via `orders_get`, the agent scenarios) gate on this.
   */
  available: boolean
  /** Comma-joined names of missing vars; for use in skip messages. */
  missing: string[]
  /**
   * True when we are running under CI (the `CI` env var is set by GitHub
   * Actions / the strobe-runner).
   */
  isCi: boolean
}

type WorkerFixtures = {
  shopifyConfig: ShopifyRealConfig
  /**
   * Shorthand for `shopifyConfig.baseUrl`. Kept for backward-compat with
   * older scenarios that destructured `shopifyBaseUrl` from the fixture.
   * NOTE: with real Shopify this is the LIVE store URL — not a mock —
   * so install-helper callers should NOT pass it as `mockShopifyUrl`.
   */
  shopifyBaseUrl: string
}

function readShopifyConfig(): ShopifyRealConfig {
  const shopDomain = process.env.SHOPIFY_DEV_STORE_DOMAIN ?? ""
  const offlineToken = process.env.SHOPIFY_DEV_STORE_OFFLINE_TOKEN ?? ""
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET ?? ""
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-01"

  const missing: string[] = []
  if (!shopDomain) missing.push("SHOPIFY_DEV_STORE_DOMAIN")
  if (!offlineToken) missing.push("SHOPIFY_DEV_STORE_OFFLINE_TOKEN")
  if (!webhookSecret) missing.push("SHOPIFY_WEBHOOK_SECRET")

  return {
    shopDomain,
    offlineToken,
    webhookSecret,
    apiVersion,
    baseUrl: shopDomain ? `https://${shopDomain}` : "",
    available: missing.length === 0,
    missing,
    isCi: Boolean(process.env.CI),
  }
}

/**
 * Hard-require live Shopify dev-store credentials. Call at the top of any
 * scenario that exercises the real dev store.
 *
 * This deliberately FAILS (throws) when creds are absent rather than skipping.
 * A green suite that silently skipped its only real-integration coverage is
 * more dangerous than a red one — it reads as "the sync system is tested" when
 * nothing actually ran. If you genuinely need to run the rest of the e2e suite
 * without Shopify, populate `liaison/.env.test` (the creds are not optional).
 */
/** Live Shopify dev-store journeys run only when asked for (like PLAYWRIGHT_LIVE_LLM). */
export const LIVE_SHOPIFY = process.env.PLAYWRIGHT_LIVE_SHOPIFY === "1"

export const LIVE_SHOPIFY_SKIP_REASON =
  "live Shopify journey: runs against the real dev store, run it with PLAYWRIGHT_LIVE_SHOPIFY=1 (and the SHOPIFY_DEV_STORE_* credentials)"

/**
 * Gate for the scenarios that drive the LIVE Shopify dev store. A default run
 * (no PLAYWRIGHT_LIVE_SHOPIFY) skips them with the reason: a checkout without
 * store credentials must not fail the suite. With the flag set they stay loud:
 * missing credentials are an error, never a skip.
 */
export function requireShopifyCreds(cfg: Pick<ShopifyRealConfig, "available" | "missing">): void {
  if (!LIVE_SHOPIFY) {
    test.info().skip(true, LIVE_SHOPIFY_SKIP_REASON)
    return
  }
  if (cfg.available) return
  throw new Error(
    `Shopify dev-store credentials are REQUIRED for this E2E scenario but are missing: ` +
      `${cfg.missing.join(", ")}.\n` +
      `PLAYWRIGHT_LIVE_SHOPIFY=1 asks for the LIVE Shopify dev store (no mock), so they do NOT self-skip.\n` +
      `Populate liaison/.env.test with SHOPIFY_DEV_STORE_DOMAIN, SHOPIFY_DEV_STORE_OFFLINE_TOKEN ` +
      `and SHOPIFY_WEBHOOK_SECRET, then re-run.`,
  )
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export const test = base.extend<{}, WorkerFixtures>({
  shopifyConfig: [
    async ({}, use) => {
      await use(readShopifyConfig())
    },
    { scope: "worker" },
  ],
  shopifyBaseUrl: [
    async ({ shopifyConfig }, use) => {
      await use(shopifyConfig.baseUrl)
    },
    { scope: "worker" },
  ],
})

export { expect } from "../fixtures/test"
