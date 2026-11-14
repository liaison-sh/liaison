// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Advances (acomptes) on a project: an ordinary invoice in the normal series, with its VAT, its
// own number at issue, `invoice_role = advance`, cited by the final that deducts it. And the
// refund of an advance when the project stops before its final: a credit note citing the advance,
// capped at what remains of it, which parks exactly as credit_note_create_and_issue does.

import { formatMoneyMinor } from "../money"
import { recipientOf } from "../recipient"
import { advanceDeductedRefusal } from "./advance-guard"
import {
  advanceRemaining,
  draftTotals,
  raiseIssueApproval,
  recipientOfQuote,
  refuse,
  shortDate,
  stepsOf,
} from "./billing-plan"
import { creditNoteCreateAndIssue } from "./credit-notes"
import { resolveIssuerProfileOrError } from "./db-helpers"
import { draftsCreate } from "./drafts"
import { counterpartyFromRow } from "./lines"
import type { ErrorEnvelope, MutationsCtx, PreflightResult } from "./shared"

type Row = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ISSUED = new Set(["issued", "paid", "overdue", "refunded"])

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

export interface AdvanceDraftCreateInput {
  projectId?: string
  stepId?: string | null
  amountMinor?: number | null
  receivedOn?: string | null
  contactId?: string | null
}

