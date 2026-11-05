// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  clearFilters,
  resetSearchStore,
  searchStore,
  setFilters,
  setOffset,
  setQuery,
} from "~/modules/search/search-store"

function mockApi(responses: Record<string, unknown>) {
  const calls: string[] = []
  const getEnvelope = vi.fn(async (path: string) => {
    calls.push(path)
    const v = responses[path]
    if (v && typeof v === "object" && "__error" in (v as object)) {
      const err = (v as { __error: { code?: string; status?: number } }).__error
      throw new ApiError("err", err.status ?? 503, err.code)
    }
    return v as { data: unknown[]; meta?: Record<string, unknown> }
  })
  return {
    getEnvelope,
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    calls,
  }
}

describe("search-store", () => {
  beforeEach(() => {
    resetSearchStore()
    vi.useFakeTimers()
  })

  it("debounces query and calls /search/page", async () => {
    const api = mockApi({
      "/search/page?q=usb&limit=25&offset=0": {
        data: [{ id: "x", app: "kernel", entity_type: "thread" }],
        meta: { total: 1, limit: 25, offset: 0 },
      },
    })
    setQuery("usb", api as any)
    expect(api.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(220)
    expect(api.calls).toContain("/search/page?q=usb&limit=25&offset=0")
    expect(searchStore.hits.length).toBe(1)
    expect(searchStore.total).toBe(1)
  })

  it("renders 503 state on SEARCH_UNAVAILABLE", async () => {
    const api = mockApi({
      "/search/page?q=x&limit=25&offset=0": {
        __error: { code: "SEARCH_UNAVAILABLE", status: 503 },
      },
    })
    setQuery("x", api as any)
    await vi.advanceTimersByTimeAsync(220)
    await Promise.resolve()
    await Promise.resolve()
    expect(searchStore.unavailable).toBe(true)
    expect(searchStore.hits.length).toBe(0)
  })

  it("clears results for empty query without calling API", async () => {
    const api = mockApi({})
    setQuery("", api as any)
    await vi.advanceTimersByTimeAsync(220)
    expect(api.calls).toEqual([])
    expect(searchStore.hits.length).toBe(0)
  })

  it("setOffset re-runs immediately", async () => {
    const api = mockApi({
      "/search/page?q=k&limit=25&offset=0": {
        data: [{ id: "a", app: "kernel", entity_type: "thread" }],
        meta: { total: 60, limit: 25, offset: 0 },
      },
      "/search/page?q=k&limit=25&offset=25": {
        data: [{ id: "b", app: "kernel", entity_type: "thread" }],
        meta: { total: 60, limit: 25, offset: 25 },
      },
    })
    setQuery("k", api as any)
    await vi.advanceTimersByTimeAsync(220)
    setOffset(25, api as any)
    await Promise.resolve()
    await Promise.resolve()
    expect(api.calls).toContain("/search/page?q=k&limit=25&offset=25")
  })

  it("setFilters resets offset and re-debounces", async () => {
    const api = mockApi({
      "/search/page?q=k&limit=25&offset=0": {
        data: [],
        meta: { total: 0, limit: 25, offset: 0 },
      },
      "/search/page?q=k&limit=25&offset=0&app=kernel": {
        data: [{ id: "z", app: "kernel", entity_type: "thread" }],
        meta: { total: 1, limit: 25, offset: 0 },
      },
    })
    setQuery("k", api as any)
    await vi.advanceTimersByTimeAsync(220)
    setOffset(25, api as any)
    setFilters({ app: ["kernel"] }, api as any)
    await vi.advanceTimersByTimeAsync(220)
    expect(searchStore.offset).toBe(0)
    expect(api.calls).toContain("/search/page?q=k&limit=25&offset=0&app=kernel")
  })

  it("clearFilters drops filters", async () => {
    const api = mockApi({
      "/search/page?q=k&limit=25&offset=0": { data: [], meta: { total: 0, limit: 25, offset: 0 } },
    })
    setQuery("k", api as any)
    setFilters({ app: ["x"] }, api as any)
    clearFilters(api as any)
    expect(searchStore.filters.app).toBeUndefined()
  })
})
