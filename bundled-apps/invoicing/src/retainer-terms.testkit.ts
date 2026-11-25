// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The retainer schedule the terms suites change: its row, the tools' ctx, and a month as its invoice
// prices it.
import { setSystemTime } from "bun:test"
// The mutations module first: it settles the import order the retainer module relies on.
import "./mutations"
import { retainerPlan } from "./mutations/retainer"
import { isRetainerMonth } from "./recurring/retainer"
import {
  type RecurringCtx,
  recurringList,
  recurringScheduleUpdate,
  retainerTermsRenew,
  type ScheduleUpdateInput,
} from "./recurring/tools"
import { createMockDb } from "./test-db"
import { testTime } from "./test-time"

export type Row = Record<string, unknown>

export const H = 60
export const PROJECT = "7a1d2c3e-0000-4000-8000-000000000001"
export const SCHEDULE = "7a1d2c3e-0000-4000-8000-0000000000f1"
export const AGREEMENT = "7a1d2c3e-0000-4000-8000-0000000000b1"
export const AGREEMENT_2 = "7a1d2c3e-0000-4000-8000-0000000000b2"
export const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  default_currency: "EUR",
  timezone: "Europe/Paris",
}
export const OFF = {
  retainer_minutes: null,
  retainer_project_id: null,
  retainer_overage_rate_minor: null,
}
export const ON = {
  retainer_minutes: 30 * H,
  retainer_project_id: PROJECT,
  retainer_overage_rate_minor: 13_000,
}
export const RENEWAL = {
  projectId: PROJECT,
  agreementId: AGREEMENT,
  agreementNumber: "AG-2026-017",
  startsOn: "2026-12-01",
  minutes: 44 * H,
  feeMinor: "495000",
  overageRateMinor: "12500",
}

export const line = (fee: number, description = "Monthly retainer, 40 h included") => ({
  description,
  qty: 1,
  unit_price_minor: fee,
  vat_bp: 2000,
})

export function schedule(over: Row = {}): Row {
  return {
    id: SCHEDULE,
    issuer_profile_id: ISSUER.id,
    contact_id: "contact-1",
    status: "active",
    repeats: "month",
    billing_day: "last",
    covers: "period_ended",
    issue_mode: "review",
    lines: [line(450_000)],
    retainer_project_id: PROJECT,
    retainer_minutes: 40 * H,
    retainer_overage_rate_minor: 12_000,
    retainer_rollover: "none",
    retainer_from: "2026-01",
    next_issue_on: "2026-12-31",
    version: 3,
    ...over,
  }
}

export const on = (y: number, m: number, d: number) =>
  setSystemTime(new Date(Date.UTC(y, m - 1, d, 12)))

export function harness(over: Row = {}, seed: Record<string, Row[]> = {}) {
  const db = createMockDb({
    bridgeWhereOperators: true,
    seed: { issuer_profiles: [ISSUER], recurring_schedules: [schedule(over)], ...seed },
  })
  const calls: Row[] = []
  const ctx = {
    getUserId: async () => "user-1",
    db: db as never,
    time: testTime(),
    approval: null,
    hasScope: async () => true,
    executeTool: async (target: string, params: Row) => {
      calls.push({ target, ...params })
      return { status: "completed" as const, result: {} }
    },
    emit: async () => {},
  } as unknown as RecurringCtx
  const stored = () => db.__all("recurring_schedules")[0] as Row
  const plan = (m: string, usedMinutes = 100 * H) =>
    retainerPlan({ db } as never, stored(), {
      projectId: PROJECT,
      period: { from: `${m}-01`, to: `${m}-28` },
      usedMinutes,
      timeboxMinutes: null,
      waived: false,
    })
  /** The month as its invoice prices it: fee, overage rate, included hours. */
  const month = async (m: string) => {
    const p = await plan(m)
    const price = (kind: string) =>
      p.items
        .filter((i) => String(i.external_id).startsWith(`retainer_${kind}:`))
        .map((i) => Number(i.unit_price_minor))
    return { fee: price("fee"), rate: price("overage")[0], hours: p.fig.includedMinutes / H }
  }
  // As the editor and an agent send it: on the version the schedule holds.
  const tryUpdate = (patch: Omit<ScheduleUpdateInput, "id">) =>
    recurringScheduleUpdate(ctx, {
      id: SCHEDULE,
      expected_version: Number(stored().version),
      ...patch,
    })
  const update = async (patch: Omit<ScheduleUpdateInput, "id">) => {
    const r = await tryUpdate(patch)
    if (r.status !== "completed") throw new Error(JSON.stringify(r))
    return r
  }
  const renew = (over: Partial<typeof RENEWAL> = {}) =>
    retainerTermsRenew(ctx, { ...RENEWAL, ...over })
  const listed = async () => (await recurringList(ctx, {})).rows[0] as unknown as Row
  const onCard = (m: string) => isRetainerMonth(stored(), m)
  return { ctx, db, calls, stored, plan, month, tryUpdate, update, renew, listed, onCard }
}

/** A repeatable random source (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
