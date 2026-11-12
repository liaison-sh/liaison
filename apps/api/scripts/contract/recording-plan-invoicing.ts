// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What record-invoicing.ts runs, in order: each step names a contract entry
// (`<kind>:<name>`), builds its input from what earlier steps created (`state.values`), and may
// read its answer for later steps. Every party below is fictional (example domains, the
// registry's test SIRENs); the Shopify order is the development store's own.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { RecordInput } from "~/modules/apps/contract/recorder"

export interface InvoicingPlanState {
  /** The development store's `<shop>.myshopify.com`. */
  shop: string
  values: Record<string, unknown>
  /** A direct Admin REST read (`orders.json`): the recorder's own call, never recorded. */
  rest: (path: string) => Promise<Record<string, unknown>>
  /** A direct database statement for setup the app's tools do not offer (never recorded). */
  sql: (text: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>
}

export interface InvoicingPlanStep {
  entry: string
  /** Setup before the input is built (seed what no tool writes). */
  before?: (s: InvoicingPlanState) => Promise<void>
  input: (s: InvoicingPlanState) => RecordInput | Promise<RecordInput>
  /** Read the answer (the handler's result, or `{ thrown }`) for later steps. */
  after?: (answer: unknown, s: InvoicingPlanState) => void | Promise<void>
  /** False: run it (a prerequisite) without writing a fixture. */
  record?: boolean
}

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {})
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? (v as Rec[]) : [])
const params = (p: Rec): RecordInput => ({ params: p })
const keep = (key: string) => (a: unknown, s: InvoicingPlanState) => {
  s.values[key] = a
}
const str = (s: InvoicingPlanState, key: string, path = ""): string => {
  let v: unknown = s.values[key]
  for (const part of path ? path.split(".") : [])
    v = Array.isArray(v) ? v[Number(part)] : obj(v)[part]
  return typeof v === "string" || typeof v === "number" ? String(v) : ""
}

/** A registry test SIREN (the public registry's own example companies are not used). */
const SELLER_SIREN = "902000009"
const BUYER_FR = {
  legal_name: "Atelier Lumen SAS",
  country: "FR",
  vat_id: "FR40900000001",
  address: "12 rue des Lilas, 69003 Lyon, France",
  email: "compta@atelier-lumen.example",
  customer_kind: "business",
  billing_line1: "12 rue des Lilas",
  billing_postcode: "69003",
  billing_city: "Lyon",
  billing_country_code: "FR",
}
/** An export customer: no EU VAT number to check, customs data on the goods. */
const BUYER_US = {
  legal_name: "Harbor Lane Recording LLC",
  country: "US",
  address: "410 Harbor Lane, Portland, OR 97209, United States",
  email: "ap@harborlane.example",
}
/** A consumer in another member state (OSS: the customer's country's VAT). */
const CONSUMER_DE = {
  legal_name: "Jonas Becker",
  country: "DE",
  address: "Lindenweg 3, 10115 Berlin, Germany",
  email: "jonas.becker@mail.example",
}
const ITEMS = [
  {
    description: "Studio monitor, pair",
    quantity: 2,
    unit_price_minor: 41940,
    hs_code: "851822",
    country_of_origin: "FR",
    customs_description: "Loudspeakers",
  },
  { description: "Installation", quantity: 1, unit_price_minor: 15000 },
]

