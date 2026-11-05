// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness P3 — unit tests for `dispatchTestWebhook`.
//
// The kernel webhook route is exercised by `apps/api/src/modules/webhooks/
// routes.test.ts`; these tests pin the helper's signing + URL-shape
// contract by spinning a tiny Bun server that mimics the kernel's
// signature check and asserts the request shape.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, timingSafeEqual } from "node:crypto"
import { dispatchTestWebhook } from "./dispatch-shopify-webhook"

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

let server: ReturnType<typeof Bun.serve>
let capturedRequests: CapturedRequest[] = []
const SECRET = "test-shopify-webhook-secret"

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      capturedRequests.push({
        url: req.url,
        method: req.method,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      })
      // Mimic the kernel's HMAC check so we can assert the helper signs
      // bytes that match the body it transmits.
      const sig = req.headers.get("x-shopify-hmac-sha256")
      if (!sig) {
        return new Response(JSON.stringify({ error: { message: "missing sig" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }
      const expected = createHmac("sha256", SECRET).update(body, "utf8").digest("base64")
      const a = Buffer.from(sig, "utf8")
      const b = Buffer.from(expected, "utf8")
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return new Response(JSON.stringify({ error: { message: "sig mismatch" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(JSON.stringify({ data: { received: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })
})

afterAll(() => {
  server.stop(true)
})

function reset() {
  capturedRequests = []
}

describe("dispatchTestWebhook: E2E harness", () => {
  it("signs the exact bytes it transmits and the kernel-style verifier accepts the signature", async () => {
    reset()
    const result = await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "11111111-1111-1111-1111-111111111111",
      appName: "shopify",
      endpointName: "customers-create",
      body: { id: 42, email: "amina@example.com" },
      secret: SECRET,
    })
    expect(result.status).toBe(200)
    expect((result.body as { data: { received: boolean } }).data.received).toBe(true)
    expect(capturedRequests).toHaveLength(1)
  })

  it("posts to /webhooks/<orgId>/<appName>/<endpointName> with no /api prefix", async () => {
    reset()
    await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "22222222-2222-2222-2222-222222222222",
      appName: "shopify",
      endpointName: "orders-create",
      body: { id: 7 },
      secret: SECRET,
    })
    const url = new URL(capturedRequests[0].url)
    expect(url.pathname).toBe(
      "/webhooks/22222222-2222-2222-2222-222222222222/shopify/orders-create",
    )
  })

  it("attaches the four Shopify-flavoured headers the verifier reads", async () => {
    reset()
    await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "33333333-3333-3333-3333-333333333333",
      appName: "shopify",
      endpointName: "refunds-create",
      body: { id: 1 },
      secret: SECRET,
      webhookId: "delivery-abc",
    })
    const h = capturedRequests[0].headers
    expect(h["x-shopify-hmac-sha256"]).toBeTruthy()
    expect(h["x-shopify-webhook-id"]).toBe("delivery-abc")
    expect(h["x-shopify-topic"]).toBe("refunds/create")
    expect(h["x-shopify-shop-domain"]).toBe("mock-shop.myshopify.com")
    expect(h["content-type"]).toBe("application/json")
  })

  it("defaults webhookId to a fresh UUID so each call dedup-bypasses by default", async () => {
    reset()
    await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "44444444-4444-4444-4444-444444444444",
      appName: "shopify",
      endpointName: "orders-fulfilled",
      body: { id: 9 },
      secret: SECRET,
    })
    await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "44444444-4444-4444-4444-444444444444",
      appName: "shopify",
      endpointName: "orders-fulfilled",
      body: { id: 10 },
      secret: SECRET,
    })
    const id1 = capturedRequests[0].headers["x-shopify-webhook-id"]
    const id2 = capturedRequests[1].headers["x-shopify-webhook-id"]
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })

  it("derives the canonical topic from the kebab endpoint name (customers-update -> customers/update)", async () => {
    reset()
    await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "55555555-5555-5555-5555-555555555555",
      appName: "shopify",
      endpointName: "customers-update",
      body: { id: 1 },
      secret: SECRET,
    })
    expect(capturedRequests[0].headers["x-shopify-topic"]).toBe("customers/update")
  })

  it("allows overriding the topic header explicitly (for app-uninstalled and similar one-shots)", async () => {
    reset()
    await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "66666666-6666-6666-6666-666666666666",
      appName: "shopify",
      endpointName: "app-uninstalled",
      topic: "app/uninstalled",
      body: { id: 1 },
      secret: SECRET,
    })
    expect(capturedRequests[0].headers["x-shopify-topic"]).toBe("app/uninstalled")
  })

  it("transmits the body bytes verbatim (key order preserved as serialised once)", async () => {
    reset()
    const payload = { z: 1, a: 2, m: { nested: true } }
    await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "77777777-7777-7777-7777-777777777777",
      appName: "shopify",
      endpointName: "customers-create",
      body: payload,
      secret: SECRET,
    })
    expect(capturedRequests[0].body).toBe(JSON.stringify(payload))
  })

  it("returns 401 when the signing secret does not match (verifier rejects)", async () => {
    reset()
    const result = await dispatchTestWebhook({
      serverUrl: server.url.origin,
      orgId: "88888888-8888-8888-8888-888888888888",
      appName: "shopify",
      endpointName: "customers-create",
      body: { id: 1 },
      secret: "wrong-secret",
    })
    expect(result.status).toBe(401)
  })

  it("handles serverUrl with a trailing slash without producing a double slash", async () => {
    reset()
    const trailing = `${server.url.origin}/`
    await dispatchTestWebhook({
      serverUrl: trailing,
      orgId: "99999999-9999-9999-9999-999999999999",
      appName: "shopify",
      endpointName: "orders-create",
      body: { id: 1 },
      secret: SECRET,
    })
    const url = new URL(capturedRequests[0].url)
    expect(url.pathname.startsWith("//")).toBe(false)
    expect(url.pathname).toBe(
      "/webhooks/99999999-9999-9999-9999-999999999999/shopify/orders-create",
    )
  })
})
