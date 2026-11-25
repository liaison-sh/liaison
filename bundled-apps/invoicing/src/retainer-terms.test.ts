// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A retainer's terms by month. A change of fee, lines, overage rate, hours or rollover applies from
// the next month: the running month and any earlier month not invoiced yet keep theirs, with a
// signed renewal or without one. The list and the editor show the terms of the next month, so a
// save from them never sends a replaced fee back.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { harness as runHarness, schedule as runSchedule } from "./__fixtures__/recurring-draft"
import { activityRead } from "./activity"
import { customerHistory } from "./customer-history"
import { invoiceIssue } from "./mutations"
import { retainerPlan } from "./mutations/retainer"
import { recurringDraftJob } from "./recurring/draft-job"
import { isRetainerMonth, termsForMonth } from "./recurring/retainer"
import { writeSchedulePatch } from "./recurring/run-card"
import { checkScheduleUpdate, recurringScheduleUpdate, retainerTermsRenew } from "./recurring/tools"
import {
  AGREEMENT,
  AGREEMENT_2,
  H,
  harness,
  line,
  on,
  PROJECT,
  RENEWAL,
  type Row,
  SCHEDULE,
  schedule,
  seeded,
} from "./retainer-terms.testkit"
import { previewTotals } from "./tools/preview-totals"
import { changedParams, draftFromRow, renewalText } from "./ui/ScheduleEditor"

const CONTACT = "7a1d2c3e-0000-4000-8000-0000000000c1"
const OLD = { fee: [450_000], rate: 12_000, hours: 40 }
const SIGNED = { fee: [495_000], rate: 12_500, hours: 44 }

afterEach(() => setSystemTime())

