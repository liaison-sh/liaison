// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: the shared document types, result envelopes, notes normalisation,
// the mutation ctx/db contracts and the minor-amount coercion every group uses.

import { minorAmountRefusal, readMinorAmount } from "@liaison/app-sdk"
import { type BuyerVatFacts, needsHumanBuyerDecision } from "../buyer-vat"
import type { CrossAppExecuteTool } from "../cross-app"
import type { ReadsFetch } from "../reads"
import type { DraftLine, IssueCtx, IssueDb } from "../issue"
import type { CustomerKind } from "../einvoicing/classify"
import type { OperationCategory } from "../einvoicing/classify-operation"
import type { EinvoiceRowColumns } from "../einvoicing/issue-gate"
import { lineSubtotal } from "../money"

export type DocumentType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

export const VALID_TYPES: ReadonlyArray<DocumentType> = [
  "invoice",
  "quote",
  "proforma",
  "purchase_order",
  "credit_note",
] as const

export interface DraftInsert {
  type: DocumentType
  counterparty_contact_id: string | null
  /** Counterparty snapshot fields — freeform, editable from the UI's new "Customer" section, and
   *  persisted onto the draft `documents` row (the columns exist on the table since the
   *  counterparty-snapshot migration). Carried through to the issued document by issueDocument's
   *  counterparty stub when set; `documents_update` edits them post-issue via the SAME columns. */
  counterparty_name?: string | null
  counterparty_address?: string | null
  /** Ship to snapshot. RENDER ONLY: printed as the PDF's SHIP TO block when it differs from the
   *  billing address, and never an input to `classify()`, which keys off counterparty_country. */
  counterparty_shipping_address?: string | null
  counterparty_shipping_name?: string | null
  counterparty_vat_id?: string | null
  counterparty_email?: string | null
  /** Counterparty's ISO country — the tax classifier derives the treatment from it at issue/convert.
   *  Carried ON the draft (not stubbed to the issuer's country) so a drafted export/reverse-charge
   *  invoice issues at the correct rate; null falls back to the issuer's country (domestic). */
  counterparty_country?: string | null
  /** Stored treatment hint (informational — issue RE-DERIVES from counterparty_country); kept so a
   *  drafts_update of the treatment is not silently dropped. */
  tax_treatment?: string | null
  issuer_profile_id: string
  currency: string
  incoterm?: string
  due_at?: string | null
  external_refs?: Record<string, unknown>
  /** When this invoice reconciles a Shopify order, the order's id/name. A partial UNIQUE constraint on
   *  documents.shopify_order_id makes this IDEMPOTENT — only one document per order, so a duplicate
   *  drafts_create for an already-invoiced order is rejected instead of double-billing. */
  shopify_order_id?: string | null
  /** The order's HUMAN name ("#1149") when this document bills a Shopify order.
   *  Distinct from `shopify_order_id` (the numeric/gid API handle): this is what
   *  the customer quotes, what the invoice PDF prints, and what documents_search
   *  matches. */
  shopify_order_number?: string | null
  /** The customer's purchase order number, when they gave one. Mirrored onto
   *  `external_refs.po_number` by the caller, same pattern as shopify_order_number. */
  po_number?: string | null
  /** Free-text notes printed on the document face. A plain column with NO external_refs
   *  mirror (nothing ever wrote notes anywhere else), unlike po_number. */
  notes?: string | null
  /** E-invoicing: the buyer's kind, stated on the draft (an identity row on the contact wins). */
  customer_kind?: CustomerKind | null
  /** E-invoicing: the goods / services category of the operation, stated on the draft. */
  operation_category?: OperationCategory | null
  /** E-invoicing: the buyer's structured billing address (the free-form address stays the
   *  printed Bill-to block). */
  billing_line1?: string | null
  billing_line2?: string | null
  billing_postcode?: string | null
  billing_city?: string | null
  billing_country_code?: string | null
  lines: DraftLine[]
}

