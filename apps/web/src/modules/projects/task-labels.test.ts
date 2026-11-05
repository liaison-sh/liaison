// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  effectiveLabels,
  LABEL_NONE,
  type LabelNode,
  labelsQueryParam,
  matchesLabelFilter,
  sanitizeLabelFilter,
  type TaskLabel,
} from "~/modules/projects/task-labels"

const NATURE = "g-nature"
const DOMAIN = "g-domain"

function own(groupId: string, valueId: string, valueName = valueId): TaskLabel {
  return {
    groupId,
    groupName: groupId === NATURE ? "Nature" : "Domain",
    groupArchived: false,
    valueId,
    valueName,
    archived: false,
    inherited: false,
    inheritedFromKey: null,
  }
}

function inheritedEntry(groupId: string, valueId: string, fromKey: string): TaskLabel {
  return { ...own(groupId, valueId), inherited: true, inheritedFromKey: fromKey }
}

function node(
  id: string,
  parentTaskId: string | null,
  labels: TaskLabel[] | undefined,
  key?: string,
): LabelNode {
  return { id, parentTaskId, labels, key: key ?? id.toUpperCase() }
}

function mapOf(...nodes: LabelNode[]): Map<string, LabelNode> {
  return new Map(nodes.map((n) => [n.id, n]))
}

describe("effectiveLabels", () => {
  it("own entry wins over the parent's", () => {
    const p = node("p", null, [own(NATURE, "bug")])
    const c = node("c", "p", [own(NATURE, "evolution")])
    const out = effectiveLabels(c, mapOf(p, c))
    expect(out).toEqual([own(NATURE, "evolution")])
  })

  it("inherits from a loaded parent, carrying the parent's key", () => {
    const p = node("p", null, [own(NATURE, "bug")], "PRJ-12")
    const c = node("c", "p", [])
    expect(effectiveLabels(c, mapOf(p, c))).toEqual([inheritedEntry(NATURE, "bug", "PRJ-12")])
  })

  it("the nearest ancestor wins over a farther one", () => {
    const g = node("g", null, [own(NATURE, "bug")], "PRJ-1")
    const p = node("p", "g", [own(NATURE, "evolution")], "PRJ-2")
    const c = node("c", "p", [])
    expect(effectiveLabels(c, mapOf(g, p, c))).toEqual([
      inheritedEntry(NATURE, "evolution", "PRJ-2"),
    ])
  })

  it("follows the parent loaded in byId, ignoring the child's stale server entry", () => {
    const p = node("p", null, [own(NATURE, "maintenance")], "PRJ-2")
    const c = node("c", "p", [inheritedEntry(NATURE, "evolution", "PRJ-2")])
    expect(effectiveLabels(c, mapOf(p, c))).toEqual([
      inheritedEntry(NATURE, "maintenance", "PRJ-2"),
    ])
    // The parent cleared its value: the child shows nothing, not the stale entry.
    const cleared = node("p", null, [], "PRJ-2")
    expect(effectiveLabels(c, mapOf(cleared, c))).toEqual([])
  })

  it("an unloaded ancestor falls back to the server's inherited entries", () => {
    const c = node("c", "missing", [
      own(DOMAIN, "security"),
      inheritedEntry(NATURE, "bug", "PRJ-9"),
    ])
    expect(effectiveLabels(c, mapOf(c))).toEqual([
      own(DOMAIN, "security"),
      inheritedEntry(NATURE, "bug", "PRJ-9"),
    ])
  })

  it("an unloaded ancestor above a loaded parent takes the parent's server entries, not the child's", () => {
    // G is not loaded. The server once gave C "Nature = bug, inherited from P";
    // P has since cleared its own value, so its event says "evolution from G".
    const p = node("p", "g-missing", [inheritedEntry(NATURE, "evolution", "PRJ-G")], "PRJ-P")
    const c = node("c", "p", [inheritedEntry(NATURE, "bug", "PRJ-P")], "PRJ-C")
    expect(effectiveLabels(c, mapOf(p, c))).toEqual([inheritedEntry(NATURE, "evolution", "PRJ-G")])
  })

  it("walks at most 7 ancestors, the server's bound", () => {
    // An 8-level chain: t1 (root, value) <- t2 <- ... <- t8 (leaf).
    const chain = (levels: number) => {
      const nodes: LabelNode[] = []
      for (let i = 1; i <= levels; i++) {
        nodes.push(
          node(
            `t${i}`,
            i === 1 ? null : `t${i - 1}`,
            i === 1 ? [own(NATURE, "bug")] : [],
            `K-${i}`,
          ),
        )
      }
      return nodes
    }
    const eight = chain(8)
    expect(effectiveLabels(eight[7] as LabelNode, mapOf(...eight))).toEqual([
      inheritedEntry(NATURE, "bug", "K-1"),
    ])
    const nine = chain(9)
    expect(effectiveLabels(nine[8] as LabelNode, mapOf(...nine))).toEqual([])
  })

  it("orders entries by the catalog's group order, then group name", () => {
    const c = node("c", null, [own(NATURE, "bug"), own(DOMAIN, "security")])
    expect(effectiveLabels(c, mapOf(c), [DOMAIN, NATURE]).map((l) => l.groupId)).toEqual([
      DOMAIN,
      NATURE,
    ])
    expect(effectiveLabels(c, mapOf(c), [NATURE, DOMAIN]).map((l) => l.groupId)).toEqual([
      NATURE,
      DOMAIN,
    ])
    // Without an order: by group name (Domain before Nature).
    expect(effectiveLabels(c, mapOf(c)).map((l) => l.groupId)).toEqual([DOMAIN, NATURE])
  })

  it("treats a non-array labels field as empty", () => {
    const c = { id: "c", parentTaskId: null, labels: "junk" } as unknown as LabelNode
    expect(effectiveLabels(c, mapOf(c))).toEqual([])
  })
})

