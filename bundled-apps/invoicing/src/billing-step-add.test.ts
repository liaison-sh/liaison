// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An accepted amendment's milestone: one step per change request the client accepted, added by
// the agreements app as its sender, billed when its task is done. A retry adds nothing; a
// project with no plan gets no step; the plan's total then takes the amendments it lists.

import { describe, expect, test } from "bun:test"
import manifest from "../app.manifest.json"
import { harness, PLAN_STEPS, PROJECT, QUOTE, withPlan } from "./__tests__/billing-plan-fixtures"
import { billingPlanSet, billingStepAdd } from "./mutations/billing-plan"

type Row = Record<string, unknown>

const CR = "5b1d2c3e-0000-4000-8000-0000000000c1"
const CR2 = "5b1d2c3e-0000-4000-8000-0000000000c2"
const T_CR = "5b1d2c3e-0000-4000-8000-0000000000b1"
const T_CR2 = "5b1d2c3e-0000-4000-8000-0000000000b2"

function withCrTasks(h: ReturnType<typeof harness>) {
  for (const id of [T_CR, T_CR2])
    h.tasks.set(id, { id, title: "CR", terminal: false, isMilestone: true, completedOn: null })
  return h
}

const add = (h: ReturnType<typeof harness>, over: Row = {}) =>
  billingStepAdd(h.ctx, {
    projectId: PROJECT,
    changeRequestId: CR,
    label: "CR-1: Single sign-on",
    amountMinor: "600000",
    currency: "EUR",
    taskId: T_CR,
    ...over,
  })

const amendmentSteps = (h: ReturnType<typeof harness>) =>
  h.db.__all("billing_steps").filter((s) => typeof s.change_request_ref === "string")

describe("an accepted amendment's billing step", () => {
  test("a project with a billing plan gets one milestone per accepted change request, after its other steps", async () => {
    const h = withCrTasks(harness())
    await withPlan(h)
    const one = await add(h)
    expect(one).toMatchObject({ status: "completed", added: true, position: 6 })
    const two = await add(h, {
      changeRequestId: CR2,
      label: "CR-2: Export",
      amountMinor: 120000,
      taskId: T_CR2,
    })
    expect(two).toMatchObject({ status: "completed", added: true, position: 7 })
    const steps = amendmentSteps(h)
    expect(
      steps.map((s) => [s.kind, s.change_request_ref, String(s.amount_minor), s.task_id]),
    ).toEqual([
      ["milestone", CR, "600000", T_CR],
      ["milestone", CR2, "120000", T_CR2],
    ])
    // The plan now bills the quote plus both amendments.
    expect(two).toMatchObject({ milestonesMinor: 6_400_000 + 600_000 + 120_000 })
    expect((one as { message: string }).message).toContain("Nothing was invoiced")
    expect(h.db.__all("documents").filter((d) => d.type === "invoice")).toHaveLength(0)
  })

  test("a retry for the same change request adds nothing and answers the step it added", async () => {
    const h = withCrTasks(harness())
    await withPlan(h)
    await add(h)
    const again = await add(h)
    expect(again).toMatchObject({ status: "completed", added: false, position: 6 })
    expect((again as { message: string }).message).toContain("Nothing was added")
    expect(amendmentSteps(h)).toHaveLength(1)
  })

  test("a project with no billing plan gets no step, and says so", async () => {
    const h = withCrTasks(harness())
    const out = await add(h)
    expect(out).toMatchObject({ status: "error", error: { code: "no_billing_plan" } })
    expect(h.db.__all("billing_steps")).toHaveLength(0)
  })

  test("a task outside the project, a task already billed or another currency is refused", async () => {
    const h = withCrTasks(harness())
    await withPlan(h)
    const stranger = "5b1d2c3e-0000-4000-8000-0000000000ff"
    expect(await add(h, { taskId: stranger })).toMatchObject({
      error: { code: "task_not_in_project" },
    })
    const billedTask = PLAN_STEPS[1]?.taskId
    expect(await add(h, { taskId: billedTask })).toMatchObject({
      error: { code: "task_on_other_plan" },
    })
    expect(await add(h, { currency: "USD" })).toMatchObject({
      error: { code: "currency_mismatch" },
    })
    expect(amendmentSteps(h)).toHaveLength(0)
  })

  test("a plan saved again keeps its total rule: the quote plus the accepted amendments it lists", async () => {
    const h = withCrTasks(harness())
    await withPlan(h)
    await add(h)
    const withAmendment = [
      ...PLAN_STEPS,
      { kind: "milestone", label: "CR-1", amountMinor: 600_000, taskId: T_CR, changeRequestId: CR },
    ]
    const ok = await billingPlanSet(h.ctx, {
      projectId: PROJECT,
      quoteDocumentId: QUOTE,
      steps: withAmendment,
    })
    expect(ok).toMatchObject({ status: "completed", milestonesMinor: 7_000_000 })
    expect(amendmentSteps(h).map((s) => s.change_request_ref)).toEqual([CR])
    // An amendment the client did not accept does not raise the total.
    const unknown = await billingPlanSet(h.ctx, {
      projectId: PROJECT,
      quoteDocumentId: QUOTE,
      steps: [
        ...PLAN_STEPS,
        {
          kind: "milestone",
          label: "CR-9",
          amountMinor: 600_000,
          taskId: T_CR2,
          changeRequestId: CR2,
        },
      ],
    })
    expect(unknown).toMatchObject({ status: "error", error: { code: "amendment_not_accepted" } })
    // Nor at another amount than the one accepted.
    const changed = await billingPlanSet(h.ctx, {
      projectId: PROJECT,
      quoteDocumentId: QUOTE,
      steps: [...PLAN_STEPS, { ...withAmendment[5], amountMinor: 700_000 }],
    })
    expect(changed).toMatchObject({
      status: "error",
      error: { code: "amendment_amount_mismatch" },
    })
    // The extra milestone without its change request is over the quote's total.
    const bare = await billingPlanSet(h.ctx, {
      projectId: PROJECT,
      quoteDocumentId: QUOTE,
      steps: [
        ...PLAN_STEPS,
        { kind: "milestone", label: "CR-1", amountMinor: 600_000, taskId: T_CR },
      ],
    })
    expect(bare).toMatchObject({ status: "error", error: { code: "plan_total_mismatch" } })
  })

  test("the step tool is hidden from the model and reached only as a cross-app call", () => {
    const tool = (manifest.tools as Record<string, Row>).billing_step_add
    expect(tool).toMatchObject({ agentVisible: false, trustBoundary: "internal" })
    expect(tool?.searchKeywords).toBeUndefined()
  })
})
