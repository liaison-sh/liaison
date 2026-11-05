// SPDX-License-Identifier: FSL-1.1-ALv2
// The e-invoicing gate as an issue site runs it: resolve the gate mode and the buyer facts
// (identity row, call / draft snapshot, or the credit note's original), derive the customer kind
// from the call's signals when nothing records it, then classify and run the mandatory-data pass.
// Shared by every issuing handler (read-only check before any approval or write) and by
// `issueDocument` (the backstop, which materialises the gate mode and writes the snapshot).
import type { CrossAppExecuteTool } from "../cross-app"
import type { Counterparty } from "../issue"
import type { CustomerKind, Regime } from "./classify"
import type { OperationCategory, PaymentState } from "./classify-operation"
import {
  type BuyerSnapshot,
  type GateEvaluation,
  type GateInput,
  type GateMode,
  type MissingItem,
  type OperationSource,
  type OriginalSnapshot,
  evaluateEinvoiceGate,
  gateErrorEnvelope,
  gateWarning,
  resolveBuyerFacts,
  resolveGateMode,
} from "./gate"
import { sirenFromFrVat } from "./identity"
import { deriveKind } from "./identity-derive"

/** The stored e-invoicing columns of a document row (an original, a draft, a source quote). */
export interface EinvoiceRowColumns extends BuyerSnapshot {
  operation_category?: OperationCategory | null
  operation_category_source?: OperationSource | null
}

/** A credit note's original: id, stored regime, transmission state and stored buyer snapshot. */
export interface EinvoiceOriginal {
  id: string
  regime: Regime | null
  transmissionStatus?: string | null
  counterparty_contact_id?: string | null
  snapshot?: EinvoiceRowColumns | null
}

export interface EinvoiceSiteInput {
  type: string
  issuer: { country: string; vat_id: string | null; vat_on_debits_default?: boolean | null }
  counterparty: Counterparty
  lines: ReadonlyArray<{ line_kind?: string | null }>
  /** Explicit category from the call / draft. */
  operation_category?: OperationCategory | null
  /** Where an explicit category came from (defaults to `explicit`), or `lines_authoritative`
   *  when the line kinds come from an authoritative source. */
  operation_source?: OperationSource | null
  payment_state?: PaymentState | null
  original?: EinvoiceOriginal | null
  /** A checkout (Shopify) buyer without company or VAT id is a consumer; a manual one is unknown. */
  origin?: "manual" | "shopify"
  /** The buyer's company as the call carries it (a checkout's billing company); the linked
   *  kernel contact's company is read when absent. */
  company?: string | null
}

export interface GateCtx {
  db: {
    findMany(entity: string, opts?: { where?: Record<string, unknown>; limit?: number; offset?: number }): Promise<unknown[]>
    insert(entity: string, data: Record<string, unknown>): Promise<unknown>
  }
  executeTool?: CrossAppExecuteTool
}

export interface PreparedGate {
  mode: GateMode
  input: GateInput
  evaluation: GateEvaluation
  /** The kind derived from the call's signals (no identity row and no explicit kind), if any. */
  derivedKind: CustomerKind | null
}

