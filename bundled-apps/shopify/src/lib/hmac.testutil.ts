// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 — Unit-test helper for hmac verification. Pure node:crypto
// path (@liaison/test-helpers/webhook-hmac) that runs in test but is NOT
// bundled into the QuickJS-target production bundle.
import { hmacBase64, utf8TimingSafeEqual } from "@liaison/test-helpers/webhook-hmac"

const HEADER_HMAC = "x-shopify-hmac-sha256"

/**
 * Pure HMAC-SHA256 base64 verifier — UNIT TESTS ONLY.
 */
export function hmacSha256Verifier(
  body: string,
  headers: Record<string, string>,
  secret: string,
): boolean {
  const sig = headers[HEADER_HMAC]
  if (!sig || typeof sig !== "string") return false
  return utf8TimingSafeEqual(sig, hmacBase64(secret, body))
}
