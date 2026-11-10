// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shipment as a PRINT RECORD: the JSON the kernel's document templates fill
// (manifest `entities.shipment.print`, tool `print_record_get`). A customs
// declaration, a certificate or a thank-you letter maps its fields to paths in
// this record (`order.customer`, `lines.0.hts`, `shipment.tracking_number`).
//
// Where every value comes from:
//   * the label buy writes a snapshot onto the row (`queue_facts.print`, built
//     here by buildPrintSnapshot): the invoice number and date, the customer and
//     the address the label was printed for, the carrier, and the goods lines
//     with their SKU, HS code, origin and value. What was in the box when it
//     was bought, so an invoice amended later does not rewrite a certificate
//     for a parcel already shipped (the same rule as queue-facts.ts);
//   * the tracking number is read off the row as it is NOW: carriers that
//     issue it at first scan fill it in after the buy;
//   * line `attributes` are the kernel's product attributes for the SKU, read
//     at print time (they are product facts, not shipment facts).
//
// Nothing is ever derived or defaulted: a value the sources do not hold is
// null (or an empty list), and the template prints it as a visible grey blank.
// A row bought before the snapshot existed therefore prints its invoice,
// customer and lines as blanks, which is the safe failure.
import { CARRIER_BRANDS, carrierBrandOf } from "./carriers"
import { countryEnglishName } from "./country-names"
import type { BoxtalToolCtx } from "./ctx"
import { currencyExponent } from "./money"

/** The carrier family ("fedex", "ups", ...) of a Boxtal offer code ("FEDX-InternationalEconomy"). */
export function carrierFamilyOf(offerCode: string | null | undefined, carrierLabel?: string | null): string | null {
  const code = (offerCode ?? "").trim()
  if (!code && !carrierLabel) return null
  return carrierBrandOf({ carrier_code: code.split("-")[0] ?? "", carrier: carrierLabel ?? "" })
}

/** What the carrier calls its tracking number on paperwork: an air waybill for FedEx. */
export function trackingLabelOf(family: string | null): string {
  return family === "fedex" ? "AWB" : "Tracking number"
}

/** One goods line as it shipped. */
export interface PrintLine {
  description: string | null
  sku: string | null
  hts: string | null
  origin: string | null
  quantity: number | null
  /** Line total (unit price times quantity), net, in the invoice currency. */
  value: number | null
  unit_value: number | null
  currency: string | null
}

/** The buy-time snapshot stored on the row under `queue_facts.print`. */
export interface PrintSnapshot {
  invoice: { number: string | null; date: string | null }
  order: {
    name: string | null
    customer: string | null
    company: string | null
    email: string | null
    phone: string | null
    address: {
      street: string | null
      postal_code: string | null
      city: string | null
      state: string | null
      country_iso2: string | null
    }
  }
  carrier_name: string | null
  carrier_family: string | null
  lines: PrintLine[]
}

/** The draft fields the snapshot is built from (structural, so this never imports shipment.ts). */
export interface PrintSnapshotDraftView {
  document_number?: string | null
  invoice_issued_at?: string | null
  order_name?: string | null
  lineSummaries?: Array<{
    line_id?: string | null
    external_id?: string | null
    description?: string | null
    line_kind?: string | null
    quantity?: number | null
    unit_price_minor?: number | null
    currency?: string | null
    hs_code?: string | null
    country_of_origin?: string | null
  }> | null
  /** The customs articles as declared (operator edits included), keyed by invoice line. */
  customsArticles?: Array<{
    line_id: string
    tariffNumber?: string | null
    originCountry?: string | null
  }> | null
}

/** The customer's side of the label (the Boxtal body's counterparty address). */
export interface PrintSnapshotAddress {
  contact?: {
    firstName?: string | null
    lastName?: string | null
    company?: string | null
    email?: string | null
    phone?: string | null
  } | null
  location?: {
    street?: string | null
    postalCode?: string | null
    city?: string | null
    state?: string | null
    countryIsoCode?: string | null
  } | null
}

