// SPDX-License-Identifier: FSL-1.1-ALv2
//
// prep-view-state: the stale-while-revalidate open plan, the refresh banner / empty-state
// decision, and the row exit transition reconcile -- all pure, all driven straight from the spec
// cases so a regression in any of them fails a named test instead of only being catchable by
// eyeballing a render (this app has no DOM harness).
import { describe, expect, it } from "bun:test"
import type { PrepListResult, PrepRow } from "./prep-row-logic"
import {
  EXIT_TRANSITION_MS,
  gridViewState,
  planPrepListOpen,
  reconcileExitingRows,
  rowIsInteractive,
  toggleRowKey,
} from "./prep-view-state"

function makeRow(overrides: Partial<PrepRow> = {}): PrepRow {
  return {
    order_key: "so:1",
    document_ref: null,
    anchor_kind: null,
    invoice_ref: "INV-1",
    order_name: "#1",
    order_created_at: null,
    customer: "Alice",
    destination: "US",
    order_tags: [],
    products: "1xES",
    grand_total_minor: 1000,
    currency: "EUR",
    parcels: [],
    package_count: 1,
    category: "sale",
    status: "to_prepare",
    status_note: null,
    staff_note: null,
    quote: {
      cheapest: null,
      alternates: [],
      offers: [],
      selected_offer_code: null,
      selected: null,
      quoted_at: null,
      stale: false,
    },
    state: "quote_missing",
    excluded: false,
    validated: false,
    invoice: { state: "missing", document_id: null, number: null, approval_id: null, kind: null },
    shipment: null,
    recipient: null,
    ...overrides,
  }
}

function makeList(rows: PrepRow[]): PrepListResult {
  return {
    rows,
    total: rows.length,
    last_sync_at: "2026-09-10T08:00:00.000Z",
    truncated: false,
    last_sync_error: null,
    invoicing_available: true,
  }
}

describe("cached rows are painted before the refresh lands", () => {
  it("planPrepListOpen paints the cached value synchronously, no fetch awaited", () => {
    const cached = makeList([makeRow()])
    const plan = planPrepListOpen(cached)
    expect(plan.paint).toBe(cached)
  })

  it("paints null (nothing to show yet) when there is no cache to open with", () => {
    expect(planPrepListOpen(null).paint).toBeNull()
  })
})

describe("a background refresh starts on every open even when the cache is warm", () => {
  it("refreshNow is true with a warm cache", () => {
    expect(planPrepListOpen(makeList([makeRow()])).refreshNow).toBe(true)
  })

  it("refreshNow is true with no cache at all -- it is not a special case, it is the rule", () => {
    expect(planPrepListOpen(null).refreshNow).toBe(true)
  })
})

describe("the refreshing message is shown while the background refresh runs", () => {
  it("banner says last known data plus a refresh is running, table stays up", () => {
    const state = gridViewState({
      hasRows: true,
      refreshing: true,
      failed: false,
      lastSyncAt: "2026-09-10T08:00:00.000Z",
    })
    expect(state.banner?.kind).toBe("refreshing")
    expect(state.banner?.message).toContain("last known data")
    expect(state.banner?.message).toContain("Refreshing now")
    expect(state.empty).toBe("none")
  })
})

describe("an empty cache during a refresh does not say nothing to prepare", () => {
  it("uses the loading empty state, never the nothing-to-prepare one", () => {
    const state = gridViewState({
      hasRows: false,
      refreshing: true,
      failed: false,
      lastSyncAt: null,
    })
    expect(state.empty).toBe("loading")
    expect(state.banner?.message.toLowerCase()).not.toContain("nothing to prepare")
    expect(state.banner?.message.toLowerCase()).not.toContain("shipped or excluded")
  })
})

describe("a failed refresh keeps the cached rows and says the refresh failed", () => {
  it("empty stays none, banner names the failure and when the shown data is from", () => {
    const state = gridViewState({
      hasRows: true,
      refreshing: false,
      failed: true,
      lastSyncAt: "2026-09-10T08:00:00.000Z",
    })
    expect(state.empty).toBe("none")
    expect(state.banner?.kind).toBe("failed")
    expect(state.banner?.message).toContain("refresh failed")
    expect(state.banner?.message).toContain("last known data")
  })
})

