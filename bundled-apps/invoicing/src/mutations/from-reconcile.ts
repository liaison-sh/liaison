// SPDX-License-Identifier: FSL-1.1-ALv2
//
// draft_from_reconcile: the invoice draft a planned vs done card makes when a person presses
// Create invoice. Internal: only the projects app calls it, through its declared cross-app call.
//
// - One draft per card revision: its key is `reconcile:<id>:<revision>` (unique), so a double
//   click or a retry returns the same draft.
// - It reads the billed lines through projects' own read (wording, billed minutes, unit, proof
//   labels, the rate frozen at Create): never real time, a note, an estimate or a person.
// - It takes no number. Issuing is a separate act: the draft gets an issue approval, decided by a
//   holder of `invoicing:documents:write`. The approval always parks (a cross-app hop runs as the
//   in-app agent), with a hidden anchor thread when the card has none. If it cannot park (too few
//   people can decide it), the draft stays and is issued from the pending list.
// - The client activity report is stored with it, version 1.

import { type ActivityReportLine, buildActivityReport } from "../activity-report"
import { lineQuantity } from "../line-amount"
import { recipientOf } from "../recipient"
import { previewTotals, unitOfBasis } from "../tools/preview-totals"
import { draftsCreate } from "./drafts"
import type { MutationsCtx } from "./shared"

type Row = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** An issue approval waits up to 30 days. */
export const ISSUE_APPROVAL_EXPIRY_HOURS = 720

export interface DraftFromReconcileInput {
  reconciliationId?: string
  revision?: number
  /** The project lead's name, signing the activity report (the projects app passes it). */
  leadName?: string | null
}

export interface DraftFromReconcileCtx extends MutationsCtx {
  logger?: { warn?: (msg: string, data?: Record<string, unknown>) => void }
}

export type DraftFromReconcileResult =
  | {
      status: "completed"
      draftId: string
      draftTitle: string
      /** The pending issue approval; null when it could not park (issue it from the pending list). */
      approvalId: string | null
      approved: boolean
      created: boolean
      totals: { excl: number; vat: number; incl: number; currency: string }
      message: string
    }
  | { status: "error"; error: { code: string; message: string; retryable: false } }

interface LinesRead {
  reconciliationId: string
  projectId: string
  projectName?: string
  companyId?: string | null
  basis: string
  state: string
  revision: number
  documentRef: string | null
  period: { from: string; to: string }
  rate: { rateMinor: number | null; currency: string | null; hoursPerDayMinutes: number }
  lines: Array<{
    lineId: string
    position: number
    wording: string
    billMinutes: number
    proofLabels: string[]
  }>
}

const refuse = (code: string, message: string): DraftFromReconcileResult => ({
  status: "error",
  error: { code, message, retryable: false },
})

