// SPDX-License-Identifier: FSL-1.1-ALv2
// `einvoicing_classify` (read only): the e-invoicing regime of a document, of the invoice a
// Shopify order would get, or of an invoice to a counterparty, with the reasons and what the
// issue gate would refuse. Never writes (the gate mode is computed, not materialised).
import type { CrossAppExecuteTool } from "../cross-app"
import type { Counterparty } from "../issue"
import { counterpartyFromRow } from "../mutations/lines"
import { getDraft } from "../mutations/db-helpers"
import type { MutationsDb } from "../mutations/shared"
import { type OrderPaidPayload, findIssuerByShopId, mergeCustomer } from "../handlers/shopify-order-paid"
import type { GateResult } from "./gate"
import { type PreparedGate, prepareEinvoiceGate } from "./issue-gate"

type Row = Record<string, unknown>

export interface ClassifyToolCtx {
  db: MutationsDb
  executeTool?: CrossAppExecuteTool
}

function fail(code: string, message: string) {
  return { status: "error" as const, error: { code, message } }
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

interface IssuerLike {
  country: string
  vat_id: string | null
  vat_on_debits_default?: boolean | null
}

function issuerOf(row: Row): IssuerLike {
  return {
    country: String(row.country ?? ""),
    vat_id: (row.vat_id as string | null) ?? null,
    vat_on_debits_default: (row.vat_on_debits_default as boolean | null | undefined) ?? null,
  }
}

/** The issuer a counterparty would be invoiced by: unambiguous only when every profile shares
 *  the facts the classifier reads (country, VAT registration). */
async function soleIssuer(db: MutationsDb): Promise<IssuerLike | { ambiguous: true } | null> {
  const rows = (await db.findMany("issuer_profiles", { limit: 50 })) as Row[]
  if (rows.length === 0) return null
  const facts = new Set(rows.map((r) => `${String(r.country ?? "").toUpperCase()}|${!!str(r.vat_id)}`))
  if (facts.size > 1) return { ambiguous: true }
  return issuerOf(rows[0]!)
}

function verdict(subject: Row, prepared: PreparedGate): Row {
  const e = prepared.evaluation
  const r: GateResult | null = e.refusal
  const b = prepared.input.buyer
  return {
    status: "ok",
    ...subject,
    regime: e.regime,
    reasons: e.reasons,
    gate_mode: prepared.mode,
    would_refuse: r ? { code: r.code, message: r.message, missing: r.missing } : null,
    buyer: {
      source: b.source,
      customer_kind: b.customerKind,
      legal_name: b.legalName,
      siren: b.siren,
      siren_confirmed: b.sirenConfirmed,
      billing_country_code: b.billing.countryCode,
    },
  }
}

async function classifyDocument(ctx: ClassifyToolCtx, id: string): Promise<Row> {
  const rows = (await ctx.db.findMany("documents", { where: { id }, limit: 1 })) as Row[]
  const doc = rows[0]
  if (!doc) return fail("row_not_found", `document ${id} not found`)
  if (doc.status !== "draft") {
    // An issued document's regime was decided at issue and is recorded on it.
    return {
      status: "ok",
      subject: "document",
      document_id: id,
      source: "recorded",
      regime: doc.regime ?? null,
      reasons: doc.regime_reasons ?? [],
    }
  }
  const draft = await getDraft(ctx.db, id)
  if (!draft) return fail("row_not_found", `document ${id} not found`)
  const issuerRows = (await ctx.db.findMany("issuer_profiles", { where: { id: draft.issuer_profile_id }, limit: 1 })) as Row[]
  if (!issuerRows[0]) return fail("issuer_not_found", `issuer_profile ${draft.issuer_profile_id} not found`)
  const issuer = issuerOf(issuerRows[0])
  const counterparty = counterpartyFromRow(draft, issuer)
  const prepared = await prepareEinvoiceGate(
    ctx,
    {
      type: draft.type,
      issuer,
      counterparty,
      lines: draft.lines,
      operation_category: draft.operation_category ?? null,
    },
    { materialise: false },
  )
  return verdict({ subject: "document", document_id: id, source: "computed" }, prepared)
}

async function classifyContact(ctx: ClassifyToolCtx, contactId: string): Promise<Row> {
  const issuer = await soleIssuer(ctx.db)
  if (!issuer) return fail("no_issuer_profile", "no issuer profile is configured")
  if ("ambiguous" in issuer) {
    return fail("issuer_profile_ambiguous", "issuer profiles differ in country or VAT registration: classify a draft (document_id) instead")
  }
  // Billing and name as last invoiced to this contact; the identity row wins on kind and SIREN.
  const docs = (await ctx.db.findMany("documents", { where: { counterparty_contact_id: contactId }, limit: 10 })) as Row[]
  const last = docs.find((d) => str(d.billing_country_code) || str(d.counterparty_country)) ?? docs[0] ?? {}
  const counterparty = counterpartyFromRow(
    {
      counterparty_contact_id: contactId,
      counterparty_name: str(last.counterparty_name),
      counterparty_country: str(last.counterparty_country) ?? str(last.billing_country_code),
      counterparty_vat_id: str(last.counterparty_vat_id),
      einvoice: {
        billing_line1: str(last.billing_line1),
        billing_line2: str(last.billing_line2),
        billing_postcode: str(last.billing_postcode),
        billing_city: str(last.billing_city),
        billing_country_code: str(last.billing_country_code),
      },
    },
    issuer,
  )
  const prepared = await prepareEinvoiceGate(
    ctx,
    { type: "invoice", issuer, counterparty, lines: [] },
    { materialise: false },
  )
  return verdict({ subject: "contact", contact_id: contactId }, prepared)
}

async function classifyOrder(ctx: ClassifyToolCtx, orderIdRaw: string): Promise<Row> {
  const orderId = orderIdRaw.replace(/^gid:\/\/shopify\/Order\//, "")
  // Already invoiced: its recorded regime.
  const docs = (await ctx.db.findMany("documents", { where: { shopify_order_id: orderId }, limit: 20 })) as Row[]
  const invoice = docs.find((d) => d.type === "invoice" && d.status !== "draft")
  if (invoice) {
    return {
      status: "ok",
      subject: "order",
      shopify_order_id: orderId,
      document_id: String(invoice.id),
      source: "recorded",
      regime: invoice.regime ?? null,
      reasons: invoice.regime_reasons ?? [],
    }
  }
  // The order's event as parked (it carries the contact and the shop), plus the live order.
  const parks = (await ctx.db.findMany("deferred_events", { where: { event_id: orderId }, limit: 5 })) as Row[]
  const payload = (parks.find((p) => p.event_payload_json && typeof p.event_payload_json === "object")?.event_payload_json ??
    null) as OrderPaidPayload | null
  if (!ctx.executeTool) return fail("target_app_unavailable", "the Shopify app is not reachable")
  const env = await ctx.executeTool("shopify:orders_get", { id: `gid://shopify/Order/${orderId}` })
  if (env.status !== "completed") return fail("order_not_found", `Shopify order ${orderId} could not be read`)
  const customer = mergeCustomer(payload?.customer, (env.result ?? null) as never)
  if (!customer) return fail("order_not_found", `Shopify order ${orderId} has no customer`)

  let issuer: IssuerLike | null = null
  if (payload?.shop_id) {
    const row = await findIssuerByShopId(ctx.db, payload.shop_id)
    if (row) issuer = { country: row.country, vat_id: row.vat_id }
  }
  if (!issuer) {
    const sole = await soleIssuer(ctx.db)
    if (!sole) return fail("no_issuer_profile", "no issuer profile is configured")
    if ("ambiguous" in sole) return fail("issuer_profile_ambiguous", "the order's shop maps to no single issuer profile")
    issuer = sole
  }
  const country = customer.country ?? customer.tax_country ?? issuer.country
  const counterparty: Counterparty = {
    contact_id: customer.contact_id ?? null,
    legal_name: customer.legal_name ?? customer.email ?? "",
    country,
    vat_id: customer.vat_id ?? null,
    address: customer.address ?? null,
    email: customer.email ?? null,
    billing_line1: customer.billing?.line1 ?? null,
    billing_line2: customer.billing?.line2 ?? null,
    billing_postcode: customer.billing?.postcode ?? null,
    billing_city: customer.billing?.city ?? null,
    billing_country_code: customer.billing?.country_code ?? country,
  }
  const lines = (payload?.line_items ?? []).map((li) => ({ line_kind: li.line_kind ?? "goods" }))
  const prepared = await prepareEinvoiceGate(
    ctx,
    {
      type: "invoice",
      issuer,
      counterparty,
      lines,
      operation_source: lines.length > 0 ? "lines_authoritative" : null,
      origin: "shopify",
      company: customer.billing?.company ?? null,
    },
    { materialise: false },
  )
  return verdict({ subject: "order", shopify_order_id: orderId, source: "computed" }, prepared)
}

export async function einvoicingClassify(
  ctx: ClassifyToolCtx,
  input: { document_id?: string | null; shopify_order_id?: string | number | null; contact_id?: string | null },
): Promise<Row> {
  const documentId = str(input?.document_id)
  // A Shopify order id is a number to most callers: take it as one too.
  const rawOrder = input?.shopify_order_id
  const orderId = typeof rawOrder === "number" && Number.isFinite(rawOrder) ? String(Math.trunc(rawOrder)) : str(rawOrder)
  const contactId = str(input?.contact_id)
  if ([documentId, orderId, contactId].filter(Boolean).length !== 1) {
    return fail("invalid_input", "pass exactly one of document_id, shopify_order_id, contact_id")
  }
  if (documentId) return classifyDocument(ctx, documentId)
  if (orderId) return classifyOrder(ctx, orderId)
  return classifyContact(ctx, contactId as string)
}
