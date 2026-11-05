// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { beforeEach, describe, expect, it, vi } from "vitest"

const ENTRY = {
  type: "user" as const,
  name: "role",
  description: "Senior eng",
  content: "...",
  updatedAt: "2026-05-23T00:00:00Z",
}

function makeApi(overrides: Partial<Record<"get" | "post" | "delete", any>> = {}): any {
  return {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue(ENTRY),
    put: vi.fn(),
    patch: vi.fn().mockResolvedValue(ENTRY),
    delete: vi.fn().mockResolvedValue(undefined),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
    ...overrides,
  }
}

describe("memories-store", () => {
  beforeEach(() => vi.resetModules())

  it("loadMemories GETs /agent/memories and hydrates state", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./memories-store")
      const api = makeApi({
        get: vi.fn().mockResolvedValue([
          { ...ENTRY },
          {
            type: "feedback",
            name: "no-emoji",
            description: "No emoji",
            content: "...",
            updatedAt: "2026-05-22T00:00:00Z",
          },
        ]),
      })
      await store.loadMemories(api)
      expect(api.get).toHaveBeenCalledWith("/agent/memories")
      expect(store.memoriesStore.memories).toHaveLength(2)
      expect(store.memoriesStore.loading).toBe(false)
      dispose()
    })
  })

  it("createMemory POSTs and prepends to state", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./memories-store")
      const api = makeApi()
      await store.createMemory(api, {
        type: "user",
        name: "role",
        description: "Senior eng",
        content: "...",
      })
      expect(api.post).toHaveBeenCalledWith(
        "/agent/memories",
        expect.objectContaining({ type: "user", name: "role" }),
      )
      expect(store.memoriesStore.memories[0]?.name).toBe("role")
      dispose()
    })
  })

  it("deleteMemory optimistically removes and reverts on failure", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./memories-store")
      const failingApi = makeApi({
        get: vi.fn().mockResolvedValue([{ ...ENTRY }]),
        delete: vi.fn().mockRejectedValue(new Error("net")),
      })
      await store.loadMemories(failingApi)
      await expect(store.deleteMemory(failingApi, "user", "role")).rejects.toThrow("net")
      expect(store.memoriesStore.memories).toHaveLength(1)
      dispose()
    })
  })

  it("deleteMemory removes from state on success", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./memories-store")
      const api = makeApi({ get: vi.fn().mockResolvedValue([{ ...ENTRY }]) })
      await store.loadMemories(api)
      await store.deleteMemory(api, "user", "role")
      expect(api.delete).toHaveBeenCalledWith("/agent/memories/user/role")
      expect(store.memoriesStore.memories).toHaveLength(0)
      dispose()
    })
  })

  it("loadMemories failure stores error and keeps memories untouched", async () => {
    await createRoot(async (dispose) => {
      const store = await import("./memories-store")
      const api = makeApi({ get: vi.fn().mockRejectedValue(new Error("oops")) })
      await store.loadMemories(api)
      expect(store.memoriesStore.error).toBe("oops")
      expect(store.memoriesStore.loading).toBe(false)
      dispose()
    })
  })
})
