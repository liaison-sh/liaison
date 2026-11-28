// SPDX-License-Identifier: FSL-1.1-ALv2
//
// retainer_draft_from_reconcile: the invoice draft of one retainer month, made when a person
// presses Create invoice on the month's planned vs done card. Internal: only the projects app
// calls it, through its declared cross-app call.
//
// - One draft per schedule and month: its key is `retainer:<schedule>:<YYYY-MM>` (unique), so a
//   retry returns the same draft. A month the month-end run already drafted or issued
//   (`recurring:<schedule>:<YYYY-MM>`) is refused: a month is billed by one or the other.
// - The fee is the schedule's own lines. Overage = max(0, used - included - rolled in) at the
//   overage rate, where "used" is what the card bills; under the timebox there is no overage line.
//   A waived card bills no overage at all: its month's, nor an earlier month's on it.
// - Hours of an earlier month told after its invoice bill on the next card of the project, as that
//   month's: its included and rolled-in hours first, then its own overage rate. The card may be
//   another schedule's, a month that bills no retainer (a draft of those hours alone), or one billed
//   by the day or the hour.
// - Rollover `next`: the month before passes its unused included hours, at most the timebox.
// - Prepaid (`covers = period_ahead`): the month's fee was invoiced ahead as an advance, so the
//   month-end draft is a final that deducts it; the overage bills on it; it may total zero.
// - It takes no number: the draft gets the same issue approval as any draft from planned vs done.

import { buildActivityReport } from "../activity-report"
import { lineQuantity } from "../line-amount"
import { formatMoneyMinor } from "../money"
import { scheduleTermsDays } from "../payment-terms"
import { recipientOf } from "../recipient"
import { RECIPIENT_GAP_REFUSAL, recipientGaps } from "../recipient-gaps"
import { monthOnRun, retainerScheduleOf } from "../recurring/project-retainer"
import {
  hoursText,
  isPrepaidMonth,
  isRetainerMonth,
  type LateHours,
  lastRetainerMonth,
  monthOf,
  previousMonth,
  type RetainerRefs,
  retainerDocumentRef,
  retainerMonth,
  retainerRefsOf,
  rolloverOut,
  termsForMonth,
} from "../recurring/retainer"
import {
  advanceRemaining,
  type DeductionLine,
  draftTotals,
  pendingIssueApproval,
  raiseIssueApproval,
  renderDeductionLines,
} from "./billing-plan"
import { ISSUED_INVOICE_STATUSES } from "./credit-coverage"
import { resolveIssuerProfileOrError } from "./db-helpers"
import { draftsCreate, draftsDiscard } from "./drafts"
import { notOverLine } from "./from-reconcile"
import { heldText, raiseOnePerProject } from "./prepaid-hold"
import { isUniqueViolation } from "./quote-proforma-po"
import type { MutationsCtx } from "./shared"

type Row = Record<string, unknown>

