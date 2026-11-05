// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import {
  getById,
  load,
  pendingRequests,
  type ScopeRequestRow,
  scopeRequestsStore,
} from "~/modules/admin-scope-requests/scope-requests-store"

function makeRow(overrides: Partial<ScopeRequestRow> = {}): ScopeRequestRow {
  return {
    id: "req-1",
    requestedBy: "u1",
    requestedByType: "user",
    targetUserId: "u1",
    requestedScopes: ["tickets:read"],
    status: "pending",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function makeFakeApi(getMock: ReturnType<typeof vi.fn>): ApiClient {
  return {
    get: getMock,
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as ApiClient
}

beforeEach(() => {
  scopeRequestsStore.stop()
})

afterEach(() => {
  scopeRequestsStore.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("scope-requests-store — prune on poll", () => {
  it("removes a row from the store once a poll response no longer includes it as pending", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce([makeRow({ id: "req-1" })])
      .mockResolvedValueOnce([])
    const api = makeFakeApi(getMock)
    await load(api)
    expect(pendingRequests().map((r) => r.id)).toEqual(["req-1"])
    // Simulate the row having moved to "approved" server-side (WS update landed
    // locally first, or we just haven't heard the WS frame yet) then a normal
    // poll comes back without it because the endpoint only returns pending rows.
    scopeRequestsStore.handleWsUpdate(makeRow({ id: "req-1", status: "approved" }))
    await load(api)
    expect(getById("req-1")).toBeUndefined()
  })

  it("retains a row absent from the poll if it is still marked pending (in-flight decide race)", async () => {
    const getMock = vi
      .fn()
      .mockResolvedValueOnce([makeRow({ id: "req-2" })])
      .mockResolvedValueOnce([])
    const api = makeFakeApi(getMock)
    await load(api)
    expect(pendingRequests().map((r) => r.id)).toEqual(["req-2"])
    await load(api)
    // Row never transitioned away from "pending" locally — do not silently drop it.
    expect(getById("req-2")).toBeDefined()
  })
})

describe("scope-requests-store — visibility-gated polling", () => {
  afterEach(() => {
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    })
  })

  it("skips the 60s tick while the document is hidden", () => {
    vi.useFakeTimers()
    const getMock = vi.fn().mockResolvedValue([])
    const api = makeFakeApi(getMock)
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    })
    scopeRequestsStore.start(api)
    getMock.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(getMock).not.toHaveBeenCalled()
  })

  it("fires the 60s tick while the document is visible", () => {
    vi.useFakeTimers()
    const getMock = vi.fn().mockResolvedValue([])
    const api = makeFakeApi(getMock)
    scopeRequestsStore.start(api)
    getMock.mockClear()
    vi.advanceTimersByTime(60_000)
    expect(getMock).toHaveBeenCalledTimes(1)
  })

  it("reloads immediately on visibilitychange to visible", () => {
    const getMock = vi.fn().mockResolvedValue([])
    const api = makeFakeApi(getMock)
    scopeRequestsStore.start(api)
    getMock.mockClear()
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    })
    document.dispatchEvent(new Event("visibilitychange"))
    expect(getMock).toHaveBeenCalledTimes(1)
  })
})
