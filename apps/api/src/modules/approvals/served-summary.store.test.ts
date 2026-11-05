// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo seed writes its approvals straight into the table, with no summary, and serving them
// ran the tool's summarizer on every read (served-summary.ts). The seed now stores each summary
// once, with the same summarizer; the read-time fill is the fallback for older rows only.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel"
import { type SummaryRunner, storeApprovalSummaries } from "~/modules/approvals/served-summary"
import { approvalSummarizerRegistry } from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// The summarizers below read nothing, so they run without a transaction.
const run: SummaryRunner = (row, summarize) =>
  summarize({ tx: {} as RlsClient, userId: row.requested_by ?? "" })

describe("storeApprovalSummaries", () => {
  beforeAll(async () => {
    await acquireTestLock()
  })
  afterAll(async () => {
    approvalSummarizerRegistry.clear()
    await releaseTestLock()
  })

  it("stores the summarizer's summary on rows written without one, and leaves the rest", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    const threadId = await minimal.thread(u.orgId, u.id)
    registerApprovalSummarizer(u.orgId, "tickets", "reply", async (params) => ({
      kind: "tickets.reply",
      title: `Reply on ${(params as { ticketId: string }).ticketId}`,
      lines: ["To: Tomoko"],
    }))
    const insert = (toolName: string, payload: unknown, summary: unknown = null) =>
      withPrivilegedDb(u.orgId, "t", async (tx) => {
        const [r] = await tx
          .insert(approvalRequests)
          .values({
            orgId: u.orgId,
            handle: `h-${crypto.randomUUID()}`,
            threadId,
            originatingThreadId: threadId,
            toolName,
            toolParams: payload,
            currentPayload: payload,
            expiresAt: new Date(Date.now() + 3_600_000),
            requestedBy: u.id,
            summary,
            metadata: { seeded: true },
          })
          .returning({ id: approvalRequests.id })
        return r!.id
      })
    const reply = await insert("tickets:reply", { ticketId: "t-1" })
    // A reseed brought the payload to a newer spec: the stored summary follows it.
    const stale = await insert(
      "tickets:reply",
      { ticketId: "t-2" },
      { kind: "tickets.reply", title: "Reply on t-old", lines: [] },
    )
    const noSummarizer = await insert("nosummaryapp:thing", {})

    const stored = await storeApprovalSummaries(u.orgId, [reply, stale, noSummarizer], run)
    expect(stored).toBe(2)
    const summaryOf = (id: string) =>
      withPrivilegedDb(u.orgId, "t", async (tx) => {
        const [r] = await tx
          .select({ summary: approvalRequests.summary })
          .from(approvalRequests)
          .where(eq(approvalRequests.id, id))
        return r?.summary as { title?: string; lines?: string[] } | null
      })
    expect(await summaryOf(reply)).toMatchObject({ title: "Reply on t-1", lines: ["To: Tomoko"] })
    expect((await summaryOf(stale))?.title).toBe("Reply on t-2")
    // No summarizer: nothing stored, the feed derives the title when served.
    expect(await summaryOf(noSummarizer)).toBeNull()
  })
})
