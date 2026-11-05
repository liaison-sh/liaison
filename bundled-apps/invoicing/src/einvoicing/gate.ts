// SPDX-License-Identifier: FSL-1.1-ALv2
// E-invoicing issue gate: regime classification, then a mandatory-data pass for an
// `e_invoice` (or `needs_review`) document; gate-mode resolution; the error / preflight /
// warning envelopes; and the regime snapshot written onto an issued document.
// No guessing: a fact the caller does not have stays null.
import {
  type Regime,
  type RegimeReason,
  type CustomerKind,
  classifyRegime,
} from "./classify"
import { type OperationCategory, type PaymentState, operationCategory } from "./classify-operation"
import { currencyExponent } from "../money"
import { eurMinor } from "./fx"
import { isSirenConfirmed, isValidSiren } from "./identity"

export type GateMode = "warn" | "enforce"
export type OperationSource = "explicit" | "lines_authoritative" | "lines_default"
export type GateCode =
  | "einvoice_data_missing"
  | "customer_kind_missing"
  | "siren_invalid"
  | "siren_inactive"
  | "einvoice_needs_review"
  | "operation_category_missing"
  | "registry_unconfirmed"
  | "imported_original_missing"

export const GATE_CODE_STATUS: Record<GateCode, 422 | 409> = {
  einvoice_data_missing: 422,
  customer_kind_missing: 422,
  siren_invalid: 422,
  siren_inactive: 422,
  einvoice_needs_review: 422,
  operation_category_missing: 422,
  registry_unconfirmed: 422,
  imported_original_missing: 409,
}

/** Every code the issue gate can refuse with (the readiness list's blocker codes). */
export const GATE_CODES: readonly GateCode[] = Object.keys(GATE_CODE_STATUS) as GateCode[]

/** Buyer columns as the call / draft / document carries them (document column names). */
export interface BuyerSnapshot {
  customer_kind?: CustomerKind | null
  buyer_legal_name?: string | null
  buyer_siren?: string | null
  buyer_siret?: string | null
  buyer_siren_confirmed_via?: "auto" | "approval" | null
  counterparty_vat_id?: string | null
  billing_line1?: string | null
  billing_line2?: string | null
  billing_postcode?: string | null
  billing_city?: string | null
  billing_country_code?: string | null
}

/** The original document of a credit note: its stored regime and buyer snapshot. */
export interface OriginalSnapshot extends BuyerSnapshot {
  id: string
  regime: Regime | null
  counterparty_contact_id?: string | null
}

export interface BuyerFacts {
  /** Where the buyer facts came from: the contact's identity row, the call/draft snapshot,
   *  the credit note's original document, or that original with the SIREN its snapshot lacks
   *  taken from the contact's registry-confirmed identity (`original_identity`). */
  source: "identity" | "snapshot" | "original" | "original_identity"
  /** Credit note: the contact the original is linked to (null for a contactless original). */
  contactId?: string | null
  customerKind: CustomerKind | null
  legalName: string | null
  siren: string | null
  siret: string | null
  vatId: string | null
  sirenStatus: "A" | "C" | null
  territoryTreatment: "as_fr" | "as_foreign" | null
  /** The SIREN was checked against the registry (or, for a credit note, comes from the original). */
  sirenConfirmed: boolean
  confirmedVia: "auto" | "approval" | null
  billing: {
    line1: string | null
    line2: string | null
    postcode: string | null
    city: string | null
    countryCode: string | null
  }
}

interface FindManyDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number; offset?: number },
  ): Promise<unknown[]>
}

type Row = Record<string, unknown>

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

const KINDS = ["business", "individual", "public_entity", "non_registered_entity"] as const
const VIA = ["auto", "approval"] as const

function billingOf(s: BuyerSnapshot): BuyerFacts["billing"] {
  return {
    line1: str(s.billing_line1),
    line2: str(s.billing_line2),
    postcode: str(s.billing_postcode),
    city: str(s.billing_city),
    countryCode: str(s.billing_country_code)?.toUpperCase() ?? null,
  }
}

