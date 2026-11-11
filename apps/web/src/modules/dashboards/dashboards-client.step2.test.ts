// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import {
  blockRowsQuery,
  type DashboardsApi,
  getBlockRows,
  getFilterOptions,
  isAppPath,
  parseBlockResponse,
  parseRowsResponse,
  recordLinkFrom,
} from "./dashboards-client"

describe("step 2 block shapes", () => {
  it("reads area, combo (with its display) and stacked bars", () => {
    const r = parseBlockResponse({
      kind: "combo",
      labels: ["Jan", "Feb"],
      series: [
        { name: "Orders", values: [1, 2] },
        { name: "Revenue", values: [10, 20] },
      ],
      display: { lineSeries: ["Revenue"], secondaryAxis: true, stacked: true },
      meta: {},
    })
    expect(r.ok && r.data.kind === "combo" && r.data.display).toEqual({
      lineSeries: ["Revenue"],
      secondaryAxis: true,
      stacked: true,
    })
    const a = parseBlockResponse({ kind: "area", labels: ["a"], series: [], meta: {} })
    expect(a.ok && a.data.kind).toBe("area")
  })

  it("reads a funnel as stages and their values", () => {
    const r = parseBlockResponse({
      kind: "funnel",
      labels: ["Visits", "Carts", "Orders"],
      series: [{ name: "value", values: [100, 40, 10] }],
      meta: { format: "number" },
    })
    expect(r).toMatchObject({
      ok: true,
      data: { kind: "funnel", labels: ["Visits", "Carts", "Orders"], values: [100, 40, 10] },
    })
  })

  it("reads a text block's markdown", () => {
    const r = parseBlockResponse({ kind: "text", markdown: "**B2B** = dealers", meta: {} })
    expect(r).toMatchObject({ ok: true, data: { kind: "text", markdown: "**B2B** = dealers" } })
  })

  it("reads a table's record links, dropping any that would leave the app", () => {
    const r = parseBlockResponse({
      kind: "table",
      columns: [{ field: "id", label: "Id" }],
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      links: [
        { kind: "path", href: "/shop/orders/1" },
        { kind: "entity", app: "tickets", entityType: "ticket", id: "t2" },
        { kind: "path", href: "//evil.example/x" },
        null,
      ],
      meta: {},
    })
    expect(r.ok && r.data.kind === "table" && r.data.links).toEqual([
      { kind: "path", href: "/shop/orders/1" },
      { kind: "entity", app: "tickets", entityType: "ticket", id: "t2" },
      null,
      null,
    ])
  })

  it("an app path never names another origin", () => {
    expect(isAppPath("/projects/p1")).toBe(true)
    expect(isAppPath("//evil.example")).toBe(false)
    expect(isAppPath("/\\evil.example")).toBe(false)
    expect(isAppPath("https://evil.example")).toBe(false)
    expect(isAppPath("/a b")).toBe(false)
    expect(recordLinkFrom({ kind: "path", href: "javascript:alert(1)" })).toBeNull()
  })
})

describe("drill-down rows", () => {
  it("asks for the figure, the page, the range without comparison, and the filters", () => {
    const q = blockRowsQuery({
      target: { category: "FR", series: "b2b" },
      offset: 50,
      range: {
        timeRange: { preset: "custom", from: "2026-01-01", to: "2026-01-31" },
        compare: "lastYear",
      },
      filters: { channel: ["b2b"] },
    })
    const p = new URLSearchParams(q.slice(1))
    expect(p.get("category")).toBe("FR")
    expect(p.get("series")).toBe("b2b")
    expect(p.get("offset")).toBe("50")
    expect(p.get("limit")).toBe("50")
    expect(p.get("range")).toBe("custom")
    expect(p.get("from")).toBe("2026-01-01")
    expect(p.has("compare")).toBe(false)
    expect(p.getAll("f.channel")).toEqual(["b2b"])
  })

  it("reads a page, and a refusal", () => {
    const ok = parseRowsResponse({
      columns: [{ field: "id", label: "Id" }],
      rows: [{ id: 1 }],
      links: [{ kind: "path", href: "/x/1" }],
      total: 120,
      offset: 0,
      limit: 50,
      nextOffset: 50,
      truncated: false,
    })
    expect(ok).toMatchObject({ ok: true, page: { total: 120, nextOffset: 50 } })
    expect(parseRowsResponse({ blockId: "b", error: "rate_limited", message: "m" })).toEqual({
      ok: false,
      error: "rate_limited",
      message: "m",
    })
  })

  it("never rejects", async () => {
    const api = { get: vi.fn(async () => Promise.reject(new TypeError("offline"))) }
    expect(await getBlockRows(api as unknown as DashboardsApi, "d", "b", {})).toEqual({
      ok: false,
      error: "network",
    })
  })
})

describe("filter options", () => {
  it("reads the options with the other filters' values", async () => {
    const get = vi.fn(async (_path: string) => ({
      filterId: "m",
      options: ["DE", "FR"],
      truncated: false,
    }))
    const api = { get } as unknown as DashboardsApi
    const r = await getFilterOptions(api, "d1", "m", { filters: { channel: ["b2b"] } })
    expect(r).toEqual({ ok: true, options: ["DE", "FR"], truncated: false })
    expect(get.mock.calls[0]![0]).toBe("/dashboards/d1/filters/m/options?f.channel=b2b")
  })
})