export interface DraftRow extends DraftInsert {
  id: string
  /** The draft's stored e-invoicing columns (read only: identity facts and confirmation are
   *  written by the identity tools, never by a draft patch). */
  einvoice?: EinvoiceRowColumns
  /** The draft's own creation date (the auto-injected `documents.created_at` column,
   *  already present on the row `getDraft` fetches) — the most operator-useful date on a
   *  not-yet-issued draft, since it has no `issued_at` yet. Null only if the column is
   *  somehow absent from the row (defensive; the column always exists). */
  created_at: string | null
}

export interface DocumentRowSummary {
  id: string
  type: DocumentType | string
  status?: string
  counterparty_contact_id: string | null
  counterparty_name: string | null
  counterparty_address: string | null
  counterparty_shipping_address: string | null
  counterparty_shipping_name: string | null
  counterparty_vat_id: string | null
  counterparty_email: string | null
  counterparty_country: string | null
  currency: string
  incoterm: string
  issuer_profile_id: string
  lifecycle_log: Array<Record<string, unknown>>
  pdf_file_id: string | null
  pdf_status: string | null
  number: string | null
  payment_status: string | null
  grand_total_minor: bigint
  /** The original invoice's issue date — surfaced on a credit note's approval card ("Reverses
   *  invoice ... issued on ..."), already present on the row `findDocumentSummary` fetches. */
  issued_at: string | null
  /** The document's `external_refs` blob, carried forward by the convert paths. */
  external_refs: Record<string, unknown>
  /** The Shopify draft order this quote mirrors, when the issuer is mapped to a shop.
   *  Converting such a quote completes the draft order instead of issuing locally. */
  shopify_draft_order_id: string | null
  /** The linked Shopify order id/gid, when this document was reconciled from a Shopify order.
   *  Used to carry the order link forward onto a credit note issued against this document, so
   *  the one-invoice-per-order guard's scoped lookup (by shopify_order_id) also finds it. */
  shopify_order_id: string | null
  /** The human Shopify order reference ("#1149"), carried forward the same way. */
  shopify_order_number: string | null
  /** The customer's purchase order number, carried forward the same way (convert-to-invoice,
   *  credit note against this document, and the order-reissue replacement invoice). */
  po_number: string | null
  /** Free-text notes on the document face, carried forward the same way. Plain column, so
   *  there is no external_refs fallback to consult. */
  notes: string | null
  /** Stored e-invoicing regime; null for a document issued before regimes were recorded. */
  regime?: string | null
  /** Transmission state of the document; null until one exists. */
  einvoice_state?: string | null
  /** Stored e-invoicing columns (buyer snapshot, billing, operation category). */
  einvoice?: EinvoiceRowColumns
}

export type ErrorEnvelope = {
  status: "error"
  /** `retryable`, `status` and `body` are carried by typed errors such as the e-invoicing
   *  gate's (the kernel keeps them on the tool-error envelope). */
  error: { code: string; message: string; retryable?: boolean; status?: number; body?: unknown }
}

/**
 * What a STAGE-TIME preflight returns to the kernel (`execute-tool.ts` runs `tool.preflight`
 * before the approval request is created). `{ ok: true }` lets the gated call be staged; an
 * `error` refuses it there and then. Every preflight in this file is read-only: lookups only,
 * no writes and no external calls, because it runs on the way IN to the approval, not on the
 * way out of it.
 */
export type PreflightResult =
  /** `noAutoApprove`: this call must be decided by a person (no auto-approve policy answers it). */
  | { ok: true; noAutoApprove?: true }
  | { error: { code: string; message: string; retryable?: boolean; status?: number; body?: unknown } }

/** Map a shared-validation outcome onto the kernel's preflight contract. */
export function toPreflightResult(
  outcome: { ok: true; buyer?: Partial<Pick<BuyerVatFacts, "consumer_override_evidence" | "business_unverified">> | null } | { ok: false; error: ErrorEnvelope },
): PreflightResult {
  if (!outcome.ok) return { error: outcome.error.error }
  // A buyer the agent declared a private consumer against business evidence, or whose business
  // status could not be verified (buyer-vat.ts): a person decides, whatever auto-approve policy
  // the org set for the tool.
  return needsHumanBuyerDecision(outcome.buyer) ? { ok: true, noAutoApprove: true } : { ok: true }
}

