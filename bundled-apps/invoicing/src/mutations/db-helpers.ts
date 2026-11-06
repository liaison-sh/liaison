// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: generic-CRUD wrappers around semantic operations (issuer profile
// resolution, document summaries, draft rows and lines, prior refunds, line item details).

import { lineSubtotal } from "../money"
import { type DraftLine, type IssuerProfile, type IssueDb, readRefString } from "../issue"
import { isUuid } from "../reads"
import { readEinvoiceRowColumns } from "../einvoicing/issue-gate"
import { liftMisplacedCountry } from "./lines"
import {
  type MutationsDb,
  type ErrorEnvelope,
  type DocumentRowSummary,
  type DocumentType,
  type DraftRow,
  type DraftInsert,
  toBigInt,
  normaliseNotesOrThrow,
} from "./shared"

// ── DB helpers (generic-CRUD wrappers around semantic operations) ─────────

export interface IssuerProfileRow extends IssuerProfile {
  invoice_approval_threshold_minor?: string | number | null
  po_approval_threshold_minor?: string | number | null
  require_two_eyes?: boolean
  /** The org's configured send-from mail account (app_mail.accounts id). send_to_customer passes it
   *  as the `accountId` to mail:compose, which requires one. */
  mail_account_id?: string | null
  /** The Shopify shop (myshopify domain) this issuer bills for. When set, a quote issued under
   *  this profile IS a Shopify draft order: quote_create_and_issue creates the draft order and
   *  the `draft_order:*` events mirror it back. Null keeps the app fully standalone. */
  shopify_shop_id?: string | null
  /** Typed unit prices are GROSS (tax included) under this profile. It MIRRORS the Shopify
   *  shop's "include tax in prices" setting, so one typed price means the same thing on both
   *  sides of the mapping. Applied once, at the boundary where hand-typed lines enter
   *  (`netLinesForIssuer`); lines that arrive already net (the draft-order sync, a convert)
   *  are never touched. */
  prices_include_tax?: boolean
}

/** Slice an ISO-8601 date/date-time value (or a bare `Date`) to its `YYYY-MM-DD` calendar date
 *  for a reviewer-legible approval-card line. Degrades to null on anything malformed/absent —
 *  never throws, never renders "Invalid Date" on a card. */
export function dateOnly(v: unknown): string | null {
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

/** True when `date` is `YYYY-MM-DD` and names a real day, so `2026-02-31` is no date. */
export function isCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
}

/**
 * Lifecycle-log event names that record a refund against a document. Both the
 * agent path (documents.record_refund → *_refund_recorded) and the Shopify
 * webhook path (onShopifyRefundCreated → partially_refunded / refunded) write
 * into the same document.lifecycle_log, so the cumulative-refund guard must
 * recognise every shape. `refund_amount_minor` is persisted as a STRING in
 * minor units on each of these entries.
 */
const REFUND_RECORDED_EVENTS = new Set([
  "partial_refund_recorded",
  "full_refund_recorded",
  "partially_refunded",
  "refunded",
])

/**
 * Sum, in minor units, every refund already recorded in a document's
 * lifecycle_log. Entries that carry no parseable amount (e.g. a legacy
 * `{ event: "refunded" }` with no minor field) contribute 0 — the caller's
 * status logic handles the full-refund case separately. All money stays in
 * minor units; nothing is converted across currencies.
 */
export function sumPriorRefundedMinor(
  lifecycleLog: Array<Record<string, unknown>>,
): bigint {
  let total = 0n
  for (const entry of lifecycleLog) {
    if (!REFUND_RECORDED_EVENTS.has(String(entry.event ?? ""))) continue
    const raw = entry.refund_amount_minor
    if (raw == null || raw === "") continue
    total += toBigInt(raw)
  }
  return total
}