/** The last day of the month of a YYYY-MM-DD day. */
export function monthEnd(day: string): string {
  const [y, m] = day.split("-").map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`
}

const MISSING_REFUSAL: Record<string, [string, string]> = {
  issuer_profile: [
    "no_issuer_profile",
    "no issuer profile is set up in invoicing, so no draft was made. Create the issuer profile in invoicing settings, then press Create invoice again.",
  ],
  company: [
    "company_missing",
    "the project has no company, so no draft was made. Set the project's company, then press Create invoice again.",
  ],
  rate: [
    "rate_missing",
    "the project has no rate, so no draft was made. Set its billing terms, then press Create invoice again.",
  ],
  currency: [
    "currency_missing",
    "the project has no currency, so no draft was made. Set its billing terms, then press Create invoice again.",
  ],
  counterparty_mismatch: [
    "counterparty_mismatch",
    "the invoice's customer is not the project's company, so no draft was made.",
  ],
  basis: [
    "basis_not_billable",
    "this project bills by a fixed price or a billing plan, not from planned vs done, so no draft was made.",
  ],
}

async function findByKey(ctx: MutationsCtx, key: string): Promise<Row | null> {
  const rows = (await ctx.db.findMany("documents", {
    where: { external_ref: key },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
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

function titleOf(projectName: string, period: { from: string; to: string }): string {
  return `Invoice draft for ${projectName}, ${period.from} to ${period.to}`
}

function totalsOf(doc: Row): { excl: number; vat: number; incl: number } {
  const excl = Number(doc.subtotal_minor ?? 0)
  const vat = Number(doc.tax_total_minor ?? 0)
  return { excl, vat, incl: Number(doc.grand_total_minor ?? excl + vat) }
}

/** The answer for a draft that already exists for this card revision (a retry, a double click). */
async function existing(
  ctx: MutationsCtx,
  doc: Row,
  read: Pick<LinesRead, "projectName" | "period">,
  totals: { excl: number; vat: number; incl: number },
  currency: string,
): Promise<DraftFromReconcileResult> {
  const draftId = String(doc.id)
  const approvalId = await pendingIssueApproval(ctx, draftId)
  const approved = typeof doc.approved_by === "string" && doc.approved_by !== ""
  const title = titleOf(read.projectName ?? "the project", read.period)
  return {
    status: "completed",
    draftId,
    draftTitle: title,
    approvalId,
    approved,
    created: false,
    totals: { ...totals, currency },
    message:
      doc.status === "draft"
        ? `${title} already exists (draft ${draftId}); nothing new was made and no number was taken.`
        : `This card's invoice was already issued as ${String(doc.number ?? doc.id)}; nothing new was made.`,
  }
}

