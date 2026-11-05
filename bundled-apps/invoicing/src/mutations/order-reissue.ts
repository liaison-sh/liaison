// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: order.reissue_apply (operator-approved order-edit reissue).

import { type Counterparty, type DraftLine, type DraftLineInput, storedTaxCountry } from "../issue"
import { ISSUED_INVOICE_STATUSES } from "./credit-coverage"
import { creditNoteCreateAndIssue } from "./credit-notes"
import { findDocumentSummary, findIssuerProfile, loadDraftLines } from "./db-helpers"
import { invoiceCreateAndIssue } from "./invoice-issue"
import { normaliseDraftLines } from "./lines"
import type { Regime } from "../einvoicing/classify"
import { checkEinvoiceGate, counterpartyEinvoiceFields } from "../einvoicing/issue-gate"
import {
  type MutationResult,
  type MutationsCtx,
  type DocumentRowSummary,
  type ErrorEnvelope,
  type PreflightResult,
  normaliseNotes,
  lineAmountsError,
  toPreflightResult,
} from "./shared"

// ── order.reissue_apply (operator-approved order-edit reissue) ────────────
//
// A modified Shopify order (line set or amounts changed after the invoice was
// issued) needs a credit note against the original invoice AND a replacement
// invoice carrying the new items/amounts, as ONE human-reviewed decision — not
// two separate gated calls the operator could approve out of order or only
// half-approve. This tool is declared `"gated": true` in the manifest (always
// gated for the system/webhook caller that reaches it — see
// `handlers/shopify-order-updated.ts`), so the KERNEL parks the pending
// approval and calls this handler only once a human approves (`ctx.approval`
// populated). At that point it reuses the SAME issuance paths every other
// credit note / invoice goes through — `creditNoteCreateAndIssue` and
// `invoiceCreateAndIssue` — passing them THIS call's own `ctx`, so their
// internal `!ctx.approval` threshold-gate checks see the outer approval and
// skip straight to issuing (no nested approval, no new issuance logic).
export interface OrderReissueApplyInput {
  /** The invoice a downstream Shopify order edit diverged from. */
  original_document_id: string
  /** The Shopify order the replacement invoice links to (same order the
   *  original billed). */
  shopify_order_id: string
  /** The order's human name ("#1149"), carried onto the replacement invoice. */
  shopify_order_number?: string | null
  /** The order's billing signature at the moment this reissue was staged
   *  (see `billingSignature` in shopify-order-updated.ts) — identifies WHICH
   *  edit this approval answers. Not interpreted by this handler; carried so
   *  the approval card and dedupe key can reference it. */
  billing_signature: string
  /** `${shopify_order_id}:${billing_signature}` — the manifest
   *  `approvalDedupeKeyParam`. A second webhook delivery for the SAME edit
   *  computes the identical value, so the kernel collapses it into the
   *  existing pending approval instead of stacking a duplicate; a LATER,
   *  DIFFERENT edit produces a different value and raises a fresh one. */
  dedupe_key: string
  /** The order's CURRENT (post-edit) line items — carried onto the
   *  replacement invoice verbatim. */
  items: DraftLineInput[]
  currency?: string
  reason?: string | null
  /** Free-text notes applied to BOTH documents this tool issues (the credit note and the
   *  replacement invoice). When omitted, the ORIGINAL invoice's own notes carry onto both,
   *  same rule as po_number: a reissue reflects the same customer order, so it keeps the
   *  same mentions. An explicit null clears them on both. */
  notes?: string | null
}

export type OrderReissueApplyResult = MutationResult<{
  credit_note_document_id: string
  credit_note_number: string
  replacement_document_id: string
  replacement_number: string
}>

/**
 * Read-only validation shared by `orderReissueApply` and its stage-time preflight export: notes
 * length, the original document resolves, it IS an invoice, it was actually issued, the approval
 * is not stale, and it has lines to reverse. ONE copy, called from both sides, so the staged
 * refusal and the executed refusal can never drift apart.
 */
async function preflightOrderReissueApplyParams(
  ctx: MutationsCtx,
  input: OrderReissueApplyInput,
): Promise<
  | {
      ok: true
      original: DocumentRowSummary
      originalLines: DraftLine[]
      notes: { value: string | null | undefined }
      counterparty: Counterparty
    }
  | { ok: false; error: ErrorEnvelope }
