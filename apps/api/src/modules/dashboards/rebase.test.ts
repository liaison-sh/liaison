// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An edit written against an older version applies on top of the current one only when no
// version saved in between changed what it names; a revert never does.

import { describe, expect, it } from "bun:test"
import type { EditOperation } from "~/modules/dashboards/edit"
import { type RebaseVersion, rebaseConflict, versionChanges } from "~/modules/dashboards/rebase"

const block = (id: string, title = `Tile ${id}`) => ({ id, type: "metric", title })

const v = (
  version: number,
  blocks: Record<string, unknown>[],
  extra: Partial<RebaseVersion> & { specExtra?: Record<string, unknown> } = {},
): RebaseVersion => ({
  version,
  title: extra.title ?? "Board",
  visibility: extra.visibility ?? "org",
  spec: { v: 1, blocks, ...(extra.specExtra ?? {}) },
  savedByName: extra.savedByName ?? null,
})

describe("versionChanges", () => {
  it("names each changed block, dataset, filter and dashboard field, not a moved block", () => {
    const a = v(1, [block("a"), block("b")], {
      specExtra: { datasets: { d: { kind: "tool", tool: "x" } }, filters: [{ id: "f" }] },
    })
    const moved = v(2, [block("b"), block("a")], {
      specExtra: { datasets: { d: { kind: "tool", tool: "x" } }, filters: [{ id: "f" }] },
    })
    expect([...versionChanges(a, moved)]).toEqual(["dash:order"])
    const changed = v(3, [block("a", "Renamed"), block("c")], {
      title: "New",
      specExtra: { datasets: { d: { kind: "tool", tool: "y" } }, timeRange: { preset: "today" } },
    })
    expect([...versionChanges(a, changed)].sort()).toEqual(
      [
        "block:a",
        "block:b",
        "block:c",
        "dash:filterOrder",
        "dash:order",
        "dash:range",
        "dash:title",
        "dataset:d",
        "filter:f",
      ].sort(),
    )
  })
})

describe("rebaseConflict", () => {
  const base = v(1, [block("a"), block("b")])
  const firstApplied = v(2, [block("a", "Sales"), block("b")], { savedByName: "Ada" })

  it("disjoint changes apply on top", () => {
    const ops: EditOperation[] = [
      { op: "updateBlock", blockId: "b", changes: { title: "Orders" } },
      { op: "addBlock", block: block("c") },
      { op: "setDescription", description: "Daily" },
    ]
    expect(rebaseConflict(ops, [base, firstApplied])).toBeNull()
  })

  it("an operation on a block a newer version changed is refused, naming both", () => {
    const ops: EditOperation[] = [
      { op: "setTitle", title: "x" },
      { op: "resizeBlock", blockId: "a", width: 2 },
    ]
    const conflict = rebaseConflict(ops, [base, firstApplied])
    expect(conflict).toMatchObject({ index: 1, what: "the block 'a'", version: 2 })
    expect(conflict?.message).toContain(
      "operation 2 (resizeBlock 'a') changes the block 'a', which version 2 (saved by Ada) also changed after version 1",
    )
    expect(conflict?.message).toContain("The dashboard is now at version 2")
  })

  it("a block placed by index conflicts with a newer reorder; one placed next to a block does not", () => {
    const reordered = v(2, [block("b"), block("a")])
    expect(
      rebaseConflict([{ op: "addBlock", block: block("c"), position: 0 }], [base, reordered]),
    ).toMatchObject({ what: expect.stringContaining("order of the blocks") })
    expect(
      rebaseConflict(
        [{ op: "addBlock", block: block("c"), position: { after: "a" } }],
        [base, reordered],
      ),
    ).toBeNull()
  })

  it("a block reading a dataset a newer version changed is refused", () => {
    const b1 = v(1, [block("a")], { specExtra: { datasets: { d: { kind: "tool", tool: "x" } } } })
    const b2 = v(2, [block("a")], { specExtra: { datasets: { d: { kind: "tool", tool: "y" } } } })
    expect(
      rebaseConflict([{ op: "addBlock", block: { ...block("n"), dataset: "d" } }], [b1, b2]),
    ).toMatchObject({ what: "the dataset 'd'" })
  })

  it("a revert never applies on top of a newer version", () => {
    const conflict = rebaseConflict([{ op: "revert", toVersion: 1 }], [base, firstApplied])
    expect(conflict?.message).toContain("applies only to the version it was written against (1)")
  })

  it("a version missing in between is a conflict", () => {
    const conflict = rebaseConflict(
      [{ op: "setTitle", title: "x" }],
      [base, v(3, [block("a"), block("b")])],
    )
    expect(conflict?.message).toContain("version 2 is no longer kept")
  })
})
