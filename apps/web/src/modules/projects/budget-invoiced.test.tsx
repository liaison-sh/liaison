// SPDX-License-Identifier: FSL-1.1-ALv2
// The budget panel's money from issued invoices: what is invoiced and, for a fixed price, what is
// left to invoice, read from budget_get; when it cannot be shown, the panel says why.
import { render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BudgetPanel } from "~/modules/projects/BudgetPanel"
import type { BudgetData, BudgetState } from "~/modules/projects/time-budgets"

const scopes = vi.hoisted(() => ({ granted: new Set<string>() }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (s: string) => scopes.granted.has(s),
}))

const dockMock = vi.hoisted(() => ({ prefill: vi.fn(async (_text: string) => "dm-1") }))
vi.mock("~/modules/shell/dock-prefill", () => ({ dock: dockMock }))

const data = (over: Partial<BudgetData> = {}): BudgetData => ({
  projectId: "p1",
  projectName: "Maison Delorme",
  line: "346 h real against a 420 h timebox, 74 h left. Partial: real time entered on 41 of 46 tasks.",
  timebox: 25200,
  real: 20760,
  left: 4440,
  partial: true,
  coverage: { withEntries: 41, total: 46 },
  money: { price: 64000, currency: "EUR" },
  milestones: [
    { id: "m1", name: "Design", state: "done", plannedMinutes: 3120, realMinutes: 3000 },
  ],
  notInNumbers: [{ text: "2 h entered on archived tasks is not counted." }],
  datedHours: false,
  ...over,
})

const ready = (d: BudgetData): BudgetState => ({ status: "ready", data: d })

const panel = (state: BudgetState | undefined, extra: { api?: never } = {}) =>
  render(() => (
    <BudgetPanel
      api={(extra.api ?? ({ post: vi.fn(async () => ({})) } as never)) as never}
      projectId="p1"
      state={state}
      rail
      archived={false}
      onClose={() => {}}
      onPlanChanged={() => {}}
      onOff={() => {}}
    />
  ))

beforeEach(() => {
  scopes.granted = new Set(["projects:projects:write"])
})

const openTab = vi.hoisted(() => vi.fn())
vi.mock("~/modules/shell/tab-store", () => ({ openTab }))

describe("BudgetPanel money from invoices", () => {
  it("a fixed price shows what its issued invoices bill and what is left to invoice", () => {
    scopes.granted = new Set(["projects:projects:write", "projects:money:read"])
    panel(
      ready(
        data({ money: { price: 64000, currency: "EUR", invoiced: 44800, leftToInvoice: 19200 } }),
      ),
    )
    expect(screen.getByTestId("budget-panel.invoiced").textContent).toMatch(/44.800/)
    expect(screen.getByTestId("budget-panel.left-to-invoice").textContent).toMatch(/19.200/)
  })

  it("a rate shows what is invoiced and no left to invoice", () => {
    scopes.granted = new Set(["projects:projects:write", "projects:money:read"])
    panel(ready(data({ money: { rate: 930, per: "day", currency: "EUR", invoiced: 3598 } })))
    expect(screen.getByTestId("budget-panel.invoiced").textContent).toMatch(/3.598/)
    expect(screen.queryByTestId("budget-panel.left-to-invoice")).toBeNull()
  })

  it("with no issued invoice the panel says why nothing invoiced is shown", () => {
    scopes.granted = new Set(["projects:projects:write", "projects:money:read"])
    const [why] = [
      "No issued invoice is linked to this project, so what is invoiced and left to invoice are not shown.",
    ]
    panel(ready(data({ money: { price: 64000, currency: "EUR", invoicedUnavailable: why } })))
    expect(screen.queryByTestId("budget-panel.invoiced")).toBeNull()
    expect(screen.getByTestId("budget-panel.invoiced-note").textContent).toBe(why)
  })

  it("a refusal shows its message", () => {
    scopes.granted = new Set(["projects:projects:write", "projects:money:read"])
    const [message] = ["This project's price has no currency."]
    panel(
      ready(data({ money: { price: 64000, currency: null, invoicedUnavailable: { message } } })),
    )
    expect(screen.getByTestId("budget-panel.invoiced-note").textContent).toBe(message)
  })
})
