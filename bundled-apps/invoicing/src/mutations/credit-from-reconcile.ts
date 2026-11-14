// SPDX-License-Identifier: FSL-1.1-ALv2
//
// credit_note_from_reconcile: correct one billed line of an invoice made from a planned vs done
// card ("Data export was 2.5 days, not 3"). An issued invoice is never edited: the correction is a
// credit note citing it, for (billed - corrected) x the line's rate, in the credit note series.
//
// - The billed figure it starts from is the issued line's, less what earlier credit notes of that
//   line took off: never real time or anything entered on the project after the issue.
// - It never raises a billed figure (`use_new_line`) and never credits past what remains of the
//   invoice (`over_credit`, the credit note path's own cap).
// - It always waits for a person: an agent's or a coding agent's call parks an approval of this
//   tool, decided by a holder of `invoicing:documents:write`; a person's own click runs at once on
//   their scope. Every check runs again when the approval is decided, inside the run that issues,
//   so two corrections of one line parked side by side cannot both credit it: the second finds the
//   line already corrected. The note's key `credit:<reconciliation>:<line>:<n>` and the report's
//   next version are unique, so two runs racing past the checks cannot both commit.
// - On issue, in the same commit, the activity report gets a corrected version linked to the
//   credit note; then projects records the billed-after-credit figure (`reconcile_mark`), or frees
//   the card's sources when the invoice is now fully credited.

import { asHandlerSummary, issueCard } from "../approval-cards"
import type { DraftLineInput, IssueBatchOp } from "../issue"
import { lineQuantity } from "../line-amount"
import { formatMoneyMinor } from "../money"
import type { ClassifyInput } from "../tax"
import { unitOfBasis } from "../tools/preview-totals"
import { creditedTotalMinor, ISSUED_INVOICE_STATUSES } from "./credit-coverage"
import { prepareCreditNoteCreateAndIssue } from "./credit-notes"
import { dateOnly, resolveIssuerProfileOrError } from "./db-helpers"
import { issueWithFxRate } from "./fx-issue"
import { computeLineFinancials, counterpartyFromRow, normaliseDraftLines } from "./lines"
import type { ErrorEnvelope, MutationsCtx, PreflightResult } from "./shared"

type Row = Record<string, unknown>

export const CREDIT_FROM_RECONCILE_TOOL = "invoicing:credit_note_from_reconcile"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CreditFromReconcileInput {
  reconciliationId?: string
  lineId?: string
  /** What the line should have billed, in its unit (days or hours), at most two decimals. */
  correctedQuantity?: number | string
  reason?: string | null
}

interface LinesRead {
  reconciliationId: string
  projectName?: string
  basis: string
  state: string
  documentRef: string | null
  rate?: { hoursPerDayMinutes?: number; unit?: string }
  lines: Array<{ lineId: string; position: number; wording: string; billMinutes: number }>
}

interface Assessed {
  read: LinesRead
  line: LinesRead["lines"][number]
  invoice: Row
  invoiceLine: Row
  unit: "day" | "hour"
  perMinutes: number
  billedH: number
  correctedH: number
  priorNotes: number
  key: string
  items: DraftLineInput[]
  counterparty: ReturnType<typeof counterpartyFromRow>
  issuerId: string
  currency: string
  totals: { excl: bigint; vat: bigint; incl: bigint }
  reason: string
}

const refuse = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

const asJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

/** A decimal quantity as hundredths, or null when it is not one (more than two decimals too). */
export function toHundredths(v: unknown): number | null {
  const s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v ?? "")
  const m = s
    .trim()
    .replace(",", ".")
    .match(/^(\d+)(?:\.(\d{1,2})0*)?$/)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0")
}

