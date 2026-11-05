// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B12 — Unfulfilled-order scanner tests.
//
// Threshold: install_metadata.unfulfilledThresholdHours (default 24). A scan
// with any matches emits exactly ONE aggregate `orders:unfulfilled_digest`
// event (count, thresholdHours, oldestAgeHours, orderNames); a scan with zero
// matches emits a count-0 digest so the translator's resolveWhen clears the
// previously-emitted row from the feed.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { channelName, createEnforcingEmit } from "../lib/emit.testutil"
import { scanUnfulfilledOrdersJob } from "./scan-unfulfilled"

interface FetchResponse { status?: number; body: unknown }
interface DbRow extends Record<string, unknown> { id: string }

function makeCtx(opts: {
  shopifyFetch?: FetchResponse[]
  thresholdHours?: number
  connectionStatus?: string
}): {
  ctx: AppContext
  events: Array<{ entity: string; action: string; entityId?: string; data?: unknown; metadata?: Record<string, unknown> }>
  channels: string[]
  fetchBodies: string[]
} {
  const responses = [...(opts.shopifyFetch ?? [])]
  // Enforcing emit: throws if the scan emits an `${entity}:${action}` not in
  // the real app.manifest.json (e.g. orders:unfulfilled_digest must be declared).
  const { emit, emits: events, channels } = createEnforcingEmit()
  const fetchBodies: string[] = []
  const tables = new Map<string, DbRow[]>()
  tables.set("install_metadata", [
    {
      id: "i1",
      shopDomain: "demo.myshopify.com",
      connectionId: "ca1",
      apiVersion: "2026-04",
      unfulfilledThresholdHours: opts.thresholdHours ?? 24,
      ...(opts.connectionStatus !== undefined ? { connectionStatus: opts.connectionStatus } : {}),
    } as DbRow,
  ])
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string) => tables.get(entity) ?? [],
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {
      shop: {
        getAccounts: async () => [
          { id: "ca1", ownerType: "org" as const, ownerId: null, identifier: "demo.myshopify.com", displayName: null },
        ],
        getToken: async () => "test-token",
      },
    },
    fetch: async (_url: string, init?: { body?: string }) => {
      fetchBodies.push(init?.body ?? "")
      const next = responses.shift() ?? { body: {} }
      return { status: next.status ?? 200, headers: {}, body: JSON.stringify(next.body) }
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
  return { ctx, events, channels, fetchBodies }
}

