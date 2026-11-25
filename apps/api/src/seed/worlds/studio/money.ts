// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's money, as a pure function of the anchor: the issuer, the year's invoices in
// the one order they were issued, the fixed-price project's billing plan with its quote, and
// the two monthly schedules. No database, no wall
// clock: the layer writes exactly this, and `plan-invariants.test.ts` holds it to the world's
// figures without seeding anything.
//
// The year's invoices are one chronological loop: the named ones sit at the dates their story
// gives them (the advance on the plan's quote, the first two milestones once each closed, the
// retainer's last month on its last weekday), and the studio's other work for earlier clients
// fills the days between, so numbers run from 0001 with no gap and dates never decrease.
// Numbers are per year of issue, as the invoicing app numbers them.
//
// The figures:
// - the portal's billing plan: an advance of 20% of 64,000 (12,800), three milestones of
//   16,000, and Launch at 16,000 less the advance (3,200); invoiced 12,800 + 16,000 + 16,000;
// - the publishing retainer: 4,500 a month for 40 h, 120 an hour above; last month 46 h, so
//   6 h above: 4,500 + 720 = 5,220 excluding VAT, 6,264.00 with it;
// - the smaller retainer: 1,200 a month for 10 h, billed before the month: a plain monthly
//   schedule on the 1st, as the invoicing app runs one (each run bills the month that holds its
//   billing day), so the month that started is invoiced and the next date is the app's.
import { addCalendarDays, isoWeekdayOf } from "@liaison/shared"
import { STUDIO_PAST_CLIENTS } from "./fiction"
import { parisCivil } from "./plan"

/** The invoice series' prefix, `F-<year>-`, as the issuer profile stores it. */
export const STUDIO_INVOICE_PREFIX = "F-{YYYY}-"
/** French VAT on services, in basis points. */
export const STUDIO_VAT_BP = 2000
/** Payment terms of every invoice, in days. */
export const STUDIO_TERMS_DAYS = 30

export interface StudioInvoiceLine {
  description: string
  quantity: number
  unitPriceMinor: number
  /** The source key a line carries on the product's own documents. */
  externalId?: string
}

export type StudioInvoiceKind =
  | "filler"
  | "project"
  | "advance"
  | "milestone"
  | "retainer"
  | "schedule"

export interface StudioInvoice {
  key: string
  kind: StudioInvoiceKind
  year: number
  numberInt: number
  /** `F-2026-0201`. */
  number: string
  /** Paris civil date of issue. */
  issuedOn: string
  /** Paris civil date the money came in, or null while it is due. */
  paidOn: string | null
  /** A client key (`STUDIO_CLIENTS`) or an earlier client's (`STUDIO_PAST_CLIENTS`). */
  client: string
  /** The project it bills, for the named invoices. */
  projectKey?: string
  /** Its billing step (`StudioBillingStep.key`), for the plan's invoices. */
  stepKey?: string
  /** The plain monthly schedule (`StudioRetainerPlan.key`) whose run issued it. */
  scheduleKey?: string
  invoiceRole: "standard" | "advance"
  servicePeriod?: { start: string; end: string }
  lines: StudioInvoiceLine[]
}

export interface StudioBillingStep {
  key: string
  position: number
  kind: "advance" | "milestone" | "final"
  label: string
  amountMinor: number
  /** The milestone task the step is invoiced on. */
  taskKey?: string
  state: "planned" | "drafted" | "issued" | "paid"
  /** The invoice it was issued as, or the draft it waits on. */
  invoiceKey?: string
}

export interface StudioRetainerPlan {
  key: string
  project: string
  client: string
  /** Customer key of the contact the invoices go to. */
  contactKey: string
  feeMinor: number
  /** The schedule's line; the app fills `{period}` with the month a run bills. */
  feeLabel: string
  /** The schedule's billing day: `last`, or a day of the month. */
  billingDay: string
  includedMinutes: number | null
  overageRateMinor: number | null
  /** Billed after the month, or before it (prepaid). */
  covers: "period_ended" | "period_ahead"
  /** The month the schedule bills by the retainer from, `YYYY-MM`. */
  from: string
  /** The next month it bills, and the day its draft is made. */
  nextIssueOn: string
  nextDraftOn: string
}

