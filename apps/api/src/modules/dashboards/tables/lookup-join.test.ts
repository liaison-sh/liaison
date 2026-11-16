// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Lookup columns, the pure half (tables/lookup.ts, columns.ts): the definition a save accepts,
// the refusal of a write naming one, and the join of a tool's rows to the table's rows.

import { describe, expect, it } from "bun:test"
import {
  CellError,
  type Column,
  columnsSchema,
  type LookupDef,
  validateCells,
} from "~/modules/dashboards/tables/columns"
import {
  joinKey,
  joinLookup,
  lookupIndex,
  lookupPairs,
  lookupValue,
} from "~/modules/dashboards/tables/lookup"

const STOCK: LookupDef = {
  source: { tool: "shop:products_search", params: { first: 50 }, rowsPath: "products" },
  match: { field: "id", on: "product" },
  value: "inventory.on_hand",
  valueType: "number",
}

const COLS: Column[] = [
  { key: "name", label: "Name", type: "text" },
  { key: "product", label: "Product", type: "link", linkTo: { app: "shop" } },
  { key: "code", label: "Code", type: "text" },
  { key: "stock", label: "Stock", type: "lookup", lookup: STOCK },
]

function problem(cols: unknown): string | null {
  const parsed = columnsSchema.safeParse(cols)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? "invalid")
}

describe("a lookup column's definition", () => {
  it("accepts a lookup naming its read, its match and its value", () => {
    expect(problem(COLS)).toBeNull()
  })

  it("refuses a lookup without its read, or a read on another type", () => {
    expect(problem([{ key: "s", label: "S", type: "lookup" }])).toContain("names its read")
    expect(problem([{ key: "s", label: "S", type: "number", lookup: STOCK }])).toContain(
      "only a lookup column",
    )
  })

  it("refuses a required lookup, a path that is not a path and a tool that is not <app>:<tool>", () => {
    expect(problem([{ ...COLS[3], required: true }])).toContain("cannot be required")
    expect(problem([{ ...COLS[3], lookup: { ...STOCK, value: "a..b" } }])).toContain("path")
    expect(
      problem([{ ...COLS[3], lookup: { ...STOCK, match: { field: "id; drop", on: "product" } } }]),
    ).toContain("path")
    expect(
      problem([{ ...COLS[3], lookup: { ...STOCK, source: { tool: "products_search" } } }]),
    ).toContain("<app>:<tool>")
    expect(
      problem([{ ...COLS[3], lookup: { ...STOCK, valueType: "date" } as unknown as LookupDef }]),
    ).not.toBeNull()
  })

  it("refuses a lookup matching on another lookup, and more than five lookups", () => {
    expect(
      problem([
        COLS[3],
        {
          key: "other",
          label: "Other",
          type: "lookup",
          lookup: { ...STOCK, match: { field: "id", on: "stock" } },
        },
      ]),
    ).toContain("not another lookup")
    const many = Array.from({ length: 6 }, (_, i) => ({ ...COLS[3], key: `l${i}` }))
    expect(problem([COLS[1], ...many])).toContain("at most 5 lookup")
  })
})

describe("a write naming a lookup column", () => {
  it("is refused with its reason, an empty value too", () => {
    for (const value of [12, null]) {
      try {
        validateCells(COLS, { stock: value }, { full: false, members: new Set() })
        throw new Error("not refused")
      } catch (err) {
        expect(err).toBeInstanceOf(CellError)
        expect((err as CellError).column).toBe("stock")
        expect((err as CellError).message).toContain("cannot be written")
      }
    }
  })
})

describe("the join", () => {
  const rows: { id: string; cells: Record<string, unknown> }[] = [
    {
      id: "r1",
      cells: {
        name: "Widget",
        product: { app: "shop", entityType: "product", id: "P-1", label: "Widget" },
        code: "w-1",
      },
    },
    {
      id: "r2",
      cells: {
        name: "Panel",
        product: { app: "shop", entityType: "product", id: "P-2", label: "Panel" },
        code: " W-2 ",
      },
    },
    { id: "r3", cells: { name: "No product" } },
  ]

  it("matches a link cell by its record id and leaves a row without a match empty", () => {
    const pairs = lookupPairs(STOCK, [
      { id: "P-1", inventory: { on_hand: "12" } },
      { id: "P-2", inventory: { on_hand: 3 } },
      { id: "P-9", inventory: { on_hand: 40 } },
      { inventory: { on_hand: 5 } },
    ])
    const out = joinLookup(COLS[3]!, lookupIndex(pairs, "number"), rows)
    expect(out.map((r) => r.cells.stock)).toEqual([12, 3, undefined])
    // The rows given are not changed in place.
    expect("stock" in rows[0]!.cells).toBe(false)
  })

  it("matches a text cell by its trimmed, case-insensitive text", () => {
    const col: Column = {
      key: "waiting",
      label: "Waiting",
      type: "lookup",
      lookup: { ...STOCK, match: { field: "code", on: "code" }, value: "units" },
    }
    const pairs = lookupPairs(col.lookup!, [
      { code: "W-1", units: 2 },
      { code: "w-2", units: 1 },
    ])
    const out = joinLookup(col, lookupIndex(pairs, "number"), rows)
    expect(out.map((r) => r.cells.waiting)).toEqual([2, 1, undefined])
  })

  it("adds up several number rows of one key, joins distinct texts, skips empty values", () => {
    const def: LookupDef = { ...STOCK, match: { field: "code", on: "code" }, value: "v" }
    const nums = lookupIndex(
      lookupPairs(def, [
        { code: "A", v: 2 },
        { code: "a", v: "3" },
        { code: "A", v: "n/a" },
      ]),
      "number",
    )
    expect(nums.get("a")).toBe(5)
    const text = lookupIndex(
      lookupPairs({ ...def, valueType: "text" }, [
        { code: "A", v: "Paris" },
        { code: "A", v: "Lyon" },
        { code: "A", v: "Paris" },
        { code: "A", v: null },
      ]),
      "text",
    )
    expect(text.get("a")).toBe("Paris, Lyon")
  })

  it("reads keys and values as the column shows them", () => {
    expect(joinKey({ id: 42 })).toBe("42")
    expect(joinKey("  ")).toBeNull()
    expect(joinKey(["a"])).toBeNull()
    expect(lookupValue("12.5", "number")).toBe(12.5)
    expect(lookupValue("twelve", "number")).toBeNull()
    expect(lookupValue(true, "text")).toBe("true")
    expect(lookupValue({ a: 1 }, "text")).toBeNull()
  })
})
