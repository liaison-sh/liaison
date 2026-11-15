// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project's billing plan: the steps a quote is invoiced in (advances, milestones, the final),
// and the drafts each step makes. A plan is for a fixed-price project; a project billed by the
// hour or the day bills from planned vs done instead, so a plan on one is refused.
//
// - The milestone and final amounts add up to the quote's total excl. VAT. An advance does not
//   add: it is invoiced early and deducted from the final.
// - A milestone's invoice is drafted from its task only: the task must be done (a terminal status)
//   and flagged a milestone. Hours and time spent never move it. The task is read through projects'
//   own milestone read, which hands over no assignee, time or activity.
// - The final's draft deducts every advance invoiced on the project by itself, one line per
//   advance and VAT rate, each citing the advance's number and date, and is marked final after
//   deposit (BT-23 business process digit 4).
// - No step's draft takes a number: issuing is a separate act, on the draft's issue approval.

import { latestIssueLine } from "../approval-cards"
import { formatMoneyMinor } from "../money"
import { planTax } from "../tax-plan"
import { creditedTotalMinor } from "./credit-coverage"
import { resolveIssuerProfileOrError } from "./db-helpers"
import { draftsCreate } from "./drafts"
import { ISSUE_APPROVAL_EXPIRY_HOURS, monthEnd } from "./from-reconcile"
import type { MutationsCtx } from "./shared"

type Row = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Bases that bill from planned vs done: a billing plan on them is refused. */
const RATE_BASES = new Set(["daily", "hourly", "retainer"])
const ISSUED = new Set(["issued", "paid", "overdue", "refunded"])
/** A quote a plan can follow: issued to the client, not refused or lapsed. */
const QUOTE_OK = new Set(["sent", "accepted", "issued", "invoiced", "closed"])
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

export type StepKind = "advance" | "milestone" | "final"

export type Refusal = {
  status: "error"
  error: { code: string; message: string; retryable: false }
}

export const refuse = (code: string, message: string): Refusal => ({
  status: "error",
  error: { code, message, retryable: false },
})

const asBig = (v: unknown): bigint => {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v))
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  return 0n
}

