// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The edges of a retainer turned off, on again or ended: the months the month-end run already holds,
// another retainer's advances on the same project, a row turned off by an earlier version, the months
// an end leaves on the card, the signed terms and the project kept. (On Postgres:
// invoicing-retainer-off.test.ts.)

import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { harness as runHarness, schedule as runSchedule } from "./__fixtures__/recurring-draft"
import { invoiceIssue } from "./mutations"
import { advanceDraftCreate } from "./mutations/advances"
import { raiseHeldApproval, raiseHeldApprovals } from "./mutations/prepaid-hold"
import { retainerScheduleOf } from "./mutations/retainer"
import { recurringDraftJob } from "./recurring/draft-job"
import {
  isPrepaidMonth,
  isRetainerOn,
  nextMonth,
  type RetainerTerms,
  retainerOffFrom,
  retainerTermsOf,
  runDocumentRef,
  termsForMonth,
  withOffLinesFrom,
} from "./recurring/retainer"
import { writeSchedulePatch } from "./recurring/run-card"
import { firstRunMonth, periodMonths, runBills, runDatesFrom } from "./recurring/run-dates"
import { addDays, datesFrom, draftOn } from "./recurring/schedule"
import { draftCandidates, recurringSchedulePause, type ScheduleRow } from "./recurring/tools"
import {
  AGREEMENT,
  AGREEMENT_2,
  H,
  harness,
  line,
  OFF,
  ON,
  on,
  PROJECT,
  type Row,
  SCHEDULE,
  schedule,
  seeded,
} from "./retainer-terms.testkit"
import {
  draftFromRow,
  renewalText,
  retainerOffText,
  runFirstDay,
  turnedOnText,
} from "./ui/ScheduleEditor"

type World = ReturnType<typeof harness>

const OLD = { fee: [450_000], rate: 12_000, hours: 40 }
/** The retainer as it was, taken up again. */
const SAME = { ...ON, retainer_minutes: 40 * H, retainer_overage_rate_minor: 12_000 }
const OTHER_SCHEDULE = "7a1d2c3e-0000-4000-8000-0000000000f2"
const OTHER_PROJECT = "7a1d2c3e-0000-4000-8000-000000000002"
const runLines = (s: Row, m: string) =>
  (termsForMonth(s, m).lines as Array<{ unit_price_minor: number }>).map((l) =>
    Number(l.unit_price_minor),
  )
const timeboxes = (calls: Row[]) =>
  calls.filter((c) => c.target === "projects:period_timebox_set").map((c) => [c.month, c.timebox])
const messageOf = (r: unknown) => (r as { error: { message: string } }).error.message
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
/** The run's own document of a period. */
const runDoc = (key: string, over: Row = {}): Row => ({
  id: `run-${key}`,
  type: "invoice",
  status: "draft",
  external_ref: runDocumentRef(SCHEDULE, key),
  ...over,
})
/** The run's row of a period, with no document. */
const runRow = (key: string, over: Row = {}): Row => ({
  id: `item-${key}`,
  schedule_id: SCHEDULE,
  period_key: key,
  state: "ready",
  ...over,
})
const askAdvance = (h: World, month?: string) =>
  advanceDraftCreate(h.ctx as never, {
    projectId: PROJECT,
    amountMinor: 450_000,
    ...(month ? { month } : {}),
  })
const agreementsFrom = (s: Row) =>
  retainerTermsOf(s)
    .filter((t) => t.agreement_number && !t.off)
    .map((t) => [t.from, t.agreement_number])

afterEach(() => setSystemTime())

test("the module loads with the issue path beside it", () => {
  expect(typeof invoiceIssue).toBe("function")
})