function fromSnapshot(s: BuyerSnapshot, source: "snapshot" | "original"): BuyerFacts {
  const via = oneOf(s.buyer_siren_confirmed_via, VIA)
  return {
    source,
    customerKind: oneOf(s.customer_kind, KINDS),
    legalName: str(s.buyer_legal_name),
    siren: str(s.buyer_siren),
    siret: str(s.buyer_siret),
    vatId: str(s.counterparty_vat_id),
    sirenStatus: null,
    territoryTreatment: null,
    // A credit note accepts its original's SIREN as recorded at issue. A call / draft snapshot
    // never confirms one: confirmation comes only from an identity row (a registry check), so a
    // caller's claim is neither trusted here nor recorded on the document.
    sirenConfirmed: source === "original",
    confirmedVia: source === "original" ? via : null,
    billing: billingOf(s),
  }
}

/**
 * Resolve the buyer facts the gate classifies (PD-4): a credit note reads its original's
 * snapshot (a legacy original without a regime falls back to the identity / snapshot);
 * an invoice reads the contact's identity row, else the call / draft snapshot.
 */
export async function resolveBuyerFacts(
  db: FindManyDb,
  input: {
    docType: string
    contact_id: string | null | undefined
    snapshot: BuyerSnapshot
    original?: OriginalSnapshot | null
  },
): Promise<BuyerFacts> {
  if (input.docType === "credit_note" && input.original?.regime) {
    const facts = fromSnapshot(input.original, "original")
    const originalContact = input.original.counterparty_contact_id ?? input.contact_id ?? null
    facts.contactId = originalContact
    // The original recorded no SIREN (issued in warn mode without it): the buyer's
    // registry-confirmed identity stands in for it, never an unconfirmed one, and the original
    // itself is never rewritten. The credit note records where its SIREN came from.
    if (!facts.siren && originalContact) {
      const rows = (await db.findMany("counterparty_identities", {
        where: { contact_id: originalContact },
        limit: 1,
      })) as Row[]
      const idn = rows[0]
      const idSiren = str(idn?.siren)
      if (idn && idSiren && isSirenConfirmed(idn as { confirmed_via?: string | null })) {
        return {
          ...facts,
          source: "original_identity",
          customerKind: facts.customerKind ?? oneOf(idn.customer_kind, KINDS),
          legalName: facts.legalName ?? str(idn.registry_name),
          siren: idSiren,
          siret: str(idn.siret) ?? facts.siret,
          sirenStatus: oneOf(idn.registry_status, ["A", "C"] as const),
          sirenConfirmed: true,
          confirmedVia: oneOf(idn.confirmed_via, VIA),
        }
      }
    }
    return facts
  }
  const snap = fromSnapshot(input.snapshot, "snapshot")
  const contactId = input.contact_id ?? input.original?.counterparty_contact_id ?? null
  if (!contactId) return snap
  const rows = (await db.findMany("counterparty_identities", { where: { contact_id: contactId }, limit: 1 })) as Row[]
  const idn = rows[0]
  if (!idn) return snap
  const idSiren = str(idn.siren)
  return {
    source: "identity",
    customerKind: oneOf(idn.customer_kind, KINDS) ?? snap.customerKind,
    legalName: str(idn.registry_name) ?? snap.legalName,
    siren: idSiren ?? snap.siren,
    siret: str(idn.siret) ?? (idSiren ? null : snap.siret),
    vatId: str(idn.vat_id) ?? snap.vatId,
    sirenStatus: oneOf(idn.registry_status, ["A", "C"] as const),
    territoryTreatment: oneOf(idn.territory_treatment, ["as_fr", "as_foreign"] as const),
    sirenConfirmed: idSiren ? isSirenConfirmed(idn as { confirmed_via?: string | null }) : snap.sirenConfirmed,
    confirmedVia: idSiren ? oneOf(idn.confirmed_via, VIA) : snap.confirmedVia,
    billing: snap.billing,
  }
}

