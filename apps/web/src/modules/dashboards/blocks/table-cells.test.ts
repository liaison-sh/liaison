// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"
import {
  editableTableOf,
  type TableChange,
  type TableColumn,
  tableErrorFrom,
} from "../dashboards-client"
import {
  addFormColumns,
  cellText,
  changeSummary,
  choicesFrom,
  columnKeyFrom,
  isStale,
  parseCellInput,
  relativeTime,
  shownColumns,
} from "./table-cells"

const t = (key: string, p?: Record<string, string | number>) =>
  p ? `${key}(${Object.values(p).join("|")})` : key
const o = { locale: "en", t, personName: (id: string) => (id === "u1" ? "Nico" : undefined) }

const COLS: TableColumn[] = [
  { key: "batch", label: "Batch", type: "text", required: true },
  { key: "units", label: "Units", type: "number", required: true },
  { key: "price", label: "Price", type: "amount", currency: "EUR" },
  { key: "eta", label: "ETA", type: "date" },
  { key: "status", label: "Status", type: "choice", choices: ["Planned", "Arrived"] },
  { key: "tags", label: "Tags", type: "choices", choices: ["a", "b"] },
  { key: "ok", label: "OK", type: "checkbox" },
  { key: "owner", label: "Owner", type: "person" },
  { key: "product", label: "Product", type: "link" },
]
const col = (k: string) => COLS.find((c) => c.key === k) as TableColumn

describe("cellText", () => {
  it("reads each type", () => {
    expect(cellText(col("batch"), "B4", o)).toBe("B4")
    expect(cellText(col("units"), 1200, o)).toBe("1,200")
    expect(cellText(col("price"), 12.5, o)).toContain("12.50")
    expect(cellText(col("eta"), "2026-11-18", o)).toBe("Nov 18, 2026")
    expect(cellText(col("tags"), ["a", "b"], o)).toBe("a, b")
    expect(cellText(col("ok"), true, o)).toBe("kernel.dashboards.tables.yes")
    expect(cellText(col("owner"), "u1", o)).toBe("Nico")
    expect(cellText(col("owner"), "u2", o)).toBe("kernel.dashboards.tables.unknownPerson")
    expect(
      cellText(col("product"), { app: "shop", entityType: "product", id: "p1", label: "Stand" }, o),
    ).toBe("Stand")
    expect(cellText(col("status"), null, o)).toBe("")
  })

  it("names an unreadable link 'Linked record'", () => {
    expect(
      cellText(col("product"), { app: "shop", entityType: "product", id: "p1", label: "" }, o),
    ).toBe("kernel.dashboards.tables.linkedRecord")
    expect(cellText(col("product"), { app: "shop", entityType: "product", id: "p1" }, o)).toBe(
      "kernel.dashboards.tables.linkedRecord",
    )
  })
})

describe("parseCellInput", () => {
  it("turns inputs into cell values", () => {
    expect(parseCellInput(col("units"), "1 200")).toEqual({ ok: true, value: 1200 })
    expect(parseCellInput(col("price"), "12,5")).toEqual({ ok: true, value: 12.5 })
    expect(parseCellInput(col("units"), "many")).toEqual({ ok: false, reason: "number" })
    expect(parseCellInput(col("batch"), "  ")).toEqual({ ok: false, reason: "required" })
    expect(parseCellInput(col("eta"), "")).toEqual({ ok: true, value: null })
    expect(parseCellInput(col("ok"), true)).toEqual({ ok: true, value: true })
    expect(parseCellInput(col("tags"), ["a"])).toEqual({ ok: true, value: ["a"] })
    expect(parseCellInput(col("product"), null)).toEqual({ ok: true, value: null })
  })
})