export type CompletedEnvelope<T> = { status: "completed" } & T
export type PendingApprovalEnvelope = {
  status: "pending_approval"
  approval_id: string
}

export type MutationResult<T> =
  | CompletedEnvelope<T>
  | PendingApprovalEnvelope
  | ErrorEnvelope

/**
 * Hard cap on `documents.notes`. Free text goes on the PDF face, so it needs a bound the
 * renderer can honour: 2000 characters is roughly a page of prose, far more than the contract
 * references, customs remarks and special mentions this field exists for, and short enough that
 * a pasted email thread is refused at the boundary instead of silently pushing the legal
 * mention and the payment box off the document.
 */
export const NOTES_MAX_LENGTH = 2000

/**
 * Normalise a caller-supplied `notes` value: trim it, turn an empty/whitespace-only string into
 * NULL (clearing the field rather than storing "" — a blank string renders as an empty "Notes"
 * heading), and refuse anything past NOTES_MAX_LENGTH with a TYPED error the agent can act on
 * rather than a raw column-length failure from pg.
 *
 * `undefined` in, `undefined` out: "the caller did not mention notes" is distinct from "the
 * caller cleared them", which is what makes the documents_update patch semantics work.
 */
export function normaliseNotes(
  raw: string | null | undefined,
): { ok: true; value: string | null | undefined } | { ok: false; error: ErrorEnvelope } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: null }
  const trimmed = String(raw).trim()
  if (trimmed.length > NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "notes_too_long",
          message:
            `notes is ${trimmed.length} characters, over the ${NOTES_MAX_LENGTH} character limit. ` +
            `notes is a short free-text mention printed on the document (a contract reference, ` +
            `extra customs information, a special mention), not a place for a full document: ` +
            `shorten it, or put the long form on the ticket or the contact instead.`,
        },
      },
    }
  }
  return { ok: true, value: trimmed === "" ? null : trimmed }
}

/** Throwing form of normaliseNotes for the legacy drafts_* tools, which signal failure by
 *  throwing a "code: message" Error rather than returning an envelope. */
export function normaliseNotesOrThrow(raw: string | null | undefined): string | null | undefined {
  const res = normaliseNotes(raw)
  if (!res.ok) throw new Error(`${res.error.error.code}: ${res.error.error.message}`)
  return res.value
}

/** Generic db surface used by every mutation. Extends IssueCtx's. */
export interface MutationsDb extends IssueDb {
  updateMany(
    entity: string,
    opts: { where: Record<string, unknown>; data: Record<string, unknown> },
  ): Promise<{ count: number }>
  delete(entity: string, id: string): Promise<void>
  count(entity: string, opts?: { where?: Record<string, unknown> }): Promise<number>
}

/**
 * The kernel's answer to `ctx.requestApproval`. `auto_approved: true` means carry on now: the
 * org's auto-approve policy approved it, or this is a person's own call and they hold the deciding
 * scope (approvals are for agents, not persons: no approval row exists then, `approval_id` is
 * null). Otherwise the approval is parked and the handler reports it pending.
 */
export type RequestedApproval = { approval_id: string; auto_approved?: undefined } | { approval_id: string | null; auto_approved: true }

export interface MutationsCtx extends Omit<IssueCtx, "db"> {
  // K6 post-approval re-entry signal. Field names mirror the kernel's
  // `AppContext.approval` contract (`@liaison/app-sdk` types.ts): the kernel
  // injects `{ approvalRequestId, approvalDeciderId, toolName }`, NOT snake_case.
  approval: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  db: MutationsDb

  requestApproval(input: {
    tool_name: string
    summary: string
    /** Optional structured detail rendered on the approval card (subtitle + up
     *  to 8 lines + up to 10 entity links). Without it the card shows only the
     *  plain-string `summary` as a title with empty lines below — see the
     *  kernel's `HandlerApprovalInput` (apps/api/src/modules/apps/execute-tool.ts). */
    summary_detail?: {
      subtitle?: string
      lines?: string[]
      links?: Array<{ label: string; app: string; entityType: string; entityId: string }>
    }
    current_payload: unknown
    editable_fields?: string[]
    /** Carry on at once when the org's auto-approve policy for `tool_name` approves the call:
     *  the kernel then answers `auto_approved: true` and the handler proceeds as approved. */
    auto_approvable?: boolean
  }): Promise<RequestedApproval>