export interface GateIssuer {
  country?: string | null
  country_code?: string | null
  vat_id: string | null
  vat_on_debits_default?: boolean | null
}

export interface GateInput {
  docType: string
  issuer: GateIssuer
  buyer: BuyerFacts
  lines: ReadonlyArray<{ line_kind?: string | null }>
  /** An explicit category from the call / draft; null to derive from the lines. */
  operationCategory: OperationCategory | null
  /** `explicit` with a category; `lines_authoritative` when the line kinds come from an
   *  authoritative source (Shopify adapter); otherwise null / `lines_default`. */
  operationSource: OperationSource | null
  paymentState: PaymentState | null
  /** Credit note: the original's id, stored regime and transmission status. */
  original: { id: string; regime: Regime | null; transmissionStatus?: string | null } | null
  mode: GateMode
}

export interface MissingItem {
  field: string
  why: string
  fix_tool: string
  fix_hint: string
}

export interface GateResult {
  mode: GateMode
  code: GateCode
  status: 422 | 409
  message: string
  missing: MissingItem[]
  regime: Regime | null
  reasons: RegimeReason[]
}

export interface GateEvaluation {
  /** The classifier's verdict, null when it could not decide (an error). */
  regime: Regime | null
  reasons: RegimeReason[]
  internalCancellation: boolean
  operationCategory: OperationCategory | null
  operationSource: OperationSource | null
  refusal: GateResult | null
  /** Each missing item with the code it was refused under (the refusal's `missing`, in order). */
  blockers: Array<{ code: GateCode; item: MissingItem }>
}

const MISSING = {
  customer_kind: {
    field: "customer_kind",
    why: "A French buyer must be recorded as a business, an individual, a public entity or a non-registered entity.",
    fix_tool: "counterparty_identity_set",
    fix_hint: "Record customer_kind on the buyer's identity, or pass customer_kind on the issuing call.",
  },
  siren_missing: {
    field: "buyer_siren",
    why: "A French business buyer is invoiced electronically, which requires its SIREN.",
    fix_tool: "counterparty_identity_lookup",
    fix_hint: "Look the buyer up in the business registry to record and confirm its SIREN.",
  },
  siren_invalid: {
    field: "buyer_siren",
    why: "The buyer's SIREN fails the checksum.",
    fix_tool: "counterparty_identity_lookup",
    fix_hint: "Look the buyer up in the business registry to replace the SIREN with the registered one.",
  },
  siren_inactive: {
    field: "buyer_siren",
    why: "The buyer's SIREN is ceased in the business registry.",
    fix_tool: "counterparty_identity_lookup",
    fix_hint: "Look the buyer up again to find its active SIREN.",
  },
  registry_unconfirmed: {
    field: "buyer_siren",
    why: "The buyer's SIREN has not been confirmed against the business registry.",
    fix_tool: "counterparty_identity_lookup",
    fix_hint: "Look the buyer up in the business registry to confirm the SIREN.",
  },
  billing_address: {
    field: "billing_address",
    why: "An e-invoice needs the buyer's structured billing address (postcode, city, country).",
    fix_tool: "drafts_update",
    fix_hint:
      "Pass the buyer's billing postcode, city and country code on the issuing call's counterparty, or set them on the draft with drafts_update.",
  },
  /** A credit note whose original records no SIREN and is linked to no contact: no identity can
   *  stand in until the original is linked to its buyer's contact. */
  siren_missing_contactless_original: {
    field: "buyer_siren",
    why: "The original e-invoice recorded no SIREN for its buyer and is linked to no contact, so no registry-confirmed identity can supply it.",
    fix_tool: "documents_update",
    fix_hint:
      "Link the original invoice to its buyer's contact with documents_update (counterparty_contact_id), then confirm the buyer's SIREN with counterparty_identity_lookup.",
  },
  territory_treatment: {
    field: "territory_treatment",
    why: "The buyer's territory is not decided automatically.",
    fix_tool: "counterparty_territory_set",
    fix_hint: "An administrator records the treatment (as_fr or as_foreign) with counterparty_territory_set.",
  },
  operation_category: {
    field: "operation_category",
    why: "The goods / services category of an e-invoice must be stated, not defaulted from line kinds.",
    fix_tool: "drafts_update",
    fix_hint:
      "Pass operation_category (goods, services or mixed) on the issuing call, or set patch.operation_category with drafts_update.",
  },
} satisfies Record<string, MissingItem>