/** Hundredths written as the invoice writes a quantity: "2.5", "3", "0.25". */
export function fromHundredths(h: number): string {
  const whole = Math.floor(h / 100)
  const frac = h % 100
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`
}

const unitWord = (unit: "day" | "hour", h: number) =>
  unit === "day" ? (h === 100 ? "day" : "days") : h === 100 ? "hour" : "hours"

async function rows(ctx: MutationsCtx, entity: string, where: Row, limit = 200): Promise<Row[]> {
  return (await ctx.db.findMany(entity, { where, limit })) as Row[]
}

/** Every check of a correction, with nothing written: run at staging and again at approval. */
async function assess(
  ctx: MutationsCtx,
  input: CreditFromReconcileInput,
): Promise<Assessed | ErrorEnvelope> {
  const reconciliationId = typeof input.reconciliationId === "string" ? input.reconciliationId : ""
  const lineId = typeof input.lineId === "string" ? input.lineId.trim() : ""
  if (!UUID.test(reconciliationId) || lineId === "" || lineId.length > 100)
    return refuse(
      "invalid_input",
      "reconciliationId must be a reconciliation id and lineId one of its lines. No credit note was made.",
    )
  const correctedH = toHundredths(input.correctedQuantity)
  if (correctedH === null)
    return refuse(
      "invalid_input",
      `correctedQuantity must be a quantity of 0 or more with at most two decimals (2.5), not ${JSON.stringify(input.correctedQuantity)}. No credit note was made.`,
    )

  let env: Awaited<ReturnType<MutationsCtx["executeTool"]>>
  try {
    env = await ctx.executeTool("projects:reconcile_lines_read", { reconciliationId })
  } catch {
    env = { status: "error", error: { code: "card_unreadable", message: "" } }
  }
  if (env?.status !== "completed")
    return refuse(
      "card_unreadable",
      "The planned vs done card could not be read. No credit note was made.",
    )
  const read = (env.result ?? {}) as LinesRead
  const line = (Array.isArray(read.lines) ? read.lines : []).find((l) => l.lineId === lineId)
  if (!line)
    return refuse(
      "line_not_found",
      `Line ${lineId} is not a billed line of this planned vs done card. No credit note was made.`,
    )

  const invoice = read.documentRef
    ? (await rows(ctx, "documents", { external_ref: read.documentRef }, 5)).find(
        (d) => d.type === "invoice" && ISSUED_INVOICE_STATUSES.has(String(d.status)),
      )
    : undefined
  if (!invoice)
    return refuse(
      "not_invoiced",
      `The card of ${read.projectName ?? "this project"} has no issued invoice, so there is nothing to credit. While its invoice is a draft, change the line on the card (Undo, edit, create again).`,
    )
  const invoiceLine = (
    await rows(ctx, "document_lines", {
      document_id: String(invoice.id),
      external_id: `reconcile_line:${lineId}`,
    })
  )[0]
  if (!invoiceLine)
    return refuse(
      "line_not_on_invoice",
      `"${line.wording}" is not a line of invoice ${String(invoice.number)}, so it cannot be corrected from the card. Make the credit note with credit_note_create_and_issue.`,
    )

  const invoicedH = toHundredths(invoiceLine.quantity)
  if (invoicedH === null)
    return refuse(
      "correction_by_hand",
      `Line "${line.wording}" of invoice ${String(invoice.number)} has a quantity this correction cannot work with (${String(invoiceLine.quantity)}). Make the credit note with credit_note_create_and_issue.`,
    )
  // What earlier credit notes of this line took off: the billed figure the correction starts from.
  const notes = (await rows(ctx, "documents", { original_document_id: String(invoice.id) }, 100))
    .filter((d) => d.type === "credit_note" && d.status !== "draft")
    .map((d) => String(d.id))
  let creditedH = 0
  let priorNotes = 0
  for (const noteId of notes) {
    const taken = await rows(ctx, "document_lines", {
      document_id: noteId,
      external_id: `reconcile_line:${lineId}`,
    })
    if (taken.length > 0) priorNotes += 1
    for (const t of taken) creditedH += toHundredths(t.quantity) ?? 0
  }
  const billedH = invoicedH - creditedH
  const unit = (
    read.rate?.unit === "day" || read.rate?.unit === "hour"
      ? read.rate.unit
      : unitOfBasis(read.basis)
  ) as "day" | "hour"
  const words = (h: number) => `${fromHundredths(h)} ${unitWord(unit, h)}`
  if (correctedH > billedH)
    return refuse(
      "use_new_line",
      `"${line.wording}" is billed ${words(billedH)} on invoice ${String(invoice.number)}; ${words(correctedH)} would bill more, and a credit note only takes off. No credit note was made. Bill the extra on next month's card or on a new invoice.`,
    )
  if (correctedH === billedH)
    return refuse(
      "nothing_to_credit",
      `"${line.wording}" is already billed ${words(billedH)} on invoice ${String(invoice.number)}${priorNotes > 0 ? " after its credit notes" : ""}. No credit note was made.`,
    )

  const issuer = await resolveIssuerProfileOrError(
    ctx.db,
    String(invoice.issuer_profile_id ?? "") || null,
  )
  if (!issuer.ok) return issuer.error
  const currency = String(invoice.currency ?? "EUR")
  const items: DraftLineInput[] = [
    {
      position: 1,
      description: `${String(invoiceLine.description ?? line.wording)}: corrected from ${words(billedH)} to ${words(correctedH)}`,
      quantity: fromHundredths(billedH - correctedH),
      unit_price_minor: -BigInt(String(invoiceLine.unit_price_minor ?? 0)),
      line_kind: "service",
      tax_rate_bp_override: Number(invoiceLine.tax_rate_bp ?? 0),
      external_id: `reconcile_line:${lineId}`,
    } as DraftLineInput,
  ]
  const counterparty = counterpartyFromRow(invoice as never, issuer.issuer as never)
  const classifyInput: ClassifyInput = {
    issuer_country: issuer.issuer.country,
    counterparty_country: counterparty.country,
    has_vat_id: !!counterparty.vat_id,
  }
  const f = computeLineFinancials(normaliseDraftLines(items), classifyInput)
  const given = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : ""
  const reason = `Correction of "${line.wording}": ${words(correctedH)} instead of ${words(billedH)}${given ? `. ${given}` : ""}`
  return {
    read,
    line,
    invoice,
    invoiceLine,
    unit,
    perMinutes: unit === "day" ? Number(read.rate?.hoursPerDayMinutes ?? 0) : 60,
    billedH,
    correctedH,
    priorNotes,
    key: `credit:${reconciliationId}:${lineId}:${priorNotes + 1}`,
    items,
    counterparty,
    issuerId: issuer.issuer.id,
    currency,
    totals: { excl: f.subtotal, vat: f.tax, incl: f.grand },
    reason,
  }
}