/** The last day of the month of a YYYY-MM-DD day. */
function monthEnd(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${day.slice(0, 8)}${String(last).padStart(2, "0")}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ISSUED = ISSUED_INVOICE_STATUSES

export interface RetainerDraftInput {
  reconciliationId?: string
  revision?: number
  waiveOverage?: boolean
  /** The month bills no retainer: the draft is an earlier month's later hours alone. */
  lateOnly?: boolean
  /** The contact the invoice goes to when the schedule names none (projects resolves the
   *  company's billing contact). */
  contactId?: string | null
}

type Ctx = MutationsCtx & { logger?: { warn?: (m: string, d?: Row) => void } }

export type RetainerDraftResult =
  | {
      status: "completed"
      draftId: string
      draftTitle: string
      approvalId: string | null
      approved: boolean
      created: boolean
      scheduleId: string
      month: string
      retainer: RetainerRefs
      totals: { excl: number; vat: number; incl: number; currency: string }
      message: string
    }
  | { status: "error"; error: { code: string; message: string; retryable: false } }

/** A document's external_refs, as stored (an object, or its JSON text). */
function refsOf(doc: Row): Row {
  const raw = doc.external_refs
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === "object" ? (parsed as Row) : {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === "object" ? (raw as Row) : {}
}

const refuse = (code: string, message: string): RetainerDraftResult => ({
  status: "error",
  error: { code, message, retryable: false },
})

interface LinesRead {
  projectId: string
  projectName?: string
  companyId?: string | null
  /** The contact the invoice goes to: the one named on the card, else the company's billing one. */
  contactId?: string | null
  basis: string
  state: string
  revision: number
  documentRef: string | null
  period: { from: string; to: string }
  timeboxMinutes?: number | null
  lines: Array<{
    lineId: string
    wording: string
    billMinutes: number
    /** The earlier retainer month the hours were worked in, after its invoice. */
    workMonth?: string
    proofLabels?: string[]
  }>
}

type DbCtx = Pick<MutationsCtx, "db">

async function one(ctx: DbCtx, table: string, where: Row): Promise<Row | null> {
  const rows = (await ctx.db.findMany(table, { where, limit: 1 })) as Row[]
  return rows[0] ?? null
}

/** Who a retainer's invoice goes to: the schedule's contact and company, else the card's. */
export function retainerRecipient(
  s: Row,
  card: { contactId: string | null; companyId: string | null },
): { contactId: string | null; companyId: string | null } {
  return {
    contactId:
      typeof s.contact_id === "string" && s.contact_id !== "" ? s.contact_id : card.contactId,
    companyId:
      typeof s.company_id === "string" && s.company_id !== "" ? s.company_id : card.companyId,
  }
}

export { monthOnRun, retainerScheduleOf } from "../recurring/project-retainer"

/** The hours rolled in from the month before: its unused included hours, read from its invoice. */
async function rolledIn(ctx: DbCtx, s: Row, month: string, included: number, lateMinutes: number) {
  if (s.retainer_rollover !== "next") return 0
  const prev = retainerRefsOf(
    await one(ctx, "documents", {
      external_ref: retainerDocumentRef(String(s.id), previousMonth(month)),
    }),
  )
  if (!prev) return 0
  return Math.min(
    included,
    rolloverOut("next", prev.included_minutes, prev.used_minutes + lateMinutes),
  )
}

function scheduleLines(
  s: Row,
): Array<{ description: string; qty: number; unit_price_minor: number; vat_bp: number }> {
  const raw = typeof s.lines === "string" ? JSON.parse(s.lines) : s.lines
  return (Array.isArray(raw) ? raw : []) as never
}

/**
 * The issued advances of a prepaid month not yet deducted: the month's fee paid ahead. An advance
 * belongs to the month of its service period (advance_draft_create dates it), never to the month
 * it was issued in; a credited one is deducted for what remains of it.
 */
async function prepaidAdvances(
  ctx: DbCtx,
  projectId: string,
  period: { from: string; to: string },
): Promise<Array<{ doc: Row; lines: Row[] }>> {
  const docs = (await ctx.db.findMany("documents", {
    where: { billing_project_id: projectId, invoice_role: "advance" },
    limit: 500,
  })) as Row[]
  const out: Array<{ doc: Row; lines: Row[] }> = []
  for (const d of docs) {
    if (!ISSUED.has(String(d.status))) continue
    const start = typeof d.service_period_start === "string" ? d.service_period_start : ""
    if (!(start >= period.from && start <= period.to)) continue
    const taken = (await ctx.db.findMany("advance_deductions", {
      where: { advance_document_id: String(d.id) },
      limit: 20,
    })) as Row[]
    if (taken.some((t) => t.state !== "released")) continue
    const total = absBig(d.grand_total_minor)
    const remaining = total === 0n ? 0n : await advanceRemaining(ctx, d)
    if (total !== 0n && remaining <= 0n) continue
    const lines = (await ctx.db.findMany("document_lines", {
      where: { document_id: String(d.id) },
      limit: 200,
    })) as Row[]
    out.push({
      doc: d,
      lines:
        total !== 0n && remaining < total
          ? lines.map((l) => ({
              ...l,
              subtotal_minor: (asBig(l.subtotal_minor) * remaining) / total,
            }))
          : lines,
    })
  }
  return out
}

const asBig = (v: unknown): bigint => {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v))
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  return 0n
}
const absBig = (v: unknown): bigint => {
  const n = asBig(v)
  return n < 0n ? -n : n
}

export interface LateLine extends LateHours {
  scheduleId: string
  rate: bigint
  vat: number
}

type Standing = ReadonlyArray<{ refs: RetainerRefs }>
type LateInput = ReadonlyArray<{ month: string; minutes: number }>

/** The standing invoice of a month: never a document that only bills its later hours. */
const invoiceOf = (standing: Standing, m: string) =>
  standing.find((d) => d.refs.month === m && !d.refs.late_only)?.refs

const lateSum = (standing: Standing, m: string, of: (l: LateHours) => number): number =>
  standing.reduce(
    (a, d) => a + (d.refs.late ?? []).reduce((b, l) => b + (l.month === m ? of(l) : 0), 0),
    0,
  )

const lateMinutesIn = (standing: Standing, month: string): number =>
  lateSum(standing, month, (l) => l.minutes)

/** The later hours of a month already billed, or waived, above what it held. */
const lateAboveIn = (standing: Standing, month: string): number =>
  lateSum(standing, month, (l) => l.overage_minutes + (l.waived_minutes ?? 0))

/**
 * The schedule a month of the project belongs to: the one its invoice was made from, else the one
 * the month is a retainer month of.
 */
async function scheduleOfMonth(ctx: DbCtx, projectId: string, standing: Standing, month: string) {
  const id = invoiceOf(standing, month)?.schedule_id
  const row = id ? await one(ctx, "recurring_schedules", { id }) : null
  if (row) return row
  const s = await retainerScheduleOf(ctx, projectId, month)
  return s && isRetainerMonth(s, month) ? s : null
}