/** The code each missing item is refused under (see `evaluateEinvoiceGate`). */
const MISSING_CODE: Record<keyof typeof MISSING, GateCode> = {
  customer_kind: "customer_kind_missing",
  siren_missing: "einvoice_data_missing",
  siren_invalid: "siren_invalid",
  siren_inactive: "siren_inactive",
  registry_unconfirmed: "registry_unconfirmed",
  billing_address: "einvoice_data_missing",
  siren_missing_contactless_original: "einvoice_data_missing",
  territory_treatment: "einvoice_needs_review",
  operation_category: "operation_category_missing",
}

/** Every (code, field, fix tool) the gate can return: the actions the readiness list offers. */
export const GATE_BLOCKER_TOOLS: ReadonlyArray<{ key: string; code: GateCode; field: string; fix_tool: string }> = (
  Object.keys(MISSING) as Array<keyof typeof MISSING>
).map((k) => ({ key: k, code: MISSING_CODE[k], field: MISSING[k].field, fix_tool: MISSING[k].fix_tool }))

const CODE_ORDER: readonly GateCode[] = [
  "customer_kind_missing",
  "einvoice_needs_review",
  "einvoice_data_missing",
  "siren_invalid",
  "siren_inactive",
  "registry_unconfirmed",
  "operation_category_missing",
]

function buildMessage(code: GateCode, missing: MissingItem[]): string {
  const head: Record<GateCode, string> = {
    einvoice_data_missing: "E-invoicing data is missing for this French business buyer.",
    customer_kind_missing: "The customer kind of this French buyer is not recorded.",
    siren_invalid: "The buyer's SIREN is not valid.",
    siren_inactive: "The buyer's SIREN is ceased.",
    einvoice_needs_review: "The buyer's territory needs a decision before this document can be issued.",
    operation_category_missing: "The operation category (goods, services, mixed) must be stated.",
    registry_unconfirmed: "The buyer's SIREN is not confirmed against the business registry.",
    imported_original_missing: "The imported original of this document is missing.",
  }
  const tools = [...new Set(missing.map((m) => m.fix_tool))]
  const items = missing.map((m) => `${m.field} (${m.fix_tool})`).join(", ")
  // The buyer's kind is a fact about the buyer, never a lever: changing it to get past a missing
  // SIREN would issue a business's invoice outside e-invoicing.
  const sirenGap = missing.some((m) => m.field === "buyer_siren")
  const kindNote = sirenGap
    ? " Keep customer_kind as the buyer really is: never change it to get past this refusal; if the SIREN cannot be found, tell the user."
    : ""
  return `${head[code]} Missing: ${items}. Fix with ${tools.join(", ")}, then retry.${kindNote}`
}

/** The missing-SIREN item, naming the tool that can actually supply it for this buyer. */
function sirenMissingItem(b: BuyerFacts): MissingItem {
  return b.source === "original" && !b.contactId ? MISSING.siren_missing_contactless_original : MISSING.siren_missing
}

