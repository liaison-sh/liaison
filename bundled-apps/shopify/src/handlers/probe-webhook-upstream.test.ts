// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Webhook upstream probe. The kernel trusts this report to decide whether webhook
// silence is a dead subscription or a quiet shop, so each branch pins the side it
// errs on: a reachable shop reports its newest order change, a shop with no live
// sender reports null (never pages), and an unreachable shop reports NOTHING (the
// kernel lists the probe as stale rather than reading it as quiet).
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { createEnforcingEmit } from "../lib/emit.testutil"
import { probeWebhookUpstreamJob } from "./probe-webhook-upstream"

interface FetchResponse { status?: number; body: unknown }
interface DbRow extends Record<string, unknown> { id: string }

function makeCtx(opts: {
  shopifyFetch?: FetchResponse[]
  thresholdHours?: number
  connectionStatus?: string
}): {
  ctx: AppContext
  fetchBodies: string[]
} {
  const responses = [...(opts.shopifyFetch ?? [])]
  const { emit } = createEnforcingEmit()
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
  return { ctx, fetchBodies }
}

const latestOrder = (updatedAt: string | null): FetchResponse => ({
  body: { data: { orders: { edges: updatedAt ? [{ node: { updatedAt } }] : [] } } },
})

describe("probeWebhookUpstreamJob", () => {
  it("reports the newest order change, asking Shopify for it sorted by UPDATED_AT", async () => {
    const { ctx, fetchBodies } = makeCtx({ shopifyFetch: [latestOrder("2026-10-10T18:27:31Z")] })
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: "2026-10-10T18:27:31Z" })
    const body = JSON.parse(fetchBodies[0]!) as { query: string }
    expect(body.query).toContain("sortKey: UPDATED_AT")
    expect(body.query).toContain("reverse: true")
    expect(body.query).toContain("first: 1")
  })

  it("a shop with no orders has no sender: reports null", async () => {
    const { ctx } = makeCtx({ shopifyFetch: [latestOrder(null)] })
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
  })

  it("a disconnected shop has no sender: reports null without calling Shopify", async () => {
    const { ctx, fetchBodies } = makeCtx({ connectionStatus: "disconnected" })
    expect(await probeWebhookUpstreamJob({}, ctx)).toEqual({ upstreamActivityAt: null })
    expect(fetchBodies).toEqual([])
  })

  it("an unreachable shop is no report, never a quiet one", async () => {
    const { ctx } = makeCtx({ shopifyFetch: [{ status: 503, body: { errors: "unavailable" } }] })
    const result = await probeWebhookUpstreamJob({}, ctx)
    expect("upstreamActivityAt" in result).toBe(false)
    expect(result).toMatchObject({ probed: false })
  })
})
