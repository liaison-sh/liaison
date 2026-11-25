// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A retainer turned off, and on again. Off takes effect from the next month: the running month and
// any earlier month not invoiced yet stay on their card with their own terms, and the month-end run
// starts with the first month after, never on a past day and never on a month a retainer's invoice
// or an advance covers. Every month is billed once. (On Postgres: invoicing-retainer-off.test.ts.)

import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { harness as runHarness, schedule as runSchedule } from "./__fixtures__/recurring-draft"
import { invoiceIssue } from "./mutations"
import { advanceDraftCreate } from "./mutations/advances"
import { retainerScheduleOf } from "./mutations/retainer"
import { recurringDraftJob } from "./recurring/draft-job"
import {
  isPrepaidMonth,
  isRetainerMonth,
  lastRetainerMonth,
  nextMonth,
  retainerOffFrom,
  termsForMonth,
  termsSignature,
} from "./recurring/retainer"
import { writeSchedulePatch } from "./recurring/run-card"
import { runBills, runDatesFrom } from "./recurring/run-dates"
import { addDays, datesFrom } from "./recurring/schedule"
import { draftCandidates, recurringScheduleUpdate, type ScheduleRow } from "./recurring/tools"
import {
  AGREEMENT_2,
  H,
  harness,
  line,
  OFF,
  ON,
  on,
  PROJECT,
  RENEWAL,
  type Row,
  SCHEDULE,
  schedule,
  seeded,
} from "./retainer-terms.testkit"
import { retainerTimeboxRoll } from "./retainer-timebox-roll"
import { billedByRun } from "./ui/month-end"
import {
  changedParams,
  draftFromRow,
  nextInvoices,
  retainerOffText,
  runFirstDay,
  turnedOffText,
} from "./ui/ScheduleEditor"

const OLD = { fee: [450_000], rate: 12_000, hours: 40 }
const runLines = (s: Row, m: string) =>
  (termsForMonth(s, m).lines as Array<{ unit_price_minor: number }>).map((l) =>
    Number(l.unit_price_minor),
  )
const timeboxes = (calls: Row[]) =>
  calls.filter((c) => c.target === "projects:period_timebox_set").map((c) => [c.month, c.timebox])
const advance = (month: string, over: Row = {}): Row => ({
  id: `adv-${month}`,
  type: "invoice",
  status: "issued",
  invoice_role: "advance",
  billing_project_id: PROJECT,
  external_ref: `advance:${PROJECT}:${month}`,
  service_period_start: `${month}-01`,
  number: "F-2026-0007",
  grand_total_minor: "540000",
  lifecycle_log: [],
  ...over,
})

afterEach(() => setSystemTime())