/** Classify, then run the mandatory-data pass. Returns the full evaluation. */
export function evaluateEinvoiceGate(input: GateInput): GateEvaluation {
  const b = input.buyer
  const cls = classifyRegime({
    docType: input.docType,
    issuerCountry: input.issuer.country_code ?? input.issuer.country ?? null,
    issuerVatRegistered: !!input.issuer.vat_id,
    customerKind: b.customerKind,
    billingCountry: b.billing.countryCode,
    billingPostcode: b.billing.postcode,
    vatId: b.vatId,
    buyerSiren: b.siren,
    sirenStatus: b.sirenStatus,
    territoryTreatment: b.territoryTreatment,
    original: input.original ? { regime: input.original.regime, transmissionStatus: input.original.transmissionStatus } : null,
  })

  // Operation category: explicit wins; otherwise derived from the lines.
  let category: OperationCategory | null = input.operationCategory
  let opSource: OperationSource | null = category ? (input.operationSource ?? "explicit") : null
  if (!category) {
    const derived = operationCategory(input.lines, { authoritative: input.operationSource === "lines_authoritative" })
    category = derived.category
    opSource = derived.category ? derived.source : null
  }
  const categoryStated = !!category && (opSource === "explicit" || opSource === "lines_authoritative")

  const found = new Map<GateCode, MissingItem[]>()
  const add = (code: GateCode, item: MissingItem) => {
    const list = found.get(code) ?? []
    list.push(item)
    found.set(code, list)
  }

  const errorCode = cls.regime === null ? cls.error.code : null
  // Would-be e-invoice: the classifier reached e_invoice, or stopped on a SIREN error for a
  // French business buyer (the remaining checks still run so every gap is listed at once).
  const wouldBeEInvoice =
    cls.regime === "e_invoice" ||
    errorCode === "einvoice_data_missing" ||
    errorCode === "siren_invalid" ||
    errorCode === "siren_inactive"

  if (errorCode === "customer_kind_missing") add("customer_kind_missing", MISSING.customer_kind)
  if (errorCode === "einvoice_data_missing") add("einvoice_data_missing", sirenMissingItem(b))
  if (errorCode === "siren_invalid") add("siren_invalid", MISSING.siren_invalid)
  if (errorCode === "siren_inactive") add("siren_inactive", MISSING.siren_inactive)

  if (cls.regime === "needs_review") {
    add("einvoice_needs_review", MISSING.territory_treatment)
    if (!categoryStated) add("operation_category_missing", MISSING.operation_category)
  }

  if (wouldBeEInvoice) {
    if (cls.regime === "e_invoice") {
      // SIREN: presence + validity (the classifier skips both when a credit note follows its
      // original), and registry confirmation unless it is the original's recorded SIREN.
      if (!b.siren) {
        add("einvoice_data_missing", sirenMissingItem(b))
      }
      else if (!isValidSiren(b.siren)) add("siren_invalid", MISSING.siren_invalid)
      else if (!b.sirenConfirmed) add("registry_unconfirmed", MISSING.registry_unconfirmed)
    }
    if (!b.billing.postcode || !b.billing.city || !b.billing.countryCode) {
      add("einvoice_data_missing", MISSING.billing_address)
    }
    if (!categoryStated) add("operation_category_missing", MISSING.operation_category)
  }

  let refusal: GateResult | null = null
  const blockers = CODE_ORDER.flatMap((c) => (found.get(c) ?? []).map((item) => ({ code: c, item })))
  const code = CODE_ORDER.find((c) => found.has(c))
  if (code) {
    const missing = CODE_ORDER.flatMap((c) => found.get(c) ?? [])
    refusal = {
      mode: input.mode,
      code,
      status: GATE_CODE_STATUS[code],
      message: buildMessage(code, missing),
      missing,
      regime: cls.regime,
      reasons: cls.reasons,
    }
  }

  return {
    regime: cls.regime,
    reasons: cls.reasons,
    internalCancellation: cls.internalCancellation === true,
    operationCategory: categoryStated || cls.regime !== "e_invoice" ? category : null,
    operationSource: categoryStated || cls.regime !== "e_invoice" ? opSource : null,
    refusal,
    blockers,
  }
}

/** The gate's refusal (enforce) or warning (warn); null when the document may be issued as is. */
export function einvoiceGateError(input: GateInput): GateResult | null {
  return evaluateEinvoiceGate(input).refusal
}

export interface GateErrorBody {
  missing: MissingItem[]
  regime: Regime | null
  reasons: RegimeReason[]
  gate_mode: GateMode
}

