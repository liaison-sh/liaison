// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure rules of dashboard tables: a cell by its column's type (each refusal names the column),
// the column definitions, and the fail-closed delivery of a table frame over the socket.

import { describe, expect, it } from "bun:test"
import { hasDashboardTableAudience } from "~/infra/websocket"
import {
  CellError,
  type Column,
  changedKeys,
  columnsSchema,
  validateCells,
} from "~/modules/dashboards/tables/columns"
import { applyColumnOps } from "~/modules/dashboards/tables/service"

const MEMBER = "11111111-1111-4111-8111-111111111111"
const COLS: Column[] = [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "qty", label: "Qty", type: "number" },
  { key: "price", label: "Price", type: "amount", currency: "EUR" },
  { key: "eta", label: "ETA", type: "date" },
  { key: "status", label: "Status", type: "choice", choices: ["open", "done"] },
  { key: "tags", label: "Tags", type: "choices", choices: ["a", "b"] },
  { key: "ok", label: "OK", type: "checkbox" },
  { key: "who", label: "Who", type: "person" },
  { key: "ref", label: "Ref", type: "link", linkTo: { app: "shopify", entityType: "order" } },
]
const members = new Set([MEMBER])

function refusal(cells: Record<string, unknown>, full = false): string | null {
  try {
    validateCells(COLS, cells, { full, members })
    return null
  } catch (err) {
    if (err instanceof CellError) return err.column
    throw err
  }
}

describe("cells", () => {
  it("accepts a value of each type and normalizes it", () => {
    expect(
      validateCells(
        COLS,
        {
          name: "A",
          qty: 2,
          price: 9.5,
          eta: "2026-12-01",
          status: "open",
          tags: ["a", "a", "b"],
          ok: true,
          who: MEMBER.toUpperCase(),
          ref: { app: "shopify", entityType: "order", id: "1", label: " #1001 " },
        },
        { full: true, members },
      ),
    ).toEqual({
      name: "A",
      qty: 2,
      price: 9.5,
      eta: "2026-12-01",
      status: "open",
      tags: ["a", "b"],
      ok: true,
      who: MEMBER,
      ref: { app: "shopify", entityType: "order", id: "1", label: "#1001" },
    })
  })

  it("refuses each wrong value naming its column", () => {
    expect(refusal({ nope: 1 })).toBe("nope")
    expect(refusal({ qty: "2" })).toBe("qty")
    expect(refusal({ price: Number.NaN })).toBe("price")
    expect(refusal({ eta: "01/12/2026" })).toBe("eta")
    expect(refusal({ status: "lost" })).toBe("status")
    expect(refusal({ tags: ["c"] })).toBe("tags")
    expect(refusal({ ok: "yes" })).toBe("ok")
    expect(refusal({ who: "22222222-2222-4222-8222-222222222222" })).toBe("who")
    expect(refusal({ ref: { app: "boxtal", entityType: "shipment", id: "1", label: "x" } })).toBe(
      "ref",
    )
    expect(refusal({ ref: { app: "shopify", entityType: "order", id: "1" } })).toBe("ref")
    expect(refusal({ qty: 1 }, true)).toBe("name")
    expect(refusal({ name: null })).toBe("name")
  })

  it("lists the keys a change touched", () => {
    expect(changedKeys({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual(["b", "c"])
  })
})

describe("columns", () => {
  it("refuses a reserved or repeated key, a choice column without choices, an amount without currency", () => {
    const bad = (cols: unknown) => columnsSchema.safeParse(cols).success
    expect(bad([{ key: "id", label: "Id", type: "text" }])).toBe(false)
    expect(bad([{ key: "updated_at", label: "U", type: "text" }])).toBe(false)
    expect(
      bad([
        { key: "a", label: "A", type: "text" },
        { key: "a", label: "B", type: "text" },
      ]),
    ).toBe(false)
    expect(bad([{ key: "s", label: "S", type: "choice" }])).toBe(false)
    expect(bad([{ key: "p", label: "P", type: "amount" }])).toBe(false)
    expect(bad([{ key: "Bad", label: "B", type: "text" }])).toBe(false)
    expect(bad(COLS)).toBe(true)
  })

  it("retires a dropped key", () => {
    const { columns, dropped } = applyColumnOps(COLS, [], { drop: ["qty"] })
    expect(columns.map((c) => c.key)).not.toContain("qty")
    expect(() =>
      applyColumnOps(columns, dropped, { add: [{ key: "qty", label: "Qty", type: "number" }] }),
    ).toThrow("dropped column")
  })
})

describe("socket delivery of a table frame", () => {
  it("reaches the audience only, and no one without one", () => {
    expect(hasDashboardTableAudience("u1", { audience: { orgWide: true, userIds: [] } })).toBe(true)
    expect(hasDashboardTableAudience("u1", { audience: { orgWide: false, userIds: ["u1"] } })).toBe(
      true,
    )
    expect(hasDashboardTableAudience("u2", { audience: { orgWide: false, userIds: ["u1"] } })).toBe(
      false,
    )
    expect(hasDashboardTableAudience("u1", { tableId: "t" })).toBe(false)
  })
})