/** The Shopify app's normalized order event (shopify webhooks.ts normalizeOrder), from a REST order. */
function orderEvent(order: Rec, shop: string): Rec {
  const currency = String(order.presentment_currency ?? order.currency ?? "EUR")
  const money = (amount: unknown) => ({ amount: String(amount ?? "0"), currencyCode: currency })
  const address = (a: unknown) => {
    const x = obj(a)
    if (!a) return null
    return {
      firstName: x.first_name ?? null,
      lastName: x.last_name ?? null,
      company: x.company ?? null,
      address1: x.address1 ?? null,
      address2: x.address2 ?? null,
      city: x.city ?? null,
      zip: x.zip ?? null,
      province: x.province ?? null,
      countryCode: x.country_code ?? null,
      phone: x.phone ?? null,
    }
  }
  const customer = obj(order.customer)
  const country =
    obj(order.shipping_address).country_code ?? obj(order.billing_address).country_code ?? null
  const data = {
    orderId: String(order.id),
    name: order.name ?? null,
    customer: order.customer
      ? {
          id: String(customer.id),
          email: customer.email ?? order.email ?? null,
          first_name: customer.first_name ?? null,
          last_name: customer.last_name ?? null,
          country,
          external_ids: { shopify: String(customer.id) },
        }
      : null,
    customerId: order.customer ? String(customer.id) : null,
    poNumber: null,
    buyerTaxId: null,
    note: order.note ?? null,
    totalPrice: money(order.total_price),
    taxesIncluded: order.taxes_included === true,
    billingAddress: address(order.billing_address),
    shippingAddress: address(order.shipping_address),
    lineItems: arr(order.line_items).map((li) => ({
      id: li.id == null ? null : String(li.id),
      title: li.title ?? null,
      quantity: li.quantity ?? 1,
      priceSet: money(li.price),
      requiresShipping: li.requires_shipping !== false,
      taxLines: arr(li.tax_lines).map((t) => ({
        title: t.title ?? null,
        rate: t.rate ?? 0,
        priceSet: money(t.price),
      })),
      discountAllocations: arr(li.discount_allocations).map((d) => money(d.amount)),
      variant: {
        id: li.variant_id == null ? null : String(li.variant_id),
        title: li.variant_title ?? null,
        sku: li.sku ?? null,
      },
    })),
    shippingLines: arr(order.shipping_lines).map((sl) => ({
      title: sl.title ?? null,
      priceSet: money(sl.discounted_price ?? sl.price),
      taxLines: [],
    })),
    fulfillmentStatus: order.fulfillment_status ?? null,
    financialStatus: order.financial_status ?? null,
    marketId: null,
    shopDomain: shop,
  }
  return { entity: "order", action: "created", entityId: data.orderId, data }
}

/** The data an issue handed the PDF renderer, read from that issue's recorded fixture. */
function renderedData(fixture: string): Rec {
  const f = JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../src/modules/apps/contract/fixtures", "invoicing", fixture),
      "utf8",
    ),
  ) as {
    calls: Array<{ method: string; args: unknown[] }>
  }
  for (const c of f.calls) {
    if (c.method !== "pdf_render") continue
    const p = obj(typeof c.args[0] === "string" ? JSON.parse(c.args[0] as string) : c.args[0])
    if (p.data) return obj(p.data)
  }
  throw new Error(`${fixture} rendered no PDF`)
}

const doc = (key: string) => (s: InvoicingPlanState) =>
  str(s, key, "document_id") || str(s, key, "id")