> {
  const notes = normaliseNotes(input.notes)
  if (!notes.ok) return { ok: false, error: notes.error }
  // A price that is not a plain number ("$1") is refused here, before gating, never read as 0.
  const amountsErr = lineAmountsError(input.items)
  if (amountsErr) return { ok: false, error: amountsErr }
  const original = await findDocumentSummary(ctx.db, input.original_document_id)
  if (!original) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "not_found",
          message: `document ${input.original_document_id} not found`,
        },
      },
    }
  }
  if (original.type !== "invoice") {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_original_document",
          message: `original_document_id ${input.original_document_id} is a ${original.type}, not an invoice: a reissue can only replace an invoice`,
        },
      },
    }
  }
  if (!ISSUED_INVOICE_STATUSES.has(original.status ?? "draft")) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_original_document",
          message: `original_document_id ${input.original_document_id} has status "${original.status}", not an issued invoice: a reissue can only replace a document that was actually issued to the customer`,
        },
      },
    }
  }

  // Refuse a STALE approval: `onShopifyOrderUpdated` (shopify-order-updated.ts)
  // stamps `external_refs.downstream_order_sig` on this same document with
  // every billing signature it observes, advancing it on each genuine
  // billable edit -- so it is the app's own record of the LATEST signature
  // seen for this order, without a new cross-app round trip. `input.billing_signature`
  // is the signature this approval was raised for (part of its dedupe key). If
  // the order was edited again while the approval sat pending, a second, later
  // approval was raised for the new signature and advanced this field, leaving
  // this one stale: approving it would carry a line set the order no longer
  // has. Compare, and issue nothing if they differ.
  const latestSig = original.external_refs?.downstream_order_sig
  if (typeof latestSig === "string" && latestSig !== input.billing_signature) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "stale_reissue_approval",
          message: `document ${original.id} has a newer edit recorded for this order since this reissue was approved. A newer edit to this order exists and a fresh approval is needed.`,
        },
      },
    }
  }

  const originalLines = await loadDraftLines(ctx.db, original.id)
  if (originalLines.length === 0) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "empty_document",
          message: `document ${original.id} has no line items to reverse`,
        },
      },
    }
  }
  // E-invoicing gate on BOTH documents this tool issues, before the approval exists: the credit
  // note (it follows the original's regime; a legacy original is classified from the current
  // data) and the replacement invoice (same buyer, the order's current lines).
  const counterparty = reissueCounterparty(original)
  const issuer = await findIssuerProfile(ctx.db, original.issuer_profile_id)
  if (issuer) {
    const stated = original.einvoice?.operation_category ?? null
    const statedSource = original.einvoice?.operation_category_source ?? null
    const category = stated && statedSource !== "lines_default" ? stated : null
    const creditGate = await checkEinvoiceGate(ctx, {
      type: "credit_note",
      issuer,
      counterparty,
      lines: originalLines,
      original: {
        id: original.id,
        regime: (original.regime as Regime | null | undefined) ?? null,
        transmissionStatus: original.einvoice_state ?? null,
        counterparty_contact_id: original.counterparty_contact_id,
        snapshot: original.einvoice ?? null,
      },
    })
    if (!creditGate.ok) return { ok: false, error: creditGate.error }
    const invoiceGate = await checkEinvoiceGate(ctx, {
      type: "invoice",
      issuer,
      counterparty,
      lines: normaliseDraftLines(input.items ?? []),
      operation_category: category,
    })
    if (!invoiceGate.ok) return { ok: false, error: invoiceGate.error }
  }
  return { ok: true, original, originalLines, notes, counterparty }
}

/** The buyer of both reissued documents: the original invoice's stored recipient snapshot,
 *  including its e-invoicing columns (kind, SIREN and its confirmation, structured billing). */
function reissueCounterparty(original: DocumentRowSummary): Counterparty {
  return {
    ...(original.einvoice ? counterpartyEinvoiceFields(original.einvoice) : {}),
    contact_id: original.counterparty_contact_id,
    legal_name: original.counterparty_name ?? "",
    country: original.counterparty_country ?? "",
    tax_country: storedTaxCountry(original),
    vat_id: original.counterparty_vat_id,
    address: original.counterparty_address ?? "",
    shipping_address: original.counterparty_shipping_address ?? null,
    shipping_name: original.counterparty_shipping_name ?? null,
    email: original.counterparty_email ?? "",
  }
}

/**
 * STAGE-TIME preflight for the gated `order_reissue_apply` tool (manifest `preflight`). A gated
 * call must not be parked for a human when the data it needs is missing: an original that does
 * not resolve, is NOT an issued invoice (a draft, a quote, a credit note), or carries no lines to
 * reverse is refused here, before the approval request exists.
 */
export async function orderReissueApplyPreflight(
  ctx: MutationsCtx,
  input: OrderReissueApplyInput,
): Promise<PreflightResult> {
  return toPreflightResult(await preflightOrderReissueApplyParams(ctx, input))
}

