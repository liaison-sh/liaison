// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness H1 + H4 — `installShopifyApp` Playwright client.
//
// The Playwright worker runs in a different process than the API server
// (the API runs in a spawned Bun process — see
// `packages/test-helpers/src/worker-env.ts`). The actual install work
// (filesystem cp, in-memory runtime registry mutation, in-process event
// dispatch into the bundle sandbox) MUST happen in the API server
// process — calling `installAppFromTarball` from the Playwright process
// only mutates DB rows; the registry update would be invisible to the
// running API.
//
// So this file is a thin HTTP client for the test-only route at
// `POST /api/_test/shopify/install-for-test`, mounted only when
// `NODE_ENV === "test"` (see
// `apps/api/test-support/harness/shopify-install-routes.ts`). The route
// does the full server-side dance:
//
//   1. `installAppFromTarball` (filesystem + DB).
//   2. `reloadInstalledApps(orgId)` (in-process registry refresh).
//   3. Seed a `kernel.connected_accounts` row with a mock offline token.
//   4. Seed `apps.config.shopifyWebhookSecret` (H4).
//   5. Rewrite the `connectionConfigRegistry` entry's
//      `authorizationUrl`/`tokenUrl` to point at the mock.
//   6. Dispatch a synthetic `kernel/connected_account:create` event so
//      the bundle's `onConnectionEstablished` writes `install_metadata`.
//   7. Write `install_metadata.api_base_url` to the mock URL (P2a).
//
// The route returns `{ connectionId, webhookSecret, installMetadataRowId,
// shopDomain }` so the test can drive subsequent steps (webhook
// dispatch via the H4 secret, etc.) without further harness round-trips.
import { api } from "@liaison/test-helpers"

export interface InstallShopifyAppOptions {
  /** Hono server URL — typically `env.serverUrl`. */
  serverUrl: string
  /** Bearer token of the calling admin user. */
  token: string
  /** Org installing the app. */
  orgId: string
  /**
   * Mock Shopify base URL — every server-side override points here.
   * Omit when `realOfflineToken` is set (real-Shopify mode).
   */
  mockShopifyUrl?: string
  /**
   * Real Shopify offline token (from `SHOPIFY_DEV_STORE_OFFLINE_TOKEN`).
   * When set, the install harness writes this token directly into
   * `connected_accounts.access_token_encrypted` and SKIPS every
   * apiBaseUrl override — the bundle's `get-client.ts` then constructs
   * the natural `https://{shop}.myshopify.com` URL.
   */
  realOfflineToken?: string
  /**
   * Webhook signing secret — must match what tests will sign with via
   * `dispatchTestWebhook`. Defaults to a random value the route returns;
   * pass `SHOPIFY_WEBHOOK_SECRET` when verifying real-Shopify webhooks.
   */
  realWebhookSecret?: string
  /**
   * Path to the locally-built `.liaisonapp` tarball. Absolute path,
   * resolved client-side from the wrapper root so the API server (which
   * may be running from a different cwd) gets a stable path.
   */
  bundlePath?: string
  /**
   * Shop domain. In real-Shopify mode this MUST be the
   * `<shop>.myshopify.com` host (from `SHOPIFY_DEV_STORE_DOMAIN`). In
   * mock mode defaults to `mock-shop.myshopify.com`.
   */
  shopDomain?: string
  /** Granted scopes. Defaults to every scope declared in the manifest. */
  grantedScopes?: string[]
}

export interface InstalledShopifyApp {
  appName: "shopify"
  connectionId: string
  webhookSecret: string
  shopDomain: string
  installMetadataRowId: string | null
}

// Per-process cache keyed by `${serverUrl}:${orgId}`. Playwright workers
// are isolated processes so this acts as a per-worker singleton — the first
// scenario in a worker triggers the real install, every subsequent scenario
// in the same worker (sharing the same world.org.id) returns the cached
// handle. Without this, the second scenario hits the
// `apps_installed.(name)` unique constraint and the route returns 500.
//
// The cache key is `serverUrl:orgId` so a hypothetical multi-org worker
// (none today) wouldn't false-share.
const installCache = new Map<string, Promise<InstalledShopifyApp>>()

/**
 * Drive the server-side install harness via HTTP. Returns the same
 * shape the route returns, which the calling test stores on a fixture
 * for use by downstream steps (e.g. `dispatchTestWebhook` reads
 * `webhookSecret` off this handle).
 *
 * Idempotent at the worker level: if the same `(serverUrl, orgId)` was
 * already installed in this worker, the cached handle is returned without
 * re-hitting the route. This lets every scenario in a file call
 * `installShopifyApp` directly without coordinating via `beforeAll`.
 */
export async function installShopifyApp(
  opts: InstallShopifyAppOptions,
): Promise<InstalledShopifyApp> {
  const cacheKey = `${opts.serverUrl}:${opts.orgId}`
  const cached = installCache.get(cacheKey)
  if (cached) return cached

  const promise = (async () => {
    const resp = await api(opts.serverUrl, "/api/_test/shopify/install-for-test", {
      method: "POST",
      token: opts.token,
      body: {
        orgId: opts.orgId,
        ...(opts.mockShopifyUrl ? { mockShopifyUrl: opts.mockShopifyUrl } : {}),
        ...(opts.realOfflineToken ? { realOfflineToken: opts.realOfflineToken } : {}),
        ...(opts.realWebhookSecret ? { realWebhookSecret: opts.realWebhookSecret } : {}),
        bundlePath: opts.bundlePath,
        shopDomain: opts.shopDomain,
        grantedScopes: opts.grantedScopes,
      },
    })
    if (resp.status !== 200) {
      throw new Error(
        `installShopifyApp: route returned ${resp.status}: ${JSON.stringify(resp.body)}`,
      )
    }
    return resp.body as InstalledShopifyApp
  })()

  installCache.set(cacheKey, promise)
  try {
    return await promise
  } catch (err) {
    // Drop the failed promise so a later retry can re-attempt the install
    // rather than perpetually re-throwing the cached error.
    installCache.delete(cacheKey)
    throw err
  }
}