export const INVOICING_RECORDING_PLAN: InvoicingPlanStep[] = [
  // ── Settings ────────────────────────────────────────────────────────────────
  {
    entry: "tool:settings_issuer_profile_create",
    input: () =>
      params({
        legal_name: "Resonance Atelier SARL",
        country: "FR",
        vat_id: "FR86902000009",
        address: "1 rue de Test, 75001 Paris, France",
        iban: "FR7630006000011234567890189",
        swift_bic: "AGRIFRPP",
        bank_name: "Banque Exemple",
        default_currency: "EUR",
        default_language: "fr",
        default_payment_terms_days: 30,
        prefix_invoice: "FAC-{YYYY}-",
        prefix_quote: "DEV-{YYYY}-",
        prefix_proforma: "PRO-{YYYY}-",
        prefix_po: "BC-{YYYY}-",
        timezone: "Europe/Paris",
        prices_include_tax: false,
      }),
    after: async (a, s) => {
      s.values.issuer = a
      // The e-invoicing seller identity and the credit-note series, which the create tool does
      // not take (the settings page sets them).
      await s.sql(
        `UPDATE app_invoicing.issuer_profiles SET prefix_credit_note = 'AV-{YYYY}-', siren = $1,
           routing_address = $1, address_line1 = '1 rue de Test', postcode = '75001', city = 'Paris',
           country_code = 'FR' WHERE org_id = '00000000-0000-4000-8000-00000000c0de'`,
        [SELLER_SIREN],
      )
      const [row] = await s.sql(
        `SELECT id FROM app_invoicing.issuer_profiles WHERE org_id = '00000000-0000-4000-8000-00000000c0de' LIMIT 1`,
      )
      s.values.issuerId = String(row?.id ?? "")
    },
  },
  { entry: "tool:settings_issuer_profile_list", input: () => params({}) },
  {
    entry: "tool:settings_issuer_profile_update",
    input: (s) => params({ id: s.values.issuerId, bank_name: "Banque Exemple Paris" }),
  },
  { entry: "tool:settings_tax_regime_list", input: () => params({}) },
  { entry: "tool:settings_hs_code_list", input: () => params({ limit: 20 }) },
  {
    entry: "tool:hs_codes_library_upsert",
    input: () =>
      params({ code: "851822", description: "Multiple loudspeakers, mounted in one enclosure" }),
  },
  {
    entry: "tool:hs_codes_library_upsert",
    input: () => params({ code: "852352", description: "Semiconductor media" }),
    record: false,
  },
  { entry: "tool:hs_codes_library_delete", input: () => params({ code: "852352" }) },
  { entry: "tool:viewer_access", input: () => params({}) },
  { entry: "tool:einvoicing_settings_get", input: () => params({}) },
  { entry: "tool:einvoicing_settings_values", input: () => params({}) },
  { entry: "tool:einvoicing_provider_options", input: () => params({}) },
  {
    entry: "tool:einvoicing_settings_set",
    input: () => params({ gate_mode: "warn", cutover_date: "2026-09-01", send_enabled: false }),
  },
  { entry: "tool:einvoicing_readiness", input: () => params({ limit: 20 }) },

  // ── Drafts and issuing from a draft ───────────────────────────────────────────
  {
    entry: "tool:drafts_create",
    input: (s) =>
      params({
        type: "invoice",
        issuer_profile_id: s.values.issuerId,
        counterparty_name: BUYER_FR.legal_name,
        counterparty_address: BUYER_FR.address,
        counterparty_email: BUYER_FR.email,
        counterparty_country: "FR",
        counterparty_vat_id: BUYER_FR.vat_id,
        customer_kind: "business",
        billing_line1: BUYER_FR.billing_line1,
        billing_postcode: BUYER_FR.billing_postcode,
        billing_city: BUYER_FR.billing_city,
        billing_country_code: "FR",
        operation_category: "goods",
        currency: "EUR",
        items: ITEMS,
      }),
    after: keep("draft"),
  },
  {
    entry: "preflight:drafts_create",
    input: (s) =>
      params({
        type: "quote",
        issuer_profile_id: s.values.issuerId,
        counterparty_name: BUYER_US.legal_name,
        counterparty_address: BUYER_US.address,
        counterparty_email: BUYER_US.email,
        counterparty_country: "US",
        currency: "EUR",
        items: ITEMS,
      }),
  },
  {
    entry: "tool:drafts_update",
    input: (s) =>
      params({
        draft_id: str(s, "draft", "draft_id"),
        patch: { notes: "Delivery by appointment", due_at: "2026-02-15" },
      }),
  },
  {
    entry: "preflight:drafts_update",
    input: (s) =>
      params({ draft_id: str(s, "draft", "draft_id"), patch: { po_number: "PO-7731" } }),
  },
  {
    entry: "tool:draft_issue_preview",
    input: (s) => params({ draft_id: str(s, "draft", "draft_id") }),
  },
  {
    entry: "preflight:invoice_issue",
    input: (s) => params({ draft_id: str(s, "draft", "draft_id") }),
  },
  {
    entry: "tool:invoice_issue",
    input: (s) => params({ draft_id: str(s, "draft", "draft_id") }),
    after: keep("invoice"),
  },
  {
    entry: "tool:drafts_create",
    input: (s) =>
      params({
        type: "quote",
        issuer_profile_id: s.values.issuerId,
        counterparty_name: BUYER_US.legal_name,
        counterparty_address: BUYER_US.address,
        counterparty_email: BUYER_US.email,
        counterparty_country: "US",
        currency: "EUR",
        items: ITEMS,
      }),
    after: keep("quoteDraft"),
    record: false,
  },
  {
    entry: "preflight:quote_issue",
    input: (s) => params({ draft_id: str(s, "quoteDraft", "draft_id") }),
  },
  {
    entry: "tool:quote_issue",
    input: (s) => params({ draft_id: str(s, "quoteDraft", "draft_id") }),
    after: keep("quote"),
  },
  {
    entry: "tool:drafts_create",
    input: (s) =>
      params({
        type: "proforma",
        issuer_profile_id: s.values.issuerId,
        counterparty_name: BUYER_US.legal_name,
        counterparty_address: BUYER_US.address,
        counterparty_email: BUYER_US.email,
        counterparty_country: "US",
        currency: "EUR",
        items: ITEMS,
      }),
    after: keep("proformaDraft"),
    record: false,
  },
  {
    entry: "preflight:proforma_issue",
    input: (s) => params({ draft_id: str(s, "proformaDraft", "draft_id") }),
  },
  {
    entry: "tool:proforma_issue",
    input: (s) => params({ draft_id: str(s, "proformaDraft", "draft_id") }),
  },
  {
    entry: "tool:drafts_create",
    input: (s) =>
      params({
        type: "purchase_order",
        issuer_profile_id: s.values.issuerId,
        counterparty_name: BUYER_US.legal_name,
        counterparty_address: BUYER_US.address,
        counterparty_email: BUYER_US.email,
        counterparty_country: "US",
        currency: "EUR",
        items: ITEMS,
      }),
    after: keep("poDraft"),
    record: false,
  },
  { entry: "tool:po_issue", input: (s) => params({ draft_id: str(s, "poDraft", "draft_id") }) },
  {
    entry: "tool:drafts_create",
    input: (s) =>
      params({
        type: "invoice",
        issuer_profile_id: s.values.issuerId,
        counterparty_name: BUYER_US.legal_name,
        counterparty_address: BUYER_US.address,
        counterparty_email: BUYER_US.email,
        counterparty_country: "US",
        currency: "EUR",
        items: ITEMS,
      }),
    after: keep("discardDraft"),
    record: false,
  },
  {
    entry: "tool:drafts_discard",
    input: (s) => params({ draft_id: str(s, "discardDraft", "draft_id") }),
  },

  // ── Create and issue in one call ──────────────────────────────────────────────
  {
    entry: "preflight:invoice_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        items: ITEMS,
      }),
  },
  {
    entry: "tool:invoice_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        items: ITEMS,
        po_number: "NA-2209",
        operation_category: "goods",
      }),
    after: keep("invoiceUS"),
  },
  {
    entry: "preflight:quote_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        items: ITEMS,
      }),
  },
  {
    entry: "tool:quote_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        items: ITEMS,
        customer_reference: "RFQ-118",
      }),
    after: keep("quote2"),
  },
  {
    entry: "preflight:proforma_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        items: ITEMS,
        reason: "Customs declaration",
      }),
  },
  {
    entry: "tool:proforma_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: CONSUMER_DE,
        buyer_is_consumer: true,
        currency: "EUR",
        items: ITEMS,
        reason: "Advance payment",
      }),
  },
  {
    entry: "preflight:po_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        items: ITEMS,
      }),
  },
  {
    entry: "tool:po_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        items: ITEMS,
        po_number: "BC-SUP-41",
      }),
  },

  // ── Reading documents ─────────────────────────────────────────────────────────
  {
    entry: "tool:documents_search",
    input: () => params({ type: "invoice", limit: 10, include_lines: true }),
  },
  { entry: "tool:documents_get", input: (s) => params({ id: doc("invoiceUS")(s) }) },
  {
    entry: "tool:documents_issue_preview",
    input: (s) => params({ issuer_profile_id: s.values.issuerId, counterparty: BUYER_US }),
  },
  {
    entry: "tool:documents_update_preview",
    input: (s) =>
      params({
        id: doc("invoiceUS")(s),
        counterparty_address: "Hafenstrasse 6, 20457 Hamburg, Germany",
      }),
  },
  { entry: "tool:pending_approvals_list", input: () => params({}) },
  { entry: "tool:deferred_list", input: () => params({ limit: 20 }) },
  {
    entry: "tool:legal_originals_verify",
    input: (s) => params({ document_id: doc("invoiceUS")(s) }),
  },
  {
    entry: "export:export",
    input: () => params({ format: "json", dateRange: { from: "2025-01-01", to: "2026-12-31" } }),
  },

  // ── Changing documents ────────────────────────────────────────────────────────
  {
    entry: "preflight:documents_update",
    input: (s) => params({ id: doc("quote2")(s), notes: "Valid 30 days" }),
  },
  {
    entry: "tool:documents_update",
    input: (s) => params({ id: doc("quote2")(s), notes: "Valid 30 days", po_number: "RFQ-118-B" }),
  },
  { entry: "tool:documents_retry_pdf", input: (s) => params({ id: doc("quote2")(s) }) },
  {
    entry: "preflight:documents_convert_to_invoice",
    input: (s) => params({ source_document_id: doc("quote2")(s) }),
  },
  {
    entry: "tool:documents_convert_to_invoice",
    input: (s) => params({ source_document_id: doc("quote2")(s), operation_category: "goods" }),
  },
  {
    entry: "preflight:documents_mark_paid",
    input: (s) => params({ document_id: doc("invoiceUS")(s), paid_date: "2026-01-20" }),
  },
  {
    entry: "tool:documents_mark_paid",
    input: (s) =>
      params({
        document_id: doc("invoiceUS")(s),
        paid_date: "2026-01-20",
        payment_note: "Bank transfer",
      }),
  },
  {
    entry: "preflight:documents_record_refund",
    input: (s) =>
      params({
        document_id: doc("invoiceUS")(s),
        refund_amount_minor: 15000,
        refund_kind: "partial",
      }),
  },
  {
    entry: "tool:documents_record_refund",
    input: (s) =>
      params({
        document_id: doc("invoiceUS")(s),
        refund_amount_minor: 15000,
        refund_kind: "partial",
      }),
  },
  {
    entry: "preflight:documents_send_to_customer",
    input: (s) => params({ document_id: doc("invoiceUS")(s) }),
  },
  {
    entry: "tool:documents_send_to_customer",
    input: (s) => params({ document_id: doc("invoiceUS")(s), subject: "Your invoice" }),
  },
  {
    entry: "preflight:credit_note_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        original_document_id: doc("invoiceUS")(s),
        reason: "Installation not performed",
        items: [{ description: "Installation", quantity: 1, unit_price_minor: -15000 }],
      }),
  },
  {
    entry: "tool:credit_note_create_and_issue",
    input: (s) =>
      params({
        issuer_profile_id: s.values.issuerId,
        counterparty: BUYER_US,
        currency: "EUR",
        original_document_id: doc("invoiceUS")(s),
        reason: "Installation not performed",
        items: [{ description: "Installation", quantity: 1, unit_price_minor: -15000 }],
      }),
  },
  {
    entry: "tool:drafts_create",
    input: (s) =>
      params({
        type: "credit_note",
        issuer_profile_id: s.values.issuerId,
        counterparty_name: BUYER_FR.legal_name,
        counterparty_address: BUYER_FR.address,
        counterparty_email: BUYER_FR.email,
        counterparty_country: "FR",
        counterparty_vat_id: BUYER_FR.vat_id,
        currency: "EUR",
        external_refs: { original_document_id: doc("invoice")(s) },
        items: [
          { description: "Studio monitor, pair (returned)", quantity: 1, unit_price_minor: -41940 },
        ],
      }),
    after: keep("cnDraft"),
    record: false,
  },
  {
    entry: "preflight:credit_note_issue",
    input: (s) => params({ draft_id: str(s, "cnDraft", "draft_id") }),
  },
  {
    entry: "tool:credit_note_issue",
    input: (s) => params({ draft_id: str(s, "cnDraft", "draft_id") }),
  },

  // ── Customs and contacts ──────────────────────────────────────────────────────
  {
    entry: "tool:hs_codes_assign",
    input: () =>
      params({
        product_source: "manual",
        external_id: "SKU-MON-2",
        hs_code: "851822",
        country_of_origin: "FR",
        customs_description: "Loudspeakers",
      }),
  },
  {
    entry: "tool:hs_codes_unassign",
    input: () =>
      params({ product_source: "manual", external_id: "SKU-MON-2", fields: ["country_of_origin"] }),
  },
  {
    entry: "tool:contact_relationships_set",
    before: async (s) => {
      // The buyer's contact, as the contacts app holds it.
      s.values.contactId = "00000000-0000-4000-8000-0000000c0a01"
      await s.sql(
        `INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, org_access)
          VALUES ($1, '00000000-0000-4000-8000-00000000c0de', '@atelier-lumen', $2, $3,
            '00000000-0000-4000-8000-00000000c0df', 'editor') ON CONFLICT DO NOTHING`,
        [s.values.contactId, BUYER_FR.legal_name, BUYER_FR.email],
      )
    },
    input: (s) => params({ contact_id: s.values.contactId, relationship: "customer" }),
  },
  {
    entry: "tool:counterparty_identity_get",
    input: (s) => params({ document_id: doc("invoice")(s) }),
  },
  {
    entry: "tool:counterparty_identity_lookup",
    input: () => params({ query: "Atelier Lumen", postcode: "69003" }),
  },
  {
    entry: "tool:counterparty_identity_set",
    input: (s) =>
      params({
        contact_id: s.values.contactId,
        customer_kind: "business",
        siren: "900000001",
        source: "manual",
        notes: "SIREN given by the customer's accountant",
      }),
  },
  {
    entry: "tool:counterparty_territory_set",
    input: (s) =>
      params({
        contact_id: s.values.contactId,
        treatment: "as_foreign",
        reason: "Customer is based in Monaco",
      }),
  },
  { entry: "tool:einvoicing_classify", input: (s) => params({ document_id: doc("invoice")(s) }) },
  {
    entry: "tool:vat_validate",
    input: () => params({ country_code: "DE", vat_number: "DE123456789" }),
  },

  // ── E-invoicing ───────────────────────────────────────────────────────────────
  {
    entry: "tool:einvoice_transmission_get",
    input: (s) => params({ document_id: doc("invoice")(s) }),
  },
  { entry: "tool:einvoice_send_request", input: (s) => params({ document_id: doc("invoice")(s) }) },
  {
    entry: "tool:einvoice_status_refresh",
    input: (s) => params({ document_id: doc("invoice")(s) }),
  },
  {
    entry: "tool:einvoice_send",
    input: (s) =>
      params({
        document_id: doc("invoice")(s),
        legal_original_sha256: "0".repeat(64),
        buyer_siren: "900000001",
        routing_address: "900000001",
      }),
  },
  {
    entry: "tool:einvoice_book_batch",
    input: () => params({ batch_id: "00000000-0000-4000-8000-0000000b0001" }),
  },
  { entry: "tool:received_einvoices_list", input: () => params({ limit: 20 }) },
  { entry: "tool:received_einvoices_refresh", input: () => params({}) },
  {
    entry: "tool:received_einvoices_get",
    input: () => params({ received_id: "00000000-0000-4000-8000-0000000e0001" }),
  },
  {
    entry: "tool:received_einvoice_action_request",
    input: () =>
      params({
        received_id: "00000000-0000-4000-8000-0000000e0001",
        action: "dispute",
        reason: "Quantity differs from delivery note",
      }),
  },
  {
    entry: "preflight:received_einvoice_set_status",
    input: () =>
      params({
        received_id: "00000000-0000-4000-8000-0000000e0001",
        action: "dispute",
        reason: "Quantity differs",
      }),
  },
  {
    entry: "tool:received_einvoice_set_status",
    input: () =>
      params({
        received_id: "00000000-0000-4000-8000-0000000e0001",
        action: "dispute",
        reason: "Quantity differs",
      }),
  },
  {
    entry: "tool:einvoicing_backfill_identities",
    input: () => params({ dry_run: true, limit: 20 }),
  },
  {
    entry: "tool:einvoicing_backfill_legacy_originals",
    input: () => params({ dry_run: true, limit: 20 }),
  },

  // ── Shopify events ────────────────────────────────────────────────────────────
  {
    entry: "event:shopify/order:created",
    before: async (s) => {
      // The issuer bills the development store's orders from here on.
      await s.sql(`UPDATE app_invoicing.issuer_profiles SET shopify_shop_id = $1 WHERE id = $2`, [
        s.shop,
        s.values.issuerId,
      ])
      const orders = arr((await s.rest("orders.json?status=any&limit=10")).orders)
      const paid = orders.find((o) => o.financial_status === "paid" && arr(o.line_items).length > 0)
      if (!paid) throw new Error("the development store has no paid order to invoice")
      s.values.order = paid
    },
    input: (s) => params(orderEvent(obj(s.values.order), s.shop)),
    after: keep("orderInvoice"),
  },
  { entry: "tool:settings_shop_mapping_list", input: () => params({}) },
  {
    entry: "event:shopify/order:updated",
    input: (s) => {
      const e = orderEvent(obj(s.values.order), s.shop)
      return params({ ...e, action: "updated", changedFields: ["note"] })
    },
  },
  {
    entry: "event:shopify/refund:created",
    input: (s) => {
      const o = obj(s.values.order)
      return params({
        entity: "refund",
        action: "created",
        data: {
          id: "990000000001",
          order_id: String(o.id),
          refund_amount_minor: 1000,
          currency: String(o.currency ?? "EUR"),
        },
      })
    },
  },
  {
    entry: "event:shopify/order:cancelled",
    input: (s) => {
      const o = obj(s.values.order)
      return params({
        entity: "order",
        action: "cancelled",
        entityId: String(o.id),
        data: { orderId: String(o.id), cancel_reason: "customer" },
      })
    },
  },

  // ── Deferred work and the tax decision ────────────────────────────────────────
  {
    entry: "tool:deferred_tax_override",
    before: async (s) => {
      const [d] = await s.sql(
        `SELECT id FROM app_invoicing.deferred_events WHERE org_id = '00000000-0000-4000-8000-00000000c0de' ORDER BY created_at DESC LIMIT 1`,
      )
      s.values.deferredId = String(d?.id ?? "00000000-0000-4000-8000-0000000d0001")
    },
    input: (s) => params({ deferred_id: s.values.deferredId, mode: "as_computed" }),
  },
  {
    entry: "preflight:deferred_tax_override",
    input: (s) => params({ deferred_id: s.values.deferredId, mode: "as_computed" }),
  },
  {
    entry: "tool:order_reissue_apply",
    input: (s) =>
      params({
        original_document_id: doc("invoice")(s),
        shopify_order_id: String(obj(s.values.order).id),
        billing_signature: "sig-contract-1",
        dedupe_key: "reissue-contract-1",
        currency: "EUR",
        reason: "Order edited",
        items: [{ description: "Studio monitor, pair", quantity: 1, unit_price_minor: 41940 }],
      }),
  },
  {
    entry: "preflight:order_reissue_apply",
    input: (s) =>
      params({
        original_document_id: doc("invoice")(s),
        shopify_order_id: String(obj(s.values.order).id),
        billing_signature: "sig-contract-1",
        dedupe_key: "reissue-contract-1",
        items: [{ description: "Studio monitor, pair", quantity: 1, unit_price_minor: 41940 }],
      }),
  },

  // ── Scheduled jobs ────────────────────────────────────────────────────────────
  { entry: "job:deferred-retry", input: () => params({}) },
  { entry: "job:overdue-scan", input: () => params({}) },
  { entry: "job:reconcile-shopify-payments", input: () => params({}) },
  { entry: "job:backfill-order-numbers", input: () => params({}) },
  { entry: "job:link-shipments", input: () => params({}) },
  {
    entry: "job:resume-interrupted-issues",
    before: async (s) => {
      // An issue a run left numbered but unrendered, long enough ago to be owed.
      // Before the contract clock's start (2026-01-01), so the run sees it pending long enough.
      await s.sql(
        `UPDATE app_invoicing.documents SET pdf_status = 'pending', updated_at = '2025-12-31T22:00:00Z'
          WHERE id = $1`,
        [doc("invoiceUS")(s)],
      )
    },
    input: () => params({}),
  },
  { entry: "job:identity-confirm", input: () => params({}) },
  { entry: "job:einvoicing-transmit", input: () => params({}) },
  { entry: "job:einvoicing-book-daily", input: () => params({}) },
  { entry: "job:einvoicing-received-catchup", input: () => params({}) },
  { entry: "job:einvoicing-status-catchup", input: () => params({}) },
  { entry: "job:einvoicing-booking-invariant", input: () => params({}) },

  // ── PDF templates (each draws the document an issue rendered) and the import ──
  ...["invoice", "quote", "proforma", "po", "credit_note"].map(
    (kind): InvoicingPlanStep => ({
      entry: `pdf-template:invoicing:${kind}_v1`,
      input: () => params(renderedData("tool__invoice_issue.json")),
    }),
  ),
  {
    entry: "import:document",
    before: async (s) => {
      // A PDF the org already holds stands for the original document of the imported invoice.
      const [f] = await s.sql(
        `SELECT id FROM kernel.files WHERE org_id = '00000000-0000-4000-8000-00000000c0de' AND app = 'invoicing'
          AND mime_type = 'application/pdf' LIMIT 1`,
      )
      s.values.pdfFileId = String(f?.id ?? "")
    },
    input: (s) => ({
      params: {
        runId: "00000000-0000-4000-8000-0000000a1001",
        kind: "document",
        sourceLabel: "Previous invoicing tool (CSV and PDFs)",
        records: [
          {
            dedupValue: "legacy:INV-2025-0412",
            record: {
              externalRef: "legacy:INV-2025-0412",
              type: "invoice",
              number: "INV-2025-0412",
              numberInt: 412,
              issueDate: "2025-11-03",
              dueDate: "2025-12-03",
              currency: "EUR",
              counterparty: {
                name: BUYER_FR.legal_name,
                address: BUYER_FR.address,
                country: "FR",
                vatId: BUYER_FR.vat_id,
                email: BUYER_FR.email,
              },
              lines: [
                {
                  description: "Studio monitor, pair",
                  quantity: 1,
                  unitPriceMinor: 41940,
                  taxRateBp: 2000,
                  totalMinor: 41940,
                },
              ],
              subtotalMinor: 41940,
              taxTotalMinor: 8388,
              grandTotalMinor: 50328,
              status: "paid",
              pdf: { fileId: s.values.pdfFileId },
            },
          },
        ],
      },
    }),
  },

  // ── Issuer deletion last (it refuses while documents exist, which is the case recorded) ──
  {
    entry: "preflight:settings_issuer_profile_delete",
    input: (s) => params({ id: s.values.issuerId }),
  },
  { entry: "tool:settings_issuer_profile_delete", input: (s) => params({ id: s.values.issuerId }) },
]