describe("turned off", () => {
  test("the module loads with the issue path beside it", () => {
    expect(typeof invoiceIssue).toBe("function")
  })

  test("the answer names the last retainer month, the run's first month and its day", async () => {
    on(2026, 12, 10)
    const h = harness()
    const r = await h.update(OFF)
    expect(r).toMatchObject({
      nextIssueOn: "2027-01-31",
      retainerOff: { last_month: "2026-12", run_from: "2027-01", dropped: [] },
    })
    expect(r.message).toContain("Its next invoice issues on 2027-01-31")
    expect(r.message).toContain("its last retainer month is 2026-12")
    expect(r.message).toContain("The month-end run starts with 2027-01")
    for (const m of ["2026-06", "2026-11", "2026-12"]) {
      expect(h.onCard(m)).toBe(true)
      expect(await h.month(m)).toEqual(OLD)
    }
    expect(h.onCard("2027-01")).toBe(false)
    // January's included hours leave the project; December's stay.
    expect(timeboxes(h.calls)).toEqual([["2027-01", null]])
    await retainerTimeboxRoll(h.ctx as never)
    expect(timeboxes(h.calls)).toHaveLength(1)
  })

  test("a renewal signed for a later month is dropped, and the answer and the editor say so", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-03-01" })
    const r = await h.update(OFF)
    expect(r.retainerOff?.dropped).toEqual([{ agreement_number: "AG-2026-017", from: "2027-03" }])
    expect(r.message).toContain("AG-2026-017 (signed from 2027-03) no longer applies")
    expect(runLines(h.stored(), "2027-04")).toEqual([450_000])
    expect(turnedOffText(r)).toContain("AG-2026-017, signed from March 2027, no longer applies.")
    // Replayed, it does not come back.
    expect(await h.renew({ startsOn: "2027-03-01" })).toMatchObject({
      status: "error",
      error: { code: "no_retainer_schedule" },
    })
    // One in force the month the run starts is what the run bills: nothing is dropped.
    const now = harness()
    await now.renew({ startsOn: "2027-01-01" })
    const s = await now.update(OFF)
    expect(s.retainerOff?.dropped).toEqual([])
    expect(runLines(now.stored(), "2027-01")).toEqual([495_000])
    expect(await now.month("2026-12")).toEqual(OLD)
  })

  test("with new lines in the same change: the run bills them, no retainer month does", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update({ ...OFF, lines: [line(200_000, "Hosting")] })
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(runLines(h.stored(), "2027-01")).toEqual([200_000])
  })

  test("twice: the second changes nothing", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    const terms = h.stored().retainer_terms
    const r = await h.update(OFF)
    expect(r.retainerOff).toBeUndefined()
    expect(h.stored().retainer_terms).toEqual(terms)
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(h.stored().next_issue_on).toBe("2027-01-31")
  })

  test("a schedule not started yet is a plain one at once", async () => {
    on(2026, 12, 10)
    const h = harness({ status: "draft", next_issue_on: null, next_draft_on: null })
    await h.renew({ startsOn: "2027-01-01" })
    const r = await h.update(OFF)
    expect(r.retainerOff).toBeUndefined()
    expect(h.stored()).toMatchObject({
      retainer_minutes: null,
      retainer_terms: null,
      retainer_from: null,
    })
    expect(h.onCard("2026-12")).toBe(false)
    expect((h.stored().lines as Row[])[0]?.unit_price_minor).toBe(495_000)
  })

  test("paused, or ending before the run starts: the answer promises no day", async () => {
    on(2026, 12, 10)
    const paused = await harness({ status: "paused" }).update(OFF)
    expect(paused.message).toContain("It is paused: nothing issues until it is resumed")
    expect(paused.nextIssueOn).toBe("2027-01-31")
    const ending = await harness({ ends_on: "2026-12-31" }).update(OFF)
    expect(ending.message).toContain("It ends on 2026-12-31, before the next invoice")
  })

  test("a month the run still owes from before the retainer keeps its day", async () => {
    on(2026, 12, 30)
    const h = harness({
      retainer_minutes: null,
      retainer_project_id: null,
      retainer_overage_rate_minor: null,
      retainer_from: null,
      next_issue_on: "2026-11-30",
    })
    await h.update(ON)
    const r = await h.update(OFF)
    expect(r.nextIssueOn).toBe("2026-11-30")
    expect(r.retainerOff?.last_month).toBeNull()
    expect(r.message).toContain("before its first month")
    expect(retainerOffText({ retainer_until: null, retainer_run_from: "2027-01" })).toBeNull()
  })

  test("longer periods: refused while the first would hold a retainer month, allowed when it begins after", async () => {
    on(2026, 11, 10)
    const h = harness()
    const held = await h.tryUpdate({ ...OFF, repeats: "quarter" })
    expect(held).toMatchObject({ status: "error", error: { code: "invalid_schedule" } })
    expect((held as { error: { message: string } }).error.message).toContain("2026-11")
    on(2026, 12, 10)
    const ok = await h.update({ ...OFF, repeats: "quarter" })
    expect(ok.nextIssueOn).toBe("2027-03-31")
    // Off already, changed later: the same rule.
    const later = harness()
    on(2027, 1, 10)
    await later.update(OFF)
    on(2027, 2, 10)
    expect(await later.tryUpdate({ repeats: "quarter" })).toMatchObject({
      error: { code: "invalid_schedule" },
    })
    on(2027, 4, 10)
    expect((await later.update({ repeats: "quarter" })).nextIssueOn).toBe("2027-06-30")
  })
})