function errorPayload(r: GateResult) {
  if (r.mode !== "enforce") throw new Error("gate: a warn-mode result is not an error")
  return {
    code: r.code,
    message: r.message,
    retryable: true as const,
    status: r.status,
    body: { missing: r.missing, regime: r.regime, reasons: r.reasons, gate_mode: r.mode } satisfies GateErrorBody,
  }
}

/** The imported-original guard's refusal: an imported legacy document has no PDF to keep, and
 *  the app never renders one over it (its legal original is the imported file). */
export function importedOriginalMissing(): GateResult {
  const missing: MissingItem[] = [
    {
      field: "legal_original",
      why: "An imported document's legal original is its imported file; it is never rendered again.",
      fix_tool: "einvoicing_backfill_legacy_originals",
      fix_hint: "Run the legacy originals backfill to restore the imported file.",
    },
  ]
  return {
    mode: "enforce",
    code: "imported_original_missing",
    status: GATE_CODE_STATUS.imported_original_missing,
    message: buildMessage("imported_original_missing", missing),
    missing,
    regime: null,
    reasons: [],
  }
}

/** Handler error envelope (kernel tool-error shape, A30). */
export function gateErrorEnvelope(r: GateResult): { status: "error"; error: ReturnType<typeof errorPayload> } {
  return { status: "error", error: errorPayload(r) }
}

/** Stage-time preflight refusal. */
export function gatePreflight(r: GateResult): { error: ReturnType<typeof errorPayload> } {
  return { error: errorPayload(r) }
}

/** Warn mode: the calm warning returned in the tool result as `einvoicing_warning`. */
export function gateWarning(r: GateResult): { code: GateCode; message: string; missing: MissingItem[] } {
  return { code: r.code, message: r.message, missing: r.missing }
}

/** Thrown by a backstop that must never be the path an agent hits (handlers check first). */
export class EinvoiceGateRefusal extends Error {
  readonly result: GateResult
  constructor(result: GateResult) {
    super(result.message)
    this.name = "EinvoiceGateRefusal"
    this.result = result
  }
}

interface SettingsDb extends FindManyDb {
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
}

/** Statuses only an issued invoice / credit note reaches (drafts, quotes and approvals excluded). */
const ISSUED_STATUSES = ["issued", "paid", "overdue", "refunded", "voided", "cancelled", "fulfilled"] as const

/** True iff the org already holds a numbered document issued before the regime existed.
 *  One bounded equality lookup per issued status (no paging, no scan over drafts). */
async function hasPreRegimeIssuedDocument(db: FindManyDb): Promise<boolean> {
  for (const status of ISSUED_STATUSES) {
    const rows = (await db.findMany("documents", { where: { status, regime: null }, limit: 5 })) as Row[]
    if (rows.some((r) => str(r.number) !== null)) return true
  }
  return false
}

/**
 * The org's gate mode (PD-16). An existing `einvoicing_settings` row wins. Otherwise the
 * default is `warn` when a pre-regime issued document exists, else `enforce`; with
 * `materialise`, that default is written (first write path), never on a read path.
 */
export async function resolveGateMode(db: SettingsDb, opts: { materialise: boolean }): Promise<GateMode> {
  const rows = (await db.findMany("einvoicing_settings", { limit: 1 })) as Row[]
  const existing = oneOf(rows[0]?.gate_mode, ["warn", "enforce"] as const)
  if (existing) return existing
  const upgraded = await hasPreRegimeIssuedDocument(db)
  const mode: GateMode = upgraded ? "warn" : "enforce"
  if (opts.materialise) {
    await db.insert("einvoicing_settings", {
      gate_mode: mode,
      gate_mode_source: upgraded ? "upgrade_default" : "install_default",
    })
  }
  return mode
}

/** Provenance of a credit note's SIREN taken from the buyer's identity (see resolveBuyerFacts). */
const SIREN_FROM_IDENTITY_REASON = {
  code: "buyer_siren_from_identity",
  en: "The buyer's SIREN comes from its registry-confirmed identity: the original invoice did not record it.",
  fr: "Le SIREN de l'acheteur provient de son identité confirmée au registre : la facture d'origine ne le mentionnait pas.",
}

