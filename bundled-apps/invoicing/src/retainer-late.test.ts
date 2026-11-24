// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Hours of a retainer month worked after its invoice bill on a later one as that month's: its
// included hours first, then the overage, and never an hour twice. Whatever the order the hours are
// told in, the overage of all the invoices together is the overage of the hours worked.
import { describe, expect, test } from "bun:test"
import "./mutations"
import { cardMinutes, retainerPlan } from "./mutations/retainer"
import { previousMonth, retainerDocumentRef } from "./recurring/retainer"
import { harness, seeded } from "./retainer-terms.testkit"

type Row = Record<string, unknown>
const H = 60

function retainer(over: Row = {}) {
  const h = harness(over)
  const s = () => h.stored()
  const projectId = String(s().retainer_project_id)
  const plan = (
    month: string,
    usedMinutes: number,
    late: Array<{ month: string; minutes: number }> = [],
  ) =>
    retainerPlan({ db: h.db } as never, s(), {
      projectId,
      period: { from: `${month}-01`, to: `${month}-28` },
      usedMinutes,
      waived: false,
      late,
    })
  /** Invoice a month: its document stands, with the figures it was priced on. */
  const invoice = async (
    month: string,
    usedMinutes: number,
    late: Array<{ month: string; minutes: number }> = [],
    doc: Row = {},
  ) => {
    const p = await plan(month, usedMinutes, late)
    await h.db.insert("documents", {
      type: "invoice",
      status: "issued",
      billing_project_id: projectId,
      external_ref: retainerDocumentRef(String(s().id), month),
      external_refs: { retainer: p.refs },
      grand_total_minor: "100000",
      ...doc,
    })
    return p
  }
  const overage = (p: Awaited<ReturnType<typeof plan>>) =>
    p.fig.overageMinutes + p.late.reduce((a, l) => a + l.overage_minutes, 0)
  return { h, plan, invoice, overage }
}

describe("hours of a month worked after its invoice", () => {
  test("fill the month's included hours, then bill at that month's rate and VAT, on their own line", async () => {
    const r = retainer()
    await r.invoice("2026-10", 30 * H)
    const p = await r.plan("2026-11", 10 * H, [{ month: "2026-10", minutes: 12 * H }])
    expect(p.late).toMatchObject([{ month: "2026-10", minutes: 720, overage_minutes: 120 }])
    const line = p.items.find((i) => String(i.external_id).startsWith("retainer_late:"))
    expect(line).toMatchObject({ unit_price_minor: 12_000n, tax_rate_bp_override: 2000 })
    expect(Number(line?.quantity)).toBe(2)
    expect(p.refs.late).toEqual([{ month: "2026-10", minutes: 720, overage_minutes: 120 }])
    expect(p.fig.usedMinutes).toBe(10 * H)
  })

  test("already counted on an earlier invoice are not free a second time", async () => {
    const r = retainer()
    await r.invoice("2026-10", 30 * H)
    await r.invoice("2026-11", 0, [{ month: "2026-10", minutes: 9 * H }])
    const p = await r.plan("2026-12", 0, [{ month: "2026-10", minutes: 4 * H }])
    expect(p.late[0]?.overage_minutes).toBe(3 * H)
  })

  test("of an invoice credited in full, or cancelled, do not count", async () => {
    const r = retainer()
    await r.invoice("2026-10", 30 * H)
    await r.invoice("2026-11", 0, [{ month: "2026-10", minutes: 9 * H }], { status: "cancelled" })
    const p = await r.plan("2026-12", 0, [{ month: "2026-10", minutes: 9 * H }])
    expect(p.late[0]?.overage_minutes).toBe(0)
  })

  test("of an invoice credited in full by a credit note are free again", async () => {
    const r = retainer()
    await r.invoice("2026-10", 30 * H)
    await r.invoice("2026-11", 0, [{ month: "2026-10", minutes: 9 * H }], { id: "nov-doc" })
    await r.h.db.insert("documents", {
      type: "credit_note",
      status: "issued",
      original_document_id: "nov-doc",
      grand_total_minor: "-100000",
      lifecycle_log: [],
    })
    const p = await r.plan("2026-12", 0, [{ month: "2026-10", minutes: 9 * H }])
    expect(p.late[0]?.overage_minutes).toBe(0)
  })

  test("of a month to come, or of the card's own month, are not late hours", async () => {
    const r = retainer()
    const p = await r.plan("2026-11", 0, [
      { month: "2026-11", minutes: 60 },
      { month: "2026-12", minutes: 60 },
    ])
    expect(p.late).toEqual([])
  })

  test("a card's minutes are told apart by the month they were worked in", () => {
    expect(
      cardMinutes([
        { billMinutes: 60 },
        { billMinutes: 30, workMonth: "2026-10" },
        { billMinutes: 15, workMonth: "2026-09" },
        { billMinutes: 10, workMonth: "2026-10" },
        { billMinutes: 0, workMonth: "2026-08" },
        { billMinutes: -5 },
        { billMinutes: 5, workMonth: "nonsense" },
      ]),
    ).toEqual({
      used: 65,
      late: [
        { month: "2026-09", minutes: 15 },
        { month: "2026-10", minutes: 40 },
      ],
    })
  })

  test("random months, hours told late in any order: no hour is included twice and none bills above its month's rule", async () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const rand = seeded(seed)
      const int = (n: number) => Math.floor(rand() * n)
      const rollover = rand() < 0.6 ? "next" : "none"
      const r = retainer({ retainer_rollover: rollover })
      const months = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]
      const total = new Map<string, number>()
      let billed = 0
      for (const [i, m] of months.entries()) {
        const used = int(60) * H
        total.set(m, used)
        const late: Array<{ month: string; minutes: number }> = []
        // Hours of any earlier month, told on this card.
        for (const e of months.slice(0, i)) {
          if (rand() < 0.4) {
            const minutes = int(20) * H
            if (minutes > 0) late.push({ month: e, minutes })
            total.set(e, (total.get(e) ?? 0) + minutes)
          }
        }
        billed += r.overage(await r.invoice(m, used, late))
      }
      const of = (m: string) => total.get(m) ?? 0
      // Every hour known from the start: what the rule of each month gives.
      let byRule = 0
      // The least that can be billed: each month's 40 hours used once, in it or (rolled) the next.
      let least = 0
      let left = 0
      for (const m of months) {
        const prev = total.get(previousMonth(m))
        const rolled = rollover === "next" && prev !== undefined ? Math.max(0, 2400 - prev) : 0
        byRule += Math.max(0, of(m) - 2400 - rolled)
        const afterRolled = Math.max(0, of(m) - (rollover === "next" ? left : 0))
        least += Math.max(0, afterRolled - 2400)
        left = Math.max(0, 2400 - afterRolled)
      }
      const said = `seed ${seed}, rollover ${rollover}: ${billed} billed, ${least} to ${byRule}`
      expect(billed, said).toBeGreaterThanOrEqual(least)
      expect(billed, said).toBeLessThanOrEqual(byRule)
      if (rollover === "none") expect(billed, said).toBe(byRule)
    }
  })
})