function moneyLine(a: Assessed): string {
  return `${formatMoneyMinor(a.totals.excl, a.currency)} excl. VAT, ${formatMoneyMinor(a.totals.vat, a.currency)} VAT, ${formatMoneyMinor(a.totals.incl, a.currency)}`
}

function citing(a: Assessed): string {
  const day = dateOnly(a.invoice.issued_at)
  return `invoice ${String(a.invoice.number)}${day ? ` of ${day}` : ""}`
}

/** Staging check: the same refusals as the run, before any approval is raised. */
export async function creditFromReconcilePreflight(
  ctx: MutationsCtx,
  input: CreditFromReconcileInput,
): Promise<PreflightResult> {
  const a = await assess(ctx, input)
  if ("status" in a) return { error: a.error }
  return { ok: true }
}

/** A correction of the same line already waiting on a person: answered instead of a second one. */
async function pendingForLine(
  ctx: MutationsCtx,
  reconciliationId: string,
  lineId: string,
): Promise<string | null> {
  const pendingFor = ctx.approvals?.pendingFor
  if (!pendingFor) return null
  try {
    const raw = asJson(await pendingFor("lineId", [CREDIT_FROM_RECONCILE_TOOL]))
    const hit = (Array.isArray(raw) ? raw : []).find((r: Row) => {
      const p = (asJson(r?.payload) ?? {}) as Row
      return r?.target_id === lineId && p.reconciliationId === reconciliationId
    }) as Row | undefined
    return typeof hit?.id === "string" ? hit.id : null
  } catch {
    return null
  }
}

