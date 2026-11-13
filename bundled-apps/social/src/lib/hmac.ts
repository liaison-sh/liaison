// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HMAC-SHA256 verifier for inbound Meta (Facebook/Instagram) webhooks.
//
// Meta signs every webhook body with HMAC-SHA256 and sends the digest as
// `X-Hub-Signature-256: sha256=<hex>` (the App Secret is the key). The App
// Secret never enters the bundle: the verifier names its config key and the
// host digests the body with it and compares in constant time
// (`crypto_verifyHmacForConfig`), on every executor. This file MUST NOT import
// `node:*`.

/** The crypto/config bridge the kernel webhook router hands the verify handler. */
export interface SocialWebhookBridge {
  config_has: (key: string) => Promise<boolean>
  crypto_verifyHmacForConfig: (
    key: string,
    data: string,
    signature: string,
    encoding: "base64" | "hex",
  ) => Promise<boolean>
  crypto_hmacSha256Base64ForConfig: (key: string, data: string) => Promise<string | null>
}

/**
 * Verify Meta's X-Hub-Signature-256 over `rawBody` with the config secret
 * `secretKey`. The provided signature may carry the `sha256=` prefix (header
 * form) or be the bare hex.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signature: string,
  secretKey: string,
  bridge: SocialWebhookBridge,
): Promise<boolean> {
  if (!signature) return false
  const provided = signature.startsWith("sha256=") ? signature.slice("sha256=".length) : signature
  if (!provided) return false
  return bridge.crypto_verifyHmacForConfig(secretKey, rawBody, provided, "hex")
}
