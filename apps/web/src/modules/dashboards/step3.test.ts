// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step 3, the plain logic: where a moved or dropped block lands, how a version reads against
// the one before, the export links (range and filters carried), the edit and history calls,
// bucket labels (quarter, month, year) and timestamps read in the org's time zone.
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { bucketLabel, formatAxisLabel, formatValue, quarterLabel } from "./blocks/format"
import { blockReadKey, fileSlug } from "./DashboardView"
import {
  blockCsvPath,
  type DashboardsApi,
  type DashboardsEditApi,
  dashboardPdfPath,
  downloadExport,
  downloadName,
  duplicateDashboard,
  editDashboard,
  getFilterOptions,
  isVersionConflict,
  listVersions,
  parseBlockResponse,
} from "./dashboards-client"
import { dropTarget, gridColumns, moveTarget, versionChanges } from "./edit-mode"

const blocks = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }]

describe("moveTarget", () => {
  it("left and right move one place; never past either end", () => {
    expect(moveTarget(blocks, "b", "left", 3)).toBe(0)
    expect(moveTarget(blocks, "b", "right", 3)).toBe(2)
    expect(moveTarget(blocks, "a", "left", 3)).toBeNull()
    expect(moveTarget(blocks, "e", "right", 3)).toBeNull()
  })
  it("up and down move one row of the grid as drawn", () => {
    expect(moveTarget(blocks, "e", "up", 3)).toBe(1)
    expect(moveTarget(blocks, "a", "down", 3)).toBe(3)
    expect(moveTarget(blocks, "c", "down", 3)).toBeNull()
    expect(moveTarget(blocks, "b", "up", 3)).toBeNull()
    // One column (a phone): up and down are one place.
    expect(moveTarget(blocks, "c", "up", 1)).toBe(1)
    expect(moveTarget(blocks, "zz", "up", 1)).toBeNull()
  })
})

describe("dropTarget", () => {
  it("a block dropped on another takes its place", () => {
    expect(dropTarget(blocks, "a", "d")).toBe(3)
    expect(dropTarget(blocks, "e", "b")).toBe(1)
    expect(dropTarget(blocks, "a", "a")).toBeNull()
    expect(dropTarget(blocks, "a", "zz")).toBeNull()
  })
})

describe("gridColumns", () => {
  it("counts the tracks the grid draws, one without a grid", () => {
    const el = document.createElement("div")
    el.style.gridTemplateColumns = "100px 100px 100px"
    document.body.appendChild(el)
    expect(gridColumns(el)).toBe(3)
    el.remove()
    expect(gridColumns(undefined)).toBe(1)
  })
})

describe("versionChanges", () => {
  const v = (version: number, title: string, blockCount: number) => ({
    version,
    title,
    blockCount,
    savedAt: "2026-11-12T10:00:00Z",
    savedBy: null,
    savedByName: null,
    current: false,
  })
  it("reads each version against the one before it", () => {
    expect(
      versionChanges([v(5, "B", 3), v(4, "A", 3), v(3, "A", 4), v(2, "A", 2), v(1, "A", 2)]),
    ).toEqual([
      { kind: "renamed", title: "B" },
      { kind: "removed", count: 1 },
      { kind: "added", count: 2 },
      { kind: "changed" },
      { kind: "first", blocks: 2 },
    ])
  })
})

describe("exports", () => {
  const range = {
    timeRange: { preset: "custom" as const, from: "2026-10-01", to: "2026-10-31" },
    compare: "lastYear" as const,
  }
  it("the PDF and CSV links carry the range and the filters shown", () => {
    expect(dashboardPdfPath("d1", { range, filters: { market: ["FR"], channel: [] } })).toBe(
      "/dashboards/d1/export.pdf?range=custom&from=2026-10-01&to=2026-10-31&compare=lastYear&f.channel=&f.market=FR",
    )
    expect(blockCsvPath("d1", "by market", "data", {})).toBe(
      "/dashboards/d1/blocks/by%20market/data.csv",
    )
    expect(blockCsvPath("d1", "b", "rows", { filters: { m: ["x", "y"] } })).toBe(
      "/dashboards/d1/blocks/b/rows.csv?f.m=x&f.m=y",
    )
  })
  it("names the file from the answer, else the fallback", () => {
    expect(downloadName('attachment; filename="sales.pdf"', "x.pdf")).toBe("sales.pdf")
    expect(downloadName(null, "x.pdf")).toBe("x.pdf")
  })
  it("downloads the answer's bytes", async () => {
    const blob = new Blob(["a,b"], { type: "text/csv" })
    const rawGet = vi.fn(
      async () =>
        new Response(blob, {
          headers: { "Content-Disposition": 'attachment; filename="orders.csv"' },
        }),
    )
    const save = vi.fn()
    await downloadExport({ rawGet }, "/dashboards/d1/blocks/b/data.csv", "b.csv", save)
    expect(rawGet).toHaveBeenCalledWith("/dashboards/d1/blocks/b/data.csv", {
      suppressGlobalError: true,
    })
    expect(save.mock.calls[0]?.[1]).toBe("orders.csv")
  })
  it("a file name from a title", () => {
    expect(fileSlug("Ventes été 2026!")).toBe("ventes-ete-2026")
    expect(fileSlug("***")).toBe("dashboard")
  })
})