export async function findIssuerProfile(
  db: Pick<IssueDb, "findMany">,
  id: string,
): Promise<IssuerProfileRow | null> {
  // The QuickJS sandbox shim auto-JSON-parses bridge results only when at
  // least one argument is non-primitive. `findOne(entity, id)` with two
  // strings does NOT trigger that path — the result comes back as a raw
  // JSON string. We route by-id reads through `findMany` with an options
  // object instead, which always parses cleanly.
  const rows = await db.findMany("issuer_profiles", { where: { id }, limit: 1 })
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: String(row.id),
    legal_name: String(row.legal_name ?? ""),
    country: String(row.country ?? ""),
    vat_id: (row.vat_id as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    iban: (row.iban as string | null) ?? null,
    swift_bic: (row.swift_bic as string | null) ?? null,
    bank_name: (row.bank_name as string | null) ?? null,
    default_language:
      (row.default_language as "en" | "fr" | "de") ?? "en",
    timezone: (row.timezone as string | null) ?? null,
    logo_file_id: (row.logo_file_id as string | null) ?? null,
    // Defaults mirror the manifest schema defaults — older fixtures and
    // partial INSERTs sometimes land without these, so we fall back here
    // rather than refusing issuance.
    prefix_invoice: (row.prefix_invoice as string | undefined) ?? "INV-{YYYY}-",
    prefix_quote: (row.prefix_quote as string | undefined) ?? "QUO-{YYYY}-",
    prefix_proforma: (row.prefix_proforma as string | undefined) ?? "PRO-{YYYY}-",
    prefix_po: (row.prefix_po as string | undefined) ?? "PO-{YYYY}-",
    prefix_credit_note: (row.prefix_credit_note as string | undefined) ?? "CN-{YYYY}-",
    invoice_approval_threshold_minor:
      (row.invoice_approval_threshold_minor as string | number | null) ?? null,
    po_approval_threshold_minor:
      (row.po_approval_threshold_minor as string | number | null) ?? null,
    require_two_eyes: !!row.require_two_eyes,
    mail_account_id: (row.mail_account_id as string | null) ?? null,
    shopify_shop_id: (row.shopify_shop_id as string | null) ?? null,
    prices_include_tax: !!row.prices_include_tax,
    vat_on_debits_default:
      typeof row.vat_on_debits_default === "boolean" ? row.vat_on_debits_default : null,
    siren: (row.siren as string | null) ?? null,
    siret: (row.siret as string | null) ?? null,
    routing_address: (row.routing_address as string | null) ?? null,
    address_line1: (row.address_line1 as string | null) ?? null,
    address_line2: (row.address_line2 as string | null) ?? null,
    postcode: (row.postcode as string | null) ?? null,
    city: (row.city as string | null) ?? null,
    country_code: (row.country_code as string | null) ?? null,
    legal_form: (row.legal_form as string | null) ?? null,
    share_capital: (row.share_capital as string | null) ?? null,
    rcs_city: (row.rcs_city as string | null) ?? null,
  }
}

/**
 * Resolve the issuer profile a document-creating tool should use, defaulting
 * SAFELY when the caller omitted `issuer_profile_id`.
 *
 * The failure this prevents: a weak model calls a create/issue tool with no
 * `issuer_profile_id`, the NULL reaches the NOT-NULL `documents.issuer_profile_id`
 * column, and pg raises 23502 — which surfaces to the agent as an opaque "Tool
 * execution failed" it can only flail against (observed live: 9 retries). Instead:
 *   * exactly one issuer profile in the org  -> default to it (the common case,
 *     and the e2e/single-issuer fixture);
 *   * several                                -> a TYPED error LISTING the ids +
 *     legal names, telling the agent to pass `issuer_profile_id` — never guess;
 *   * none                                   -> a TYPED error telling the agent
 *     to create an issuer profile in settings first.
 * A passed `issuer_profile_id` that does not resolve returns the same
 * `issuer_not_found` shape the create paths used before.
 */