describe("a change of a retainer's terms applies from the next month", () => {
  test("the module loads with the issue path beside it", () => {
    expect(typeof invoiceIssue).toBe("function")
  })

  test("with no renewal: the running month and an undrafted past month keep fee, rate and hours", async () => {
    on(2026, 12, 15)
    const h = harness()
    const r = await h.update({
      lines: [line(480_000), line(20_000, "Hosting")],
      retainer_overage_rate_minor: 13_000,
      retainer_minutes: 45 * H,
    })
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(await h.month("2027-01")).toEqual({ fee: [480_000, 20_000], rate: 13_000, hours: 45 })
    expect(r.message).toContain("2027-01")
    expect(r.message).toContain("earlier months not invoiced yet keep")
  })

  test("a rate alone: only the rate changes, from the next month, and the answer says so", async () => {
    on(2026, 12, 15)
    const h = harness()
    const r = await h.update({ retainer_overage_rate_minor: 13_000 })
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(await h.month("2027-01")).toEqual({ ...OLD, rate: 13_000 })
    expect(r.message).toContain("apply from 2027-01")
  })

  test("a fee alone: the answer names the first month too", async () => {
    on(2026, 12, 15)
    const h = harness()
    const r = await h.update({ lines: [line(470_000)] })
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(await h.month("2027-01")).toEqual({ ...OLD, fee: [470_000] })
    expect(r.message).toContain("apply from 2027-01")
    // No month-end run issues a retainer, so no next invoice day is promised.
    expect(r.message).not.toContain("Its next invoice issues on")
  })

  test("after a signed renewal in force: its running month keeps the signed terms", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    on(2026, 12, 15)
    await h.update({ lines: [line(500_000)], retainer_overage_rate_minor: 13_000 })
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual(SIGNED)
    expect(await h.month("2027-01")).toEqual({ fee: [500_000], rate: 13_000, hours: 44 })
  })

  test("a change each month: every month not invoiced yet keeps its own", async () => {
    const h = harness()
    on(2026, 11, 10)
    await h.update({ lines: [line(460_000)] })
    on(2026, 12, 10)
    await h.update({ retainer_overage_rate_minor: 13_000 })
    on(2027, 1, 10)
    await h.update({ lines: [line(470_000)] })
    // Twice in the same month: the last one counts.
    await h.update({ lines: [line(475_000)] })
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual({ ...OLD, fee: [460_000] })
    expect(await h.month("2027-01")).toEqual({ ...OLD, fee: [460_000], rate: 13_000 })
    expect(await h.month("2027-02")).toEqual({ ...OLD, fee: [475_000], rate: 13_000 })
  })

  test("a renewal that starts later keeps its own first month, and the answer names it", async () => {
    on(2026, 12, 2)
    const h = harness()
    await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2027-02-01" })
    const r = await h.update({ lines: [line(470_000)] })
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(await h.month("2027-01")).toEqual({ ...OLD, fee: [470_000] })
    expect(await h.month("2027-02")).toEqual(SIGNED)
    expect(r.message).toContain("AG-2026-017")
    expect(r.message).toContain("2027-02")
  })

  test("a second renewal keeps the months of the first and those before it", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    on(2026, 12, 15)
    const second = await retainerTermsRenew(h.ctx, {
      ...RENEWAL,
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2026-021",
      startsOn: "2027-01-01",
      minutes: 50 * H,
      feeMinor: "560000",
      overageRateMinor: null,
    })
    expect(second).toMatchObject({ status: "completed", from: "2027-01" })
    expect((second as { message: string }).message).toContain("(2026-12: 44 h and 4950.00")
    // November is still undrafted: it keeps the first terms.
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual(SIGNED)
    expect(await h.month("2027-01")).toEqual({ fee: [560_000], rate: 12_500, hours: 50 })
    // The first agreement's retry changes nothing.
    expect(await retainerTermsRenew(h.ctx, RENEWAL)).toMatchObject({ unchanged: true })
    expect(await h.month("2027-01")).toEqual({ fee: [560_000], rate: 12_500, hours: 50 })
  })

  test("a change before a renewal's first month keeps the renewal's name, and its agreement's retry changes nothing", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    await h.update({ retainer_minutes: 45 * H })
    expect(renewalText(await h.listed())).toEqual(["Renewed by AG-2026-017 from December 2026"])
    expect(await retainerTermsRenew(h.ctx, RENEWAL)).toMatchObject({ unchanged: true })
    expect(await h.month("2026-12")).toEqual({ ...SIGNED, hours: 45 })
  })

  test("a renewal signed for an earlier month replaces one waiting, and takes nothing from it", async () => {
    on(2026, 12, 2)
    const h = harness({ retainer_rollover: "next" })
    await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2027-02-01" })
    await h.update({ retainer_overage_rate_minor: 13_000, retainer_minutes: 42 * H })
    const r = await retainerTermsRenew(h.ctx, {
      ...RENEWAL,
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2026-021",
      startsOn: "2027-01-01",
      minutes: 50 * H,
      feeMinor: "560000",
      overageRateMinor: null,
    })
    // The months before are the running month's terms, not the change it replaces.
    expect((r as { message: string }).message).toContain("(2026-12: 40 h and 4500.00")
    // Its rate is the schedule's own, as changed for that month; the waiting renewal's is not read.
    const signed = { fee: [560_000], rate: 13_000, hours: 50 }
    expect(await h.month("2027-01")).toEqual(signed)
    expect(await h.month("2027-02")).toEqual(signed)
    expect(termsForMonth(h.stored(), "2027-02").retainer_rollover).toBe("next")
  })

  test("a renewal of the same month as one waiting replaces it, rate included", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    await retainerTermsRenew(h.ctx, {
      ...RENEWAL,
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2026-021",
      overageRateMinor: null,
    })
    expect((await h.month("2026-12")).rate).toBe(12_000)
  })

  test("a retainer again after a time as a plain schedule starts from no old terms", async () => {
    on(2026, 12, 15)
    const h = harness({
      retainer_minutes: null,
      retainer_project_id: null,
      retainer_renewal: {
        from: "2026-06",
        agreement_id: AGREEMENT,
        agreement_number: "AG-2026-017",
        retainer_minutes: 44 * H,
        retainer_overage_rate_minor: "12500",
        lines: [line(495_000)],
      },
    })
    await h.update({
      retainer_project_id: PROJECT,
      retainer_minutes: 40 * H,
      retainer_overage_rate_minor: 12_000,
    })
    expect(await h.month("2027-01")).toEqual(OLD)
  })

  test("rollover changed during a month is the next month's too", async () => {
    on(2026, 12, 15)
    const h = harness()
    for (const m of ["2026-11", "2026-12"])
      await h.db.insert("documents", {
        id: `doc-${m}`,
        external_ref: `retainer:${SCHEDULE}:${m}`,
        status: "issued",
        external_refs: { retainer: { month: m, included_minutes: 40 * H, used_minutes: 30 * H } },
      })
    await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2027-02-01" })
    await h.update({ retainer_rollover: "next" })
    const rolledIn = async (m: string) =>
      (
        await retainerPlan({ db: h.db } as never, h.stored(), {
          projectId: PROJECT,
          period: { from: `${m}-01`, to: `${m}-28` },
          usedMinutes: 0,
          waived: false,
        })
      ).fig.rolloverInMinutes
    expect(await rolledIn("2026-12")).toBe(0)
    expect(await rolledIn("2027-01")).toBe(10 * H)
    // A renewal that starts later sets no rollover, so it does not end it.
    expect(termsForMonth(h.stored(), "2027-02").retainer_rollover).toBe("next")
  })

  test("a change that changes nothing adds no terms and claims none", async () => {
    on(2026, 12, 15)
    const h = harness()
    const r = await h.update({ retainer_minutes: 40 * H, lines: [line(450_000)] })
    expect(h.stored().retainer_terms ?? null).toBeNull()
    expect(r.message).not.toContain("apply from")
  })

  test("a schedule not started yet takes its terms at once, and says it has not started", async () => {
    on(2026, 12, 15)
    const h = harness({ status: "draft" })
    const r = await h.update({ lines: [line(480_000)], retainer_minutes: 45 * H })
    expect(await h.month("2026-12")).toEqual({ fee: [480_000], rate: 12_000, hours: 45 })
    expect(r.message).toContain("has not started")
    expect(r.message).not.toContain("earlier months")
  })

  test("a schedule made a retainer keeps its lines for the month its run still bills", async () => {
    on(2026, 12, 15)
    const h = harness({
      retainer_project_id: null,
      retainer_minutes: null,
      retainer_overage_rate_minor: null,
      retainer_from: null,
      lines: [line(300_000, "Maintenance")],
    })
    await h.update({
      retainer_project_id: PROJECT,
      retainer_minutes: 40 * H,
      retainer_overage_rate_minor: 12_000,
      lines: [line(450_000)],
    })
    // The run reads the schedule's own lines for December; the retainer's months read January's.
    expect((h.stored().lines as Row[])[0]?.unit_price_minor).toBe(300_000)
    expect(await h.month("2027-01")).toEqual(OLD)
  })

  test("a run row's change from now on never reaches a retainer's running month", async () => {
    // A retainer from December whose November row, still on the run, was changed for good.
    on(2026, 12, 2)
    const h = harness({ retainer_from: "2026-12" })
    const item = {
      id: "item-1",
      schedule_id: SCHEDULE,
      period_key: "2026-11",
      schedule_patch: { applies: "from_now_on", lines: [line(430_000)] },
    }
    await h.db.insert("recurring_run_items", item)
    expect(await writeSchedulePatch(h.ctx as never, item)).toBe(SCHEDULE)
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(await h.month("2027-01")).toEqual({ ...OLD, fee: [430_000] })
  })

  test("a run row's change approved in its own month is the next month's", async () => {
    on(2026, 11, 30)
    const h = harness({ retainer_from: "2026-12" })
    const item = {
      id: "item-1",
      schedule_id: SCHEDULE,
      period_key: "2026-11",
      schedule_patch: { applies: "from_now_on", lines: [line(430_000)] },
    }
    await h.db.insert("recurring_run_items", item)
    await writeSchedulePatch(h.ctx as never, item)
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual({ ...OLD, fee: [430_000] })
  })

  test("a run row of a month not begun yet changes the month after it", async () => {
    on(2026, 12, 30)
    const h = harness({ retainer_from: "2027-02" })
    const item = {
      id: "item-1",
      schedule_id: SCHEDULE,
      period_key: "2027-01",
      schedule_patch: { applies: "from_now_on", lines: [line(430_000)] },
    }
    await h.db.insert("recurring_run_items", item)
    await writeSchedulePatch(h.ctx as never, item)
    expect(await h.month("2027-01")).toEqual(OLD)
    expect(await h.month("2027-02")).toEqual({ ...OLD, fee: [430_000] })
  })

  test("a renewed retainer turned back into a plain schedule bills the signed lines, not the old ones", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    on(2026, 12, 15)
    await h.update({ retainer_minutes: null, retainer_project_id: null })
    const run = termsForMonth(h.stored(), "2027-01")
    expect((run.lines as Row[])[0]?.unit_price_minor).toBe(495_000)
    expect(run.retainer_minutes).toBeNull()
    expect(h.stored().retainer_renewal ?? null).toBeNull()
  })
})

