// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Operational-queue read tools backing the BoxtalSidebar badges + the queue
// views (the redesigned UI). All four are READ-only and derive from data that
// already exists:
//
//   ready_list      — live (PENDING/CONFIRMED) outbound shipments with their
//                     label bought, for the operator print station.
//   returns_list    — inbound return shipments (`kind='return'`).
//   to_prepare_list — EVERY open unfulfilled Shopify order (minus the excluded
//                     ones), joined to its anchor document when it has one:
//                     `worklistCandidates` over `openOrdersScan` (orders.ts).
//                     The pre-rework version enumerated issued invoices, which
//                     made an order with no invoice structurally invisible
//                     (ticket-10224). Rows are classified ready / needs-fix by
//                     re-using the draft resolver (`shipmentDraftCreate`).
//   queue_counts    — badge counts for the three queues. `ready`/`returns` are
//                     cheap local counts; `to_prepare` counts the same order
//                     candidates the list derives from.
//
// A row with no anchor document is NOT silently dropped: it surfaces with the
// reason it cannot ship yet (`noAnchorReason`), because a real order nobody has
// invoiced is exactly the work the queue exists to make visible.
import type { BoxtalToolCtx } from "./ctx"
import { documentNumbersById } from "./document-numbers"
import {
  coverageMovedSince,
  isDraftCacheStale,
  loadDraftCache,
  resolveDrafts,
  RESOLVE_CONCURRENCY,
  type DraftCacheRow,
} from "./draft-cache"
import {
  excludedOrderKeys,
  loadOrderStates,
  orderKeyForShopifyOrder,
  parseOrderKey,
  type PrepStatus,
} from "./order-state"
import { readQueueFacts, type QueueFacts } from "./queue-facts"
import { evaluateAttention, mergeTemplateNeed, type AttentionMark } from "./attention"
import { loadTemplateNeeds } from "./needed-documents"
import { ORDER_RECORD_TYPE, orderDocumentsByRef, type OrderDocument } from "./customs-documents"
import { carrierFamilyOf } from "./print-record"
import { loadAttentionRules } from "./attention-store"
import { loadProductCodeConfig } from "./settings"
import { isLiveShipment, isOperatorVisibleRef, isStaleReservation, UNFINISHED_LINK_STATES } from "./link-store"
import { openOrdersScan, type OpenOrdersScan, type OrderCandidate } from "./orders"


// ── Row shapes (mirror the UI's expected props) ──────────────────────────────
//
// EVERY worklist row carries the SAME buy-time snapshot (queue-facts.ts) on top of its own
// queue-specific fields: cartons and their sizes, weight, unit count, category, order number and
// date, staff note. Before this, each queue exposed a different subset and the same parcel read
// differently depending on which list you were standing in.
export interface ReadyRow extends QueueFacts {
  id: string
  recipient: string
  carrier: string | null
  tracking_number: string | null
  cost: number | null
  order_status: string | null
  has_label: boolean
  invoice_ref: string | null
  /** When the CUSTOMER placed the order (from the `prep_meta` sync cache, keyed by the
   *  shipment's anchor document). Null when this shipment's document was never synced —
   *  the print station shows a dash, rather than being given the label-purchase date
   *  dressed up as an order date. */
  order_created_at: string | null
  /** When the LABEL WAS REQUESTED from Boxtal (this shipment row's creation). This is the
   *  queue's SORT KEY: it is the same date and time Boxtal's own shipment list shows, so the
   *  print station's order matches the carrier-side list the operator cross-checks against,
   *  and unlike the order date it is local, always present and never waits on a sync. */
  requested_at: string | null
  /** Extra paperwork this parcel needs (customs declarations and the like), or null. The mark
   *  says what is NEEDED, never that it has been produced. */
  attention: AttentionMark | null
  /** The kernel document templates this parcel needs (document rules), for the Print documents
   *  control: pre-ticked and badged. Empty when none. */
  needed_template_ids: string[]
  /** The papers the organisation's document rules asked for on this parcel's ORDER, generated
   *  on their own (customs-documents.ts): one PDF per template, newest print. They go into the
   *  print pack with the invoice and the label. Empty when none. */
  documents: OrderDocument[]
  /** The operator's status on the underlying order (to_prepare / validated / on_hold), so the
   *  row tint is the same rule on every Boxtal screen. Null when the order carries no state row. */
  status: PrepStatus | null
  /** Boxtal's own shipment reference (their list and their label filenames use it). Present from
   *  the moment the label exists, unlike `tracking_number`, which only appears once the carrier
   *  acknowledges the parcel — for some services that is hours later, and an operator staring at
   *  an empty Tracking cell has no way to match the row to Boxtal's list in the meantime. */
  shipment_ref: string | null
  /** The warehouse bench mark: the parcel is boxed, taped and waiting for the carrier pickup
   *  (ready_set_packed). Packed is NOT shipped: the box is still in the warehouse. */
  packed: boolean
  /** WHEN it was packed, so the mark keeps its history. Null while the row is still to do. */
  packed_at: string | null
  /** The Shopify fulfillment of this parcel: fulfilled, pending_approval, failed, cancelled, or
   *  null when none was attempted yet. A failure carries its reason in `fulfillment_error`. */
  fulfillment_state: string | null
  fulfillment_error: string | null
  /** No tracking number yet and the label read gave none we could accept (label-tracking.ts):
   *  the row says "tracking to confirm". */
  tracking_to_confirm: boolean
}
export interface ReturnRow extends QueueFacts {
  id: string
  /** When the label was requested from Boxtal — the sort key every queue shares. */
  requested_at: string | null
  customer: string
  reason: string | null
  proforma_ref: string | null
  /** The proforma's number, what the Returns list shows; null when it could not be resolved. */
  proforma_number: string | null
  order_status: string | null
  tracking_status: string | null
  label_ready: boolean
  created_by: "agent" | "user"
}
/**
 * Prep state of a to-prepare row. DELIBERATELY a string, NOT a `ready:boolean`:
 * an agent reads `ready:true` as "this shipment is already staged/ready to go"
 * and narrates a staged shipment with no matching gated create_shipment call
 * (fabrication). `prep_status` names the real meaning — the INVOICE is ready to
 * be turned INTO a draft, the draft has NOT been quoted/staged/shipped:
 *   - "ready_to_prepare" — the invoice resolves cleanly; you can open a draft and
 *     stage a (gated) shipment. NOTHING is staged yet — this is a worklist hint.
 *   - "needs_fix" — a blocking defect (`reason`) must be cleared before drafting.
 */