  decideApproval(input: {
    approval_id: string
    deciding_user_id: string
  }): Promise<{ status: "ok" } | ErrorEnvelope>

  executeTool: CrossAppExecuteTool

  /** Kernel-mediated outbound HTTP (allowlisted hosts): the VIES check of a buyer VAT number.
   *  Optional: absent, a VAT number is reported "not verified (VIES unavailable)". */
  fetch?: ReadsFetch

  /** Whether the calling user holds a scope (kernel bridge; hierarchical, `*` holds everything).
   *  Optional so pure unit contexts can omit it; a check that finds it absent refuses. */
  hasScope?(scope: string): Promise<boolean>

  // The real SDK channel for attention: emit a declared event that the manifest
  // attention `translations` map to an attention item (e.g. the manifest rule
  // `invoicing:contact_conflict`). Replaces the never-provided `emitAttention`.
  emit(event: {
    entity: string
    action: string
    entityId?: string
    data?: unknown
    metadata?: Record<string, unknown>
  }): Promise<void>
}

export function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value
  if (typeof value === "number") return BigInt(Math.round(value))
  if (typeof value === "string" && value.length > 0) return BigInt(value)
  return 0n
}

function isAbsentAmount(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "")
}

function showValue(value: unknown): string {
  try {
    return (JSON.stringify(value) ?? String(value)).slice(0, 80)
  } catch {
    return String(value).slice(0, 80)
  }
}

/** What a line's discount means, said in the refusal so the caller can correct it in one go. */
const DISCOUNT_HINT =
  "discount_minor is the TOTAL discount for the whole line in minor currency units (cents), not " +
  "per unit and not a percentage: for 38% off 40 units at 89900 pass 1366480 (40 x 89900 x 0.38). " +
  "Leave it out for no discount."

/** The typed refusal for a minor-unit field that does not hold a whole number. `field` may be a
 *  path (`items[2].discount_minor`). */
export function invalidAmountError(field: string, value: unknown): { code: string; message: string } {
  const hint = field.endsWith("discount_minor")
    ? ` ${DISCOUNT_HINT}`
    : field.endsWith("unit_price_minor")
      ? " unit_price_minor is the price of ONE unit in minor currency units (cents)."
      : ""
  return {
    code: "invalid_amount",
    message: `${minorAmountRefusal(field, value)}${hint} Correct ${field} and call the tool again.`,
  }
}

/**
 * Range check of each line's `discount_minor` for the create-and-issue tools, run after
 * lineAmountsError (which refuses a value that is not a number). A discount is the TOTAL discount
 * of the line in minor units (issueDocument subtracts it once from quantity x unit price), so it
 * must lie between 0 and the line's own amount: a negative one would raise the price and a larger
 * one would make the line negative. The refusal names the line, the allowed range and a correct
 * value. Lines whose quantity cannot be read are left to the downstream quantity error.
 */
