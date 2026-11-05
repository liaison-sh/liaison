// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 Task B16 — Mock Shopify server unit tests.
// Verifies the request-recording behaviour the per-user enforcement spec
// relies on, plus the operation-routed GraphQL response shape.
import { afterEach, describe, expect, it } from "bun:test"
import { type MockShopifyHandle, startMockShopify } from "./_mock-shopify-server"

// Pick a high port that's unlikely to collide.
let handle: MockShopifyHandle | null = null

afterEach(async () => {
  if (handle) {
    await handle.stop()
    handle = null
  }
})

async function pickPort(): Promise<number> {
  // Bun's Bun.serve will pick a free port if asked for 0 — but our API takes
  // an explicit port, so just generate one in a high range and accept the
  // occasional collision (afterEach cleans up).
  return 39000 + Math.floor(Math.random() * 5000)
}

describe("mock Shopify server", () => {
  it("starts and stops cleanly", async () => {
    const port = await pickPort()
    handle = await startMockShopify({ port })
    expect(handle.url).toBe(`http://127.0.0.1:${port}`)
    const res = await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { authorization: "Bearer test-user-amina", "content-type": "application/json" },
      body: JSON.stringify({ query: "query shop { shop { id name } }" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.shop.id).toBe("gid://shopify/Shop/1")
  })

  it("records every inbound request keyed by Authorization", async () => {
    const port = await pickPort()
    handle = await startMockShopify({ port })
    await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { authorization: "Bearer test-user-amina", "content-type": "application/json" },
      body: JSON.stringify({ query: "query shop { shop { id } }" }),
    })
    await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { authorization: "Bearer test-user-lucas", "content-type": "application/json" },
      body: JSON.stringify({ query: "query shop { shop { id } }" }),
    })
    expect(handle.allRequests().length).toBe(2)
    expect(handle.requestsFromUser("test-user-amina").length).toBe(1)
    expect(handle.requestsFromUser("test-user-lucas").length).toBe(1)
    expect(handle.requestsFromUser("test-user-eve").length).toBe(0)
  })

  it("routes GraphQL responses by operationName", async () => {
    const port = await pickPort()
    handle = await startMockShopify({
      port,
      graphqlResponses: {
        customRefund: {
          data: { refundCreate: { refund: { id: "gid://shopify/Refund/42" }, userErrors: [] } },
        },
      },
    })
    const res = await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { authorization: "Bearer test-user-marie", "content-type": "application/json" },
      body: JSON.stringify({
        operationName: "customRefund",
        query: "mutation customRefund { refundCreate { refund { id } } }",
      }),
    })
    const body = await res.json()
    expect(body.data.refundCreate.refund.id).toBe("gid://shopify/Refund/42")
  })

  it("setPathResponse overrides the OAuth token-exchange endpoint", async () => {
    const port = await pickPort()
    handle = await startMockShopify({ port })
    handle.setPathResponse("/admin/oauth/access_token", 200, {
      access_token: "custom-mock-token",
      scope: "read_orders",
    })
    const res = await fetch(`${handle.url}/admin/oauth/access_token`, { method: "POST" })
    const body = await res.json()
    expect(body.access_token).toBe("custom-mock-token")
  })

  it("records X-Liaison-Actor and groups requestsFromUser by it (P4)", async () => {
    const port = await pickPort()
    handle = await startMockShopify({ port })
    // Two requests sharing the same Authorization (the shared offline token)
    // but different X-Liaison-Actor headers — Amina and Lucas. This mirrors
    // production where Shopify only ever sees one token; per-user isolation
    // hinges on the in-test actor marker the sandbox bridge injects (P4).
    await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: {
        authorization: "Bearer mock-offline-token",
        "content-type": "application/json",
        "x-liaison-actor": "amina-uuid",
      },
      body: JSON.stringify({ query: "query shop { shop { id } }" }),
    })
    await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: {
        authorization: "Bearer mock-offline-token",
        "content-type": "application/json",
        "x-liaison-actor": "lucas-uuid",
      },
      body: JSON.stringify({ query: "query shop { shop { id } }" }),
    })
    const all = handle.allRequests()
    expect(all.length).toBe(2)
    expect(all[0].actor).toBe("amina-uuid")
    expect(all[1].actor).toBe("lucas-uuid")
    // Authorization is shared — grouping by actor is the only way to tell them
    // apart, which is exactly what S2 (per-user enforcement) asserts.
    expect(handle.requestsFromUser("amina-uuid").length).toBe(1)
    expect(handle.requestsFromUser("lucas-uuid").length).toBe(1)
    expect(handle.requestsFromUser("eve-uuid").length).toBe(0)
  })

  it("requestsFromUser falls back to scanning Authorization (host-side calls)", async () => {
    // For calls that don't route through the sandbox bridge (e.g. the
    // OAuth-callback token exchange), the bridge cannot inject the actor
    // header. The fallback path keeps `requestsFromUser` useful for those
    // cases — useful for spec coverage of the install round-trip (S0).
    const port = await pickPort()
    handle = await startMockShopify({ port })
    await fetch(`${handle.url}/admin/oauth/access_token`, {
      method: "POST",
      headers: { authorization: "Bearer test-user-amina" },
    })
    expect(handle.requestsFromUser("test-user-amina").length).toBe(1)
  })

  it("clear() resets the recorded request log without restarting the server", async () => {
    const port = await pickPort()
    handle = await startMockShopify({ port })
    await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { authorization: "Bearer test-user-x" },
      body: "{}",
    })
    expect(handle.allRequests().length).toBe(1)
    handle.clear()
    expect(handle.allRequests().length).toBe(0)
    await fetch(`${handle.url}/admin/api/2026-04/graphql.json`, {
      method: "POST",
      headers: { authorization: "Bearer test-user-y" },
      body: "{}",
    })
    expect(handle.allRequests().length).toBe(1)
  })
})
