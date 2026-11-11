// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Editing a dashboard by operations: applied in order, all or none, and described one
// plain line per operation for the approval card.

import { describe, expect, it } from "bun:test"
import {
  applyOperations,
  describeOperations,
  type EditableDashboard,
  EditOperationError,
} from "~/modules/dashboards/edit"
import type { DashboardSpec } from "~/modules/dashboards/spec"

const block = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "metric",
  title: `Block ${id}`,
  width: 1,
  source: {
    kind: "tool",
    tool: "shop:orders_search",
    params: { status: "open", since: "{{today-90d}}" },
  },
  map: { agg: "count" },
  ...extra,
})

const dashboard = (): EditableDashboard => ({
  title: "Sales",
  visibility: "org",
  spec: {
    v: 1,
    layout: "grid",
    blocks: [block("a"), block("b"), block("c")],
  } as unknown as DashboardSpec,
})

const ids = (spec: Record<string, unknown>) => (spec.blocks as { id: string }[]).map((b) => b.id)

describe("applyOperations", () => {
  it("adds, moves and removes blocks by index or next to another block", () => {
    const out = applyOperations(dashboard(), [
      { op: "addBlock", block: block("d"), position: { after: "a" } },
      { op: "moveBlock", blockId: "c", position: 0 },
      { op: "removeBlock", blockId: "b" },
      { op: "addBlock", block: block("e") },
      { op: "moveBlock", blockId: "a", position: { before: "e" } },
    ])
    expect(ids(out.spec)).toEqual(["c", "d", "a", "e"])
  })

  it("merges an update key by key, a null removing a key, and keeps the id", () => {
    const out = applyOperations(dashboard(), [
      {
        op: "updateBlock",
        blockId: "a",
        changes: {
          id: "zz",
          title: "Open orders",
          source: { params: { since: "{{range.from}}", until: "{{range.to}}", status: null } },
          map: { target: 40 },
        },
      },
    ])
    const a = (out.spec.blocks as Record<string, unknown>[])[0]!
    expect(a.id).toBe("a")
    expect(a.title).toBe("Open orders")
    expect(a.source).toEqual({
      kind: "tool",
      tool: "shop:orders_search",
      params: { since: "{{range.from}}", until: "{{range.to}}" },
    })
    expect(a.map).toEqual({ agg: "count", target: 40 })
  })

  it("sets the title, the default range and the visibility", () => {
    const out = applyOperations(dashboard(), [
      { op: "setTitle", title: "Direction" },
      { op: "setTimeRange", timeRange: { preset: "lastMonth" }, compare: "previousPeriod" },
      { op: "setVisibility", visibility: "personal" },
    ])
    expect(out.title).toBe("Direction")
    expect(out.visibility).toBe("personal")
    expect(out.spec.timeRange).toEqual({ preset: "lastMonth" })
    expect(out.spec.compare).toBe("previousPeriod")
    const cleared = applyOperations(
      { ...dashboard(), spec: out.spec as unknown as DashboardSpec },
      [{ op: "setTimeRange", timeRange: null }],
    )
    expect(cleared.spec.timeRange).toBeUndefined()
    expect(cleared.spec.compare).toBe("previousPeriod")
  })

  it("refuses the whole list at the first operation that cannot apply", () => {
    const current = dashboard()
    expect(() =>
      applyOperations(current, [
        { op: "removeBlock", blockId: "a" },
        { op: "updateBlock", blockId: "nope", changes: { title: "x" } },
      ]),
    ).toThrow(new EditOperationError(1, "no block 'nope'"))
    expect(() => applyOperations(current, [{ op: "addBlock", block: block("b") }])).toThrow(
      "operations.0: a block 'b' is already on the dashboard",
    )
    // Nothing was changed in place.
    expect(ids(current.spec as unknown as Record<string, unknown>)).toEqual(["a", "b", "c"])
  })
})

