// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Step-3 edit operations: resize (width, height), duplicate a block, the description, and a
// revert to a saved version; each one plain line on the approval card.

import { describe, expect, it } from "bun:test"
import {
  applyOperations,
  describeOperations,
  diffDashboards,
  type EditableDashboard,
  EditOperationError,
  editOperationSchema,
  revertTargets,
  type SavedVersion,
} from "~/modules/dashboards/edit"
import { type DashboardSpec, dashboardSpecSchema } from "~/modules/dashboards/spec"

const block = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "metric",
  title: `Block ${id}`,
  width: 1,
  source: { kind: "tool", tool: "shop:orders_search", params: { status: "open" } },
  map: { agg: "count" },
  ...extra,
})

const dashboard = (): EditableDashboard => ({
  title: "Sales",
  visibility: "org",
  spec: { v: 1, layout: "grid", blocks: [block("a"), block("b")] } as unknown as DashboardSpec,
})

const ctx = { timeZone: "Europe/Paris", now: new Date("2026-11-11T10:00:00Z") }
const blocksOf = (spec: Record<string, unknown>) => spec.blocks as Record<string, unknown>[]

describe("resizeBlock, duplicateBlock, setDescription", () => {
  it("resizes width and height; height 1 is the default and is not stored", () => {
    const out = applyOperations(dashboard(), [
      { op: "resizeBlock", blockId: "a", width: 3, height: 2 },
      { op: "resizeBlock", blockId: "b", height: 1 },
    ])
    expect(blocksOf(out.spec)[0]).toMatchObject({ width: 3, height: 2 })
    expect("height" in blocksOf(out.spec)[1]!).toBe(false)
    expect(dashboardSpecSchema.safeParse(out.spec).success).toBe(true)
  })

  it("refuses a resize that names nothing to change", () => {
    expect(editOperationSchema.safeParse({ op: "resizeBlock", blockId: "a" }).success).toBe(false)
  })

  it("duplicates a block right after the original with a free id and a (copy) title", () => {
    const out = applyOperations(dashboard(), [
      { op: "duplicateBlock", blockId: "a" },
      { op: "duplicateBlock", blockId: "a" },
    ])
    const blocks = blocksOf(out.spec)
    expect(blocks.map((b) => b.id)).toEqual(["a", "a-copy-2", "a-copy", "b"])
    expect(blocks[2]!.title).toBe("Block a (copy)")
    expect(blocks[2]!.source).toEqual(blocks[0]!.source)
    expect(blocks[2]!.source).not.toBe(blocks[0]!.source)
    expect(dashboardSpecSchema.safeParse(out.spec).success).toBe(true)
  })

  it("refuses a duplicate onto an id already taken", () => {
    expect(() =>
      applyOperations(dashboard(), [{ op: "duplicateBlock", blockId: "a", newId: "b" }]),
    ).toThrow(EditOperationError)
  })

  it("sets and removes the description", () => {
    const set = applyOperations(dashboard(), [{ op: "setDescription", description: "Weekly" }])
    expect(set.spec.description).toBe("Weekly")
    const removed = applyOperations(
      { ...dashboard(), spec: set.spec as unknown as DashboardSpec },
      [{ op: "setDescription", description: null }],
    )
    expect("description" in removed.spec).toBe(false)
  })

  it("describes each in one plain line", () => {
    const lines = describeOperations(
      dashboard(),
      [
        { op: "resizeBlock", blockId: "a", width: 2, height: 2 },
        { op: "duplicateBlock", blockId: "b", title: "Open orders again" },
        { op: "setDescription", description: "What sales does every Monday" },
        { op: "resizeBlock", blockId: "zz", width: 2 },
      ],
      ctx,
    )
    expect(lines[0]).toBe('1. Resize the block "Block a": width 1 → 2, height 1 → 2.')
    expect(lines[1]).toContain('2. Duplicate the metric block "Block b" as "Open orders again"')
    expect(lines[1]).toContain("(id b-copy) at position 3 of 3 (last)")
    expect(lines[1]).toContain("shop:orders_search")
    expect(lines[2]).toBe('3. Add the description "What sales does every Monday".')
    expect(lines[3]).toContain("this edit will be refused")
  })

  it("a whole-spec save lists a description change", () => {
    const ops = diffDashboards(dashboard(), {
      spec: { ...(dashboard().spec as object), description: "New" },
    })
    expect(ops).toEqual([{ op: "setDescription", description: "New" }])
  })
})

describe("revert", () => {
  const v3: SavedVersion = {
    version: 3,
    title: "Sales (old)",
    spec: { v: 1, layout: "grid", blocks: [block("a"), block("old")] },
    savedAt: "2026-11-09T08:00:00.000Z",
    savedByName: "Ana",
  }
  const versions = new Map([[3, v3]])

  it("brings back the version's title and spec, keeps the visibility", () => {
    const out = applyOperations(dashboard(), [{ op: "revert", toVersion: 3 }], versions)
    expect(out.title).toBe("Sales (old)")
    expect(out.visibility).toBe("org")
    expect(blocksOf(out.spec).map((b) => b.id)).toEqual(["a", "old"])
  })

  it("refuses a version that is not kept", () => {
    expect(() => applyOperations(dashboard(), [{ op: "revert", toVersion: 9 }])).toThrow(
      /no saved version 9/,
    )
  })

  it("names the targets and describes what the revert changes", () => {
    expect(
      revertTargets([
        { op: "revert", toVersion: 3 },
        { op: "setTitle", title: "x" },
      ]),
    ).toEqual([3])
    const [line] = describeOperations(dashboard(), [{ op: "revert", toVersion: 3 }], {
      ...ctx,
      versions,
    })
    expect(line).toContain("1. Revert to version 3 (saved 2026-11-09 by Ana)")
    expect(line).toContain('removes "Block b"')
    expect(line).toContain('adds back "Block old"')
    expect(line).toContain('the title becomes "Sales (old)"')
    const [missing] = describeOperations(dashboard(), [{ op: "revert", toVersion: 9 }], ctx)
    expect(missing).toContain("not kept any more")
  })
})

describe("calculated values on the card", () => {
  it("says what a computed metric and a computed measure read", () => {
    const [metric, chart] = describeOperations(
      dashboard(),
      [
        {
          op: "addBlock",
          block: block("roas", {
            map: {
              values: { revenue: { field: "total" }, spend: { field: "cost", dataset: "ads" } },
              expr: "revenue / spend",
              scale: 1,
            },
          }),
        },
        {
          op: "addBlock",
          block: block("trend", {
            type: "line",
            map: {
              groupBy: { field: "day", bucket: "quarter" },
              measures: [
                { label: "Revenue", name: "revenue", field: "total" },
                { label: "ROAS", expr: "revenue / spend" },
              ],
              percentOfTotal: true,
            },
          }),
        },
      ],
      ctx,
    )
    expect(metric).toContain(
      "the computed value revenue / spend (revenue = sum of total, spend = sum of cost from the shared dataset 'ads')",
    )
    expect(metric).toContain("every value multiplied by 1")
    expect(chart).toContain("ROAS (computed: revenue / spend)")
    expect(chart).toContain("per quarter")
    expect(chart).toContain("each value as a percentage of its total")
  })
})
