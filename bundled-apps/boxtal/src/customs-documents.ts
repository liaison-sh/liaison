// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ORDER as a print record, and the paperwork the organisation's document rules ask for,
// generated on its own.
//
// A parcel to some destinations needs papers nobody would guess from the row (a customs
// declaration of the metal in the goods, a chemical-substances certification). Which ones is the
// organisation's DATA: kernel document templates (the text and layout), kernel document rules
// (record type `boxtal:order`: destination, SKU, carrier, product attribute -> templates) and
// kernel product attributes (the facts about each product a template prints). Nothing here knows
// a product, a destination or a legal text.
//
// The order record (`order_print_record_get`, manifest `entities.order.print`) exists from the
// moment the order enters To prepare: before a label it is built from the goods invoice and the
// order's ship-to (the same virtual draft the worklist resolves); once a label is bought it is the
// label's buy-time snapshot plus the tracking number as the carrier issued it. Files print onto
// the order's own row (`prep_state`, keyed by the invoice's document ref), so the papers made at
// To prepare and the ones made after the buy live in one place and follow the parcel to the print
// pack.
//
// generateOrderDocuments: for each order, match the rules, then print every needed template whose
// record CHANGED since it was last printed (a fingerprint of the record). So the papers are made
// once at To prepare, made again when the label is bought and its tracking number appears, and
// left alone otherwise. A template a rule no longer asks for is dropped from the order's list
// (its file stays on the row, as history). Best effort throughout: a failure is logged and
// reported, never thrown into the caller (the worklist sync, the label buy).
//
// Nothing is ever derived or defaulted: a value the sources do not hold is null and the template
// prints its blank.
import type { BoxtalToolCtx } from "./ctx"
import { currencyExponent } from "./money"
import {
  buildPrintSnapshot,
  carrierFamilyOf,
  countryNameEn,
  type PrintLine,
  type PrintSnapshot,
  readPrintSnapshot,
  trackingLabelOf,
} from "./print-record"
import { CARRIER_BRANDS } from "./carriers"
import { refKey, resolveVariantSkus, SHOPIFY_VARIANT_GID } from "./product-attributes"
import { worklistCandidates } from "./queues"
import { shipmentDraftCreate } from "./shipment"

/** The record type the order prints and matches as (manifest `entities.order.print`). */
export const ORDER_RECORD_TYPE = "boxtal:order"
/** Orders one generation pass works through (the rest wait for the next pass). */
export const GENERATE_BATCH = 25

// ---------------------------------------------------------------------------
// Formatting (English paperwork: "9 November 2026", "USD 1,234.50")
// ---------------------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** "2026-11-09..." -> "9 November 2026"; null when not a date. */
export function dateText(value: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""))
  if (!m) return null
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null
}