describe("on again while the run already holds next month", () => {
  const offThenHeld = async (docs: Row[], items: Row[] = [], over: Row = {}) => {
    on(2026, 12, 10)
    const h = harness({ billing_day: "1", next_issue_on: "2027-01-01", ...over })
    await h.update(OFF)
    for (const d of docs) await h.db.insert("documents", d)
    for (const i of items) await h.db.insert("recurring_run_items", i)
    await h.db.update("recurring_schedules", SCHEDULE, { next_issue_on: "2027-02-01" })
    on(2026, 12, 30)
    return h
  }

  test("it starts after that month, which is no retainer month, and the answer says so", async () => {
    const h = await offThenHeld([runDoc("2027-01")], [runRow("2027-01")])
    const r = await h.update(ON)
    expect(["2026-12", "2027-01", "2027-02"].map(h.onCard)).toEqual([true, false, true])
    expect(r.message).toContain("It is a retainer again from 2027-02")
    expect(r.message).toContain("already holds 2027-01 (its draft)")
    expect(r.message).not.toContain("It stays a retainer")
    expect(r.retainerOn).toEqual({ from: "2027-02", on_run: "2027-01", gone: null })
    expect(turnedOnText(r)).toBe(
      "Saved. The retainer bills from February 2027. January 2027 is already on the month-end run, which bills it.",
    )
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(runLines(h.stored(), "2027-01")).toEqual([450_000])
    expect(await h.month("2027-02")).toEqual({ fee: [450_000], rate: 13_000, hours: 30 })
    expect(timeboxes(h.calls).at(-1)).toEqual(["2027-02", "30h"])
    // Off again the same day: the run goes on with February, January stays its own.
    await h.update(OFF)
    expect(h.onCard("2027-02")).toBe(false)
    expect(retainerOffFrom(h.stored())).toBe("2027-01")
    expect(h.stored().next_issue_on).toBe("2027-02-01")
  })

  test.each<[string, Row[], Row[], string]>([
    [
      "issued",
      [runDoc("2027-01", { status: "issued", number: "F-2026-0042" })],
      [],
      "(invoice F-2026-0042)",
    ],
    ["its row alone", [], [runRow("2027-01")], "(its draft)"],
    [
      "its row left out, the draft kept",
      [runDoc("2027-01")],
      [runRow("2027-01", { state: "left_out" })],
      "(its draft)",
    ],
    ["a quarter", [runDoc("2027-Q1")], [], "2027-03"],
    ["a year", [], [runRow("2027")], "2027-12"],
    ["two months, whatever their order", [runDoc("2027-02"), runDoc("2027-01")], [], "2027-02"],
  ])("held as %s", async (_n, docs, items, says) => {
    const h = await offThenHeld(docs, items)
    const r = await h.update(ON)
    expect(r.message).toContain(says)
    const until = { "2027-03": "2027-04", "2027-12": "2028-01" }[says] ?? "2027-02"
    const first = says === "2027-02" ? "2027-03" : until
    expect(r.retainerOn?.from).toBe(first)
    expect(h.onCard("2027-01")).toBe(false)
    expect(h.onCard(first)).toBe(true)
  })

  test.each<[string, Row[], Row[]]>([
    ["cancelled", [runDoc("2027-01", { status: "cancelled" })], []],
    ["another schedule's", [runDoc("2027-01", { external_ref: "recurring:other:2027-01" })], []],
    ["left out with no draft", [], [runRow("2027-01", { state: "left_out" })]],
    ["this month's", [runDoc("2026-12")], [runRow("2026-12")]],
  ])("a run invoice %s holds no month to come", async (_n, docs, items) => {
    const h = await offThenHeld(docs, items)
    const r = await h.update(ON)
    expect(r.message).toContain("It stays a retainer")
    expect(r.message).not.toContain("already holds")
    expect(r.retainerOn).toEqual({ from: "2027-01", on_run: null, gone: null })
    expect(h.onCard("2027-01")).toBe(true)
  })

  test("a schedule made a retainer for the first time starts after it too", async () => {
    on(2026, 12, 30)
    const h = harness(
      { ...OFF, retainer_from: null, billing_day: "1", next_issue_on: "2027-02-01" },
      { documents: [runDoc("2027-01")] },
    )
    const r = await h.update({ ...ON, lines: [line(500_000)] })
    expect(r.message).toContain("It is a retainer from 2027-02")
    expect(r.message).toContain("already holds 2027-01")
    expect(["2027-01", "2027-02"].map(h.onCard)).toEqual([false, true])
    expect(runLines(h.stored(), "2027-01")).toEqual([450_000])
    expect(await h.month("2027-02")).toEqual({ fee: [500_000], rate: 13_000, hours: 30 })
    // What the list shows and a change replaces is February's.
    expect((await h.listed()).retainer_terms_month).toBe("2027-02")
  })

  test("terms changed or renewed before its first month never reach the month on the run", async () => {
    const h = await offThenHeld([runDoc("2027-01")])
    await h.update(ON)
    const row = await h.listed()
    expect(row).toMatchObject({ retainer_terms_month: "2027-02", retainer_minutes: 30 * H })
    const r = await h.update({ lines: [line(480_000)], terms_month: "2027-02" })
    expect(r.message).toContain("New retainer terms apply from 2027-02")
    expect(["2027-01", "2027-02"].map(h.onCard)).toEqual([false, true])
    expect((await h.month("2027-02")).fee).toEqual([480_000])
    expect(await h.renew({ startsOn: "2027-01-01" })).toMatchObject({ from: "2027-02" })
    expect(["2027-01", "2027-02"].map(h.onCard)).toEqual([false, true])
    expect((await h.month("2027-02")).fee).toEqual([495_000])
  })

  test("the advance of a month the run holds is refused, asked for or by default", async () => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" }, { documents: [advance("2026-12")] })
    await h.db.insert("documents", runDoc("2027-01"))
    for (const month of [undefined, "2027-01"]) {
      const r = await askAdvance(h, month)
      expect(r).toMatchObject({ status: "error", error: { code: "period_on_run" } })
      expect(messageOf(r)).toContain("2027-01")
      expect(messageOf(r)).toContain("Name a later month")
    }
    expect(await askAdvance(h, "2027-02")).toMatchObject({ status: "completed" })
  })

  test("the advance of a month off between two times as a retainer names its next first month", async () => {
    const h = await offThenHeld([runDoc("2027-01")], [], { covers: "period_ahead" })
    await h.update(ON)
    const r = await askAdvance(h, "2027-01")
    expect(messageOf(r)).toContain("The retainer bills from 2027-02")
  })
})