describe("prepaid", () => {
  test.each([
    ["issued", {}, "2027-02", "advance F-2026-0007"],
    ["drafted", { status: "draft", number: null }, "2027-02", "its advance is already made"],
  ])(
    "next month's advance %s: that month is the last retainer month",
    async (_n, over, from, says) => {
      on(2026, 12, 10)
      const h = harness({ covers: "period_ahead" }, { documents: [advance("2027-01", over)] })
      const r = await h.update(OFF)
      expect(r.retainerOff).toMatchObject({ last_month: "2027-01", run_from: from })
      expect(r.nextIssueOn).toBe("2027-02-28")
      expect(r.message).toContain(says)
      expect(h.onCard("2027-01")).toBe(true)
      // January's hours stay on the project, February's leave it.
      expect(timeboxes(h.calls)).toEqual([["2027-02", null]])
      await retainerTimeboxRoll(h.ctx as never)
      expect(timeboxes(h.calls).at(-1)).toEqual(["2027-01", "40h"])
    },
  )

  test.each([
    ["cancelled", advance("2027-01", { status: "cancelled" }), []],
    [
      "credited in full",
      advance("2027-01"),
      [
        {
          id: "cn-1",
          type: "credit_note",
          status: "issued",
          original_document_id: "adv-2027-01",
          external_refs: { original_document_id: "adv-2027-01" },
          grand_total_minor: "-540000",
        },
      ],
    ],
    ["of another project", advance("2027-01", { external_ref: "advance:other:2027-01" }), []],
  ])("an advance %s holds no month", async (_n, doc, more) => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" }, { documents: [doc, ...more] })
    expect((await h.update(OFF)).nextIssueOn).toBe("2027-01-31")
  })

  test("two months ahead: the later one holds, whatever order they come in", async () => {
    on(2026, 12, 10)
    for (const months of [
      ["2027-01", "2027-03"],
      ["2027-03", "2027-01"],
    ]) {
      const h = harness({ covers: "period_ahead" }, { documents: months.map((m) => advance(m)) })
      expect((await h.update(OFF)).retainerOff).toMatchObject({
        last_month: "2027-03",
        run_from: "2027-04",
      })
    }
  })

  test("how the retainer's months were billed is kept: a later change of what it covers deducts all the same", async () => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" })
    await h.update({ ...OFF, covers: "period_ended" })
    expect(isPrepaidMonth(h.stored(), "2026-12")).toBe(true)
    expect((await h.plan("2026-12")).prepaid).toBe(true)
    const arrears = harness()
    await arrears.update({ ...OFF, covers: "period_ahead" })
    expect((await arrears.plan("2026-12")).prepaid).toBe(false)
  })

  test("an advance asked for a month the run bills is refused, and names the last retainer month", async () => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" })
    await h.update(OFF)
    const r = await advanceDraftCreate(h.ctx as never, {
      projectId: PROJECT,
      amountMinor: 450_000,
      month: "2027-01",
    })
    expect(r).toMatchObject({ status: "error", error: { code: "period_on_run" } })
    expect((r as { error: { message: string } }).error.message).toContain(
      "2026-12 is its last month",
    )
  })

  test("an advance that covers a run month all the same is never billed again by the run", async () => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" })
    await h.update(OFF)
    await h.db.insert("documents", advance("2027-01"))
    const s = h.stored() as unknown as ScheduleRow
    expect(await runBills(h.ctx as never, s, "2027-01-31")).toBe(false)
    expect((await runDatesFrom(h.ctx as never, s, "2027-01-01")).next_issue_on).toBe("2027-02-28")
  })
})