export async function advanceDraftCreate(
  ctx: MutationsCtx & { logger?: { warn?: (m: string, d?: Row) => void } },
  input: AdvanceDraftCreateInput,
) {
  const projectId = typeof input.projectId === "string" ? input.projectId : ""
  if (!UUID.test(projectId))
    return refuse(
      "invalid_project",
      `projectId ${projectId || "(none)"} is not a project id. Nothing was drafted.`,
    )
  const receivedOn =
    typeof input.receivedOn === "string" && DAY.test(input.receivedOn) ? input.receivedOn : null
  const steps = await stepsOf(ctx, projectId)
  const step =
    typeof input.stepId === "string" && input.stepId !== ""
      ? (steps.find((s) => s.id === input.stepId) ?? null)
      : null
  if (input.stepId && !step)
    return refuse(
      "no_billing_step",
      `Step ${input.stepId} is not a step of this project's plan. Nothing was drafted.`,
    )
  if (step && step.kind !== "advance")
    return refuse(
      "not_an_advance_step",
      `Step "${String(step.label)}" is a ${String(step.kind)}, not an advance. Nothing was drafted; a milestone is drafted from its task (milestone_draft_create).`,
    )

  const amount = step
    ? asBig(step.amount_minor)
    : typeof input.amountMinor === "number" && Number.isInteger(input.amountMinor)
      ? BigInt(input.amountMinor)
      : 0n
  if (amount <= 0n)
    return refuse(
      "invalid_amount",
      "An advance needs a positive amountMinor (excl. VAT), or the plan step it bills. Nothing was drafted.",
    )

  const key = step
    ? `advance:${String(step.id)}`
    : `advance:${projectId}:${receivedOn ?? "undated"}:${amount}`
  const existing = await one(ctx, "documents", { external_ref: key })
  if (existing)
    return refuse(
      "already_drafted",
      existing.status === "draft"
        ? `This advance already has its draft ${String(existing.id)}; nothing new was drafted.`
        : `This advance was already invoiced as ${String(existing.number ?? existing.id)}; nothing new was drafted.`,
    )

  // An advance drafted after the project's final would never be deducted: the final took its
  // deductions when it was drafted.
  const finals = (await ctx.db.findMany("documents", {
    where: { billing_project_id: projectId, invoice_role: "final" },
    limit: 20,
  })) as Row[]
  const final = finals.find((d) => d.status !== "cancelled" && d.status !== "voided")
  if (final)
    return refuse(
      "final_already_drafted",
      `This project's final invoice ${final.number ? String(final.number) : `draft ${String(final.id)}`} already exists, so no advance was drafted: an advance after the final is never deducted. ${final.number ? "Bill the rest as an ordinary invoice." : "Discard the final's draft, draft the advance, then draft the final again."}`,
    )

  // The customer: the plan's quote, else the contact named.
  const quoteId = (step ?? steps.find((s) => typeof s.quote_document_id === "string"))
    ?.quote_document_id
  const quote = typeof quoteId === "string" ? await one(ctx, "documents", { id: quoteId }) : null
  let recipient: Row
  if (quote) recipient = recipientOfQuote(quote)
  else if (typeof input.contactId === "string" && UUID.test(input.contactId))
    recipient = {
      counterparty_contact_id: input.contactId,
      ...(await recipientOf(ctx, { contactId: input.contactId, companyId: null })),
    }
  else
    return refuse(
      "no_customer",
      "The project has no billing plan with a quote, and no contactId was given, so the advance has no customer. Nothing was drafted.",
    )

  const issuer = await resolveIssuerProfileOrError(ctx.db, null)
  if (!issuer.ok)
    return refuse(
      "no_issuer_profile",
      "No issuer profile is set up in invoicing, so nothing was drafted.",
    )
  const currency = String(
    step?.currency ??
      quote?.currency ??
      (issuer.issuer as { default_currency?: string }).default_currency ??
      "EUR",
  )
  const stepRate = typeof step?.tax_rate_bp === "number" ? step.tax_rate_bp : undefined
  const label = step
    ? String(step.label)
    : quote?.number
      ? `Advance on quote ${String(quote.number)}`
      : "Advance"
  const items = [
    {
      position: 1,
      description: quote?.number && step ? `${label} (quote ${String(quote.number)})` : label,
      quantity: "1",
      unit_price_minor: amount,
      line_kind: "service",
      product_source: null,
      external_id: key,
      ...(stepRate !== undefined ? { tax_rate_bp_override: stepRate } : {}),
    },
  ]
  const created = await draftsCreate(ctx, {
    type: "invoice",
    ...recipient,
    currency,
    operation_category: "services",
    items,
  } as never)
  const draftId = created.draft_id
  try {
    await ctx.db.update("documents", draftId, {
      external_ref: key,
      billing_project_id: projectId,
      invoice_role: "advance",
      payment_state: "due",
      // Money received before the work: the advance invoice is due at receipt.
      ...(receivedOn ? { latest_issue_on: receivedOn } : {}),
      ...(quote
        ? {
            external_refs: {
              quote_document_id: String(quote.id),
              quote_number: quote.number ?? null,
            },
          }
        : {}),
    })
  } catch (err) {
    await ctx.db.delete("documents", draftId).catch(() => {})
    const winner = await one(ctx, "documents", { external_ref: key })
    if (!winner) throw err
    return refuse(
      "already_drafted",
      `This advance already has its draft ${String(winner.id)}; nothing new was drafted.`,
    )
  }
  if (step)
    await ctx.db.update("billing_steps", String(step.id), {
      document_id: draftId,
      state: "drafted",
    })

  const totals = await draftTotals(ctx, recipient as never, items)
  const title = `Advance invoice draft, ${label}`
  const approvalId = await raiseIssueApproval(ctx, draftId, title, [
    `${formatMoneyMinor(amount, currency)} excl. VAT, ${formatMoneyMinor(BigInt(totals.incl), currency)} incl. VAT`,
    ...(receivedOn ? [`Received on ${shortDate(receivedOn)}`] : []),
  ])
  return {
    status: "completed" as const,
    draftId,
    draftTitle: title,
    approvalId,
    totals: { ...totals, currency },
    message:
      `Created ${title} (draft ${draftId}): ${formatMoneyMinor(BigInt(totals.excl), currency)} excl. VAT, ${formatMoneyMinor(BigInt(totals.vat), currency)} VAT, ${formatMoneyMinor(BigInt(totals.incl), currency)}. It takes the normal invoice series at issue; no number was taken. The final invoice will deduct it. ` +
      (approvalId
        ? `Issuing it is waiting on approval ${approvalId}.`
        : "Its issue approval could not be raised: issue it from the pending list."),
  }
}

export interface AdvanceRefundPrepareInput {
  advanceDocumentId?: string
}

/**
 * Refund what remains of an advance as a credit note citing it, when the project stops before its
 * final. The credit note is made by credit_note_create_and_issue's own path, so it parks the same
 * way and its cap and the deducted-advance refusal are checked again when it is approved.
 */