describe("another retainer's advances on the same project", () => {
  const other = (over: Row = {}): Row => ({
    ...schedule({ covers: "period_ahead", retainer_from: "2027-01", ...over }),
    id: OTHER_SCHEDULE,
  })
  test("a turned-off schedule bills its own run months", async () => {
    on(2026, 12, 10)
    for (const over of [{}, { status: "ended" }]) {
      const h = harness()
      await h.update(OFF)
      await h.db.insert("recurring_schedules", other(over))
      for (const m of ["2027-02", "2027-03"]) await h.db.insert("documents", advance(m))
      const s = h.stored() as unknown as ScheduleRow
      for (const day of ["2027-01-31", "2027-02-28", "2027-03-31"])
        expect([day, await runBills(h.ctx as never, s, day)]).toEqual([day, true])
      expect((await runDatesFrom(h.ctx as never, s, "2027-02-01")).next_issue_on).toBe("2027-02-28")
    }
  })

  test("turned off beside it, its run starts next month; its own advance still holds one", async () => {
    on(2026, 12, 10)
    const start = async (rows: Row[]) => {
      const h = harness({}, { recurring_schedules: rows, documents: [advance("2027-02")] })
      return (await firstRunMonth(h.ctx as never, schedule() as never, "2026-12")).from
    }
    expect(await start([other(), schedule()])).toBe("2027-01")
    expect(await start([schedule(), other()])).toBe("2027-03")
    expect(await start([schedule(), other({ status: "ended" })])).toBe("2027-03")
  })

  test("an advance of its own month is the month's own schedule's", async () => {
    on(2026, 12, 10)
    // The live one starts in February; January is still the turned-off one's.
    const h = harness({}, { documents: [advance("2027-01")] })
    await h.update(OFF)
    await h.db.update("documents", "adv-2027-01", { status: "cancelled", external_ref: "gone" })
    await h.db.insert("recurring_schedules", other({ retainer_from: "2027-02" }))
    // Not refused as a month before the live one's first; a month of neither is.
    expect(await askAdvance(h, "2027-01")).toMatchObject({ status: "completed" })
    expect(await askAdvance(h, "2026-01")).toMatchObject({ status: "completed" })
    expect(await askAdvance(h, "2025-12")).toMatchObject({ error: { code: "period_on_run" } })
  })

  test("a retainer's invoice of next month is a retainer month when it is turned off", async () => {
    on(2026, 12, 10)
    const h = harness(
      {},
      {
        documents: [
          {
            id: "ret-1",
            status: "issued",
            number: "F-2026-0050",
            external_ref: `retainer:${SCHEDULE}:2027-01`,
          },
        ],
      },
    )
    const r = await h.update(OFF)
    expect(r.retainerOff).toMatchObject({ last_month: "2027-01", run_from: "2027-02" })
    expect(r.message).toContain("2027-01 stays a retainer month because its invoice F-2026-0050")
  })
})

describe("a row turned off by an earlier version", () => {
  test("months its retainer invoiced one after another are passed, however many", async () => {
    const h = runHarness("2027-03-31", {
      schedules: [
        runSchedule(SCHEDULE, { next_issue_on: "2026-10-31", next_draft_on: "2026-10-28" }),
      ],
      docs: ["2026-10", "2026-11"].map((m) => ({
        id: `ret-${m}`,
        type: "invoice",
        status: "issued",
        external_ref: `retainer:${SCHEDULE}:${m}`,
      })),
    })
    for (let i = 0; i < 8; i++) await recurringDraftJob(h.ctx)
    const refs = h.db
      .__all("documents")
      .map((d) => String(d.external_ref))
      .filter((r) => r.startsWith("recurring:"))
    expect(refs.sort()).toEqual(
      ["2026-12", "2027-01", "2027-02", "2027-03"].map((m) => `recurring:${SCHEDULE}:${m}`),
    )
  })

  test("a year is twelve months, a quarter three", () => {
    expect(periodMonths("year", "2027-12-31")).toHaveLength(12)
    expect(periodMonths("year", "2027-12-31").at(-1)).toBe("2027-12")
    expect(periodMonths("quarter", "2027-03-31")).toEqual(["2027-01", "2027-02", "2027-03"])
  })

  test("a year that holds a retainer month in its middle is not the run's", async () => {
    on(2026, 11, 10)
    const h = harness()
    const r = await h.tryUpdate({ ...OFF, repeats: "year" })
    expect(r).toMatchObject({ error: { code: "invalid_schedule" } })
    expect(messageOf(r)).toContain("2026-11")
    const s = {
      ...schedule({ ...OFF, repeats: "year" }),
      id: SCHEDULE,
    } as unknown as ScheduleRow
    await h.db.insert("documents", {
      id: "ret-may",
      status: "issued",
      external_ref: `retainer:${SCHEDULE}:2027-05`,
    })
    expect(await runBills(h.ctx as never, s, "2027-12-31")).toBe(false)
  })
})

