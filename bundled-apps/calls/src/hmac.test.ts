// SPDX-License-Identifier: FSL-1.1-ALv2
//
// callsWebhookVerifier round-trip — mirrors the coverage of the two
// precedents' verifier suites (monitoring webhooks.test.ts, projects
// ci-webhook.test.ts §HMAC): valid signature, missing/mismatched signature,
// missing secret, signed-ts freshness both directions, TTL override,
// delivery-id replay key + HMAC-of-body fallback, 7-day replay TTL.
import { describe, expect, it } from "bun:test"
import {
  callsWebhookVerifier,
  DELIVERY_ID_HEADER,
  FRESHNESS_TTL_CONFIG_KEY,
  SIGNATURE_HEADER,
  WEBHOOK_SECRET_KEY,
} from "./lib/hmac"
import { hmacBase64, makeTestBridge } from "./lib/hmac.testutil"

const SECRET = "calls-test-secret"
const NOW = Date.parse("2026-07-06T10:05:00Z")

function reqFor(
  body: string,
  headers: Record<string, string> = {},
): {
  headers: Record<string, string>
  body: string
  method: string
  query: Record<string, string>
} {
  return { headers, body, method: "POST", query: {} }
}

function signedBody(tsIso: string): { body: string; sig: string } {
  const body = JSON.stringify({
    callRef: "call-1",
    segmentId: "s1",
    ts: tsIso,
    speaker: "Alice",
    text: "hello",
  })
  return { body, sig: hmacBase64(SECRET, body) }
}

describe("callsWebhookVerifier", () => {
  it("accepts a correctly signed fresh delivery and returns the delivery-id replay key", async () => {
    const { body, sig } = signedBody("2026-07-06T10:04:30Z")
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: sig, [DELIVERY_ID_HEADER]: "d-42" }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r.ok).toBe(true)
    // The delivery-id header is unsigned, so the key is the signed body's digest.
    expect(r.replayKey).toBe(hmacBase64("calls-delivery", body))
    expect(r.replayTtlSeconds).toBe(7 * 24 * 60 * 60)
    // The verifier grants the handler exactly the knowledge document scopes
    // its cross-app writes need (outcome.scopes mechanism) — the connector's
    // state IS knowledge documents; the default `calls:*` grant alone cannot
    // write them.
    expect(r.scopes).toEqual([
      "calls:*",
      "knowledge:documents:create",
      "knowledge:documents:update",
      "knowledge:documents:read",
    ])
  })

  it("falls back to an HMAC-of-body replay key when no delivery-id header is sent", async () => {
    const { body, sig } = signedBody("2026-07-06T10:04:30Z")
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r.ok).toBe(true)
    expect(r.replayKey).toBe(hmacBase64("calls-delivery", body))
    // Same body ⇒ same replay key (an exact redelivery dedups); different body ⇒ different key.
    const other = signedBody("2026-07-06T10:04:31Z")
    const r2 = await callsWebhookVerifier(
      reqFor(other.body, { [SIGNATURE_HEADER]: other.sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r2.replayKey).not.toBe(r.replayKey)
  })

  it("rejects a missing signature", async () => {
    const { body } = signedBody("2026-07-06T10:04:30Z")
    const r = await callsWebhookVerifier(reqFor(body), makeTestBridge(SECRET), NOW)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("missing_signature")
  })

  it("rejects a signature computed under the wrong secret", async () => {
    const { body } = signedBody("2026-07-06T10:04:30Z")
    const wrongSig = hmacBase64("some-other-secret", body)
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: wrongSig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("signature_mismatch")
  })

  it("rejects when no signing secret has been minted yet", async () => {
    const { body, sig } = signedBody("2026-07-06T10:04:30Z")
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: sig }),
      makeTestBridge(null),
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("missing_secret")
  })

  it("rejects a payload with no parseable signed ts", async () => {
    const body = JSON.stringify({ callRef: "call-1", segmentId: "s1", speaker: "A", text: "x" })
    const sig = hmacBase64(SECRET, body)
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("missing_ts")
  })

  it("rejects a stale signed ts (older than the freshness TTL)", async () => {
    const { body, sig } = signedBody("2026-07-06T09:50:00Z") // 15 min before NOW > 600s default
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("stale_ts")
  })

  it("rejects a future signed ts beyond the window (clock-skew capture defense)", async () => {
    const { body, sig } = signedBody("2026-07-06T10:20:00Z") // 15 min after NOW
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("future_ts")
  })

  it("honors the callsWebhookTtlSeconds config override", async () => {
    const { body, sig } = signedBody("2026-07-06T09:50:00Z") // 15 min old
    // Default 600s rejects it; a 3600s override accepts it.
    const r = await callsWebhookVerifier(
      reqFor(body, { [SIGNATURE_HEADER]: sig }),
      makeTestBridge(SECRET, { [FRESHNESS_TTL_CONFIG_KEY]: 3600 }),
      NOW,
    )
    expect(r.ok).toBe(true)
  })

  it("verifies the RAW body byte-for-byte (a mutated body fails the signature)", async () => {
    const { body, sig } = signedBody("2026-07-06T10:04:30Z")
    const mutated = body.replace("hello", "hell0")
    const r = await callsWebhookVerifier(
      reqFor(mutated, { [SIGNATURE_HEADER]: sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("signature_mismatch")
  })

  it("reads the secret from the callsWebhookSecret config key", async () => {
    // Bridge that only answers the exact expected key — a wrong key lookup
    // surfaces as missing_secret.
    const { body, sig } = signedBody("2026-07-06T10:04:30Z")
    const bridge = makeTestBridge(SECRET)
    expect(WEBHOOK_SECRET_KEY).toBe("callsWebhookSecret")
    const r = await callsWebhookVerifier(reqFor(body, { [SIGNATURE_HEADER]: sig }), bridge, NOW)
    expect(r.ok).toBe(true)
  })
})