export interface EinvoicingWarning {
  code: string
  message: string
  missing: MissingItem[]
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

const INVOICE_TYPES = new Set(["invoice", "credit_note"])

/** The buyer snapshot an issuing call's counterparty carries. The billing country falls back to
 *  the counterparty's country (the field of record for the tax classification). */
export function counterpartyBuyerSnapshot(cp: Counterparty): BuyerSnapshot {
  return {
    customer_kind: cp.customer_kind ?? null,
    buyer_legal_name: str(cp.legal_name),
    buyer_siren: str(cp.siren),
    buyer_siret: str(cp.siret),
    // A caller's snapshot never carries a confirmation (only identity rows do).
    buyer_siren_confirmed_via: null,
    counterparty_vat_id: str(cp.vat_id),
    billing_line1: str(cp.billing_line1),
    billing_line2: str(cp.billing_line2),
    billing_postcode: str(cp.billing_postcode),
    billing_city: str(cp.billing_city),
    billing_country_code: str(cp.billing_country_code) ?? str(cp.country),
  }
}

/** The company recorded on the linked kernel contact, or null. */
async function contactCompany(ctx: GateCtx, contactId: string | null): Promise<string | null> {
  if (!contactId || !ctx.executeTool) return null
  const env = await ctx.executeTool("kernel:contacts_read", { contactId })
  if (env.status !== "completed") return null
  const contact = (env.result as { contact?: { company?: unknown } } | null | undefined)?.contact
  return str(contact?.company)
}

/**
 * Resolve mode and buyer facts, derive the kind when nothing records it, and evaluate the gate.
 * `materialise` writes the default gate mode on the first write path (issueDocument); a site
 * check passes false and stays read-only.
 */
export async function prepareEinvoiceGate(
  ctx: GateCtx,
  s: EinvoiceSiteInput,
  opts: { materialise: boolean },
): Promise<PreparedGate> {
  const mode = await resolveGateMode(ctx.db, { materialise: opts.materialise })
  const cp = s.counterparty
  const isCredit = s.type === "credit_note"
  const original = isCredit ? (s.original ?? null) : null
  const originalSnapshot: OriginalSnapshot | null =
    original && original.regime
      ? {
          ...(original.snapshot ?? {}),
          id: original.id,
          regime: original.regime,
          counterparty_contact_id: original.counterparty_contact_id ?? null,
        }
      : null
  const buyer = await resolveBuyerFacts(ctx.db, {
    docType: s.type,
    contact_id: cp.contact_id,
    snapshot: counterpartyBuyerSnapshot(cp),
    original: originalSnapshot,
  })

  // A caller's kind never takes a contact recorded with a company out of e-invoicing: the company
  // says it is a business, and only a person records otherwise (counterparty_identity_set asks one
  // for that change). The call's kind is then not taken and the kind is derived as below.
  let company: string | null | undefined
  if (
    INVOICE_TYPES.has(s.type) &&
    buyer.source === "snapshot" &&
    buyer.customerKind &&
    buyer.customerKind !== "business" &&
    cp.contact_id
  ) {
    company = str(s.company) ?? (await contactCompany(ctx, cp.contact_id))
    if (company) buyer.customerKind = null
  }

  let derivedKind: CustomerKind | null = null
  if (INVOICE_TYPES.has(s.type) && buyer.source !== "original" && buyer.source !== "original_identity" && !buyer.customerKind) {
    company = buyer.vatId ? null : company !== undefined ? company : (str(s.company) ?? (await contactCompany(ctx, cp.contact_id)))
    derivedKind = deriveKind({
      vat_id: buyer.vatId,
      company,
      legal_name: cp.legal_name,
      country: buyer.billing.countryCode,
      origin: s.origin ?? "manual",
    })
    if (derivedKind) {
      buyer.customerKind = derivedKind
      if (derivedKind === "business" && !buyer.siren) {
        const fromVat = sirenFromFrVat(buyer.vatId, { billingCountry: buyer.billing.countryCode })
        if (fromVat) {
          // Read off the VAT id: a fact, but unconfirmed until a registry check.
          buyer.siren = fromVat
          buyer.sirenConfirmed = false
          buyer.confirmedVia = null
        }
      }
    }
  }

  // Operation category: the call's explicit value; otherwise a credit note inherits its
  // original's stated category; otherwise the lines decide (authoritative or default).
  let category: OperationCategory | null = s.operation_category ?? null
  let source: OperationSource | null = category ? (s.operation_source ?? "explicit") : (s.operation_source ?? null)
  const origCat = originalSnapshot ? original?.snapshot : null
  if (
    !category &&
    origCat?.operation_category &&
    (origCat.operation_category_source === "explicit" || origCat.operation_category_source === "lines_authoritative")
  ) {
    category = origCat.operation_category
    source = origCat.operation_category_source
  }

  const input: GateInput = {
    docType: s.type,
    issuer: {
      country: s.issuer.country,
      vat_id: s.issuer.vat_id,
      vat_on_debits_default: s.issuer.vat_on_debits_default ?? null,
    },
    buyer,
    lines: s.lines,
    operationCategory: category,
    operationSource: source,
    paymentState: s.payment_state ?? null,
    original: original
      ? { id: original.id, regime: original.regime, transmissionStatus: original.transmissionStatus ?? null }
      : null,
    mode,
  }
  return { mode, input, evaluation: evaluateEinvoiceGate(input), derivedKind }
}

export type EinvoiceSiteCheck =
  | { ok: true; prepared: PreparedGate; warning: EinvoicingWarning | null }
  | { ok: false; error: ReturnType<typeof gateErrorEnvelope>; derivedKind: CustomerKind | null }

/**
 * The issuing handler's read-only check, run before any approval request, number allocation or
 * write: in enforce mode a refusal becomes the typed, retryable error envelope; in warn mode the
 * document may be issued and the warning travels with the result.
 */
export async function checkEinvoiceGate(ctx: GateCtx, s: EinvoiceSiteInput): Promise<EinvoiceSiteCheck> {
  const prepared = await prepareEinvoiceGate(ctx, s, { materialise: false })
  const r = prepared.evaluation.refusal
  if (r && r.mode === "enforce") return { ok: false, error: gateErrorEnvelope(r), derivedKind: prepared.derivedKind }
  return { ok: true, prepared, warning: r ? gateWarning(r) : null }
}

/** The stored e-invoicing columns of a document row, for an original / a draft / a source. */
export function readEinvoiceRowColumns(row: Record<string, unknown>): EinvoiceRowColumns {
  const kinds = ["business", "individual", "public_entity", "non_registered_entity"]
  const cats = ["goods", "services", "mixed"]
  const sources = ["explicit", "lines_authoritative", "lines_default"]
  const pick = <T extends string>(v: unknown, allowed: string[]): T | null =>
    typeof v === "string" && allowed.includes(v) ? (v as T) : null
  return {
    customer_kind: pick<CustomerKind>(row.customer_kind, kinds),
    buyer_legal_name: str(row.buyer_legal_name),
    buyer_siren: str(row.buyer_siren),
    buyer_siret: str(row.buyer_siret),
    buyer_siren_confirmed_via: pick<"auto" | "approval">(row.buyer_siren_confirmed_via, ["auto", "approval"]),
    counterparty_vat_id: str(row.counterparty_vat_id),
    billing_line1: str(row.billing_line1),
    billing_line2: str(row.billing_line2),
    billing_postcode: str(row.billing_postcode),
    billing_city: str(row.billing_city),
    billing_country_code: str(row.billing_country_code),
    operation_category: pick<OperationCategory>(row.operation_category, cats),
    operation_category_source: pick<OperationSource>(row.operation_category_source, sources),
  }
}

/** The counterparty fields a stored row's e-invoicing columns contribute (kind, identity, billing). */
export function counterpartyEinvoiceFields(cols: EinvoiceRowColumns): Partial<Counterparty> {
  return {
    customer_kind: cols.customer_kind ?? null,
    siren: cols.buyer_siren ?? null,
    siret: cols.buyer_siret ?? null,
    billing_line1: cols.billing_line1 ?? null,
    billing_line2: cols.billing_line2 ?? null,
    billing_postcode: cols.billing_postcode ?? null,
    billing_city: cols.billing_city ?? null,
    billing_country_code: cols.billing_country_code ?? null,
  }
}

/**
 * Drop the fields a caller may never assert on an issuing call: a SIREN's registry confirmation
 * comes only from a registry check (identity row or a stored snapshot), never from the wire.
 */
export function untrustedCounterparty<T>(cp: T): T {
  if (cp == null || typeof cp !== "object") return cp
  const {
    siren_confirmed_via: _a,
    buyer_siren_confirmed_via: _b,
    ...rest
  } = cp as Record<string, unknown>
  return rest as T
}

const KIND_VALUES = ["business", "individual", "public_entity", "non_registered_entity"] as const
const CATEGORY_VALUES = ["goods", "services", "mixed"] as const

/**
 * Typed refusal for an issuing call whose e-invoicing params are not one of the allowed values
 * (the kernel validates the agent path against the manifest enums; this covers in-process
 * callers). Null when both are absent or valid.
 */
export function einvoiceParamsError(
  counterparty: Pick<Counterparty, "customer_kind"> | null | undefined,
  operationCategory: unknown,
): { status: "error"; error: { code: string; message: string } } | null {
  const kind = counterparty?.customer_kind
  if (kind != null && !(KIND_VALUES as readonly string[]).includes(kind)) {
    return {
      status: "error",
      error: {
        code: "invalid_params",
        message: `counterparty.customer_kind must be one of ${KIND_VALUES.join(", ")} (got ${JSON.stringify(kind)})`,
      },
    }
  }
  if (operationCategory != null && !(CATEGORY_VALUES as readonly unknown[]).includes(operationCategory)) {
    return {
      status: "error",
      error: {
        code: "invalid_params",
        message: `operation_category must be one of ${CATEGORY_VALUES.join(", ")} (got ${JSON.stringify(operationCategory)})`,
      },
    }
  }
  return null
}
