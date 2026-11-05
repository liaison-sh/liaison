// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B7 — attention provider. Maps finding/dm_conversation rows to AttentionItems:
//   - findings needing a reply (status triaged + should_reply) → `mention`
//   - findings awaiting approval → `approval_pending`
//   - DMs whose reply window is closing soon → `dm_window_closing`
// Capped at 200 items.

import { describe, expect, test } from "bun:test"
import { computeSocialAttention } from "./attention"
import type { SocialToolCtx } from "./ctx"
import { createMockDb, type MockDb } from "./test-db"

function makeCtx(db: MockDb): SocialToolCtx {
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({ status: 200, ok: true, json: async () => ({}), text: async () => "" })) as never,
    connections: {},
    config: { get: async () => null },
    async emit() {},
  } as SocialToolCtx
}

describe("computeSocialAttention (B7)", () => {
  test("maps a should_reply triaged finding to a `mention` open_entity item", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f1",
      platform: "youtube",
      external_id: "y1",
      relation: "keyword_match",
      status: "triaged",
      should_reply: true,
      urgency: 70,
      content_text: "where can I buy this?",
      occurred_at: "2026-06-01T08:00:00.000Z",
    })
    const items = await computeSocialAttention(makeCtx(db), "org-1", "user-1")
    const mention = items.find((i) => i.kind === "mention")
    expect(mention).toBeDefined()
    expect(mention?.action.type).toBe("open_entity")
    expect(mention?.entityId).toBe("f1")
  })

  test("maps an awaiting_approval finding to an `approval_pending` item", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f2",
      platform: "facebook",
      external_id: "fb2",
      relation: "comment_on_our_content",
      status: "awaiting_approval",
      urgency: 60,
      occurred_at: "2026-06-01T08:00:00.000Z",
    })
    const items = await computeSocialAttention(makeCtx(db), "org-1", "user-1")
    expect(items.some((i) => i.kind === "approval_pending" && i.entityId === "f2")).toBe(true)
  })

  test("maps a DM whose window is closing soon to `dm_window_closing`", async () => {
    const db = createMockDb()
    const now = Date.now()
    // last inbound ~6d20h ago → ~4h before the 7d HUMAN_AGENT window closes
    const closingSoon = new Date(now - (7 * 86400_000 - 4 * 3600_000)).toISOString()
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "IG1",
      participant_handle: "@fan",
      last_inbound_at: closingSoon,
      status: "open",
    })
    const items = await computeSocialAttention(makeCtx(db), "org-1", "user-1")
    const closing = items.find((i) => i.kind === "dm_window_closing")
    expect(closing).toBeDefined()
    expect(closing?.action.type).toBe("open_entity")
  })

  test("does NOT raise dm_window_closing for a fresh conversation", async () => {
    const db = createMockDb()
    await db.insert("dm_conversation", {
      id: "c2",
      platform: "instagram",
      external_id: "IG2",
      last_inbound_at: new Date().toISOString(),
      status: "open",
    })
    const items = await computeSocialAttention(makeCtx(db), "org-1", "user-1")
    expect(items.some((i) => i.kind === "dm_window_closing")).toBe(false)
  })

  test("an awaiting_approval finding with an approval_request_id routes to decide_approval (M2 / §5)", async () => {
    const db = createMockDb()
    await db.insert("finding", {
      id: "f3",
      platform: "facebook",
      external_id: "fb3",
      relation: "comment_on_our_content",
      status: "awaiting_approval",
      urgency: 80,
      approval_request_id: "appr-99",
      occurred_at: "2026-06-01T08:00:00.000Z",
    })
    const items = await computeSocialAttention(makeCtx(db), "org-1", "user-1")
    const approval = items.find((i) => i.kind === "approval_pending" && i.entityId === "f3")
    expect(approval).toBeDefined()
    expect(approval?.action).toEqual({ type: "decide_approval", approvalId: "appr-99" })
  })

  test("caps the result at 200 items", async () => {
    const db = createMockDb()
    for (let i = 0; i < 250; i++) {
      await db.insert("finding", {
        id: `f${i}`,
        platform: "youtube",
        external_id: `y${i}`,
        relation: "keyword_match",
        status: "triaged",
        should_reply: true,
        urgency: 50,
        occurred_at: "2026-06-01T08:00:00.000Z",
      })
    }
    const items = await computeSocialAttention(makeCtx(db), "org-1", "user-1")
    expect(items.length).toBeLessThanOrEqual(200)
  })
})
