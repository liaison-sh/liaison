// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import { makeSandboxSearchHandler } from "./external-bridge"
import {
  ExternalSearchHandlersTestAccess,
  type ExternalSearchHit,
  fanoutExternal,
  registerExternalSearchHandler,
  unregisterExternalSearchHandler,
  unregisterExternalSearchHandlersForApp,
} from "./external-handlers"

/** Build a §4.4 handler that returns a fixed page + optional nextCursor. */
function fixedHandler(hits: ExternalSearchHit[], nextCursor: string | null = null) {
  return async () => ({ hits, nextCursor })
}

describe("external search handlers", () => {
  beforeEach(() => {
    ExternalSearchHandlersTestAccess.reset()
  })

  it("returns empty when no handlers registered", async () => {
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.hits).toEqual([])
    expect(r.timedOut).toEqual([])
    expect(r.cursors).toEqual({})
  })

  it("tags hits with source:external:<app>", async () => {
    registerExternalSearchHandler(
      "o",
      "shopify",
      fixedHandler([{ id: "x", app: "shopify", entity_type: "order", title: "#1001" }]),
    )
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.hits[0].source).toBe("external:shopify")
  })

  it("isolates handler errors and continues other handlers", async () => {
    registerExternalSearchHandler(
      "o",
      "shopify",
      fixedHandler([{ id: "x", app: "shopify", entity_type: "order", title: "#1001" }]),
    )
    registerExternalSearchHandler("o", "broken", async () => {
      throw new Error("boom")
    })
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.hits.map((h) => h.app)).toEqual(["shopify"])
    expect(r.timedOut).toEqual([])
    // The broken handler contributes no cursor; the healthy one does.
    expect(r.cursors).not.toHaveProperty("broken")
    expect(r.cursors).toHaveProperty("shopify")
  })

  it("flags slow handlers as timedOut without stalling others (per-handler timeout override)", async () => {
    registerExternalSearchHandler(
      "o",
      "fast",
      fixedHandler([{ id: "f", app: "fast", entity_type: "thing", title: "Fast" }]),
    )
    registerExternalSearchHandler(
      "o",
      "slow",
      // Never answers: only the per-handler override can end its wait.
      () => new Promise<never>(() => {}),
      { timeoutMs: 50 },
    )
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.hits.map((h) => h.app)).toEqual(["fast"])
    expect(r.timedOut).toContain("slow")
  }, 3000)

  // Phase 16 Task A4 — back-compat hit-shape rename + sandbox bridge.
  it("populates `entity` from `entity_type` for back-compat handlers", async () => {
    registerExternalSearchHandler(
      "o",
      "legacy",
      fixedHandler([{ id: "1", app: "legacy", entity_type: "order", title: "X" }]),
    )
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.hits[0].entity).toBe("order")
    expect(r.hits[0].entity_type).toBe("order")
  })

  it("populates `entity_type` from `entity` for new handlers", async () => {
    registerExternalSearchHandler(
      "o",
      "modern",
      fixedHandler([{ id: "1", app: "modern", entity: "product", title: "X" }]),
    )
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.hits[0].entity).toBe("product")
    expect(r.hits[0].entity_type).toBe("product")
  })

  it("default timeout (5s) does not flag a handler returning under 1s", async () => {
    registerExternalSearchHandler("o", "medium", async () => {
      await new Promise((r) => setTimeout(r, 200))
      return { hits: [{ id: "1", app: "medium", entity: "x", title: "y" }], nextCursor: null }
    })
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.timedOut).not.toContain("medium")
    expect(r.hits.length).toBe(1)
  }, 3000)

  // Cluster-5 minor fix — the registry is keyed by (org, app). A handler
  // registered for org A must never run against org B's query, and the same
  // app installed in two orgs must register two independent handlers.
  it("only runs handlers registered for the requesting org", async () => {
    registerExternalSearchHandler(
      "orgA",
      "shopify",
      fixedHandler([{ id: "a", app: "shopify", entity: "order", title: "A-order" }]),
    )
    registerExternalSearchHandler(
      "orgB",
      "shopify",
      fixedHandler([{ id: "b", app: "shopify", entity: "order", title: "B-order" }]),
    )
    const rA = await fanoutExternal({ orgId: "orgA", userId: "u", q: "x", filters: {} })
    expect(rA.hits.map((h) => h.id)).toEqual(["a"])
    const rB = await fanoutExternal({ orgId: "orgB", userId: "u", q: "x", filters: {} })
    expect(rB.hits.map((h) => h.id)).toEqual(["b"])
  })

  it("registering the same app in two orgs does not overwrite the first", async () => {
    registerExternalSearchHandler(
      "orgA",
      "shopify",
      fixedHandler([{ id: "a", app: "shopify", entity: "order", title: "A" }]),
    )
    registerExternalSearchHandler(
      "orgB",
      "shopify",
      fixedHandler([{ id: "b", app: "shopify", entity: "order", title: "B" }]),
    )
    // org A's handler still fires after org B registered the same app.
    const rA = await fanoutExternal({ orgId: "orgA", userId: "u", q: "x", filters: {} })
    expect(rA.hits.map((h) => h.id)).toEqual(["a"])
  })

  it("unregister is org-scoped — removes only the named org's handler", async () => {
    registerExternalSearchHandler(
      "orgA",
      "shopify",
      fixedHandler([{ id: "a", app: "shopify", entity: "order", title: "A" }]),
    )
    registerExternalSearchHandler(
      "orgB",
      "shopify",
      fixedHandler([{ id: "b", app: "shopify", entity: "order", title: "B" }]),
    )
    unregisterExternalSearchHandler("orgA", "shopify")
    const rA = await fanoutExternal({ orgId: "orgA", userId: "u", q: "x", filters: {} })
    expect(rA.hits).toEqual([])
    const rB = await fanoutExternal({ orgId: "orgB", userId: "u", q: "x", filters: {} })
    expect(rB.hits.map((h) => h.id)).toEqual(["b"])
  })

  it("unregisterExternalSearchHandlersForApp removes every org's handler for that app", async () => {
    registerExternalSearchHandler(
      "orgA",
      "shopify",
      fixedHandler([{ id: "a", app: "shopify", entity: "order", title: "A" }]),
    )
    registerExternalSearchHandler(
      "orgB",
      "shopify",
      fixedHandler([{ id: "b", app: "shopify", entity: "order", title: "B" }]),
    )
    unregisterExternalSearchHandlersForApp("shopify")
    const rA = await fanoutExternal({ orgId: "orgA", userId: "u", q: "x", filters: {} })
    const rB = await fanoutExternal({ orgId: "orgB", userId: "u", q: "x", filters: {} })
    expect(rA.hits).toEqual([])
    expect(rB.hits).toEqual([])
  })

  // Phase 16 §4.4 / §3.7 pagination — fanout MUST forward limit/cursor/
  // marketContext to each handler and surface each source's nextCursor back.
  it("forwards the §4.4 params (query, limit, cursor, marketContext) into the handler", async () => {
    let seen: unknown
    registerExternalSearchHandler("o", "shopify", async (params) => {
      seen = params
      return { hits: [], nextCursor: null }
    })
    await fanoutExternal({
      orgId: "o",
      userId: "u",
      q: "marie",
      filters: {},
      limit: 25,
      cursors: { shopify: "page-1-cursor" },
      marketContext: "eu",
    })
    expect(seen).toEqual({
      orgId: "o",
      userId: "u",
      query: "marie",
      limit: 25,
      cursor: "page-1-cursor",
      marketContext: "eu",
    })
  })

  it("each source receives only its own cursor (sections paginate independently)", async () => {
    const seen: Record<string, string | null | undefined> = {}
    registerExternalSearchHandler("o", "shopify", async (p) => {
      seen.shopify = p.cursor
      return { hits: [], nextCursor: null }
    })
    registerExternalSearchHandler("o", "acme", async (p) => {
      seen.acme = p.cursor
      return { hits: [], nextCursor: null }
    })
    await fanoutExternal({
      orgId: "o",
      userId: "u",
      q: "x",
      filters: {},
      cursors: { shopify: "S", acme: "T" },
    })
    expect(seen.shopify).toBe("S")
    expect(seen.acme).toBe("T")
  })

  it("surfaces each source's nextCursor under cursors[app]", async () => {
    registerExternalSearchHandler(
      "o",
      "shopify",
      fixedHandler([{ id: "1", app: "shopify", entity: "order", title: "X" }], "next-shopify"),
    )
    registerExternalSearchHandler(
      "o",
      "acme",
      fixedHandler([{ id: "2", app: "acme", entity: "charge", title: "Y" }], null),
    )
    const r = await fanoutExternal({ orgId: "o", userId: "u", q: "x", filters: {} })
    expect(r.cursors.shopify).toBe("next-shopify")
    expect(r.cursors.acme).toBe(null)
  })

  it("sandbox bridge dispatches the §4.4 payload (no orgId/userId leak into bundle)", async () => {
    let dispatched: unknown
    const h = makeSandboxSearchHandler({
      appName: "shopify",
      handlerName: "searchHandler",
      timeoutMs: 5000,
      dispatch: async (_name, payload) => {
        dispatched = payload
        return { results: [], nextCursor: null }
      },
    })
    await h({
      orgId: "o",
      userId: "u",
      query: "marie",
      limit: 10,
      cursor: "C",
      marketContext: "eu",
    })
    expect(dispatched).toEqual({ query: "marie", limit: 10, cursor: "C", marketContext: "eu" })
  })

  it("sandbox bridge maps handler output to ExternalSearchHit shape and propagates nextCursor", async () => {
    const h = makeSandboxSearchHandler({
      appName: "shopify",
      handlerName: "searchHandler",
      timeoutMs: 5000,
      dispatch: async () => ({
        results: [
          {
            id: "gid://shopify/Order/1",
            entity: "order",
            title: "Order #1001",
            snippet: "Marie",
            market: "EU",
            currency: "EUR",
          },
        ],
        nextCursor: "opaque-cursor",
      }),
    })
    const r = await h({ orgId: "o", userId: "u", query: "marie" })
    expect(r.hits[0]).toMatchObject({
      app: "shopify",
      id: "gid://shopify/Order/1",
      entity: "order",
      entity_type: "order",
      title: "Order #1001",
      market: "EU",
      currency: "EUR",
    })
    expect(r.nextCursor).toBe("opaque-cursor")
  })

  it("sandbox bridge returns empty page when dispatch result is not a {results:[]} shape", async () => {
    const h = makeSandboxSearchHandler({
      appName: "x",
      handlerName: "h",
      timeoutMs: 1000,
      dispatch: async () => ({ wrong: "shape" }),
    })
    const r = await h({ orgId: "o", userId: "u", query: "q" })
    expect(r.hits).toEqual([])
    expect(r.nextCursor).toBe(null)
  })
})
