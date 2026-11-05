// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness P3 — `dispatchTestWebhook` helper.
//
// Computes the HMAC-SHA256 signature Shopify would attach to an outbound
// webhook and POSTs the body to the kernel's manifest-webhook router at
// `${serverUrl}/webhooks/<orgId>/<appName>/<endpointName>`.
//
// Notes (verified against the kernel + the Shopify app):
//
//   * The kernel route lives at `apps/api/src/modules/webhooks/routes.ts:38`
//     and is mounted at `/webhooks` (no `/api` prefix) — confirmed via
//     `apps/api/src/app.ts:550`.
//
//   * The manifest endpoint name is the *kebab* form declared in
//     `bundled-apps/shopify/app.manifest.json#webhooks` (e.g.
//     `customers-create`, `orders-create`), because the kernel's
//     `WEBHOOK_NAME_PATTERN` rejects `/`. The Shopify app's
//     `runTopic` helper restores the canonical `customers/create` topic
//     internally — callers of this helper pass the kebab form.
//
//   * The verifier (`bundled-apps/shopify/src/lib/hmac.ts`) computes
//     HMAC-SHA256 over the raw bytes Shopify signed (base64) and reads the
//     header `X-Shopify-Hmac-Sha256`. It also requires `X-Shopify-Webhook-Id`
//     as the kernel-side redis dedup key. Both are added here.
//
//   * The verifier reads the signing secret via `config_get` from the app's
//     persisted `config` row under the key `shopifyWebhookSecret`. The
//     `installShopifyApp` per-test fixture (H1) writes that key during
//     install metadata setup; this helper accepts the same secret as an
//     argument so the test owns the only copy.
import { createHmac } from "node:crypto"

export interface DispatchTestWebhookOptions {
  /** Hono server URL (no trailing slash) — typically `env.serverUrl`. */
  serverUrl: string
  /** Org installing the app. */
  orgId: string
  /** App manifest name. For Phase 16, always `"shopify"`. */
  appName: string
  /**
   * Kebab-cased endpoint name from the manifest's `webhooks` map.
   * Examples: `"customers-create"`, `"orders-create"`,
   * `"refunds-create"`, `"app-uninstalled"`.
   */
  endpointName: string
  /**
   * Webhook payload — serialised to JSON exactly once. Pass an object;
   * the helper handles JSON.stringify so the signed body matches the
   * transmitted body byte-for-byte (a subtle correctness bug when callers
   * stringify ahead and the serializer re-orders keys).
   */
  body: Record<string, unknown>
  /**
   * The Shopify webhook signing secret — must be the same value the
   * install fixture wrote into the app's `config.shopifyWebhookSecret`
   * row, otherwise the verifier returns `signature_mismatch` and the
   * router responds 401.
   */
  secret: string
  /**
   * Unique per-delivery webhook id. Defaults to a fresh UUID-shaped string
   * so the kernel's redis dedup (replay key) treats every call as new.
   * Pass an explicit value when intentionally testing dedup behaviour.
   */
  webhookId?: string
  /**
   * Canonical Shopify topic (e.g. `"customers/create"`) — recorded in
   * `X-Shopify-Topic` because the Shopify app's `runTopic` reads it from
   * the header to recover the slash-form topic the manifest stores in
   * kebab form. Defaults to converting `endpointName` from kebab to slash.
   */
  topic?: string
  /**
   * Shop domain — recorded in `X-Shopify-Shop-Domain`. Most handlers do
   * not need it for routing (the URL carries `orgId` + `appName`); it is
   * provided so the audit/log surface looks realistic. Default
   * `"mock.myshopify.com"`.
   */
  shopDomain?: string
}

export interface DispatchTestWebhookResult {
  status: number
  body: unknown
}

/**
 * Sign and POST a Shopify-flavoured webhook to the kernel router. Returns
 * the kernel's parsed JSON response so the caller can assert on the
 * `{ received: true }` envelope (or on a `duplicate: true` flag for
 * dedup tests).
 */
export async function dispatchTestWebhook(
  opts: DispatchTestWebhookOptions,
): Promise<DispatchTestWebhookResult> {
  const {
    serverUrl,
    orgId,
    appName,
    endpointName,
    body,
    secret,
    webhookId = crypto.randomUUID(),
    topic = endpointName.replace(/-/g, "/"),
    // Must match the shop domain the test-install route seeds into
    // install_metadata (`mock-shop.myshopify.com`) — the bundle's webhook
    // handler pins the `X-Shopify-Shop-Domain` header to the installed shop
    // (validateShopDomain) and rejects mismatches.
    shopDomain = "mock-shop.myshopify.com",
  } = opts

  // Stringify exactly once so the HMAC matches the body we send. Using a
  // single deterministic call keeps signature + transport in lockstep
  // regardless of caller-supplied key ordering.
  const rawBody = JSON.stringify(body)

  const signature = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64")

  const url = `${trimTrailingSlash(serverUrl)}/webhooks/${encodeURIComponent(orgId)}/${encodeURIComponent(appName)}/${encodeURIComponent(endpointName)}`

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signature,
      "x-shopify-webhook-id": webhookId,
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shopDomain,
    },
    body: rawBody,
  })

  let parsed: unknown = null
  const text = await resp.text()
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return { status: resp.status, body: parsed }
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s
}
