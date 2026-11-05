// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The ONE row shape every Boxtal worklist speaks.
//
// Ready-to-ship, Returns and the stuck queues each grew their own narrow row, so the same parcel
// read differently depending on which list you were standing in: To-prepare knew its cartons, its
// weight, its category and its order, and the moment a label was bought all of that vanished from
// view. The operator could no longer tell a repair from a sale, or a 3 kg parcel from a 30 kg one,
// without going back to the invoice.
//
// These facts are a SNAPSHOT taken when the label is bought, not a live re-resolution:
//
//   * it is what was actually shipped. The invoice can be amended, a shipping profile can be
//     re-measured, a category can be corrected — none of that rewrites a parcel already on a
//     carrier's van, and a queue that silently re-derived those numbers would be lying about
//     what is in the box;
//   * it costs nothing to read. The to-prepare grid pays for resolution because it is deciding
//     what to ship; the post-buy queues are print stations and must stay cheap enough to paint.
//
// Every field is nullable and every consumer renders a dash for null: rows bought before this
// existed carry no snapshot, and that is a permanent, normal state, not an error to repair.
import type { PrepCategory } from "./customs"
import { orderProductsSummary, type ProductCodeConfig } from "./product-codes"
import type { Parcel } from "./resolver"

/** One carton, as measured at buy time (cm, kg) — mirrors `Parcel`, stored verbatim. */
export type QueueParcel = Parcel

export interface QueueFacts {
  /** Who it is going to, as printed on the label. */
  customer: string | null
  /** ISO country of the recipient. */
  destination: string | null
  /** Physical units in the box (goods lines only — shipping and software lines are not things). */
  items: number | null
  /** WHICH items, in the prep grid's own wording ("1xES, 2xET2"). A bare count answers "how many
   *  boxes of something" and leaves the operator opening the invoice to find out what they are
   *  packing, which is precisely the trip this snapshot exists to remove. */
  products: string | null
  /** Total gross weight across every carton, kg. */
  weight: number | null
  /** The cartons themselves, so "3 packages" can be read as the sizes it actually is. */
  parcels: QueueParcel[]
  package_count: number | null
  /** sale / repair / gift / sample — the thing an operator most often needs and could not see. */
  category: PrepCategory | null
  /** Shopify order number (e.g. "#3445"). */
  order_name: string | null
  /** When the customer placed the order. */
  order_created_at: string | null
  /** The Shopify staff note, as it read at buy time. */
  staff_note: string | null
  /** The goods lines' SKUs as they shipped, for the document rules (which templates a parcel
   *  needs). Null on a row bought before they were kept: such a row matches no SKU rule. */
  skus: string[] | null
  /** The carrier family ("fedex", "ups") of the offer bought, for the document rules. */
  carrier_family: string | null
}

/** The empty snapshot: what a row bought before this existed reads as. */
export const EMPTY_QUEUE_FACTS: QueueFacts = {
  customer: null,
  destination: null,
  items: null,
  products: null,
  weight: null,
  parcels: [],
  package_count: null,
  category: null,
  order_name: null,
  order_created_at: null,
  staff_note: null,
  skus: null,
  carrier_family: null,
}

/** The draft fields the snapshot is built from — structurally typed so this module never has to
 *  import shipment.ts (which imports half the app). */
export interface QueueFactsDraftView {
  parcels?: Parcel[] | null
  /** Pre-summarized products ("1xES, 2xET2"), from the SAME summarizeProducts the prep grid uses,
   *  so the two screens word the identical parcel identically. */
  products?: string | null
  recipient?: string | null
  recipient_country?: string | null
  category?: PrepCategory | null
  lineSummaries?: Array<{ line_kind?: string | null; quantity?: number | null; external_id?: string | null }> | null
}