describe("paused while the last retainer month runs", () => {
  test("resumed by a person, or by its date: from the first month the run bills", async () => {
    on(2026, 12, 10)
    const h = harness({ status: "paused" })
    await h.update(OFF)
    const r = await h.update({ status: "active" })
    expect(r.nextIssueOn).toBe("2027-01-31")
    await h.db.update("recurring_schedules", SCHEDULE, {
      status: "paused",
      paused_until: "2026-12-20",
      next_issue_on: "2026-12-31",
    })
    await draftCandidates(h.ctx, "2026-12-20")
    expect(h.stored()).toMatchObject({ status: "active", next_issue_on: "2027-01-31" })
  })
})

describe("on again", () => {
  test("a signed renewal comes back with the retainer, and a replay adds nothing", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-03-01" })
    // As a row holds it when its renewals were not listed yet.
    await h.db.update("recurring_schedules", SCHEDULE, { retainer_agreements: null })
    await h.update(OFF)
    await h.update(ON)
    const terms = h.stored().retainer_terms
    expect(await h.renew({ startsOn: "2027-03-01" })).toMatchObject({ unchanged: true })
    expect(h.stored().retainer_terms).toEqual(terms)
    expect((await h.month("2027-02")).fee).toEqual([450_000])
    expect((await h.month("2027-03")).fee).toEqual([495_000])
  })

  test("in the same month: no month goes to the run", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    const r = await h.update(ON)
    expect(r.message).toContain("It stays a retainer")
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(await h.month("2027-01")).toEqual({ fee: [450_000], rate: 13_000, hours: 30 })
    expect(h.onCard("2027-01")).toBe(true)
    // With the terms it had: nothing dated is left.
    const same = harness()
    await same.update(OFF)
    await same.update({ ...ON, retainer_minutes: 40 * H, retainer_overage_rate_minor: 12_000 })
    expect(same.stored().retainer_terms).toEqual([])
    expect(retainerOffFrom(same.stored())).toBeNull()
  })

  test("after months on the run: from the next month, each month on its own terms", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    on(2027, 2, 10)
    const r = await h.update({ ...ON, lines: [line(500_000)] })
    expect(r.message).toContain("It is a retainer again from 2027-03")
    expect(["2026-12", "2027-01", "2027-02", "2027-03"].map(h.onCard)).toEqual([
      true,
      false,
      false,
      true,
    ])
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(runLines(h.stored(), "2027-02")).toEqual([450_000])
    expect(await h.month("2027-03")).toEqual({ fee: [500_000], rate: 13_000, hours: 30 })
    expect(timeboxes(h.calls).at(-1)).toEqual(["2027-03", "30h"])
    // Off before that first month: the run goes on, and its own month keeps its day.
    on(2027, 2, 20)
    const off = await h.update(OFF)
    expect(off.retainerOff).toMatchObject({ last_month: "2026-12" })
    expect(off.message).toContain("The month-end run goes on billing the months after it")
    expect(h.onCard("2027-03")).toBe(false)
  })

  test("on another project: refused, naming the project its months are on; a retainer with no month yet may move", async () => {
    const OTHER = "7a1d2c3e-0000-4000-8000-000000000002"
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    const r = await h.tryUpdate({ ...ON, retainer_project_id: OTHER })
    expect(r).toMatchObject({ status: "error", error: { code: "invalid_schedule" } })
    expect((r as { error: { message: string } }).error.message).toContain(PROJECT)
    const none = harness({ ...OFF, retainer_from: null })
    await none.update(ON)
    await none.update(OFF)
    expect(lastRetainerMonth(none.stored())).toBeNull()
    await none.update({ ...ON, retainer_project_id: OTHER })
    expect(none.stored().retainer_project_id).toBe(OTHER)
  })
})

