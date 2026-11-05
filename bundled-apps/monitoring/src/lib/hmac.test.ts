// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { DEFAULT_FRESHNESS_TTL_SECONDS, monitoringWebhookVerifier } from "./hmac"
import { hmacBase64, makeTestBridge } from "./hmac.testutil"

const SECRET = "test-monitoring-secret"
const TS = "2026-07-05T03:12:00Z"
const TS_MS = Date.parse(TS)
// "Now" for the deterministic clock: 1 minute after the signed ts → fresh.
const NOW = TS_MS + 60_000
const BODY = JSON.stringify({
  source: "grafana-prod",
  severity: "critical",
  title: "API p99 latency > 5s",
  ts: TS,
})

function params(headers: Record<string, string>, body = BODY) {
  return { headers, body, method: "POST", query: {} }
}

describe("monitoringWebhookVerifier", () => {
  it("accepts a correctly signed fresh body and returns a replay key", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await monitoringWebhookVerifier(
      params({ "X-Monitoring-Signature": sig, "x-monitoring-delivery-id": "d-1" }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(res.ok).toBe(true)
    // The delivery-id header is unsigned: re-sending the same signed body under a
    // different id must produce the SAME replay key.
    const again = await monitoringWebhookVerifier(
      params({ "X-Monitoring-Signature": sig, "x-monitoring-delivery-id": "d-other" }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(again.replayKey).toBe(res.replayKey)
    expect(res.replayKey).not.toBe("d-1")
    expect(res.replayTtlSeconds).toBeGreaterThan(0)
  })

  it("derives a stable replay key from the body when no delivery id header is sent", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const a = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    const b = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(a.ok).toBe(true)
    expect(a.replayKey).toBeDefined()
    expect(a.replayKey).toBe(b.replayKey as string)
  })

  it("rejects a wrong signature", async () => {
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": hmacBase64("wrong-secret", BODY) }),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("signature_mismatch")
  })

  it("rejects a tampered body under a valid-for-other-body signature", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }, `${BODY} `),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(res.ok).toBe(false)
  })

  it("rejects when the signature header is missing", async () => {
    const res = await monitoringWebhookVerifier(params({}), makeTestBridge(SECRET), NOW)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_signature")
  })

  it("rejects when no secret has been minted yet", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      makeTestBridge(null),
      NOW,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_secret")
  })

  // --- M3C-01: signed-ts freshness (replay window bound) --------------------

  it("rejects a correctly signed but STALE body (replay of a captured delivery)", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig, "x-monitoring-delivery-id": "d-replay" }),
      makeTestBridge(SECRET),
      TS_MS + (DEFAULT_FRESHNESS_TTL_SECONDS + 1) * 1000,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("stale_ts")
  })

  it("accepts at exactly the TTL boundary (bound is >TTL, not >=)", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      makeTestBridge(SECRET),
      TS_MS + DEFAULT_FRESHNESS_TTL_SECONDS * 1000,
    )
    expect(res.ok).toBe(true)
  })

  it("rejects a signed ts too far in the FUTURE (skewed-capture window extension)", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      makeTestBridge(SECRET),
      TS_MS - (DEFAULT_FRESHNESS_TTL_SECONDS + 1) * 1000,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("future_ts")
  })

  it("rejects a signed body with no ts field (all first-party senders send one)", async () => {
    const noTs = JSON.stringify({ source: "s", severity: "info", title: "t" })
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": hmacBase64(SECRET, noTs) }, noTs),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_ts")
  })

  it("rejects a signed body whose ts is unparseable", async () => {
    const badTs = JSON.stringify({ source: "s", severity: "info", title: "t", ts: "not-a-date" })
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": hmacBase64(SECRET, badTs) }, badTs),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_ts")
  })

  it("rejects a signed non-JSON body before it reaches the handler", async () => {
    const raw = "not json at all"
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": hmacBase64(SECRET, raw) }, raw),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("missing_ts")
  })

  it("rejects a TAMPERED ts (freshened by the attacker) via the signature, not the clock", async () => {
    const sig = hmacBase64(SECRET, BODY) // signed over the ORIGINAL (stale) ts
    const freshened = BODY.replace(TS, new Date(NOW).toISOString())
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }, freshened),
      makeTestBridge(SECRET),
      NOW,
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toBe("signature_mismatch")
  })

  it("honours the monitoringAlertTtlSeconds config override", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const bridge = makeTestBridge(SECRET, { monitoringAlertTtlSeconds: 60 })
    const fresh = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      bridge,
      TS_MS + 30_000,
    )
    expect(fresh.ok).toBe(true)
    const stale = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      bridge,
      TS_MS + 61_000,
    )
    expect(stale.ok).toBe(false)
    expect(stale.reason).toBe("stale_ts")
  })

  it("falls back to the default TTL on a junk config override (fail-closed to known-good)", async () => {
    const sig = hmacBase64(SECRET, BODY)
    const bridge = makeTestBridge(SECRET, { monitoringAlertTtlSeconds: "-5" })
    const res = await monitoringWebhookVerifier(
      params({ "x-monitoring-signature": sig }),
      bridge,
      TS_MS + (DEFAULT_FRESHNESS_TTL_SECONDS - 1) * 1000,
    )
    expect(res.ok).toBe(true)
  })
})
