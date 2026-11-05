// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B9 — HMAC-SHA256 verifier tests.
import { describe, expect, it } from "bun:test"
import { createHmac, timingSafeEqual } from "node:crypto"
import { hmacSha256VerifierViaBridge, shopifyWebhookVerifier } from "./hmac"
import { hmacSha256Verifier } from "./hmac.testutil"

const sign = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body, "utf8").digest("base64")

// Host-faithful bridge: mirrors apps/api/src/modules/webhooks/routes.ts —
// crypto_timingSafeEqual does the length check + constant-time compare itself,
// and crypto_hmacSha256Base64 computes the real digest. Tests that drive the
// PRODUCTION verifier (hmacSha256VerifierViaBridge) must use this, not a
// stringy `a === b`, so the length-oracle fix is actually exercised.
const hostBridge = {
  crypto_hmacSha256Base64: async (s: string, body: string) =>
    createHmac("sha256", s).update(body, "utf8").digest("base64"),
  crypto_timingSafeEqual: async (a: string, b: string) => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  },
}

describe("hmacSha256Verifier", () => {
  it("returns true on valid signature", () => {
    const body = '{"x":1}'
    const secret = "s"
    const sig = sign(body, secret)
    expect(hmacSha256Verifier(body, { "x-shopify-hmac-sha256": sig }, secret)).toBe(true)
  })

  it("returns false on mismatch", () => {
    expect(
      hmacSha256Verifier('{"x":1}', { "x-shopify-hmac-sha256": "garbage" }, "s"),
    ).toBe(false)
  })

  it("returns false when header missing", () => {
    expect(hmacSha256Verifier('{"x":1}', {}, "s")).toBe(false)
  })

  it("returns false when body tampered", () => {
    const sig = sign('{"x":1}', "s")
    expect(
      hmacSha256Verifier('{"x":2}', { "x-shopify-hmac-sha256": sig }, "s"),
    ).toBe(false)
  })
})

// Production verifier — the one the kernel webhook route actually calls
// (hmac.test previously only covered the test-only hmac.testutil reimpl, so the
// real path that runs in QuickJS was untested).
describe("hmacSha256VerifierViaBridge (production, host-faithful bridge)", () => {
  it("returns true on a valid base64 HMAC", async () => {
    const body = '{"order":1}'
    const secret = "shh"
    const sig = sign(body, secret)
    expect(
      await hmacSha256VerifierViaBridge(body, { "x-shopify-hmac-sha256": sig }, secret, hostBridge),
    ).toBe(true)
  })

  it("returns false when the header is missing", async () => {
    expect(await hmacSha256VerifierViaBridge('{"x":1}', {}, "s", hostBridge)).toBe(false)
  })

  it("returns false on a tampered body", async () => {
    const sig = sign('{"x":1}', "s")
    expect(
      await hmacSha256VerifierViaBridge('{"x":2}', { "x-shopify-hmac-sha256": sig }, "s", hostBridge),
    ).toBe(false)
  })

  it("returns false on a wrong-length signature WITHOUT an app-side length short-circuit", async () => {
    // The length mismatch must be resolved by the host crypto_timingSafeEqual
    // (which checks length internally), not by an early return in hmac.ts —
    // that early return was the length oracle we removed. Assert the bridge's
    // compare is the decider by spying on whether it was invoked.
    let compareCalled = false
    const spyBridge = {
      crypto_hmacSha256Base64: hostBridge.crypto_hmacSha256Base64,
      crypto_timingSafeEqual: async (a: string, b: string) => {
        compareCalled = true
        return hostBridge.crypto_timingSafeEqual(a, b)
      },
    }
    const ok = await hmacSha256VerifierViaBridge(
      '{"x":1}',
      { "x-shopify-hmac-sha256": "short" },
      "s",
      spyBridge,
    )
    expect(ok).toBe(false)
    expect(compareCalled).toBe(true)
  })
})

describe("shopifyWebhookVerifier (manifest-format)", () => {
  const bridge = (secret: string | null) => ({
    config_get: async () => secret,
    crypto_hmacSha256Base64: async (s: string, body: string) =>
      createHmac("sha256", s).update(body, "utf8").digest("base64"),
    crypto_timingSafeEqual: async (a: string, b: string) => a === b,
  })

  it("returns ok=true with replayKey when signature + webhookId present", async () => {
    const body = '{"order":1}'
    const secret = "shh"
    const sig = sign(body, secret)
    const r = await shopifyWebhookVerifier(
      {
        body,
        method: "POST",
        query: {},
        headers: {
          "X-Shopify-Hmac-Sha256": sig,
          "X-Shopify-Webhook-Id": "wh-100",
          "X-Shopify-Shop-Domain": "demo.myshopify.com",
        },
      },
      bridge(secret),
    )
    expect(r.ok).toBe(true)
    // The webhook-id header is unsigned, so the key is the digest of the signed body.
    expect(r.replayKey).toBe(createHmac("sha256", "shopify-delivery").update(body, "utf8").digest("base64"))
    const reId = await shopifyWebhookVerifier(
      {
        body,
        method: "POST",
        query: {},
        headers: { "X-Shopify-Hmac-Sha256": sig, "X-Shopify-Webhook-Id": "a-fresh-id" },
      },
      bridge(secret),
    )
    expect(reId.replayKey).toBe(r.replayKey)
    expect((r.replayTtlSeconds ?? 0) > 86_400).toBe(true)
  })

  it("returns ok=false when secret unset", async () => {
    const r = await shopifyWebhookVerifier(
      { body: "{}", method: "POST", query: {}, headers: { "x-shopify-hmac-sha256": "x" } },
      bridge(null),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("missing_secret")
  })

  it("returns ok=false on signature mismatch", async () => {
    const r = await shopifyWebhookVerifier(
      {
        body: "{}",
        method: "POST",
        query: {},
        headers: { "x-shopify-hmac-sha256": "wrong", "x-shopify-webhook-id": "wh1" },
      },
      bridge("s"),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("signature_mismatch")
  })

  it("returns ok=false when X-Shopify-Webhook-Id missing", async () => {
    const body = "{}"
    const secret = "s"
    const sig = sign(body, secret)
    const r = await shopifyWebhookVerifier(
      { body, method: "POST", query: {}, headers: { "x-shopify-hmac-sha256": sig } },
      bridge(secret),
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("missing_webhook_id")
  })
})