const ordersResponse = (
  orders: Array<{ id: string; createdAt: string; name: string; market?: string; currency?: string }>,
): FetchResponse => ({
  body: {
    data: {
      orders: {
        edges: orders.map((o) => ({
          node: {
            id: `gid://shopify/Order/${o.id}`,
            name: o.name,
            createdAt: o.createdAt,
            displayFulfillmentStatus: "UNFULFILLED",
            currencyCode: o.currency ?? "USD",
            presentmentCurrencyCode: o.currency ?? "USD",
            // Order.market does not exist on API 2026-04 — the job derives the
            // market axis from the `market:<name>` tag convention (reads.ts).
            tags: o.market ? [`market:${o.market}`] : [],
          },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  },
})

describe("scanUnfulfilledOrdersJob", () => {
  it("emits ONE orders:unfulfilled_digest event for a single matched order; includes oldestAgeHours", async () => {
    const now = Date.now()
    const dayAgo = new Date(now - 26 * 3600 * 1000).toISOString()
    const { ctx, events, channels } = makeCtx({
      shopifyFetch: [
        ordersResponse([
          { id: "1001", createdAt: dayAgo, name: "#1001" },
        ]),
      ],
    })
    const result = await scanUnfulfilledOrdersJob({}, ctx)
    expect(events.length).toBe(1)
    expect(events[0]!.entity).toBe("orders")
    expect(events[0]!.action).toBe("unfulfilled_digest")
    expect(events[0]!.entityId).toBe("unfulfilled-orders")
    // Canonical channel (emit did not throw => orders:unfulfilled_digest declared).
    expect(channels[0]).toBe(channelName("shopify", "orders", "unfulfilled_digest"))
    const data = events[0]!.data as { count: number; oldestAgeHours: number; orderNames: string[]; thresholdHours: number }
    expect(data.count).toBe(1)
    expect(data.oldestAgeHours).toBeGreaterThanOrEqual(25)
    expect(data.orderNames).toEqual(["#1001"])
    expect(data.thresholdHours).toBe(24)
    expect(result).toEqual({ matched: 1 })
  })

  it("digest event carries no market/currency axis metadata (aggregate spans all markets)", async () => {
    const dayAgo = new Date(Date.now() - 26 * 3600 * 1000).toISOString()
    const { ctx, events } = makeCtx({
      shopifyFetch: [ordersResponse([{ id: "1003", createdAt: dayAgo, name: "#1003", market: "EU", currency: "EUR" }])],
    })
    await scanUnfulfilledOrdersJob({}, ctx)
    expect(events.length).toBe(1)
    expect(events[0]!.metadata).toBeUndefined()
  })

  it("does NOT drop a boundary order whose age equals the threshold exactly", async () => {
    // An order created exactly `threshold` hours ago is past the Shopify cutoff
    // (created_at < cutoff). The previous code re-filtered with
    // `ageHours < threshold` and `Math.floor`, which could drop it. The fix
    // trusts the Shopify cutoff, so it must be counted in the digest.
    const exactlyThreshold = new Date(Date.now() - 24 * 3600 * 1000 - 1000).toISOString()
    const { ctx, events } = makeCtx({
      thresholdHours: 24,
      shopifyFetch: [ordersResponse([{ id: "1004", createdAt: exactlyThreshold, name: "#1004" }])],
    })
    await scanUnfulfilledOrdersJob({}, ctx)
    expect(events.length).toBe(1)
    expect((events[0]!.data as { count: number }).count).toBe(1)
  })

  it("respects custom threshold from install_metadata.unfulfilledThresholdHours", async () => {
    const recent = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    const { ctx, events, fetchBodies } = makeCtx({
      thresholdHours: 1,
      shopifyFetch: [ordersResponse([{ id: "1002", createdAt: recent, name: "#1002" }])],
    })
    await scanUnfulfilledOrdersJob({}, ctx)
    expect(events.length).toBe(1)
    expect((events[0]!.data as { thresholdHours: number }).thresholdHours).toBe(1)
    // The query must include the threshold as a created_at filter AND the
    // lookback lower bound (ancient never-fulfilled orders stay out).
    expect(fetchBodies[0]).toMatch(/created_at:</)
    expect(fetchBodies[0]).toMatch(/created_at:>/)
    // Cancelled/archived orders keep UNFULFILLED bookkeeping status forever;
    // status:open keeps them out of the digest.
    expect(fetchBodies[0]).toMatch(/status:open/)
  })

  it("picks the oldest order and caps orderNames at 5, oldest first", async () => {
    const now = Date.now()
    const ageHoursFor = (h: number) => new Date(now - h * 3600 * 1000).toISOString()
    const { ctx, events } = makeCtx({
      shopifyFetch: [
        ordersResponse([
          { id: "1", createdAt: ageHoursFor(30), name: "#1" },
          { id: "2", createdAt: ageHoursFor(72), name: "#2" },
          { id: "3", createdAt: ageHoursFor(48), name: "#3" },
          { id: "4", createdAt: ageHoursFor(96), name: "#4" },
          { id: "5", createdAt: ageHoursFor(60), name: "#5" },
          { id: "6", createdAt: ageHoursFor(120), name: "#6" },
          { id: "7", createdAt: ageHoursFor(25), name: "#7" },
        ]),
      ],
    })
    const result = await scanUnfulfilledOrdersJob({}, ctx)
    expect(events.length).toBe(1)
    const data = events[0]!.data as { count: number; oldestAgeHours: number; orderNames: string[] }
    expect(data.count).toBe(7)
    expect(data.oldestAgeHours).toBeGreaterThanOrEqual(119)
    expect(data.orderNames).toEqual(["#6", "#4", "#2", "#5", "#3"])
    expect(data.orderNames.length).toBe(5)
    expect(result).toEqual({ matched: 7 })
  })

  it("empty result emits a count-0 digest (resolves the stale feed row)", async () => {
    const { ctx, events } = makeCtx({
      shopifyFetch: [ordersResponse([])],
    })
    const result = await scanUnfulfilledOrdersJob({}, ctx)
    expect(events.length).toBe(1)
    const data = events[0]!.data as { count: number; orderNames: string[] }
    expect(data.count).toBe(0)
    expect(data.orderNames).toEqual([])
    expect(result).toEqual({ matched: 0 })
  })

  it("error from Shopify is swallowed; job completes (no throw)", async () => {
    const { ctx, events } = makeCtx({
      shopifyFetch: [{ status: 500, body: { errors: [{ message: "down" }] } }],
    })
    await scanUnfulfilledOrdersJob({}, ctx)
    expect(events.length).toBe(0)
  })

  it("returns { matched: 0 } immediately when connectionStatus is 'disconnected' and issues no Shopify query", async () => {
    // Post-uninstall guard: the shop connection is no longer valid; scanning
    // would generate noise and potential auth errors.
    const { ctx, events, fetchBodies } = makeCtx({
      connectionStatus: "disconnected",
      // Provide a response to detect if a fetch is accidentally issued.
      shopifyFetch: [ordersResponse([{ id: "9001", createdAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(), name: "#9001" }])],
    })
    const result = await scanUnfulfilledOrdersJob({}, ctx)
    expect(result).toEqual({ matched: 0 })
    expect(events.length).toBe(0)
    // No Shopify API query must have been issued.
    expect(fetchBodies.length).toBe(0)
  })
})
