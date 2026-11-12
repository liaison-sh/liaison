// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A provider's answer as the feed stores it (normalizeProviderItems). A long
// queue is an answer, not a failure: the feed shows the most urgent items and
// never tells the reader the app did not answer because it had a lot to say.
import { describe, expect, it } from "bun:test"
import type { AttentionItem } from "@liaison/shared"
import { normalizeProviderItems, PROVIDER_ITEM_CAP } from "~/modules/apps/attention-store"

function item(entityId: string, kind: AttentionItem["kind"], urgency: number): AttentionItem {
  return {
    id: `${kind}:${entityId}`,
    app: "desk",
    entity: "ticket",
    entityId,
    kind,
    summary: `ticket ${entityId}`,
    urgency,
    occurredAt: "2026-11-01T09:00:00.000Z",
    action: { type: "open_entity", tabType: "desk:ticket", entityId },
  }
}

describe("a provider's answer as stored", () => {
  it("a queue longer than the cap is stored without an error, most urgent first", () => {
    const raw = Array.from({ length: PROVIDER_ITEM_CAP + 30 }, (_, n) =>
      item(`t${n}`, "awaiting_agent", n % 100),
    )
    const { items, error } = normalizeProviderItems(raw)
    expect(error).toBeNull()
    expect(items).toHaveLength(PROVIDER_ITEM_CAP)
    expect(items[0]?.urgency).toBe(99)
  })

  it("several rules about one record count once, so the cap holds distinct records", () => {
    // 150 records, each raised by two rules: 300 items, 150 things to do.
    const raw = Array.from({ length: 150 }, (_, n) => [
      item(`t${n}`, "awaiting_agent", 60),
      item(`t${n}`, "unassigned", 40),
    ]).flat()
    const { items, error } = normalizeProviderItems(raw)
    expect(error).toBeNull()
    expect(new Set(items.map((i) => i.entityId)).size).toBe(150)
    expect(items).toHaveLength(150)
    expect(items[0]?.kind).toBe("awaiting_agent")
    expect(items[0]?.alsoKinds).toEqual(["unassigned"])
  })

  it("a malformed item is still reported", () => {
    const raw = [item("t1", "awaiting_agent", 50), { id: "broken" }]
    const { items, error } = normalizeProviderItems(raw)
    expect(items).toHaveLength(1)
    expect(error?.message).toContain("malformed")
  })
})