/** "16 Apr 2026" for a YYYY-MM-DD day, or an ISO instant's day. */
export function shortDate(day: unknown): string {
  const s = typeof day === "string" ? day.slice(0, 10) : ""
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return s
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

async function one(ctx: MutationsCtx, table: string, where: Row): Promise<Row | null> {
  const rows = (await ctx.db.findMany(table, { where, limit: 1 })) as Row[]
  return rows[0] ?? null
}

export async function stepsOf(ctx: MutationsCtx, projectId: string): Promise<Row[]> {
  const rows = (await ctx.db.findMany("billing_steps", {
    where: { billing_project_id: projectId },
    limit: 500,
  })) as Row[]
  return rows.sort((a, b) => Number(a.position) - Number(b.position))
}

/** What became of a step, read from the document it made (the stored state may lag an issue). */
export function stepState(step: Row, doc: Row | null): string {
  if (step.state === "cancelled") return "cancelled"
  if (!doc) return step.document_id ? "drafted" : "planned"
  if (doc.status === "draft" || doc.status === "pending_approval") return "drafted"
  if (doc.payment_status === "paid" || doc.status === "paid") return "paid"
  if (ISSUED.has(String(doc.status))) return "issued"
  return String(step.state ?? "planned")
}

interface MilestoneRead {
  basis: string
  tasks: Array<{
    id: string
    terminal: boolean
    isMilestone: boolean
    completedOn: string | null
  }>
}

/** The project's billing basis and the named tasks' done state, through projects' milestone read. */
export async function readMilestones(
  ctx: MutationsCtx,
  projectId: string,
  taskIds: string[],
): Promise<MilestoneRead | null> {
  try {
    const env = await ctx.executeTool("projects:milestone_status_read", { projectId, taskIds })
    if (env?.status !== "completed") return null
    const r = (env.result ?? {}) as Partial<MilestoneRead>
    return {
      basis: typeof r.basis === "string" ? r.basis : "none",
      tasks: Array.isArray(r.tasks) ? r.tasks : [],
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Deduction lines

export interface DeductionLine {
  advanceDocumentId: string
  advanceNumber: string
  advanceDate: string
  /** YYYY-MM-DD, the advance's issue day. */
  advanceIssuedOn: string
  taxRateBp: number
  /** Excl. VAT, positive: the amount the line takes off. */
  amountMinor: number
  description: string
}

/**
 * The deduction lines of a final invoice: one per advance and VAT rate, each citing the advance's
 * number and date, from the advance's own issued lines. The one place a deduction is worded, used
 * by the draft and by every screen that shows it.
 */
export function renderDeductionLines(advances: Array<{ doc: Row; lines: Row[] }>): DeductionLine[] {
  const out: DeductionLine[] = []
  for (const { doc, lines } of advances) {
    const byRate = new Map<number, bigint>()
    for (const l of lines) {
      const rate = Number(l.tax_rate_bp ?? 0)
      byRate.set(rate, (byRate.get(rate) ?? 0n) + asBig(l.subtotal_minor))
    }
    const number = String(doc.number ?? doc.id)
    const date = shortDate(doc.issued_at)
    const rates = [...byRate.keys()].sort((a, b) => b - a)
    for (const rate of rates) {
      const amount = byRate.get(rate) ?? 0n
      if (amount <= 0n) continue
      out.push({
        advanceDocumentId: String(doc.id),
        advanceNumber: number,
        advanceDate: date,
        advanceIssuedOn: typeof doc.issued_at === "string" ? doc.issued_at.slice(0, 10) : "",
        taxRateBp: rate,
        amountMinor: Number(amount),
        description:
          rates.length > 1
            ? `Advance invoice ${number} of ${date}, VAT ${rate / 100}%`
            : `Advance invoice ${number} of ${date}`,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// billing_plan_get

export interface BillingPlanGetInput {
  projectId?: string
}

async function planView(ctx: MutationsCtx, projectId: string) {
  const steps = await stepsOf(ctx, projectId)
  const quoteId = steps.find((s) => typeof s.quote_document_id === "string")?.quote_document_id
  const quote = typeof quoteId === "string" ? await one(ctx, "documents", { id: quoteId }) : null
  const view = []
  for (const s of steps) {
    const doc =
      typeof s.document_id === "string" ? await one(ctx, "documents", { id: s.document_id }) : null
    view.push({
      id: String(s.id),
      position: Number(s.position),
      kind: String(s.kind),
      label: String(s.label),
      amountMinor: Number(asBig(s.amount_minor)),
      currency: String(s.currency ?? ""),
      taskId: typeof s.task_id === "string" ? s.task_id : null,
      state: stepState(s, doc),
      document: doc
        ? {
            id: String(doc.id),
            number: typeof doc.number === "string" ? doc.number : null,
            status: String(doc.status),
          }
        : null,
    })
  }
  const currency = view[0]?.currency ?? String(quote?.currency ?? "EUR")
  const billed = view.filter((s) => s.kind !== "advance").reduce((a, s) => a + s.amountMinor, 0)
  const advances = view.filter((s) => s.kind === "advance").reduce((a, s) => a + s.amountMinor, 0)
  return {
    projectId,
    quote: quote
      ? {
          id: String(quote.id),
          number: typeof quote.number === "string" ? quote.number : null,
          totalExclMinor: Number(asBig(quote.subtotal_minor)),
        }
      : null,
    steps: view,
    currency,
    milestonesMinor: billed,
    advancesMinor: advances,
    milestonesTotal: { minor: billed, currency },
    advancesTotal: { minor: advances, currency },
    title:
      view.length === 0
        ? "No billing plan"
        : `Billing plan, ${view.length} step${view.length === 1 ? "" : "s"}, ${formatMoneyMinor(BigInt(billed), currency)} excl. VAT`,
  }
}

export async function billingPlanGet(ctx: MutationsCtx, input: BillingPlanGetInput) {
  const projectId = typeof input.projectId === "string" ? input.projectId : ""
  if (!UUID.test(projectId))
    return refuse(
      "invalid_project",
      `projectId ${projectId || "(none)"} is not a project id. Nothing was read.`,
    )
  const view = await planView(ctx, projectId)
  const open = view.steps.filter((s) => s.state === "planned").length
  return {
    status: "completed" as const,
    ...view,
    message:
      view.steps.length === 0
        ? `Project ${projectId} has no billing plan. Set one from its quote with billing_plan_set.`
        : `${view.title}; ${open} step${open === 1 ? "" : "s"} not invoiced yet. A milestone is invoiced when its task is done (milestone_draft_create).`,
  }
}

// ---------------------------------------------------------------------------------------------
// billing_plan_set

export interface PlanStepInput {
  kind?: string
  label?: string
  amountMinor?: number
  percent?: number
  taskId?: string | null
  quoteLinePosition?: number | null
  taxRateBp?: number | null
}

export interface BillingPlanSetInput {
  projectId?: string
  quoteDocumentId?: string
  steps?: PlanStepInput[]
}

export async function billingPlanSet(ctx: MutationsCtx, input: BillingPlanSetInput) {
  const projectId = typeof input.projectId === "string" ? input.projectId : ""
  if (!UUID.test(projectId))
    return refuse(
      "invalid_project",
      `projectId ${projectId || "(none)"} is not a project id. No plan was saved.`,
    )
  const quoteId = typeof input.quoteDocumentId === "string" ? input.quoteDocumentId : ""
  const quote = UUID.test(quoteId) ? await one(ctx, "documents", { id: quoteId }) : null
  if (!quote || quote.type !== "quote")
    return refuse(
      "quote_not_found",
      `No quote ${quoteId || "(none)"} was found. No plan was saved.`,
    )
  if (!QUOTE_OK.has(String(quote.status)))
    return refuse(
      "quote_not_sent",
      `Quote ${String(quote.number ?? quote.id)} is ${String(quote.status)}: a plan follows a quote the client was sent. No plan was saved.`,
    )
  const quoteName = String(quote.number ?? quote.id)
  const currency = String(quote.currency ?? "EUR")
  const quoteExcl = asBig(quote.subtotal_minor)
  const given = Array.isArray(input.steps) ? input.steps : []
  if (given.length === 0) return refuse("no_steps", "The plan has no step. No plan was saved.")

  const steps: Array<{
    kind: StepKind
    label: string
    amount: bigint
    taskId: string | null
    quoteLinePosition: number | null
    taxRateBp: number | null
  }> = []
  for (const [i, s] of given.entries()) {
    const kind = s.kind as StepKind
    if (kind !== "advance" && kind !== "milestone" && kind !== "final")
      return refuse(
        "invalid_step",
        `Step ${i + 1}: kind must be advance, milestone or final. No plan was saved.`,
      )
    const label = typeof s.label === "string" ? s.label.trim() : ""
    if (!label) return refuse("invalid_step", `Step ${i + 1} has no label. No plan was saved.`)
    let amount: bigint | null = null
    if (typeof s.amountMinor === "number" && Number.isInteger(s.amountMinor))
      amount = BigInt(s.amountMinor)
    else if (typeof s.percent === "number" && s.percent > 0 && s.percent <= 100)
      amount = (quoteExcl * BigInt(Math.round(s.percent * 100)) + 5000n) / 10000n
    if (amount === null || amount <= 0n)
      return refuse(
        "invalid_step",
        `Step ${i + 1} (${label}) needs a positive amountMinor or a percent of the quote. No plan was saved.`,
      )
    const taskId = typeof s.taskId === "string" && s.taskId !== "" ? s.taskId : null
    if (kind !== "advance" && (!taskId || !UUID.test(taskId)))
      return refuse(
        "invalid_step",
        `Step ${i + 1} (${label}) is a ${kind}: name the task whose completion invoices it. No plan was saved.`,
      )
    steps.push({
      kind,
      label,
      amount,
      taskId: kind === "advance" ? null : taskId,
      quoteLinePosition: typeof s.quoteLinePosition === "number" ? s.quoteLinePosition : null,
      taxRateBp: typeof s.taxRateBp === "number" ? s.taxRateBp : null,
    })
  }
  if (steps.filter((s) => s.kind === "final").length > 1)
    return refuse("invalid_step", "A plan has one final step. No plan was saved.")
  if (steps.some((s) => s.kind === "advance") && !steps.some((s) => s.kind === "final"))
    return refuse(
      "advance_needs_final",
      "An advance is deducted from the final step, and the plan has none. No plan was saved.",
    )
  const taskIds = steps.flatMap((s) => (s.taskId ? [s.taskId] : []))
  if (new Set(taskIds).size !== taskIds.length)
    return refuse("invalid_step", "Two steps name the same task. No plan was saved.")

  const billed = steps.filter((s) => s.kind !== "advance").reduce((a, s) => a + s.amount, 0n)
  if (billed !== quoteExcl) {
    const diff = quoteExcl - billed
    return refuse(
      "plan_total_mismatch",
      `The milestone and final amounts add up to ${formatMoneyMinor(billed, currency)}, not quote ${quoteName}'s ${formatMoneyMinor(quoteExcl, currency)} excl. VAT: ${diff > 0n ? `${formatMoneyMinor(diff, currency)} is missing` : `${formatMoneyMinor(-diff, currency)} too much`}. Advances do not count toward it. No plan was saved.`,
    )
  }

  const read = await readMilestones(ctx, projectId, taskIds)
  if (!read)
    return refuse(
      "project_unreadable",
      `Project ${projectId} could not be read. No plan was saved.`,
    )
  if (RATE_BASES.has(read.basis))
    return refuse(
      "plan_on_rate_project",
      `This project bills ${read.basis === "retainer" ? "a monthly retainer" : `by the ${read.basis === "daily" ? "day" : "hour"}`}, from planned vs done, so a billing plan was not saved. Change its billing terms to a fixed price first.`,
    )
  const known = new Set(read.tasks.map((t) => t.id))
  const missingTask = taskIds.find((t) => !known.has(t))
  if (missingTask)
    return refuse(
      "task_not_in_project",
      `Task ${missingTask} is not a task of this project. No plan was saved.`,
    )
  for (const t of taskIds) {
    const other = await one(ctx, "billing_steps", { task_id: t })
    if (other && other.billing_project_id !== projectId)
      return refuse(
        "task_on_other_plan",
        `Task ${t} already invoices a step of another project's plan. No plan was saved.`,
      )
  }

  // A step that already made a document stays as it is: the new plan must keep it unchanged.
  const current = await stepsOf(ctx, projectId)
  const ops: Array<Record<string, unknown>> = []
  for (const s of current) {
    const locked =
      typeof s.document_id === "string" || (s.state !== "planned" && s.state !== "cancelled")
    const pos = Number(s.position)
    const same = steps[pos - 1]
    if (locked) {
      if (
        !same ||
        same.kind !== s.kind ||
        same.amount !== asBig(s.amount_minor) ||
        (same.taskId ?? null) !== ((s.task_id as string | null) ?? null)
      )
        return refuse(
          "step_locked",
          `Step ${pos} (${String(s.label)}) already has its invoice, so it cannot change or move. Keep it as step ${pos} with the same amount. No plan was saved.`,
        )
    } else ops.push({ delete: "billing_steps", id: String(s.id) })
  }
  const keep = new Set(
    current
      .filter(
        (s) =>
          typeof s.document_id === "string" || (s.state !== "planned" && s.state !== "cancelled"),
      )
      .map((s) => Number(s.position)),
  )
  steps.forEach((s, i) => {
    if (keep.has(i + 1)) return
    ops.push({
      insert: "billing_steps",
      data: {
        billing_project_id: projectId,
        position: i + 1,
        kind: s.kind,
        label: s.label,
        amount_minor: s.amount,
        currency,
        tax_rate_bp: s.taxRateBp,
        task_id: s.taskId,
        quote_document_id: quoteId,
        quote_line_position: s.quoteLinePosition,
        state: "planned",
      },
    })
  })
  await ctx.db.batch({ ops } as never)
  const view = await planView(ctx, projectId)
  const advances = steps.filter((s) => s.kind === "advance")
  return {
    status: "completed" as const,
    ...view,
    message:
      `Saved the billing plan of quote ${quoteName}: ${steps.length} step${steps.length === 1 ? "" : "s"}, ${formatMoneyMinor(billed, currency)} excl. VAT` +
      (advances.length
        ? `, with ${advances.length} advance${advances.length === 1 ? "" : "s"} of ${formatMoneyMinor(
            advances.reduce((a, s) => a + s.amount, 0n),
            currency,
          )} deducted at the final`
        : "") +
      ". Nothing was invoiced. Draft each milestone's invoice once its task is done (milestone_draft_create with the task); a done milestone with no invoice is raised on Home within the hour.",
  }
}

// ---------------------------------------------------------------------------------------------
// milestone_draft_create

export interface MilestoneDraftCreateInput {
  taskId?: string
}

/** The issued advances of a project, and why one cannot be deducted yet. */
async function projectAdvances(
  ctx: MutationsCtx,
  projectId: string,
  steps: Row[],
): Promise<{ ok: Array<{ doc: Row; lines: Row[] }> } | Refusal> {
  const docs = (await ctx.db.findMany("documents", {
    where: { billing_project_id: projectId, invoice_role: "advance" },
    limit: 200,
  })) as Row[]
  const live = docs.filter((d) => d.status !== "cancelled" && d.status !== "voided")
  for (const s of steps.filter((x) => x.kind === "advance")) {
    if (typeof s.document_id !== "string")
      return refuse(
        "advance_not_issued",
        `The plan's advance "${String(s.label)}" has no issued invoice yet, so nothing was drafted. Issue the advance first (advance_draft_create), then draft the final again.`,
      )
  }
  const draft = live.find((d) => !ISSUED.has(String(d.status)))
  if (draft)
    return refuse(
      "advance_not_issued",
      `Advance draft ${String(draft.id)} is not issued yet, so nothing was drafted. Issue it first, then draft the final again.`,
    )
  const out: Array<{ doc: Row; lines: Row[] }> = []
  for (const d of live) {
    const lines = (await ctx.db.findMany("document_lines", {
      where: { document_id: String(d.id) },
      limit: 200,
    })) as Row[]
    // A credited advance has nothing left to deduct (credited before the final); a partly
    // credited one is deducted for what remains, split over its VAT rates as issued.
    const total = absBig(d.grand_total_minor)
    const remaining = total === 0n ? 0n : await advanceRemaining(ctx, d)
    if (total !== 0n && remaining <= 0n) continue
    const taken = (await ctx.db.findMany("advance_deductions", {
      where: { advance_document_id: String(d.id) },
      limit: 20,
    })) as Row[]
    const holding = taken.find((t) => t.state !== "released")
    if (holding) {
      const final = await one(ctx, "documents", { id: String(holding.final_document_id) })
      return refuse(
        "advance_already_deducted",
        `Advance ${String(d.number ?? d.id)} is already deducted from ${final?.number ? `invoice ${String(final.number)}` : `draft ${String(holding.final_document_id)}`}, so nothing was drafted. An advance is deducted from one final only.`,
      )
    }
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
  return { ok: out }
}

/** What remains of an advance after its issued credit notes (minor units, incl. VAT). */
export async function advanceRemaining(ctx: Pick<MutationsCtx, "db">, doc: Row): Promise<bigint> {
  const notes = (await ctx.db.findMany("documents", {
    where: { original_document_id: String(doc.id) },
    limit: 50,
  })) as Row[]
  const credited = await creditedTotalMinor(
    ctx.db,
    { id: String(doc.id), lifecycle_log: (doc.lifecycle_log as Row[] | undefined) ?? [] },
    notes,
  )
  const total = asBig(doc.grand_total_minor)
  return (total < 0n ? -total : total) - credited
}

const absBig = (v: unknown): bigint => {
  const n = asBig(v)
  return n < 0n ? -n : n
}

async function pendingIssueApproval(ctx: MutationsCtx, draftId: string): Promise<string | null> {
  const pendingFor = ctx.approvals?.pendingFor
  if (!pendingFor) return null
  try {
    let raw = await pendingFor("draft_id", ["invoicing:invoice_issue"])
    if (typeof raw === "string") raw = JSON.parse(raw)
    const hit = (Array.isArray(raw) ? raw : []).find(
      (r: { target_id?: unknown }) => r?.target_id === draftId,
    ) as { id?: unknown } | undefined
    return typeof hit?.id === "string" ? hit.id : null
  } catch {
    return null
  }
}

/**
 * Take the project's "done with no invoice yet" Home line down: a draft of the project now waits
 * with its own issue approval, which is the project's one money item (billing-steps-sweep).
 * Best effort: the hourly sweep takes it down too.
 */
export async function takeDownMilestoneLine(ctx: MutationsCtx, projectId: string): Promise<void> {
  try {
    await ctx.emit({
      entity: "billing_step",
      action: "milestone_no_invoice",
      entityId: projectId,
      data: { project_id: projectId, resolved: true },
    })
  } catch {
    // The sweep takes it down within the hour.
  }
}

/**
 * Raise the issue approval of a billing draft; null when it cannot park (issue it from the pending
 * list). With the draft's latest issue day, the card says it (or that the draft is late, read on
 * the org's day) and Home brings the approval to the top from four days before it.
 */
export async function raiseIssueApproval(
  ctx: MutationsCtx & { logger?: { warn?: (m: string, d?: Row) => void } },
  draftId: string,
  title: string,
  lines: string[],
  latestIssueOn?: string | null,
): Promise<string | null> {
  try {
    // `UTC` reads the org's own zone (the host's rule for an unset zone).
    const today = latestIssueOn ? (await ctx.time.civil({ timezone: "UTC" })).date : null
    const latest = latestIssueOn ? latestIssueLine(latestIssueOn, today) : null
    const parked = await ctx.requestApproval({
      tool_name: "invoicing:invoice_issue",
      summary: `Issue ${title}`,
      summary_detail: latest
        ? { lines: [...lines.slice(0, 7), latest], latest_on: String(latestIssueOn).slice(0, 10) }
        : { lines },
      current_payload: { draft_id: draftId },
      approve_scope: "invoicing:documents:write",
      expiry_hours: ISSUE_APPROVAL_EXPIRY_HOURS,
    })
    return typeof parked?.approval_id === "string" ? parked.approval_id : null
  } catch (err) {
    ctx.logger?.warn?.("the issue approval of a billing draft could not park", {
      draftId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Totals of a draft's lines as issue will compute them (minor units). */
export async function draftTotals(
  ctx: MutationsCtx,
  recipient: { counterparty_country?: string | null; counterparty_vat_id?: string | null },
  lines: Array<{ quantity: string; unit_price_minor: bigint; tax_rate_bp_override?: number }>,
): Promise<{ excl: number; vat: number; incl: number }> {
  const issuer = await resolveIssuerProfileOrError(ctx.db, null)
  const plan = planTax({
    issuerCountry: issuer.ok ? issuer.issuer.country : null,
    pricesIncludeTax: false,
    taxCountry: recipient.counterparty_country ?? null,
    hasVatId: !!recipient.counterparty_vat_id,
    lines,
    linesAreNet: true,
  })
  return {
    excl: Number(plan.subtotal_minor),
    vat: Number(plan.tax_minor),
    incl: Number(plan.total_minor),
  }
}

/** The quote's customer, as a draft takes it. */
export function recipientOfQuote(quote: Row): Row {
  const keys = [
    "counterparty_contact_id",
    "counterparty_name",
    "counterparty_address",
    "counterparty_vat_id",
    "counterparty_email",
    "counterparty_country",
    "billing_line1",
    "billing_line2",
    "billing_postcode",
    "billing_city",
    "billing_country_code",
    "customer_kind",
  ]
  const out: Row = {}
  for (const k of keys) out[k] = quote[k] ?? null
  return out
}

export async function milestoneDraftCreate(
  ctx: MutationsCtx & { logger?: { warn?: (m: string, d?: Row) => void } },
  input: MilestoneDraftCreateInput,
) {
  const taskId = typeof input.taskId === "string" ? input.taskId : ""
  if (!UUID.test(taskId))
    return refuse(
      "invalid_task",
      `taskId ${taskId || "(none)"} is not a task id. Nothing was drafted.`,
    )
  const step = await one(ctx, "billing_steps", { task_id: taskId })
  if (!step)
    return refuse(
      "no_billing_step",
      `Task ${taskId} invoices no step of a billing plan. Nothing was drafted.`,
    )
  const stepId = String(step.id)
  const key = `milestone:${stepId}`
  const projectId = String(step.billing_project_id)
  const existing = await one(ctx, "documents", { external_ref: key })
  if (existing)
    return refuse(
      "already_drafted",
      existing.status === "draft"
        ? `Step "${String(step.label)}" already has its draft ${String(existing.id)}; nothing new was drafted and no number was taken.`
        : `Step "${String(step.label)}" was already invoiced as ${String(existing.number ?? existing.id)}; nothing new was drafted.`,
    )

  const read = await readMilestones(ctx, projectId, [taskId])
  if (!read)
    return refuse(
      "project_unreadable",
      `The task's project could not be read. Nothing was drafted.`,
    )
  const task = read.tasks.find((t) => t.id === taskId)
  if (!task)
    return refuse(
      "task_gone",
      `Task ${taskId} of step "${String(step.label)}" no longer exists. Nothing was drafted; link the step to another task with billing_plan_set.`,
    )
  if (!task.terminal || !task.isMilestone)
    return refuse(
      "not_done",
      `The task of step "${String(step.label)}" is ${task.isMilestone ? "not done yet" : "not a milestone"}, so nothing was drafted. Its invoice is drafted once it is done${task.isMilestone ? "" : " and flagged a milestone"}.`,
    )

  const steps = await stepsOf(ctx, projectId)
  const quote =
    typeof step.quote_document_id === "string"
      ? await one(ctx, "documents", { id: step.quote_document_id })
      : null
  if (!quote)
    return refuse("quote_not_found", `The plan's quote could not be read. Nothing was drafted.`)
  const recipient = recipientOfQuote(quote)
  const currency = String(step.currency ?? quote.currency ?? "EUR")
  const amount = asBig(step.amount_minor)
  const isFinal = step.kind === "final"

  let deductions: DeductionLine[] = []
  if (isFinal) {
    const adv = await projectAdvances(ctx, projectId, steps)
    if ("status" in adv) return adv
    deductions = renderDeductionLines(adv.ok)
    const taken = deductions.reduce((a, d) => a + BigInt(d.amountMinor), 0n)
    if (taken > amount)
      return refuse(
        "advance_exceeds_invoice",
        `The advances (${formatMoneyMinor(taken, currency)}) are larger than "${String(step.label)}" (${formatMoneyMinor(amount, currency)}), so nothing was drafted. Refund the part above it with advance_refund_prepare, or change the plan.`,
      )
  }

  const stepRate = typeof step.tax_rate_bp === "number" ? step.tax_rate_bp : undefined
  const items = [
    {
      position: 1,
      description: String(step.label),
      quantity: "1",
      unit_price_minor: amount,
      line_kind: "service",
      product_source: null,
      external_id: key,
      ...(stepRate !== undefined ? { tax_rate_bp_override: stepRate } : {}),
    },
    ...deductions.map((d, i) => ({
      position: i + 2,
      description: d.description,
      quantity: "-1",
      unit_price_minor: BigInt(d.amountMinor),
      line_kind: "service",
      product_source: null,
      external_id: `advance_deduction:${d.advanceDocumentId}:${d.taxRateBp}`,
      tax_rate_bp_override: d.taxRateBp,
    })),
  ]
  const created = await draftsCreate(ctx, {
    type: "invoice",
    ...recipient,
    currency,
    operation_category: "services",
    items,
  } as never)
  const draftId = created.draft_id
  const completedOn = task.completedOn ?? (await ctx.time.civil({ timezone: "UTC" })).date
  const advanceDocs = [...new Map(deductions.map((d) => [d.advanceDocumentId, d])).values()]
  try {
    await ctx.db.update("documents", draftId, {
      external_ref: key,
      billing_project_id: projectId,
      invoice_role: deductions.length > 0 ? "final" : "standard",
      ...(deductions.length > 0 ? { payment_state: "final_after_deposit" } : {}),
      service_period_end: completedOn,
      latest_issue_on: monthEnd(completedOn),
      external_refs: {
        billing_step_id: stepId,
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
    await ctx.db.delete("documents", draftId).catch(() => {})
    const winner = await one(ctx, "documents", { external_ref: key })
    if (!winner) throw err
    return refuse(
      "already_drafted",
      `Step "${String(step.label)}" already has its draft ${String(winner.id)}; nothing new was drafted.`,
    )
  }
  const ops: Array<Record<string, unknown>> = [
    { update: "billing_steps", id: stepId, data: { document_id: draftId, state: "drafted" } },
  ]
  for (const d of advanceDocs) {
    const first = deductions.findIndex((x) => x.advanceDocumentId === d.advanceDocumentId)
    const sum = deductions
      .filter((x) => x.advanceDocumentId === d.advanceDocumentId)
      .reduce((a, x) => a + x.amountMinor, 0)
    ops.push({
      insert: "advance_deductions",
      data: {
        advance_document_id: d.advanceDocumentId,
        final_document_id: draftId,
        amount_minor: BigInt(sum),
        // The rate of the first deduction line; a multi-rate advance has one line per rate.
        tax_rate_bp: d.taxRateBp,
        line_position: first + 2,
        state: "reserved",
      },
    })
  }
  try {
    await ctx.db.batch({ ops } as never)
  } catch (err) {
    // Another final took the advance first (the deduction's unique key): drop this draft.
    await ctx.db.delete("documents", draftId).catch(() => {})
    return refuse(
      "advance_already_deducted",
      `An advance of this project was deducted from another invoice at the same moment, so nothing was drafted (${err instanceof Error ? err.message : String(err)}).`,
    )
  }

  const totals = await draftTotals(ctx, recipient as never, items)
  const title = `Invoice draft for ${String(step.label)}`
  const lines = [
    `${String(step.label)}: ${formatMoneyMinor(amount, currency)}`,
    ...deductions.map(
      (d) => `${d.description}: -${formatMoneyMinor(BigInt(d.amountMinor), currency)}`,
    ),
    `To pay ${formatMoneyMinor(BigInt(totals.incl), currency)} incl. VAT`,
  ]
  await takeDownMilestoneLine(ctx, projectId)
  const approvalId = await raiseIssueApproval(ctx, draftId, title, lines, monthEnd(completedOn))
  return {
    status: "completed" as const,
    draftId,
    draftTitle: title,
    approvalId,
    stepId,
    totals: { ...totals, currency },
    paymentState: deductions.length > 0 ? "final_after_deposit" : "due",
    deductions,
    message:
      `Created ${title} (draft ${draftId}) from the done task of step "${String(step.label)}", on ${shortDate(completedOn)}: ${formatMoneyMinor(BigInt(totals.excl), currency)} excl. VAT, ${formatMoneyMinor(BigInt(totals.incl), currency)} incl. VAT` +
      (deductions.length
        ? `, after deducting ${deductions
            .map((d) => d.advanceNumber)
            .filter((v, i, a) => a.indexOf(v) === i)
            .join(", ")}`
        : "") +
      `. No number was taken. ${approvalId ? `Issuing it is waiting on approval ${approvalId}.` : "Its issue approval could not be raised: issue it from the pending list."}`,
  }
}

export { pendingIssueApproval }