describe("ended", () => {
  const owner = async (h: World, m: string) =>
    (await retainerScheduleOf(h.ctx as never, PROJECT, m))?.id ?? null

  test("after it was turned off: its months stay on the card, no other does, and the answer says so", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    const r = await h.update({ status: "ended" })
    expect(r.message).toContain("its last retainer month is 2026-12")
    expect(r.message).toContain("stay on the project's planned vs done card")
    expect(r.message).not.toContain("bills nothing more. The retainer is on")
    for (const m of ["2026-10", "2026-11", "2026-12"]) expect(await owner(h, m)).toBe(SCHEDULE)
    for (const m of ["2027-01", "2027-06"]) expect(await owner(h, m)).toBeNull()
    expect(await h.month("2026-12")).toEqual(OLD)
    const row = await h.listed()
    expect(row.retainer_until).toBe("2026-12")
    expect(row.retainer_run_from).toBeUndefined()
    const d = draftFromRow(SCHEDULE, row)
    expect(retainerOffText(d)).toBe(
      "December 2026 is the last retainer month: it and any earlier month not invoiced yet are billed from the project's card.",
    )
    expect(runFirstDay(d, "2026-12-10")).toBe("2026-12-10")
  })

  test("while on: the running month is its last, its months to come leave the project", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-03-01" })
    const r = await h.update({ status: "ended" })
    expect(r.scheduleStatus).toBe("ended")
    expect(r.nextIssueOn).toBeNull()
    expect(r.retainerOff).toBeUndefined()
    expect(r.message).toContain("The retainer has ended: its last retainer month is 2026-12")
    expect(r.message).toContain("AG-2026-017 (signed from 2027-03) no longer applies.")
    expect(r.message).not.toContain("month-end run starts")
    expect(await owner(h, "2026-11")).toBe(SCHEDULE)
    expect(await owner(h, "2026-12")).toBe(SCHEDULE)
    expect(await owner(h, "2027-01")).toBeNull()
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(timeboxes(h.calls).at(-1)).toEqual(["2027-01", null])
  })

  test("with next month's advance already paid: that month is the last", async () => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" }, { documents: [advance("2027-01")] })
    const r = await h.update({ status: "ended" })
    expect(r.message).toContain("its last retainer month is 2027-01")
    expect(await owner(h, "2027-01")).toBe(SCHEDULE)
    expect(await owner(h, "2027-02")).toBeNull()
    expect((await h.plan("2027-01")).prepaid).toBe(true)
    expect(timeboxes(h.calls)).toEqual([["2027-02", null]])
    // Turned off first, then ended: the same, and no hours of that month are taken off.
    const off = harness({ covers: "period_ahead" }, { documents: [advance("2027-01")] })
    await off.update(OFF)
    await off.update({ status: "ended" })
    expect(await owner(off, "2027-01")).toBe(SCHEDULE)
    expect(timeboxes(off.calls)).toEqual([["2027-02", null]])
  })

  test("a live schedule of the project comes first, one ended by an earlier version holds none", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update({ status: "ended" })
    await h.db.insert("recurring_schedules", {
      ...schedule({ retainer_from: "2026-12" }),
      id: OTHER_SCHEDULE,
    })
    expect(await owner(h, "2026-11")).toBe(SCHEDULE)
    expect(await owner(h, "2026-12")).toBe(OTHER_SCHEDULE)
    expect(await owner(harness({ status: "ended" }), "2026-11")).toBeNull()
  })

  test("a draft never started, and a plain schedule, keep no month", async () => {
    on(2026, 12, 10)
    const draft = harness({ status: "draft", next_issue_on: null })
    const r = await draft.update({ status: "ended" })
    expect(r.message).toContain("bills nothing more")
    expect(await owner(draft, "2026-12")).toBeNull()
    const plain = harness({ ...OFF, retainer_from: null })
    expect((await plain.update({ status: "ended" })).message).toContain(
      "It has ended and bills nothing more.",
    )
    expect(plain.stored().retainer_terms ?? null).toBeNull()
  })

  test("its held invoice still gets its approval", async () => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" })
    await h.update({ status: "ended" })
    await h.db.insert("documents", {
      id: "final-1",
      status: "draft",
      billing_project_id: PROJECT,
      external_ref: `retainer:${SCHEDULE}:2026-12`,
      external_refs: { issue_held: true },
      service_period_start: "2026-12-01",
      currency: "EUR",
    })
    const asked: Row[] = []
    const ctx = {
      ...h.ctx,
      requestApproval: async (input: Row) => {
        asked.push(input)
        return { approval_id: "ap-1" }
      },
    }
    await raiseHeldApproval(ctx as never, { id: "adv", billing_project_id: PROJECT })
    expect(asked).toHaveLength(1)
    expect(await raiseHeldApprovals(ctx as never)).toBe(0)
    expect(isPrepaidMonth(h.stored(), "2026-12")).toBe(true)
  })
})

