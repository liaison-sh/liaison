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
//   A waived month bills no overage, that month only.
// - Rollover `next`: the month before passes its unused included hours, at most the timebox.
// - Prepaid (`covers = period_ahead`): the month's fee was invoiced ahead as an advance, so the
//   month-end draft is a final that deducts it; the overage bills on it; it may total zero.
// - It takes no number: the draft gets the same issue approval as any draft from planned vs done.

import { buildActivityReport } from "../activity-report"
import { lineQuantity } from "../line-amount"
import { formatMoneyMinor } from "../money"
import { recipientOf } from "../recipient"
import {
  hoursText,
  isRetainerMonth,
  isRetainerSchedule,
  monthOf,
  previousMonth,
  type RetainerRefs,
  retainerDocumentRef,
  retainerMonth,
  retainerRefsOf,
  rolloverOut,
  runDocumentRef,
} from "../recurring/retainer"
import {
  type DeductionLine,
  draftTotals,
  pendingIssueApproval,
  raiseIssueApproval,
  renderDeductionLines,
} from "./billing-plan"
import { draftsCreate, draftsDiscard } from "./drafts"
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
const ISSUED = new Set(["issued", "paid", "overdue", "refunded"])
const GONE = new Set(["cancelled", "voided"])

export interface RetainerDraftInput {
  reconciliationId?: string
  revision?: number
  waiveOverage?: boolean
  /** The project lead's name, signing the activity report (the projects app passes it). */
  leadName?: string | null
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

const refuse = (code: string, message: string): RetainerDraftResult => ({
  status: "error",
  error: { code, message, retryable: false },
})

interface LinesRead {
  projectId: string
  projectName?: string
  companyId?: string | null
  basis: string
  state: string
  revision: number
  documentRef: string | null
  period: { from: string; to: string }
  timeboxMinutes?: number | null
  lines: Array<{ lineId: string; wording: string; billMinutes: number; proofLabels?: string[] }>
}

type DbCtx = Pick<MutationsCtx, "db">

async function one(ctx: DbCtx, table: string, where: Row): Promise<Row | null> {
  const rows = (await ctx.db.findMany(table, { where, limit: 1 })) as Row[]
  return rows[0] ?? null
}

/** The live retainer schedule of a project, or null. */
export async function retainerScheduleOf(ctx: DbCtx, projectId: string): Promise<Row | null> {
  const rows = (await ctx.db.findMany("recurring_schedules", {
    where: { retainer_project_id: projectId },
    limit: 20,
  })) as Row[]
  return rows.find((s) => s.status !== "ended" && isRetainerSchedule(s)) ?? null
}

/** A month the month-end run holds: its draft or issued invoice, or its row in a run. */
async function monthOnRun(ctx: DbCtx, scheduleId: string, month: string): Promise<boolean> {
  const doc = await one(ctx, "documents", { external_ref: runDocumentRef(scheduleId, month) })
  if (doc && !GONE.has(String(doc.status))) return true
  const item = await one(ctx, "recurring_run_items", { schedule_id: scheduleId, period_key: month })
  return !!item && item.state !== "left_out"
}

/** The hours rolled in from the month before: its unused included hours, read from its invoice. */
async function rolledIn(ctx: DbCtx, s: Row, month: string, included: number) {
  if (s.retainer_rollover !== "next") return 0
  const prev = retainerRefsOf(
    await one(ctx, "documents", {
      external_ref: retainerDocumentRef(String(s.id), previousMonth(month)),
    }),
  )
  if (!prev) return 0
  return Math.min(included, rolloverOut("next", prev.included_minutes, prev.used_minutes))
}

function scheduleLines(
  s: Row,
): Array<{ description: string; qty: number; unit_price_minor: number; vat_bp: number }> {
  const raw = typeof s.lines === "string" ? JSON.parse(s.lines) : s.lines
  return (Array.isArray(raw) ? raw : []) as never
}

/** The issued advances of a prepaid month not yet deducted: the month's fee paid ahead. */
async function prepaidAdvances(
  ctx: DbCtx,
  projectId: string,
  period: { from: string; to: string },
): Promise<Array<{ doc: Row; lines: Row[] }>> {
  const docs = (await ctx.db.findMany("documents", {
    where: { billing_project_id: projectId, invoice_role: "advance" },
    limit: 200,
  })) as Row[]
  const out: Array<{ doc: Row; lines: Row[] }> = []
  for (const d of docs) {
    if (!ISSUED.has(String(d.status))) continue
    const start = typeof d.service_period_start === "string" ? d.service_period_start : null
    const issuedOn = typeof d.issued_at === "string" ? d.issued_at.slice(0, 10) : ""
    const forMonth = start ? start >= period.from && start <= period.to : issuedOn <= period.to
    if (!forMonth) continue
    const taken = (await ctx.db.findMany("advance_deductions", {
      where: { advance_document_id: String(d.id) },
      limit: 20,
    })) as Row[]
    if (taken.some((t) => t.state !== "released")) continue
    const lines = (await ctx.db.findMany("document_lines", {
      where: { document_id: String(d.id) },
      limit: 200,
    })) as Row[]
    out.push({ doc: d, lines })
  }
  return out
}

export interface RetainerPlanInput {
  projectId: string
  period: { from: string; to: string }
  /** What the card bills for the month. */
  usedMinutes: number
  /** The month's timebox on the project, when it has one; else the schedule's included hours. */
  timeboxMinutes?: number | null
  waived: boolean
}

/** A retainer month's lines and figures, priced exactly as its draft will be. Nothing is written. */
export async function retainerPlan(ctx: DbCtx, s: Row, input: RetainerPlanInput) {
  const scheduleId = String(s.id)
  const month = monthOf(input.period.from)
  const included =
    Number(input.timeboxMinutes ?? 0) > 0
      ? Number(input.timeboxMinutes)
      : Number(s.retainer_minutes)
  const fig = retainerMonth({
    includedMinutes: included,
    usedMinutes: input.usedMinutes,
    rolloverInMinutes: await rolledIn(ctx, s, month, included),
    waived: input.waived,
  })
  const refs: RetainerRefs = {
    schedule_id: scheduleId,
    month,
    included_minutes: fig.includedMinutes,
    used_minutes: fig.usedMinutes,
    rollover_in_minutes: fig.rolloverInMinutes,
    overage_minutes: fig.overageMinutes,
    waived_minutes: fig.waivedMinutes,
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
  const prepaid = s.covers === "period_ahead"
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

  return { fig, refs, items, deductions, fees, overageRate, currency, prepaid }
}

function titleOf(projectName: string, month: string): string {
  return `Retainer invoice draft for ${projectName}, ${month}`
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

  const s = await retainerScheduleOf(ctx, read.projectId)
  if (!s)
    return refuse(
      "no_retainer_schedule",
      `${name} has no retainer schedule in Invoicing, so no draft was made. Save the retainer on its recurring schedule, then press Create invoice again.`,
    )
  const scheduleId = String(s.id)
  const month = monthOf(read.period.from)
  const key = retainerDocumentRef(scheduleId, month)
  const title = titleOf(name, month)

  const found = await one(ctx, "documents", { external_ref: key })
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
  if (!isRetainerMonth(s, month) || (await monthOnRun(ctx, scheduleId, month)))
    return refuse(
      "period_on_run",
      `${month} of ${name} is already billed by the month-end run (the schedule became a retainer during the month), so no retainer draft was made. The retainer bills from the next month.`,
    )

  const plan = await retainerPlan(ctx, s, {
    projectId: read.projectId,
    period: read.period,
    usedMinutes: (read.lines ?? []).reduce(
      (a, l) => a + Math.max(0, Number(l.billMinutes) || 0),
      0,
    ),
    timeboxMinutes: read.timeboxMinutes ?? null,
    waived: input.waiveOverage === true,
  })
  const { fig, refs, items, deductions, fees, overageRate, currency } = plan

  const recipient = await recipientOf(ctx, {
    contactId: typeof s.contact_id === "string" ? s.contact_id : null,
    companyId: typeof s.company_id === "string" ? s.company_id : (read.companyId ?? null),
  })
  const created = await draftsCreate(ctx, {
    type: "invoice",
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
      service_period_start: read.period.from,
      service_period_end: read.period.to,
      latest_issue_on: monthEnd(read.period.to),
      invoice_role: deductions.length > 0 ? "final" : "standard",
      ...(deductions.length > 0 ? { payment_state: "final_after_deposit" } : {}),
      ...(canIssue ? { approved_by: userId, approved_at: today } : {}),
      external_refs: {
        recurring_schedule_id: scheduleId,
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
      return refuse(
        "advance_already_deducted",
        `This month's advance was deducted from another invoice at the same moment, so no draft was made (${err instanceof Error ? err.message : String(err)}).`,
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
      lines: (read.lines ?? []).map((l) => ({
        wording: l.wording,
        billedMinutes: l.billMinutes,
        unit: "hour" as const,
        proofLabels: Array.isArray(l.proofLabels) ? l.proofLabels : [],
      })),
      lead:
        typeof input.leadName === "string" && input.leadName.trim() !== "" ? input.leadName : null,
    }),
  })

  const t = await draftTotals(ctx, recipient as never, items as never)
  const totals = { ...t, currency }
  const said = [
    `Fee ${formatMoneyMinor(BigInt(fees.reduce((a, l) => a + Number(l.qty) * Number(l.unit_price_minor), 0)), currency)}`,
    fig.overageMinutes > 0
      ? `${hoursText(fig.overageMinutes)} above the retainer at ${formatMoneyMinor(overageRate, currency)}`
      : fig.waivedMinutes > 0
        ? `overage of ${hoursText(fig.waivedMinutes)} waived this month`
        : "no hours above the retainer",
    ...(fig.rolloverInMinutes > 0
      ? [`${hoursText(fig.rolloverInMinutes)} rolled in from ${previousMonth(month)}`]
      : []),
    ...deductions.map((d) => `${d.description} deducted`),
  ]
  const approvalId = await raiseIssueApproval(
    ctx,
    draftId,
    title,
    [...said, `To pay ${formatMoneyMinor(BigInt(totals.incl), currency)} incl. VAT`],
    monthEnd(read.period.to),
  )
  const who = canIssue ? "approved" : "waiting for someone who can issue invoices"
  const next =
    approvalId === null
      ? "Its issue approval could not be raised: issue it from the pending list."
      : `Issuing it is waiting on approval ${approvalId}.`
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
export async function reconcileDraftDiscard(ctx: MutationsCtx, input: { draft_id?: string }) {
  const id = typeof input.draft_id === "string" ? input.draft_id : ""
  const row = id ? ((await ctx.db.findOne("documents", id)) as Row | null) : null
  const ref = typeof row?.external_ref === "string" ? row.external_ref : ""
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
