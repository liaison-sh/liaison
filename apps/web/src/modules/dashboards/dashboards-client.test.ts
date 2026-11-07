// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  blockErrorFrom,
  type DashboardsApi,
  getBlockData,
  getDashboard,
  listDashboards,
  parseBlockResponse,
} from "./dashboards-client"

function fakeApi(get: (path: string, init?: any) => Promise<unknown>): DashboardsApi {
  return { get: get as DashboardsApi["get"] }
}

describe("parseBlockResponse", () => {
  it("reads a metric, with its format from meta", () => {
    expect(
      parseBlockResponse({
        kind: "metric",
        value: 12.5,
        meta: { format: "currency", currency: "EUR" },
      }),
    ).toEqual({
      ok: true,
      data: { kind: "metric", value: 12.5, format: "currency", currency: "EUR" },
    })
  })

  it("reads a metric with no value as null", () => {
    expect(parseBlockResponse({ kind: "metric", value: null })).toEqual({
      ok: true,
      data: { kind: "metric", value: null },
    })
  })

  it("reads a table and its truncation", () => {
    const r = parseBlockResponse({
      kind: "table",
      columns: [{ field: "n", label: "N" }],
      rows: [{ n: 1 }],
      meta: { truncated: true },
    })
    expect(r).toEqual({
      ok: true,
      data: {
        kind: "table",
        columns: [{ field: "n", label: "N" }],
        rows: [{ n: 1 }],
        truncated: true,
      },
    })
  })

  it("reads bar and line from the server's labels + series, and from x", () => {
    const series = [{ name: "total", values: [1, 2] }]
    expect(parseBlockResponse({ kind: "bar", labels: ["a", "b"], series })).toEqual({
      ok: true,
      data: { kind: "bar", x: ["a", "b"], series },
    })
    expect(parseBlockResponse({ kind: "line", x: ["2026-11-01"], series })).toMatchObject({
      ok: true,
      data: { kind: "line", x: ["2026-11-01"] },
    })
  })

  it("reads a pie from its first series or flat values", () => {
    expect(
      parseBlockResponse({ kind: "pie", labels: ["a"], series: [{ name: "v", values: [3] }] }),
    ).toEqual({ ok: true, data: { kind: "pie", labels: ["a"], values: [3] } })
    expect(parseBlockResponse({ kind: "pie", labels: ["a"], values: [4] })).toEqual({
      ok: true,
      data: { kind: "pie", labels: ["a"], values: [4] },
    })
  })

  it.each(["no_access", "not_allowed", "rate_limited", "source_error"])(
    "passes the server's %s refusal through",
    (error) => {
      expect(parseBlockResponse({ error, message: "m" })).toEqual({
        ok: false,
        error,
        message: "m",
        retryAfter: undefined,
      })
    },
  )

  it("reads an unknown refusal or shape as a source error", () => {
    expect(parseBlockResponse({ error: "weird" })).toMatchObject({
      ok: false,
      error: "source_error",
    })
    expect(parseBlockResponse({ kind: "gauge" })).toEqual({ ok: false, error: "source_error" })
    expect(parseBlockResponse({ kind: "bar", labels: "nope" })).toEqual({
      ok: false,
      error: "source_error",
    })
    expect(parseBlockResponse({ kind: "metric", value: { a: 1 } })).toEqual({
      ok: false,
      error: "source_error",
    })
    expect(parseBlockResponse(null)).toEqual({ ok: false, error: "source_error" })
  })
})

describe("blockErrorFrom", () => {
  it("maps a coded refusal to its kind", () => {
    expect(blockErrorFrom(new ApiError("x", 403, "not_allowed"))).toMatchObject({
      error: "not_allowed",
    })
    expect(blockErrorFrom(new ApiError("x", 400, "no_access"))).toMatchObject({
      error: "no_access",
    })
  })

  it("maps statuses", () => {
    expect(blockErrorFrom(new ApiError("x", 429, undefined, 12))).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfter: 12,
    })
    expect(blockErrorFrom(new ApiError("x", 403))).toMatchObject({ error: "no_access" })
    expect(blockErrorFrom(new ApiError("x", 404))).toMatchObject({ error: "not_found" })
    expect(blockErrorFrom(new ApiError("x", 0, "timeout"))).toMatchObject({ error: "network" })
    expect(blockErrorFrom(new ApiError("boom", 500))).toMatchObject({
      error: "source_error",
      message: "boom",
    })
    expect(blockErrorFrom(new TypeError("fetch failed"))).toMatchObject({ error: "network" })
    expect(blockErrorFrom("??")).toEqual({ ok: false, error: "source_error" })
  })
})

describe("getBlockData", () => {
  it("reads the block's path quietly, refresh bypasses the cache", async () => {
    const get = vi.fn(async (_path: string, _init?: unknown) => ({ kind: "metric", value: 1 }))
    await getBlockData(fakeApi(get), "d 1", "b1")
    await getBlockData(fakeApi(get), "d 1", "b1", { refresh: true })
    expect(get.mock.calls[0]).toEqual([
      "/dashboards/d%201/blocks/b1/data",
      { signal: undefined, suppressGlobalError: true, userInitiated: false },
    ])
    expect(get.mock.calls[1]?.[0]).toBe("/dashboards/d%201/blocks/b1/data?refresh=1")
    expect((get.mock.calls[1] as any[])[1].userInitiated).toBe(true)
  })

  it("never rejects: a thrown read is the block's state", async () => {
    const r = await getBlockData(
      fakeApi(async () => {
        throw new ApiError("slow down", 429)
      }),
      "d",
      "b",
    )
    expect(r).toMatchObject({ ok: false, error: "rate_limited" })
  })

  it("keeps at most four reads in flight", async () => {
    let live = 0
    let peak = 0
    const release: Array<() => void> = []
    const get = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          live++
          peak = Math.max(peak, live)
          release.push(() => {
            live--
            resolve({ kind: "metric", value: 1 })
          })
        }),
    )
    const all = Promise.all(
      Array.from({ length: 7 }, (_, i) => getBlockData(fakeApi(get), "d", `b${i}`)),
    )
    for (let i = 0; i < 20 && (release.length > 0 || get.mock.calls.length < 7); i++) {
      await Promise.resolve()
      await new Promise((r) => setTimeout(r, 0))
      release.shift()?.()
    }
    while (release.length) release.shift()?.()
    await all
    expect(get).toHaveBeenCalledTimes(7)
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe("dashboards", () => {
  it("lists from an array or {items}, dropping malformed rows", async () => {
    const row = { id: "a", title: "A", visibility: "personal", ownerUserId: "u" }
    expect(await listDashboards(fakeApi(async () => [row, { id: 3 }]))).toEqual([row])
    expect(await listDashboards(fakeApi(async () => ({ items: [row] })))).toEqual([row])
  })

  it("reads one dashboard and defaults missing blocks", async () => {
    const d = await getDashboard(
      fakeApi(async () => ({
        id: "a",
        title: "A",
        visibility: "org",
        spec: { v: 1, layout: "grid" },
      })),
      "a",
    )
    expect(d.spec.blocks).toEqual([])
  })

  it("rejects a body without a spec as not found", async () => {
    await expect(
      getDashboard(
        fakeApi(async () => ({ id: "a" })),
        "a",
      ),
    ).rejects.toMatchObject({
      status: 404,
    })
  })
})