function text(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function fromMinor(minor: number | null, currency: string | null): number | null {
  if (minor == null || !currency) return null
  const exp = currencyExponent(currency)
  return round(minor / 10 ** exp, exp)
}

/**
 * The print snapshot to store at label buy. Goods lines only (a shipping or a
 * software line is not in the box); the HS code and origin are the declared
 * customs article's when the route has a declaration, else the invoice line's.
 */
export function buildPrintSnapshot(
  draft: PrintSnapshotDraftView,
  opts: { offerCode?: string | null; carrierName?: string | null; customer?: PrintSnapshotAddress | null },
): PrintSnapshot {
  const articles = new Map((draft.customsArticles ?? []).map((a) => [a.line_id, a]))
  const lines: PrintLine[] = (draft.lineSummaries ?? [])
    .filter((l) => (l.line_kind ?? "goods") === "goods")
    .map((l) => {
      const article = l.line_id ? articles.get(l.line_id) : undefined
      const quantity = finite(l.quantity)
      const currency = text(l.currency)
      const unit = fromMinor(finite(l.unit_price_minor), currency)
      return {
        description: text(l.description),
        sku: text(l.external_id),
        hts: text(article?.tariffNumber) ?? text(l.hs_code),
        origin: text(article?.originCountry) ?? text(l.country_of_origin),
        quantity,
        value: unit != null && quantity != null ? round(unit * quantity, currency ? currencyExponent(currency) : 2) : null,
        unit_value: unit,
        currency,
      }
    })
  const contact = opts.customer?.contact ?? null
  const location = opts.customer?.location ?? null
  const name = [text(contact?.firstName), text(contact?.lastName)].filter((p): p is string => p != null).join(" ")
  const family = carrierFamilyOf(opts.offerCode, opts.carrierName)
  return {
    invoice: { number: text(draft.document_number), date: text(draft.invoice_issued_at) },
    order: {
      name: text(draft.order_name),
      customer: text(name),
      company: text(contact?.company),
      email: text(contact?.email),
      phone: text(contact?.phone),
      address: {
        street: text(location?.street),
        postal_code: text(location?.postalCode),
        city: text(location?.city),
        state: text(location?.state),
        country_iso2: text(location?.countryIsoCode)?.toUpperCase() ?? null,
      },
    },
    carrier_name: text(opts.carrierName) ?? CARRIER_BRANDS.find((b) => b.key === family)?.label ?? null,
    carrier_family: family,
    lines,
  }
}

function asObject(raw: unknown): Record<string, unknown> | null {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The snapshot read back off `queue_facts`; null for a row bought before it existed. */
export function readPrintSnapshot(queueFacts: unknown): PrintSnapshot | null {
  const facts = asObject(queueFacts)
  const p = asObject(facts?.print)
  if (!p) return null
  const invoice = asObject(p.invoice) ?? {}
  const order = asObject(p.order) ?? {}
  const address = asObject(order.address) ?? {}
  const lines = Array.isArray(p.lines) ? p.lines : []
  return {
    invoice: { number: text(invoice.number), date: text(invoice.date) },
    order: {
      name: text(order.name),
      customer: text(order.customer),
      company: text(order.company),
      email: text(order.email),
      phone: text(order.phone),
      address: {
        street: text(address.street),
        postal_code: text(address.postal_code),
        city: text(address.city),
        state: text(address.state),
        country_iso2: text(address.country_iso2),
      },
    },
    carrier_name: text(p.carrier_name),
    carrier_family: text(p.carrier_family),
    lines: lines
      .map((l) => asObject(l))
      .filter((l): l is Record<string, unknown> => l != null)
      .map((l) => ({
        description: text(l.description),
        sku: text(l.sku),
        hts: text(l.hts),
        origin: text(l.origin),
        quantity: finite(l.quantity),
        value: finite(l.value),
        unit_value: finite(l.unit_value),
        currency: text(l.currency),
      })),
  }
}

/** "US" -> "United States", in English (paperwork language); null when the runtime cannot name it. */
export function countryNameEn(iso2: string | null): string | null {
  if (!iso2 || !/^[A-Z]{2}$/.test(iso2)) return null
  // The static table first: the app's sandbox has no `Intl`, so in production `Intl.DisplayNames`
  // throws and every country printed as its bare code. `Intl` only names a code the table lacks.
  const listed = countryEnglishName(iso2)
  if (listed) return listed
  try {
    // Some ICU builds name CN "China mainland"; paperwork names the country.
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(iso2)?.replace(/ mainland$/, "")
    return name && name !== iso2 ? name : null
  } catch {
    return null
  }
}

/** The record the templates fill. */
export interface PrintRecord {
  invoice: { number: string | null; date: string | null }
  order: PrintSnapshot["order"]
  shipment: {
    id: string
    carrier_name: string | null
    carrier_family: string | null
    /** Null until the carrier has issued one: never derived from anything else. */
    tracking_number: string | null
    tracking_label: string
  }
  destination: { iso2: string | null; name: string | null }
  lines: Array<PrintLine & { attributes: Record<string, string> }>
}

interface PrintRowView {
  id: string | number
  offer_code?: string | null
  tracking_number?: string | null
  queue_facts?: unknown
}

/** Product attributes by SKU (kernel), one call for the record's SKUs; empty on any failure. */
async function attributesBySku(ctx: BoxtalToolCtx, skus: string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>()
  if (skus.length === 0) return out
  try {
    const env = await ctx.executeTool("kernel:product_attributes_list", { skus })
    if (env.status !== "completed") return out
    const rows = (env.result as { attributes?: Array<{ sku?: unknown; key?: unknown; value?: unknown }> } | null)?.attributes ?? []
    for (const a of rows) {
      if (typeof a.sku !== "string" || typeof a.key !== "string" || typeof a.value !== "string") continue
      const attrs = out.get(a.sku) ?? {}
      attrs[a.key] = a.value
      out.set(a.sku, attrs)
    }
  } catch (err) {
    ctx.logger?.warn?.("print record: product_attributes_list failed", { err: String(err) })
  }
  return out
}

/** `print_record_get`: the shipment's print record (read only). */
export async function printRecordGet(
  ctx: BoxtalToolCtx,
  input: { shipment_id?: string },
): Promise<PrintRecord | { error: { code: string; message: string } }> {
  const id = String(input.shipment_id ?? "").trim()
  if (!id) return { error: { code: "invalid_params", message: "shipment_id is required (a shipment row id)." } }
  const rows = (await ctx.db.findMany("shipment", { where: { id }, limit: 1 })) as PrintRowView[]
  const row = rows[0]
  if (!row) return { error: { code: "not_found", message: `No shipment row matches "${id}".` } }

  const snapshot = readPrintSnapshot(row.queue_facts)
  // The offer code never changes on a row, so the family read from it is the buy-time one.
  const family = snapshot?.carrier_family ?? carrierFamilyOf(row.offer_code)
  const lines = snapshot?.lines ?? []
  const skus = [...new Set(lines.map((l) => l.sku).filter((s): s is string => s != null))]
  const attrs = await attributesBySku(ctx, skus)
  const iso2 = snapshot?.order.address.country_iso2 ?? null
  const tracking = text(row.tracking_number)
  return {
    invoice: snapshot?.invoice ?? { number: null, date: null },
    order: snapshot?.order ?? {
      name: null,
      customer: null,
      company: null,
      email: null,
      phone: null,
      address: { street: null, postal_code: null, city: null, state: null, country_iso2: null },
    },
    shipment: {
      id: String(row.id),
      carrier_name: snapshot?.carrier_name ?? CARRIER_BRANDS.find((b) => b.key === family)?.label ?? null,
      carrier_family: family,
      tracking_number: tracking,
      tracking_label: trackingLabelOf(family),
    },
    destination: { iso2, name: countryNameEn(iso2) },
    lines: lines.map((l) => ({ ...l, attributes: (l.sku ? attrs.get(l.sku) : undefined) ?? {} })),
  }
}
