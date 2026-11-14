// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hourly sweep of a project's billing plan: a done milestone with no invoice raises one Home
// line, once per step, and drafts nothing; the line goes once the step has its invoice.

import { describe, expect, test } from "bun:test"
import {
  done,
  harness,
  PROJECT,
  T_BETA,
  T_GAMMA,
  withPlan,
} from "./__tests__/billing-plan-fixtures"
import { billingStepsSweep } from "./billing-steps-sweep"
import { invoiceIssue } from "./mutations"
import { milestoneDraftCreate } from "./mutations/billing-plan"

type Row = Record<string, unknown>

function sweepCtx(h: ReturnType<typeof harness>, emitted: Row[]) {
  return {
    db: h.db,
    executeTool: h.ctx.executeTool,
    time: h.ctx.time,
    emit: async (e: Row) => {
      emitted.push(e)
    },
  } as never
}

describe("billing steps sweep", () => {
  test("a done step with no invoice raises one line, once, and drafts nothing", async () => {
    const h = harness()
    await withPlan(h)
    const emitted: Row[] = []
    // Nothing done yet: no line.
    expect(await billingStepsSweep(sweepCtx(h, emitted))).toMatchObject({ raised: 0 })
    done(h, T_BETA)
    const first = await billingStepsSweep(sweepCtx(h, emitted))
    const second = await billingStepsSweep(sweepCtx(h, emitted))
    expect(first.raised).toBe(1)
    expect(second.raised).toBe(0)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      entity: "billing_step",
      action: "milestone_no_invoice",
      data: { task_title: "Beta", resolved: false },
    })
    // It drafted nothing and asked nobody.
    expect(h.db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(0)
    expect(h.approvals).toHaveLength(0)
    // The person drafts it: the line goes, once.
    const d = await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
    expect(d.status).toBe("completed")
    const third = await billingStepsSweep(sweepCtx(h, emitted))
    expect(third.resolved).toBe(1)
    expect(emitted.at(-1)).toMatchObject({
      action: "milestone_no_invoice",
      data: { resolved: true },
    })
    expect((await billingStepsSweep(sweepCtx(h, emitted))).resolved).toBe(0)
  })

  test("two milestones done in one month make one Home line for the project, and a waiting draft holds it", async () => {
    const h = harness()
    await withPlan(h)
    const emitted: Row[] = []
    h.ctx.emit = async (e: Row) => {
      emitted.push(e)
    }
    done(h, T_BETA)
    done(h, T_GAMMA)
    const first = await billingStepsSweep(sweepCtx(h, emitted))
    expect(first.raised).toBe(1)
    const raisedLines = () => emitted.filter((e) => (e.data as Row).resolved === false)
    expect(raisedLines()).toHaveLength(1)
    expect(raisedLines()[0]).toMatchObject({ entityId: PROJECT })
    expect(String((raisedLines()[0]?.data as Row).task_title)).toContain("Beta")
    expect(String((raisedLines()[0]?.data as Row).task_title)).toContain("Gamma")
    // Drafting one of them takes the line down at once: its issue approval is the project's item.
    const d = await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
    if (d.status !== "completed") throw new Error(JSON.stringify(d))
    expect(emitted.at(-1)).toMatchObject({ entityId: PROJECT, data: { resolved: true } })
    // While the draft waits, Gamma raises no second line.
    const waiting = await billingStepsSweep(sweepCtx(h, emitted))
    expect(waiting.raised).toBe(0)
    expect(raisedLines()).toHaveLength(1)
    // Once it is issued, Gamma's line comes up, alone.
    await invoiceIssue(h.ctx, { draft_id: d.draftId })
    const after = await billingStepsSweep(sweepCtx(h, emitted))
    expect(after.raised).toBe(1)
    expect(raisedLines()).toHaveLength(2)
    expect(String((raisedLines()[1]?.data as Row).task_title)).toBe("Gamma")
  })
})