/** 1234.5, "USD" -> "USD 1,234.50"; null when either is missing. */
export function moneyText(value: number | null | undefined, currency: string | null | undefined): string | null {
  if (value == null || !Number.isFinite(value) || !currency) return null
  const digits = currencyExponent(currency)
  const [int, frac] = Math.abs(value).toFixed(digits).split(".")
  const grouped = (int ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${currency} ${value < 0 ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`
}

/** "FR" -> "France", as paperwork names a country; the code alone when it cannot be named; null when none. */
export function countryName(iso2: string | null | undefined): string | null {
  const code = (iso2 ?? "").trim().toUpperCase()
  if (!code) return null
  return countryNameEn(code) ?? code
}

// ---------------------------------------------------------------------------
// The order print record
// ---------------------------------------------------------------------------

export interface OrderPrintLine extends PrintLine {
  unit_value_text: string | null
  value_text: string | null
  origin_name: string | null
  attributes: Record<string, string>
}

export interface OrderPrintRecord {
  /** The order's id as the files and rules know it (the goods invoice's document ref). */
  id: string
  /** What a person calls the order: its invoice number, else its order number. */
  label: string | null
  issued_on: string | null
  invoice: { number: string | null; date: string | null; date_text: string | null }
  order: PrintSnapshot["order"] & {
    /** The delivery address as printed lines: company, street, "city, state postal code", country. */
    address_lines: string[]
    po_number: string | null
    incoterm: string | null
  }
  shipment: {
    /** Null until a label is bought. */
    id: string | null
    has_label: boolean
    carrier_name: string | null
    carrier_family: string | null
    tracking_number: string | null
    tracking_label: string
    /** "FedEx AWB 1234" once the carrier issued a number; null before. */
    reference: string | null
    /** The day the label was bought. */
    shipped_on: string | null
  }
  destination: { iso2: string | null; name: string | null }
  currency: string | null
  totals: { value: number | null; value_text: string | null; units: number; articles: number }
  lines: OrderPrintLine[]
}

interface ShipmentRowView {
  id: string | number
  document_ref?: string | null
  kind?: string | null
  offer_code?: string | null
  tracking_number?: string | null
  order_status?: string | null
  queue_facts?: unknown
  created_at?: string | null
  boxtal_order_id?: string | null
}

interface InvoiceView {
  number?: string | null
  issued_at?: string | null
  incoterm?: string | null
  currency?: string | null
  external_refs?: { po_number?: string | null } | null
  po_number?: string | null
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

/** The order's live outbound shipment, the newest when there are several batches. */
async function liveShipmentFor(ctx: BoxtalToolCtx, documentRef: string): Promise<ShipmentRowView | null> {
  const rows = (await ctx.db.findMany("shipment", { where: { document_ref: documentRef }, limit: 50 })) as ShipmentRowView[]
  const live = rows
    .filter((r) => (r.kind ?? "outbound") !== "return" && r.order_status !== "CANCELLED")
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
  return live[0] ?? null
}

async function invoiceFor(ctx: BoxtalToolCtx, documentRef: string): Promise<InvoiceView | null> {
  try {
    const env = await ctx.executeTool("invoicing:documents_get", { id: documentRef })
    return env.status === "completed" ? ((env.result as InvoiceView | null) ?? null) : null
  } catch {
    return null
  }
}

/**
 * The merchant SKU of every line keyed by a store variant id. An invoice line made from a store
 * order carries the variant's id (`gid://shopify/ProductVariant/...`) where the SKU would be, and
 * the product attributes and the document rules are keyed by the merchant's SKU: read through the
 * variant SKU cache, then one `shopify:variants_brief` call for the rest. A variant whose SKU
 * cannot be read keeps its id (logged), never failing the record. `cache` writes what the store
 * answered into the cache (a read-only caller passes false).
 */
async function merchantSkusOf(ctx: BoxtalToolCtx, ids: string[], cache: boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const refs = [...new Set(ids.filter((id) => id.startsWith(SHOPIFY_VARIANT_GID)))].map((id) => ({
    product_source: "shopify",
    product_id: id,
  }))
  if (refs.length === 0) return out
  try {
    const found = await resolveVariantSkus(ctx, refs, { cache })
    for (const r of refs) {
      const sku = found.get(refKey(r))
      if (sku) out.set(r.product_id, sku)
    }
  } catch (err) {
    ctx.logger?.warn?.("order print record: variant SKU lookup failed", { err: String(err) })
  }
  const unresolved = refs.filter((r) => !out.has(r.product_id)).map((r) => r.product_id)
  if (unresolved.length > 0) ctx.logger?.warn?.("order print record: no SKU for these store variants", { variants: unresolved })
  return out
}

/** Product attributes by SKU (kernel), one call for the record's SKUs; empty on any failure. */
async function attributesBySku(ctx: BoxtalToolCtx, skus: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>()
  if (skus.length === 0) return out
  try {
    const env = await ctx.executeTool("kernel:product_attributes_list", { skus })
    if (env.status !== "completed") return out
    const rows =
      (env.result as { attributes?: Array<{ sku?: unknown; key?: unknown; value?: unknown }> } | null)?.attributes ?? []
    for (const a of rows) {
      if (typeof a.sku !== "string" || typeof a.key !== "string" || typeof a.value !== "string") continue
      const attrs = out.get(a.sku) ?? {}
      attrs[a.key] = a.value
      out.set(a.sku, attrs)
    }
  } catch (err) {
    ctx.logger?.warn?.("order print record: product_attributes_list failed", { err: String(err) })
  }
  return out
}

/** The address lines a declaration prints, from the snapshot's parts (nothing invented). */
export function addressLines(order: PrintSnapshot["order"]): string[] {
  const a = order.address
  const cityLine = [a.city, [a.state, a.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ")
  return [order.company, a.street, cityLine || null, countryNameEn(a.country_iso2) ?? a.country_iso2].filter(
    (l): l is string => typeof l === "string" && l.trim() !== "",
  )
}

/**
 * The record a template fills, from its parts (pure). `today` is the issue date printed on the
 * papers; it is NOT part of what makes a document stale (see recordFingerprint).
 */
export function composeOrderRecord(args: {
  documentRef: string
  snapshot: PrintSnapshot
  invoice: InvoiceView | null
  shipment: ShipmentRowView | null
  attributes: Map<string, Record<string, string>>
  today: string
}): OrderPrintRecord {
  const { snapshot, invoice, shipment } = args
  const family = snapshot.carrier_family ?? (shipment ? carrierFamilyOf(shipment.offer_code) : null)
  const carrierName = snapshot.carrier_name ?? CARRIER_BRANDS.find((b) => b.key === family)?.label ?? null
  const tracking = text(shipment?.tracking_number)
  const label = trackingLabelOf(family)
  const currency = snapshot.lines.find((l) => l.currency)?.currency ?? text(invoice?.currency)
  const lines: OrderPrintLine[] = snapshot.lines.map((l) => ({
    ...l,
    unit_value_text: moneyText(l.unit_value, l.currency ?? currency),
    value_text: moneyText(l.value, l.currency ?? currency),
    origin_name: countryName(l.origin),
    attributes: (l.sku ? args.attributes.get(l.sku) : undefined) ?? {},
  }))
  const values = lines.map((l) => l.value)
  const total = values.length > 0 && values.every((v) => v != null) ? values.reduce<number>((n, v) => n + (v ?? 0), 0) : null
  const digits = currency ? currencyExponent(currency) : 2
  const value = total == null ? null : Math.round(total * 10 ** digits) / 10 ** digits
  const iso2 = snapshot.order.address.country_iso2
  const invoiceNumber = snapshot.invoice.number ?? text(invoice?.number)
  const invoiceDate = snapshot.invoice.date ?? text(invoice?.issued_at)
  return {
    id: args.documentRef,
    label: invoiceNumber ?? snapshot.order.name,
    issued_on: dateText(args.today),
    invoice: { number: invoiceNumber, date: invoiceDate, date_text: dateText(invoiceDate) },
    order: {
      ...snapshot.order,
      address_lines: addressLines(snapshot.order),
      po_number: text(invoice?.external_refs?.po_number) ?? text(invoice?.po_number),
      incoterm: text(invoice?.incoterm),
    },
    shipment: {
      id: shipment ? String(shipment.id) : null,
      has_label: shipment != null,
      carrier_name: shipment ? carrierName : null,
      carrier_family: shipment ? family : null,
      tracking_number: tracking,
      tracking_label: label,
      reference: tracking && carrierName ? `${carrierName} ${label} ${tracking}` : null,
      shipped_on: shipment ? dateText(shipment.created_at) : null,
    },
    destination: { iso2, name: countryNameEn(iso2) },
    currency,
    totals: {
      value,
      value_text: moneyText(value, currency),
      units: lines.reduce((n, l) => n + (l.quantity ?? 0), 0),
      articles: lines.length,
    },
    lines,
  }
}

/** `order_print_record_get`: the order's print record (read only). */
/** How the order reads before a label: the virtual draft (a seam for tests). */
export type DraftReader = (ctx: BoxtalToolCtx, documentRef: string) => Promise<OrderDraftView>
export type OrderDraftView = Parameters<typeof buildPrintSnapshot>[0] & {
  recipient_address?: {
    name?: string | null
    company?: string | null
    email?: string | null
    phone?: string | null
    street?: string | null
    city?: string | null
    postalCode?: string | null
    countryIsoCode?: string | null
    state?: string | null
  } | null
  recipient_country?: string | null
}
const readDraft: DraftReader = (ctx, documentRef) => shipmentDraftCreate(ctx, { document_ref: documentRef })

export interface RecordOptions {
  /** The day printed as the issue date (ISO); now when unset. */
  today?: string
  readDraft?: DraftReader
  /** Cache the variant SKUs read from the store (the generation pass; never the read-only tool). */
  cacheVariantSkus?: boolean
}

export async function orderPrintRecordGet(
  ctx: BoxtalToolCtx,
  input: { document_ref?: string },
  opts: RecordOptions = {},
): Promise<OrderPrintRecord | { error: { code: string; message: string } }> {
  const ref = String(input.document_ref ?? "").trim()
  if (!ref) return { error: { code: "invalid_params", message: "document_ref is required (the order's goods invoice)." } }
  const shipment = await liveShipmentFor(ctx, ref)
  let snapshot = shipment ? readPrintSnapshot(shipment.queue_facts) : null
  if (!snapshot) {
    // Before a label (or a row bought before snapshots existed): the goods invoice and the
    // order's ship-to, through the same virtual draft the worklist resolves (same-org reads only).
    try {
      const draft = await (opts.readDraft ?? readDraft)(ctx, ref)
      const r = draft.recipient_address
      const [firstName, ...rest] = (r?.name ?? "").trim().split(/\s+/)
      snapshot = buildPrintSnapshot(draft, {
        offerCode: shipment?.offer_code ?? null,
        customer: r
          ? {
              contact: {
                firstName: firstName || null,
                lastName: rest.join(" ") || null,
                company: r.company ?? null,
                email: r.email ?? null,
                phone: r.phone ?? null,
              },
              location: {
                street: r.street ?? null,
                postalCode: r.postalCode ?? null,
                city: r.city ?? null,
                state: r.state ?? null,
                countryIsoCode: r.countryIsoCode ?? draft.recipient_country ?? null,
              },
            }
          : null,
      })
      if (!shipment) {
        snapshot.carrier_family = null
        snapshot.carrier_name = null
      }
    } catch (err) {
      return {
        error: {
          code: "not_found",
          message: `The order ${ref} could not be read: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
  }
  // A line keyed by a store variant id prints, and matches the rules, as the merchant's SKU.
  const merchant = await merchantSkusOf(
    ctx,
    snapshot.lines.flatMap((l) => (l.sku ? [l.sku] : [])),
    opts.cacheVariantSkus === true,
  )
  if (merchant.size > 0) {
    snapshot = { ...snapshot, lines: snapshot.lines.map((l) => (l.sku && merchant.has(l.sku) ? { ...l, sku: merchant.get(l.sku)! } : l)) }
  }
  const skus = [...new Set(snapshot.lines.map((l) => l.sku).filter((s): s is string => s != null))]
  const [invoice, attributes] = await Promise.all([invoiceFor(ctx, ref), attributesBySku(ctx, skus)])
  return composeOrderRecord({
    documentRef: ref,
    snapshot,
    invoice,
    shipment,
    attributes,
    today: opts.today ?? new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** One generated paper, as kept on the order's row (`prep_state.documents`). */
export interface OrderDocument {
  template_id: string
  template_name: string
  file_id: string
  filename: string
  /** The record's fingerprint when it printed: a change (a tracking number) prints it again. */
  fingerprint: string
  /** The tracking number it printed with, null when it printed before the label. */
  tracking_number: string | null
  generated_at: string
  /** The fields that printed blank (grey), for a person to complete. */
  blanks: string[]
}

/** A stable short hash (FNV-1a, 32 bit, hex) of a string. */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value ?? null)
}

/** What makes a printed paper stale: the record, minus the day it is printed on. */
export function recordFingerprint(record: OrderPrintRecord): string {
  const { issued_on: _today, ...rest } = record
  return fnv1a(stableJson(rest))
}

export function readOrderDocuments(raw: unknown): OrderDocument[] {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter(
    (d): d is OrderDocument =>
      d != null && typeof d === "object" && typeof d.template_id === "string" && typeof d.file_id === "string",
  )
}

export interface GenerateResult {
  document_ref: string
  /** Templates the rules ask for. */
  needed: string[]
  /** Templates printed this pass. */
  printed: string[]
  /** Already up to date. */
  unchanged: string[]
  error?: string
}

interface PrepStateView {
  id: string
  document_ref: string
  documents?: unknown
}

async function prepStateRow(ctx: BoxtalToolCtx, documentRef: string): Promise<PrepStateView> {
  const rows = (await ctx.db.findMany("prep_state", { where: { document_ref: documentRef }, limit: 1 })) as PrepStateView[]
  if (rows[0]) return rows[0]
  // The order's file parent: the row the worklist keeps per order (defaults as prep.ts writes them).
  await ctx.db.insert("prep_state", { document_ref: documentRef, category: "sale", excluded: false })
  const again = (await ctx.db.findMany("prep_state", { where: { document_ref: documentRef }, limit: 1 })) as PrepStateView[]
  if (!again[0]) throw new Error(`no prep_state row for ${documentRef}`)
  return again[0]
}

interface MatchEnvelope {
  matches?: Array<{ recordId?: unknown; templates?: Array<{ id?: unknown; name?: unknown }> }>
}

interface PrintEnvelope {
  files?: Array<{ templateId?: string; templateName?: string; fileId?: string; filename?: string; blanks?: Array<{ label?: string }> }>
}

/**
 * Generate (or bring up to date) the papers the document rules ask for, for each order given.
 * Returns one result per order; never throws.
 */
export async function generateOrderDocuments(
  ctx: BoxtalToolCtx,
  documentRefs: readonly string[],
  opts: RecordOptions = {},
): Promise<GenerateResult[]> {
  const refs = [...new Set(documentRefs.filter((r) => typeof r === "string" && r !== ""))].slice(0, GENERATE_BATCH)
  if (refs.length === 0) return []
  const today = opts.today ?? new Date().toISOString()
  const records = new Map<string, OrderPrintRecord>()
  const results = new Map<string, GenerateResult>()
  for (const ref of refs) {
    try {
      const rec = await orderPrintRecordGet(ctx, { document_ref: ref }, { cacheVariantSkus: true, ...opts, today })
      if ("error" in rec) results.set(ref, { document_ref: ref, needed: [], printed: [], unchanged: [], error: rec.error.message })
      else records.set(ref, rec)
    } catch (err) {
      results.set(ref, { document_ref: ref, needed: [], printed: [], unchanged: [], error: String(err) })
    }
  }
  if (records.size === 0) return refs.map((r) => results.get(r)!)

  // One rules call for the whole batch.
  const needs = new Map<string, Array<{ id: string; name: string }>>()
  try {
    const env = await ctx.executeTool("kernel:document_rules_match", {
      recordType: ORDER_RECORD_TYPE,
      records: [...records.values()].map((r) => ({
        id: r.id,
        skus: [...new Set(r.lines.map((l) => l.sku).filter((s): s is string => s != null))],
        ...(r.destination.iso2 ? { countryIso2: r.destination.iso2 } : {}),
        ...(r.shipment.carrier_family ? { carrier_family: r.shipment.carrier_family } : {}),
      })),
    })
    if (env.status !== "completed") throw new Error(`document_rules_match: ${env.status}`)
    for (const m of (env.result as MatchEnvelope | null)?.matches ?? []) {
      if (typeof m.recordId !== "string") continue
      needs.set(
        m.recordId,
        (m.templates ?? []).flatMap((t) => (typeof t.id === "string" ? [{ id: t.id, name: String(t.name ?? "") }] : [])),
      )
    }
  } catch (err) {
    ctx.logger?.warn?.("order documents: rules match failed", { err: String(err) })
    for (const ref of records.keys())
      results.set(ref, { document_ref: ref, needed: [], printed: [], unchanged: [], error: String(err) })
    return refs.map((r) => results.get(r)!)
  }

  for (const [ref, record] of records) {
    const needed = needs.get(ref) ?? []
    const result: GenerateResult = { document_ref: ref, needed: needed.map((t) => t.id), printed: [], unchanged: [] }
    results.set(ref, result)
    try {
      const row = needed.length > 0 ? await prepStateRow(ctx, ref) : await existingPrepState(ctx, ref)
      if (!row) continue
      const previous = readOrderDocuments(row.documents)
      const fingerprint = recordFingerprint(record)
      const kept = previous.filter((d) => needed.some((t) => t.id === d.template_id))
      const stale = needed.filter((t) => !kept.some((d) => d.template_id === t.id && d.fingerprint === fingerprint))
      result.unchanged = needed.filter((t) => !stale.includes(t)).map((t) => t.id)
      let fresh: OrderDocument[] = []
      if (stale.length > 0) {
        const env = await ctx.executeTool("kernel:documents_print", {
          app: "boxtal",
          entity: "order",
          recordId: ref,
          templateIds: stale.map((t) => t.id),
        })
        if (env.status !== "completed") {
          const message = (env as { error?: { message?: string } }).error?.message ?? env.status
          throw new Error(`documents_print: ${message}`)
        }
        const generatedAt = new Date().toISOString()
        fresh = ((env.result as PrintEnvelope | null)?.files ?? []).flatMap((f) =>
          f.templateId && f.fileId
            ? [
                {
                  template_id: f.templateId,
                  template_name: f.templateName ?? "",
                  file_id: f.fileId,
                  filename: f.filename ?? "",
                  fingerprint,
                  tracking_number: record.shipment.tracking_number,
                  generated_at: generatedAt,
                  blanks: (f.blanks ?? []).map((b) => b.label ?? "").filter((l) => l !== ""),
                },
              ]
            : [],
        )
        result.printed = fresh.map((d) => d.template_id)
      }
      // In the rules' order: the fresh paper replaces the old one of the same template.
      const next = needed.flatMap((t) => {
        const doc = fresh.find((d) => d.template_id === t.id) ?? kept.find((d) => d.template_id === t.id)
        return doc ? [doc] : []
      })
      if (stableJson(next) !== stableJson(previous)) await ctx.db.update("prep_state", row.id, { documents: next })
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err)
      ctx.logger?.warn?.("order documents: generation failed", { document_ref: ref, err: result.error })
    }
  }
  return refs.map((r) => results.get(r)!)
}

async function existingPrepState(ctx: BoxtalToolCtx, documentRef: string): Promise<PrepStateView | null> {
  const rows = (await ctx.db.findMany("prep_state", { where: { document_ref: documentRef }, limit: 1 })) as PrepStateView[]
  return rows[0] ?? null
}

/** The generated papers of the given orders (one read), for the worklist and the print pack. */
export async function orderDocumentsByRef(
  ctx: BoxtalToolCtx,
  documentRefs: readonly string[],
): Promise<Map<string, OrderDocument[]>> {
  const out = new Map<string, OrderDocument[]>()
  const refs = [...new Set(documentRefs.filter((r) => r))]
  for (let i = 0; i < refs.length; i += 1000) {
    const rows = (await ctx.db.findMany("prep_state", {
      where: { document_ref: { in: refs.slice(i, i + 1000) } },
      limit: 1000,
    })) as PrepStateView[]
    for (const r of rows) {
      const docs = readOrderDocuments(r.documents)
      if (docs.length > 0) out.set(r.document_ref, docs)
    }
  }
  return out
}

/** The scheduled pass: every order on To prepare or Ready to ship whose papers may be missing or stale. */
export async function generateOrderDocumentsJobHandler(
  payload: { document_refs?: string[] } | undefined,
  ctx: BoxtalToolCtx,
): Promise<{ orders: number; printed: number; errors: number }> {
  let refs = payload?.document_refs ?? []
  if (refs.length === 0) {
    const { candidates } = await worklistCandidates(ctx, { source: "cache", bestEffortWrites: true })
    const shipments = (await ctx.db.findMany("shipment", { where: { tracking_status: null }, limit: 500 })) as ShipmentRowView[]
    refs = [
      ...candidates.map((c) => c.anchor_ref ?? ""),
      ...shipments.filter((s) => (s.kind ?? "outbound") !== "return").map((s) => s.document_ref ?? ""),
    ]
  }
  const results = await generateOrderDocuments(ctx, refs)
  return {
    orders: results.length,
    printed: results.reduce((n, r) => n + r.printed.length, 0),
    errors: results.filter((r) => r.error).length,
  }
}