/**
 * The part of each earlier month's late hours above what that month still held: its included hours
 * and the ones rolled into it, less what its invoice and earlier late hours used, less what the
 * month after already took of the hours it rolled on. No hour is included twice, none billed twice.
 * Hours told two months later or more may bill less than they would have on time (a month after
 * took the hours it rolled on), never more. Read over every retainer schedule of the project.
 */
export async function lateHoursOf(
  ctx: DbCtx,
  projectId: string,
  late: LateInput,
  before: string,
  standing: Standing,
  waived: boolean,
): Promise<{ lines: LateLine[]; unknown: string[] }> {
  const months = late.filter((l) => l.month < before && l.minutes > 0)
  const here = (m: string) => late.reduce((a, l) => a + (l.month === m ? l.minutes : 0), 0)
  const schedules = new Map<string, Row | null>()
  for (const m of new Set(months.flatMap((l) => [l.month, previousMonth(l.month)])))
    schedules.set(m, await scheduleOfMonth(ctx, projectId, standing, m))
  const termsOf = (m: string) => {
    const s = schedules.get(m)
    return s ? termsForMonth(s, m) : null
  }
  const includedOf = (m: string) =>
    invoiceOf(standing, m)?.included_minutes ?? Number(termsOf(m)?.retainer_minutes ?? 0)
  const usedOf = (m: string) =>
    (invoiceOf(standing, m)?.used_minutes ?? 0) + lateMinutesIn(standing, m)
  /** The hours of a month already billed, or waived, above what it held. */
  const aboveOf = (m: string, refs: RetainerRefs) =>
    refs.overage_minutes + refs.waived_minutes + lateAboveIn(standing, m)
  const afterOf = (m: string) =>
    standing.find((d) => !d.refs.late_only && previousMonth(d.refs.month) === m)?.refs.month
  /** What a month took of the hours rolled into it, its own partly taken by the month after. */
  const tookOf = (m: string): number => {
    const refs = invoiceOf(standing, m)
    if (!refs || refs.rollover_in_minutes === 0) return 0
    const after = afterOf(m)
    const asked = usedOf(m) + (after === undefined ? 0 : tookOf(after)) - aboveOf(m, refs)
    return Math.min(refs.rollover_in_minutes, Math.max(0, asked - refs.included_minutes))
  }
  /** The hours rolled into a month that its month before still has, its late hours counted. */
  const rolledInto = (m: string) => {
    const rolled = invoiceOf(standing, m)?.rollover_in_minutes ?? 0
    if (rolled === 0) return 0
    const prev = previousMonth(m)
    const left = includedOf(prev) - usedOf(prev) - here(prev)
    return Math.min(rolled, Math.max(tookOf(m), left))
  }
  const lines: LateLine[] = []
  const unknown: string[] = []
  for (const l of months) {
    const schedule = schedules.get(l.month)
    const terms = termsOf(l.month)
    if (!schedule || !terms) {
      unknown.push(l.month)
      continue
    }
    const after = afterOf(l.month)
    const free =
      includedOf(l.month) +
      rolledInto(l.month) -
      usedOf(l.month) -
      (after !== undefined ? tookOf(after) : 0)
    const over = Math.max(0, l.minutes - Math.max(0, free))
    lines.push({
      month: l.month,
      minutes: l.minutes,
      overage_minutes: waived ? 0 : over,
      ...(waived && over > 0 ? { waived_minutes: over } : {}),
      scheduleId: String(schedule.id),
      rate: BigInt(Number(terms.retainer_overage_rate_minor ?? 0)),
      vat: Number(scheduleLines(terms)[0]?.vat_bp ?? 0),
    })
  }
  return { lines, unknown }
}

/** The invoice lines of late hours above their month's, after `from` lines. */
export function lateItems(late: readonly LateLine[], from: number): Array<Record<string, unknown>> {
  return late
    .filter((l) => l.overage_minutes > 0)
    .map((l, i) => ({
      position: from + i + 1,
      description: `Hours above the retainer, ${l.month}, worked after its invoice`,
      quantity: lineQuantity(l.overage_minutes, "hour", 60),
      unit_price_minor: l.rate,
      line_kind: "service",
      product_source: null,
      external_id: `retainer_late:${l.scheduleId}:${l.month}`,
      tax_rate_bp_override: l.vat,
    }))
}

/** What a document keeps of the late hours it bills. */
export const lateRefs = (late: readonly LateLine[]): LateHours[] =>
  late.map((l) => ({
    month: l.month,
    minutes: l.minutes,
    overage_minutes: l.overage_minutes,
    ...(l.waived_minutes ? { waived_minutes: l.waived_minutes } : {}),
  }))

/** Late hours in words, one line each. */
export const lateSaid = (late: readonly LateLine[], currency: string): string[] =>
  late.map((l) =>
    l.overage_minutes > 0
      ? `${hoursText(l.overage_minutes)} above ${l.month}'s hours, worked after its invoice, at ${formatMoneyMinor(l.rate, currency)}`
      : l.waived_minutes
        ? `overage of ${hoursText(l.waived_minutes)} of ${l.month} waived`
        : `${hoursText(l.minutes)} of ${l.month}, worked after its invoice, within its hours`,
  )