export async function resolveIssuerProfileOrError(
  db: MutationsDb,
  issuerProfileId: string | null | undefined,
): Promise<{ ok: true; issuer: IssuerProfileRow } | { ok: false; error: ErrorEnvelope }> {
  const explicit = typeof issuerProfileId === "string" ? issuerProfileId.trim() : ""
  const fail = (code: string, message: string) => ({
    ok: false as const,
    error: { status: "error" as const, error: { code, message } },
  })
  const createGuidance =
    "The issuer profile is the company's legal identity printed on every document. " +
    "Ask the person for their company's legal name, country, postal address and legal " +
    "identifiers (VAT number, SIREN or SIRET), or for a document that shows them; never make " +
    "them up. Create it with settings_issuer_profile_create (legal_name, country, address, " +
    "vat_id), then call this tool again with the new profile's id as issuer_profile_id."
  const noIssuerError = fail(
    "no_issuer_profile",
    `no issuer profile configured for this org, so nothing can be issued yet (nothing was created). ${createGuidance}`,
  )
  if (explicit) {
    const issuer = await findIssuerProfile(db, explicit)
    if (issuer) return { ok: true, issuer }
    const rows = (await db.findMany("issuer_profiles", { limit: 100 })) as Array<Record<string, unknown>>
    if (rows.length === 0) {
      return fail(
        "issuer_not_found",
        `issuer_profile ${explicit} not found, and this org has no issuer profile at all (nothing was created). ${createGuidance}`,
      )
    }
    return fail(
      "issuer_not_found",
      `issuer_profile ${explicit} not found: no issuer profile has that id (nothing was created). ` +
        `Use one of this org's profiles as issuer_profile_id: ${describeIssuerProfiles(rows)}. ` +
        `settings_issuer_profile_list returns them all.`,
    )
  }
  // No explicit id — resolve the org's issuer profiles and default only when unambiguous.
  const rows = (await db.findMany("issuer_profiles", { limit: 100 })) as Array<Record<string, unknown>>
  if (rows.length === 0) return noIssuerError
  if (rows.length > 1) {
    return fail(
      "issuer_profile_ambiguous",
      `this org has ${rows.length} issuer profiles and no issuer_profile_id was passed, so nothing ` +
        `was created (do NOT guess). Call this tool again with issuer_profile_id set to one of: ` +
        `${describeIssuerProfiles(rows)}. A profile linked to a Shopify shop issues a quote as a ` +
        `Shopify draft order; a profile with no shop issues a plain quote. Ask the person which ` +
        `company issues it when the request does not say.`,
    )
  }
  const soleRow = rows[0]
  const issuer = soleRow ? await findIssuerProfile(db, String(soleRow.id)) : null
  // Race/inconsistency between the count read and the by-id read: treat as none.
  if (!issuer) return noIssuerError
  return { ok: true, issuer }
}

/** One line per issuer profile for a refusal: id, legal name and its Shopify shop, if any. */
export function describeIssuerProfiles(rows: Array<Record<string, unknown>>): string {
  return rows
    .map((r) => {
      const shop =
        typeof r.shopify_shop_id === "string" && r.shopify_shop_id.trim() !== "" ? r.shopify_shop_id.trim() : null
      return `${String(r.id)} (${String(r.legal_name ?? "unnamed")}, ${
        shop ? `linked to Shopify shop ${shop}` : "no shop linked"
      })`
    })
    .join("; ")
}

/**
 * Reject a Shopify DRAFT-order id passed where a completed-order id belongs.
 * `gid://shopify/DraftOrder/<n>` (and the bare `DraftOrder/<n>` shape) can never
 * link to a real order, so silently accepting it would persist an invoice tied to
 * a non-order. Returns a TYPED error steering the agent to the completed order's
 * numeric id, or null when the id is safe (absent, or a normal order id). A bare
 * numeric id is deliberately NOT rejected — completed orders are routinely passed
 * unprefixed, and there is no local way to prove a number is a draft.
 */
export function rejectDraftOrderId(shopifyOrderId: string | null | undefined): ErrorEnvelope | null {
  if (typeof shopifyOrderId !== "string") return null
  const id = shopifyOrderId.trim()
  if (!id) return null
  if (/(^|\/)DraftOrder\//i.test(id)) {
    return {
      status: "error",
      error: {
        code: "shopify_draft_order_id",
        message:
          `no Shopify order ${id} known to invoicing: that is a DRAFT-order id, not a completed order. ` +
          `Complete the draft order in Shopify first, then pass the resulting completed order's numeric id ` +
          `(not the draft-order id).`,
      },
    }
  }
  return null
}

