// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HMAC-SHA256 verifier for inbound Meta (Facebook/Instagram) webhooks.
//
// Meta signs every webhook body with HMAC-SHA256 and sends the digest as
// `X-Hub-Signature-256: sha256=<hex>` (the App Secret is the key). The bundle
// runs inside QuickJS, which has NO `node:crypto`; the digest is computed via
// the host `crypto_hmacSha256Hex` bridge and compared via
// `crypto_timingSafeEqual`. This file MUST NOT import `node:*` — the pure-node
// helper used by the unit tests lives in `hmac.testutil.ts`.

/** The crypto/config bridge the kernel webhook router hands the verify handler. */
export interface SocialWebhookBridge {
  config_get?: (key: string) => Promise<unknown>
  crypto_hmacSha256Hex: (secret: string, body: string) => Promise<string>
  crypto_timingSafeEqual: (a: string, b: string) => Promise<boolean>
}

/**
 * Verify Meta's X-Hub-Signature-256 over `rawBody` with `secret`. The provided
 * signature may carry the `sha256=` prefix (header form) or be the bare hex.
 * The digest is host-computed (QuickJS-safe) and compared in constant time.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signature: string,
  secret: string,
  bridge: SocialWebhookBridge,
): Promise<boolean> {
  if (!secret || !signature) return false
  const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature
  const expected = await bridge.crypto_hmacSha256Hex(secret, rawBody)
  return bridge.crypto_timingSafeEqual(provided, expected)
}