describe("rows written before the dated terms bill what they billed", () => {
  const legacy = {
    from: "2026-12",
    agreement_id: AGREEMENT,
    agreement_number: "AG-2026-017",
    retainer_minutes: 44 * H,
    retainer_overage_rate_minor: "12500",
    lines: [line(495_000, "Monthly retainer, 44 h included")],
  }

  test.each([
    ["an object", legacy],
    ["its JSON text", JSON.stringify(legacy)],
  ])("a stored renewal as %s, read and then changed", async (_name, renewal) => {
    on(2026, 12, 15)
    const h = harness({ retainer_renewal: renewal })
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual(SIGNED)
    expect(await h.month("2027-06")).toEqual(SIGNED)
    await h.update({ lines: [line(500_000)] })
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual(SIGNED)
    expect(await h.month("2027-01")).toEqual({ ...SIGNED, fee: [500_000] })
  })

  test("a renewal stored beside dated terms counts by its month", async () => {
    const h = harness({
      retainer_renewal: { ...legacy, from: "2027-03" },
      retainer_terms: [
        {
          from: "2027-01",
          retainer_minutes: 41 * H,
          retainer_overage_rate_minor: "12000",
          lines: [],
        },
      ],
    })
    expect(await h.month("2027-02")).toEqual({ ...OLD, hours: 41 })
    expect(await h.month("2027-03")).toEqual(SIGNED)
  })

  test("a schedule with neither", async () => {
    const h = harness()
    expect(await h.month("2025-01")).toEqual(OLD)
    expect(await h.month("2030-01")).toEqual(OLD)
  })
})

