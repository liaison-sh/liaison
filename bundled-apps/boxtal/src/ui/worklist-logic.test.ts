// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ticket-10508 (one worklist) and ticket-10647 / ticket-10507 / ticket-10522 (the packed tick
// fulfils the order): the pure rules the worklist page renders.
import { describe, expect, it } from "bun:test"
import {
  packedToggleAction,
  readyRowClass,
  readyRowMatches,
  readyRowState,
  showsReady,
  showsToPrepare,
  type WorklistReadyRow,
  worklistFilterCounts,
  worklistFilterForRoute,
  worklistSections,
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
    const r = row({ fulfillment_state: "failed", fulfillment_error: "Order has no OPEN fulfillment orders" })
    expect(readyRowState(r)).toBe("fulfillment_failed")
    expect(readyRowClass(r)).toContain("bg-error")
  })

  it("on hold wins over a done row: a held parcel never looks done", () => {
    expect(readyRowClass(row({ status: "on_hold", packed: true, fulfillment_state: "fulfilled" }))).toContain("bg-error")
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
  it("All shows both halves; To prepare hides the bought labels; the others hide the orders", () => {
    expect(showsToPrepare("all") && showsReady("all")).toBe(true)
    expect(showsToPrepare("to_prepare")).toBe(true)
    expect(showsReady("to_prepare")).toBe(false)
    expect(showsToPrepare("ready")).toBe(false)
    expect(showsToPrepare("packed")).toBe(false)
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
// Packed 0" while the same page opened from /boxtal/queue/ready read 1 and 1. The labels are only
// loaded by the Ready to ship half, which the To prepare filter used to unmount.
describe("filter counts do not depend on the route that opened the page", () => {
  it("the Ready to ship half stays mounted (hidden) under every filter", () => {
    for (const f of ["all", "to_prepare", "ready", "to_pack", "packed"] as const) {
      expect(worklistSections(f).ready.mounted).toBe(true)
    }
    expect(worklistSections("to_prepare").ready.visible).toBe(false)
    expect(worklistSections(worklistFilterForRoute("to-prepare", "")).ready.mounted).toBe(true)
  })

  it("counts come from the loaded rows alone", () => {
    const rows = [row({ packed: true, fulfillment_state: "fulfilled" })]
    expect(worklistFilterCounts(rows)).toEqual({ ready: 1, to_pack: 0, packed: 1 })
  })
})
