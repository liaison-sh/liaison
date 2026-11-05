// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 H1 helper contract test — asserts `installShopifyApp` builds
// the right HTTP request shape against the test-only kernel route and
// returns the route's response verbatim. Runs against an in-memory mock
// `fetch` (no real server) so the test is fast + self-contained.
import { afterEach, describe, expect, it } from "bun:test"
import { installShopifyApp } from "./install-shopify-app"

interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function withMockFetch(handler: (req: RecordedRequest) => Response): {
  requests: RecordedRequest[]
  restore: () => void
} {
  const original = globalThis.fetch
  const requests: RecordedRequest[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const headersObj: Record<string, string> = {}
    const initHeaders = init?.headers
    if (initHeaders && typeof initHeaders === "object") {
      for (const [k, v] of Object.entries(initHeaders as Record<string, string>)) {
        headersObj[k] = v
      }
    }
    let parsedBody: unknown
    if (init?.body) {
      try {
        parsedBody = JSON.parse(init.body as string)
      } catch {
        parsedBody = init.body
      }
    }
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers: headersObj,
      body: parsedBody,
    }
    requests.push(req)
    return handler(req)
  }) as typeof fetch
  return {
    requests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

describe("installShopifyApp (H1 client)", () => {
  let restore: (() => void) | null = null
  afterEach(() => {
    if (restore) {
      restore()
      restore = null
    }
  })

  it("POSTs to /api/_test/shopify/install-for-test with the bearer token and request body", async () => {
    const mock = withMockFetch(
      () =>
        new Response(
          JSON.stringify({
            appName: "shopify",
            connectionId: "conn-1",
            webhookSecret: "secret-1",
            shopDomain: "mock-shop.myshopify.com",
            installMetadataRowId: "im-1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    )
    restore = mock.restore
    const result = await installShopifyApp({
      serverUrl: "http://localhost:3001",
      token: "test-token",
      orgId: "00000000-0000-0000-0000-000000000001",
      mockShopifyUrl: "http://localhost:40010",
      bundlePath: "/abs/path/shopify-0.1.0.liaisonapp",
      shopDomain: "mock-shop.myshopify.com",
      grantedScopes: ["shopify:orders:read", "shopify:refunds:write"],
    })
    expect(mock.requests.length).toBe(1)
    const req = mock.requests[0]
    expect(req.url).toBe("http://localhost:3001/api/_test/shopify/install-for-test")
    expect(req.method).toBe("POST")
    expect(req.headers.Authorization).toBe("Bearer test-token")
    expect(req.headers["Content-Type"]).toBe("application/json")
    expect(req.body).toEqual({
      orgId: "00000000-0000-0000-0000-000000000001",
      mockShopifyUrl: "http://localhost:40010",
      bundlePath: "/abs/path/shopify-0.1.0.liaisonapp",
      shopDomain: "mock-shop.myshopify.com",
      grantedScopes: ["shopify:orders:read", "shopify:refunds:write"],
    })
    expect(result.connectionId).toBe("conn-1")
    expect(result.webhookSecret).toBe("secret-1")
    expect(result.installMetadataRowId).toBe("im-1")
    expect(result.shopDomain).toBe("mock-shop.myshopify.com")
    expect(result.appName).toBe("shopify")
  })

  it("throws with the body content when the route returns non-200", async () => {
    const mock = withMockFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "missing orgId" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    )
    restore = mock.restore
    await expect(
      installShopifyApp({
        serverUrl: "http://localhost:3001",
        token: "test-token",
        orgId: "00000000-0000-0000-0000-000000000001",
        mockShopifyUrl: "http://localhost:40010",
      }),
    ).rejects.toThrow(/400/)
  })

  it("omits optional fields from the body when not supplied", async () => {
    const mock = withMockFetch(
      () =>
        new Response(
          JSON.stringify({
            appName: "shopify",
            connectionId: "conn-2",
            webhookSecret: "secret-2",
            shopDomain: "mock-shop.myshopify.com",
            installMetadataRowId: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    )
    restore = mock.restore
    await installShopifyApp({
      serverUrl: "http://localhost:3001",
      token: "test-token",
      orgId: "00000000-0000-0000-0000-000000000001",
      mockShopifyUrl: "http://localhost:40010",
    })
    const body = mock.requests[0].body as Record<string, unknown>
    expect(body.orgId).toBe("00000000-0000-0000-0000-000000000001")
    expect(body.mockShopifyUrl).toBe("http://localhost:40010")
    expect(body.bundlePath).toBeUndefined()
    expect(body.shopDomain).toBeUndefined()
    expect(body.grantedScopes).toBeUndefined()
  })
})