describe("the list and the editor show the terms in force for the next month", () => {
  test("after a signed renewal: the renewed hours, rate and fee, the renewal and its first month", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    const row = await h.listed()
    expect(Number(row.retainer_minutes)).toBe(44 * H)
    expect(Number(row.retainer_overage_rate_minor)).toBe(12_500)
    expect((row.lines as Row[])[0]?.unit_price_minor).toBe(495_000)
    expect(row.retainer_terms_month).toBe("2026-12")
    expect(renewalText(row)).toEqual(["Renewed by AG-2026-017 from December 2026"])
    const d = draftFromRow(SCHEDULE, row)
    expect(d.retainer_hours).toBe(44)
    expect(d.lines[0]?.unit_price_minor).toBe(495_000)
  })

  test("a renewal that starts later is named with its first month, and the next month's terms stay", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2027-02-01" })
    const row = await h.listed()
    expect(Number(row.retainer_minutes)).toBe(40 * H)
    expect(renewalText(row)).toEqual(["Renewed by AG-2026-017 from February 2027"])
  })

  test("a plain change is named with its first month", async () => {
    on(2026, 12, 15)
    const h = harness()
    await h.update({ lines: [line(480_000)] })
    expect(renewalText(await h.listed())).toEqual(["New terms from January 2027"])
  })

  test("correcting one line's text from the editor keeps the signed fee", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    on(2026, 12, 15)
    const before = draftFromRow(SCHEDULE, await h.listed())
    const after = {
      ...before,
      lines: before.lines.map((l) => ({ ...l, description: "Monthly retainer, design" })),
    }
    await h.update(changedParams(before, after) as never)
    expect(await h.month("2026-12")).toEqual(SIGNED)
    expect(await h.month("2027-01")).toEqual(SIGNED)
    expect((termsForMonth(h.stored(), "2027-01").lines as Row[]).map((l) => l.description)).toEqual(
      ["Monthly retainer, design"],
    )
    // The signed agreement is still named, from its own first month.
    expect(renewalText(await h.listed())).toEqual([
      "Renewed by AG-2026-017 from December 2026",
      "New terms from January 2027",
    ])
  })

  test("a page read in an earlier month cannot send that month's fee over a renewal", async () => {
    on(2026, 12, 30)
    const h = harness()
    await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2027-02-01" })
    // Read in December: January's terms, the old fee.
    const before = draftFromRow(SCHEDULE, await h.listed())
    expect(before.lines[0]?.unit_price_minor).toBe(450_000)
    const after = {
      ...before,
      lines: before.lines.map((l) => ({ ...l, description: "Monthly retainer, design" })),
    }
    // Saved in January: the save would be February's terms, which the renewal signed.
    on(2027, 1, 2)
    const r = await recurringScheduleUpdate(h.ctx, {
      id: SCHEDULE,
      expected_version: before.version,
      ...changedParams(before, after),
    } as never)
    expect(r).toMatchObject({ status: "error", error: { code: "schedule_changed" } })
    expect(await h.month("2027-02")).toEqual(SIGNED)
  })

  test("a page read in an earlier month saves when the terms are the same ones", async () => {
    on(2026, 12, 30)
    const h = harness()
    const before = draftFromRow(SCHEDULE, await h.listed())
    const after = { ...before, retainer_hours: 45 }
    on(2027, 1, 2)
    await h.update(changedParams(before, after) as never)
    expect(await h.month("2027-01")).toEqual(OLD)
    expect(await h.month("2027-02")).toEqual({ ...OLD, hours: 45 })
  })

  test("saving the hours the screen shows sends nothing, so nothing reverts", async () => {
    on(2026, 12, 15)
    const h = harness()
    await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2027-01-01" })
    const d = draftFromRow(SCHEDULE, await h.listed())
    expect(changedParams(d, { ...d })).toEqual({})
  })

  test("a plain schedule's row is as stored", async () => {
    on(2026, 12, 15)
    const h = harness({ retainer_minutes: null, retainer_project_id: null })
    const row = await h.listed()
    expect((row.lines as Row[])[0]?.unit_price_minor).toBe(450_000)
    expect(row.retainer_terms_month).toBeUndefined()
    expect(renewalText(row)).toEqual([])
  })

  test("a customer's history prices the next invoice on the terms in force", async () => {
    on(2026, 12, 15)
    const h = harness()
    await h.update({ lines: [line(480_000)] })
    const out = await customerHistory(
      { ...h.ctx, executeTool: undefined } as never,
      { contact_id: "contact-1" } as never,
    )
    expect(out.recurring_schedules[0]?.lines[0]?.unit_price_minor).toBe("480000")
  })

  test("a contact's activity says the fee in force", async () => {
    on(2026, 12, 15)
    const h = harness({
      contact_id: CONTACT,
      created_at: "2026-01-05T09:00:00.000Z",
      retainer_terms: [
        {
          from: "2027-01",
          retainer_minutes: 40 * H,
          retainer_overage_rate_minor: "12000",
          lines: [line(480_000)],
        },
      ],
    })
    const rows = async (t: string) => (t === "recurring_schedules" ? [h.stored()] : [])
    const out = await activityRead({ db: { findMany: rows } } as never, {
      contactIds: [CONTACT],
      before: null,
      limit: 10,
      prefix: "invoicing:",
    })
    expect(JSON.stringify(out)).toContain("4,800.00")
  })

  test("the card's preview says the month's own overage rate", async () => {
    on(2026, 11, 19)
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    const out = (await previewTotals(
      h.ctx as never,
      {
        projectId: PROJECT,
        basis: "retainer",
        periodFrom: "2026-12-01",
        lines: [{ billMinutes: 50 * H }],
      } as never,
    )) as { retainer?: { overageRateMinor: number; feeExclMinor: number } }
    expect(out.retainer).toMatchObject({ overageRateMinor: 12_500, feeExclMinor: 495_000 })
  })
})