describe("the run's lines of a schedule that was a retainer", () => {
  test("changed before and after the run starts: every run month to come, no retainer month", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    await h.update({ lines: [line(200_000)] })
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(runLines(h.stored(), "2027-01")).toEqual([200_000])
    on(2027, 3, 10)
    await h.update({ lines: [line(210_000)] })
    expect(runLines(h.stored(), "2027-02")).toEqual([200_000])
    expect(runLines(h.stored(), "2027-03")).toEqual([210_000])
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(isPrepaidMonth(h.stored(), "2026-12")).toBe(false)
  })

  test("a month still on the run before the retainer's first one takes the change too", async () => {
    on(2026, 12, 10)
    const h = harness({ ...OFF, retainer_from: null, lines: [line(300_000)] })
    await h.update({ ...ON, lines: [line(450_000)] })
    await h.update(OFF)
    await h.update({ lines: [line(310_000)] })
    expect(runLines(h.stored(), "2026-12")).toEqual([310_000])
    expect(runLines(h.stored(), "2027-01")).toEqual([310_000])
  })

  test("and a retainer month in between keeps its own fee", async () => {
    on(2026, 12, 10)
    const h = harness(
      { ...OFF, retainer_from: null, lines: [line(300_000)] },
      { documents: [advance("2027-01")] },
    )
    await h.update(ON)
    expect((await h.update(OFF)).retainerOff).toMatchObject({ last_month: "2027-01" })
    await h.update({ lines: [line(310_000)] })
    expect(runLines(h.stored(), "2026-12")).toEqual([310_000])
    expect(await h.month("2027-01")).toEqual({ fee: [300_000], rate: 13_000, hours: 30 })
    expect(runLines(h.stored(), "2027-02")).toEqual([310_000])
  })

  test("a run row's change from now on, on a schedule off since, is the run's next month's", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    on(2027, 2, 3)
    const item = {
      id: "item-1",
      schedule_id: SCHEDULE,
      period_key: "2027-01",
      schedule_patch: { lines: [line(220_000)] },
    }
    await h.db.insert("recurring_run_items", item)
    await writeSchedulePatch(h.ctx as never, item)
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(runLines(h.stored(), "2027-01")).toEqual([450_000])
    expect(runLines(h.stored(), "2027-02")).toEqual([220_000])
    expect(retainerOffFrom(h.stored())).toBe("2027-01")
  })
})

describe("a project with more than one retainer schedule", () => {
  const OTHER_SCHEDULE = "7a1d2c3e-0000-4000-8000-0000000000f2"
  test("each month is the one's whose month it is, the one turned off included", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    await h.db.insert("recurring_schedules", {
      ...schedule({ retainer_from: "2027-01" }),
      id: OTHER_SCHEDULE,
    })
    const of = async (m: string) => (await retainerScheduleOf(h.ctx as never, PROJECT, m))?.id
    expect(await of("2026-12")).toBe(SCHEDULE)
    expect(await of("2027-01")).toBe(OTHER_SCHEDULE)
    // A month both hold is the live one's.
    await h.db.update("recurring_schedules", OTHER_SCHEDULE, { retainer_from: "2026-12" })
    expect(await of("2026-12")).toBe(OTHER_SCHEDULE)
  })
})

