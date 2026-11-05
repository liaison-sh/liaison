// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { computeKnowledgeAttentionItems } from "./attention"
import { applyReviewTransition, shouldResetVerification } from "./review"
import { normalizeKnowledgeTagName } from "./tags"

describe("Knowledge review lifecycle", () => {
  it("resets verified documents to needs_review for every spec-listed content field", () => {
    // Spec §123: editing a local document's title, body, summary, attachments,
    // owner, document scope, team, or sensitivity resets `verified` to
    // `needs_review` (unless the editor verifies in the same action).
    // Collection/tag changes preserve verification.
    const fields = [
      ["title", "new title"],
      ["body", "new body"],
      ["summary", "new summary"],
      ["attachments", ["att-1"]],
      ["ownerUserId", "user-2"],
      ["documentScope", "personal"],
      ["team", ["sales"]],
      ["sensitivity", "confidential"],
    ] as const
    for (const [field, value] of fields) {
      expect(
        shouldResetVerification({ reviewStatus: "verified" } as any, { [field]: value }),
        `editing ${field} must reset verification`,
      ).toBe(true)
    }
    // Non-reset fields per spec
    expect(
      shouldResetVerification({ reviewStatus: "verified" } as any, { tagNames: ["ops"] }),
    ).toBe(false)
    expect(
      shouldResetVerification({ reviewStatus: "verified" } as any, { collectionIds: ["c1"] }),
    ).toBe(false)
    // verifyNow short-circuits the reset
    expect(
      shouldResetVerification({ reviewStatus: "verified" } as any, {
        body: "new",
        verifyNow: true,
      }),
    ).toBe(false)
  })

  it("marks source metadata changes stale with a safe reason", () => {
    const next = applyReviewTransition({ reviewStatus: "verified", title: "Old" } as any, {
      kind: "source_metadata_changed",
    })
    expect(next.reviewStatus).toBe("stale")
    expect(next.reviewReason).toBe("content_changed")
  })

  it("creates one attention item per unresolved stale or review-needed target", async () => {
    const items = await computeKnowledgeAttentionItems({
      rows: async () => [
        {
          id: "d1",
          targetType: "document",
          title: "Runbook",
          reviewStatus: "needs_review",
          reviewReason: "expired",
        },
        {
          id: "l1",
          targetType: "source_link",
          title: "Drive Policy",
          reviewStatus: "stale",
          reviewReason: "source_unavailable",
        },
      ],
    } as any)
    expect(items.map((i) => i.entityId)).toEqual(["d1", "l1"])
    expect(items[0].kind).toBe("knowledge_review")
  })

  it("collapses duplicate attention items and derives owner/due-date reasons", async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const items = await computeKnowledgeAttentionItems({
      rows: async () => [
        {
          id: "d1",
          targetType: "document",
          title: "Runbook",
          reviewStatus: "needs_review",
          reviewReason: "expired",
        },
        {
          id: "d1",
          targetType: "document",
          title: "Runbook",
          reviewStatus: "needs_review",
          reviewReason: "expired",
        },
        {
          id: "d2",
          targetType: "document",
          title: "No owner",
          reviewStatus: "verified",
          ownerUserId: null,
        },
        {
          id: "d3",
          targetType: "document",
          title: "Past due",
          reviewStatus: "verified",
          reviewDueAt: past,
        },
      ],
    } as any)
    expect(items.map((i) => i.key)).toEqual([
      "knowledge:document:d1:expired",
      "knowledge:document:d2:owner_missing",
      "knowledge:document:d3:expired",
    ])
  })

  // Collection management tests moved to collections.integration.test.ts
  // (T2 rewrites the deps-injection shape to (tx, input, actor) with own SQL).

  it("normalizes tag names (trim, lowercase, single-space)", () => {
    expect(normalizeKnowledgeTagName("  Ops   Runbook ")).toBe("ops runbook")
  })
  // Full tagging integration tests live in tags.integration.test.ts (T3 — new
  // (tx, input, actor) shape).
})