/**
 * Late hours of retainer months on a card that bills something else, or nothing of its own: their
 * lines and what its document keeps. `before` is the month of the card.
 */
export async function lateOnOtherCard(
  ctx: DbCtx,
  input: { projectId: string; before: string; late: LateInput; waived?: boolean },
) {
  const standing = await standingMonths(ctx, input.projectId, null)
  const { lines, unknown } = await lateHoursOf(
    ctx,
    input.projectId,
    input.late,
    input.before,
    standing,
    input.waived === true,
  )
  const first = lines[0]
  const schedule = first ? await one(ctx, "recurring_schedules", { id: first.scheduleId }) : null
  const issuer = schedule
    ? await one(ctx, "issuer_profiles", { id: String(schedule.issuer_profile_id) })
    : null
  return {
    late: lines,
    unknown,
    schedule,
    currency: String(issuer?.default_currency ?? "EUR"),
    refs: (first
      ? {
          schedule_id: first.scheduleId,
          month: input.before,
          included_minutes: 0,
          used_minutes: 0,
          rollover_in_minutes: 0,
          overage_minutes: 0,
          waived_minutes: 0,
          late: lateRefs(lines),
          late_only: true,
        }
      : null) as RetainerRefs | null,
  }
}

export interface RetainerPlanInput {
  projectId: string
  period: { from: string; to: string }
  /** What the card bills for the month. */
  usedMinutes: number
  /** The month's timebox on the project, when it has one; else the schedule's included hours. */
  timeboxMinutes?: number | null
  waived: boolean
  /** Hours of earlier months worked after their invoices, billed on this one. */
  late?: ReadonlyArray<{ month: string; minutes: number }>
}

/** A card's billed minutes: its own month's, and each earlier month's. */
export function cardMinutes(lines: ReadonlyArray<{ billMinutes?: unknown; workMonth?: unknown }>): {
  used: number
  late: Array<{ month: string; minutes: number }>
} {
  let used = 0
  const late = new Map<string, number>()
  for (const l of lines) {
    const minutes = Math.max(0, Math.round(Number(l.billMinutes) || 0))
    if (typeof l.workMonth === "string" && /^\d{4}-\d{2}$/.test(l.workMonth))
      late.set(l.workMonth, (late.get(l.workMonth) ?? 0) + minutes)
    else used += minutes
  }
  return {
    used,
    late: [...late]
      .filter(([, minutes]) => minutes > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, minutes]) => ({ month, minutes })),
  }
}

const PAGE = 200

/**
 * The project's retainer invoices that still stand (issued or drafted, not credited in full), over
 * all its schedules; not the one under `exceptKey`.
 */
export async function standingMonths(ctx: DbCtx, projectId: string, exceptKey: string | null) {
  const out: Array<{ doc: Row; refs: RetainerRefs }> = []
  for (let offset = 0; ; offset += PAGE) {
    const docs = (await ctx.db.findMany("documents", {
      where: { billing_project_id: projectId },
      orderBy: { id: "asc" },
      limit: PAGE,
      offset,
    })) as Row[]
    for (const doc of docs) {
      const refs = retainerRefsOf(doc)
      if (!refs || doc.type === "credit_note") continue
      if (doc.status === "cancelled" || doc.status === "voided") continue
      const key = String(doc.external_ref ?? "")
      if (exceptKey !== null && (key === exceptKey || key.startsWith(`${exceptKey}:`))) continue
      if (
        doc.status !== "draft" &&
        absBig(doc.grand_total_minor) > 0n &&
        (await advanceRemaining(ctx, doc)) <= 0n
      )
        continue
      out.push({ doc, refs })
    }
    if (docs.length < PAGE) return out
  }
}