describe("the list and the editor", () => {
  test("a retainer turned off reads as the plain schedule its run bills, with its last month", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-01-01" })
    const before = draftFromRow(SCHEDULE, await h.listed())
    // Exactly what a click on the box sends.
    const r = await h.update(
      changedParams(before, {
        ...before,
        retainer_hours: null,
        retainer_project_id: null,
      }) as never,
    )
    expect(turnedOffText(r)).toContain("December 2026 is the last retainer month")
    const row = await h.listed()
    expect(row).toMatchObject({
      retainer_minutes: null,
      retainer_project_id: null,
      retainer_until: "2026-12",
      retainer_run_from: "2027-01",
      next_issue_on: "2027-01-31",
    })
    expect(row.retainer_terms_month).toBeUndefined()
    expect(row.retainer_terms).toBeUndefined()
    expect(row.edit_claim).toBeUndefined()
    expect(row.retainer_agreements).toBeUndefined()
    const d = draftFromRow(SCHEDULE, row)
    expect(d.retainer_hours).toBeNull()
    expect(d.lines[0]?.unit_price_minor).toBe(495_000)
    expect(retainerOffText(d)).toContain("starts with January 2027")
    expect(nextInvoices(d, runFirstDay(d, "2026-12-10"), 1)[0]?.issueOn).toBe("2027-01-31")
    expect(runFirstDay(d, "2027-03-04")).toBe("2027-03-04")
    // Nothing is sent by saving it as it reads.
    expect(changedParams(d, { ...d })).toEqual({})
  })

  test("the first run month's own lines are shown while it is the next one to bill", async () => {
    on(2026, 12, 10)
    const h = harness({ ...OFF, retainer_from: null, lines: [line(300_000)] })
    await h.update({ ...ON, lines: [line(450_000)] })
    await h.update(OFF)
    expect((await h.listed()).lines).toMatchObject([{ unit_price_minor: 300_000 }])
  })

  test("a draft names no month for its terms: a change there applies at once", async () => {
    on(2026, 12, 10)
    const h = harness({ status: "draft" })
    const d = draftFromRow(SCHEDULE, await h.listed())
    expect(d.terms_month).toBeNull()
    expect(d.retainer_hours).toBe(40)
    await h.renew({ startsOn: "2027-01-01" })
    expect((await h.listed()).retainer_terms_month).toBe("2027-01")
  })

  test("a run offers no retainer to add, nor one turned off before its first run month", () => {
    expect(billedByRun({}, "2026-12-31")).toBe(true)
    expect(billedByRun({ retainer_minutes: 2400 }, "2026-12-31")).toBe(false)
    const off = { retainer_minutes: null, retainer_run_from: "2027-01" }
    expect(billedByRun(off, "2026-12-31")).toBe(false)
    expect(billedByRun(off, "2027-01-31")).toBe(true)
  })
})

describe("two changes of one schedule", () => {
  test("another change claimed or written in between: nothing is saved", async () => {
    on(2026, 12, 10)
    for (const meanwhile of [{ edit_claim: "another" }, { version: 9 }]) {
      const h = harness()
      const db = h.db as unknown as {
        updateMany: (e: string, o: never) => Promise<{ count: number }>
      }
      const write = db.updateMany.bind(h.db)
      let once = true
      db.updateMany = async (entity, opts) => {
        if (once && entity === "recurring_schedules") {
          once = false
          await h.db.update("recurring_schedules", SCHEDULE, meanwhile)
        }
        return write(entity, opts)
      }
      const r = await h.tryUpdate({ lines: [line(480_000)] })
      expect(r).toMatchObject({ status: "error", error: { code: "schedule_changed" } })
      expect(h.stored().retainer_terms ?? null).toBeNull()
      // A signature is taken again on what the schedule holds then.
      once = true
      expect(await h.renew({ startsOn: "2027-01-01" })).toMatchObject({ status: "completed" })
      expect((await h.month("2027-01")).fee).toEqual([495_000])
    }
  })
})

describe("the draft job", () => {
  const PAST = {
    ...schedule(),
    retainer_terms: [
      {
        from: "2026-12",
        off: true,
        retainer_minutes: 0,
        retainer_overage_rate_minor: null,
        lines: [line(200_000)],
      },
    ],
  }
  const row = (over: Row) => {
    const { id: _i, issuer_profile_id: _p, contact_id: _c, ...rest } = { ...PAST, ...over } as Row
    return runSchedule(SCHEDULE, rest)
  }
  const refs = (h: ReturnType<typeof runHarness>) =>
    h.db
      .__all("documents")
      .map((d) => String(d.external_ref))
      .filter((r) => r.startsWith("recurring:"))

  test("a date on a retainer month moves to the first month the run bills, on its dated lines", async () => {
    const h = runHarness("2026-12-29", {
      schedules: [row({ next_issue_on: "2026-10-31", next_draft_on: "2026-10-28" })],
    })
    await recurringDraftJob(h.ctx)
    expect(refs(h)).toEqual([])
    expect(h.db.__all("recurring_schedules")[0]).toMatchObject({ next_issue_on: "2026-12-31" })
    await recurringDraftJob(h.ctx)
    expect(refs(h)).toEqual([`recurring:${SCHEDULE}:2026-12`])
    expect(h.db.__all("document_lines").map((l) => Number(l.unit_price_minor))).toEqual([200_000])
    expect(h.db.__all("recurring_schedules")[0]).toMatchObject({ next_issue_on: "2027-01-31" })
  })

  test("a retainer that is on keeps its dates and is never drafted", async () => {
    const h = runHarness("2026-12-29", {
      schedules: [
        row({ retainer_terms: null, next_issue_on: "2026-10-31", next_draft_on: "2026-10-28" }),
      ],
    })
    await recurringDraftJob(h.ctx)
    expect(refs(h)).toEqual([])
    expect(h.db.__all("recurring_schedules")[0]).toMatchObject({ next_issue_on: "2026-10-31" })
  })
})

