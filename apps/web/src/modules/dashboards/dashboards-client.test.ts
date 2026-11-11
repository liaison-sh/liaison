// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  blockErrorFrom,
  type DashboardsApi,
  DashboardsClientTestAccess,
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

describe("permanent block refusals", () => {
  it("a gone source and a map that no longer fits keep their own kind", () => {
    expect(parseBlockResponse({ error: "unknown_tool", message: "x" })).toMatchObject({
      ok: false,
      error: "unknown_tool",
    })
    expect(parseBlockResponse({ error: "invalid_map" })).toMatchObject({ error: "invalid_map" })
    expect(parseBlockResponse({ error: "source_failed" })).toMatchObject({ error: "source_error" })
  })
})

describe("block read slots", () => {
  it("a finishing read hands its slot to the next waiter: never more than four at once", async () => {
    const { withSlot, inFlight } = DashboardsClientTestAccess
    let peak = 0
    const releases: Array<() => void> = []
    const job = () =>
      withSlot(
        () =>
          new Promise<void>((resolve) => {
            peak = Math.max(peak, inFlight())
            releases.push(resolve)
          }),
      )
    const first = [job(), job(), job(), job(), job()]
    await Promise.resolve()
    expect(releases.length).toBe(4)
    releases.shift()?.()
    // A newcomer arriving while the slot is being handed over waits its turn.
    const late = job()
    await new Promise((r) => setTimeout(r, 0))
    expect(inFlight()).toBe(4)
    while (releases.length) {
      releases.shift()?.()
      await new Promise((r) => setTimeout(r, 0))
    }
    await Promise.all([...first, late])
    expect(peak).toBeLessThanOrEqual(4)
    expect(inFlight()).toBe(0)
  })

  it("a read whose view closed while it waited never runs", async () => {
    const { withSlot } = DashboardsClientTestAccess
    const releases: Array<() => void> = []
    const hold = () => withSlot(() => new Promise<void>((resolve) => releases.push(resolve)))
    const held = [hold(), hold(), hold(), hold()]
    const gone = new AbortController()
    let ran = false
    const waiting = withSlot(async () => {
      ran = true
    }, gone.signal)
    gone.abort()
    for (const r of releases) r()
    await Promise.all(held)
    expect(await waiting).toBeNull()
    expect(ran).toBe(false)
  })
})

describe("the time range on the wire", () => {
  it("sends the range the viewer looks at, custom days included", async () => {
    const { blockDataQuery } = await import("./dashboards-client")
    expect(blockDataQuery()).toBe("")
    expect(blockDataQuery({ refresh: true })).toBe("?refresh=1")
    expect(blockDataQuery({ range: { timeRange: { preset: "mtd" }, compare: "lastYear" } })).toBe(
      "?range=mtd&compare=lastYear",
    )
    expect(
      blockDataQuery({
        refresh: true,
        range: {
          timeRange: { preset: "custom", from: "2026-11-01", to: "2026-11-11" },
          compare: "none",
        },
      }),
    ).toBe("?refresh=1&range=custom&from=2026-11-01&to=2026-11-11&compare=none")
  })

  it("reads a metric's comparison, target and sparkline, and the read's context", async () => {
    const { parseBlockResponse } = await import("./dashboards-client")
    const r = parseBlockResponse({
      kind: "metric",
      value: 12,
      previous: 10,
      target: 40,
      sparkline: { labels: ["2026-11-01"], values: [3] },
      meta: { truncated: false, skippedRows: 2, sourceRows: 9 },
      computedAt: "2026-11-11T10:00:00.000Z",
      window: { mode: "dashboard", preset: "mtd", from: "2026-11-01", to: "2026-11-11" },
      compareWindow: { mode: "lastYear", from: "2025-11-01", to: "2025-11-11" },
      previousError: { error: "source_error", message: "boom" },
    })
    expect(r).toEqual({
      ok: true,
      data: {
        kind: "metric",
        value: 12,
        previous: 10,
        target: 40,
        sparkline: { labels: ["2026-11-01"], values: [3] },
      },
      info: {
        computedAt: "2026-11-11T10:00:00.000Z",
        window: { mode: "dashboard", preset: "mtd", from: "2026-11-01", to: "2026-11-11" },
        compareWindow: { mode: "lastYear", from: "2025-11-01", to: "2025-11-11" },
        skippedRows: 2,
        previousError: { error: "source_error", message: "boom" },
      },
    })
  })

  it("reads a chart's previous series and a refusal's window", async () => {
    const { parseBlockResponse } = await import("./dashboards-client")
    const chart = parseBlockResponse({
      kind: "bar",
      labels: ["a"],
      series: [{ name: "s", values: [1] }],
      previous: { labels: ["a"], series: [{ name: "s", values: [null] }] },
      meta: {},
    })
    expect(chart.ok && chart.data.kind === "bar" && chart.data.previous).toEqual({
      labels: ["a"],
      series: [{ name: "s", values: [null] }],
    })
    const refused = parseBlockResponse({
      blockId: "b",
      error: "no_access",
      message: "no",
      window: { mode: "fixed", dates: [{ token: "{{today}}", date: "2026-11-11" }] },
      compareWindow: null,
    })
    expect(refused).toMatchObject({
      ok: false,
      error: "no_access",
      info: {
        window: { mode: "fixed", dates: [{ token: "{{today}}", date: "2026-11-11" }] },
        compareWindow: null,
      },
    })
  })
})