export type ToPrepareStatus = "ready_to_prepare" | "needs_fix"

/** The buy-time ship-to country on a row's snapshot (`to_country`), or null when it has none.
 *  `destination` is the invoice counterparty's country, which can differ from where the parcel goes. */
function shipToCountry(raw: unknown): string | null {
  let o: unknown = raw
  if (typeof raw === "string") {
    try {
      o = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const v = o && typeof o === "object" ? (o as Record<string, unknown>).to_country : null
  return typeof v === "string" && v ? v : null
}

export interface ToPrepareRow {
  /** The ANCHOR document id, i.e. the `draft_id` for the downstream draft tools. NULL when the row
   *  has no shipping document yet (an order with no invoice is still a row: it is real work). */
  id: string | null
  /** The row identity: `so:<shopify order id>`, or `doc:`/`pending:` for an order-less row. */
  order_key: string
  invoice_ref: string
  customer: string
  destination: string
  items: number
  weight: number | null
  /** Worklist state of the INVOICE (see {@link ToPrepareStatus}). "ready_to_prepare"
   *  means "a draft can be opened", NOT "a shipment is staged/ready to ship". */
  prep_status: ToPrepareStatus
  reason?: string
  /** True when one or more PARTIAL batches are live for this invoice but units remain. */
  partially_shipped?: boolean
  /** Units still without a live batch (summed across lines), present when partially_shipped. */
  remaining_units?: number
}

/**
 * The full `to_prepare_list` result: a server-side AUTHORITATIVE partition of the whole
 * to-prepare worklist, NOT a bounded sample. `rows` is the complete list (kept for
 * back-compat); `ready_to_prepare` + `needs_fix` are the SAME rows already split by
 * `prep_status` so the caller RENDERS the server's partition verbatim instead of
 * re-deriving it in-context — and the counts (`total`/`ready_count`/`needs_fix_count`)
 * are the denominators so a long worklist can never be guessed past (the anti-fabrication
 * surface: the agent must enumerate the real `ready_to_prepare[].invoice_ref` values, never
 * invent invoice references to fill a count it could not read — the journey-16 fabrication
 * root). Every invoice that has a shippable physical line + no live shipment is in EXACTLY
 * one bucket; the buckets are disjoint and cover `total`.
 */
export interface ToPrepareList {
  /** The complete worklist (back-compat; equals `ready_to_prepare` ∪ `needs_fix`). */
  rows: ToPrepareRow[]
  /** Total invoices on the to-prepare worklist (= rows.length). The denominator. */
  total: number
  /** How many of `total` are `ready_to_prepare` (= ready_to_prepare.length). */
  ready_count: number
  /** How many of `total` are `needs_fix` (= needs_fix.length). */
  needs_fix_count: number
  /** The `ready_to_prepare` rows ONLY — render these as the trustworthy "ready to pack" list
   *  (every `invoice_ref` here is real + draftable). */
  ready_to_prepare: ToPrepareRow[]
  /** The `needs_fix` rows ONLY — each carries its blocking `reason`. Strictly disjoint from
   *  `ready_to_prepare` (a row is NEVER in both). */
  needs_fix: ToPrepareRow[]
}
export interface QueueCounts {
  to_prepare: number
  ready: number
  returns: number
  /** Count of shipments in a carrier EXCEPTION/INCIDENT/RETURNED/LOST state (the stuck parcels the
   *  authoritative exceptions_list returns). Surfaced on the queue badge so a "what's stuck in
   *  shipping" / business-pulse read off queue_counts cannot mistake an empty prep queue for a clean
   *  exceptions check — a non-zero `exceptions` means a stuck parcel exists and the caller must
   *  exceptions_list/track to surface it (queue_counts is a badge, exceptions_list is the breakdown). */
  exceptions: number
  /** The four counts as rows (`key` = the queue, `value` = its count): the list a dashboard
   *  block charts. */
  rows: Array<{ key: "to_prepare" | "ready" | "returns" | "exceptions"; value: number }>
}

// Local view of a `shipment` row (the columns these reads touch).
interface ShipmentRow {
  id: string | number
  external_id?: string | null
  boxtal_order_id?: string | null
  order_status?: string | null
  tracking_status?: string | null
  offer_code?: string | null
  tracking_number?: string | null
  boxtal_shipment_ref?: string | null
  declared_total?: number | string | null
  label_cost_ttc?: number | string | null
  recipient_summary?: string | null
  document_ref?: string | null
  documents?: Array<{ type?: string; format?: string }> | null
  kind?: string | null
  return_reason?: string | null
  created_by?: string | null
  /** The buy-time snapshot (queue-facts.ts), read back onto every worklist row. */
  queue_facts?: unknown
  /** Framework-managed system column (stamped DEFAULT NOW() on insert) — for a shipment row
   *  that is the moment the LABEL WAS REQUESTED from Boxtal. */
  created_at?: string | null
  /** When the packer boxed this parcel (ready_set_packed). Null while it is still to do. */
  packed_at?: string | null
  /** create_in_flight | created | create_uncertain | create_abandoned — see link-store.ts. */
  link_state?: string | null
  fulfillment_synced?: boolean | null
  fulfillment_state?: string | null
  fulfillment_error?: string | null
  tracking_to_confirm?: boolean | null
}

function asNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The ONLY tracking states in which a parcel is still PHYSICALLY IN THE
 * WAREHOUSE, and therefore still the print station's work:
 *   - `null`      — no carrier event yet (label just bought, or never announced)
 *   - ANNOUNCED   — the carrier has been notified but has NOT collected it yet;
 *                   the box is still on the bench waiting for the round.
 *
 * Every other state (IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, FAILED_ATTEMPT,
 * REACHED_DELIVERY_PICKUP_POINT, EXCEPTION, RETURNED, LOST, …) means the carrier
 * has TAKEN POSSESSION — there is nothing left to pack, so the row leaves this
 * queue. An UNKNOWN/new status string also removes the row: a carrier only starts
 * reporting once it has the parcel, so "some status we do not model yet" is far
 * likelier to mean handed-over than sitting-on-the-bench.
 *
 * Why this gate exists: `order_status` is Boxtal's ORDER lifecycle (PENDING →
 * CONFIRMED → CANCELLED), NOT the parcel's journey. It never advances once the
 * order is confirmed, so filtering on it alone kept DELIVERED parcels in
 * "Ready to ship" forever — the queue grew monotonically and the operator lost
 * all trust in it. The two axes are independent and both must be consulted.
 */
const IN_WAREHOUSE_TRACKING: ReadonlySet<string> = new Set(["ANNOUNCED"])

/**
 * Read EVERY shipment row matching `where`, paged on a stable key.
 *
 * The queues used to read `orderBy: { id: "desc" }, limit: 100`. Shipment ids are random UUIDs, so
 * that window was an arbitrary sample of the whole table, not "the latest 100": once the table
 * passed 100 rows, live parcels fell out of Ready to ship (and the exception and stuck lists) at
 * random, and the operator had no way to tell a missing row from a finished one. A queue is now
 * bounded by its STATE (the `where`), read completely, and ordered by request time.
 */
export const SHIPMENT_PAGE = 500
/** Hard stop on a runaway read: far above any real queue, low enough to fail loudly in the log. */
const SHIPMENT_MAX_PAGES = 40

export async function findAllShipments(
  ctx: BoxtalToolCtx,
  where: Record<string, unknown>,
): Promise<ShipmentRow[]> {
  const out: ShipmentRow[] = []
  for (let page = 0; page < SHIPMENT_MAX_PAGES; page++) {
    const rows = (await ctx.db.findMany("shipment", {
      where,
      // id breaks ties so a page boundary never skips or repeats a row stamped in the same instant.
      orderBy: { createdAt: "asc", id: "asc" },
      limit: SHIPMENT_PAGE,
      offset: page * SHIPMENT_PAGE,
    })) as ShipmentRow[]
    out.push(...rows)
    if (rows.length < SHIPMENT_PAGE) return out
  }
  ctx.logger?.warn?.("shipment queue read hit its page ceiling", { where, rows: out.length })
  return out
}

/** Union of several state-bounded reads, each row once (a row can match two of them). */
export async function findShipmentsInAny(
  ctx: BoxtalToolCtx,
  wheres: Array<Record<string, unknown>>,
): Promise<ShipmentRow[]> {
  const pages = await Promise.all(wheres.map((w) => findAllShipments(ctx, w)))
  const seen = new Set<string>()
  const out: ShipmentRow[] = []
  for (const rows of pages) {
    for (const r of rows) {
      const id = String(r.id)
      if (seen.has(id)) continue
      seen.add(id)
      out.push(r)
    }
  }
  return out
}

function isStillInWarehouse(trackingStatus: string | null | undefined): boolean {
  if (trackingStatus == null || trackingStatus === "") return true
  return IN_WAREHOUSE_TRACKING.has(trackingStatus)
}

/**
 * "The label is ready" — ONE definition, used by the print queue, the returns list and the prep
 * grid's Label button. Boxtal generates the label asynchronously, so a CONFIRMED order does NOT
 * imply a label exists; only a LABEL document does. The returns list used to answer this with
 * `order_status === "CONFIRMED"`, which lit up a Label button for a shipment with no label behind it.
 */
export function shipmentHasLabel(row: { documents?: Array<{ type?: string }> | null }): boolean {
  return Array.isArray(row.documents) && row.documents.some((d) => d?.type === "LABEL")
}

/** The live outbound shipment covering each anchor document, for the prep grid's shipment cell. */
export async function liveShipmentsByAnchor(
  ctx: BoxtalToolCtx,
): Promise<Map<string, {
  id: string
  has_label: boolean
  tracking_number: string | null
  order_status: string | null
  created_at: string | null
}>> {
  const rows = await findAllShipments(ctx, {})
  const out = new Map<string, {
    id: string
    has_label: boolean
    tracking_number: string | null
    order_status: string | null
    created_at: string | null
  }>()
  for (const r of rows) {
    if (r.kind === "return") continue
    if (!isLiveShipment(r)) continue
    if (!r.document_ref) continue
    const view = {
      id: String(r.id),
      has_label: shipmentHasLabel(r),
      tracking_number: r.tracking_number ?? null,
      order_status: r.order_status ?? null,
      created_at: r.created_at ?? null,
    }
    // A row with a label wins over one without: the operator needs the printable one.
    const existing = out.get(r.document_ref)
    if (!existing || (!existing.has_label && view.has_label)) out.set(r.document_ref, view)
  }
  return out
}

// ── ready_list ───────────────────────────────────────────────────────────────
/**
 * Boxtal's ORDER lifecycle states in which a bought shipment is still OURS to pack:
 * PENDING -> REQUESTED -> CONFIRMED. Only CANCELLED leaves.
 *
 * REQUESTED was missing here until 2026-09-14 and that HID LIVE WORK: a shipment sitting at
 * REQUESTED is also absent from the To-prepare worklist (which subtracts every non-CANCELLED
 * live shipment), so those orders were in NEITHER queue and simply vanished from the print
 * station. Five real orders were invisible when it was found (#3434, #3438, #3439, #3443,
 * #3445). The rule is "not CANCELLED", never an allow-list of two of the three live states.
 */
const LIVE_ORDER_STATES: ReadonlySet<string> = new Set(["PENDING", "REQUESTED", "CONFIRMED"])

export async function readyList(ctx: BoxtalToolCtx): Promise<{ rows: ReadyRow[] }> {
  // A freshly bought label sits at order_status PENDING (then REQUESTED) until Boxtal confirms
  // the order, so the print-station queue must include every live state, not just CONFIRMED —
  // the operator prints and packs off the label, not off Boxtal's confirmation.
  const [rows, attentionRules, productCodes] = await Promise.all([
    // Bounded by STATE, read completely: a live order whose parcel the carrier has not taken yet.
    // Two reads because SQL cannot put NULL in an IN list; an empty string is kept for rows written
    // before the column carried an enum.
    findShipmentsInAny(ctx, [
      { order_status: { in: [...LIVE_ORDER_STATES] }, tracking_status: null },
      { order_status: { in: [...LIVE_ORDER_STATES] }, tracking_status: { in: [...IN_WAREHOUSE_TRACKING, ""] } },
    ]),
    loadAttentionRules(ctx),
    loadProductCodeConfig(ctx),
  ])
  // The order facts for exactly these rows (not the first 1000 of a table that grows per order).
  const orderFacts = await orderFactsByDocumentRef(
    ctx,
    rows.map((r) => r.document_ref).filter((d): d is string => typeof d === "string" && d !== ""),
  )
  const live = rows
    .filter((r) => r.kind !== "return")
    .filter((r) => LIVE_ORDER_STATES.has(r.order_status ?? ""))
    // Second axis: drop anything the carrier already has (see IN_WAREHOUSE_TRACKING).
    .filter((r) => isStillInWarehouse(r.tracking_status))
    .map((r) => ({ r, facts: readQueueFacts(r.queue_facts, productCodes) }))
  // The templates the kernel's document rules ask for, for the whole list in ONE call. The carrier
  // family falls back to the row's offer code, which never changes after the buy.
  const needs = await loadTemplateNeeds(
    ctx,
    live.map(({ r, facts }) => ({
      id: String(r.id),
      skus: facts.skus,
      // The country the PARCEL ships to (frozen at buy time), not the billed counterparty's.
      countryIso2: shipToCountry(r.queue_facts) ?? facts.destination,
      carrier_family: facts.carrier_family ?? carrierFamilyOf(r.offer_code),
    })),
  )
  // The ORDER's document rules (record type boxtal:order: the papers generated at To prepare and
  // again after the buy), folded into the same mark, and the papers already generated.
  const orderNeeds = await loadTemplateNeeds(
    ctx,
    live
      .filter(({ r }) => typeof r.document_ref === "string" && r.document_ref !== "")
      .map(({ r, facts }) => ({
        id: String(r.document_ref),
        skus: facts.skus,
        countryIso2: shipToCountry(r.queue_facts) ?? facts.destination,
        carrier_family: facts.carrier_family ?? carrierFamilyOf(r.offer_code),
      })),
    ORDER_RECORD_TYPE,
  )
  const orderDocs = await orderDocumentsByRef(
    ctx,
    live.map(({ r }) => r.document_ref ?? "").filter((d) => d !== ""),
  ).catch(() => new Map<string, OrderDocument[]>())
  const out = live
    .map(({ r, facts }) => {
      const shipmentNeed = needs.get(String(r.id))
      const orderNeed = r.document_ref ? orderNeeds.get(r.document_ref) : undefined
      const need =
        shipmentNeed || orderNeed
          ? {
              rules: [...(shipmentNeed?.rules ?? []), ...(orderNeed?.rules ?? [])],
              templates: [...(shipmentNeed?.templates ?? []), ...(orderNeed?.templates ?? [])],
            }
          : undefined
      return {
      // The buy-time snapshot first, so a row's own fields still win where the names meet.
      ...facts,
      id: String(r.id),
      recipient: r.recipient_summary ?? "-",
      carrier: r.offer_code ?? null,
      tracking_number: r.tracking_number ?? null,
      // The CARRIER label cost (what shipping the parcel costs us), not the
      // customs declared value — showing declared_total here misled operators
      // (a 899 EUR "cost" for a 9 EUR label). Null for rows bought before the
      // field existed.
      cost: asNumber(r.label_cost_ttc),
      order_status: r.order_status ?? null,
      has_label: shipmentHasLabel(r),
      invoice_ref: r.document_ref ?? null,
      order_created_at: (r.document_ref ? orderFacts.get(r.document_ref)?.order_created_at : null) ?? null,
      // The operator's own status on this order, so the WHOLE ROW can carry it here exactly as it
      // does on the prep grid: a parcel put on hold must not look ordinary in the print queue.
      status: (r.document_ref ? orderFacts.get(r.document_ref)?.status : null) ?? null,
      requested_at: r.created_at ?? null,
      // Only a reference an operator can actually look up in Boxtal. 0.13.16 briefly stored their
      // internal numeric id, and rendering that beside a tracking number invites reading it AS one.
      shipment_ref: isOperatorVisibleRef(r.boxtal_shipment_ref) ? (r.boxtal_shipment_ref as string) : null,
      tracking_to_confirm: !r.tracking_number && r.tracking_to_confirm === true,
      // The bench mark. A timestamp on the row, so "packed" is simply "stamped" and the moment it
      // happened survives; the queue's ORDER is untouched by it (a packed row keeps its place).
      packed: r.packed_at != null,
      packed_at: r.packed_at ?? null,
      // Rows fulfilled before the state column existed carry only the old flag.
      fulfillment_state: r.fulfillment_state ?? (r.fulfillment_synced ? "fulfilled" : null),
      fulfillment_error: r.fulfillment_error ?? null,
      // Paperwork this destination/product combination needs that nothing else on the row would
      // reveal (attention.ts). Evaluated from the row's OWN facts, so it costs no extra read.
      // The kernel document rules' templates fold into the SAME mark (one marker per row).
      attention: mergeTemplateNeed(
        evaluateAttention(
          {
            destination: facts.destination,
            carrier: r.offer_code ?? null,
            category: facts.category,
            products: facts.products,
            weight: facts.weight,
            declared_value: asNumber(r.declared_total),
            items: facts.items,
          },
          attentionRules,
        ),
        need,
      ),
      // The templates to pre-tick and badge in the row's Print documents control.
      needed_template_ids: shipmentNeed?.templates.map((t) => t.id) ?? [],
      documents: (r.document_ref ? orderDocs.get(r.document_ref) : undefined) ?? [],
      }
    })
    // Oldest REQUEST first: the print station works the queue top-down, and this is the column
    // Boxtal's own shipment list is ordered by, so the two read the same way when the operator
    // cross-checks them. A row with no date goes LAST (an empty string would sort it to the top
    // as the oldest of all).
    .sort((a, b) => {
      if (a.requested_at == null || b.requested_at == null) {
        if (a.requested_at === b.requested_at) return 0
        return a.requested_at == null ? 1 : -1
      }
      return a.requested_at.localeCompare(b.requested_at)
    })
  return { rows: out }
}

/** Order placement date AND operator status per ANCHOR DOCUMENT. Both come from local tables
 *  (`prep_meta` + `prep_order_state`): the print queue must not fan out to Shopify to render a
 *  date, and must not resolve a draft to know a row is on hold. */
async function orderFactsByDocumentRef(
  ctx: BoxtalToolCtx,
  documentRefs: string[],
): Promise<Map<string, { order_created_at: string | null; status: PrepStatus | null }>> {
  const refs = [...new Set(documentRefs)]
  const metas: Array<{ document_ref?: string | null; order_created_at?: string | null; shopify_order_id?: string | null }> = []
  // The bridge caps an IN list at 1000 values.
  for (let i = 0; i < refs.length; i += 1000) {
    metas.push(
      ...((await ctx.db.findMany("prep_meta", {
        where: { document_ref: { in: refs.slice(i, i + 1000) } },
        limit: 1000,
      })) as typeof metas),
    )
  }
  const states = await loadOrderStates(ctx)
  const out = new Map<string, { order_created_at: string | null; status: PrepStatus | null }>()
  for (const m of metas) {
    if (!m.document_ref) continue
    // The operator's hold/validated decision is keyed by ORDER, so it reaches a shipment row
    // through the document the row was bought from.
    const key = m.shopify_order_id ? orderKeyForShopifyOrder(m.shopify_order_id) : null
    const state = key ? states.get(key) : undefined
    out.set(m.document_ref, {
      order_created_at: m.order_created_at ?? null,
      status: (state?.status as PrepStatus | null | undefined) ?? null,
    })
  }
  return out
}

// ── returns_list ─────────────────────────────────────────────────────────────
export async function returnsList(ctx: BoxtalToolCtx): Promise<{ rows: ReturnRow[] }> {
  const [all, productCodes] = await Promise.all([
    findAllShipments(ctx, { kind: "return" }),
    loadProductCodeConfig(ctx),
  ])
  const rows = all.reverse().filter((r) => isLiveShipment(r))
  const numbers = await documentNumbersById(ctx, rows.map((r) => r.document_ref ?? null))
  const out = rows
    .map((r): ReturnRow => ({
      ...readQueueFacts(r.queue_facts, productCodes),
      id: String(r.id),
      requested_at: r.created_at ?? null,
      customer: r.recipient_summary ?? "-",
      reason: r.return_reason ?? null,
      proforma_ref: r.document_ref ?? null,
      proforma_number: r.document_ref ? (numbers.get(r.document_ref) ?? null) : null,
      order_status: r.order_status ?? null,
      tracking_status: r.tracking_status ?? null,
      // One definition of "label ready" (see shipmentHasLabel): CONFIRMED is Boxtal's ORDER
      // lifecycle, not evidence that a label PDF exists.
      label_ready: shipmentHasLabel(r),
      created_by: r.created_by === "agent" ? "agent" : "user",
    }))
  return { rows: out }
}

// ── to_prepare_list ──────────────────────────────────────────────────────────
const SCAN_LIMIT = 40

/** Live outbound coverage per invoice: `full` when a legacy full-invoice shipment is
 *  live (covers everything), else the per-line shipped units summed over live PARTIAL
 *  batches. An invoice absent from the map has no live outbound shipment at all. */
export interface ShipmentCoverage {
  full: boolean
  shippedByLine: Map<string, number>
}

async function liveShipmentCoverage(ctx: BoxtalToolCtx): Promise<Map<string, ShipmentCoverage>> {
  const ships = (await findAllShipments(ctx, {})) as Array<
    ShipmentRow & { line_quantities?: Array<{ line_id: string; quantity: number }> | null }
  >
  const out = new Map<string, ShipmentCoverage>()
  for (const s of ships) {
    if (s.kind === "return") continue
    if (!isLiveShipment(s)) continue
    if (!s.document_ref) continue
    const cov = out.get(s.document_ref) ?? { full: false, shippedByLine: new Map<string, number>() }
    if (s.line_quantities == null) {
      cov.full = true
    } else {
      for (const lq of s.line_quantities) {
        cov.shippedByLine.set(lq.line_id, (cov.shippedByLine.get(lq.line_id) ?? 0) + lq.quantity)
      }
    }
    out.set(s.document_ref, cov)
  }
  return out
}

/** The pre-rework per-DOCUMENT exclusion flags, still honoured (read-through) for rows that never
 *  got an order-state row. */
async function legacyExcludedDocumentRefs(ctx: BoxtalToolCtx): Promise<Set<string>> {
  const rows = (await ctx.db.findMany("prep_state", { limit: 1000 })) as Array<{
    document_ref: string
    excluded?: boolean | null
  }>
  return new Set(rows.filter((r) => r.excluded).map((r) => r.document_ref))
}

export interface ToPrepareListOptions {
  /**
   * When true, KEEP rows the operator has excluded. When false (the default), the shared excluded
   * set is subtracted, so the sidebar badge (queue_counts), quote_batch and prep_list all agree on
   * one worklist. Exclusion is keyed by ORDER now, so a row with no invoice can be excluded too.
   */
  includeExcluded?: boolean
  /** Pre-computed scan, so a caller that already has one (prep_list) does not scan twice. */
  scan?: OpenOrdersScan
  /** Skip the on-demand resolution of un-cached anchors (what prep_list does: the grid renders
   *  `not_synced` and offers Sync instead of paying O(rows) resolutions on a read). */
  skipResolve?: boolean
}

/**
 * The worklist candidates, order-driven and shared by every consumer.
 *
 * One definition of "what is shipping work", so the sidebar badge, the agent's to_prepare_list and
 * the operator's grid can never disagree: every open unfulfilled order, minus the excluded ones,
 * minus order-less rows whose proforma is already fully shipped.
 */
export async function worklistCandidates(
  ctx: BoxtalToolCtx,
  opts: {
    includeExcluded?: boolean
    scan?: OpenOrdersScan
    source?: "live" | "cache"
    /** Passed to the scan this call builds itself (ignored when `scan` is given): the proforma settle
     *  inside the scan writes back only Boxtal's and the invoicing app's own state, so a read caller
     *  sets this and a failed write never fails the read. */
    bestEffortWrites?: boolean
  } = {},
): Promise<{ candidates: OrderCandidate[]; scan: OpenOrdersScan; coverage: Map<string, ShipmentCoverage> }> {
  const [scan, coverage, excluded, legacyExcludedDocs] = await Promise.all([
    opts.scan ? Promise.resolve(opts.scan) : openOrdersScan(ctx, { source: opts.source, bestEffortWrites: opts.bestEffortWrites }),
    liveShipmentCoverage(ctx),
    opts.includeExcluded ? Promise.resolve(new Set<string>()) : excludedOrderKeys(ctx),
    opts.includeExcluded ? Promise.resolve(new Set<string>()) : legacyExcludedDocumentRefs(ctx),
  ])
  // An ORDER-LESS row created from an existing order (prep_add_shipment with from_order_number)
  // SUPERSEDES that order's own candidate: they are the same physical parcel, and showing both put
  // the same shipment in the queue twice, which an operator can ship twice. Computed from the
  // candidates already in hand (each carries its prep_order_state row), so this costs no extra
  // query and both worklist consumers -- prep_list and to_prepare_list -- inherit it here, in the
  // one place they share.
  const superseded = new Set<string>()
  for (const c of scan.candidates) {
    if (parseOrderKey(c.order_key)?.kind === "order") continue
    const orderId = c.state?.shopify_order_id ?? c.shopify_order_id
    if (orderId) superseded.add(orderKeyForShopifyOrder(orderId))
  }
  const candidates = scan.candidates.filter((c) => {
    if (superseded.has(c.order_key)) return false
    if (excluded.has(c.order_key)) return false
    // Legacy exclusions were keyed by DOCUMENT. excludedOrderKeys re-keys the ones prep_meta can
    // map; this catches the rest by matching the row's current anchor, so a row excluded before the
    // rework stays excluded even if it was never prep_synced. An order-state row wins over both
    // (an explicit restore must not be undone by a stale legacy flag).
    if (!c.state && c.anchor_ref && legacyExcludedDocs.has(c.anchor_ref)) return false
    // A row leaves the worklist as soon as a live local shipment fully covers its invoice, whether
    // the row is order keyed or order less, and no matter where the scan came from. The local
    // shipment table is the authority we actually control, so we drop on it directly instead of
    // waiting on Shopify's fulfilment signal, which this queue does not rely on for this decision.
    if (c.anchor_ref && coverage.get(c.anchor_ref)?.full) return false
    return true
  })
  return { candidates, scan, coverage }
}

/**
 * `to_prepare_list`: the AGENT-facing worklist, now one row per open order rather than one per
 * issued invoice (an order with no invoice used to be structurally absent — ticket-10224).
 *
 * Unlike the operator grid this DOES resolve an anchor's draft when the cache has nothing for it
 * (bounded by SCAN_LIMIT): the agent path has a longer budget than the UI tool route, and an agent
 * asking "what is ready to prepare" needs the classification now, not after a separate sync.
 */
export async function toPrepareList(
  ctx: BoxtalToolCtx,
  opts: ToPrepareListOptions = {},
): Promise<ToPrepareList> {
  // Stays on the live default (no `source` passed): this is the AGENT-facing tool, not the UI page
  // read that deadlocked the sandbox pool. It has a longer budget than a page-open tool call and an
  // agent asking "what is ready to prepare" needs a live answer, not the same cache queue_counts and
  // prep_list's list read now use.
  const [{ candidates, coverage }, cache] = await Promise.all([
    worklistCandidates(ctx, {
      includeExcluded: opts.includeExcluded,
      scan: opts.scan,
      // A read: the settle's write-back is Boxtal's and the invoicing app's own state, best effort
      // (the same stance as prep_list).
      bestEffortWrites: true,
    }),
    loadDraftCache(ctx),
  ])

  if (!opts.skipResolve) {
    const missing = candidates
      .map((c) => c.anchor_ref)
      .filter(
        (ref): ref is string =>
          ref != null &&
          (isDraftCacheStale(cache.get(ref)) || coverageMovedSince(cache.get(ref), coverage.get(ref))),
      )
    if (missing.length > 0) {
      const fresh = await resolveDrafts(ctx, missing, {
        limit: SCAN_LIMIT,
        concurrency: RESOLVE_CONCURRENCY,
        coverage,
      })
      for (const [ref, row] of fresh) cache.set(ref, row)
    }
  }

  const rows: ToPrepareRow[] = candidates.map((c) => toPrepareRow(c, cache.get(c.anchor_ref ?? ""), coverage))
  const ready_to_prepare = rows.filter((r) => r.prep_status === "ready_to_prepare")
  const needs_fix = rows.filter((r) => r.prep_status === "needs_fix")
  return {
    rows,
    total: rows.length,
    ready_count: ready_to_prepare.length,
    needs_fix_count: needs_fix.length,
    ready_to_prepare,
    needs_fix,
  }
}

/** The blocking reason for a row with no anchor document, or null when the row has one. */
export function noAnchorReason(c: OrderCandidate): string | null {
  if (c.anchor_ref) return null
  if (c.no_anchor_reason) return c.no_anchor_reason
  if (c.proforma_approval_expired) return "Proforma approval expired"
  if (c.proforma_pending_approval_id) return "Proforma pending approval"
  if (c.category === "repair" || c.category === "gift") return "No proforma issued yet"
  return "No invoice issued for this order yet"
}

function toPrepareRow(
  c: OrderCandidate,
  cached: DraftCacheRow | undefined,
  coverage: Map<string, ShipmentCoverage>,
): ToPrepareRow {
  const anchorMissing = noAnchorReason(c)
  const weight = (cached?.parcels ?? []).reduce((s, p) => s + (Number(p.weight) || 0), 0)
  const base = {
    id: c.anchor_ref,
    order_key: c.order_key,
    invoice_ref: c.anchor_number ?? c.order_name ?? c.order_key,
    customer: c.customer,
    destination: c.destination ?? "-",
    items: cached?.parcels.length ?? c.line_items.length,
    weight: weight > 0 ? weight : null,
  }
  if (anchorMissing) {
    return { ...base, prep_status: "needs_fix", reason: anchorMissing }
  }
  if (!cached) {
    return { ...base, prep_status: "needs_fix", reason: "Not synced yet" }
  }
  if (cached.needs_fix_reason) {
    return { ...base, prep_status: "needs_fix", reason: cached.needs_fix_reason }
  }
  const remaining = cached.partial_remaining
  if (remaining && remaining.length === 0) {
    return { ...base, prep_status: "needs_fix", reason: "Every unit already has a live shipment" }
  }
  if (remaining) {
    const units = remaining.reduce((s, l) => s + l.quantity, 0)
    return {
      ...base,
      prep_status: "ready_to_prepare",
      partially_shipped: true,
      remaining_units: units,
    }
  }
  return { ...base, prep_status: "ready_to_prepare" }
}

// ── queue_counts ─────────────────────────────────────────────────────────────
export async function queueCounts(ctx: BoxtalToolCtx): Promise<QueueCounts> {
  const [ready, returns, exceptions, toPrepareEstimate] = await Promise.all([
    readyList(ctx).then((r) => r.rows.length),
    returnsList(ctx).then((r) => r.rows.length),
    // The stuck-parcel count, from the SAME authoritative source as exceptions_list. Surfaced on the
    // badge so a queue read can never be mistaken for a clean exceptions check — a non-zero here means
    // exceptions_list/track is required to surface the stuck shipment(s).
    exceptionsList(ctx).then((r) => r.rows.length),
    // Order-driven, and the SAME candidate set the grid renders: the badge is the row count, not
    // an estimate that can drift from it. No draft resolution, so it stays a cheap header read.
    // LIVE for now: cache mode (`source: "cache"`) exists and is exercised in tests, but nothing
    // warms `prep_meta` for an order that was never prep_synced, so a cache-only scan undercounts
    // never-synced orders -- flipping the default here is a product decision, not yet made.
    worklistCandidates(ctx, { bestEffortWrites: true }).then((r) => r.candidates.length),
  ])
  return {
    to_prepare: toPrepareEstimate,
    ready,
    returns,
    exceptions,
    rows: [
      { key: "to_prepare", value: toPrepareEstimate },
      { key: "ready", value: ready },
      { key: "returns", value: returns },
      { key: "exceptions", value: exceptions },
    ],
  }
}

// ── exceptions_list ────────────────────────────────────────────────────────────
export interface ExceptionRow extends QueueFacts {
  id: string
  /** When the label was requested from Boxtal — the sort key every queue shares. */
  requested_at: string | null
  /** The shipment's order reference (boxtal external_id) — the operative ref a
   *  customer/ticket quotes. Surfaced here (as on search/track) so an operator
   *  chasing an exception can cite the ORDER, not the internal uuid, and so the
   *  agent never has to fabricate an order ref it could not see. Null when unset. */
  external_id: string | null
  recipient: string
  carrier: string | null
  tracking_number: string | null
  tracking_status: string | null
  order_status: string | null
}

// A healthy fleet is a normal state — these are the carrier tracking states that
// represent a real delivery problem an operator must act on. Includes both the
// canonical schema enum value (`EXCEPTION`) and the carrier-vocabulary aliases.
export const EXCEPTION_STATES = ["INCIDENT", "RETURNED", "LOST", "EXCEPTION"]

/**
 * List shipments whose carrier tracking is in an exception state
 * (INCIDENT / RETURNED / LOST). Returns `[]` for a healthy fleet — not an error.
 */
export async function exceptionsList(ctx: BoxtalToolCtx): Promise<{ rows: ExceptionRow[] }> {
  const [rows, productCodes] = await Promise.all([
    findAllShipments(ctx, { tracking_status: { in: EXCEPTION_STATES } }),
    loadProductCodeConfig(ctx),
  ])
  const out = rows
    .filter((r) => r.tracking_status != null && EXCEPTION_STATES.includes(r.tracking_status))
    .map((r) => ({
      ...readQueueFacts(r.queue_facts, productCodes),
      id: String(r.id),
      requested_at: r.created_at ?? null,
      external_id: r.external_id ?? null,
      recipient: r.recipient_summary ?? "-",
      carrier: r.offer_code ?? null,
      tracking_number: r.tracking_number ?? null,
      tracking_status: r.tracking_status ?? null,
      order_status: r.order_status ?? null,
    }))
  return { rows: out }
}

// ── stuck_list ──────────────────────────────────────────────────────────────
//
// The SINGLE needs-attention queue spanning ALL stuck families — the server-side
// union that exceptions_list (only the hard EXCEPTION/INCIDENT/RETURNED/LOST
// states) does NOT cover. `exceptions_list` MISSES a failed delivery attempt
// (FAILED_ATTEMPT) and a parcel awaiting pickup-point collection
// (REACHED_DELIVERY_PICKUP_POINT), so a "find every stuck shipment" sweep that
// relied only on it would silently drop those families. Rather than make the
// caller enumerate the whole fleet via search + classify each tracking_status
// enum in-context (the fragile in-context discrimination the l710/l713/l714
// doctrine moves SERVER-SIDE), this read does the classification ONCE, on the
// server, and returns the union with a per-row `family` + `reason` label so a
// caller (a routine tick, a triage reply) RENDERS the stuck set instead of
// re-deriving it from raw enums. Pure off the local shipment row (no live carrier
// call) — exactly like exceptions_list — so it is deterministic and depends on
// no live track read.

/** The stuck-family classification of a needs-attention row. */
export type StuckFamily = "exception" | "failed_delivery" | "pickup_expiring" | "create_orphan" | "fulfillment_failed"

// The tracking_status values that belong to each stuck family. EXCEPTION-class
// reuses EXCEPTION_STATES (the same authoritative set exceptions_list uses) so
// stuck_list is a strict SUPERSET of exceptions_list. FAILED_ATTEMPT and
// REACHED_DELIVERY_PICKUP_POINT are the two DISTINCT non-exception stuck states.
// Everything else (ANNOUNCED / SHIPPED / IN_TRANSIT / OUT_FOR_DELIVERY /
// DELIVERED) is a HEALTHY state and is NEVER surfaced here.
const FAILED_DELIVERY_STATE = "FAILED_ATTEMPT"
const PICKUP_POINT_STATE = "REACHED_DELIVERY_PICKUP_POINT"

function classifyStuck(trackingStatus: string | null): StuckFamily | null {
  if (trackingStatus == null) return null
  if (EXCEPTION_STATES.includes(trackingStatus)) return "exception"
  if (trackingStatus === FAILED_DELIVERY_STATE) return "failed_delivery"
  if (trackingStatus === PICKUP_POINT_STATE) return "pickup_expiring"
  return null
}

// A human-readable, NON-FABRICATED reason + next-action per family. Grounded in
// the tracking_status (the carrier state) — NOT a guessed cause: for the exact
// per-shipment carrier checkpoint message, the caller still calls track. These
// are the family-level "what's wrong + what to do" so the queue is actionable
// without the caller inventing a cause from the bare flag.
const FAMILY_REASON: Record<StuckFamily, string> = {
  // The ONLY family that is not a carrier state: a label purchase whose create
  // call was interrupted before the Boxtal order id was stored (link-store.ts,
  // isStaleReservation). Copy is deliberately explicit that nothing is done
  // automatically, because a paid label may be sitting on the Boxtal side.
  create_orphan:
    "Label purchase left unfinished: the create call was interrupted before the Boxtal order id was saved, so a paid label may exist at Boxtal with no local record. Check this invoice in the Boxtal dashboard, then settle the row with settle_orphan_create: outcome adopt with the Boxtal order id if an order is there, or outcome release if no label was bought (that frees the invoice for a new label). Nothing is bought, cancelled or retried automatically.",
  fulfillment_failed:
    "Shopify fulfillment failed: the parcel shipped (or is packed) but its Shopify order is not fulfilled, so the customer has no tracking. The shipment's fulfillment_error says why; fix the cause, then tick the row on Ready to ship again or fulfil the order in Shopify.",
  exception:
    "Carrier exception / incident (e.g. held at customs, lost or returned-to-sender): chase the carrier; track for the live checkpoint, and open a claim if the parcel is lost.",
  failed_delivery:
    "Failed delivery attempt: the carrier could not deliver; reschedule delivery or confirm the address with the customer.",
  pickup_expiring:
    "Parcel awaiting collection at a pickup point (Mondial Relay / point-relais): it will RETURN TO SENDER if not collected before the deadline; notify the customer to collect it now.",
}

export interface StuckRow extends QueueFacts {
  /** When the label was requested from Boxtal — the sort key every queue shares. */
  requested_at: string | null
  id: string
  /** The stuck family — exception | failed_delivery | pickup_expiring. */
  family: StuckFamily
  /** The merchant order reference (external_id, e.g. the Shopify order number) when the shipment
   *  carries one — the friendliest ref to cite. Null when the shipment has no merchant external id. */
  external_id: string | null
  /** The Boxtal order id (the carrier-side order reference `track` keys on). Present even when the
   *  merchant external_id is absent — so there is always a real, tool-backed order reference to cite. */
  boxtal_order_id: string | null
  /** The single ORDER REFERENCE to quote for this stuck parcel: the merchant external_id when present,
   *  else the Boxtal order id. Always tool-backed — never the internal shipment-row uuid, never invented.
   *  Cite THIS as the order ref in the dossier. Null only when the shipment carries neither id. */
  order_ref: string | null
  recipient: string
  carrier: string | null
  /** The real carrier tracking number — cite THIS, never the internal uuid. */
  tracking_number: string | null
  /** The exact carrier tracking_status string (quote it verbatim; do not paraphrase). */
  tracking_status: string | null
  order_status: string | null
  /** The family-level reason + concrete next action (grounded in the status, not a guess). */
  reason: string
}

/**
 * The single needs-attention queue: every shipment in a STUCK state, across ALL
 * families exceptions_list does and does NOT catch (carrier exception/incident,
 * failed delivery attempt, pickup-point-awaiting-collection, plus the ONE
 * non-carrier family: an orphaned label purchase whose create call never
 * finished, which has no tracking_status at all and was therefore invisible to
 * every queue), each row labelled
 * with its `family` + a grounded `reason`/next-action. Excludes every healthy
 * state (in-transit / out-for-delivery / delivered). Returns `[]` for a fully
 * healthy fleet — not an error. The caller renders these rows directly; for a
 * shipment's LIVE carrier checkpoint detail it can still call track.
 */
export async function stuckList(ctx: BoxtalToolCtx): Promise<{ rows: StuckRow[] }> {
  const [rows, productCodes] = await Promise.all([
    findShipmentsInAny(ctx, [
      { tracking_status: { in: [...EXCEPTION_STATES, FAILED_DELIVERY_STATE, PICKUP_POINT_STATE] } },
      { link_state: { in: [...UNFINISHED_LINK_STATES] } },
      { fulfillment_state: "failed" },
    ]),
    loadProductCodeConfig(ctx),
  ])
  const out: StuckRow[] = []
  const nowMs = Date.now()
  for (const r of rows) {
    // A CANCELLED shipment is no longer in play — never surface it as stuck.
    if (r.order_status === "CANCELLED") continue
    // An orphaned create reservation carries NO tracking_status, so the carrier
    // classification below structurally cannot see it. Age-gated in link-store
    // (STALE_RESERVATION_MS), so a create that is legitimately running right now
    // never appears here.
    const family: StuckFamily | null = isStaleReservation(r, nowMs)
      ? "create_orphan"
      : (classifyStuck(r.tracking_status ?? null) ?? (r.fulfillment_state === "failed" ? "fulfillment_failed" : null))
    if (family == null) continue
    const externalId = r.external_id ?? null
    const boxtalOrderId = r.boxtal_order_id ?? null
    out.push({
      ...readQueueFacts(r.queue_facts, productCodes),
      id: String(r.id),
      requested_at: r.created_at ?? null,
      family,
      external_id: externalId,
      boxtal_order_id: boxtalOrderId,
      // The merchant ref is the friendliest; fall back to the Boxtal order id so the dossier ALWAYS
      // has a real, tool-backed order reference to cite (a shipment with no merchant external_id — the
      // exception-sweep fixture — still yields its Boxtal order id, never a null / fabricated ref).
      order_ref: externalId ?? boxtalOrderId,
      recipient: r.recipient_summary ?? "-",
      carrier: r.offer_code ?? null,
      tracking_number: r.tracking_number ?? null,
      tracking_status: r.tracking_status ?? null,
      order_status: r.order_status ?? null,
      reason:
        family === "fulfillment_failed" && r.fulfillment_error
          ? `${FAMILY_REASON[family]} Reason: ${r.fulfillment_error}`
          : FAMILY_REASON[family],
    })
  }
  return { rows: out }
}