describe("the version never goes down", () => {
  /** Another change is written right after the next read of the schedule. */
  const changedAfterRead = (h: World, method: "findOne" | "findMany", over: Row) => {
    const db = h.db as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    const read = db[method]!.bind(h.db)
    let once = true
    db[method] = async (...args) => {
      const out = structuredClone(await read(...args))
      if (once && args[0] === "recurring_schedules") {
        once = false
        await h.db.update("recurring_schedules", SCHEDULE, over)
      }
      return out
    }
  }

  test("paused while another change is saved", async () => {
    on(2026, 12, 10)
    const h = harness()
    changedAfterRead(h, "findOne", { version: 9, notes: "Net 30" })
    const r = await recurringSchedulePause(h.ctx, { id: SCHEDULE })
    expect(r).toMatchObject({ status: "completed" })
    expect(h.stored()).toMatchObject({ status: "paused", version: 10, notes: "Net 30" })
    // Ended meanwhile: nothing is paused.
    const ended = harness()
    changedAfterRead(ended, "findOne", { version: 9, status: "ended" })
    expect(await recurringSchedulePause(ended.ctx, { id: SCHEDULE })).toMatchObject({
      error: { code: "schedule_changed" },
    })
    expect(ended.stored()).toMatchObject({ status: "ended", version: 9 })
  })

  test("a pause whose write lost to another change is taken again", async () => {
    on(2026, 12, 10)
    const h = harness()
    let once = true
    const db = h.db as unknown as { updateMany: (e: string, o: never) => Promise<unknown> }
    const write = db.updateMany.bind(h.db)
    db.updateMany = async (e, o) => {
      if (once) {
        once = false
        await h.db.update("recurring_schedules", SCHEDULE, { version: 9 })
      }
      return write(e, o)
    }
    await recurringSchedulePause(h.ctx, { id: SCHEDULE })
    expect(h.stored()).toMatchObject({ status: "paused", version: 10 })
  })

  test("resumed by its date while another change is saved", async () => {
    on(2026, 12, 20)
    const paused = { status: "paused", paused_until: "2026-12-20" }
    const h = harness(paused)
    changedAfterRead(h, "findMany", { version: 9, notes: "Net 30" })
    await draftCandidates(h.ctx, "2026-12-20")
    expect(h.stored()).toMatchObject({ status: "active", version: 10, notes: "Net 30" })
    const ended = harness(paused)
    changedAfterRead(ended, "findMany", { version: 9, status: "ended" })
    await draftCandidates(ended.ctx, "2026-12-20")
    expect(ended.stored()).toMatchObject({ status: "ended", version: 9 })
  })

  test("a change written between the check and the claim is refused, never written over", async () => {
    on(2026, 12, 10)
    const h = harness()
    const db = h.db as unknown as { update: (...a: unknown[]) => Promise<unknown> }
    const update = db.update.bind(h.db)
    let once = true
    db.update = async (...args) => {
      if (once && (args[2] as Row | undefined)?.edit_claim) {
        once = false
        // A renewal saved after the check, before this change claims the row.
        await update("recurring_schedules", SCHEDULE, { version: 4 })
      }
      return update(...args)
    }
    const r = await h.tryUpdate({ lines: [line(430_000)] })
    expect(r).toMatchObject({ status: "error", error: { code: "schedule_changed" } })
    expect(h.stored()).toMatchObject({ version: 4 })
    expect(h.stored().retainer_terms ?? null).toBeNull()
  })
})