export async function orderReissueApply(
  ctx: MutationsCtx,
  input: OrderReissueApplyInput,
): Promise<OrderReissueApplyResult> {
  // The stale-signature guard below ALSO runs at stage time (the preflight export shares this
  // exact code), but it stays here: that is precisely the state that changes while an approval
  // sits pending, so the executed call re-checks rather than trusts.
  const pre = await preflightOrderReissueApplyParams(ctx, input)
  if (!pre.ok) return pre.error
  const { original, originalLines, notes, counterparty } = pre

  const currency = input.currency ?? original.currency
  const statedCategory =
    original.einvoice?.operation_category && original.einvoice.operation_category_source !== "lines_default"
      ? original.einvoice.operation_category
      : null

  // Mirror the original's FULL line set, negated, so the credit note fully
  // reverses it. This is what `assertNoLiveInvoiceForOrder` (below, inside
  // invoiceCreateAndIssue) requires before it will let a replacement invoice
  // link the SAME shopify_order_id: "once its issued credit notes cover the
  // full total, the order is free for a replacement invoice" — this tool IS
  // that documented modify flow, run as one atomic step.
  const creditItems: DraftLineInput[] = originalLines.map((l) => ({
    ...l,
    unit_price_minor: -l.unit_price_minor,
    discount_minor: l.discount_minor != null ? -l.discount_minor : undefined,
  }))

  const creditResult = await creditNoteCreateAndIssue(ctx, {
    issuer_profile_id: original.issuer_profile_id,
    counterparty,
    currency,
    items: creditItems,
    original_document_id: original.id,
    reason:
      input.reason ??
      "Order edited after invoice issued: reissuing with the updated items/amounts",
    // Explicit notes win on both documents; otherwise creditNoteCreateAndIssue inherits the
    // original invoice's own notes (it reads them from original_document_id itself).
    notes: notes.value,
  })
  if (creditResult.status !== "completed") {
    // `ctx.approval` is populated on this post-approval re-entry, so
    // creditNoteCreateAndIssue's own `!ctx.approval` threshold gate cannot
    // fire (see its definition above) — this branch is only a real DB/typed
    // error, propagated as-is with nothing yet persisted for the invoice half.
    return creditResult
  }

  const invoiceResult = await invoiceCreateAndIssue(ctx, {
    issuer_profile_id: original.issuer_profile_id,
    counterparty,
    currency,
    shopify_order_id: input.shopify_order_id,
    shopify_order_number: input.shopify_order_number ?? original.shopify_order_number,
    // Carry the PO number forward to the replacement invoice, same as the order number above —
    // the reissue reflects the same customer order, so it keeps the same reference.
    po_number: original.po_number,
    // Same rule as po_number: carried onto the replacement unless the caller said otherwise.
    notes: notes.value === undefined ? original.notes : notes.value,
    // The replacement bills the same operation as the original: its stated category carries.
    operation_category: statedCategory,
    items: input.items,
  })
  if (invoiceResult.status !== "completed") {
    // The credit note above already ran inside THIS call's ambient
    // transaction (manifest `atomic: true` on order_reissue_apply — see
    // execute-tool.ts's whole-run ambient-transaction branch). A plain
    // `return` here would still COMMIT that credit note despite the overall
    // failure (atomic rollback triggers only on a THROWN error, never on an
    // error-status return), leaving the order half-reissued: credited but
    // with no replacement. Throwing aborts the whole transaction so NEITHER
    // document persists.
    const detail =
      invoiceResult.status === "error"
        ? `${invoiceResult.error.code}: ${invoiceResult.error.message}`
        : "unexpectedly parked a second approval"
    throw new Error(
      `order_reissue_apply: replacement invoice failed after crediting ${
        original.number ?? original.id
      } (credit note ${creditResult.number}): ${detail}`,
    )
  }

  // Link the replacement to the credited original the same way a credit note
  // already links to the document it reverses.
  const replacementDoc = await findDocumentSummary(ctx.db, invoiceResult.document_id)
  await ctx.db.update("documents", invoiceResult.document_id, {
    external_refs: {
      ...(replacementDoc?.external_refs ?? {}),
      original_document_id: original.id,
      original_document_number: original.number,
      // Belt and suspenders alongside the po_number passed into invoiceCreateAndIssue
      // above: this explicit copy is what a customer service dispute would actually read,
      // so it is asserted here rather than assumed to have survived the call above.
      ...(original.po_number ? { po_number: original.po_number } : {}),
    },
    // Mirror onto the first-class column too, matching the pattern everywhere else in this
    // file (the column is the canonical, searchable, rendered read path).
    ...(original.po_number ? { po_number: original.po_number } : {}),
  })

  return {
    status: "completed",
    credit_note_document_id: creditResult.document_id,
    credit_note_number: creditResult.number,
    replacement_document_id: invoiceResult.document_id,
    replacement_number: invoiceResult.number,
  }
}