describe("edit, duplicate, history calls", () => {
  const record = {
    id: "d1",
    title: "T",
    visibility: "personal",
    version: 4,
    spec: { v: 1, layout: "grid", blocks: [] },
  }
  it("sends the operations with the version shown", async () => {
    const post = vi.fn(async (_path: string, ..._rest: unknown[]) => record)
    const d = await editDashboard({ post } as unknown as DashboardsEditApi, "d1", 3, [
      { op: "resizeBlock", blockId: "a", height: 2 },
    ])
    expect(post).toHaveBeenCalledWith(
      "/dashboards/d1/edit",
      { ifVersion: 3, operations: [{ op: "resizeBlock", blockId: "a", height: 2 }] },
      { suppressGlobalError: true },
    )
    expect(d.version).toBe(4)
  })
  it("tells a stale version from another refusal", () => {
    expect(isVersionConflict(new ApiError("stale", 409, "VERSION_CONFLICT"))).toBe(true)
    expect(isVersionConflict(new ApiError("bad", 422, "INVALID_SPEC"))).toBe(false)
  })
  it("duplicates and lists versions", async () => {
    const post = vi.fn(async (_path: string, ..._rest: unknown[]) => ({ ...record, id: "d2" }))
    expect((await duplicateDashboard({ post } as unknown as DashboardsEditApi, "d1")).id).toBe("d2")
    expect(post).toHaveBeenCalledWith("/dashboards/d1/duplicate", {}, { suppressGlobalError: true })
    const get = vi.fn(async (_path: string, ..._rest: unknown[]) => ({
      versions: [{ version: 2, title: "T", blockCount: 1 }, { bad: 1 }],
    }))
    expect(
      (await listVersions({ get } as unknown as DashboardsApi, "d1")).map((v) => v.version),
    ).toEqual([2])
  })
  it("a filter's options are searched with q", async () => {
    const get = vi.fn(async (_path: string, ..._rest: unknown[]) => ({
      options: ["FR"],
      truncated: true,
    }))
    const r = await getFilterOptions({ get } as unknown as DashboardsApi, "d1", "market", {
      q: " fr ",
    })
    expect(get.mock.calls[0]?.[0]).toBe("/dashboards/d1/filters/market/options?q=fr")
    expect(r).toEqual({ ok: true, options: ["FR"], truncated: true })
  })
})

describe("grid keys", () => {
  it("a move, a resize or a rename keeps a block mounted; a new map remounts it", () => {
    const b = { id: "a", type: "bar" as const, title: "A", width: 1 as const, map: { x: "d" } }
    expect(blockReadKey({ ...b, title: "B", width: 2, height: 2 })).toBe(blockReadKey(b))
    expect(blockReadKey({ ...b, map: { x: "e" } })).not.toBe(blockReadKey(b))
  })
})

describe("bucket labels and time zones", () => {
  it("quarters read Q4 2026 in English, T4 2026 in French; months and years too", () => {
    expect(quarterLabel("2026", "4", "en-GB")).toBe("Q4 2026")
    expect(bucketLabel("2026-Q4", "fr")).toBe("T4 2026")
    expect(formatAxisLabel("2026-Q1", "en")).toBe("Q1 2026")
    expect(formatAxisLabel("2026-11", "en")).toBe("Nov 2026")
    expect(formatAxisLabel("2026", "en")).toBe("2026")
    expect(formatValue("2026-Q3", { format: "date", locale: "fr" })).toBe("T3 2026")
    expect(bucketLabel("2026-13", "en")).toBeNull()
  })
  it("a timestamp reads as the org zone's day; a bare day stays as written", () => {
    // 23:30 UTC on Nov 7 is already Nov 8 in Paris.
    expect(formatAxisLabel("2026-11-07T23:30:00Z", "en", "Europe/Paris")).toBe("Nov 8")
    expect(formatAxisLabel("2026-11-07T23:30:00Z", "en", "America/New_York")).toBe("Nov 7")
    expect(formatAxisLabel("2026-11-07", "en", "Pacific/Kiritimati")).toBe("Nov 7")
    expect(
      formatValue("2026-11-07T23:30:00Z", {
        format: "date",
        locale: "en",
        timeZone: "Europe/Paris",
      }),
    ).toBe("Nov 8, 2026")
    // An unknown zone falls back to the browser's, never throws.
    expect(() => formatAxisLabel("2026-11-07T10:00:00Z", "en", "Mars/Olympus")).not.toThrow()
  })
})

describe("a metric read from one object", () => {
  it("carries sourceRows 0 (no rows to drill into)", () => {
    const r = parseBlockResponse({ kind: "metric", value: 3, meta: { sourceRows: 0 } })
    expect(r.ok && r.info?.sourceRows).toBe(0)
  })
})