describe("matchesLabelFilter", () => {
  const p = node("p", null, [own(NATURE, "bug"), own(DOMAIN, "security")])
  const c = node("c", "p", [own(DOMAIN, "enrichment")])
  const bare = node("b", null, [])
  const byId = mapOf(p, c, bare)

  it("an empty filter matches everything", () => {
    expect(matchesLabelFilter(bare, byId, {})).toBe(true)
  })

  it("combines groups with AND", () => {
    expect(matchesLabelFilter(p, byId, { [NATURE]: "bug", [DOMAIN]: "security" })).toBe(true)
    expect(matchesLabelFilter(p, byId, { [NATURE]: "bug", [DOMAIN]: "enrichment" })).toBe(false)
  })

  it("matches an inherited value", () => {
    expect(matchesLabelFilter(c, byId, { [NATURE]: "bug", [DOMAIN]: "enrichment" })).toBe(true)
  })

  it("__none__ selects tasks with no effective value in that group", () => {
    expect(matchesLabelFilter(bare, byId, { [NATURE]: LABEL_NONE })).toBe(true)
    expect(matchesLabelFilter(c, byId, { [NATURE]: LABEL_NONE })).toBe(false)
  })
})

describe("sanitizeLabelFilter", () => {
  const groups = [
    {
      id: NATURE,
      values: [{ id: "bug" }, { id: "old", archived: true }],
    },
    { id: DOMAIN, archivedAt: "2026-10-01T00:00:00Z", values: [{ id: "security" }] },
  ]

  it("drops an unknown group or an unknown value, keeps archived ones and __none__", () => {
    expect(
      sanitizeLabelFilter(
        {
          [NATURE]: "old",
          [DOMAIN]: "security",
          "g-gone": "bug",
        },
        groups,
      ),
    ).toEqual({ [NATURE]: "old", [DOMAIN]: "security" })
    expect(sanitizeLabelFilter({ [NATURE]: "nope", [DOMAIN]: LABEL_NONE }, groups)).toEqual({
      [DOMAIN]: LABEL_NONE,
    })
  })
})

describe("labelsQueryParam", () => {
  it("encodes the map as JSON and returns null when empty", () => {
    const filter = { [NATURE]: "bug", [DOMAIN]: LABEL_NONE }
    expect(labelsQueryParam(filter)).toBe(`labels=${encodeURIComponent(JSON.stringify(filter))}`)
    expect(labelsQueryParam({})).toBeNull()
  })
})
