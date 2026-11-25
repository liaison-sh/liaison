// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An approved run that commits on its own transactions says what it committed: a discard is one
// commit, so a failure at its last write leaves the draft whole and reads as no effect; an issue
// that fails after its number is committed reads as done (the number and the document), never as
// unknown or as nothing.

import { describe, expect, test } from "bun:test"
import { draftFromCard, type Harness, harness, type Row } from "./__tests__/from-reconcile-harness"
import { draftsDiscard, invoiceIssue, invoiceIssuePreflight } from "./mutations"

/** The harness, its run approved as `tool`, with the protocol records it makes. */
function approvedAs(tool: string): Harness & { records: Row[] } {
  const h = harness()
  const records: Row[] = []
  Object.assign(h.ctx, {
    approval: { approvalRequestId: "ap-1", approvalDeciderId: "user-1", toolName: tool },
    approval_recordStarted: async (t: string) => {
      records.push({ step: "started", tool: t })
    },
    approval_recordEffectLanded: async (t: string, ref: string) => {
      records.push({ step: "landed", tool: t, ref: JSON.parse(ref) })
    },
    approval_recordSucceeded: async (t: string) => {
      records.push({ step: "succeeded", tool: t })
    },
    approval_recordFailedNoEffect: async (t: string, err: string) => {
      records.push({ step: "failed_no_effect", tool: t, error: JSON.parse(err) })
    },
  })
  return { ...h, records }
}

describe("an approved run on its own transactions", () => {
  test("a discard failing at its last write leaves the draft, its lines and its report whole, recorded as no effect", async () => {
    const h = approvedAs("invoicing:drafts_discard")
    const draftId = await draftFromCard(h)
    const before = {
      lines: h.db.__all("document_lines").filter((l) => l.document_id === draftId).length,
      reports: h.db.__all("activity_reports").filter((r) => r.document_id === draftId).length,
      attachments: h.db.__all("document_attachments").filter((a) => a.document_id === draftId)
        .length,
    }
    expect(before.lines).toBeGreaterThan(0)
    expect(before.attachments).toBeGreaterThan(0)
    // The draft's own delete, the commit's last write, fails: the commit lands nothing.
    const batch = h.db.batch.bind(h.db)
    h.db.batch = (async (spec: { ops: Row[] }) => {
      const last = spec.ops.at(-1)
      if (last?.delete === "documents" && last.id === draftId)
        throw new Error("the draft is still referenced")
      return batch(spec as never)
    }) as never

    await expect(draftsDiscard(h.ctx, { draft_id: draftId })).rejects.toThrow("still referenced")

    expect(h.db.__all("documents").some((d) => d.id === draftId)).toBe(true)
    expect(h.db.__all("document_lines").filter((l) => l.document_id === draftId)).toHaveLength(
      before.lines,
    )
    expect(h.db.__all("activity_reports").filter((r) => r.document_id === draftId)).toHaveLength(
      before.reports,
    )
    expect(
      h.db.__all("document_attachments").filter((a) => a.document_id === draftId),
    ).toHaveLength(before.attachments)
    expect(h.records.map((r) => r.step)).toEqual(["started", "failed_no_effect"])
  })

  test("a discard records its one commit, then that it finished", async () => {
    const h = approvedAs("invoicing:drafts_discard")
    const draftId = await draftFromCard(h)
    await draftsDiscard(h.ctx, { draft_id: draftId })
    expect(h.db.__all("documents").some((d) => d.id === draftId)).toBe(false)
    expect(h.db.__all("document_lines").filter((l) => l.document_id === draftId)).toHaveLength(0)
    expect(h.records.map((r) => r.step)).toEqual(["started", "landed", "succeeded"])
  })

  test("an issue failing after its number is committed records the invoice as landed, not as no effect", async () => {
    const h = approvedAs("invoicing:invoice_issue")
    const draftId = await draftFromCard(h)
    // What its approver was shown, as the card carries it.
    const pre = (await invoiceIssuePreflight(h.ctx, { draft_id: draftId })) as {
      pinnedParams?: { draft_hash?: string }
    }
    // The first thing after the numbering commit fails.
    h.ctx.emit = async () => {
      throw new Error("the event bus is down")
    }

    await expect(
      invoiceIssue(h.ctx, { draft_id: draftId, draft_hash: pre.pinnedParams?.draft_hash }),
    ).rejects.toThrow("event bus is down")

    const issued = h.db.__all("documents").find((d) => d.status === "issued" && d.number)
    expect(issued).toBeDefined()
    expect(h.records.map((r) => r.step)).toEqual(["started", "landed"])
    expect(h.records[1]?.ref).toEqual({ document_id: issued?.id, number: issued?.number })
  })

  test("an issue refused before its number records no effect", async () => {
    const h = approvedAs("invoicing:invoice_issue")
    const res = await invoiceIssue(h.ctx, { draft_id: "7a1d2c3e-0000-4000-8000-0000000000ee" })
    expect(res).toMatchObject({ status: "error" })
    expect(h.records.map((r) => r.step)).toEqual(["started", "failed_no_effect"])
  })

  test("a call inside another tool's approval records nothing of its own", async () => {
    const h = approvedAs("invoicing:some_other_tool")
    const draftId = await draftFromCard(h)
    await draftsDiscard(h.ctx, { draft_id: draftId })
    expect(h.records).toEqual([])
  })
})
