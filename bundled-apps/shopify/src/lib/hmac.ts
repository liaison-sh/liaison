// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B9 — HMAC-SHA256 verifier for inbound Shopify webhooks.
//
// Shopify signs every webhook body with HMAC-SHA256 (base64) using the
// app's webhook signing secret, and sends the digest in the
// `X-Shopify-Hmac-Sha256` header. The bundle runs inside QuickJS, which
// has no `node:crypto` — so production code computes the digest via the
// host-side `crypto_hmacSha256Base64` bridge (defined in
// apps/api/src/modules/webhooks/routes.ts) and compares via
// `crypto_timingSafeEqual` from the same bridge.
//
// IMPORTANT: This file MUST NOT import from `node:crypto` (the bundle is
// loaded into QuickJS which can't resolve it). The pure-node helper for
// unit tests lives in a sibling file `hmac.testutil.ts` so it doesn't
// pollute the production bundle.

import { lowercaseHeaderKeys } from "@liaison/app-sdk/webhook-verify"

export interface VerifyResult {
  ok: boolean
  replayKey?: string
  replayTtlSeconds?: number
  reason?: string
}

const HEADER_HMAC = "x-shopify-hmac-sha256"
const HEADER_WEBHOOK_ID = "x-shopify-webhook-id"

/**
 * HMAC-SHA256 base64 verifier — uses the host bridge for the digest +
 * timing-safe compare so it runs in the QuickJS sandbox.
 *
 * @param body raw request body (string — must be the exact bytes Shopify
 *             signed; not the JSON-parsed object).
 * @param headers request headers (lowercased keys).
 * @param secret the Shopify webhook signing secret for this org.
 * @param bridge host bridge with `crypto_hmacSha256Base64` and `crypto_timingSafeEqual`.
 */
export async function hmacSha256VerifierViaBridge(
  body: string,
  headers: Record<string, string>,
  secret: string,
  bridge: {
    crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
    crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
  },
): Promise<boolean> {
  const sig = headers[HEADER_HMAC]
  if (!sig || typeof sig !== "string") return false
  const expected = await bridge.crypto_hmacSha256Base64(secret, body)
  // Do NOT short-circuit on `sig.length !== expected.length` here: that leaks a
  // signature-length oracle (an early return that's observably faster for a
  // wrong-length input). The host `crypto_timingSafeEqual` bridge already
  // handles unequal lengths internally (length check then constant-time
  // compare), so defer the entire comparison to it.
  return bridge.crypto_timingSafeEqual(sig, expected)
}

/**
 * Manifest-format webhook verifier. The kernel webhook router calls
 * this with a serialized request descriptor (body + headers). The
 * router expects a structured outcome of shape
 * `{ ok: true, replayKey, replayTtlSeconds }` — see
 * `liaison/apps/api/src/modules/webhooks/verification.ts`.
 *
 * The replay key is `x-shopify-webhook-id` — the unique delivery id
 * Shopify mints per webhook envelope. We pin replay TTL to 7 days to
 * cover Shopify's documented 19-attempt / 48-hour retry window with
 * head-room.
 *
 * The signing secret is read from the app's persisted config under
 * `shopifyWebhookSecret`. The verifier accepts the secret via the
 * sandbox `config_get` bridge so it can run inside the QuickJS sandbox
 * with no host-side imports.
 */
export async function shopifyWebhookVerifier(
  params: {
    headers: Record<string, string>
    body: string
    method: string
    query: Record<string, string>
  },
  bridge: {
    config_get: (key: string) => Promise<unknown>
    crypto_hmacSha256Base64: (secret: string, body: string) => Promise<string>
    crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
  },
): Promise<VerifyResult> {
  const headers = lowercaseHeaderKeys(params.headers)
  const secret = (await bridge.config_get("shopifyWebhookSecret")) as string | null
  if (!secret) return { ok: false, reason: "missing_secret" }
  if (!(await hmacSha256VerifierViaBridge(params.body, headers, secret, bridge))) {
    return { ok: false, reason: "signature_mismatch" }
  }
  const webhookId = headers[HEADER_WEBHOOK_ID]
  if (!webhookId) return { ok: false, reason: "missing_webhook_id" }
  return {
    ok: true,
    // X-Shopify-Webhook-Id is not covered by the HMAC, so it cannot key replay
    // protection (a captured body re-sent under a new id would read as new).
    // Shopify redelivers the identical body on retry, so the digest dedups those.
    replayKey: await bridge.crypto_hmacSha256Base64("shopify-delivery", params.body),
    replayTtlSeconds: 7 * 24 * 60 * 60,
  }
}