describe("the signed terms", () => {
  const patch = (month: string): Row => ({
    id: "item-1",
    schedule_id: SCHEDULE,
    period_key: month,
    schedule_patch: { applies: "from_now_on", lines: [line(430_000)] },
  })
  const signedLine = line(495_000, "Monthly retainer, 44 h included")
  const SIGNED_ON = {
    ...ON,
    retainer_minutes: 44 * H,
    retainer_overage_rate_minor: 12_500,
    lines: [signedLine],
  }
  const keptBy = async (h: World, month: string) => {
    await h.db.insert("recurring_run_items", patch(month))
    await writeSchedulePatch(h.ctx as never, patch(month))
    const row = h.db.__all("recurring_run_items")[0] as Row
    return (row.schedule_patch as Row).lines_kept ?? null
  }

  test("kept by a later change that leaves the lines: a run row never replaces them", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-01-01" })
    on(2027, 1, 10)
    const r = await h.update({ retainer_rollover: "next" })
    expect(r.message).toContain("New retainer terms apply from 2027-02")
    await h.update({ retainer_minutes: 44 * H })
    await h.update({ retainer_overage_rate_minor: 12_600 })
    expect(await keptBy(h, "2027-01")).toBe("AG-2026-017")
    expect((await h.month("2027-02")).fee).toEqual([495_000])
    // The list names the agreement with its own month, and the change with its own.
    expect(renewalText(await h.listed())).toEqual([
      "Renewed by AG-2026-017 from January 2027",
      "New terms from February 2027",
    ])
    // A later renewal starts from the rollover set since.
    await h.renew({ agreementId: AGREEMENT_2, agreementNumber: "AG-2", startsOn: "2027-02-01" })
    expect(retainerTermsOf(h.stored()).at(-1)).toMatchObject({
      agreement_number: "AG-2",
      retainer_rollover: "next",
    })
  })

  test("kept through off and on again before the renewal's month, with the lines shown", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-01-01" })
    await h.update(OFF)
    const shown = (await h.listed()).lines as never
    const r = await h.update({ ...SIGNED_ON, lines: shown, retainer_rollover: "next" })
    expect(r.message).not.toContain("no longer applies")
    expect(agreementsFrom(h.stored())).toEqual([["2027-01", "AG-2026-017"]])
    expect(await keptBy(h, "2026-12")).toBe("AG-2026-017")
    expect(await h.month("2027-01")).toEqual({ fee: [495_000], rate: 12_500, hours: 44 })
  })

  test("kept by a change is not signed for its own month: off and on again names no agreement gone", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-01-01" })
    on(2027, 1, 10)
    await h.update({ retainer_rollover: "next" })
    expect((await h.update(OFF)).retainerOff?.dropped).toEqual([])
    const r = await h.update({ ...ON, lines: [line(470_000)] })
    expect(r.message).not.toContain("no longer applies")
    expect((await h.month("2027-01")).fee).toEqual([495_000])
    expect((await h.month("2027-02")).fee).toEqual([470_000])
  })

  test("kept after a month on the run, off again: the run bills its lines, and nothing is dropped", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-01-01" })
    await h.update(OFF)
    await h.db.insert("documents", runDoc("2027-01"))
    await h.update(SIGNED_ON)
    expect(agreementsFrom(h.stored())).toEqual([["2027-02", "AG-2026-017"]])
    expect((await h.update(OFF)).retainerOff?.dropped).toEqual([])
    expect(runLines(h.stored(), "2027-01")).toEqual([495_000])
    await h.update(SIGNED_ON)
    expect(agreementsFrom(h.stored())).toEqual([["2027-02", "AG-2026-017"]])
  })

  test("on again with the terms in force before a renewal due by then: those keep their own agreement", async () => {
    on(2026, 11, 19)
    const h = harness()
    await h.renew({ startsOn: "2026-12-01" })
    await h.renew({
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2",
      startsOn: "2027-01-01",
      feeMinor: "520000",
    })
    on(2026, 12, 10)
    await h.update(OFF)
    const r = await h.update(SIGNED_ON)
    expect(r.message).toContain("AG-2 (signed from 2027-01) no longer applies")
    expect(await keptBy(h, "2026-12")).toBe("AG-2026-017")
    // Its hours changed as well: still named.
    const other = harness()
    on(2026, 11, 19)
    await other.renew({ startsOn: "2026-12-01" })
    await other.renew({
      agreementId: AGREEMENT_2,
      agreementNumber: "AG-2",
      startsOn: "2027-01-01",
      feeMinor: "520000",
    })
    on(2026, 12, 10)
    await other.update(OFF)
    await other.update({ ...SIGNED_ON, retainer_minutes: 50 * H })
    expect(await keptBy(other, "2026-12")).toBe("AG-2026-017")
  })

  test("not lost to a run row's change of the first run month", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-03-01" })
    await h.update(OFF)
    expect(await keptBy(h, "2026-12")).toBeNull()
    expect(runLines(h.stored(), "2027-01")).toEqual([430_000])
    await h.update(ON)
    expect((await h.month("2027-03")).fee).toEqual([495_000])
  })

  test("kept through months on the run at the signed lines", async () => {
    on(2026, 11, 19)
    const h = harness()
    await h.renew({ startsOn: "2026-12-01" })
    on(2026, 12, 10)
    await h.update(OFF)
    on(2027, 2, 10)
    await h.update(SIGNED_ON)
    expect(await keptBy(h, "2027-02")).toBe("AG-2026-017")
    expect((await h.month("2027-03")).fee).toEqual([495_000])
  })

  test("on again with other lines: the renewal of that month is gone, and the answer says so", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-01-01" })
    await h.update(OFF)
    const r = await h.update({ ...ON, lines: [line(470_000)] })
    expect(r.message).toContain(
      "AG-2026-017 (signed from 2027-01) no longer applies: the terms saved now replace it.",
    )
    expect(turnedOnText(r)).toContain("AG-2026-017, signed from January 2027, no longer applies.")
    expect(agreementsFrom(h.stored())).toEqual([])
    expect((await h.month("2027-01")).fee).toEqual([470_000])
    // With the very terms it had before the renewal: gone as well, and said.
    const same = harness()
    await same.renew({ startsOn: "2027-01-01" })
    await same.update(OFF)
    const back = await same.update({ ...SAME, lines: [line(450_000)] })
    expect(back.message).toContain("AG-2026-017 (signed from 2027-01) no longer applies")
    expect(await same.month("2027-01")).toEqual(OLD)
  })

  test("a renewal signed for later comes back when on again before it, and the answer names it", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.renew({ startsOn: "2027-03-01" })
    expect((await h.update(OFF)).message).toContain("AG-2026-017 (signed from 2027-03)")
    // The run's lines changed meanwhile, twice: it is not lost with them.
    await h.update({ lines: [line(460_000)] })
    on(2027, 1, 12)
    await h.update({ lines: [line(465_000)] })
    const r = await h.update({ ...ON, lines: [line(500_000)] })
    expect(r.message).toContain("From 2027-03 the signed terms of AG-2026-017 apply")
    expect((await h.month("2027-02")).fee).toEqual([500_000])
    expect(await h.month("2027-03")).toEqual({ fee: [495_000], rate: 12_500, hours: 44 })
    // Off again drops it again, and says so.
    expect((await h.update(OFF)).retainerOff?.dropped).toEqual([
      { agreement_number: "AG-2026-017", from: "2027-03" },
    ])
    // On again once its month has begun: gone, and said.
    on(2027, 4, 2)
    const late = await h.update({ ...ON, lines: [line(500_000)] })
    expect(late.message).toContain("AG-2026-017 (signed from 2027-03) no longer applies")
    expect((await h.month("2027-05")).fee).toEqual([500_000])
  })

  test("a renewal of a schedule that is off is refused, by its project and when it was turned off meanwhile", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    const none = await h.renew({ startsOn: "2027-01-01" })
    expect(messageOf(none)).toContain("has no retainer schedule")
    // Another schedule of the project is the one renewed.
    await h.db.insert("recurring_schedules", { ...schedule(), id: OTHER_SCHEDULE })
    expect(await h.renew({ startsOn: "2027-01-01" })).toMatchObject({ scheduleId: OTHER_SCHEDULE })
    expect(retainerOffFrom(h.stored())).toBe("2027-01")

    const raced = harness()
    const db = raced.db as unknown as { update: (...a: unknown[]) => Promise<unknown> }
    const update = db.update.bind(raced.db)
    let once = true
    db.update = async (...args) => {
      if (once && (args[2] as Row | undefined)?.edit_claim) {
        once = false
        await update("recurring_schedules", SCHEDULE, {
          version: 4,
          retainer_terms: [
            { from: "2027-01", off: true, retainer_minutes: 0, lines: [line(450_000)] },
          ],
        })
      }
      return update(...args)
    }
    const r = await raced.renew({ startsOn: "2027-01-01" })
    expect(messageOf(r)).toContain("is no longer a retainer")
    expect(raced.stored()).toMatchObject({ version: 4 })
    expect(isRetainerOn(raced.stored())).toBe(false)
  })
})

