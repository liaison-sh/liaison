// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo seed writes its approvals straight into the table, with no summary, and serving them
// ran the tool's summarizer on every read (served-summary.ts). The seed now stores each summary
// once, with the same summarizer; the read-time fill is the fallback for older rows only.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { approvalRequests } from "~/db/schema/kernel"
import { type SummaryRunner, storeApprovalSummaries } from "~/modules/approvals/served-summary"
import {
  type BackfillJob,
  backfillApprovalSummaryBatch,
  processApprovalSummaryBackfillJob,
} from "~/modules/approvals/summary-backfill"
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

  it("the backfill summarizes only pending rows: a decided, auto-approved or expired row runs no summarizer", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    const threadId = await minimal.thread(u.orgId, u.id)
    let calls = 0
    registerApprovalSummarizer(u.orgId, "tickets", "reply", async (params) => {
      calls++
      return {
        kind: "tickets.reply",
        title: `Reply on ${(params as { ticketId: string }).ticketId}`,
        lines: [],
      }
    })
    const decided: Array<{ status: string; reason?: string }> = [
      { status: "approved", reason: "auto_approved_by_policy" },
      { status: "approved", reason: "auto_approved_by_capability" },
      { status: "approved" },
      { status: "denied" },
      { status: "expired" },
      { status: "approved", reason: "auto_approved_by_policy" },
    ]
    const ids = await withPrivilegedDb(u.orgId, "t", async (tx) =>
      (
        await tx
          .insert(approvalRequests)
          .values(
            decided.map((d, i) => ({
              orgId: u.orgId,
              handle: `h-${crypto.randomUUID()}`,
              threadId,
              originatingThreadId: threadId,
              toolName: "tickets:reply",
              toolParams: { ticketId: `d-${i}` },
              currentPayload: { ticketId: `d-${i}` },
              expiresAt: new Date(Date.now() + 3_600_000),
              requestedBy: u.id,
              summary: i % 2 === 0 ? null : { kind: "k", title: "tickets:reply", lines: [] },
              status: d.status,
              ...(d.reason ? { reason: d.reason } : {}),
            })),
          )
          .returning({ id: approvalRequests.id })
      ).map((r) => r.id),
    )
    const res = await backfillApprovalSummaryBatch({
      orgIds: [u.orgId],
      ensureOrgApps: async () => {},
      run,
      cap: 50,
    })
    expect(res.stored).toBe(0)
    expect(res.next).toBeNull()
    expect(calls).toBe(0)
    const summaries = await withPrivilegedDb(u.orgId, "t", async (tx) =>
      (
        await tx
          .select({ summary: approvalRequests.summary })
          .from(approvalRequests)
          .where(inArray(approvalRequests.id, ids))
      ).map((r) => r.summary),
    )
    // They keep what they had: served with the generic summary of their payload.
    expect(summaries.filter((x) => x === null).length).toBe(3)
  })

  it("the backfill job summarizes pending rows in paced batches of its cap, then stops", async () => {
    const u = await minimal.orgAdmin((await createTestOrg()).id)
    const threadId = await minimal.thread(u.orgId, u.id)
    let calls = 0
    registerApprovalSummarizer(u.orgId, "tickets", "reply", async (params) => {
      calls++
      return {
        kind: "tickets.reply",
        title: `Reply on ${(params as { ticketId: string }).ticketId}`,
        lines: [],
      }
    })
    const ids = await withPrivilegedDb(u.orgId, "t", async (tx) =>
      (
        await tx
          .insert(approvalRequests)
          .values(
            [0, 1, 2, 3, 4].map((i) => ({
              orgId: u.orgId,
              handle: `h-${crypto.randomUUID()}`,
              threadId,
              originatingThreadId: threadId,
              toolName: "tickets:reply",
              toolParams: { ticketId: `p-${i}` },
              currentPayload: { ticketId: `p-${i}` },
              expiresAt: new Date(Date.now() + 3_600_000),
              requestedBy: u.id,
              summary: i === 0 ? { kind: "k", title: "tickets:reply", lines: [] } : null,
            })),
          )
          .returning({ id: approvalRequests.id })
      ).map((r) => r.id),
    )
    const queued: BackfillJob[] = []
    const deps = {
      orgIds: [u.orgId],
      ensureOrgApps: async () => {},
      run,
      cap: 2,
      enqueue: async (job: BackfillJob) => {
        queued.push(job)
      },
    }
    const perJob: number[] = []
    let payload: BackfillJob["payload"] = {}
    for (let jobs = 0; jobs < 10; jobs++) {
      const before = calls
      await processApprovalSummaryBackfillJob(payload, deps)
      perJob.push(calls - before)
      const next = queued.shift()
      if (!next) break
      // Paced: the next batch waits before it runs.
      expect(next.delay).toBeGreaterThan(0)
      payload = next.payload
    }
    expect(perJob).toEqual([2, 2, 1])
    expect(calls).toBe(5)
    const titles = await withPrivilegedDb(u.orgId, "t", async (tx) =>
      (
        await tx
          .select({ summary: approvalRequests.summary })
          .from(approvalRequests)
          .where(inArray(approvalRequests.id, ids))
      ).map((r) => (r.summary as { title?: string } | null)?.title),
    )
    expect(titles.sort()).toEqual([0, 1, 2, 3, 4].map((i) => `Reply on p-${i}`))
    // Every pending row has its summary: a new pass computes nothing.
    await processApprovalSummaryBackfillJob({}, deps)
    expect(calls).toBe(5)
    expect(queued).toEqual([])
  })
})