// Characters that can never appear in a uuid NOR a document number (e.g. a Shopify GID
// `gid://shopify/DraftOrder/123`) — short-circuit to not-found without a wasted query. Mirrors
// reads.ts's resolveDocumentRow (kept local since MutationsDb is a distinct db-client shape).
export const FOREIGN_ID_CHARS = /[:/\s]/

export async function findDocumentSummary(
  db: MutationsDb,
  idOrNumber: string,
): Promise<DocumentRowSummary | null> {
  if (!idOrNumber || FOREIGN_ID_CHARS.test(idOrNumber)) return null
  // A weak agent naturally passes the visible document NUMBER (e.g. "PO0034009", read off a
  // documents_search result or a rendered PDF) rather than the internal uuid `id` — that used to
  // fall straight into this `where: { id }` lookup and 22P02 at the pg layer ("invalid input syntax
  // for type uuid"), surfacing as a bare 500 (prod incident, PO0034009). Route non-uuid input to a
  // number lookup instead; org/RLS scoping on `db` keeps this unambiguous.
  const where = isUuid(idOrNumber) ? { id: idOrNumber } : { number: idOrNumber }
  const rows = await db.findMany("documents", { where, limit: 1 })
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    id: String(row.id),
    type: (row.type as DocumentType | string) ?? "invoice",
    status: (row.status as string | undefined) ?? "draft",
    counterparty_contact_id:
      (row.counterparty_contact_id as string | null) ?? null,
    counterparty_name: (row.counterparty_name as string | null) ?? null,
    counterparty_address: (row.counterparty_address as string | null) ?? null,
    counterparty_shipping_address: (row.counterparty_shipping_address as string | null) ?? null,
    counterparty_shipping_name: (row.counterparty_shipping_name as string | null) ?? null,
    counterparty_vat_id: (row.counterparty_vat_id as string | null) ?? null,
    counterparty_email: (row.counterparty_email as string | null) ?? null,
    counterparty_country: (row.counterparty_country as string | null) ?? null,
    currency: String(row.currency ?? "EUR"),
    incoterm: String(row.incoterm ?? "DAP"),
    issuer_profile_id: String(row.issuer_profile_id ?? ""),
    lifecycle_log:
      (row.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? [],
    pdf_file_id: (row.pdf_file_id as string | null) ?? null,
    pdf_status: (row.pdf_status as string | null) ?? null,
    number: (row.number as string | null) ?? null,
    payment_status: (row.payment_status as string | null) ?? null,
    grand_total_minor: toBigInt(row.grand_total_minor),
    issued_at: (row.issued_at as string | null) ?? null,
    external_refs: (row.external_refs as Record<string, unknown> | undefined) ?? {},
    shopify_draft_order_id: readDraftOrderId(row),
    shopify_order_id:
      typeof row.shopify_order_id === "string" && row.shopify_order_id.length > 0
        ? row.shopify_order_id
        : null,
    shopify_order_number:
      typeof row.shopify_order_number === "string" && row.shopify_order_number.length > 0
        ? row.shopify_order_number
        : null,
    // Column first, external_refs fallback for a row written before the column existed
    // (the legacy CSV importer has always recorded it there) — same rule reads.ts's
    // readRefColumn applies.
    po_number:
      readRefString(row, "po_number") ??
      readRefString((row.external_refs as Record<string, unknown> | undefined) ?? {}, "po_number"),
    notes: readRefString(row, "notes"),
    regime: readRefString(row, "regime"),
    einvoice_state: readRefString(row, "einvoice_state"),
    einvoice: readEinvoiceRowColumns(row),
  }
}