const GATE_WARNING_REASON = (r: GateResult) => ({
  code: "gate_warning",
  en: `Issued in warn mode with e-invoicing data missing (${r.code}).`,
  fr: `Émis en mode avertissement avec des données de facturation électronique manquantes (${r.code}).`,
  missing: r.missing.map((m) => m.field),
})

export interface RegimeSnapshotColumns {
  regime: Regime
  regime_reasons: unknown[]
  operation_category: OperationCategory | null
  operation_category_source: OperationSource | null
  payment_state: PaymentState | null
  vat_on_debits: boolean | null
  customer_kind: CustomerKind | null
  buyer_siren: string | null
  buyer_siret: string | null
  buyer_routing_address: string | null
  buyer_legal_name: string | null
  buyer_siren_confirmed_via: "auto" | "approval" | null
  billing_line1: string | null
  billing_line2: string | null
  billing_postcode: string | null
  billing_city: string | null
  billing_country_code: string | null
  delivery_name?: string | null
  delivery_line1?: string | null
  delivery_line2?: string | null
  delivery_postcode?: string | null
  delivery_city?: string | null
  delivery_country_code?: string | null
  tax_point_date: string | null
  original_document_id: string | null
  internal_cancellation: boolean | null
  fx_rate: string | null
  fx_rate_date: string | null
  fx_source: string | null
  /** Decimal string: a bigint cannot cross the sandbox bridge inside the snapshot object. */
  tax_total_eur_minor: string | null
}

export interface DeliveryAddress {
  name?: string | null
  line1?: string | null
  line2?: string | null
  postcode?: string | null
  city?: string | null
  country_code?: string | null
}

function sameAddress(d: DeliveryAddress, b: BuyerFacts["billing"]): boolean {
  const n = (v: string | null | undefined) => (v ?? "").trim().toLowerCase()
  return (
    n(d.line1) === n(b.line1) &&
    n(d.line2) === n(b.line2) &&
    n(d.postcode) === n(b.postcode) &&
    n(d.city) === n(b.city) &&
    n(d.country_code) === n(b.countryCode)
  )
}

/**
 * The regime / buyer / address columns written on an issued document. Called after the gate
 * passed (enforce) or with its warning (warn): a warning adds a `gate_warning` reason and,
 * when the classifier reached no verdict, records `needs_review`.
 */
export function regimeSnapshot(args: {
  evaluation: GateEvaluation
  input: GateInput
  issuedAt: string | null
  delivery: DeliveryAddress | null
  /** A non-EUR document: the cached ECB rate (null when none is cached; issuing never waits on it)
   *  and the document's VAT total in its own minor units. */
  fx?: { rate: string; rate_date: string } | null
  taxTotalMinor?: bigint
  /** The document's currency: its ISO 4217 exponent scales `taxTotalMinor` (0 for JPY, 2 for USD). */
  currency?: string | null
}): Partial<RegimeSnapshotColumns> {
  const { evaluation: ev, input } = args
  const b = input.buyer
  const warning = ev.refusal && ev.refusal.mode === "warn" ? ev.refusal : null
  const reasons: unknown[] = [...ev.reasons]
  if (warning) reasons.push(GATE_WARNING_REASON(warning))
  if (b.source === "original_identity") reasons.push(SIREN_FROM_IDENTITY_REASON)
  const siren = b.siren && isValidSiren(b.siren) ? b.siren : null
  const out: Partial<RegimeSnapshotColumns> = {
    regime: ev.regime ?? "needs_review",
    regime_reasons: reasons,
    operation_category: ev.operationCategory,
    operation_category_source: ev.operationSource,
    payment_state: input.paymentState,
    vat_on_debits: input.issuer.vat_on_debits_default ?? null,
    customer_kind: b.customerKind,
    buyer_siren: siren,
    buyer_siret: b.siret,
    buyer_routing_address: siren,
    buyer_legal_name: b.legalName,
    buyer_siren_confirmed_via: siren ? b.confirmedVia : null,
    billing_line1: b.billing.line1,
    billing_line2: b.billing.line2,
    billing_postcode: b.billing.postcode,
    billing_city: b.billing.city,
    billing_country_code: b.billing.countryCode,
    tax_point_date: args.issuedAt,
    original_document_id: input.original?.id ?? null,
    internal_cancellation: input.docType === "credit_note" ? ev.internalCancellation : null,
  }
  if (args.fx && args.taxTotalMinor !== undefined) {
    if (!args.currency) throw new Error("regimeSnapshot: an fx snapshot needs the document currency")
    out.fx_rate = args.fx.rate
    out.fx_rate_date = args.fx.rate_date
    out.fx_source = "ECB"
    out.tax_total_eur_minor = eurMinor(args.taxTotalMinor, args.fx.rate, currencyExponent(args.currency)).toString()
  }
  const d = args.delivery
  if (d && !sameAddress(d, b.billing)) {
    out.delivery_name = str(d.name)
    out.delivery_line1 = str(d.line1)
    out.delivery_line2 = str(d.line2)
    out.delivery_postcode = str(d.postcode)
    out.delivery_city = str(d.city)
    out.delivery_country_code = str(d.country_code)?.toUpperCase() ?? null
  }
  return out
}

