// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one write path into the search index (index-writer.ts): the vector
// invariant, the vector flag, and the rebuild's replay notes.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import * as searchClientModule from "~/infra/search/client"
import { redis } from "~/lib/redis"
import {
  finalizeDocuments,
  IndexWriterTestAccess,
  REBUILD_KEYS,
  sendIndexWrite,
} from "~/modules/search/index-writer"

const calls: Array<[string, unknown]> = []
const spies: Array<{ mockRestore: () => void }> = []

beforeEach(async () => {
  calls.length = 0
  await redis.del(REBUILD_KEYS.lock, REBUILD_KEYS.touched)
  IndexWriterTestAccess.resetRebuildCache()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue("test_writer_idx"))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue({
      index: (name: string) => ({
        addDocuments: async (docs: unknown) => {
          calls.push([`add:${name}`, docs])
          return { taskUid: 1 }
        },
        deleteDocuments: async (arg: unknown) => {
          calls.push([`delete:${name}`, arg])
          return { taskUid: 2 }
        },
      }),
    } as never),
  )
})

afterEach(async () => {
  for (const s of spies) s.mockRestore()
  spies.length = 0
  await redis.del(REBUILD_KEYS.lock, REBUILD_KEYS.touched)
  IndexWriterTestAccess.resetRebuildCache()
})

describe("finalizeDocuments", () => {
  it("gives every document `_vectors.memory`, and `has_vector` exactly when it has one", () => {
    const docs = finalizeDocuments([
      { id: "a" },
      { id: "b", _vectors: { memory: [0.1, 0.2] } },
      { id: "c", _vectors: { memory: null }, has_vector: true },
      { id: "d", _vectors: { other: [1] } },
    ] as Array<Record<string, unknown>>)
    expect(docs[0]).toEqual({ id: "a", _vectors: { memory: null } })
    expect(docs[1]).toEqual({ id: "b", _vectors: { memory: [0.1, 0.2] }, has_vector: true })
    // A stale flag never survives a document that lost its vector.
    expect(docs[2]).toEqual({ id: "c", _vectors: { memory: null } })
    expect(docs[3]).toEqual({ id: "d", _vectors: { other: [1], memory: null } })
  })
})

describe("sendIndexWrite", () => {
  it("deletes before it adds, and never sends a document without its vector slot", async () => {
    await sendIndexWrite({
      docs: [{ id: "x" }],
      deleteIds: ["y", "y"],
      deleteFilters: ['dedupe_key = "g"'],
    })
    expect(calls.map(([k]) => k)).toEqual([
      "delete:test_writer_idx",
      "delete:test_writer_idx",
      "add:test_writer_idx",
    ])
    expect(calls[0]?.[1]).toEqual(["y"])
    expect(calls[1]?.[1]).toEqual({ filter: 'dedupe_key = "g"' })
    expect(calls[2]?.[1]).toEqual([{ id: "x", _vectors: { memory: null } }])
  })

  it("notes the requests of a live write while a rebuild runs, and only then", async () => {
    const item = { t: "message", key: "k1", payload: { orgId: "o", action: "upsert" as const } }
    await sendIndexWrite({ deleteIds: ["k1"] }, { replay: [item] })
    expect(await redis.hlen(REBUILD_KEYS.touched)).toBe(0)

    await redis.set(REBUILD_KEYS.lock, "rebuild", "PX", 10_000)
    IndexWriterTestAccess.resetRebuildCache()
    await sendIndexWrite({ deleteIds: ["k1"] }, { replay: [item] })
    expect(JSON.parse(String(await redis.hget(REBUILD_KEYS.touched, "k1")))).toEqual(item)

    // The rebuild's own writes to its shadow are not notes.
    await redis.del(REBUILD_KEYS.touched)
    await sendIndexWrite(
      { deleteIds: ["k2"] },
      {
        indexName: "test_writer_idx__rebuild",
        replay: [{ ...item, key: "k2" }],
      },
    )
    expect(await redis.hlen(REBUILD_KEYS.touched)).toBe(0)
  })

  it("a DELETE that cannot be noted for a running rebuild fails the write; an upsert goes ahead", async () => {
    await redis.set(REBUILD_KEYS.lock, "rebuild", "PX", 10_000)
    IndexWriterTestAccess.resetRebuildCache()
    const multi = spyOn(redis, "multi").mockImplementation((() => {
      throw new Error("redis write refused")
    }) as never)
    try {
      const del = {
        t: "raw",
        key: "d1",
        payload: { orgId: "o", action: "delete" as const, ids: ["d1"] },
      }
      await expect(sendIndexWrite({ deleteIds: ["d1"] }, { replay: [del] })).rejects.toThrow(
        "redis write refused",
      )
      // Nothing reached Meili: the caller retries the whole write.
      expect(calls).toEqual([])
      const up = { t: "message", key: "u1", payload: { orgId: "o", action: "upsert" as const } }
      await sendIndexWrite({ docs: [{ id: "u1" }] }, { replay: [up] })
      expect(calls.map(([k]) => k)).toEqual(["add:test_writer_idx"])
    } finally {
      multi.mockRestore()
    }
  })
})
