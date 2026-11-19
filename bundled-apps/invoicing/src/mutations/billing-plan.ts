// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A project's billing plan: the steps a quote is invoiced in (advances, milestones, the final),
// and the drafts each step makes. A plan is for a fixed-price project; a project billed by the
// hour or the day bills from planned vs done instead, so a plan on one is refused.
//
// - The milestone and final amounts add up to the quote's total excl. VAT, plus the accepted
//   amendments the plan lists. An advance does not add: it is invoiced early and deducted from
//   the final.
// - An accepted amendment (a change request the client approved) adds one milestone of its own
//   (`billing_step_add`, called by the agreements app as the change request's sender), once per
//   change request: the step carries the change request's id, and a second call returns it.
// - A milestone's invoice is drafted from its task only: the task must be done (a terminal status)
//   and flagged a milestone. Hours and time spent never move it. The task is read through projects'
//   own milestone read, which hands over no assignee, time or activity.
// - The final's draft deducts every advance invoiced on the project by itself, one line per
//   advance and VAT rate, each citing the advance's number and date, and is marked final after
//   deposit (BT-23 business process digit 4).
// - No step's draft takes a number: issuing is a separate act, on the draft's issue approval.

import { latestIssueLine } from "../approval-cards"
import { type DeductionLine, renderDeductionLines, shortDate } from "../deduction-lines"
import { formatMoneyMinor } from "../money"
import { recipientOf } from "../recipient"
import { planTax } from "../tax-plan"
import { creditedTotalMinor } from "./credit-coverage"
import { resolveIssuerProfileOrError } from "./db-helpers"
import { draftsCreate } from "./drafts"
import {
  customerLine,
  ISSUE_APPROVAL_EXPIRY_HOURS,
  issuePayloadFor,
  monthEnd,
} from "./from-reconcile"
import { isUniqueViolation } from "./quote-proforma-po"
import type { MutationsCtx } from "./shared"

export { type DeductionLine, renderDeductionLines, shortDate }

type Row = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Bases that bill from planned vs done: a billing plan on them is refused. */
const RATE_BASES = new Set(["daily", "hourly", "retainer"])
const ISSUED = new Set(["issued", "paid", "overdue", "refunded"])
/** A quote a plan can follow: issued to the client, not refused or lapsed. */
const QUOTE_OK = new Set(["sent", "accepted", "issued", "invoiced", "closed"])

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
  /** The project's client company, when it has one. */
  companyId?: string | null
  tasks: Array<{
    id: string
    terminal: boolean
    isMilestone: boolean
    completedOn: string | null
  }>
}

/** The project's billing basis and the named tasks' done state, through projects' milestone read. */
/** A document row's client company, when it names one. */
function companyOf(doc: Row | null): string | null {
  const id = doc?.company_id
  return typeof id === "string" && UUID.test(id) ? id : null
}

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
      companyId: typeof r.companyId === "string" && r.companyId !== "" ? r.companyId : null,
    }
  } catch {
    return null
  }
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
      changeRequestId:
        typeof s.change_request_ref === "string" && s.change_request_ref !== ""
          ? s.change_request_ref
          : null,
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
    // What the client is invoiced in all: an advance is deducted at the final, so adding every
    // step's amount counts it twice.
    invoicedInAll: { minor: billed, currency },
    title:
      view.length === 0
        ? "No billing plan"
        : `Billing plan, ${view.length} step${view.length === 1 ? "" : "s"}, ${formatMoneyMinor(BigInt(billed), currency)} excl. VAT in all${
            advances > 0
              ? ` (the advance of ${formatMoneyMinor(BigInt(advances), currency)} is deducted at the final, so the steps do not add up to it)`
              : ""
          }`,
  }
}

/**
 * Whether a step's task is done: true once the step was drafted, false for an open milestone whose
 * task is not done yet, null for an advance, a step with no task or when projects could not say.
 */
