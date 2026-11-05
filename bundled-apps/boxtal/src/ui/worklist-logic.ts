// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure rules of the shipping worklist (Queues.tsx): one page where an order goes from To prepare,
// to Label bought, to Packed and fulfilled, with its state on every row and a filter on top.
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
    return { kind: "confirm_unpack", message: `Confirm unfulfilling order ${row.order_name ?? "of this parcel"}?` }
  }
  return { kind: "unpack" }
}

// ── the filter ────────────────────────────────────────────────────────────────

export type WorklistFilter = "all" | "to_prepare" | "ready" | "to_pack" | "packed"

export const WORKLIST_FILTERS: Array<{ id: WorklistFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "to_prepare", label: "To prepare" },
  { id: "ready", label: "Ready to ship" },
  { id: "to_pack", label: "To pack" },
  { id: "packed", label: "Packed" },
]

export function parseWorklistFilter(v: string | null | undefined): WorklistFilter {
  return v === "to_prepare" || v === "ready" || v === "to_pack" || v === "packed" ? v : "all"
}

/** Which Ready-to-ship rows the filter keeps. "To prepare" keeps none: those are the orders above. */
export function readyRowMatches(row: WorklistReadyRow, filter: WorklistFilter): boolean {
  if (filter === "all" || filter === "ready") return true
  if (filter === "to_prepare") return false
  return filter === "packed" ? row.packed : !row.packed
}

export function showsToPrepare(filter: WorklistFilter): boolean {
  return filter === "all" || filter === "to_prepare"
}

export function showsReady(filter: WorklistFilter): boolean {
  return filter !== "to_prepare"
}

/**
 * How each half of the worklist is rendered for a filter. The Ready to ship half stays MOUNTED
 * under every filter, only hidden: it is what loads the bought labels, and the filter bar counts
 * (Ready to ship, To pack, Packed) are computed from them. Unmounting it on "To prepare" left
 * those counts at 0 when the page was opened from the To prepare route.
 */
export function worklistSections(filter: WorklistFilter): {
  toPrepare: { mounted: boolean; visible: boolean }
  ready: { mounted: boolean; visible: boolean }
} {
  return {
    toPrepare: { mounted: showsToPrepare(filter), visible: showsToPrepare(filter) },
    ready: { mounted: true, visible: showsReady(filter) },
  }
}

/** The filter bar counts. Depend on the loaded rows only, never on the filter that is active. */
export function worklistFilterCounts(rows: WorklistReadyRow[]): Record<"ready" | "to_pack" | "packed", number> {
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