/** A retainer month's lines and figures, priced exactly as its draft will be. Nothing is written. */
export async function retainerPlan(ctx: DbCtx, schedule: Row, input: RetainerPlanInput) {
  const scheduleId = String(schedule.id)
  const month = monthOf(input.period.from)
  // The month is billed on its own terms: a renewal's from its first month, the old ones before.
  const s = termsForMonth(schedule, month)
  const included =
    Number(input.timeboxMinutes ?? 0) > 0
      ? Number(input.timeboxMinutes)
      : Number(s.retainer_minutes)
  const standing = await standingMonths(
    ctx,
    input.projectId,
    retainerDocumentRef(scheduleId, month),
  )
  const lateHere = (m: string) =>
    (input.late ?? []).reduce((a, l) => a + (l.month === m ? l.minutes : 0), 0)
  const prevMonth = previousMonth(month)
  const fig = retainerMonth({
    includedMinutes: included,
    usedMinutes: input.usedMinutes,
    // Hours worked in the month before after its invoice use its included hours first.
    rolloverInMinutes: await rolledIn(
      ctx,
      s,
      month,
      included,
      lateMinutesIn(standing, prevMonth) + lateHere(prevMonth),
    ),
    // Hours of this month a later invoice already counted inside its hours are not free again.
    takenMinutes: lateMinutesIn(standing, month) - lateAboveIn(standing, month),
    waived: input.waived,
  })
  const { lines: late, unknown } = await lateHoursOf(
    ctx,
    input.projectId,
    input.late ?? [],
    month,
    standing,
    input.waived,
  )
  const refs: RetainerRefs = {
    schedule_id: scheduleId,
    month,
    included_minutes: fig.includedMinutes,
    used_minutes: fig.usedMinutes,
    rollover_in_minutes: fig.rolloverInMinutes,
    overage_minutes: fig.overageMinutes,
    waived_minutes: fig.waivedMinutes,
    ...(late.length > 0 ? { late: lateRefs(late) } : {}),
  }

  const issuer = (await one(ctx, "issuer_profiles", { id: String(s.issuer_profile_id) })) ?? null
  const currency = String(issuer?.default_currency ?? "EUR")
  const fees = scheduleLines(s)
  const feeVat = Number(fees[0]?.vat_bp ?? 0)
  const overageRate = BigInt(Number(s.retainer_overage_rate_minor ?? 0))
  const items: Array<Record<string, unknown>> = fees.map((l, i) => ({
    position: i + 1,
    description: String(l.description),
    quantity: String(l.qty),
    unit_price_minor: BigInt(Number(l.unit_price_minor)),
    line_kind: "service",
    product_source: null,
    external_id: `retainer_fee:${scheduleId}:${month}:${i + 1}`,
    tax_rate_bp_override: Number(l.vat_bp),
  }))
  if (fig.overageMinutes > 0) {
    items.push({
      position: items.length + 1,
      description: `Hours above the retainer, ${month}`,
      quantity: lineQuantity(fig.overageMinutes, "hour", 60),
      unit_price_minor: overageRate,
      line_kind: "service",
      product_source: null,
      external_id: `retainer_overage:${scheduleId}:${month}`,
      tax_rate_bp_override: feeVat,
    })
  }
  items.push(...lateItems(late, items.length))
  const prepaid = isPrepaidMonth(schedule, month)
  let deductions: DeductionLine[] = []
  if (prepaid) {
    deductions = renderDeductionLines(await prepaidAdvances(ctx, input.projectId, input.period))
    for (const d of deductions) {
      items.push({
        position: items.length + 1,
        description: d.description,
        quantity: "-1",
        unit_price_minor: BigInt(d.amountMinor),
        line_kind: "service",
        product_source: null,
        external_id: `advance_deduction:${d.advanceDocumentId}:${d.taxRateBp}`,
        tax_rate_bp_override: d.taxRateBp,
      })
    }
  }

  return { fig, refs, items, deductions, fees, overageRate, currency, prepaid, late, unknown }
}

function titleOf(projectName: string, month: string, lateOnly: boolean): string {
  return lateOnly
    ? `Invoice draft of earlier retainer hours for ${projectName}, ${month}`
    : `Retainer invoice draft for ${projectName}, ${month}`
}

/** Whether the project's month is billed from its retainer card: a schedule's, and not on its run. */
async function monthOnCard(ctx: DbCtx, projectId: string, month: string): Promise<boolean> {
  const s = await retainerScheduleOf(ctx, projectId, month)
  return !!s && isRetainerMonth(s, month) && !(await monthOnRun(ctx, String(s.id), month))
}