export interface StudioMoneyPlan {
  /** Paris civil date of the anchor. */
  today: string
  invoices: StudioInvoice[]
  quote: {
    key: string
    issuedOn: string
    acceptedOn: string
    client: string
    contactKey: string
    projectKey: string
    lines: StudioInvoiceLine[]
  }
  steps: StudioBillingStep[]
  retainers: StudioRetainerPlan[]
  /** Last month on the publishing retainer, as its card billed it. */
  retainerLastMonth: {
    month: string
    usedMinutes: number
    overageMinutes: number
    invoiceKey: string
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0")

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function dayDiff(from: string, to: string): number {
  const ms = (c: string) => {
    const [y, m, d] = c.split("-").map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((ms(to) - ms(from)) / 86_400_000)
}

/** The month `back` months before the anchor's: its year, month and dates. */
function monthOf(today: string, back: number) {
  const [ty, tm] = today.split("-").map(Number) as [number, number]
  const index = ty * 12 + (tm - 1) - back
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const last = daysInMonth(year, month)
  return {
    key: `${year}-${pad(month)}`,
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${pad(last)}`,
    date: (day: number) => `${year}-${pad(month)}-${pad(Math.min(day, last))}`,
  }
}

/** The last Monday-to-Friday day of a month. */
function lastWeekday(end: string): string {
  let d = end
  while (isoWeekdayOf(d) > 5) d = addCalendarDays(d, -1)
  return d
}

/**
 * A monthly schedule's billing day in a month, as invoicing works it out: `last`, or the day
 * (a day past the month's end is its last). An issue day never moves, even onto a weekend.
 */
function billingDayIn(billingDay: string, month: ReturnType<typeof monthOf>): string {
  return billingDay === "last" ? month.end : month.date(Number(billingDay))
}

/** The first billing day on or after `onOrAfter`, as invoicing's `nextIssueOn` (monthly). */
function nextBillingDay(billingDay: string, onOrAfter: string): string {
  for (let ahead = 0; ; ahead--) {
    const day = billingDayIn(billingDay, monthOf(onOrAfter, ahead))
    if (day >= onOrAfter) return day
  }
}

/** The last billing day before `today`: the day the latest run issued. */
function lastBillingDayBefore(billingDay: string, today: string): string {
  for (let back = 0; ; back++) {
    const day = billingDayIn(billingDay, monthOf(today, back))
    if (day < today) return day
  }
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** How invoicing fills a line's `{period}` for a month: `November 2026`. */
function periodLabel(day: string): string {
  return `${MONTH_NAMES[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`
}

/** The day a schedule drafts the invoice it issues on `issueOn`, as invoicing works it out:
 *  three days before, a weekend moved back to its Friday. */
function draftDayOf(issueOn: string): string {
  let d = addCalendarDays(issueOn, -3)
  while (isoWeekdayOf(d) > 5) d = addCalendarDays(d, -1)
  return d
}

/** A Saturday or Sunday moves back to its Friday, never before `floor`. */
function onWorkday(civil: string, floor: string): string {
  const wd = isoWeekdayOf(civil)
  const moved = wd > 5 ? addCalendarDays(civil, 5 - wd) : civil
  return moved < floor ? floor : moved
}

/** A Saturday or Sunday moves on to its Monday. */
function nextWorkday(civil: string): string {
  const wd = isoWeekdayOf(civil)
  return wd > 5 ? addCalendarDays(civil, 8 - wd) : civil
}

/** The studio's other work, billed by the day: what one filler invoice bills. */
function fillerLines(i: number): StudioInvoiceLine[] {
  const days = 2 + ((i * 7) % 9)
  const rateMinor = 85_000 + ((i * 3) % 5) * 2_500
  const what = ["Development", "Data work", "Maintenance", "Design", "Support"][i % 5] as string
  return [{ description: `${what}, ${days} days`, quantity: days, unitPriceMinor: rateMinor }]
}

/** The money plan at an anchor. */
export function studioMoney(anchor: Date): StudioMoneyPlan {
  const today = parisCivil(anchor)
  const lastMonth = monthOf(today, 1)

  // The named invoices, at the dates their story gives them.
  const advanceOn = nextWorkday(monthOf(today, 7).date(16))
  const discoveryOn = nextWorkday(monthOf(today, 6).date(27))
  const designOn = nextWorkday(monthOf(today, 5).date(29))
  const retainerOn = lastWeekday(lastMonth.end)
  const yearStart = nextWorkday(monthOf(today, 10).date(2))
  const paidAfter = (issuedOn: string) => {
    const paid = addCalendarDays(issuedOn, STUDIO_TERMS_DAYS)
    return paid < today ? paid : null
  }

  const named: Array<Omit<StudioInvoice, "year" | "numberInt" | "number">> = [
    {
      key: "marlin-advance",
      kind: "advance",
      issuedOn: advanceOn,
      // Paid the day it was issued: the client paid the advance with its signature.
      paidOn: advanceOn,
      client: "marlin",
      projectKey: "MARLIN",
      stepKey: "advance",
      invoiceRole: "advance",
      lines: [
        {
          description: "Advance on the partner portal rebuild, 20% of the fixed price",
          quantity: 1,
          unitPriceMinor: 1_280_000,
          externalId: "advance",
        },
      ],
    },
    {
      key: "marlin-discovery",
      kind: "milestone",
      issuedOn: discoveryOn,
      paidOn: paidAfter(discoveryOn),
      client: "marlin",
      projectKey: "MARLIN",
      stepKey: "discovery",
      invoiceRole: "standard",
      lines: [{ description: "Discovery", quantity: 1, unitPriceMinor: 1_600_000 }],
    },
    {
      key: "marlin-design",
      kind: "milestone",
      issuedOn: designOn,
      paidOn: paidAfter(designOn),
      client: "marlin",
      projectKey: "MARLIN",
      stepKey: "design",
      invoiceRole: "standard",
      lines: [{ description: "Design", quantity: 1, unitPriceMinor: 1_600_000 }],
    },
    {
      key: "sorel-retainer-last-month",
      kind: "retainer",
      issuedOn: retainerOn,
      paidOn: null,
      client: "sorel",
      projectKey: "SOREL",
      invoiceRole: "standard",
      servicePeriod: { start: lastMonth.start, end: lastMonth.end },
      lines: [
        {
          description: "Publishing retainer, 40 hours included",
          quantity: 1,
          unitPriceMinor: 450_000,
        },
        {
          description: `Hours above the retainer, ${lastMonth.key}`,
          quantity: 6,
          unitPriceMinor: 12_000,
        },
      ],
    },
  ]
  // How many of the studio's other invoices come before each named one, then the named one.
  const fillersBefore = [200, 61, 133, 114]

  const loop: Array<Omit<StudioInvoice, "year" | "numberInt" | "number">> = []
  let from = yearStart
  let fillerIndex = 0
  named.forEach((n, k) => {
    const count = fillersBefore[k] as number
    const span = dayDiff(from, n.issuedOn)
    for (let i = 0; i < count; i++) {
      const raw = addCalendarDays(from, Math.floor(((i + 1) * span) / (count + 1)))
      const issuedOn = onWorkday(raw, from)
      const client = STUDIO_PAST_CLIENTS[fillerIndex % STUDIO_PAST_CLIENTS.length]?.key as string
      loop.push({
        key: `filler-${pad(fillerIndex + 1, 4)}`,
        kind: "filler",
        issuedOn,
        paidOn: paidAfter(issuedOn),
        client,
        invoiceRole: "standard",
        lines: fillerLines(fillerIndex),
      })
      fillerIndex++
    }
    loop.push(n)
    from = n.issuedOn
  })

  // The past client's audit, at a fixed price of 18,500: half when it started, the balance
  // once its report was delivered. Each takes the place of the studio's other work on its day,
  // so the numbering and the dates stay as they were.
  const audit: Array<{ key: string; on: string; label: string }> = [
    { key: "vallee-audit-start", on: monthOf(today, 4).date(6), label: "50% at the start" },
    {
      key: "vallee-audit-balance",
      on: monthOf(today, 2).date(21),
      label: "balance, report delivered",
    },
  ]
  for (const a of audit) {
    const at = loop.findIndex((inv) => inv.kind === "filler" && inv.issuedOn >= a.on)
    const filler = loop[at]
    if (!filler) throw new Error(`studio money: no invoice day for ${a.key}`)
    loop[at] = {
      ...filler,
      key: a.key,
      kind: "project",
      client: "vallee",
      projectKey: "VALLEE",
      lines: [
        { description: `Data pipeline audit, ${a.label}`, quantity: 1, unitPriceMinor: 925_000 },
      ],
    }
  }

  // The upkeep's latest run: the last billing day before today, billing the month that holds it.
  const upkeep = UPKEEP_SCHEDULE
  const upkeepOn = lastBillingDayBefore(upkeep.billingDay, today)
  const upkeepMonth = monthOf(upkeepOn, 0)
  const upkeepInvoice: Omit<StudioInvoice, "year" | "numberInt" | "number"> = {
    key: "verdier-upkeep-last-run",
    kind: "schedule",
    issuedOn: upkeepOn,
    paidOn: paidAfter(upkeepOn),
    client: upkeep.client,
    scheduleKey: upkeep.key,
    invoiceRole: "standard",
    servicePeriod: { start: upkeepMonth.start, end: upkeepMonth.end },
    lines: [
      {
        description: upkeep.feeLabel.split("{period}").join(periodLabel(upkeepOn)),
        quantity: 1,
        unitPriceMinor: upkeep.feeMinor,
      },
    ],
  }
  // After every invoice issued on or before its day: invoicing numbers in issue order.
  const at = loop.findIndex((inv) => inv.issuedOn > upkeepOn)
  loop.splice(at === -1 ? loop.length : at, 0, upkeepInvoice)

  // Numbered in issue order, per year of issue, as the app numbers them.
  const counters = new Map<number, number>()
  const invoices: StudioInvoice[] = loop.map((inv) => {
    const year = Number(inv.issuedOn.slice(0, 4))
    const numberInt = (counters.get(year) ?? 0) + 1
    counters.set(year, numberInt)
    return { ...inv, year, numberInt, number: `F-${year}-${pad(numberInt, 4)}` }
  })
  const byKey = (key: string) => invoices.find((i) => i.key === key)

  const steps: StudioBillingStep[] = [
    {
      key: "advance",
      position: 1,
      kind: "advance",
      label: "Advance, 20%",
      amountMinor: 1_280_000,
      state: "paid",
      invoiceKey: "marlin-advance",
    },
    {
      key: "discovery",
      position: 2,
      kind: "milestone",
      label: "Discovery",
      amountMinor: 1_600_000,
      taskKey: "MARLIN-1",
      state: byKey("marlin-discovery")?.paidOn ? "paid" : "issued",
      invoiceKey: "marlin-discovery",
    },
    {
      key: "design",
      position: 3,
      kind: "milestone",
      label: "Design",
      amountMinor: 1_600_000,
      taskKey: "MARLIN-8",
      state: byKey("marlin-design")?.paidOn ? "paid" : "issued",
      invoiceKey: "marlin-design",
    },
    {
      key: "beta",
      position: 4,
      kind: "milestone",
      label: "Beta",
      amountMinor: 1_600_000,
      taskKey: "MARLIN-19",
      // Its task is still in progress, so nothing is drafted for it yet.
      state: "planned",
    },
    {
      key: "launch",
      position: 5,
      kind: "final",
      label: "Launch",
      amountMinor: 1_600_000,
      taskKey: "MARLIN-36",
      state: "planned",
    },
  ]

  return {
    today,
    invoices,
    quote: {
      key: "marlin-quote",
      issuedOn: monthOf(today, 8).date(20),
      acceptedOn: monthOf(today, 7).date(14),
      client: "marlin",
      contactKey: "pauline-gros",
      projectKey: "MARLIN",
      lines: [
        { description: "Discovery", quantity: 1, unitPriceMinor: 1_600_000 },
        { description: "Design", quantity: 1, unitPriceMinor: 1_600_000 },
        { description: "Beta", quantity: 1, unitPriceMinor: 1_600_000 },
        { description: "Launch", quantity: 1, unitPriceMinor: 1_600_000 },
      ],
    },
    steps,
    retainers: [
      {
        key: "sorel",
        project: "SOREL",
        client: "sorel",
        contactKey: "thomas-blanc",
        feeMinor: 450_000,
        feeLabel: "Publishing retainer, 40 hours included",
        includedMinutes: 40 * 60,
        overageRateMinor: 12_000,
        billingDay: "last",
        covers: "period_ended",
        from: monthOf(today, 3).key,
        // Billed from its planned vs done card, never by a run: the next billing day from today.
        nextIssueOn: nextBillingDay("last", today),
        nextDraftOn: draftDayOf(nextBillingDay("last", today)),
      },
      {
        ...UPKEEP_SCHEDULE,
        covers: "period_ahead",
        from: monthOf(upkeepOn, 0).key,
        // The app's rule after a run: the next billing day after the one it issued.
        nextIssueOn: nextBillingDay(UPKEEP_SCHEDULE.billingDay, addCalendarDays(upkeepOn, 1)),
        nextDraftOn: draftDayOf(
          nextBillingDay(UPKEEP_SCHEDULE.billingDay, addCalendarDays(upkeepOn, 1)),
        ),
      },
    ],
    retainerLastMonth: {
      month: lastMonth.key,
      usedMinutes: 46 * 60,
      overageMinutes: 6 * 60,
      invoiceKey: "sorel-retainer-last-month",
    },
  }
}

/**
 * The smaller retainer, a plain monthly schedule (its project is at a fixed price): billed on
 * the 1st, before the month it bills is worked.
 */
const UPKEEP_SCHEDULE = {
  key: "verdier",
  project: "VERD",
  client: "verdier",
  contactKey: "marc-verdier",
  feeMinor: 120_000,
  feeLabel: "Route planning upkeep, {period}",
  billingDay: "1",
  includedMinutes: null,
  overageRateMinor: null,
} as const

/** Excluding VAT and with it, in minor units, as the app rounds a line's tax (half to even). */
export function invoiceTotals(lines: readonly StudioInvoiceLine[]): {
  exclMinor: number
  vatMinor: number
  inclMinor: number
} {
  let excl = 0
  let vat = 0
  for (const l of lines) {
    const sub = l.unitPriceMinor * l.quantity
    excl += sub
    const raw = (sub * STUDIO_VAT_BP) / 10_000
    const floor = Math.floor(raw)
    const rest = raw - floor
    vat += rest > 0.5 || (rest === 0.5 && floor % 2 === 1) ? floor + 1 : floor
  }
  return { exclMinor: excl, vatMinor: vat, inclMinor: excl + vat }
}
