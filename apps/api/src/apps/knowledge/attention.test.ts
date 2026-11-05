// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  aggregateFloods,
  FLOOD_AGGREGATE_THRESHOLD,
  type KnowledgeAttentionItem,
} from "~/apps/knowledge/attention"

function docItem(n: number, reason = "owner_missing"): KnowledgeAttentionItem {
  return {
    key: `knowledge:document:doc-${reason}-${n}:${reason}`,
    kind: "knowledge_review",
    app: "knowledge",
    entityType: "document",
    entityId: `doc-${reason}-${n}`,
    title: `doc-${n}.md`,
    reason,
  }
}

describe("aggregateFloods", () => {
  it("keeps buckets at or below the threshold as individual items", () => {
    const items = Array.from({ length: FLOOD_AGGREGATE_THRESHOLD }, (_, i) => docItem(i))
    expect(aggregateFloods(items)).toEqual(items)
  })

  it("collapses a bucket above the threshold into one counted item", () => {
    const count = FLOOD_AGGREGATE_THRESHOLD + 1
    const out = aggregateFloods(Array.from({ length: count }, (_, i) => docItem(i)))
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      key: "knowledge:document:aggregate:owner_missing",
      entityType: "document",
      entityId: "",
      title: `${count} documents`,
      reason: "owner_missing",
      aggregateCount: count,
    })
  })

  it("aggregates per (entityType, reason) bucket independently", () => {
    const flood = Array.from({ length: 10 }, (_, i) => docItem(i))
    const small = [docItem(0, "expired"), docItem(1, "expired")]
    const out = aggregateFloods([...flood, ...small])
    expect(out.filter((i) => i.aggregateCount != null)).toHaveLength(1)
    expect(out.filter((i) => i.reason === "expired")).toEqual(small)
  })
})
