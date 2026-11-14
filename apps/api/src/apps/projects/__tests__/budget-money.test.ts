// SPDX-License-Identifier: FSL-1.1-ALv2
// budget_get's money half: what is invoiced, and what is left only where a price exists.
import { describe, expect, it } from "bun:test"
import { budgetGet } from "~/apps/projects/handlers"

function ctxWith(money: Record<string, unknown>, totals: Array<{ k: string; text: string }>) {
  return {
    projects_budgetGet: async () => JSON.stringify({ projectId: "p1", money, totals: [...totals] }),
    executeTool: async () =>
      JSON.stringify({
        status: "completed",
        result: { invoicedExcl: 186000, currency: "EUR", documents: [{ id: "d1" }] },
      }),
  } as never
}

describe("budget_get money half", () => {
  it("a day-rate project shows what is invoiced and never a left to invoice", async () => {
    const out = (await budgetGet(
      { projectId: "p1" },
      ctxWith({ rate: 930, per: "day", currency: "EUR" }, [{ k: "Rate", text: "€930.00 a day" }]),
    )) as { money: Record<string, unknown>; totals: Array<{ k: string; text: string }> }
    expect(out.money.invoiced).toBe(1860)
    expect("leftToInvoice" in out.money).toBe(false)
    expect(out.totals.map((t) => t.k)).toEqual(["Rate", "Invoiced"])
    expect(JSON.stringify(out)).not.toContain("NaN")
  })

  it("a fixed-price project still shows invoiced and left to invoice", async () => {
    const out = (await budgetGet(
      { projectId: "p1" },
      ctxWith({ price: 5000, currency: "EUR" }, [{ k: "Price", text: "€5,000.00" }]),
    )) as { money: Record<string, unknown>; totals: Array<{ k: string; text: string }> }
    expect(out.money.invoiced).toBe(1860)
    expect(out.money.leftToInvoice).toBe(3140)
    expect(out.totals.map((t) => t.k)).toEqual(["Price", "Invoiced", "Left to invoice"])
  })
})
