// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DashboardSpec, EditOperation } from "./dashboards-client"
import { FilterEditor } from "./FilterEditor"
import {
  addFilterOps,
  fieldsFrom,
  filterIdFrom,
  filterTargets,
  optionsFor,
  removeFilterOps,
  renameFilterOp,
} from "./filter-editor"

afterEach(() => cleanup())

const SOURCE = { kind: "tool", tool: "shop:orders_search", params: { from: "{{range.from}}" } }

const SPEC: DashboardSpec = {
  v: 1,
  layout: "grid",
  blocks: [
    { id: "intro", type: "text", title: "Notes", width: 1, text: "hi" },
    { id: "orders", type: "bar", title: "Orders", width: 2, source: SOURCE, map: { x: "day" } },
    {
      id: "total",
      type: "metric",
      title: "Total",
      width: 1,
      dataset: "sales",
      map: { agg: "sum" },
    },
    {
      id: "blend",
      type: "combo",
      title: "Units and visits",
      width: 3,
      layers: [
        {
          id: "units",
          as: "bar",
          source: SOURCE,
          map: { groupBy: { field: "day", bucket: "day" } },
        },
        {
          id: "visits",
          label: "Visits",
          as: "line",
          dataset: "visits",
          map: { groupBy: { field: "day", bucket: "day" } },
        },
      ],
    },
  ],
}

describe("filter operations", () => {
  it("makes an id from the label, unique", () => {
    expect(filterIdFrom("Sales channel", [])).toBe("sales_channel")
    expect(filterIdFrom("Marché", ["marche"])).toBe("marche_2")
    expect(filterIdFrom("2026 year", [])).toBe("year")
    expect(filterIdFrom("!!!", [])).toBe("filter")
  })

  it("lists every block and blended layer that reads rows", () => {
    expect(filterTargets(SPEC)).toEqual([
      { blockId: "orders" },
      { blockId: "total" },
      { blockId: "blend", layerId: "units" },
      { blockId: "blend", layerId: "visits" },
    ])
  })

  it("groups the fields the rows carry by field", () => {
    expect(
      fieldsFrom([
        { target: { blockId: "orders" }, fields: ["market", "day"] },
        { target: { blockId: "total" }, fields: ["market"] },
      ]),
    ).toEqual([
      { field: "day", targets: [{ blockId: "orders" }] },
      { field: "market", targets: [{ blockId: "orders" }, { blockId: "total" }] },
    ])
  })

  it("reads a select's values from a dataset or a source that reads no filter", () => {
    expect(optionsFor(SPEC, "market", [{ blockId: "total" }])).toEqual({
      fromDataset: "sales",
      field: "market",
    })
    expect(optionsFor(SPEC, "market", [{ blockId: "orders" }])).toEqual({
      fromSource: SOURCE,
      field: "market",
    })
    const reads = {
      ...SPEC,
      blocks: SPEC.blocks.map((b) =>
        b.id === "orders" ? { ...b, source: { ...SOURCE, params: { m: "{{filter.x}}" } } } : b,
      ),
    }
    expect(optionsFor(reads, "market", [{ blockId: "orders" }])).toBeNull()
  })

  it("adds the filter, then a row condition on each chosen block or layer", () => {
    const ops = addFilterOps(SPEC, {
      label: "Market",
      type: "multi",
      field: "market",
      targets: [{ blockId: "orders" }, { blockId: "blend", layerId: "visits" }],
    })
    expect(ops?.[0]).toEqual({
      op: "setFilter",
      filter: {
        id: "market",
        label: "Market",
        type: "multi",
        options: { fromSource: SOURCE, field: "market" },
      },
    })
    const clause = { field: "market", op: "eq", value: { filter: "market" } }
    expect(ops?.[1]).toEqual({
      op: "updateBlock",
      blockId: "orders",
      changes: { map: { where: [clause] } },
    })
    const blend = ops?.[2] as Extract<EditOperation, { op: "updateBlock" }>
    expect(blend.changes.layers?.[0]?.map.where).toBeUndefined()
    expect(blend.changes.layers?.[1]?.map.where).toEqual([clause])
  })

  it("a text filter matches what is typed, with no option list", () => {
    const ops = addFilterOps(SPEC, {
      label: "Search",
      type: "text",
      field: "name",
      targets: [{ blockId: "orders" }],
    })
    expect(ops?.[0]).toEqual({
      op: "setFilter",
      filter: { id: "search", label: "Search", type: "text" },
    })
    expect(ops?.[1]).toMatchObject({
      changes: { map: { where: [{ field: "name", op: "contains", value: { filter: "search" } }] } },
    })
  })

  it("removes the row conditions first, then the filter; renames in place", () => {
    const def = { id: "market", label: "Market", type: "select" as const, options: ["FR"] }
    const spec: DashboardSpec = {
      ...SPEC,
      filters: [def],
      blocks: SPEC.blocks.map((b) =>
        b.id === "orders"
          ? {
              ...b,
              map: {
                x: "day",
                where: [
                  { field: "market", op: "eq", value: { filter: "market" } },
                  { field: "kind", op: "eq", value: "sale" },
                ],
              },
            }
          : b,
      ),
    }
    expect(removeFilterOps(spec, "market")).toEqual([
      {
        op: "updateBlock",
        blockId: "orders",
        changes: { map: { where: [{ field: "kind", op: "eq", value: "sale" }] } },
      },
      { op: "removeFilter", id: "market" },
    ])
    expect(renameFilterOp(def, " Country ")).toEqual({
      op: "setFilter",
      filter: { ...def, label: "Country" },
    })
  })
})