describe("describeOperations", () => {
  const ctx = { timeZone: "UTC", now: new Date("2026-11-10T12:00:00Z") }

  it("writes one numbered, plain line per operation, as they apply in order", () => {
    const lines = describeOperations(
      dashboard(),
      [
        {
          op: "addBlock",
          block: block("spend", {
            type: "bar",
            title: "Spend by campaign",
            width: 2,
            source: {
              kind: "tool",
              tool: "ads:insights_query",
              params: { since: "{{range.from}}", until: "{{range.to}}" },
            },
          }),
          position: { after: "a" },
        },
        { op: "updateBlock", blockId: "b", changes: { title: "Open B2B orders" } },
        { op: "removeBlock", blockId: "c" },
        { op: "moveBlock", blockId: "a", position: { after: "b" } },
        { op: "setTitle", title: "Direction" },
        { op: "setTimeRange", timeRange: { preset: "lastMonth" }, compare: "previousPeriod" },
      ],
      ctx,
    )
    expect(lines).toHaveLength(6)
    expect(lines[0]).toStartWith(
      '1. Add a bar block "Spend by campaign" (width 2) at position 2 of 4 (after "Block a"), reading ads:insights_query with {"since":"{{range.from}}","until":"{{range.to}}"}',
    )
    expect(lines[0]).toContain(
      "{{range.from}} = the dashboard range's start (2026-10-12 by default today)",
    )
    expect(lines[1]).toBe('2. Change the block "Block b": title "Block b" → "Open B2B orders".')
    expect(lines[2]).toContain('3. Remove the metric block "Block c" (it read shop:orders_search')
    expect(lines[2]).toContain("{{today-90d}} = 2026-08-12 today")
    expect(lines[3]).toBe('4. Move the block "Block a" from position 1 to position 3 of 3 (last).')
    expect(lines[4]).toBe('5. Rename the dashboard "Sales" → "Direction".')
    expect(lines[5]).toBe(
      "6. Default time range: the dashboard opens on last month (today 2026-10-01 to 2026-10-31) instead of the last 30 days (today 2026-10-12 to 2026-11-10), and compares with the previous period instead of the same period last year (each person's own choice stays theirs).",
    )
  })

  it("says plainly when an operation names a block that is not there", () => {
    const [line] = describeOperations(dashboard(), [{ op: "removeBlock", blockId: "x" }], ctx)
    expect(line).toBe("1. Remove the block 'x' (not on the dashboard: this edit will be refused).")
  })
})

describe("datasets and filters by operation", () => {
  const src = { kind: "tool", tool: "shop:orders_search", params: { market: "{{filter.market}}" } }
  const filter = { id: "market", label: "Market", type: "select", options: ["FR", "DE"] }

  it("sets, replaces and removes a dataset and a filter", () => {
    const out = applyOperations(dashboard(), [
      { op: "setDataset", id: "orders", source: src },
      { op: "setFilter", filter },
      { op: "setFilter", filter: { id: "channel", label: "Channel", type: "text" }, position: 0 },
      { op: "setFilter", filter: { ...filter, label: "Pays" } },
      {
        op: "addBlock",
        block: { id: "d", type: "metric", title: "D", dataset: "orders", map: { agg: "count" } },
      },
    ])
    expect(out.spec.datasets).toEqual({ orders: src })
    expect(
      (out.spec.filters as { id: string; label: string }[]).map((f) => `${f.id}:${f.label}`),
    ).toEqual(["channel:Channel", "market:Pays"])
    const back = applyOperations({ ...dashboard(), spec: out.spec as unknown as DashboardSpec }, [
      { op: "removeBlock", blockId: "d" },
      { op: "removeDataset", id: "orders" },
      { op: "removeFilter", id: "channel" },
      { op: "removeFilter", id: "market" },
    ])
    expect(back.spec.datasets).toBeUndefined()
    expect(back.spec.filters).toBeUndefined()
    expect(() => applyOperations(dashboard(), [{ op: "removeDataset", id: "x" }])).toThrow(
      EditOperationError,
    )
  })

  it("describes each in plain words: where a dataset reads and who uses it, a filter's options", () => {
    const lines = describeOperations(
      dashboard(),
      [
        { op: "setDataset", id: "orders", source: src },
        { op: "setFilter", filter: { ...filter, default: "FR" } },
        {
          op: "addBlock",
          block: {
            id: "d",
            type: "bar",
            title: "By channel",
            dataset: "orders",
            map: {
              x: "channel",
              agg: "count",
              where: [{ field: "status", op: "neq", value: "cancelled" }],
            },
          },
        },
        {
          op: "addBlock",
          block: { id: "n", type: "text", title: "Notes", text: "B2B = tagged b2b" },
        },
        {
          op: "updateBlock",
          blockId: "a",
          changes: { map: { where: [{ field: "market", op: "eq", value: { filter: "market" } }] } },
        },
        { op: "removeFilter", id: "market" },
      ],
      { timeZone: "UTC", now: new Date("2026-11-11T12:00:00Z") },
    )
    expect(lines[0]).toContain("Add the shared dataset 'orders': it reads shop:orders_search")
    expect(lines[0]).toContain("no block uses it yet")
    expect(lines[1]).toContain(
      'Add the filter "Market" (id market, one value, options FR, DE, default FR',
    )
    expect(lines[2]).toContain("reading the shared dataset 'orders'")
    expect(lines[2]).toContain("keeping only rows where status is not cancelled")
    expect(lines[3]).toContain('showing the note "B2B = tagged b2b"')
    expect(lines[4]).toContain(
      'keeps only rows where market is the "Market" filter\'s value (all rows while it is empty)',
    )
    expect(lines[5]).toBe('6. Remove the filter "Market".')
  })
})