export function lineDiscountError(lines: unknown, field = "items"): ErrorEnvelope | null {
  if (!Array.isArray(lines)) return null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Record<string, unknown> | null
    if (!line || typeof line !== "object" || isAbsentAmount(line.discount_minor)) continue
    const discount = readMinorAmount(line.discount_minor)
    if (discount === null) continue
    const unit = isAbsentAmount(line.unit_price_minor) ? 0n : readMinorAmount(line.unit_price_minor)
    if (unit === null) continue
    let lineAmount: bigint
    try {
      lineAmount = lineSubtotal({ quantity: line.quantity as string | number, unit_price_minor: unit })
    } catch {
      continue
    }
    if (discount >= 0n && discount <= lineAmount) continue
    const path = `${field}[${i}].discount_minor`
    const qty = String(line.quantity)
    const why =
      discount < 0n
        ? "a discount cannot be negative"
        : lineAmount === 0n
          ? `the line has no amount to discount (${qty} x unit_price_minor ${unit} = 0): set ` +
            `${field}[${i}].unit_price_minor to the unit price the discount applies to`
          : `that is more than the line itself (${qty} x ${unit} = ${lineAmount} minor units)`
    return {
      status: "error",
      error: {
        code: "invalid_discount",
        message:
          `${path} is ${discount}: ${why}. Nothing was created. discount_minor is the TOTAL discount ` +
          `for the whole line in minor currency units, not per unit and not a percentage, so on ` +
          `${field}[${i}] it must be between 0 and ${lineAmount}. Example: for 38% off 40 units at ` +
          `89900, pass unit_price_minor 89900, quantity 40 and discount_minor 1366480 ` +
          `(40 x 89900 x 0.38). Correct ${path}, or leave it out for no discount, and call the tool again.`,
      },
    }
  }
  return null
}

/** Longest customer reference accepted: a CRM record id or a short customer code, not prose. */
export const CUSTOMER_REFERENCE_MAX_LENGTH = 200

/**
 * Normalise a caller-supplied `customer_reference` (the caller's own id for this customer in
 * another system, e.g. a CRM record id): trimmed, blank becomes null, over the cap is a typed
 * error. Same undefined/null semantics as normaliseNotes.
 */
export function normaliseCustomerReference(
  raw: unknown,
): { ok: true; value: string | null | undefined } | { ok: false; error: ErrorEnvelope } {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: null }
  const trimmed = (typeof raw === "string" || typeof raw === "number" ? String(raw) : "").trim()
  if (typeof raw !== "string" && typeof raw !== "number") {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "invalid_customer_reference",
          message:
            `customer_reference is ${showValue(raw)}, which is not text. Nothing was created. Pass ` +
            `your own reference for this customer as a plain string, e.g. "crm-48213", or leave it out.`,
        },
      },
    }
  }
  if (trimmed.length > CUSTOMER_REFERENCE_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "customer_reference_too_long",
          message:
            `customer_reference is ${trimmed.length} characters, over the ` +
            `${CUSTOMER_REFERENCE_MAX_LENGTH} character limit. Nothing was created. It is a short ` +
            `identifier printed on the PDF as "Customer ref" (e.g. a CRM record id such as ` +
            `"crm-48213"); put longer text in notes instead.`,
        },
      },
    }
  }
  return { ok: true, value: trimmed === "" ? null : trimmed }
}

/**
 * A money value in minor units (readMinorAmount). An ABSENT value (undefined, null, blank string)
 * is 0n as before (the empty_document / downstream validation catches it). A PRESENT value that is
 * not a whole number throws an "invalid_amount: ..." error, never a guess: a price of "$1" once
 * issued a proforma at 0, and "-1260.50" once issued a credit note at 100 times its amount.
 */
export function coerceMinorAmount(value: unknown, field = "amount"): bigint {
  if (isAbsentAmount(value)) return 0n
  const parsed = readMinorAmount(value)
  if (parsed === null) {
    const err = invalidAmountError(field, value)
    throw new Error(`${err.code}: ${err.message}`)
  }
  return parsed
}

/**
 * Validate the money fields of agent-supplied lines BEFORE gating, so an unreadable price never
 * parks an approval card or consumes a document number. `unit_price_minor` and `discount_minor`
 * may be absent (they keep their defaults); when present they must be whole numbers. A non-array
 * is left to normaliseDraftLines, which reports it.
 */
export function lineAmountsError(lines: unknown, field = "items"): ErrorEnvelope | null {
  if (!Array.isArray(lines)) return null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as Record<string, unknown> | null
    if (!line || typeof line !== "object") continue
    for (const key of ["unit_price_minor", "discount_minor"]) {
      const value = line[key]
      if (!isAbsentAmount(value) && readMinorAmount(value) === null) {
        return { status: "error", error: invalidAmountError(`${field}[${i}].${key}`, value) }
      }
    }
  }
  return null
}
