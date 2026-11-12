// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { ShopifyClient, type ShopifyFetchResponse, throttlePauseFor } from "./shopify-client"

const COST_OK = { cost: { throttleStatus: { currentlyAvailable: 1000, restoreRate: 50 } } }
const COST_LOW = { cost: { throttleStatus: { currentlyAvailable: 50, restoreRate: 50 } } }

function okResponse(body: object): ShopifyFetchResponse {
  return { status: 200, headers: {}, body: JSON.stringify(body) }
}

describe("ShopifyClient", () => {
  it("query returns data on a 200 response", async () => {
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => okResponse({ data: { ok: true }, extensions: COST_OK }),
    })
    const r = await client.query<{ ok: boolean }>("query { ok }", {})
    expect(r.ok).toBe(true)
  })

  it("retries once with after:null when the API rejects a malformed cursor", async () => {
    const bodies: string[] = []
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async (req) => {
        bodies.push(typeof req.body === "string" ? req.body : "")
        n++
        // First call (carrying the bad cursor) → Shopify "Malformed cursor"; the
        // fallback retry (after:null) → ok.
        if (n === 1)
          return okResponse({ errors: [{ message: "Malformed cursor" }], extensions: COST_OK })
        return okResponse({ data: { orders: { edges: [] } }, extensions: COST_OK })
      },
    })
    const r = await client.query<{ orders: { edges: unknown[] } }>(
      "query($after:String){ orders }",
      { after: "garbage-cursor" },
    )
    expect(r.orders.edges).toEqual([])
    expect(n).toBe(2) // initial + exactly one cursor-fallback retry
    expect(JSON.parse(bodies[0]!).variables.after).toBe("garbage-cursor")
    expect(JSON.parse(bodies[1]!).variables.after).toBe(null)
  })

  it("does NOT retry a malformed-cursor error when no cursor was sent (after is null)", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return okResponse({ errors: [{ message: "Malformed cursor" }], extensions: COST_OK })
      },
    })
    await expect(client.query("query{ orders }", { after: null })).rejects.toThrow(
      /Malformed cursor/,
    )
    expect(n).toBe(1) // nothing to degrade to → no fallback retry
  })

  it("does NOT retry a non-cursor GraphQL error even with a cursor present", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return okResponse({
          errors: [{ message: "Field 'foo' doesn't exist" }],
          extensions: COST_OK,
        })
      },
    })
    await expect(client.query("query($after:String){ orders }", { after: "c" })).rejects.toThrow(
      /doesn't exist/,
    )
    expect(n).toBe(1)
  })

  it("reports a pause for a low cost bucket, long enough to refill to the watermark", async () => {
    const pauses: number[] = []
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return okResponse({ data: { ok: true }, extensions: COST_LOW })
      },
      throttleLowWatermark: 100,
      onThrottle: (ms) => {
        pauses.push(ms)
      },
    })
    const started = Date.now()
    await client.query("query { ok }", {})
    await client.query("query { ok }", {})
    // (100 - 50) points at 50 points/s: one second, reported, never waited in the run.
    expect(pauses).toEqual([1000, 1000])
    expect(n).toBe(2)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it("reports no pause while the bucket holds the watermark", async () => {
    const pauses: number[] = []
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => okResponse({ data: { ok: true }, extensions: COST_OK }),
      onThrottle: (ms) => {
        pauses.push(ms)
      },
    })
    await client.query("query { ok }", {})
    expect(pauses).toEqual([])
  })

  it("a failing pause report never fails the call", async () => {
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => okResponse({ data: { ok: true }, extensions: COST_LOW }),
      onThrottle: async () => {
        throw new Error("limiter unavailable")
      },
    })
    const r = await client.query<{ ok: boolean }>("query { ok }", {})
    expect(r.ok).toBe(true)
  })

  it("retries 429 up to 3 times, at once, then throws", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return { status: 429, headers: { "retry-after": "30" }, body: "" }
      },
    })
    const started = Date.now()
    await expect(client.query("query{}", {})).rejects.toThrow(/429/)
    expect(n).toBe(4) // initial + 3 retries
    // The limiter holds the retries for Retry-After; the client itself never waits.
    expect(Date.now() - started).toBeLessThan(500)
  })

  it("a fail-fast client throws RATE_LIMIT on the first 429", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      failFast: true,
      fetch: async () => {
        n++
        return { status: 429, headers: { "retry-after": "1" }, body: "" }
      },
    })
    await expect(client.query("query{}", {})).rejects.toMatchObject({ code: "RATE_LIMIT" })
    expect(n).toBe(1)
  })

  it("propagates 401 immediately as CONNECTION_LOST (no retry)", async () => {
    let n = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => {
        n++
        return { status: 401, headers: {}, body: "" }
      },
    })
    await expect(client.query("query{}", {})).rejects.toMatchObject({ code: "CONNECTION_LOST" })
    expect(n).toBe(1)
  })

  it("propagates 403 as SCOPE_DENIED (no retry)", async () => {
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => ({ status: 403, headers: {}, body: "" }),
    })
    await expect(client.query("query{}", {})).rejects.toMatchObject({ code: "SCOPE_DENIED" })
  })

  it("paginate iterates edges across multiple GraphQL pages", async () => {
    const pages = [
      {
        data: {
          customers: {
            edges: [{ node: { id: "1" } }],
            pageInfo: { hasNextPage: true, endCursor: "c1" },
          },
        },
        extensions: COST_OK,
      },
      {
        data: {
          customers: {
            edges: [{ node: { id: "2" } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        extensions: COST_OK,
      },
    ]
    let i = 0
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => okResponse(pages[i++]!),
    })
    const ids: string[] = []
    for await (const node of client.paginate<{ id: string }>({ query: "...", path: "customers" })) {
      ids.push(node.id)
    }
    expect(ids).toEqual(["1", "2"])
  })

  it("baseUrlOverride routes the GraphQL call to the override host (P2a)", async () => {
    const urls: string[] = []
    const client = new ShopifyClient({
      shop: "demo",
      baseUrlOverride: "http://127.0.0.1:40001",
      fetch: async (req) => {
        urls.push(req.url)
        return okResponse({ data: { ok: true }, extensions: COST_OK })
      },
    })
    await client.query("query { ok }", {})
    expect(urls[0]).toBe("http://127.0.0.1:40001/admin/api/2026-04/graphql.json")
  })

  it("baseUrlOverride strips a trailing slash", async () => {
    const urls: string[] = []
    const client = new ShopifyClient({
      shop: "demo",
      baseUrlOverride: "http://127.0.0.1:40001/",
      fetch: async (req) => {
        urls.push(req.url)
        return okResponse({ data: { ok: true }, extensions: COST_OK })
      },
    })
    await client.query("query { ok }", {})
    expect(urls[0]).toBe("http://127.0.0.1:40001/admin/api/2026-04/graphql.json")
  })

  it("without baseUrlOverride, falls back to the canonical Shopify host", async () => {
    const urls: string[] = []
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async (req) => {
        urls.push(req.url)
        return okResponse({ data: { ok: true }, extensions: COST_OK })
      },
    })
    await client.query("query { ok }", {})
    expect(urls[0]).toBe("https://demo.myshopify.com/admin/api/2026-04/graphql.json")
  })

  it("malformed extensions.cost defaults to 'no throttle' (no pause reported)", async () => {
    const pauses: number[] = []
    const client = new ShopifyClient({
      shop: "demo",
      fetch: async () => okResponse({ data: { ok: true }, extensions: { cost: "nope" } }),
      onThrottle: (ms) => {
        pauses.push(ms)
      },
    })
    await client.query("query {}", {})
    expect(pauses).toEqual([])
  })
})

describe("throttlePauseFor", () => {
  it("is the refill time to the watermark at the restore rate", () => {
    expect(throttlePauseFor({ currentlyAvailable: 50, restoreRate: 50 }, 100, 1000)).toBe(1000)
    expect(throttlePauseFor({ currentlyAvailable: 90, restoreRate: 100 }, 100, 1000)).toBe(100)
  })

  it("is the fallback without a restore rate, 0 at or above the watermark", () => {
    expect(throttlePauseFor({ currentlyAvailable: 10 }, 100, 1000)).toBe(1000)
    expect(throttlePauseFor({ currentlyAvailable: 100, restoreRate: 50 }, 100, 1000)).toBe(0)
    expect(throttlePauseFor(undefined, 100, 1000)).toBe(0)
  })

  it("never exceeds the limiter's 60 s cap", () => {
    expect(throttlePauseFor({ currentlyAvailable: 0, restoreRate: 0.5 }, 100, 1000)).toBe(60_000)
  })
})