export async function retainerDraftFromReconcile(
  ctx: Ctx,
  input: RetainerDraftInput,
): Promise<RetainerDraftResult> {
  const reconciliationId = typeof input.reconciliationId === "string" ? input.reconciliationId : ""
  const revision = Number(input.revision)
  if (!UUID.test(reconciliationId) || !Number.isInteger(revision) || revision < 1) {
    return refuse(
      "invalid_input",
      "reconciliationId must be a reconciliation id and revision its card revision. No draft was made.",
    )
  }
  let env: Awaited<ReturnType<MutationsCtx["executeTool"]>>
  try {
    env = await ctx.executeTool("projects:reconcile_lines_read", { reconciliationId })
  } catch {
    env = { status: "error" } as never
  }
  if (env?.status !== "completed")
    return refuse(
      "card_unreadable",
      "The planned vs done card could not be read. No draft was made.",
    )
  const read = (env.result ?? {}) as LinesRead
  if (!DAY.test(read.period?.from ?? "") || !DAY.test(read.period?.to ?? ""))
    return refuse("card_unreadable", "The card's period could not be read. No draft was made.")
  const name = read.projectName ?? "the project"
  if (read.basis !== "retainer")
    return refuse("not_a_retainer", `${name} is not billed by a retainer. No draft was made.`)

  const month = monthOf(read.period.from)
  const lateOnly = input.lateOnly === true
  const minutes = cardMinutes(read.lines ?? [])
  const alone = lateOnly
    ? await lateOnOtherCard(ctx, {
        projectId: read.projectId,
        before: month,
        late: minutes.late,
        waived: input.waiveOverage === true,
      })
    : null
  const s = alone ? alone.schedule : await retainerScheduleOf(ctx, read.projectId, month)
  if (!s)
    return refuse(
      "no_retainer_schedule",
      `${name} has no retainer schedule in Invoicing, so no draft was made. Save the retainer on its recurring schedule, then press Create invoice again.`,
    )
  const scheduleId = String(s.id)
  // The month's key; a month whose invoice was credited in full is billed again under the next
  // key, `<key>:<n>`, which the projects app chose for the new card. A draft of earlier hours alone
  // is the card's own, keyed by its revision.
  const base = retainerDocumentRef(scheduleId, month)
  const ref = typeof read.documentRef === "string" ? read.documentRef : ""
  const key = lateOnly
    ? `reconcile:${reconciliationId}:${revision}`
    : ref.startsWith(`${base}:`) && /^\d+$/.test(ref.slice(base.length + 1))
      ? ref
      : base
  const title = titleOf(name, month, lateOnly)

  const found = await one(ctx, "documents", { external_ref: key })
  if (found && refsOf(found).reconciliation_id !== reconciliationId) {
    // One draft per retainer month: another card's lines are never added to it.
    const on =
      found.status === "draft"
        ? `${title} (draft ${String(found.id)}), made from another planned vs done card`
        : `invoice ${String(found.number ?? found.id)}, made from another planned vs done card`
    return refuse(
      "month_on_other_card",
      `${month} of ${name} is already on ${on}. Nothing was made, and nothing was added to it. ${
        found.status === "draft"
          ? "Bill these lines on that card, or discard that draft and press Create invoice here again."
          : "Correct that invoice with a credit note; once it is credited in full, the month can be invoiced again from its card."
      }`,
    )
  }
  const madeFrom = found ? refsOf(found).reconciliation_revision : null
  if (found && found.status === "draft" && typeof madeFrom === "number" && madeFrom !== revision)
    return refuse(
      "draft_outdated",
      `${title} (draft ${String(found.id)}) was made from the card as it stood at revision ${madeFrom}, so it was not used for revision ${revision}. Nothing was made. Discard that draft in Invoicing, then press Create invoice here again.`,
    )
  if (found) {
    const totals = {
      excl: Number(found.subtotal_minor ?? 0),
      vat: Number(found.tax_total_minor ?? 0),
      incl: Number(found.grand_total_minor ?? 0),
      currency: String(found.currency ?? "EUR"),
    }
    return {
      status: "completed",
      draftId: String(found.id),
      draftTitle: title,
      approvalId: await pendingIssueApproval(ctx, String(found.id)),
      approved: typeof found.approved_by === "string" && found.approved_by !== "",
      created: false,
      scheduleId,
      month,
      retainer: retainerRefsOf(found) as RetainerRefs,
      totals,
      message:
        found.status === "draft"
          ? `${title} already exists (draft ${String(found.id)}); nothing new was made and no number was taken.`
          : `${month} of this retainer was already invoiced as ${String(found.number ?? found.id)}; nothing new was made.`,
    }
  }
  if (read.revision !== revision)
    return refuse(
      "card_changed",
      `The card changed since it was shown (revision ${read.revision}, not ${revision}). No draft was made. Open the latest card and press Create invoice there.`,
    )
  if (read.documentRef && read.documentRef !== key)
    return refuse("card_changed", "The card was invoiced under another key. No draft was made.")
  if (read.state === "invoiced" || read.state === "credited")
    return refuse("already_invoiced", `The card is already ${read.state}. No draft was made.`)
  const unknown = (months: string[]) =>
    refuse(
      "no_retainer_schedule",
      `${name} has hours of ${months.join(", ")} on this card, and no retainer schedule holds ${months.length === 1 ? "that month" : "those months"} in Invoicing, so no draft was made. Set ${months.length === 1 ? "that line" : "those lines"} to 0 and bill the hours by hand, with an invoice in Invoicing.`,
    )
  let plan: Pick<
    Awaited<ReturnType<typeof retainerPlan>>,
    | "fig"
    | "refs"
    | "items"
    | "deductions"
    | "fees"
    | "overageRate"
    | "currency"
    | "prepaid"
    | "late"
  >
  if (alone) {
    if (alone.unknown.length > 0) return unknown(alone.unknown)
    if (await monthOnCard(ctx, read.projectId, month))
      return refuse(
        "card_changed",
        `${month} of ${name} is billed by its retainer from this card. No draft was made: open the latest card and press Create invoice there.`,
      )
    const items = lateItems(alone.late, 0)
    if (items.length === 0 || !alone.refs)
      return refuse(
        "nothing_billed",
        `The earlier hours on this card are within their month's included hours, so there is nothing to bill. No draft was made.`,
      )
    plan = {
      fig: retainerMonth({
        includedMinutes: 0,
        usedMinutes: 0,
        rolloverInMinutes: 0,
        waived: false,
      }),
      refs: alone.refs,
      items,
      deductions: [],
      fees: [],
      overageRate: 0n,
      currency: alone.currency,
      prepaid: false,
      late: alone.late,
    }
  } else {
    const last = lastRetainerMonth(s)
    if (last !== null && month > last)
      return refuse(
        "period_on_run",
        `${month} of ${name} is billed by the month-end run: the retainer was turned off and ${last} is its last month. No retainer draft was made.`,
      )
    if (!isRetainerMonth(s, month) || (await monthOnRun(ctx, scheduleId, month)))
      return refuse(
        "period_on_run",
        `${month} of ${name} is already billed by the month-end run (the schedule became a retainer during the month), so no retainer draft was made. The retainer bills from the next month.`,
      )
    const full = await retainerPlan(ctx, s, {
      projectId: read.projectId,
      period: read.period,
      usedMinutes: minutes.used,
      late: minutes.late,
      timeboxMinutes: read.timeboxMinutes ?? null,
      waived: input.waiveOverage === true,
    })
    if (full.unknown.length > 0) return unknown(full.unknown)
    plan = full
  }
  const { fig, refs, items, deductions, fees, overageRate, currency } = plan

  const billTo = retainerRecipient(s, {
    contactId:
      typeof input.contactId === "string" && UUID.test(input.contactId)
        ? input.contactId
        : typeof read.contactId === "string"
          ? read.contactId
          : null,
    companyId: read.companyId ?? null,
  })
  const recipient = await recipientOf(ctx, billTo)
  // A customer missing what its invoice needs is named now, before any draft or claim.
  const issuer = await resolveIssuerProfileOrError(ctx.db, null)
  if (issuer.ok) {
    const gap = (await recipientGaps(ctx, issuer.issuer, billTo.contactId, recipient))[0]
    if (gap) {
      const [code, why] = RECIPIENT_GAP_REFUSAL[gap]
      return refuse(code, `For ${name}, ${why}`)
    }
  }
  const created = await draftsCreate(ctx, {
    type: "invoice",
    // The month's invoice is made out to the client's contact, as a card's and an advance's are.
    counterparty_contact_id: billTo.contactId,
    ...recipient,
    currency,
    operation_category: "services",
    items,
  } as never)
  const draftId = created.draft_id
  const canIssue = ctx.hasScope ? await ctx.hasScope("invoicing:documents:write") : false
  const userId = await ctx.getUserId()
  const today = (await ctx.time.civil({ timezone: "UTC" })).date
  const advanceDocs = [...new Map(deductions.map((d) => [d.advanceDocumentId, d])).values()]
  try {
    await ctx.db.update("documents", draftId, {
      external_ref: key,
      billing_project_id: read.projectId,
      // The client company the retainer bills: the month's invoice is the company's.
      ...(billTo.companyId ? { company_id: billTo.companyId } : {}),
      service_period_start: read.period.from,
      service_period_end: read.period.to,
      latest_issue_on: monthEnd(read.period.to),
      invoice_role: deductions.length > 0 ? "final" : "standard",
      ...(deductions.length > 0 ? { payment_state: "final_after_deposit" } : {}),
      ...(canIssue ? { approved_by: userId, approved_at: today } : {}),
      external_refs: {
        recurring_schedule_id: scheduleId,
        // The schedule's own due rule: the invoice is due by it, counted from its issue.
        due_days: scheduleTermsDays(s),
        reconciliation_id: reconciliationId,
        reconciliation_revision: revision,
        retainer: refs,
        ...(advanceDocs.length
          ? {
              preceding_invoices: advanceDocs.map((d) => ({
                document_id: d.advanceDocumentId,
                number: d.advanceNumber,
                issue_date: d.advanceIssuedOn,
              })),
            }
          : {}),
      },
    })
  } catch (err) {
    // Another click made this month's draft first: drop ours (it has no number).
    await ctx.db.delete("documents", draftId).catch(() => {})
    if (!(await one(ctx, "documents", { external_ref: key }))) throw err
    return retainerDraftFromReconcile(ctx, input)
  }
  if (advanceDocs.length > 0) {
    const ops = advanceDocs.map((d) => ({
      insert: "advance_deductions",
      data: {
        advance_document_id: d.advanceDocumentId,
        final_document_id: draftId,
        amount_minor: BigInt(
          deductions
            .filter((x) => x.advanceDocumentId === d.advanceDocumentId)
            .reduce((a, x) => a + x.amountMinor, 0),
        ),
        tax_rate_bp: d.taxRateBp,
        line_position:
          items.findIndex((it) =>
            String(it.external_id).startsWith(`advance_deduction:${d.advanceDocumentId}:`),
          ) + 1,
        state: "reserved",
      },
    }))
    try {
      await ctx.db.batch({ ops } as never)
    } catch (err) {
      await ctx.db.delete("documents", draftId).catch(() => {})
      // Only the deduction's unique key means another invoice took the advance first; any other
      // failure is reported as itself, never as a race that did not happen.
      if (!isUniqueViolation(err)) throw err
      return refuse(
        "advance_already_deducted",
        `This month's advance was deducted from another invoice at the same moment, so no draft was made.`,
      )
    }
  }

  await ctx.db.insert("activity_reports", {
    document_id: draftId,
    version: 1,
    content: buildActivityReport({
      project: { id: read.projectId, name: read.projectName ?? "" },
      period: read.period,
      hoursPerDayMinutes: 60,
      lines: (read.lines ?? [])
        .filter((l) => !lateOnly || typeof l.workMonth === "string")
        .map((l) => ({
          wording: l.wording,
          billedMinutes: l.billMinutes,
          unit: "hour" as const,
          proofLabels: Array.isArray(l.proofLabels) ? l.proofLabels : [],
        })),
    }),
  })

  const t = await draftTotals(ctx, recipient as never, items as never)
  const totals = { ...t, currency }
  const monthSaid = [
    `Fee ${formatMoneyMinor(BigInt(fees.reduce((a, l) => a + Number(l.qty) * Number(l.unit_price_minor), 0)), currency)}`,
    fig.overageMinutes > 0
      ? `${hoursText(fig.overageMinutes)} above the retainer at ${formatMoneyMinor(overageRate, currency)}`
      : fig.waivedMinutes > 0
        ? `overage of ${hoursText(fig.waivedMinutes)} waived this month`
        : "no hours above the retainer",
    ...(fig.rolloverInMinutes > 0
      ? [`${hoursText(fig.rolloverInMinutes)} rolled in from ${previousMonth(month)}`]
      : []),
  ]
  const said = [
    ...(lateOnly ? [] : monthSaid),
    ...lateSaid(plan.late, currency),
    ...deductions.map((d) => `${d.description} deducted`),
  ]
  const approvalLines = [
    ...notOverLine(read.period.to, today),
    ...said,
    `To pay ${formatMoneyMinor(BigInt(totals.incl), currency)} incl. VAT`,
  ]
  const latestIssueOn = monthEnd(read.period.to)
  // A prepaid retainer's project has one issue approval waiting at a time (its next advance's or
  // this final's), so Home holds one money item for it.
  const raised = plan.prepaid
    ? await raiseOnePerProject(ctx, read.projectId, draftId, title, approvalLines, latestIssueOn)
    : {
        approvalId: await raiseIssueApproval(ctx, draftId, title, approvalLines, latestIssueOn),
        heldBy: null,
      }
  const approvalId = raised.approvalId
  const who = canIssue ? "approved" : "waiting for someone who can issue invoices"
  const next =
    approvalId !== null
      ? `Issuing it is waiting on approval ${approvalId}.`
      : raised.heldBy
        ? heldText(raised.heldBy)
        : "Its issue approval could not be raised: issue it from the pending list."
  return {
    status: "completed",
    draftId,
    draftTitle: title,
    approvalId,
    approved: canIssue,
    created: true,
    scheduleId,
    month,
    retainer: refs,
    totals,
    message: `Created ${title} (draft ${draftId}), ${who}: ${said.join("; ")}; ${formatMoneyMinor(BigInt(totals.excl), currency)} excl. VAT, ${formatMoneyMinor(BigInt(totals.incl), currency)} incl. VAT. No number was taken. ${next}`,
  }
}

