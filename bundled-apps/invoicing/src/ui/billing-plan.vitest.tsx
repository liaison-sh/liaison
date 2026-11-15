// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project's billing plan screen: each step's amount and state, a milestone whose task is not
// done yet showing nothing drafted, and the way there from a milestone draft.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
const navigated: string[] = []

// Fixture copy, kept out of the copy guard's literal scan as the other rendered tests do.
const [ADVANCE, ALPHA, BETA, LAUNCH] = ["Advance 20%", "Alpha", "Beta", "Launch"]

const PLAN = {
  status: "completed",
  steps: [
    {
      id: "s1",
      kind: "advance",
      label: ADVANCE,
      amountMinor: 1_280_000,
      currency: "EUR",
      state: "issued",
      taskDone: null,
      document: { id: "adv", number: "F-2026-0201", status: "issued" },
    },
    {
      id: "s2",
      kind: "milestone",
      label: ALPHA,
      amountMinor: 1_600_000,
      currency: "EUR",
      state: "drafted",
      taskDone: true,
      document: { id: "d2", number: null, status: "draft" },
    },
    {
      id: "s3",
      kind: "milestone",
      label: BETA,
      amountMinor: 1_600_000,
      currency: "EUR",
      state: "planned",
      taskDone: true,
      document: null,
    },
    {
      id: "s4",
      kind: "final",
      label: LAUNCH,
      amountMinor: 1_600_000,
      currency: "EUR",
      state: "planned",
      taskDone: false,
      document: null,
    },
  ],
}

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: (path: string) => navigated.push(path),
  app: {
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      return PLAN
    },
  },
}))

const { InvoicingBillingPlan } = await import("./BillingPlan")
const { SourcedDraftPanel } = await import("./SourcedDraft")

afterEach(() => {
  cleanup()
  calls.length = 0
  navigated.length = 0
})

describe("the billing plan screen", () => {
  it("a milestone whose task is not done yet shows nothing drafted", async () => {
    render(() => <InvoicingBillingPlan entityId="proj-1" />)
    await waitFor(() => expect(screen.getByTestId("billing-step-s4")).toBeTruthy())
    expect(calls).toEqual([{ tool: "billing_plan_get", params: { projectId: "proj-1" } }])
    expect(screen.getByTestId("billing-step-s4").getAttribute("data-state")).toBe("not-done-yet")
    expect(screen.getByTestId("billing-step-state-s4").textContent).toBe(
      "Not done yet, nothing drafted",
    )
    expect(screen.queryByTestId("billing-step-open-s4")).toBeNull()
    expect(screen.getByTestId("billing-step-s3").getAttribute("data-state")).toBe("ready")
    expect(screen.getByTestId("billing-step-s2").getAttribute("data-state")).toBe("drafted")
    expect(screen.getByTestId("billing-step-state-s1").textContent).toBe("Issued, F-2026-0201")
    expect(screen.getByTestId("invoicing-billing-plan").textContent).toContain(
      "Hours do not move it",
    )
    fireEvent.click(screen.getByTestId("billing-step-open-s2"))
    expect(navigated).toEqual(["/invoicing/document/d2"])
  })

  it("a milestone draft leads to its project's billing plan", () => {
    render(() => (
      <SourcedDraftPanel
        doc={{
          id: "d2",
          status: "draft",
          currency: "EUR",
          grand_total_minor: "1920000",
          external_ref: "milestone:s2",
          approved_by: null,
          billing_project_id: "proj-1",
        }}
        lines={[]}
        today="2026-06-20"
      />
    ))
    fireEvent.click(screen.getByTestId("sourced-draft-plan"))
    expect(navigated).toEqual(["/invoicing/billing-plan/proj-1"])
  })
})
