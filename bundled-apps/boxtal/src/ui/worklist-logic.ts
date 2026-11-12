// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure rules of the shipping worklist (Queues.tsx): one page, ONE table, where an order goes from
// To prepare, to Label bought, to Packed and fulfilled, with its state on every row and a filter on
// top.
// Kept free of Solid and of the host so every rule is unit tested.

/** What a Ready-to-ship row needs for its state, tint and packed toggle. */
export interface WorklistReadyRow {
  packed: boolean
  fulfillment_state: string | null
  fulfillment_error: string | null
  status: "to_prepare" | "validated" | "on_hold" | null
  order_name: string | null
}

export type ReadyRowState =
  | "label_bought"
  | "packed_fulfilled"
  | "packed"
  | "fulfillment_failed"
  | "awaiting_approval"
  | "fulfilled"

export const READY_STATE_LABELS: Record<ReadyRowState, string> = {
  label_bought: "Label bought",
  packed_fulfilled: "Packed, fulfilled",
  packed: "Packed",
  fulfillment_failed: "Fulfillment failed",
  awaiting_approval: "Fulfillment awaiting approval",
  fulfilled: "Fulfilled, not packed",
}

/** The one state a Ready-to-ship row is in. A failure outranks everything: it is the row to act on. */
export function readyRowState(row: WorklistReadyRow): ReadyRowState {
  if (row.fulfillment_state === "failed") return "fulfillment_failed"
  if (row.fulfillment_state === "pending_approval") return "awaiting_approval"
  const fulfilled = row.fulfillment_state === "fulfilled"
  if (row.packed) return fulfilled ? "packed_fulfilled" : "packed"
  return fulfilled ? "fulfilled" : "label_bought"
}

/**
 * The whole-row tint. Packed and fulfilled is light green and stays green; a failed fulfillment is
 * red; on hold is red too and wins over everything, because a held parcel must never look done.
 */
export function readyRowClass(row: WorklistReadyRow): string {
  if (row.status === "on_hold") return "bg-error-glow/40"
  const state = readyRowState(row)
  if (state === "fulfillment_failed") return "bg-error-glow/40"
  if (state === "packed_fulfilled" || state === "packed") return "bg-success/10"
  if (state === "awaiting_approval") return "bg-warning-glow"
  return ""
}

/** What a click on the packed toggle does. */
export type PackedToggleAction =
  | { kind: "pack" }
  | { kind: "unpack" }
  /** The order is fulfilled on Shopify: the operator confirms before the fulfillment is cancelled. */
  | { kind: "confirm_unpack"; message: string }

export function packedToggleAction(row: WorklistReadyRow): PackedToggleAction {
  if (!row.packed) return { kind: "pack" }
  if (row.fulfillment_state === "fulfilled") {
    return {
      kind: "confirm_unpack",
      message: `Confirm unfulfilling order ${row.order_name ?? "of this parcel"}?`,
    }
  }
  return { kind: "unpack" }
}

// ── the filter ────────────────────────────────────────────────────────────────

export type WorklistFilter = "all" | "to_prepare" | "ready" | "to_pack" | "packed"

/** The State cell of an order that has no label yet (the worklist's first state). */
export const WORKLIST_TO_PREPARE_LABEL = "To prepare"

export const WORKLIST_FILTERS: Array<{ id: WorklistFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "to_prepare", label: WORKLIST_TO_PREPARE_LABEL },
  { id: "ready", label: "Ready to ship" },
  { id: "to_pack", label: "To pack" },
  { id: "packed", label: "Packed" },
]

export function parseWorklistFilter(v: string | null | undefined): WorklistFilter {
  return v === "to_prepare" || v === "ready" || v === "to_pack" || v === "packed" ? v : "all"
}

/** Which bought-label rows the filter keeps. "To prepare" keeps none: those are the orders without
 *  a label yet. */
export function readyRowMatches(row: WorklistReadyRow, filter: WorklistFilter): boolean {
  if (filter === "all" || filter === "ready") return true
  if (filter === "to_prepare") return false
  return filter === "packed" ? row.packed : !row.packed
}

export function showsToPrepare(filter: WorklistFilter): boolean {
  return filter === "all" || filter === "to_prepare"
}

/** What else narrows the worklist table: the search box and the order filters above it. */
export interface WorklistNarrowing {
  search: string
  country: string
  tag: string
  product: string
}

/** The fields of a bought-label row the table's search, country and product filters read. */
export interface WorklistReadySearchRow extends WorklistReadyRow {
  recipient: string
  destination: string | null
  invoice_ref: string | null
  tracking_number: string | null
  shipment_ref: string | null
  products: string | null
}

/**
 * Whether a bought-label row passes the table's filters, the same ones the orders to prepare go
 * through (matchesPrepFilter): the state filter, the country, the product and the search (order,
 * invoice, customer, country, and the tracking number or Boxtal reference). A bought label carries
 * no Shopify tags, so a tag filter keeps none of them.
 */
export function readyRowMatchesView(
  row: WorklistReadySearchRow,
  filter: WorklistFilter,
  n: WorklistNarrowing,
): boolean {
  if (!readyRowMatches(row, filter)) return false
  if (n.country && (row.destination ?? "").trim().toUpperCase() !== n.country.trim().toUpperCase())
    return false
  if (n.tag) return false
  if (n.product && !(row.products ?? "").toLowerCase().includes(n.product.toLowerCase()))
    return false
  if (n.search) {
    const q = n.search.toLowerCase()
    const haystack = [
      row.invoice_ref,
      row.order_name,
      row.recipient,
      row.destination,
      row.tracking_number,
      row.shipment_ref,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    if (!haystack.includes(q)) return false
  }
  return true
}

/** Why the worklist table is empty, so it says the true thing. */
export type WorklistEmptyKind = "nothing_to_prepare" | "nothing_ready" | "no_match"

export function worklistEmptyKind(input: {
  filter: WorklistFilter
  /** Orders to prepare read (before the table's filters). */
  prepTotal: number
  /** Bought labels read (before the table's filters). */
  readyTotal: number
  /** A search or order filter is set. */
  narrowed: boolean
}): WorklistEmptyKind {
  if (input.narrowed) return "no_match"
  if (input.filter === "to_prepare")
    return input.prepTotal === 0 ? "nothing_to_prepare" : "no_match"
  if (input.filter !== "all") return input.readyTotal === 0 ? "nothing_ready" : "no_match"
  return input.prepTotal === 0 && input.readyTotal === 0 ? "nothing_to_prepare" : "no_match"
}

/** The filter bar counts. Depend on the loaded rows only, never on the filter that is active. */
export function worklistFilterCounts(
  rows: WorklistReadyRow[],
): Record<"ready" | "to_pack" | "packed", number> {
  return {
    ready: rows.filter((r) => readyRowMatches(r, "ready")).length,
    to_pack: rows.filter((r) => readyRowMatches(r, "to_pack")).length,
    packed: rows.filter((r) => readyRowMatches(r, "packed")).length,
  }
}

// ── routes ────────────────────────────────────────────────────────────────────

/**
 * The filter a queue route opens the worklist on. `/boxtal/queue/worklist` reads `?state=`; the two
 * retired routes (`to-prepare`, `ready`) still resolve, to the same page with their filter preset.
 */
export function worklistFilterForRoute(queueId: string, search: string): WorklistFilter {
  if (queueId === "to-prepare") return "to_prepare"
  if (queueId === "ready") return "ready"
  const m = /[?&]state=([a-z_]+)/.exec(search)
  return parseWorklistFilter(m?.[1])
}
