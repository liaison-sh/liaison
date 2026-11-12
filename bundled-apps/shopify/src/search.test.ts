// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B7 — Shopify search handler routing tests.
//
// Each test stubs `ctx.fetch` with a captured GraphQL response keyed by
// the query body's top-level field (`orders`, `customers`, `products`)
// and asserts the merged result entity tags.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { SearchTestAccess, searchHandler } from "./search"

interface RouteMap {
  customers?: unknown
  orders?: unknown
  products?: unknown
}

interface CapturedCall {
  query: string
  variables: Record<string, unknown>
}

function makeCtx(opts: {
  route: RouteMap
  shopDomain?: string | null
  calls?: CapturedCall[]
}): AppContext {
  const shopDomain = opts.shopDomain === null ? null : (opts.shopDomain ?? "demo.myshopify.com")
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string) => {
        if (entity === "install_metadata" && shopDomain) {
          return [{ id: "i1", shopDomain, connectionId: "ca1", apiVersion: "2026-04" }]
        }
        return []
      },
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit: async () => undefined,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [
          {
            id: "ca1",
            ownerType: "org" as const,
            ownerId: null,
            identifier: shopDomain ?? "demo.myshopify.com",
            displayName: null,
          },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? "{}") as {
        query?: string
        variables?: Record<string, unknown>
      }
      const q = body.query ?? ""
      opts.calls?.push({ query: q, variables: body.variables ?? {} })
      // Route by which root field the query targets.
      if (q.includes("customers(")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: { customers: opts.route.customers ?? { edges: [], pageInfo: {} } },
          }),
        }
      }
      if (q.includes("orders(")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: { orders: opts.route.orders ?? { edges: [], pageInfo: {} } },
          }),
        }
      }
      if (q.includes("products(")) {
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            data: { products: opts.route.products ?? { edges: [], pageInfo: {} } },
          }),
        }
      }
      return { status: 200, headers: {}, body: JSON.stringify({ data: {} }) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
  } as unknown as AppContext
  return ctx
}

function customerEdge(id: string, email: string) {
  return {
    node: {
      id,
      email,
      firstName: "M",
      lastName: "D",
      tags: [],
      numberOfOrders: "1",
      amountSpent: { amount: "10", currencyCode: "USD" },
    },
  }
}

function orderEdge(id: string, name: string) {
  return {
    node: {
      id,
      name,
      email: "x@example.com",
      createdAt: "2026-05-01T00:00:00Z",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      currentTotalPriceSet: {
        presentmentMoney: { amount: "10", currencyCode: "USD" },
        shopMoney: { amount: "10", currencyCode: "USD" },
      },
      customer: null,
    },
  }
}

function productEdge(id: string, title: string) {
  return {
    node: {
      id,
      title,
      vendor: "ACME",
      status: "ACTIVE",
      totalInventory: 1,
      variants: { edges: [{ node: { id: "v1", sku: "S", price: "1.00", inventoryQuantity: 1 } }] },
    },
  }
}

describe("searchHandler", () => {
  it("routes email-shaped query to customer search", async () => {
    const ctx = makeCtx({
      route: {
        customers: {
          edges: [customerEdge("gid://shopify/Customer/1", "marie@example.com")],
          pageInfo: {},
        },
      },
    })
    const r = await searchHandler({ query: "marie@example.com", filters: {} }, ctx)
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.results[0]!.entity).toBe("customer")
  })

  it("routes order-number query (#1234) to order search", async () => {
    const ctx = makeCtx({
      route: { orders: { edges: [orderEdge("gid://shopify/Order/1", "#1234")], pageInfo: {} } },
    })
    const r = await searchHandler({ query: "#1234", filters: {} }, ctx)
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.results[0]!.entity).toBe("order")
  })

  it("free text fans out to products + orders + customers", async () => {
    const ctx = makeCtx({
      route: {
        customers: { edges: [], pageInfo: {} },
        orders: { edges: [orderEdge("gid://shopify/Order/2", "#22")], pageInfo: {} },
        products: { edges: [productEdge("gid://shopify/Product/3", "Widget")], pageInfo: {} },
      },
    })
    const r = await searchHandler({ query: "widget", filters: {} }, ctx)
    const entities = r.results.map((h) => h.entity).sort()
    expect(entities).toContain("order")
    expect(entities).toContain("product")
  })

  it("returns results tagged with shopify GIDs (caller will tag .app=shopify)", async () => {
    const ctx = makeCtx({
      route: {
        products: { edges: [productEdge("gid://shopify/Product/9", "Widget9")], pageInfo: {} },
      },
    })
    const r = await searchHandler({ query: "widget", filters: {} }, ctx)
    expect(r.results[0]!.id).toMatch(/^gid:\/\/shopify\//)
  })

  it("propagates filters.market by forwarding to the GraphQL `query` arg", async () => {
    let lastBody = ""
    const ctx = makeCtx({
      route: { customers: { edges: [], pageInfo: {} } },
    })
    // Wrap fetch to capture the body
    const orig = ctx.fetch
    ctx.fetch = (async (url: string, init?: { body?: string }) => {
      lastBody = init?.body ?? ""
      return orig(url, init)
    }) as typeof ctx.fetch
    await searchHandler({ query: "marie@example.com", filters: { market: "canada" } }, ctx)
    expect(lastBody).toContain("market:canada")
  })

  it("returns an empty result-set when no roots match", async () => {
    const ctx = makeCtx({ route: {} })
    const r = await searchHandler({ query: "nomatch", filters: {} }, ctx)
    expect(r.results).toEqual([])
  })
})