/** The checks of a refund, with nothing written: the advance, its state, and what remains of it. */
async function refundable(
  ctx: MutationsCtx,
  input: AdvanceRefundPrepareInput,
): Promise<{ doc: Row; remaining: bigint } | ReturnType<typeof refuse> | ErrorEnvelope> {
  const id = typeof input.advanceDocumentId === "string" ? input.advanceDocumentId : ""
  const doc = UUID.test(id) ? await one(ctx, "documents", { id }) : null
  if (!doc || doc.type !== "invoice" || doc.invoice_role !== "advance")
    return refuse(
      "not_an_advance",
      `${id || "(none)"} is not an advance invoice. No credit note was made.`,
    )
  if (!ISSUED.has(String(doc.status)))
    return refuse(
      "advance_not_issued",
      `Advance ${String(doc.id)} is not issued, so there is nothing to refund. Discard the draft instead.`,
    )
  const deducted = await advanceDeductedRefusal(ctx.db, String(doc.id))
  if (deducted) return deducted
  const remaining = await advanceRemaining(ctx, doc)
  if (remaining <= 0n)
    return refuse(
      "nothing_to_refund",
      `Advance ${String(doc.number)} is already fully credited. No credit note was made.`,
    )
  return { doc, remaining }
}

/** Staging check of advance_refund_prepare: the same refusals, before any approval is raised. */
export async function advanceRefundPreflight(
  ctx: MutationsCtx,
  input: AdvanceRefundPrepareInput,
): Promise<PreflightResult> {
  const r = await refundable(ctx, input)
  if ("status" in r) return { error: r.error }
  return { ok: true }
}

export async function advanceRefundPrepare(ctx: MutationsCtx, input: AdvanceRefundPrepareInput) {
  const checked = await refundable(ctx, input)
  if ("status" in checked) return checked
  const { doc, remaining } = checked
  const currency = String(doc.currency ?? "EUR")
  const lines = (await ctx.db.findMany("document_lines", {
    where: { document_id: String(doc.id) },
    limit: 200,
  })) as Row[]
  const total = asBig(doc.grand_total_minor)
  const rates = [...new Set(lines.map((l) => Number(l.tax_rate_bp ?? 0)))]
  let items: Array<Record<string, unknown>>
  if (remaining >= total) {
    items = lines
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((l, i) => ({
        position: i + 1,
        description: `Refund of ${String(l.description)}`,
        quantity: String(l.quantity ?? "1"),
        unit_price_minor: -asBig(l.unit_price_minor),
        line_kind: "service",
        tax_rate_bp_override: Number(l.tax_rate_bp ?? 0),
      }))
  } else if (rates.length === 1) {
    // Part of it was credited already: refund the rest, net of its one VAT rate.
    const rate = rates[0] as number
    const net = (remaining * 10000n) / BigInt(10000 + rate)
    items = [
      {
        position: 1,
        description: `Refund of the rest of advance ${String(doc.number)}`,
        quantity: "1",
        unit_price_minor: -net,
        line_kind: "service",
        tax_rate_bp_override: rate,
      },
    ]
  } else
    return refuse(
      "refund_by_hand",
      `Advance ${String(doc.number)} has several VAT rates and was partly credited, so the rest (${formatMoneyMinor(remaining, currency)}) was not worked out. Make the credit note with credit_note_create_and_issue, line by line.`,
    )
  const issuer = await resolveIssuerProfileOrError(
    ctx.db,
    String(doc.issuer_profile_id ?? "") || null,
  )
  if (!issuer.ok) return issuer.error
  const res = await creditNoteCreateAndIssue(ctx, {
    issuer_profile_id: issuer.issuer.id,
    counterparty: counterpartyFromRow(doc as never, issuer.issuer as never),
    currency,
    items: items as never,
    original_document_id: String(doc.id),
    reason: `Refund of advance ${String(doc.number)} of ${shortDate(doc.issued_at)}: the project stopped before its final invoice.`,
    operation_category: "services",
  })
  const what = `a credit note of ${formatMoneyMinor(remaining, currency)} citing advance ${String(doc.number)} of ${shortDate(doc.issued_at)}`
  if (res.status === "completed") return { ...res, message: `Issued ${what} as ${res.number}.` }
  if (res.status === "pending_approval")
    return {
      ...res,
      message: `Prepared ${what}; it is waiting on approval ${String((res as { approval_id?: unknown }).approval_id ?? "")} and is not issued until a person approves it.`,
    }
  return res
}