export async function loadDraftLines(
  db: MutationsDb,
  documentId: string,
): Promise<DraftLine[]> {
  const rows = await db.findMany("document_lines", {
    where: { document_id: documentId },
    orderBy: { position: "asc" },
    limit: 1000,
  })
  return rows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      position: Number(r.position ?? 0),
      description: String(r.description ?? ""),
      quantity: String(r.quantity ?? "0"),
      unit_price_minor: toBigInt(r.unit_price_minor),
      tax_rate_bp_override:
        r.tax_rate_bp != null ? Number(r.tax_rate_bp) : undefined,
      hs_code: (r.hs_code as string | null) ?? null,
      customs_description: (r.customs_description as string | null) ?? null,
      country_of_origin: (r.country_of_origin as string | null) ?? null,
      product_source: (r.product_source as string | null) ?? null,
      external_id: (r.external_id as string | null) ?? null,
    }
  })
}

async function insertDraftLines(
  db: MutationsDb,
  documentId: string,
  lines: DraftLine[],
): Promise<void> {
  let position = 0
  for (const l of lines) {
    position += 1
    // Line subtotal = quantity x unit_price. Storing "0" made a draft (and drafts_update's returned
    // state) show zero totals for lines that clearly had a price — the agent + judge read it as a
    // broken/empty draft (the export multi-step scenarios). Tax is still 0 on a draft (applied at
    // issue), so total = subtotal here.
    const subtotal = lineSubtotal({ quantity: l.quantity, unit_price_minor: l.unit_price_minor })
    await db.insert("document_lines", {
      document_id: documentId,
      // Agent-supplied lines carry NO `position` (only DB-loaded lines do). Inserting `undefined`
      // violated document_lines.position NOT-NULL (23502) and aborted the whole drafts_create/update.
      // Fall back to the 1-based array index, mirroring issueDocument's `position ?? lineIndex`.
      position: l.position ?? position,
      description: l.description,
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor.toString(),
      // Persist NULL (not 0) when there is no per-line override, so issuing the
      // draft falls back to the tax classifier's domestic rate. Writing 0 here
      // would round-trip back as an explicit 0% override and drop all VAT.
      tax_rate_bp:
        typeof l.tax_rate_bp_override === "number"
          ? l.tax_rate_bp_override
          : null,
      subtotal_minor: subtotal.toString(),
      tax_minor: "0",
      total_minor: subtotal.toString(),
      // Inline customs facts (export lines) — persist what the agent supplied instead of hardcoding
      // null, so a one-shot drafts_create export invoice carries its HS codes through to issue.
      hs_code: l.hs_code ?? null,
      country_of_origin: l.country_of_origin ?? null,
      customs_description: l.customs_description ?? null,
      product_source: l.product_source,
      external_id: l.external_id,
    })
  }
}

export async function deleteAllLines(
  db: MutationsDb,
  documentId: string,
): Promise<void> {
  const rows = await db.findMany("document_lines", {
    where: { document_id: documentId },
    limit: 1000,
  })
  for (const row of rows) {
    const id = String((row as Record<string, unknown>).id)
    await db.delete("document_lines", id)
  }
}

export async function getDraft(
  db: MutationsDb,
  draftId: string,
): Promise<DraftRow | null> {
  // findMany shape — see comment in findIssuerProfile for the rationale.
  const rows = await db.findMany("documents", { where: { id: draftId }, limit: 1 })
  const doc = rows[0] as Record<string, unknown> | undefined
  if (!doc) return null
  if (doc.status !== "draft") return null
  const lines = await loadDraftLines(db, draftId)
  return {
    id: String(doc.id),
    type: (doc.type as DocumentType) ?? "invoice",
    counterparty_contact_id:
      (doc.counterparty_contact_id as string | null) ?? null,
    counterparty_name: (doc.counterparty_name as string | null) ?? null,
    counterparty_address: (doc.counterparty_address as string | null) ?? null,
    counterparty_shipping_address: (doc.counterparty_shipping_address as string | null) ?? null,
    counterparty_shipping_name: (doc.counterparty_shipping_name as string | null) ?? null,
    counterparty_vat_id: (doc.counterparty_vat_id as string | null) ?? null,
    counterparty_email: (doc.counterparty_email as string | null) ?? null,
    counterparty_country: (doc.counterparty_country as string | null) ?? null,
    tax_treatment: (doc.tax_treatment as string | null) ?? null,
    issuer_profile_id: String(doc.issuer_profile_id ?? ""),
    currency: String(doc.currency ?? "EUR"),
    incoterm: String(doc.incoterm ?? "DAP"),
    due_at: (doc.due_at as string | null) ?? null,
    external_refs:
      (doc.external_refs as Record<string, unknown> | undefined) ?? {},
    po_number: (doc.po_number as string | null) ?? null,
    notes: (doc.notes as string | null) ?? null,
    ...draftEinvoiceFieldsOf(doc),
    lines,
    created_at: (doc.created_at as string | null) ?? null,
  }
}

