// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hourly sweep of a project's billing plan: a done milestone with no invoice raises one Home
// line, once per step, and drafts nothing; the line goes once the step has its invoice.

import { describe, expect, test } from "bun:test"
import { done, harness, T_BETA, withPlan } from "./__tests__/billing-plan-fixtures"
import { billingStepsSweep } from "./billing-steps-sweep"
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
})