describe("columns", () => {
  it("puts required columns first in the add form", () => {
    const cols = [col("eta"), col("batch"), col("status"), col("units")]
    expect(addFormColumns(cols).map((c) => c.key)).toEqual(["batch", "units", "eta", "status"])
  })

  it("shows the map's columns in its order, skipping unknown keys", () => {
    expect(shownColumns(COLS, ["status", "nope", "batch"]).map((c) => c.key)).toEqual([
      "status",
      "batch",
    ])
    expect(shownColumns(COLS).length).toBe(COLS.length)
  })

  it("makes a key from a label that avoids reserved, used and dropped keys", () => {
    expect(columnKeyFrom("Date d'arrivée", [])).toBe("date_d_arrivee")
    expect(columnKeyFrom("ID", [])).toBe("id_2")
    expect(columnKeyFrom("Updated at", [])).toBe("updated_at_2")
    expect(columnKeyFrom("Status", ["status"])).toBe("status_2")
    expect(columnKeyFrom("123", [])).toBe("column")
  })

  it("cleans a choices list", () => {
    expect(choicesFrom(" Air, Sea ,, Air,Train ")).toEqual(["Air", "Sea", "Train"])
  })
})

describe("changeSummary", () => {
  const base = {
    id: "c1",
    rowId: "r1",
    actor: { type: "user" as const, id: "u1", label: "Nico" },
    at: "",
    undoable: true,
  }
  it("says what an update changed", () => {
    const c: TableChange = {
      ...base,
      op: "update",
      before: { status: "Planned", units: 180 },
      after: { status: "Arrived", units: 200 },
    }
    expect(changeSummary(c, COLS, o)).toBe("Status: Planned → Arrived · Units: 180 → 200")
  })
  it("says a row was added or deleted, and reads a dropped column by its key", () => {
    expect(
      changeSummary(
        { ...base, op: "create", before: null, after: { batch: "B4", units: 5 } },
        COLS,
        o,
      ),
    ).toBe("kernel.dashboards.tables.changeAdded(B4, 5)")
    expect(
      changeSummary({ ...base, op: "delete", before: { batch: "B4" }, after: null }, COLS, o),
    ).toBe("kernel.dashboards.tables.changeDeleted")
    expect(
      changeSummary(
        { ...base, op: "update", before: { gone: "x" }, after: { gone: null } },
        COLS,
        o,
      ),
    ).toBe("gone: x → kernel.dashboards.tables.emptyCell")
  })
})

describe("times", () => {
  const now = Date.parse("2026-11-12T12:00:00Z")
  it("says when, relative", () => {
    expect(relativeTime("2026-11-12T11:59:30Z", now, "en", t)).toBe(
      "kernel.dashboards.tables.justNow",
    )
    expect(relativeTime("2026-11-12T11:56:00Z", now, "en", t)).toBe("4 min. ago")
  })
  it("marks a row not changed for the block's days", () => {
    expect(isStale("2026-11-01T12:00:00Z", now, 7)).toBe(true)
    expect(isStale("2026-11-10T12:00:00Z", now, 7)).toBe(false)
    expect(isStale("2026-01-01T12:00:00Z", now, undefined)).toBe(false)
  })
})

describe("client helpers", () => {
  it("knows an editable table block", () => {
    expect(
      editableTableOf({
        type: "table",
        source: { kind: "table", table: "t1" },
        map: { editable: true, columns: ["a", "b"] as never, staleAfterDays: 14 },
      }),
    ).toEqual({ tableId: "t1", columns: ["a", "b"], staleAfterDays: 14 })
    expect(
      editableTableOf({ type: "table", source: { kind: "table", table: "t1" }, map: {} }),
    ).toBeNull()
    expect(
      editableTableOf({
        type: "bar",
        source: { kind: "table", table: "t1" },
        map: { editable: true },
      }),
    ).toBeNull()
  })

  it("reads a refusal's code, column and current row from its details", () => {
    const current = {
      id: "r1",
      cells: {},
      version: 3,
      updatedAt: "",
      updatedBy: { type: "user", id: "u", label: "Nico" },
    }
    const e = tableErrorFrom(new ApiError("stale", 409, "version_conflict", undefined, { current }))
    expect(e.code).toBe("version_conflict")
    expect(e.current?.version).toBe(3)
    expect(
      tableErrorFrom(new ApiError("bad", 422, "invalid_cell", undefined, { column: "units" })),
    ).toMatchObject({
      code: "invalid_cell",
      column: "units",
    })
    expect(tableErrorFrom(new ApiError("x", 404)).code).toBe("not_found")
    // A taken table name is a 409 too, but not a stale row: its own code.
    expect(tableErrorFrom(new ApiError("exists", 409, "conflict")).code).toBe("conflict")
    expect(tableErrorFrom(new ApiError("bad", 400, "invalid_request")).code).toBe("invalid_request")
  })
})
