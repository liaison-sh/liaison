// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A retainer renewed by a signed agreement: the new hours, fee and overage rate apply from the
// period the agreement starts (never before the next one), on the same schedule and project.
// The months before keep the old terms, so no month is billed on two sets of terms, and the
// project's timebox for the first renewed month carries the new hours.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
// The mutations module first: it settles the import order the retainer module relies on.
import { invoiceIssue } from "./mutations"
import { retainerPlan } from "./mutations/retainer"
import { termsForMonth } from "./recurring/retainer"
import { type RecurringCtx, retainerTermsRenew } from "./recurring/tools"
import { retainerTimeboxRoll } from "./retainer-timebox-roll"
import { createMockDb } from "./test-db"
import { testTime } from "./test-time"

type Row = Record<string, unknown>

const H = 60
const PROJECT = "7a1d2c3e-0000-4000-8000-000000000001"
const OTHER_PROJECT = "7a1d2c3e-0000-4000-8000-000000000002"
const SCHEDULE = "7a1d2c3e-0000-4000-8000-0000000000f1"
const AGREEMENT = "7a1d2c3e-0000-4000-8000-0000000000b1"
const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  default_currency: "EUR",
  timezone: "Europe/Paris",
}

function schedule(over: Row = {}): Row {
  return {
    id: SCHEDULE,
    issuer_profile_id: ISSUER.id,
    contact_id: "contact-1",
    status: "active",
    repeats: "month",
    billing_day: "last",
    covers: "period_ended",
    issue_mode: "review",
    lines: [
      {
        description: "Monthly retainer, 40 h included",
        qty: 1,
        unit_price_minor: 450_000,
        vat_bp: 2000,
      },
    ],
    retainer_project_id: PROJECT,
    retainer_minutes: 40 * H,
    retainer_overage_rate_minor: 12_000,
    retainer_rollover: "none",
    retainer_from: "2026-01",
    version: 3,
    ...over,
  }
}

function harness(opts: { scopes?: string[]; schedules?: Row[] } = {}) {
  const db = createMockDb({
    seed: { issuer_profiles: [ISSUER], recurring_schedules: opts.schedules ?? [schedule()] },
  })
  const calls: Row[] = []
  const scopes = new Set(opts.scopes ?? ["invoicing:documents:write", "projects:money:write"])
  const ctx = {
    getUserId: async () => "user-1",
    db: db as never,
    time: testTime(),
    approval: null,
    hasScope: async (s: string) => scopes.has(s),
    executeTool: async (target: string, params: Row) => {
      calls.push({ target, ...params })
      return { status: "completed" as const, result: {} }
    },
    emit: async () => {},
  } as unknown as RecurringCtx
  return { ctx, db, calls }
}

const RENEWAL = {
  projectId: PROJECT,
  agreementId: AGREEMENT,
  agreementNumber: "AG-2026-017",
  startsOn: "2026-12-01",
  minutes: 44 * H,
  feeMinor: "495000",
  overageRateMinor: "12500",
}

const timeboxWrites = (calls: Row[]) =>
  calls.filter((c) => c.target === "projects:period_timebox_set").map((c) => [c.month, c.timebox])

describe("a retainer renewed by a signed agreement", () => {
  test("the module loads with the issue path beside it", () => {
    expect(typeof invoiceIssue).toBe("function")
  })

  afterEach(() => setSystemTime())

  test("signed on 19 Nov from 1 Dec: November keeps 40 h at 4,500.00, December takes 44 h at 4,950.00", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 19, 12)))
    const h = harness()
    const out = await retainerTermsRenew(h.ctx, RENEWAL)
    expect(out).toMatchObject({ status: "completed", scheduleId: SCHEDULE, from: "2026-12" })
    expect(String((out as { message?: string }).message)).toContain("AG-2026-017")
    const [row] = h.db.__all("recurring_schedules") as Row[]
    // The base terms are untouched: November is billed on them.
    expect(row).toMatchObject({ retainer_minutes: 40 * H, version: 4 })
    const nov = termsForMonth(row as Row, "2026-11")
    const dec = termsForMonth(row as Row, "2026-12")
    const jan = termsForMonth(row as Row, "2027-01")
    expect([nov.retainer_minutes, dec.retainer_minutes, jan.retainer_minutes]).toEqual([
      40 * H,
      44 * H,
      44 * H,
    ])
    expect(Number(dec.retainer_overage_rate_minor)).toBe(12_500)
    // December's timebox on the project carries the new hours now.
    expect(timeboxWrites(h.calls)).toEqual([["2026-12", "44h"]])

    // The month's invoice is priced on that month's terms.
    const plan = async (month: string) =>
      retainerPlan({ db: h.db } as never, row as Row, {
        projectId: PROJECT,
        period: { from: `${month}-01`, to: `${month}-28` },
        usedMinutes: 0,
        timeboxMinutes: null,
        waived: false,
      })
    const fee = (p: Awaited<ReturnType<typeof plan>>) =>
      p.items
        .filter((i) => String(i.external_id).startsWith("retainer_fee:"))
        .map((i) => Number(i.unit_price_minor))
    expect(fee(await plan("2026-11"))).toEqual([450_000])
    expect(fee(await plan("2026-12"))).toEqual([495_000])
    expect((await plan("2026-12")).fig.includedMinutes).toBe(44 * H)
  })

  test("the same agreement renewing again changes nothing more", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 19, 12)))
    const h = harness()
    await retainerTermsRenew(h.ctx, RENEWAL)
    const again = await retainerTermsRenew(h.ctx, RENEWAL)
    expect(again).toMatchObject({ status: "completed", from: "2026-12", unchanged: true })
    const [row] = h.db.__all("recurring_schedules") as Row[]
    expect(row?.version).toBe(4)
    expect(timeboxWrites(h.calls)).toHaveLength(1)
  })

  test("a renewal signed after its start applies from the next period, never to a month already running", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 19, 12)))
    const h = harness()
    const out = await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2026-11-01" })
    expect(out).toMatchObject({ status: "completed", from: "2026-12" })
    const [row] = h.db.__all("recurring_schedules") as Row[]
    expect(termsForMonth(row as Row, "2026-11").retainer_minutes).toBe(40 * H)
  })

  test("the daily roll gives the renewed hours to each month from the renewal on", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 19, 12)))
    const h = harness()
    await retainerTermsRenew(h.ctx, { ...RENEWAL, startsOn: "2027-01-01" })
    // In November the next month (December) still gets the old hours.
    await retainerTimeboxRoll(h.ctx as never)
    expect(timeboxWrites(h.calls)).toEqual([["2026-12", "40h"]])
    setSystemTime(new Date(Date.UTC(2026, 11, 2, 12)))
    await retainerTimeboxRoll(h.ctx as never)
    expect(timeboxWrites(h.calls).at(-1)).toEqual(["2027-01", "44h"])
  })

  test("no retainer on the project, or a person without the projects money scope: nothing changes", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 19, 12)))
    const none = harness()
    expect(
      await retainerTermsRenew(none.ctx, { ...RENEWAL, projectId: OTHER_PROJECT }),
    ).toMatchObject({
      status: "error",
      error: { code: "no_retainer_schedule" },
    })
    const finance = harness({ scopes: ["invoicing:documents:write"] })
    expect(await retainerTermsRenew(finance.ctx, RENEWAL)).toMatchObject({
      status: "error",
      error: { code: "retainer_needs_project_money" },
    })
    expect((finance.db.__all("recurring_schedules")[0] as Row).version).toBe(3)
    expect(finance.calls).toHaveLength(0)
  })
})