// — §4.4 handler contract: { query, limit, cursor, marketContext } → { results, nextCursor } —

describe("searchHandler §4.4 contract", () => {
  it("honors marketContext by forwarding `market:<handle>` to the GraphQL query", async () => {
    const calls: CapturedCall[] = []
    const ctx = makeCtx({ route: { customers: { edges: [], pageInfo: {} } }, calls })
    await searchHandler({ query: "marie@example.com", marketContext: "canada" }, ctx)
    expect(calls[0]!.variables.query).toContain("market:canada")
  })

  it("clamps limit to MAX_LIMIT and forwards `first` to Shopify", async () => {
    const calls: CapturedCall[] = []
    const ctx = makeCtx({ route: { customers: { edges: [], pageInfo: {} } }, calls })
    await searchHandler({ query: "marie@example.com", limit: 999 }, ctx)
    expect(calls[0]!.variables.first).toBe(SearchTestAccess.MAX_LIMIT)
  })

  it("defaults limit to 25 when omitted", async () => {
    const calls: CapturedCall[] = []
    const ctx = makeCtx({ route: { customers: { edges: [], pageInfo: {} } }, calls })
    await searchHandler({ query: "marie@example.com" }, ctx)
    expect(calls[0]!.variables.first).toBe(25)
  })

  it("surfaces a composite nextCursor for free-text fanout and resumes each source on page 2", async () => {
    // Page 1: orders + products have a next page; customers do not.
    const calls1: CapturedCall[] = []
    const ctx1 = makeCtx({
      calls: calls1,
      route: {
        orders: {
          edges: [orderEdge("gid://shopify/Order/1", "#1")],
          pageInfo: { endCursor: "O1", hasNextPage: true },
        },
        products: {
          edges: [productEdge("gid://shopify/Product/1", "P1")],
          pageInfo: { endCursor: "P1", hasNextPage: true },
        },
        customers: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
      },
    })
    const page1 = await searchHandler({ query: "widget", limit: 1 }, ctx1)
    expect(page1.nextCursor).not.toBeNull()
    const decoded = JSON.parse(page1.nextCursor as string) as Record<string, string>
    expect(decoded.orders).toBe("O1")
    expect(decoded.products).toBe("P1")
    expect(decoded.customers).toBeUndefined() // no next page → dropped

    // Page 2: the handler must pass each source's cursor back into `after`.
    const calls2: CapturedCall[] = []
    const ctx2 = makeCtx({
      calls: calls2,
      route: {
        orders: { edges: [], pageInfo: {} },
        products: { edges: [], pageInfo: {} },
        customers: { edges: [], pageInfo: {} },
      },
    })
    await searchHandler({ query: "widget", limit: 1, cursor: page1.nextCursor }, ctx2)
    const orderCall = calls2.find((c) => c.query.includes("orders("))
    const productCall = calls2.find((c) => c.query.includes("products("))
    expect(orderCall!.variables.after).toBe("O1")
    expect(productCall!.variables.after).toBe("P1")
  })

  it("returns nextCursor:null when no source has a next page", async () => {
    const ctx = makeCtx({
      route: { customers: { edges: [], pageInfo: { hasNextPage: false } } },
    })
    const r = await searchHandler({ query: "marie@example.com" }, ctx)
    expect(r.nextCursor).toBeNull()
  })

  it("tolerates a malformed opaque cursor by starting from the beginning", () => {
    expect(SearchTestAccess.parseCursor("not-json")).toEqual({})
    expect(SearchTestAccess.parseCursor(null)).toEqual({})
    expect(SearchTestAccess.parseCursor(JSON.stringify({ orders: "X" }))).toEqual({ orders: "X" })
  })
})