describe("what counts as a change of terms, and what a renewal carries", () => {
  const base = { ...line(450_000), line_kind: "service" }
  test.each([
    ["the VAT alone", { ...base, vat_bp: 550 }],
    ["the quantity alone", { ...base, qty: 2 }],
    ["the product alone", { ...base, product_ref: "prod-1" }],
    ["the line's kind alone", { ...base, line_kind: "software" }],
  ])("%s is a change of the next month's line", async (_what, changed) => {
    on(2026, 12, 15)
    const h = harness({ lines: [base] })
    await h.update({ lines: [changed as never] })
    expect(termsForMonth(h.stored(), "2026-12").lines).toMatchObject([base])
    expect(termsForMonth(h.stored(), "2027-01").lines).toMatchObject([changed])
  })

  test("a renewal keeps the rollover in force, and writes the old renewal column away", async () => {
    on(2026, 11, 2)
    const h = harness({
      // As a row written before the dated terms holds a renewal still waiting.
      retainer_renewal: {
        from: "2027-03",
        agreement_id: AGREEMENT,
        agreement_number: "AG-2026-017",
        retainer_minutes: 44 * H,
        retainer_overage_rate_minor: "12500",
        lines: [line(495_000)],
      },
    })
    await h.update({ retainer_rollover: "next" })
    const r = await h.renew({
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2026-021",
      startsOn: "2026-12-01",
      minutes: 50 * H,
      feeMinor: "560000",
    })
    expect(r).toMatchObject({ status: "completed" })
    expect(termsForMonth(h.stored(), "2026-12").retainer_rollover).toBe("next")
    // The newer agreement replaced the waiting one: it never applies beside it.
    expect(h.stored().retainer_renewal).toBeNull()
    for (const m of ["2026-12", "2027-03", "2027-08"])
      expect(await h.month(m)).toMatchObject({ fee: [560_000], hours: 50 })
  })

  test("a renewal carries over a waiting old column's month only when it starts after it", async () => {
    on(2026, 11, 2)
    const h = harness({
      retainer_renewal: {
        from: "2026-12",
        agreement_id: AGREEMENT,
        agreement_number: "AG-2026-017",
        retainer_minutes: 44 * H,
        retainer_overage_rate_minor: "12500",
        lines: [line(495_000)],
      },
    })
    await h.renew({
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2026-021",
      startsOn: "2027-02-01",
      minutes: 50 * H,
      feeMinor: "560000",
    })
    expect(await h.month("2026-12")).toEqual(SIGNED)
    expect(await h.month("2027-01")).toEqual(SIGNED)
    expect((await h.month("2027-02")).fee).toEqual([560_000])
    expect(h.stored().retainer_renewal).toBeNull()
  })

  test("a replayed renewal never overwrites a later one, after any change", async () => {
    on(2026, 12, 2)
    const h = harness()
    await h.renew({ startsOn: "2027-01-01" })
    await h.renew({
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2026-021",
      startsOn: "2027-01-01",
      feeMinor: "520000",
    })
    const replay = await h.renew({ startsOn: "2027-01-01" })
    expect(replay).toMatchObject({ status: "completed", unchanged: true })
    expect((replay as { message: string }).message).toContain("replaced it since")
    expect((await h.month("2027-01")).fee).toEqual([520_000])
    // And the later one's own replay changes nothing either.
    expect(await h.renew({ agreementId: AGREEMENT_2 })).toMatchObject({ unchanged: true })
    await h.update({ lines: [line(530_000)] })
    expect(await h.renew()).toMatchObject({ unchanged: true })
    expect((await h.month("2027-01")).fee).toEqual([530_000])
  })

  test("an old row's null overage rate in a renewal is the schedule's own rate", async () => {
    const h = harness({
      retainer_renewal: {
        from: "2026-12",
        retainer_minutes: 44 * H,
        retainer_overage_rate_minor: null,
        lines: [line(495_000)],
      },
    })
    expect(await h.month("2026-12")).toEqual({ fee: [495_000], rate: 12_000, hours: 44 })
  })

  test("an entry with no hours that does not turn the retainer off is not terms", async () => {
    const h = harness({
      retainer_terms: [
        {
          from: "2026-12",
          retainer_minutes: 0,
          retainer_overage_rate_minor: "1",
          lines: [line(1)],
        },
      ],
    })
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(h.onCard("2026-12")).toBe(true)
  })

  test("a row holding both columns for one month bills the dated terms", async () => {
    const entry = (fee: number, minutes: number) => ({
      from: "2026-12",
      retainer_minutes: minutes,
      retainer_overage_rate_minor: "12500",
      lines: [line(fee)],
    })
    const h = harness({
      retainer_renewal: entry(495_000, 44 * H),
      retainer_terms: [entry(505_000, 46 * H)],
    })
    expect(await h.month("2026-12")).toEqual({ fee: [505_000], rate: 12_500, hours: 46 })
    expect(await h.month("2026-11")).toEqual(OLD)
  })

  test("a draft that already holds a signed renewal takes a change from its month, not at once", async () => {
    on(2026, 11, 19)
    const h = harness({ status: "draft" })
    await h.renew()
    await h.update({ retainer_overage_rate_minor: 14_000 })
    expect(await h.month("2026-11")).toEqual(OLD)
    expect(await h.month("2026-12")).toEqual({ ...SIGNED, rate: 14_000 })
  })

  test("a schedule resumed, or moved to another project, writes the hours in force, not its first ones", async () => {
    on(2026, 11, 19)
    const h = harness()
    await h.renew()
    on(2026, 12, 15)
    const OTHER = "7a1d2c3e-0000-4000-8000-000000000002"
    await h.update({ retainer_project_id: OTHER })
    const timebox = () => {
      const c = h.calls.filter((x) => x.target === "projects:period_timebox_set").at(-1)
      return [c?.projectId, c?.month, c?.timebox]
    }
    expect(timebox()).toEqual([OTHER, "2027-01", "44h"])
    const paused = harness({ status: "paused" })
    await paused.renew({ startsOn: "2027-01-01" })
    await paused.update({ status: "active" })
    expect(paused.calls.at(-1)).toMatchObject({ month: "2027-01", timebox: "44h" })
  })
})