export async function creditFromReconcile(ctx: MutationsCtx, input: CreditFromReconcileInput) {
  const a = await assess(ctx, input)
  if ("status" in a) return a
  const what = `a credit note of ${moneyLine(a)} citing ${citing(a)}, "${a.line.wording}" ${fromHundredths(a.billedH)} to ${fromHundredths(a.correctedH)} ${unitWord(a.unit, a.correctedH)}`

  if (!ctx.approval) {
    const payload = {
      reconciliationId: a.read.reconciliationId,
      lineId: a.line.lineId,
      correctedQuantity: fromHundredths(a.correctedH),
      ...(typeof input.reason === "string" && input.reason.trim() !== ""
        ? { reason: input.reason.trim() }
        : {}),
    }
    const waiting = await pendingForLine(ctx, payload.reconciliationId, payload.lineId)
    if (waiting)
      return {
        status: "pending_approval" as const,
        approval_id: waiting,
        message: `A correction of "${a.line.wording}" on ${citing(a)} is already waiting on approval ${waiting}; no second one was made. Nothing is credited until a person approves it.`,
      }
    // Never auto-approvable: an agent's correction always waits for a person; a person's own
    // click is decided by the tool's scope and runs at once.
    const approval = await ctx.requestApproval({
      tool_name: CREDIT_FROM_RECONCILE_TOOL,
      ...asHandlerSummary(
        issueCard({
          kind: "credit_note_from_reconcile",
          type: "credit_note",
          fromDraft: false,
          customer: a.counterparty.legal_name,
          country: a.counterparty.country,
          currency: a.currency,
          lines: normaliseDraftLines(a.items),
          totalMinor: a.totals.incl,
          reason: a.reason,
          originalNumber: String(a.invoice.number ?? ""),
          originalDate: dateOnly(a.invoice.issued_at),
          originalTotalMinor: BigInt(String(a.invoice.grand_total_minor ?? 0)),
          issuerName: null,
        }),
      ),
      current_payload: payload,
      approve_scope: "invoicing:documents:write",
    })
    if (!approval.auto_approved)
      return {
        status: "pending_approval" as const,
        approval_id: approval.approval_id,
        totals: {
          excl: Number(a.totals.excl),
          vat: Number(a.totals.vat),
          incl: Number(a.totals.incl),
          currency: a.currency,
        },
        message: `Prepared ${what}. It is waiting on approval ${approval.approval_id} and is not issued until a person approves it; no number was taken and the billed figure is unchanged.`,
      }
  }

  const prepared = await prepareCreditNoteCreateAndIssue(
    ctx,
    {
      issuer_profile_id: a.issuerId,
      counterparty: a.counterparty,
      currency: a.currency,
      items: a.items,
      original_document_id: String(a.invoice.id),
      reason: a.reason,
      operation_category: "services",
    },
    { external_ref: a.key },
  )
  if (!prepared.ok) return prepared.result

  // The corrected activity report, linked to the credit note, in the commit that issues it.
  const reports = await rows(ctx, "activity_reports", { document_id: String(a.invoice.id) }, 50)
  const latest = reports.sort((x, y) => Number(y.version) - Number(x.version))[0]
  const reportOps: IssueBatchOp[] = []
  let reportVersion: number | null = null
  if (latest) {
    const content = (asJson(latest.content) ?? {}) as Row
    const lines = (Array.isArray(content.lines) ? content.lines : []) as Row[]
    const at = Number(a.invoiceLine.position) - 1
    const corrected = lineQuantity(
      Math.round((a.correctedH * a.perMinutes) / 100),
      a.unit,
      a.unit === "day" ? a.perMinutes : 60,
    )
    reportVersion = Number(latest.version) + 1
    reportOps.push({
      insert: "activity_reports",
      data: {
        document_id: String(a.invoice.id),
        version: reportVersion,
        corrects_version: Number(latest.version),
        credit_note_id: { $ref: "document" },
        content: {
          ...content,
          lines: lines.map((l, i) =>
            i === at
              ? { ...l, billed: a.unit === "day" ? fromHundredths(a.correctedH) : corrected }
              : l,
          ),
        },
      },
    })
  }
  const issueInput = {
    ...prepared.credit.issueInput,
    commit_with: [...(prepared.credit.issueInput.commit_with ?? []), ...reportOps],
  }
  const issued = await issueWithFxRate(ctx, issueInput)
  if (!issued.ok) return issued.error
  await prepared.credit.after(issued.result)

  // Projects records the billed-after-credit figure, or frees the card's sources on a full credit.
  // Best effort: the projects sweep settles a full credit by itself.
  const after = (await rows(ctx, "documents", { id: String(a.invoice.id) }, 1))[0] ?? a.invoice
  const grand = BigInt(String(after.grand_total_minor ?? 0))
  const credited = await creditedTotalMinor(ctx.db, {
    id: String(after.id),
    lifecycle_log: ((asJson(after.lifecycle_log) as Row[] | null) ?? []) as Row[],
  })
  const full = grand !== 0n && credited >= (grand < 0n ? -grand : grand)
  const creditedMinutes = Math.max(
    0,
    a.line.billMinutes - Math.round((a.correctedH * a.perMinutes) / 100),
  )
  let marked = false
  try {
    const res = await ctx.executeTool("projects:reconcile_mark", {
      reconciliationId: a.read.reconciliationId,
      to: full ? "credited" : "partly_credited",
      documentId: String(a.invoice.id),
      creditedMinutesByLine: { [a.line.lineId]: creditedMinutes },
    })
    marked = res?.status === "completed"
  } catch {
    marked = false
  }
  const number = issued.result.number
  return {
    status: "completed" as const,
    document_id: issued.result.document_id,
    number,
    ...(issued.result.einvoicing_warning
      ? { einvoicing_warning: issued.result.einvoicing_warning }
      : {}),
    message:
      `Issued credit note ${number}: ${what}. ${
        full
          ? "The invoice is now fully credited, so the card's work can be billed again on a new reconciliation."
          : `The line now bills ${fromHundredths(a.correctedH)} ${unitWord(a.unit, a.correctedH)}.`
      }${reportVersion ? ` The activity report has a corrected version ${reportVersion}.` : ""} Real time and the invoice itself are unchanged.` +
      (marked ? "" : " The project's billed figure updates at its next check."),
  }
}