function taskDoneOf(
  step: { kind: string; taskId: string | null; state: string },
  read: MilestoneRead | null,
): boolean | null {
  if (step.kind === "advance" || !step.taskId || step.state === "cancelled") return null
  if (step.state !== "planned") return true
  const task = read?.tasks.find((t) => t.id === step.taskId)
  return task ? task.terminal === true : null
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
  // Whether each open milestone's task is done, through projects' milestone read (done state only).
  const waiting = view.steps.filter(
    (s) => s.state === "planned" && s.kind !== "advance" && s.taskId,
  )
  const read =
    waiting.length > 0
      ? await readMilestones(ctx, projectId, [...new Set(waiting.map((s) => String(s.taskId)))])
      : null
  const steps = view.steps.map((s) => ({ ...s, taskDone: taskDoneOf(s, read) }))
  return {
    status: "completed" as const,
    ...view,
    steps,
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
  /** An accepted amendment's milestone, already on the plan: the change request it bills. */
  changeRequestId?: string | null
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
    changeRequestId: string | null
  }> = []
  // The accepted amendments on this plan, by change request: each adds its own amount once.
  const current = await stepsOf(ctx, projectId)
  const amendments = new Map<string, bigint>()
  for (const s of current)
    if (typeof s.change_request_ref === "string" && s.change_request_ref !== "")
      amendments.set(s.change_request_ref, asBig(s.amount_minor))
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
    const changeRequestId =
      typeof s.changeRequestId === "string" && s.changeRequestId !== "" ? s.changeRequestId : null
    if (changeRequestId !== null) {
      const accepted = amendments.get(changeRequestId)
      if (kind !== "milestone" || accepted === undefined)
        return refuse(
          "amendment_not_accepted",
          `Step ${i + 1} (${label}) names change request ${changeRequestId}, which has no accepted amendment on this plan. No plan was saved.`,
        )
      if (accepted !== amount)
        return refuse(
          "amendment_amount_mismatch",
          `Step ${i + 1} (${label}) bills change request ${changeRequestId} at ${formatMoneyMinor(amount, currency)}, but the client accepted ${formatMoneyMinor(accepted, currency)} excl. VAT. No plan was saved.`,
        )
    }
    steps.push({
      kind,
      label,
      amount,
      taskId: kind === "advance" ? null : taskId,
      quoteLinePosition: typeof s.quoteLinePosition === "number" ? s.quoteLinePosition : null,
      taxRateBp: typeof s.taxRateBp === "number" ? s.taxRateBp : null,
      changeRequestId,
    })
  }
  const listed = steps.flatMap((s) => (s.changeRequestId ? [s.changeRequestId] : []))
  if (new Set(listed).size !== listed.length)
    return refuse("invalid_step", "Two steps name the same change request. No plan was saved.")
  const amended = steps.reduce((a, s) => (s.changeRequestId ? a + s.amount : a), 0n)
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
  const expected = quoteExcl + amended
  if (billed !== expected) {
    const diff = expected - billed
    const target =
      amended > 0n
        ? `quote ${quoteName}'s ${formatMoneyMinor(quoteExcl, currency)} plus the ${formatMoneyMinor(amended, currency)} of the accepted amendments it lists, ${formatMoneyMinor(expected, currency)}`
        : `quote ${quoteName}'s ${formatMoneyMinor(quoteExcl, currency)}`
    return refuse(
      "plan_total_mismatch",
      `The milestone and final amounts add up to ${formatMoneyMinor(billed, currency)}, not ${target} excl. VAT: ${diff > 0n ? `${formatMoneyMinor(diff, currency)} is missing` : `${formatMoneyMinor(-diff, currency)} too much`}. Advances do not count toward it. No plan was saved.`,
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
        change_request_ref: s.changeRequestId,
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
// billing_step_add

export interface BillingStepAddInput {
  projectId?: string
  changeRequestId?: string
  label?: string
  /** Excl. VAT, in minor units: an integer, or its decimal string. */
  amountMinor?: number | string
  currency?: string
  taskId?: string
  taxRateBp?: number | null
}

const asMinor = (v: unknown): bigint | null => {
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v)
  if (typeof v === "string" && /^\d{1,18}$/.test(v.trim())) return BigInt(v.trim())
  return null
}

/**
 * One milestone for an accepted amendment: the change request the client approved, billed when
 * its task is done. Called by the agreements app only, as the change request's sender, once the
 * task exists. Once per change request: a second call (a retry, a resumed run) returns the step
 * the first one added and adds nothing. A project with no billing plan gets no step.
 */
export async function billingStepAdd(ctx: MutationsCtx, input: BillingStepAddInput) {
  const projectId = typeof input.projectId === "string" ? input.projectId : ""
  const crId = typeof input.changeRequestId === "string" ? input.changeRequestId : ""
  if (!UUID.test(projectId))
    return refuse(
      "invalid_project",
      `projectId ${projectId || "(none)"} is not a project id. No step was added.`,
    )
  if (!UUID.test(crId))
    return refuse(
      "invalid_step",
      `changeRequestId ${crId || "(none)"} is not a change request id. No step was added.`,
    )
  const label = typeof input.label === "string" ? input.label.trim() : ""
  const amount = asMinor(input.amountMinor)
  const taskId = typeof input.taskId === "string" ? input.taskId : ""
  if (!label || amount === null || amount <= 0n || !UUID.test(taskId))
    return refuse(
      "invalid_step",
      "An amendment's step needs a label, a positive amountMinor and the task whose completion invoices it. No step was added.",
    )

  const already = async () => {
    const existing = await one(ctx, "billing_steps", { change_request_ref: crId })
    if (!existing) return null
    if (existing.billing_project_id !== projectId)
      return refuse(
        "amendment_on_other_plan",
        `Change request ${crId} is already billed by another project's plan. No step was added.`,
      )
    const view = await planView(ctx, projectId)
    return {
      status: "completed" as const,
      ...view,
      added: false,
      position: Number(existing.position),
      message: `Change request ${crId} is already step ${Number(existing.position)} (${String(existing.label)}) of this plan. Nothing was added.`,
    }
  }
  const before = await already()
  if (before) return before

  const current = await stepsOf(ctx, projectId)
  if (current.length === 0)
    return refuse(
      "no_billing_plan",
      `Project ${projectId} has no billing plan, so the amendment adds no step. Nothing was changed.`,
    )
  const currency = String(current[0]?.currency ?? "EUR")
  if (typeof input.currency === "string" && input.currency !== "" && input.currency !== currency)
    return refuse(
      "currency_mismatch",
      `The amendment is in ${input.currency} and the plan in ${currency}. No step was added.`,
    )
  if (
    current.some((s) => s.task_id === taskId) ||
    (await one(ctx, "billing_steps", { task_id: taskId }))
  )
    return refuse(
      "task_on_other_plan",
      `Task ${taskId} already invoices a step of a plan. No step was added.`,
    )
  const read = await readMilestones(ctx, projectId, [taskId])
  if (!read)
    return refuse(
      "project_unreadable",
      `Project ${projectId} could not be read. No step was added.`,
    )
  if (RATE_BASES.has(read.basis))
    return refuse(
      "plan_on_rate_project",
      `This project bills ${read.basis === "retainer" ? "a monthly retainer" : `by the ${read.basis === "daily" ? "day" : "hour"}`}, from planned vs done, so no billing step was added.`,
    )
  if (!read.tasks.some((t) => t.id === taskId))
    return refuse(
      "task_not_in_project",
      `Task ${taskId} is not a task of this project. No step was added.`,
    )
  const quoteId = current.find((s) => typeof s.quote_document_id === "string")?.quote_document_id
  const position = current.reduce((m, s) => Math.max(m, Number(s.position)), 0) + 1
  try {
    await ctx.db.batch({
      ops: [
        {
          insert: "billing_steps",
          data: {
            billing_project_id: projectId,
            position,
            kind: "milestone",
            label,
            amount_minor: amount,
            currency,
            tax_rate_bp: typeof input.taxRateBp === "number" ? input.taxRateBp : null,
            task_id: taskId,
            quote_document_id: typeof quoteId === "string" ? quoteId : null,
            quote_line_position: null,
            change_request_ref: crId,
            state: "planned",
          },
        },
      ],
    } as never)
  } catch (err) {
    // A concurrent call for the same change request added it first: answer that one.
    if (!isUniqueViolation(err)) throw err
    const raced = await already()
    if (raced) return raced
    throw err
  }
  const view = await planView(ctx, projectId)
  return {
    status: "completed" as const,
    ...view,
    added: true,
    position,
    message: `Added step ${position}, ${label}, ${formatMoneyMinor(amount, currency)} excl. VAT, for change request ${crId}: it is invoiced when its task is done (milestone_draft_create). Nothing was invoiced.`,
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
    // The line is down for every step on it, so a step still done with no invoice comes up again
    // once the draft no longer holds the line.
    const noticed = (
      (await ctx.db.findMany("billing_steps", {
        where: { billing_project_id: projectId },
        limit: 200,
      })) as Row[]
    ).filter((s) => s.no_invoice_noticed_on)
    for (const s of noticed)
      await ctx.db.update("billing_steps", String(s.id), { no_invoice_noticed_on: null })
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
    // Whoever decides reads who is invoiced first: the draft's customer.
    const shown = [...(await customerLine(ctx, draftId)), ...lines]
    const parked = await ctx.requestApproval({
      tool_name: "invoicing:invoice_issue",
      summary: `Issue ${title}`,
      summary_detail: latest
        ? { lines: [...shown.slice(0, 7), latest], latest_on: String(latestIssueOn).slice(0, 10) }
        : { lines: shown },
      current_payload: await issuePayloadFor(ctx, draftId),
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

/**
 * What drafting a milestone's invoice would make, for its approval card: the step, its amount
 * excluding VAT and the customer of the plan's quote. Internal read, nothing is written.
 */
export async function milestoneDraftPreview(
  ctx: MutationsCtx,
  input: { taskId?: string },
): Promise<
  | { label: string; amountMinor: string; currency: string; customer: string | null }
  | { error: { code: string; message: string } }
> {
  const taskId = typeof input?.taskId === "string" ? input.taskId : ""
  if (!UUID.test(taskId)) return { error: { code: "invalid_task", message: "Not a task id." } }
  const step = await one(ctx, "billing_steps", { task_id: taskId })
  if (!step)
    return { error: { code: "no_billing_step", message: "The task invoices no billing step." } }
  const quote =
    typeof step.quote_document_id === "string"
      ? await one(ctx, "documents", { id: step.quote_document_id })
      : null
  const name = typeof quote?.counterparty_name === "string" ? quote.counterparty_name.trim() : ""
  return {
    label: String(step.label ?? ""),
    amountMinor: String(step.amount_minor ?? "0"),
    currency: String(step.currency ?? quote?.currency ?? "EUR"),
    customer: name || null,
  }
}

/**
 * The quote's customer, with the structured billing address an e-invoice states read from its
 * contact when the quote holds none (a quote saved before addresses were structured, or
 * imported): otherwise the invoice issues flagged for a billing address it prints.
 */
export async function recipientOfQuoteCompleted(ctx: MutationsCtx, quote: Row): Promise<Row> {
  const out = recipientOfQuote(quote)
  const contactId = out.counterparty_contact_id
  if (out.billing_postcode || out.billing_city || typeof contactId !== "string" || !contactId)
    return out
  const current = await recipientOf(ctx, { contactId, companyId: null }).catch(() => null)
  if (!current?.billing_postcode || !current.billing_city) return out
  for (const k of [
    "billing_line1",
    "billing_line2",
    "billing_postcode",
    "billing_city",
    "billing_country_code",
  ] as const)
    out[k] = current[k] ?? null
  return out
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
  const recipient = await recipientOfQuoteCompleted(ctx, quote)
  const companyId = companyOf(quote) ?? read.companyId ?? null
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
      // The plan's client company (its quote's, else its project's): the invoice is the company's.
      ...(companyId ? { company_id: companyId } : {}),
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
    // Another final took the advance first (the deduction's unique key): drop this draft. Any
    // other failure drops it too and is reported as itself, never as that race.
    await ctx.db.delete("documents", draftId).catch(() => {})
    if (!isUniqueViolation(err)) throw err
    return refuse(
      "advance_already_deducted",
      `An advance of this project was deducted from another invoice at the same moment, so nothing was drafted.`,
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
