// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The month-end run's card against the in-memory store: one approval with a row per draft, what a
// change does to its hash, undo and reject, the last-day urgency, and issuing by itself under the
// approval threshold. Numbers and the issue transaction are proven on Postgres in the api suite.
import { describe, expect, test } from "bun:test"
import { harness, previousDoc, schedule } from "./draft-job.test"
import { recurringDraftJob } from "./draft-job"
import { recurringIssueJob } from "./issue-job"
import { recurringLegalDateJob, urgencyOf } from "./legal-date-job"
import { cardItems, recurringRunIssue, recurringRunUnapprove } from "./run-card"
import { recurringRunGet } from "./run-get"

const SCHED_ONE = "33333333-3333-4333-8333-333333333331"
const SCHED_TWO = "33333333-3333-4333-8333-333333333332"

async function drafted(today = "2026-11-27", extra: Parameters<typeof harness>[1] = {}) {
  const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
  const h = harness(today, {
    schedules: [schedule(SCHED_ONE, { last_document_id: prev.id }), schedule(SCHED_TWO, { last_document_id: prev.id, created_by: "user-am-2" })],
    docs: [prev],
    ...extra,
  })
  await recurringDraftJob(h.ctx)
  const [run] = h.db.__all("recurring_runs")
  return { h, runId: String(run?.id) }
}