describe("a month begins in the issuer's zone", () => {
  // 23:30 UTC on 30 November is 1 December in Paris.
  const late = () => setSystemTime(new Date(Date.UTC(2026, 10, 30, 23, 30)))

  test("the list's terms are those of the month after the issuer's", async () => {
    late()
    expect((await harness().listed()).retainer_terms_month).toBe("2027-01")
  })

  test("a run row's change from now on begins after the issuer's month", async () => {
    late()
    const h = harness({ retainer_from: "2026-12" })
    const item = {
      id: "item-1",
      schedule_id: SCHEDULE,
      period_key: "2026-11",
      schedule_patch: { applies: "from_now_on", lines: [line(430_000)] },
    }
    await h.db.insert("recurring_run_items", item)
    await writeSchedulePatch(h.ctx as never, item)
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(await h.month("2027-01")).toEqual({ ...OLD, fee: [430_000] })
  })
})

describe("a run row's change from now on never replaces a signed agreement's lines", () => {
  const item = (over: Row = {}) => ({
    id: "item-1",
    schedule_id: SCHEDULE,
    period_key: "2026-12",
    note: "Changed since November",
    schedule_patch: {
      applies: "from_now_on",
      lines: [line(430_000)],
      notes: "Net 30",
      ...over,
    },
  })

  test("signed from the same month: the lines stay, the rest is written, the row says why", async () => {
    on(2026, 12, 20)
    const h = harness({ retainer_from: "2027-01" })
    await h.db.insert("recurring_run_items", item())
    await h.renew({ startsOn: "2027-01-01" })
    const version = Number(h.stored().version)
    on(2026, 12, 31)
    expect(await writeSchedulePatch(h.ctx as never, item())).toBe(SCHEDULE)
    expect(await h.month("2027-01")).toEqual(SIGNED)
    expect(h.stored()).toMatchObject({ notes: "Net 30", version: version + 1 })
    const row = h.db.__all("recurring_run_items")[0] as Row
    expect(row.note).toBe("Changed since November · Lines from now on kept: AG-2026-017 is signed")
    expect(row.schedule_patch).toMatchObject({ written: true, lines_kept: "AG-2026-017" })
  })

  test("signed for an earlier month and still in force: the same, and lines alone write nothing", async () => {
    on(2026, 11, 19)
    const h = harness({ retainer_from: "2026-12" })
    await h.renew()
    const only = { ...item(), schedule_patch: { lines: [line(430_000)] } }
    await h.db.insert("recurring_run_items", only)
    const version = h.stored().version
    on(2026, 12, 31)
    await writeSchedulePatch(h.ctx as never, only)
    expect(await h.month("2027-01")).toEqual(SIGNED)
    expect(h.stored().version).toBe(version)
  })

  test("terms a person changed after the agreement are theirs to change again", async () => {
    on(2026, 11, 19)
    const h = harness({ retainer_from: "2026-12" })
    await h.renew()
    on(2026, 12, 10)
    await h.update({ lines: [line(470_000)] })
    await h.db.insert("recurring_run_items", item())
    on(2026, 12, 31)
    await writeSchedulePatch(h.ctx as never, item())
    expect((await h.month("2027-01")).fee).toEqual([430_000])
  })
})