/**
 * reconcile_draft_discard: Undo on a planned vs done card discards the draft the card made, and
 * nothing else. Internal, for the projects app: it refuses any document that is not an unissued
 * draft carrying a card's key, so it can never discard another draft or an issued invoice.
 */
export async function reconcileDraftDiscard(
  ctx: MutationsCtx,
  input: { draft_id?: string; reconciliationId?: string },
) {
  const id = typeof input.draft_id === "string" ? input.draft_id : ""
  const row = id ? ((await ctx.db.findOne("documents", id)) as Row | null) : null
  const ref = typeof row?.external_ref === "string" ? row.external_ref : ""
  const holder = row ? refsOf(row).reconciliation_id : undefined
  // Undo on a card discards only the draft that card made.
  const otherCard =
    typeof input.reconciliationId === "string" &&
    typeof holder === "string" &&
    holder !== input.reconciliationId
  if (otherCard) {
    return refuse(
      "not_a_card_draft",
      `Document ${id} was made from another planned vs done card, so nothing was discarded.`,
    )
  }
  if (!row || !(ref.startsWith("reconcile:") || ref.startsWith("retainer:"))) {
    return refuse(
      "not_a_card_draft",
      `Document ${id || "(none)"} is not a draft made from a planned vs done card, so nothing was discarded.`,
    )
  }
  if (String(row.status ?? "draft") !== "draft") {
    return refuse(
      "already_issued",
      `The card's invoice was already issued as ${String(row.number ?? id)}, so nothing was discarded. Correct it with a credit note.`,
    )
  }
  await draftsDiscard(ctx, { draft_id: id })
  return {
    status: "completed" as const,
    draftId: id,
    message: `Discarded the card's invoice draft ${id}; no number was used, and the card's month is free again.`,
  }
}