describe("the month-end run card", () => {
  test("the card is one approval with one row per draft and its account manager, and a changed row changes the card's hash", async () => {
    const { h, runId } = await drafted()
    expect(h.approvals).toHaveLength(1)
    const card = h.approvals[0] as { tool_name: string; current_payload: { run_id: string; items: Array<{ content_hash: string; document_id: string; total_minor: string }> }; summary_detail: { lines: string[] }; expiry_hours: number }
    expect(card.tool_name).toBe("invoicing:recurring_run_issue")
    expect(card.current_payload.items).toHaveLength(2)
    expect(card.current_payload.items[0]?.total_minor).toBe("180000")
    expect(card.summary_detail.lines).toHaveLength(2)
    expect(card.summary_detail.lines[0]).toContain("1500.00 EUR excl., 300.00 EUR VAT, 1800.00 EUR incl.")
    // Drawn on 27 Nov at 09:00 in Paris, valid to the end of 30 Nov.
    expect(card.expiry_hours).toBe(3 * 24 + 15)
    const got = await recurringRunGet(h.ctx, { run_id: runId })
    if (got.status !== "completed") throw new Error("run not read")
    expect(got.rows.map((r) => r.account_manager)).toEqual(["user-am", "user-am-2"])
    expect(got.rows.every((r) => r.draft_id !== null)).toBe(true)
    const before = (await cardItems(h.ctx, runId)).items[0]?.content_hash
    const firstDraft = card.current_payload.items[0]?.document_id as string
    const line = h.db.__all("document_lines").find((l) => l.document_id === firstDraft)
    await h.db.update("document_lines", String(line?.id), { unit_price_minor: "160000", subtotal_minor: "160000" })
    const after = (await cardItems(h.ctx, runId)).items[0]?.content_hash
    expect(after).not.toBe(before)
  })

  test("approval records each item's hash and the approver and takes no number", async () => {
    const { h, runId } = await drafted()
    const payload = (h.approvals[0] as { current_payload: { run_id: string; items: never[] } }).current_payload
    h.ctx.approval = { approvalRequestId: "approval-1", approvalDeciderId: "user-boss", toolName: "invoicing:recurring_run_issue" }
    const res = await recurringRunIssue(h.ctx, payload)
    expect(res).toMatchObject({ status: "completed", approved: 2 })
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "approved", approved_by: "user-boss" })
    expect(h.db.__all("recurring_run_items").every((i) => typeof i.approved_hash === "string" && i.state === "approved")).toBe(true)
    expect(h.db.__all("documents").filter((d) => d.status === "draft").every((d) => d.number === null)).toBe(true)
    expect(runId).toBeTruthy()
  })

  test("undo before the first number returns the run to drafted; after it, it is refused naming what issued", async () => {
    const { h, runId } = await drafted()
    const payload = (h.approvals[0] as { current_payload: { run_id: string; items: never[] } }).current_payload
    await recurringRunIssue(h.ctx, payload)
    h.decided.add("approval-1")
    const undone = await recurringRunUnapprove(h.ctx, { run_id: runId })
    expect(undone).toMatchObject({ status: "completed", approval_id: "approval-2" })
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "drafted", approved_by: null })
    expect(h.db.__all("recurring_run_items").every((i) => i.state === "ready" && i.approved_hash === null)).toBe(true)
    await recurringRunIssue(h.ctx, (h.approvals[1] as { current_payload: never }).current_payload)
    const [first] = h.db.__all("recurring_run_items")
    await h.db.update("recurring_run_items", String(first?.id), { state: "issued", issued_number: "F-2026-0041" })
    const refused = await recurringRunUnapprove(h.ctx, { run_id: runId })
    expect(refused).toMatchObject({ status: "error", error: { code: "run_already_issuing" } })
    expect(JSON.stringify(refused)).toContain("F-2026-0041")
  })

  test("a reject keeps drafts and a new card is staged on the issue day", async () => {
    const { h, runId } = await drafted()
    h.ctx.approvals = { ...h.ctx.approvals, statusOf: async () => ({ status: "denied" }) }
    await recurringLegalDateJob(h.ctx)
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "rejected" })
    expect(h.db.__all("documents").filter((d) => d.status === "draft" && d.number === null)).toHaveLength(2)
    // The day before the issue day: nothing is staged.
    const dayBefore = harness("2026-11-29")
    Object.assign(h.ctx, { time: dayBefore.ctx.time })
    await recurringIssueJob(h.ctx)
    expect(h.approvals).toHaveLength(1)
    // The issue day (a Monday), 09:00 in Paris: a new card.
    const onDay = harness("2026-11-30")
    Object.assign(h.ctx, { time: onDay.ctx.time })
    await recurringIssueJob(h.ctx)
    expect(h.approvals).toHaveLength(2)
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ id: runId, status: "drafted", approval_request_id: "approval-2" })
  })

  test("three days before the last day urgency rises, on the day the card ends today, after it the run is late and nothing issues", async () => {
    expect(urgencyOf("2026-11-26", "2026-11-30")).toBe("normal")
    expect(urgencyOf("2026-11-27", "2026-11-30")).toBe("rising")
    expect(urgencyOf("2026-11-29", "2026-11-30")).toBe("rising")
    expect(urgencyOf("2026-11-30", "2026-11-30")).toBe("ends_today")
    expect(urgencyOf("2026-12-01", "2026-11-30")).toBe("late")
    const { h } = await drafted()
    const events: Array<{ action: string; data: { urgency: string; when: string } }> = []
    h.ctx.emit = async (e) => {
      events.push(e as never)
    }
    for (const [day, urgency] of [["2026-11-30", "ends_today"], ["2026-12-01", "late"]] as const) {
      Object.assign(h.ctx, { time: harness(day).ctx.time })
      await recurringLegalDateJob(h.ctx)
      expect(events.at(-1)?.data.urgency).toBe(urgency)
    }
    expect(events.find((e) => e.data.urgency === "ends_today")?.data.when).toBe("Ends today")
    expect(h.db.__all("recurring_runs")[0]).toMatchObject({ status: "late" })
    // Approved late, the issue job still issues nothing after the last day.
    let issueCalls = 0
    h.ctx.executeTool = async () => {
      issueCalls += 1
      return { status: "error", error: { code: "x", message: "x" } }
    }
    await h.db.update("recurring_runs", String(h.db.__all("recurring_runs")[0]?.id), { status: "approved" })
    await recurringIssueJob(h.ctx)
    expect(issueCalls).toBe(0)
  })

  test("issue by itself under, at and over the threshold: no card, no card, card", async () => {
    // One schedule of 1,500.00 + 20% VAT = 1,800.00 incl., set to issue by itself.
    for (const [threshold, card] of [[180001, false], [180000, false], [179999, true]] as const) {
      const prev = previousDoc("44444444-4444-4444-8444-444444444441", true)
      const h = harness("2026-11-27", {
        schedules: [schedule(SCHED_ONE, { issue_mode: "auto", auto_enabled_by: "user-boss", last_document_id: prev.id })],
        docs: [prev],
        threshold,
      })
      await recurringDraftJob(h.ctx)
      expect(h.approvals.length > 0).toBe(card)
      const [run] = h.db.__all("recurring_runs")
      expect(run).toMatchObject(card ? { status: "drafted" } : { status: "approved", auto: true, approved_by: "user-boss" })
    }
  })
})
