// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Hours of a retainer month worked after its invoice bill on a later one as that month's: its
// included hours first, then the overage, and never an hour twice. Whatever the order the hours are
// told in, the overage of all the invoices together is the overage of the hours worked.
import { describe, expect, test } from "bun:test"
import "./mutations"
import { cardMinutes, lateItems, lateOnOtherCard, retainerPlan } from "./mutations/retainer"
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
    waived = false,
  ) =>
    retainerPlan({ db: h.db } as never, s(), {
      projectId,
      period: { from: `${month}-01`, to: `${month}-28` },
      usedMinutes,
      waived,
      late,
    })
  /** Invoice a month: its document stands, with the figures it was priced on. */
  const invoice = async (
    month: string,
    usedMinutes: number,
    late: Array<{ month: string; minutes: number }> = [],
    doc: Row = {},
    waived = false,
  ) => {
    const p = await plan(month, usedMinutes, late, waived)
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
  /** The hours above a month that a waiver left unbilled. */
  const waivedOf = (p: Awaited<ReturnType<typeof plan>>) =>
    p.fig.waivedMinutes + p.late.reduce((a, l) => a + (l.waived_minutes ?? 0), 0)
  return { h, plan, invoice, overage, waivedOf }
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

  test("are billed at the rate, the hours and the VAT of the month they were worked in", async () => {
    const r = retainer({
      retainer_terms: [
        {
          from: "2026-11",
          retainer_minutes: 60 * H,
          retainer_overage_rate_minor: "15000",
          lines: [{ description: "Fee", qty: 1, unit_price_minor: 600_000, vat_bp: 1000 }],
        },
      ],
    })
    await r.invoice("2026-10", 41 * H)
    const p = await r.plan("2026-11", 61 * H, [{ month: "2026-10", minutes: 2 * H }])
    expect(
      p.items.slice(1).map((i) => [Number(i.quantity), i.unit_price_minor, i.tax_rate_bp_override]),
    ).toEqual([
      [1, 15_000n, 1000],
      [2, 12_000n, 2000],
    ])
    // Of a month with no invoice, at its own terms too.
    const alone = await r.plan("2026-12", 0, [{ month: "2026-11", minutes: 61 * H }])
    expect(alone.late[0]).toMatchObject({ overage_minutes: 60, rate: 15_000n, vat: 1000 })
  })

  test("of another schedule's month are that schedule's, and a month no schedule holds is named, never billed at 0", async () => {
    const r = retainer()
    await r.invoice("2026-10", 47 * H)
    const old = String(r.h.stored().id)
    await r.h.db.update("recurring_schedules", old, {
      status: "ended",
      retainer_terms: [{ from: "2026-11", off: true, retainer_minutes: 0, lines: [] }],
    })
    const next: Row = {
      ...r.h.stored(),
      id: "7a1d2c3e-0000-4000-8000-0000000000f2",
      status: "active",
      retainer_terms: null,
      retainer_from: "2026-11",
      retainer_minutes: 100 * H,
      retainer_overage_rate_minor: 15_000,
    }
    await r.h.db.insert("recurring_schedules", next)
    const projectId = String(next.retainer_project_id)
    const plan = (late: Array<{ month: string; minutes: number }>) =>
      retainerPlan({ db: r.h.db } as never, next, {
        projectId,
        period: { from: "2026-11-01", to: "2026-11-30" },
        usedMinutes: 0,
        waived: false,
        late,
      })
    const p = await plan([{ month: "2026-10", minutes: 18 * H }])
    expect(p.late).toMatchObject([
      { month: "2026-10", overage_minutes: 18 * H, rate: 12_000n, scheduleId: old },
    ])
    expect(p.unknown).toEqual([])
    const none = await plan([{ month: "2025-10", minutes: 60 }])
    expect(none.unknown).toEqual(["2025-10"])
    expect(none.late).toEqual([])
  })

  test("a document that only bills later hours is not its month's invoice", async () => {
    const r = retainer()
    await r.invoice("2026-10", 47 * H)
    const other = await lateOnOtherCard({ db: r.h.db } as never, {
      projectId: String(r.h.stored().retainer_project_id),
      before: "2026-11",
      late: [{ month: "2026-10", minutes: 2 * H }],
    })
    expect(other.late).toMatchObject([{ month: "2026-10", overage_minutes: 2 * H }])
    expect(other.refs).toMatchObject({ month: "2026-11", late_only: true, used_minutes: 0 })
    expect(lateItems(other.late, 3).map((i) => [i.position, Number(i.quantity)])).toEqual([[4, 2]])
    await r.h.db.insert("documents", {
      type: "invoice",
      status: "issued",
      billing_project_id: String(r.h.stored().retainer_project_id),
      external_ref: "reconcile:x:1",
      external_refs: { retainer: other.refs },
      grand_total_minor: "24000",
    })
    // November is still whole for its own hours told later, and October's two are counted.
    const p = await r.plan("2026-12", 0, [
      { month: "2026-10", minutes: H },
      { month: "2026-11", minutes: 41 * H },
    ])
    expect(p.late.map((l) => [l.month, l.overage_minutes])).toEqual([
      ["2026-10", H],
      ["2026-11", H],
    ])
  })

  test("are found however many documents the project has", async () => {
    const r = retainer()
    await r.invoice("2026-10", 40 * H)
    for (let i = 0; i < 450; i++)
      await r.h.db.insert("documents", {
        id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
        type: "invoice",
        status: "issued",
        billing_project_id: String(r.h.stored().retainer_project_id),
        grand_total_minor: "1",
      })
    const p = await r.plan("2026-11", 0, [{ month: "2026-10", minutes: H }])
    expect(p.late[0]?.overage_minutes).toBe(H)
  })

  test("counted by a later invoice are not free again on the month's own, made again", async () => {
    const r = retainer({ retainer_rollover: "next" })
    await r.invoice("2026-11", 0, [{ month: "2026-10", minutes: 15 * H }])
    const p = await r.plan("2026-10", 35 * H)
    expect(p.fig.overageMinutes).toBe(10 * H)
  })

  test("waived leave no line, are not billed later, and are kept as waived", async () => {
    const r = retainer()
    await r.invoice("2026-10", 41 * H)
    const p = await r.invoice("2026-11", 0, [{ month: "2026-10", minutes: 5 * H }], {}, true)
    expect(p.late).toMatchObject([{ minutes: 5 * H, overage_minutes: 0, waived_minutes: 5 * H }])
    expect(p.items.some((i) => String(i.external_id).startsWith("retainer_late:"))).toBe(false)
    expect(p.refs.late).toEqual([
      { month: "2026-10", minutes: 5 * H, overage_minutes: 0, waived_minutes: 5 * H },
    ])
    expect((await r.plan("2026-12", 0, [{ month: "2026-10", minutes: H }])).late).toMatchObject([
      { overage_minutes: H },
    ])
  })

  test("random months with waivers: what is billed and what is waived together stay in the same bounds", async () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const rand = seeded(seed + 70_000)
      const int = (n: number) => Math.floor(rand() * n)
      const r = retainer({ retainer_rollover: "next" })
      const months = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]
      const total = new Map<string, number>()
      let settled = 0
      for (const [i, m] of months.entries()) {
        const used = int(60) * H
        total.set(m, used)
        const late: Array<{ month: string; minutes: number }> = []
        for (const e of months.slice(0, i)) {
          if (rand() < 0.4) {
            const minutes = int(20) * H
            if (minutes > 0) late.push({ month: e, minutes })
            total.set(e, (total.get(e) ?? 0) + minutes)
          }
        }
        const p = await r.invoice(m, used, late, {}, rand() < 0.5)
        settled += r.overage(p) + r.waivedOf(p)
      }
      const of = (m: string) => total.get(m) ?? 0
      let byRule = 0
      let least = 0
      let left = 0
      for (const m of months) {
        const prev = total.get(previousMonth(m))
        const rolled = prev !== undefined ? Math.max(0, 2400 - prev) : 0
        byRule += Math.max(0, of(m) - 2400 - rolled)
        const afterRolled = Math.max(0, of(m) - left)
        least += Math.max(0, afterRolled - 2400)
        left = Math.max(0, 2400 - afterRolled)
      }
      const said = `seed ${seed}: ${settled} settled, ${least} to ${byRule}`
      expect(settled, said).toBeGreaterThanOrEqual(least)
      expect(settled, said).toBeLessThanOrEqual(byRule)
    }
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