describe("its project", () => {
  test("on again, it never moves to another project: in one change, in two, or after a later one", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update(OFF)
    await h.update(SAME)
    const move = { retainer_project_id: OTHER_PROJECT }
    for (const patch of [move, { ...ON, ...move }, { ...move, lines: [line(1)] }]) {
      const r = await h.tryUpdate(patch)
      expect(r).toMatchObject({ status: "error", error: { code: "invalid_schedule" } })
      expect(messageOf(r)).toContain(PROJECT)
    }
    await h.update({ lines: [line(480_000)] })
    await h.renew({ startsOn: "2027-01-01" })
    on(2027, 3, 5)
    expect(await h.tryUpdate(move)).toMatchObject({ error: { code: "invalid_schedule" } })
    await h.update(OFF)
    expect(await h.tryUpdate({ ...ON, ...move })).toMatchObject({
      error: { code: "invalid_schedule" },
    })
    expect(h.stored().retainer_project_id).toBe(PROJECT)
    expect((await h.listed()).retainer_kept_project).toBeUndefined()
  })

  test("a retainer that was never off, or never begun when it was, still may", async () => {
    on(2026, 12, 10)
    const h = harness()
    await h.update({ retainer_project_id: OTHER_PROJECT })
    expect(h.stored().retainer_project_id).toBe(OTHER_PROJECT)
    const none = harness({ ...OFF, retainer_from: null })
    await none.update(ON)
    await none.update(OFF)
    await none.update(ON)
    await none.update({ retainer_project_id: OTHER_PROJECT })
    expect(none.stored().retainer_project_id).toBe(OTHER_PROJECT)
  })
})

describe("the run's lines of a schedule turned off", () => {
  test("a prepaid month still deducts its advance after they change", async () => {
    on(2026, 12, 10)
    const h = harness(
      { covers: "period_ahead" },
      {
        documents: [advance("2026-12")],
        document_lines: [
          {
            id: "l-1",
            document_id: "adv-2026-12",
            position: 1,
            description: "Advance",
            subtotal_minor: "450000",
            tax_rate_bp: 2000,
          },
        ],
      },
    )
    await h.update({ ...OFF, covers: "period_ended" })
    for (const fee of [200_000, 210_000]) {
      await h.update({ lines: [line(fee)] })
      const p = await h.plan("2026-12")
      expect(p.prepaid).toBe(true)
      expect(p.deductions.length).toBeGreaterThan(0)
    }
  })

  test("the run bills the terms in force its first month, not next month's", async () => {
    on(2026, 12, 10)
    const h = harness({ covers: "period_ahead" }, { documents: [advance("2027-01")] })
    await h.renew({ startsOn: "2027-02-01" })
    const r = await h.update(OFF)
    expect(r.retainerOff).toMatchObject({ run_from: "2027-02", dropped: [] })
    expect(runLines(h.stored(), "2027-02")).toEqual([495_000])
    expect((await h.month("2027-01")).fee).toEqual([450_000])
  })

  test("a row's change during a gap keeps the retainer taken up again later", async () => {
    const off: RetainerTerms = {
      from: "2027-01",
      off: true,
      retainer_minutes: 0,
      retainer_overage_rate_minor: null,
      lines: [line(450_000)],
      covers: "period_ahead",
    }
    const again: RetainerTerms = {
      from: "2027-03",
      retainer_minutes: 30 * H,
      retainer_overage_rate_minor: "13000",
      lines: [line(500_000)],
    }
    const s = { ...schedule(), retainer_terms: [off, again] }
    const next = { ...s, ...withOffLinesFrom(s, "2027-02", [line(220_000)]) }
    expect(runLines(next, "2027-01")).toEqual([450_000])
    expect(runLines(next, "2027-02")).toEqual([220_000])
    expect(isRetainerOn(next)).toBe(true)
    expect(runLines(next, "2027-03")).toEqual([500_000])
    expect(retainerTermsOf(next).find((t) => t.from === "2027-02")?.covers).toBe("period_ahead")
  })
})