/** The order facts, as cached on `prep_meta`. */
export interface QueueFactsOrderView {
  order_name?: string | null
  order_created_at?: string | null
  staff_note?: string | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Build the snapshot to store on the shipment row at label buy.
 *
 * Goods-only item count: an invoice line for shipping or for a software licence is not a thing in
 * the box, and counting it made a one-unit parcel read as two or three.
 */
export function buildQueueFacts(
  draft: QueueFactsDraftView,
  order: QueueFactsOrderView = {},
  opts: { kind?: "outbound" | "return" | null; carrierFamily?: string | null } = {},
): QueueFacts {
  const parcels = (draft.parcels ?? []).map((p) => ({
    length: p.length,
    width: p.width,
    height: p.height,
    weight: p.weight,
  }))
  const goods = (draft.lineSummaries ?? []).filter(
    (l) => (l.line_kind ?? "goods") === "goods",
  )
  const items = goods.reduce((sum, l) => sum + (l.quantity ?? 0), 0)
  const weight = parcels.reduce((sum, p) => sum + (p.weight ?? 0), 0)
  const skus = [
    ...new Set(
      goods.map((l) => (typeof l.external_id === "string" ? l.external_id.trim() : "")).filter((s) => s !== ""),
    ),
  ]
  return {
    customer: draft.recipient ?? null,
    destination: draft.recipient_country ?? null,
    // Zero items means "we could not tell", not "an empty box": keep it null so the column shows
    // a dash instead of asserting an empty parcel.
    items: items > 0 ? items : null,
    products: draft.products && draft.products !== "-" ? draft.products : null,
    weight: parcels.length > 0 ? round2(weight) : null,
    parcels,
    package_count: parcels.length > 0 ? parcels.length : null,
    // "sale" is the DEFAULT a row carries when nobody set a category, and on an inbound return
    // that default is simply wrong: the Returns queue showed "sale" against two repair returns.
    // We do not know the real category there, so say nothing — the Reason column already does.
    category: opts.kind === "return" && (draft.category ?? "sale") === "sale" ? null : (draft.category ?? null),
    order_name: order.order_name ?? null,
    order_created_at: order.order_created_at ?? null,
    staff_note: order.staff_note ?? null,
    skus: skus.length > 0 ? skus : null,
    carrier_family: opts.carrierFamily ?? null,
  }
}

/**
 * Read the snapshot back off a shipment row. Tolerates every shape the column can hold — absent,
 * null, a JSON string (some drivers hand back text for a json column), or a partial object from
 * an older writer — because a worklist read must never throw on one malformed row.
 */
/** `productCodes` orders the products column by the org's display rank (display only: the snapshot
 *  itself is never rewritten). Omitted keeps the stored order. */
export function readQueueFacts(raw: unknown, productCodes?: ProductCodeConfig): QueueFacts {
  let value = raw
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return { ...EMPTY_QUEUE_FACTS }
    }
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { ...EMPTY_QUEUE_FACTS }
  }
  const v = value as Record<string, unknown>
  const parcels = Array.isArray(v.parcels)
    ? (v.parcels as unknown[]).filter(
        (p): p is QueueParcel =>
          p != null && typeof p === "object" && typeof (p as QueueParcel).weight === "number",
      )
    : []
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null)
  const str = (x: unknown): string | null => (typeof x === "string" && x !== "" ? x : null)
  const products = str(v.products)
  return {
    customer: str(v.customer),
    destination: str(v.destination),
    items: num(v.items),
    products: products && productCodes ? orderProductsSummary(products, productCodes) : products,
    weight: num(v.weight),
    parcels,
    package_count: num(v.package_count) ?? (parcels.length > 0 ? parcels.length : null),
    category: (str(v.category) as PrepCategory | null) ?? null,
    order_name: str(v.order_name),
    order_created_at: str(v.order_created_at),
    staff_note: str(v.staff_note),
    skus: Array.isArray(v.skus)
      ? (v.skus as unknown[]).filter((x): x is string => typeof x === "string" && x !== "")
      : null,
    carrier_family: str(v.carrier_family),
  }
}

/** "30x20x10, 22x22x12" — the carton sizes, for the one cell that shows them. Empty when unknown. */
export function formatParcelDims(parcels: QueueParcel[]): string {
  return parcels.map((p) => `${p.length}x${p.width}x${p.height}`).join(", ")
}