describe("a change of a retainer's terms names the version it was read at", () => {
  const changes: Array<[string, Row]> = [
    ["lines", { lines: [line(450_000, "Design")] }],
    ["hours", { retainer_minutes: 45 * H }],
    ["rate", { retainer_overage_rate_minor: 1 }],
    ["rollover", { retainer_rollover: "next" }],
    ["off", { retainer_minutes: null, retainer_project_id: null }],
  ]
  test.each(changes)(
    "%s: refused without it, in the preflight and when it runs",
    async (_n, patch) => {
      on(2026, 12, 15)
      const h = harness()
      for (const r of [
        await checkScheduleUpdate(h.ctx, { id: SCHEDULE, ...patch }, "preflight"),
        await recurringScheduleUpdate(h.ctx, { id: SCHEDULE, ...patch }),
      ]) {
        expect(r).toMatchObject({ status: "error", error: { code: "version_required" } })
        expect((r as { error: { message: string } }).error.message).toContain("version 3")
      }
      expect(h.stored().version).toBe(3)
    },
  )

  test("anything else on a retainer, and a plain schedule's lines, need none", async () => {
    on(2026, 12, 15)
    const h = harness()
    const notes = await recurringScheduleUpdate(h.ctx, { id: SCHEDULE, notes: "Net 30" })
    expect(notes.status).toBe("completed")
    const plain = harness({ retainer_minutes: null, retainer_project_id: null })
    const r = await recurringScheduleUpdate(plain.ctx, { id: SCHEDULE, lines: [line(1)] })
    expect(r.status).toBe("completed")
  })
})