describe("FilterEditor", () => {
  it("adds a filter a person makes: field, name, kind, blocks, saved as one change", async () => {
    const apply = vi.fn(async (_ops: EditOperation[]) => true)
    const loadFields = vi.fn(async (t: { blockId: string; layerId?: string }) =>
      t.blockId === "orders" ? ["day", "market"] : t.blockId === "total" ? ["market"] : [],
    )
    render(() => <FilterEditor spec={SPEC} apply={apply} loadFields={loadFields} />)
    fireEvent.click(screen.getByTestId("dashboard-filter-add"))
    const field = (await screen.findByTestId("dashboard-filter-new-field")) as HTMLSelectElement
    expect(loadFields).toHaveBeenCalledTimes(4)
    expect([...field.options].map((o) => o.value)).toEqual(["", "day", "market"])
    expect((screen.getByTestId("dashboard-filter-new-save") as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.change(field, { target: { value: "market" } })
    // The name starts as the field; every block carrying it is ticked.
    expect((screen.getByTestId("dashboard-filter-new-label") as HTMLInputElement).value).toBe(
      "market",
    )
    fireEvent.input(screen.getByTestId("dashboard-filter-new-label"), {
      target: { value: "Market" },
    })
    fireEvent.change(screen.getByTestId("dashboard-filter-new-type"), {
      target: { value: "select" },
    })
    const total = screen.getByTestId("dashboard-filter-new-target-total") as HTMLInputElement
    expect(total.checked).toBe(true)
    fireEvent.click(total)
    fireEvent.click(screen.getByTestId("dashboard-filter-new-save"))
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1))
    const ops = apply.mock.calls[0]![0]
    expect(ops.map((o) => o.op)).toEqual(["setFilter", "updateBlock"])
    expect(ops[1]).toMatchObject({ blockId: "orders" })
    await waitFor(() => expect(screen.queryByTestId("dashboard-filter-new")).toBeNull())
  })

  it("renames and removes a filter through the same edit", async () => {
    const apply = vi.fn(async (_ops: EditOperation[]) => true)
    const spec: DashboardSpec = {
      ...SPEC,
      filters: [{ id: "market", label: "Market", type: "text" }],
    }
    render(() => <FilterEditor spec={spec} apply={apply} loadFields={async () => []} />)
    const input = screen.getByTestId("dashboard-filter-rename-market") as HTMLInputElement
    fireEvent.input(input, { target: { value: "Country" } })
    input.value = "Country"
    fireEvent.blur(input)
    expect(apply).toHaveBeenCalledWith([
      { op: "setFilter", filter: { id: "market", label: "Country", type: "text" } },
    ])
    fireEvent.click(screen.getByTestId("dashboard-filter-remove-market"))
    expect(apply).toHaveBeenLastCalledWith([{ op: "removeFilter", id: "market" }])
  })

  it("says so when no block's fields can be read", async () => {
    render(() => (
      <FilterEditor spec={SPEC} apply={async () => true} loadFields={async () => null} />
    ))
    fireEvent.click(screen.getByTestId("dashboard-filter-add"))
    expect(await screen.findByTestId("dashboard-filter-new-nofields")).toBeTruthy()
  })
})
