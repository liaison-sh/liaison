// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  type DraftStoreCtx,
  type DraftStoreDb,
  loadDraftOverride,
  saveDraftOverride,
} from "./draft-store"

// A tiny in-memory app_config store that enforces the real (org_id, key) UNIQUE constraint the kernel
// table carries — `insert` of a key that already exists throws the same shape the sandbox db bridge
// surfaces (`… — pg: duplicate key value violates unique constraint "app_config_org_id_key_key"
// (23505)`). This lets us reproduce the concurrent set_customs race that the l502 park misread as a
// fabricated "Boxtal API error".
function makeStore(): { db: DraftStoreDb; rows: Map<string, { id: string; value: unknown }> } {
  const rows = new Map<string, { id: string; value: unknown }>() // key → row
  let seq = 0
  const db: DraftStoreDb = {
    findMany: async (_entity, opts) => {
      const key = (opts?.where as { key?: string } | undefined)?.key
      if (key == null) return []
      const row = rows.get(key)
      return row ? [row] : []
    },
    insert: async (_entity, data) => {
      const key = String(data.key)
      if (rows.has(key)) {
        throw new Error(
          `db_insert failed — pg: duplicate key value violates unique constraint "app_config_org_id_key_key" (23505)`,
        )
      }
      const id = `cfg-${++seq}`
      rows.set(key, { id, value: data.value })
      return { id }
    },
    update: async (_entity, id, data) => {
      for (const [, row] of rows) {
        if (row.id === id) {
          row.value = data.value
          return
        }
      }
      throw new Error(`update: no row ${id}`)
    },
    delete: async (_entity, id) => {
      for (const [key, row] of rows) {
        if (row.id === id) {
          rows.delete(key)
          return
        }
      }
    },
  }
  return { db, rows }
}

const REF = "draft-123"

describe("saveDraftOverride — concurrency-safe upsert (BL-254)", () => {
  it("inserts the override on first save and merges per-line customs patches on a second save", async () => {
    const { db } = makeStore()
    const ctx: DraftStoreCtx = { db }
    await saveDraftOverride(ctx, REF, { customsByLineId: { lineA: { tariffNumber: "9207.90" } } })
    await saveDraftOverride(ctx, REF, { customsByLineId: { lineB: { tariffNumber: "8543.70" } } })
    const loaded = await loadDraftOverride(ctx, REF)
    expect(loaded?.customsByLineId?.lineA?.tariffNumber).toBe("9207.90")
    expect(loaded?.customsByLineId?.lineB?.tariffNumber).toBe("8543.70")
  })

  it("RECOVERS from a unique-violation insert race (two concurrent saves of the same draft) instead of surfacing a non-2xx", async () => {
    const { db, rows } = makeStore()
    const ctx: DraftStoreCtx = { db }
    // Simulate the race: writer B has already committed a row for REF (the instrument line) BEFORE
    // writer A's read happened — but A's read of an EMPTY store already returned null, so A is about to
    // INSERT. We model that by seeding the row directly, then driving a save whose internal read still
    // misses (we force-miss by pre-clearing A's cached read via a fresh save call). The honest
    // reproduction: do two saves where the FIRST creates the row, and a SECOND save path is forced down
    // the insert branch against an existing key.
    rows.set(`draft_override:${REF}`, {
      id: "cfg-pre",
      value: { customsByLineId: { lineA: { tariffNumber: "9207.90" } } },
    })
    // Patch findMany so writer A's reads BEFORE its insert (both `loadDraftOverride` for the merge and
    // `rowFor` for the branch decision) miss the row B already committed — A then takes the INSERT
    // branch, hits 23505, and must recover via a FRESH re-read (the 3rd read, which sees B's row) +
    // UPDATE. The first two reads return empty; subsequent reads behave normally.
    let reads = 0
    const realFind = db.findMany
    db.findMany = async (entity, opts) => {
      reads++
      if (reads <= 2) return []
      return realFind(entity, opts)
    }
    await expect(
      saveDraftOverride(ctx, REF, { customsByLineId: { lineB: { tariffNumber: "8543.70" } } }),
    ).resolves.toBeDefined()
    // Both lines survive: A's accessory patch merged onto B's instrument row.
    const loaded = await loadDraftOverride(ctx, REF)
    expect(loaded?.customsByLineId?.lineA?.tariffNumber).toBe("9207.90")
    expect(loaded?.customsByLineId?.lineB?.tariffNumber).toBe("8543.70")
  })

  it("does NOT swallow a non-unique insert error (real failures still throw with pg detail)", async () => {
    const { db } = makeStore()
    db.insert = async () => {
      throw new Error("db_insert failed — pg: null value in column \"value\" (23502)")
    }
    const ctx: DraftStoreCtx = { db }
    await expect(
      saveDraftOverride(ctx, REF, { customsByLineId: { lineA: { tariffNumber: "9207.90" } } }),
    ).rejects.toThrow(/23502/)
  })
})