describe("old rows bill exactly what they billed before the dated terms", () => {
  // The rules as they were when a row held one renewal and no dated terms.
  function oldTerms(s: Row, month: string): Row {
    let r = s.retainer_renewal as Row | string | null
    if (typeof r === "string") r = JSON.parse(r) as Row
    if (!r || typeof r.from !== "string" || !(Number(r.retainer_minutes) > 0) || month < r.from)
      return s
    return {
      ...s,
      retainer_minutes: r.retainer_minutes,
      retainer_overage_rate_minor: r.retainer_overage_rate_minor ?? s.retainer_overage_rate_minor,
      lines: Array.isArray(r.lines) && r.lines.length > 0 ? r.lines : s.lines,
    }
  }
  function oldIsMonth(s: Row, month: string): boolean {
    if (s.retainer_minutes === null || !(Number(s.retainer_minutes) > 0)) return false
    return typeof s.retainer_from !== "string" || month >= s.retainer_from
  }

  test("2000 rows, every month of two years", () => {
    const rand = seeded(20261124)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T
    const months = Array.from({ length: 24 }, (_, i) => {
      const y = 2026 + Math.floor(i / 12)
      return `${y}-${String((i % 12) + 1).padStart(2, "0")}`
    })
    for (let n = 0; n < 2000; n++) {
      const renewal = pick<Row | null>([
        null,
        {
          from: pick(months),
          agreement_id: AGREEMENT,
          agreement_number: "AG-1",
          retainer_minutes: pick([0, 600, 2640]),
          retainer_overage_rate_minor: pick(["12500", null]),
          lines: pick([[], [line(495_000)], [line(1), line(2)]]),
        },
      ])
      const row: Row = {
        ...schedule(),
        retainer_minutes: pick([null, 0, 2400]),
        retainer_from: pick([null, pick(months)]),
        retainer_renewal: renewal && rand() < 0.5 ? JSON.stringify(renewal) : renewal,
        ...(rand() < 0.5 ? { retainer_terms: null, retainer_agreements: null } : {}),
      }
      for (const m of months) {
        expect(termsForMonth(row, m)).toEqual(oldTerms(row, m))
        expect(isRetainerMonth(row, m)).toBe(oldIsMonth(row, m))
      }
    }
  })

  test("a schedule turned off before: the run bills its own lines, whatever renewal it still holds", async () => {
    const h = runHarness("2026-12-29", {
      schedules: [
        runSchedule(SCHEDULE, {
          next_issue_on: "2026-12-31",
          next_draft_on: "2026-12-28",
          retainer_minutes: null,
          retainer_renewal: {
            from: "2026-12",
            retainer_minutes: 2640,
            retainer_overage_rate_minor: null,
            lines: [line(495_000)],
          },
          lines: [line(450_000)],
        }),
      ],
    })
    await recurringDraftJob(h.ctx)
    expect(h.db.__all("document_lines").map((l) => Number(l.unit_price_minor))).toEqual([450_000])
  })
})
