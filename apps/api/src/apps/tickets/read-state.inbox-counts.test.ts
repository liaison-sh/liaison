// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { inboxCounts } from "~/apps/tickets/read-state"
import { withInboxFixture } from "./read-state.test-fixtures"

describe("tickets.read-state.inbox-counts", () => {
  it("returns unread counts per source_inbox_id; closed and read excluded", async () => {
    await withInboxFixture(async ({ tx, inboxA, inboxB }) => {
      const out = await inboxCounts(tx, { inboxIds: [inboxA, inboxB] })
      const a = out.counts.find((c) => c.inboxId === inboxA)
      const b = out.counts.find((c) => c.inboxId === inboxB)
      expect(a?.unread).toBe(2)
      expect(b?.unread).toBe(1)
    })
  })

  it("filters by inboxIds when provided", async () => {
    await withInboxFixture(async ({ tx, inboxA }) => {
      const out = await inboxCounts(tx, { inboxIds: [inboxA] })
      expect(out.counts.map((c) => c.inboxId)).toEqual([inboxA])
    })
  })

  it("zero unread when last_inbound_at IS NULL on every ticket", async () => {
    await withInboxFixture({ noInbound: true }, async ({ tx, inboxA }) => {
      const out = await inboxCounts(tx, { inboxIds: [inboxA] })
      expect(out.counts.find((c) => c.inboxId === inboxA)?.unread ?? 0).toBe(0)
    })
  })
})
