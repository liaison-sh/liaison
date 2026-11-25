// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A milestone task moved to a done status drafts its billing step's invoice at once: one draft,
// parked for a person's issue approval, nothing issued; a replay finds the draft.

import { describe, expect, test } from "bun:test"
import { done, harness, T_BETA, withPlan } from "./__tests__/billing-plan-fixtures"
import { onMilestoneTaskDone } from "./milestone-done"

type Row = Record<string, unknown>

const moved = (id: string, terminal: boolean) => ({ data: { id, terminal } })
const invoices = (h: ReturnType<typeof harness>) =>
  h.db.__all("documents").filter((d: Row) => d.type === "invoice")

describe("a milestone moved to done", () => {
  test("drafts its step's invoice once, parked for a person, and issues nothing", async () => {
    const h = harness()
    await withPlan(h)
    done(h, T_BETA)
    const out = await onMilestoneTaskDone(h.ctx, moved(T_BETA, true))
    expect(out).toMatchObject({ status: "drafted" })
    expect(invoices(h)).toHaveLength(1)
    expect(invoices(h)[0]).toMatchObject({
      status: "draft",
      external_ref: expect.stringMatching(/^milestone:/),
    })
    expect(h.approvals.filter((a) => a.status === "pending")).toHaveLength(1)
    const step = h.db.__all("billing_steps").find((s: Row) => s.task_id === T_BETA) as Row
    expect(step.state).toBe("drafted")
    // A second delivery of the same move drafts nothing more.
    expect(await onMilestoneTaskDone(h.ctx, moved(T_BETA, true))).toMatchObject({
      status: "ignored",
    })
    expect(invoices(h)).toHaveLength(1)
  })

  test("a move to a status that is not done, or of a task with no step, drafts nothing", async () => {
    const h = harness()
    await withPlan(h)
    expect(await onMilestoneTaskDone(h.ctx, moved(T_BETA, false))).toMatchObject({
      status: "ignored",
    })
    const other = "5b1d2c3e-0000-4000-8000-0000000000ff"
    expect(await onMilestoneTaskDone(h.ctx, moved(other, true))).toMatchObject({
      status: "ignored",
    })
    expect(invoices(h)).toHaveLength(0)
    expect(h.approvals).toHaveLength(0)
  })
})