export async function insertDraftRow(
  db: MutationsDb,
  row: DraftInsert,
): Promise<DraftRow> {
  const inserted = (await db.insert("documents", {
    type: row.type,
    status: "draft",
    counterparty_contact_id: row.counterparty_contact_id,
    counterparty_name: row.counterparty_name ?? null,
    counterparty_address: row.counterparty_address ?? null,
    counterparty_shipping_address: row.counterparty_shipping_address ?? null,
    counterparty_shipping_name: row.counterparty_shipping_name ?? null,
    counterparty_vat_id: row.counterparty_vat_id ?? null,
    counterparty_email: row.counterparty_email ?? null,
    counterparty_country: row.counterparty_country ?? null,
    issuer_profile_id: row.issuer_profile_id,
    currency: row.currency,
    incoterm: row.incoterm ?? "DAP",
    due_at: row.due_at ?? null,
    external_refs: row.external_refs ?? {},
    shopify_order_id: row.shopify_order_id ?? null,
    shopify_order_number: row.shopify_order_number ?? null,
    po_number: row.po_number ?? null,
    notes: row.notes ?? null,
    lifecycle_log: [],
    subtotal_minor: "0",
    tax_total_minor: "0",
    grand_total_minor: "0",
    payment_status: "unpaid",
    number: null,
    number_int: null,
    year_of_issue: null,
    issued_at: null,
    pdf_file_id: null,
    pdf_status: null,
    tax_treatment: row.tax_treatment ?? null,
    ...draftEinvoiceWrite(row, "insert"),
  })) as Record<string, unknown>
  const id = String(inserted.id)
  await insertDraftLines(db, id, row.lines)
  return { ...row, id, created_at: (inserted.created_at as string | null) ?? null }
}

export async function updateDraftRow(
  db: MutationsDb,
  draftId: string,
  patch: Partial<DraftInsert>,
): Promise<DraftRow> {
  const existing = await getDraft(db, draftId)
  if (!existing) {
    throw new Error(`not_found: draft ${draftId}`)
  }
  // BL-44: route a destination country the agent put in the informational `tax_treatment` onto the
  // field of record `counterparty_country` (which drives the issue-time tax classification).
  const lifted = liftMisplacedCountry(patch)
  const update: Record<string, unknown> = {}
  if (lifted.type) update.type = lifted.type
  if ("counterparty_contact_id" in lifted)
    update.counterparty_contact_id = lifted.counterparty_contact_id
  if ("counterparty_name" in lifted) update.counterparty_name = lifted.counterparty_name
  if ("counterparty_address" in lifted) update.counterparty_address = lifted.counterparty_address
  if ("counterparty_shipping_address" in lifted)
    update.counterparty_shipping_address = lifted.counterparty_shipping_address
  if ("counterparty_shipping_name" in lifted)
    update.counterparty_shipping_name = lifted.counterparty_shipping_name
  if ("counterparty_vat_id" in lifted) update.counterparty_vat_id = lifted.counterparty_vat_id
  if ("counterparty_email" in lifted) update.counterparty_email = lifted.counterparty_email
  if (lifted.issuer_profile_id) update.issuer_profile_id = lifted.issuer_profile_id
  if (lifted.currency) update.currency = lifted.currency
  if (lifted.incoterm) update.incoterm = lifted.incoterm
  if ("counterparty_country" in lifted) update.counterparty_country = lifted.counterparty_country
  if ("tax_treatment" in lifted) update.tax_treatment = lifted.tax_treatment
  if ("due_at" in lifted) update.due_at = lifted.due_at
  // Free text: normalised (trim, blank -> null, length-capped) before it reaches the column,
  // the same rule every other notes write goes through.
  if ("notes" in lifted) update.notes = normaliseNotesOrThrow(lifted.notes) ?? null
  if (lifted.external_refs) update.external_refs = lifted.external_refs
  Object.assign(update, draftEinvoiceWrite(patch, "patch"))
  if (Object.keys(update).length > 0) {
    await db.update("documents", draftId, update)
  }
  if (patch.lines) {
    await deleteAllLines(db, draftId)
    await insertDraftLines(db, draftId, patch.lines)
  }
  const refreshed = await getDraft(db, draftId)
  if (!refreshed) throw new Error(`draft ${draftId} disappeared after update`)
  return refreshed
}

