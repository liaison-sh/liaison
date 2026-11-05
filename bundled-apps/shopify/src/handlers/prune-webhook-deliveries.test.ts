// SPDX-License-Identifier: FSL-1.1-ALv2
//
// §3.4 — webhook_deliveries ledger prune tests.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { pruneWebhookDeliveriesJob } from "./prune-webhook-deliveries"

interface Row { id: string; receivedAt: Date }

function makeCtx(rows: Row[]): { ctx: AppContext; deleted: string[] } {
  // The store is the canonical source; findMany returns it oldest-first when
  // orderBy receivedAt asc is requested (mirroring the real bridge), and delete
  // removes by id.
  const store = [...rows]
  const deleted: string[] = []
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (
        entity: string,
        opts?: { orderBy?: Record<string, "asc" | "desc">; limit?: number },
      ) => {
        if (entity !== "webhook_deliveries") return []
        const sorted = [...store]
        if (opts?.orderBy?.receivedAt === "asc") {
          sorted.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
        }
        return opts?.limit !== undefined ? sorted.slice(0, opts.limit) : sorted
      },
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async (entity: string, id: string) => {
        if (entity !== "webhook_deliveries") return
        const idx = store.findIndex((r) => r.id === id)
        if (idx >= 0) store.splice(idx, 1)
        deleted.push(id)
      },
      count: async () => 0,
    },
    emit: async () => undefined,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: {},
    fetch: async () => ({ status: 200, headers: {}, body: "" }),
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
  return { ctx, deleted }
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

describe("pruneWebhookDeliveriesJob", () => {
  it("deletes rows older than 30 days and keeps newer ones", async () => {
    const { ctx, deleted } = makeCtx([
      { id: "old-1", receivedAt: daysAgo(40) },
      { id: "old-2", receivedAt: daysAgo(31) },
      { id: "fresh-1", receivedAt: daysAgo(29) },
      { id: "fresh-2", receivedAt: daysAgo(1) },
    ])
    const res = await pruneWebhookDeliveriesJob({}, ctx)
    expect(res.pruned).toBe(2)
    expect(deleted.sort()).toEqual(["old-1", "old-2"])
  })

  it("no-ops when every row is within the retention window", async () => {
    const { ctx, deleted } = makeCtx([
      { id: "fresh-1", receivedAt: daysAgo(5) },
      { id: "fresh-2", receivedAt: daysAgo(10) },
    ])
    const res = await pruneWebhookDeliveriesJob({}, ctx)
    expect(res.pruned).toBe(0)
    expect(deleted).toEqual([])
  })

  it("no-ops on an empty ledger", async () => {
    const { ctx } = makeCtx([])
    const res = await pruneWebhookDeliveriesJob({}, ctx)
    expect(res.pruned).toBe(0)
  })

  it("stops at the first in-retention row (oldest-first ordering)", async () => {
    // 31d row must be pruned; the 29d row that follows it must NOT be — and the
    // scan must stop there rather than scanning the whole table.
    const { ctx, deleted } = makeCtx([
      { id: "keep", receivedAt: daysAgo(29) },
      { id: "drop", receivedAt: daysAgo(31) },
    ])
    const res = await pruneWebhookDeliveriesJob({}, ctx)
    expect(res.pruned).toBe(1)
    expect(deleted).toEqual(["drop"])
  })
})