describe("a run row's change from now on", () => {
  const item = (over: Row = {}): Row => ({
    id: "item-1",
    schedule_id: SCHEDULE,
    period_key: "2026-11",
    schedule_patch: { applies: "from_now_on", lines: [line(430_000)], notes: "Net 30" },
    ...over,
  })
  const losing = (h: World, times: number) => {
    const db = h.db as unknown as { updateMany: (e: string, o: never) => Promise<unknown> }
    const write = db.updateMany.bind(h.db)
    let left = times
    let version = 20
    db.updateMany = async (e, o) => {
      if (left > 0 && e === "recurring_schedules") {
        left -= 1
        await h.db.update("recurring_schedules", SCHEDULE, { version: version++ })
      }
      return write(e, o)
    }
  }

  test("taken again when another change is written at the same moment", async () => {
    on(2026, 12, 20)
    for (const times of [1, 2]) {
      const h = harness()
      await h.db.insert("recurring_run_items", item())
      losing(h, times)
      expect(await writeSchedulePatch(h.ctx as never, item())).toBe(SCHEDULE)
      expect(h.stored()).toMatchObject({ notes: "Net 30", version: 20 + times })
      expect(runLines(h.stored(), "2027-01")).toEqual([430_000])
    }
  })

  test("that loses each time is never reported as written", async () => {
    on(2026, 12, 20)
    const h = harness()
    await h.db.insert("recurring_run_items", item())
    losing(h, 5)
    await expect(writeSchedulePatch(h.ctx as never, item())).rejects.toThrow("schedule_changed")
    expect(h.stored().notes).toBeUndefined()
    const row = h.db.__all("recurring_run_items")[0] as Row
    expect((row.schedule_patch as Row).written).toBeUndefined()
  })

  test("begins after the issuer's month, not UTC's", async () => {
    // 31 December 23:30 UTC is 1 January in Paris.
    setSystemTime(new Date("2026-12-31T23:30:00Z"))
    const h = harness()
    await h.db.insert("recurring_run_items", item())
    await writeSchedulePatch(h.ctx as never, item())
    expect((await h.month("2027-01")).fee).toEqual([450_000])
    expect((await h.month("2027-02")).fee).toEqual([430_000])
  })

  test("on a schedule off from the month it would start, is the run's from that month", async () => {
    on(2026, 12, 20)
    const h = harness()
    await h.update(OFF)
    // A row of an old month: the month after it is a retainer month, January is the run's.
    await h.db.insert("recurring_run_items", item())
    await writeSchedulePatch(h.ctx as never, item())
    expect(await h.month("2026-12")).toEqual(OLD)
    expect(h.onCard("2027-01")).toBe(false)
    expect(runLines(h.stored(), "2027-01")).toEqual([430_000])
    expect(retainerOffFrom(h.stored())).toBe("2027-01")
  })
})

describe("any sequence of changes, with a run that drafts ahead of its month", () => {
  test("every month is the card's or the run's, never both, never neither", async () => {
    const rand = seeded(329)
    const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T
    let heldWhenOn = 0
    for (let n = 0; n < 150; n++) {
      on(2026, 9, 1)
      const plainFirst = rand() < 0.4
      const day = pick(["1", "2", "15", "last"])
      const h = harness({
        billing_day: day,
        covers: "period_ahead",
        next_issue_on: datesFrom({ repeats: "month", billing_day: day }, "2026-09-03")
          .next_issue_on,
        retainer_from: "2026-09",
        ...(plainFirst ? { ...OFF, retainer_from: null } : {}),
      })
      // The first run invoice, when the month had begun before it.
      const run = new Set<string>(plainFirst && (day === "1" || day === "2") ? ["2026-09"] : [])
      const isOn = () => h.stored().retainer_minutes !== null && isRetainerOn(h.stored())
      const job = async (today: string) => {
        for (let guard = 0; guard < 6; guard++) {
          const s = h.stored() as unknown as ScheduleRow
          const due = String(s.next_issue_on)
          if (draftOn(due) > today) return
          const month = due.slice(0, 7)
          if (await runBills(h.ctx as never, s, due)) {
            expect(run.has(month)).toBe(false)
            run.add(month)
            await h.db.insert("documents", runDoc(month))
            await h.db.update("recurring_schedules", SCHEDULE, {
              ...datesFrom(s, addDays(due, 1)),
            })
          } else {
            const next = await runDatesFrom(h.ctx as never, s, addDays(due, 1))
            if (!(await runBills(h.ctx as never, s, next.next_issue_on))) return
            await h.db.update("recurring_schedules", SCHEDULE, { ...next })
          }
        }
      }
      let today = "2026-09-03"
      for (; today < "2027-04-01"; today = addDays(today, pick([1, 2]))) {
        const [y, m, d] = today.split("-").map(Number) as [number, number, number]
        on(y, m, d)
        const month = today.slice(0, 7)
        const fee = 100_000 + Math.floor(rand() * 900) * 1000
        const change = pick(["none", "none", "off", "on", "fee", "renew", "advance", "job"])
        if (change === "off" && isOn()) await h.update(OFF)
        else if (change === "on" && !isOn()) {
          const r = await h.update({ ...ON, lines: [line(fee)] })
          if (r.retainerOn?.on_run) heldWhenOn += 1
        } else if (change === "fee" && isOn()) await h.update({ lines: [line(fee)] })
        else if (change === "renew" && isOn())
          await h.renew({
            agreementId: crypto.randomUUID(),
            startsOn: `${pick([month, nextMonth(month)])}-01`,
            feeMinor: String(fee),
          })
        else if (change === "advance") {
          const next = nextMonth(month)
          const r = await askAdvance(h, next)
          if (r.status === "completed" && h.stored().retainer_minutes !== null) {
            expect([next, h.onCard(next)]).toEqual([next, true])
            expect(run.has(next)).toBe(false)
          }
        }
        await job(today)
      }
      for (let m = "2026-09"; m < "2027-04"; m = nextMonth(m))
        expect([n, m, run.has(m)]).toEqual([n, m, !h.onCard(m)])
    }
    expect(heldWhenOn).toBeGreaterThan(5)
  })
})

test("the two agreements of the world differ", () => {
  expect(AGREEMENT).not.toBe(AGREEMENT_2)
})