export async function draftFromReconcile(
  ctx: DraftFromReconcileCtx,
  input: DraftFromReconcileInput,
): Promise<DraftFromReconcileResult> {
  const reconciliationId = typeof input.reconciliationId === "string" ? input.reconciliationId : ""
  const revision = Number(input.revision)
  if (!UUID.test(reconciliationId) || !Number.isInteger(revision) || revision < 1) {
    return refuse(
      "invalid_input",
      "reconciliationId must be a reconciliation id and revision its card revision. No draft was made.",
    )
  }
  const key = `reconcile:${reconciliationId}:${revision}`

  let env: Awaited<ReturnType<MutationsCtx["executeTool"]>>
  try {
    env = await ctx.executeTool("projects:reconcile_lines_read", { reconciliationId })
  } catch {
    return refuse(
      "card_unreadable",
      "The planned vs done card could not be read. No draft was made.",
    )
  }
  if (env?.status !== "completed")
    return refuse(
      "card_unreadable",
      "The planned vs done card could not be read. No draft was made.",
    )
  const read = (env.result ?? {}) as LinesRead
  const currency = read.rate?.currency ?? null

  const found = await findByKey(ctx, key)
  if (found) return existing(ctx, found, read, totalsOf(found), String(found.currency ?? currency))

  if (read.revision !== revision) {
    return refuse(
      "card_changed",
      `The card changed since it was shown (revision ${read.revision}, not ${revision}). No draft was made. Open the latest card and press Create invoice there.`,
    )
  }
  if (read.documentRef && read.documentRef !== key) {
    return refuse(
      "card_changed",
      "The card was invoiced under another revision. No draft was made.",
    )
  }
  if (read.state === "invoiced" || read.state === "credited") {
    return refuse("already_invoiced", `The card is already ${read.state}. No draft was made.`)
  }
  if (!DAY.test(read.period?.from ?? "") || !DAY.test(read.period?.to ?? "")) {
    return refuse("card_unreadable", "The card's period could not be read. No draft was made.")
  }
  if (!Array.isArray(read.lines) || read.lines.length === 0) {
    return refuse("nothing_billed", "The card bills no line. No draft was made.")
  }

  const preview = await previewTotals(ctx, {
    projectId: read.projectId,
    basis: read.basis,
    companyId: read.companyId ?? null,
    currency,
    rateMinor: read.rate?.rateMinor ?? null,
    hoursPerDayMinutes: read.rate?.hoursPerDayMinutes ?? null,
    lines: read.lines.map((l) => ({ billMinutes: l.billMinutes })),
  })
  if ("error" in preview) return refuse(preview.error.code, preview.error.message)
  if (!preview.ready) {
    const first = preview.missing[0] as string
    const [code, why] = MISSING_REFUSAL[first] ?? ["not_ready", "no draft was made."]
    return refuse(code, `For ${read.projectName ?? "this project"}, ${why}`)
  }

  const unit = unitOfBasis(read.basis)
  const hpd = read.rate.hoursPerDayMinutes
  const rate = read.rate.rateMinor as number
  const recipient = await recipientOf(ctx, { contactId: null, companyId: read.companyId ?? null })
  const created = await draftsCreate(ctx, {
    type: "invoice",
    counterparty_contact_id: null,
    ...recipient,
    currency: currency as string,
    operation_category: "services",
    items: read.lines.map((l, i) => ({
      position: i + 1,
      description: l.wording,
      quantity: lineQuantity(l.billMinutes, unit, hpd),
      unit_price_minor: BigInt(rate),
      line_kind: "service",
      product_source: null,
      external_id: `reconcile_line:${l.lineId}`,
    })),
  } as never)
  const draftId = created.draft_id

  const canIssue = ctx.hasScope ? await ctx.hasScope("invoicing:documents:write") : false
  const userId = await ctx.getUserId()
  const today = (await ctx.time.civil({ timezone: "UTC" })).date
  try {
    await ctx.db.update("documents", draftId, {
      external_ref: key,
      billing_project_id: read.projectId,
      service_period_start: read.period.from,
      service_period_end: read.period.to,
      latest_issue_on: monthEnd(read.period.to),
      ...(canIssue ? { approved_by: userId, approved_at: today } : {}),
    })
  } catch (err) {
    // Another click made this card's draft first: drop ours (it has no number) and answer theirs.
    await ctx.db.delete("documents", draftId).catch(() => {})
    const winner = await findByKey(ctx, key)
    if (!winner) throw err
    return existing(ctx, winner, read, totalsOf(winner), currency as string)
  }

  const reportLines: ActivityReportLine[] = read.lines.map((l) => ({
    wording: l.wording,
    billedMinutes: l.billMinutes,
    unit,
    proofLabels: Array.isArray(l.proofLabels) ? l.proofLabels : [],
  }))
  await ctx.db.insert("activity_reports", {
    document_id: draftId,
    version: 1,
    content: buildActivityReport({
      project: { id: read.projectId, name: read.projectName ?? "" },
      period: read.period,
      hoursPerDayMinutes: hpd,
      lines: reportLines,
      lead:
        typeof input.leadName === "string" && input.leadName.trim() !== "" ? input.leadName : null,
    }),
  })

  const title = titleOf(read.projectName ?? "the project", read.period)
  const totals = {
    excl: preview.excl ?? 0,
    vat: preview.vat ?? 0,
    incl: preview.incl ?? 0,
    currency: currency as string,
  }
  let approvalId: string | null = null
  try {
    const parked = await ctx.requestApproval({
      tool_name: "invoicing:invoice_issue",
      summary: `Issue ${title}`,
      summary_detail: {
        subtitle: `${read.lines.length} line${read.lines.length === 1 ? "" : "s"} from planned vs done`,
        lines: [`Issue by ${monthEnd(read.period.to)}`],
      },
      current_payload: { draft_id: draftId },
      approve_scope: "invoicing:documents:write",
      expiry_hours: ISSUE_APPROVAL_EXPIRY_HOURS,
    })
    approvalId = typeof parked?.approval_id === "string" ? parked.approval_id : null
  } catch (err) {
    ctx.logger?.warn?.("the issue approval of a draft from planned vs done could not park", {
      draftId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
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
    totals,
    message: `Created ${title} (draft ${draftId}), ${who}. No number was taken. ${next}`,
  }
}