/** The kind of park an e-invoicing identity refusal raises (order-paid, refund, cancellation). */
export const EINVOICE_IDENTITY_PARK_KIND = "einvoice_identity"

interface AttentionCtx {
  db: FindManyDb
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

/**
 * Raise the `einvoicing:identity_missing` attention item for an identity park: only when the
 * park was just created (a redelivery refreshes it silently) and no other open identity park
 * already waits on the same contact, so one contact gets one item however many documents wait.
 * Returns true when the event was emitted.
 */
/** True when an open identity park other than `parkId` waits on `contactId`. Filtered by the
 *  park's `contact_id` column and status, never a bounded scan of every open park. */
async function otherOpenIdentityPark(db: FindManyDb, contactId: string, parkId: string): Promise<boolean> {
  const open = (await db.findMany("deferred_events", {
    where: { contact_id: contactId, status: "awaiting_data" },
    limit: 50,
  })) as Row[]
  return open.some(
    (r) => String(r.id) !== parkId && ((r.blocked_on ?? {}) as Row).kind === EINVOICE_IDENTITY_PARK_KIND,
  )
}

/**
 * Resolve the `einvoicing:identity_missing` attention item once an identity park closed: keyed
 * by the contact (by the park itself when contactless), and only when no other open identity
 * park still waits on that contact. Returns true when the resolve was emitted.
 */
export async function resolveIdentityAttention(
  ctx: AttentionCtx,
  input: { parkId: string; contact_id: string | null },
): Promise<boolean> {
  if (!ctx.emit) return false
  if (input.contact_id && (await otherOpenIdentityPark(ctx.db, input.contact_id, input.parkId))) return false
  await ctx.emit({
    entity: "einvoicing",
    action: "identity_missing",
    entityId: input.contact_id ?? input.parkId,
    data: { contact_id: input.contact_id, deferred_id: input.parkId, resolved: true },
  })
  return true
}

export async function raiseIdentityAttention(
  ctx: AttentionCtx,
  input: {
    park: { id: string; created: boolean }
    contact_id: string | null
    code: GateCode
    data?: Record<string, unknown>
  },
): Promise<boolean> {
  if (!input.park.created || !ctx.emit) return false
  if (input.contact_id && (await otherOpenIdentityPark(ctx.db, input.contact_id, input.park.id))) return false
  await ctx.emit({
    entity: "einvoicing",
    action: "identity_missing",
    entityId: input.contact_id ?? input.park.id,
    data: {
      ...(input.data ?? {}),
      contact_id: input.contact_id,
      code: input.code,
      deferred_id: input.park.id,
      resolved: false,
    },
  })
  return true
}