const DRAFT_EINVOICE_ENUMS = {
  customer_kind: ["business", "individual", "public_entity", "non_registered_entity"],
  operation_category: ["goods", "services", "mixed"],
} as const
const DRAFT_EINVOICE_TEXT = [
  "billing_line1",
  "billing_line2",
  "billing_postcode",
  "billing_city",
  "billing_country_code",
] as const

/**
 * The e-invoicing columns a draft write carries: `customer_kind` and `operation_category`
 * (enum-checked, a bad value is a typed error naming the allowed ones) and the structured billing
 * address (trimmed, blank becomes null, country code upper-cased). On a patch only the keys the
 * caller mentioned are written.
 */
function draftEinvoiceWrite(
  input: Partial<DraftInsert>,
  mode: "insert" | "patch",
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, allowed] of Object.entries(DRAFT_EINVOICE_ENUMS)) {
    if (!(key in input)) continue
    const v = (input as Record<string, unknown>)[key]
    if (v === null || v === undefined || v === "") {
      out[key] = null
      continue
    }
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      throw new Error(`invalid_params: ${key} must be one of ${allowed.join(", ")} (got ${JSON.stringify(v)})`)
    }
    out[key] = v
  }
  for (const key of DRAFT_EINVOICE_TEXT) {
    if (!(key in input)) continue
    const raw = (input as Record<string, unknown>)[key]
    const t = typeof raw === "string" ? raw.trim() : ""
    out[key] = t === "" ? null : key === "billing_country_code" ? t.toUpperCase() : t
  }
  // A stated category is the caller's: record where it came from.
  if ("operation_category" in out) {
    out.operation_category_source = out.operation_category ? "explicit" : null
  }
  if (mode === "insert") {
    for (const k of [...Object.keys(DRAFT_EINVOICE_ENUMS), ...DRAFT_EINVOICE_TEXT]) {
      if (!(k in out)) out[k] = null
    }
  }
  return out
}

/** A draft row's e-invoicing fields, for `getDraft`. */
function draftEinvoiceFieldsOf(doc: Record<string, unknown>): Partial<DraftRow> {
  const cols = readEinvoiceRowColumns(doc)
  return {
    customer_kind: cols.customer_kind ?? null,
    operation_category: cols.operation_category ?? null,
    billing_line1: cols.billing_line1 ?? null,
    billing_line2: cols.billing_line2 ?? null,
    billing_postcode: cols.billing_postcode ?? null,
    billing_city: cols.billing_city ?? null,
    billing_country_code: cols.billing_country_code ?? null,
    einvoice: cols,
  }
}

export async function deleteDraftRow(db: MutationsDb, draftId: string): Promise<void> {
  await deleteAllLines(db, draftId)
  await db.delete("documents", draftId)
}

/** The Shopify draft order a document mirrors, from the top-level column or the external_refs
 *  fallback (rows written before the column existed). */
export function readDraftOrderId(
  row: { shopify_draft_order_id?: unknown; external_refs?: unknown } | null | undefined,
): string | null {
  const direct = row?.shopify_draft_order_id
  if (typeof direct === "string" && direct.trim() !== "") return direct.trim()
  const refs = (row?.external_refs as Record<string, unknown> | undefined) ?? {}
  const fallback = refs.shopify_draft_order_id
  return typeof fallback === "string" && fallback.trim() !== "" ? fallback.trim() : null
}
