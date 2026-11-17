// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The hourly sweep of a project's billing plan: a done milestone with no invoice is drafted (the
// backstop of a lost status event); one it cannot draft raises one Home line, which goes once the
// step has its invoice.

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

type Row = Record<string, unknown>

// The job's ctx is the app's own: the sweep drafts through the same mutation a person calls.
function sweepCtx(h: ReturnType<typeof harness>, emitted: Row[]) {
  h.ctx.emit = async (e: Row) => {
    emitted.push(e)
  }
  return h.ctx as never
}

const invoices = (h: ReturnType<typeof harness>) =>
  h.db.__all("documents").filter((d) => d.type === "invoice")

describe("billing steps sweep", () => {
  test("a done step with no invoice is drafted by the sweep, once, parked for a person, with no line", async () => {
    const h = harness()
    await withPlan(h)
    const emitted: Row[] = []
    // Nothing done yet: nothing drafted, no line.
    expect(await billingStepsSweep(sweepCtx(h, emitted))).toMatchObject({ raised: 0, drafted: 0 })
    done(h, T_BETA)
    const first = await billingStepsSweep(sweepCtx(h, emitted))
    const second = await billingStepsSweep(sweepCtx(h, emitted))
    expect(first).toMatchObject({ drafted: 1, raised: 0 })
    expect(second).toMatchObject({ drafted: 0, raised: 0 })
    expect(invoices(h)).toHaveLength(1)
    expect(invoices(h)[0]).toMatchObject({ status: "draft" })
    // Its issue approval is the project's one item; nothing was issued and no line went up.
    expect(h.approvals.filter((a) => a.status === "pending")).toHaveLength(1)
    expect(emitted.filter((e) => (e.data as Row).resolved === false)).toHaveLength(0)
  })

  test("a done step the sweep cannot draft raises one line, once, and the line goes once it is drafted", async () => {
    const h = harness()
    await withPlan(h)
    const emitted: Row[] = []
    const beta = h.db.__all("billing_steps").find((s) => s.task_id === T_BETA) as Row
    const quote = beta.quote_document_id
    await h.db.update("billing_steps", String(beta.id), { quote_document_id: crypto.randomUUID() })
    done(h, T_BETA)
    const first = await billingStepsSweep(sweepCtx(h, emitted))
    const second = await billingStepsSweep(sweepCtx(h, emitted))
    expect(first).toMatchObject({ raised: 1, drafted: 0 })
    expect(second.raised).toBe(0)
    const raised = emitted.filter((e) => (e.data as Row).resolved === false)
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({
      entity: "billing_step",
      action: "milestone_no_invoice",
      entityId: PROJECT,
      data: { step_label: "Beta", resolved: false },
    })
    expect(invoices(h)).toHaveLength(0)
    // The plan is put right: the next sweep drafts it and the line goes, once.
    await h.db.update("billing_steps", String(beta.id), { quote_document_id: quote })
    const after = await billingStepsSweep(sweepCtx(h, emitted))
    expect(after.drafted).toBe(1)
    expect(invoices(h)).toHaveLength(1)
    expect(emitted.at(-1)).toMatchObject({ data: { resolved: true } })
    expect((await billingStepsSweep(sweepCtx(h, emitted))).raised).toBe(0)
  })

  test("two milestones done on one day make two drafts, one per step", async () => {
    const h = harness()
    await withPlan(h)
    const emitted: Row[] = []
    done(h, T_BETA)
    done(h, T_GAMMA)
    expect(await billingStepsSweep(sweepCtx(h, emitted))).toMatchObject({ drafted: 2, raised: 0 })
    expect(invoices(h)).toHaveLength(2)
    expect(await billingStepsSweep(sweepCtx(h, emitted))).toMatchObject({ drafted: 0, raised: 0 })
  })
})
