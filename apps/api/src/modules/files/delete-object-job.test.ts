// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeAll, describe, expect, it, mock } from "bun:test"

type Mod = typeof import("./delete-object-job")
let mod: Mod

beforeAll(async () => {
  mod = await import("./delete-object-job")
})

// No live row references the key: the lock just runs the deletion.
const unreferenced = (async (_o: string, _k: string, fn: (r: boolean) => Promise<unknown>) =>
  fn(false)) as any

describe("processDeleteObjectJob", () => {
  it("deletes storage and thumbnail keys", async () => {
    const deleted: string[][] = []
    await mod.processDeleteObjectJob(
      { orgId: "o", storageKey: "k1", thumbnailKey: "k1.thumb" },
      {
        deleteObjects: mock(async (keys: string[]) => {
          deleted.push(keys)
        }) as any,
        withKeyLock: unreferenced,
      },
    )
    expect(deleted).toHaveLength(1)
    expect(deleted[0].sort()).toEqual(["k1", "k1.thumb"])
  })

  it("treats missing thumbnailKey gracefully", async () => {
    const deleted: string[][] = []
    await mod.processDeleteObjectJob(
      { orgId: "o", storageKey: "k1", thumbnailKey: null },
      {
        deleteObjects: mock(async (keys: string[]) => {
          deleted.push(keys)
        }) as any,
        withKeyLock: unreferenced,
      },
    )
    expect(deleted[0]).toEqual(["k1"])
  })

  it("rethrows transient errors so BullMQ retries", async () => {
    const fail = mock(async () => {
      throw new Error("ECONNRESET")
    }) as any
    await expect(
      mod.processDeleteObjectJob(
        { orgId: "o", storageKey: "k1", thumbnailKey: null },
        { deleteObjects: fail, withKeyLock: unreferenced },
      ),
    ).rejects.toThrow(/ECONNRESET/)
  })

  it("keeps the object when a live row owns its key again", async () => {
    const del = mock(async () => {}) as any
    const locked: string[] = []
    await mod.processDeleteObjectJob(
      { orgId: "o", storageKey: "k1", thumbnailKey: "k1.thumb" },
      {
        deleteObjects: del,
        withKeyLock: (async (_o: string, key: string, fn: (r: boolean) => Promise<unknown>) => {
          locked.push(key)
          return fn(true)
        }) as any,
      },
    )
    expect(locked).toEqual(["k1"])
    expect(del).not.toHaveBeenCalled()
  })
})