describe("any sequence of changes", () => {
  test("every month is billed once and no month that has begun ever moves", async () => {
    const rand = seeded(411)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T
    for (let n = 0; n < 60; n++) {
      on(2026, 9, 1)
      const plainFirst = rand() < 0.4
      const h = harness({
        next_issue_on: "2026-09-30",
        retainer_from: "2026-09",
        ...(plainFirst ? { ...OFF, retainer_from: null } : {}),
      })
      const first = "2026-09"
      const run: string[] = []
      const begun = new Map<string, string>()
      const face = (m: string) =>
        h.onCard(m) ? termsSignature(termsForMonth(h.stored(), m)) : "run"
      let month = first
      for (let i = 0; i < 8; i++, month = nextMonth(month)) {
        const [y, m] = month.split("-").map(Number) as [number, number]
        begun.set(month, face(month))
        for (let k = 0; k < 2; k++) {
          on(y, m, 5 + k * 8)
          const isOn = retainerOffFrom(h.stored()) === null && h.stored().retainer_minutes
          const change = pick(["none", "off", "on", "fee", "renew", "day", "pause"])
          const fee = 100_000 + Math.floor(rand() * 900) * 1000
          if (change === "off" && isOn) await h.update(OFF)
          else if (change === "on" && !isOn) await h.update({ ...ON, lines: [line(fee)] })
          else if (change === "fee" && isOn) await h.update({ lines: [line(fee)] })
          else if (change === "renew" && isOn)
            await h.renew({
              agreementId: crypto.randomUUID(),
              startsOn: `${nextMonth(pick([month, nextMonth(month)]))}-01`,
              feeMinor: String(fee),
            })
          else if (change === "day") await h.update({ billing_day: pick(["last", "28"]) })
          for (const [b, was] of begun) expect([b, face(b)]).toEqual([b, was])
        }
        // The job at the month's end, as draft-job.ts moves the dates.
        on(y, m, 28)
        for (let guard = 0; guard < 12; guard++) {
          const s = h.stored() as unknown as ScheduleRow
          const due = String(s.next_issue_on)
          if (due.slice(0, 7) > month) break
          if (await runBills(h.ctx as never, s, due)) {
            run.push(due.slice(0, 7))
            await h.db.update("recurring_schedules", SCHEDULE, {
              ...datesFrom(s, addDays(due, 1)),
            })
          } else {
            const next = await runDatesFrom(h.ctx as never, s, addDays(due, 1))
            if (!(await runBills(h.ctx as never, s, next.next_issue_on))) break
            await h.db.update("recurring_schedules", SCHEDULE, { ...next })
          }
        }
      }
      const billed: string[] = []
      for (let m = first; m < month; m = nextMonth(m)) if (!h.onCard(m)) billed.push(m)
      // The run billed exactly the months that are not the retainer's, once each, in order.
      expect(run).toEqual(billed)
      expect(isRetainerMonth(h.stored(), month)).toBeDefined()
    }
  })
})

test("the version is still checked when a schedule is turned off", async () => {
  on(2026, 12, 10)
  const h = harness()
  const stale = await recurringScheduleUpdate(h.ctx, { id: SCHEDULE, expected_version: 2, ...OFF })
  expect(stale).toMatchObject({ error: { code: "schedule_changed" } })
  expect(RENEWAL.agreementId).not.toBe(AGREEMENT_2)
})