describe("a failed refresh with no cached rows still shows the load error", () => {
  it("empty is load_error and there is no banner (the EmptyState carries the message)", () => {
    const state = gridViewState({
      hasRows: false,
      refreshing: false,
      failed: true,
      lastSyncAt: null,
    })
    expect(state.empty).toBe("load_error")
    expect(state.banner).toBeNull()
  })
})

describe("gridViewState on success", () => {
  it("no banner and no special empty state once neither refreshing nor failed", () => {
    const state = gridViewState({
      hasRows: true,
      refreshing: false,
      failed: false,
      lastSyncAt: null,
    })
    expect(state.banner).toBeNull()
    expect(state.empty).toBe("none")
  })
})

describe("a row removed by a refresh is held for the exit transition and is not interactive", () => {
  it("a dropped row is kept in the merged list (not yanked), and marked to exit", () => {
    const a = makeRow({ order_key: "so:a" })
    const b = makeRow({ order_key: "so:b" })
    const current = [a] // the refresh dropped "so:b"
    const prevDisplay = [a, b]
    const { merged, toExit, toCancel } = reconcileExitingRows(current, prevDisplay, new Set())

    expect(merged.map((r) => r.order_key)).toEqual(["so:a", "so:b"])
    expect(toExit).toEqual(["so:b"])
    expect(toCancel).toEqual([])
    // The held row is not interactive while it is exiting.
    expect(rowIsInteractive(true)).toBe(false)
    expect(rowIsInteractive(false)).toBe(true)
  })

  it("re-inserts the held row at ~its last known position, not at the end", () => {
    const a = makeRow({ order_key: "so:a" })
    const b = makeRow({ order_key: "so:b" })
    const c = makeRow({ order_key: "so:c" })
    const current = [a, c] // "so:b" was between a and c
    const prevDisplay = [a, b, c]
    const { merged } = reconcileExitingRows(current, prevDisplay, new Set())
    expect(merged.map((r) => r.order_key)).toEqual(["so:a", "so:b", "so:c"])
  })

  it("a row that reappears before its exit timer fires is cancelled, not re-exited", () => {
    const a = makeRow({ order_key: "so:a" })
    const b = makeRow({ order_key: "so:b" })
    const current = [a, b] // "so:b" is back
    const prevDisplay = [a, b]
    const exiting = new Set(["so:b"]) // was mid-exit from a previous tick
    const { merged, toExit, toCancel } = reconcileExitingRows(current, prevDisplay, exiting)
    expect(toCancel).toEqual(["so:b"])
    expect(toExit).toEqual([])
    expect(merged.map((r) => r.order_key)).toEqual(["so:a", "so:b"])
  })

  it("does not re-mark an already-exiting row as newly exiting", () => {
    const a = makeRow({ order_key: "so:a" })
    const b = makeRow({ order_key: "so:b" })
    const current = [a] // "so:b" still gone
    const prevDisplay = [a, b]
    const exiting = new Set(["so:b"]) // already mid-exit from a previous tick
    const { toExit } = reconcileExitingRows(current, prevDisplay, exiting)
    expect(toExit).toEqual([])
  })

  it("EXIT_TRANSITION_MS mirrors TicketsInbox's own window", () => {
    expect(EXIT_TRANSITION_MS).toBe(220)
  })
})

describe("toggleRowKey: a row's folds live by order key, outside the row", () => {
  it("opens, closes and force-sets one key without touching the others or the input", () => {
    const start = new Set(["so:2"])
    const opened = toggleRowKey(start, "so:1")
    expect([...opened].sort()).toEqual(["so:1", "so:2"])
    expect([...start]).toEqual(["so:2"])
    expect([...toggleRowKey(opened, "so:1")]).toEqual(["so:2"])
    expect([...toggleRowKey(opened, "so:1", true)].sort()).toEqual(["so:1", "so:2"])
    expect([...toggleRowKey(opened, "so:9", false)].sort()).toEqual(["so:1", "so:2"])
  })

  it("an open fold stays open when a re-read hands back a new object for the same row", () => {
    // <For> rebuilds a row whose object changed; the fold is read by key, so it survives that.
    const before = makeRow({ order_key: "so:7" })
    const open = toggleRowKey(new Set(), before.order_key)
    const after = makeRow({ order_key: "so:7", customer: "re-read" })
    expect(after).not.toBe(before)
    expect(open.has(after.order_key)).toBe(true)
  })
})
