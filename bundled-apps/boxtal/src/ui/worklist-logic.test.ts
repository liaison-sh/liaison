// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ticket-10508 (one worklist) and ticket-10647 / ticket-10507 / ticket-10522 (the packed tick
// fulfils the order): the pure rules the worklist page renders.
import { describe, expect, it } from "bun:test"
import {
  packedToggleAction,
  readyRowClass,
  readyRowMatches,
  readyRowMatchesView,
  readyRowState,
  showsToPrepare,
  type WorklistReadyRow,
  type WorklistReadySearchRow,
  worklistEmptyKind,
  worklistFilterCounts,
  worklistFilterForRoute,
} from "./worklist-logic"

const row = (over: Partial<WorklistReadyRow> = {}): WorklistReadyRow => ({
  packed: false,
  fulfillment_state: null,
  fulfillment_error: null,
  status: null,
  order_name: "#3475",
  ...over,
})

describe("worklist row state and tint", () => {
  it("a packed and fulfilled row is light green, and stays green while it is listed", () => {
    const r = row({ packed: true, fulfillment_state: "fulfilled" })
    expect(readyRowState(r)).toBe("packed_fulfilled")
    expect(readyRowClass(r)).toContain("bg-success")
  })

  it("a failed fulfillment is red and named, whatever the tick says", () => {
    const r = row({
      fulfillment_state: "failed",
      fulfillment_error: "Order has no OPEN fulfillment orders",
    })
    expect(readyRowState(r)).toBe("fulfillment_failed")
    expect(readyRowClass(r)).toContain("bg-error")
  })

  it("on hold wins over a done row: a held parcel never looks done", () => {
    expect(
      readyRowClass(row({ status: "on_hold", packed: true, fulfillment_state: "fulfilled" })),
    ).toContain("bg-error")
  })

  it("a fresh label is just bought, untinted", () => {
    expect(readyRowState(row())).toBe("label_bought")
    expect(readyRowClass(row())).toBe("")
  })
})

describe("the packed toggle", () => {
  it("ticks an unpacked row", () => {
    expect(packedToggleAction(row())).toEqual({ kind: "pack" })
  })

  it("asks before unticking a fulfilled row, naming the order", () => {
    expect(packedToggleAction(row({ packed: true, fulfillment_state: "fulfilled" }))).toEqual({
      kind: "confirm_unpack",
      message: "Confirm unfulfilling order #3475?",
    })
  })

  it("unticks a packed row with nothing fulfilled without asking", () => {
    expect(packedToggleAction(row({ packed: true }))).toEqual({ kind: "unpack" })
  })
})

describe("one worklist, one filter", () => {
  it("All shows every row; To prepare keeps no bought label; the others keep no order", () => {
    expect(showsToPrepare("all")).toBe(true)
    expect(showsToPrepare("to_prepare")).toBe(true)
    expect(readyRowMatches(row(), "to_prepare")).toBe(false)
    expect(readyRowMatches(row(), "all")).toBe(true)
    expect(showsToPrepare("ready")).toBe(false)
    expect(showsToPrepare("packed")).toBe(false)
  })

  it("a bought label goes through the same search and order filters as the orders", () => {
    const label: WorklistReadySearchRow = {
      ...row({ order_name: "#1042" }),
      recipient: "Dana Example",
      destination: "DE",
      invoice_ref: "INV-77",
      tracking_number: "1Z999",
      shipment_ref: "BXT-1",
      products: "2xAA",
    }
    const none = { search: "", country: "", tag: "", product: "" }
    expect(readyRowMatchesView(label, "all", none)).toBe(true)
    expect(readyRowMatchesView(label, "to_prepare", none)).toBe(false)
    expect(readyRowMatchesView(label, "all", { ...none, country: "de" })).toBe(true)
    expect(readyRowMatchesView(label, "all", { ...none, country: "FR" })).toBe(false)
    for (const q of ["dana", "#1042", "inv-77", "1z999", "bxt-1"]) {
      expect(readyRowMatchesView(label, "all", { ...none, search: q })).toBe(true)
    }
    expect(readyRowMatchesView(label, "all", { ...none, search: "nobody" })).toBe(false)
    expect(readyRowMatchesView(label, "all", { ...none, product: "aa" })).toBe(true)
    // A bought label has no Shopify tags: a tag filter keeps none.
    expect(readyRowMatchesView(label, "all", { ...none, tag: "vip" })).toBe(false)
  })

  it("an empty table says the true thing", () => {
    const base = { prepTotal: 0, readyTotal: 0, narrowed: false }
    expect(worklistEmptyKind({ ...base, filter: "all" })).toBe("nothing_to_prepare")
    expect(worklistEmptyKind({ ...base, filter: "packed" })).toBe("nothing_ready")
    expect(worklistEmptyKind({ ...base, filter: "packed", readyTotal: 2 })).toBe("no_match")
    expect(worklistEmptyKind({ ...base, filter: "to_prepare", readyTotal: 2 })).toBe(
      "nothing_to_prepare",
    )
    expect(worklistEmptyKind({ ...base, filter: "all", prepTotal: 3, narrowed: true })).toBe(
      "no_match",
    )
  })

  it("To pack and Packed split the bought labels by the tick", () => {
    const todo = row()
    const done = row({ packed: true, fulfillment_state: "fulfilled" })
    expect([todo, done].filter((r) => readyRowMatches(r, "to_pack"))).toEqual([todo])
    expect([todo, done].filter((r) => readyRowMatches(r, "packed"))).toEqual([done])
    expect([todo, done].filter((r) => readyRowMatches(r, "ready"))).toEqual([todo, done])
  })

  it("the retired routes open the worklist with their filter", () => {
    expect(worklistFilterForRoute("to-prepare", "")).toBe("to_prepare")
    expect(worklistFilterForRoute("ready", "?x=1")).toBe("ready")
    expect(worklistFilterForRoute("worklist", "?state=packed")).toBe("packed")
    expect(worklistFilterForRoute("worklist", "")).toBe("all")
    expect(worklistFilterForRoute("worklist", "?state=bogus")).toBe("all")
  })
})

// Prod walk 2026-10-05: opened from /boxtal/queue/to-prepare, the filter bar read "Ready to ship 0,
// Packed 0" while the same page opened from /boxtal/queue/ready read 1 and 1. The labels are now
// loaded by the worklist page itself, alive under every filter (Queues.tsx ShippingWorklist).
describe("filter counts do not depend on the route that opened the page", () => {
  it("counts come from the loaded rows alone", () => {
    const rows = [row({ packed: true, fulfillment_state: "fulfilled" })]
    expect(worklistFilterCounts(rows)).toEqual({ ready: 1, to_pack: 0, packed: 1 })
  })
})
