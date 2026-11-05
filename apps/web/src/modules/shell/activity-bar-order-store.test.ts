// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import type { ActivityBarEntry } from "~/framework/app-registry"
import {
  applyActivityBarOrder,
  customActivityBarOrder,
  moveActivityBarEntry,
  resetActivityBarOrderStore,
  setActivityBarOrder,
} from "./activity-bar-order-store"

function entry(id: string, order: number): ActivityBarEntry {
  return {
    id,
    icon: (() => null) as unknown as ActivityBarEntry["icon"],
    label: id,
    order,
    appId: id,
    tabAction: { type: id, entityId: id, label: id },
  }
}

describe("activity-bar-order-store", () => {
  beforeEach(() => {
    resetActivityBarOrderStore()
  })

  it("falls back to registered order when no custom order is set", () => {
    const sorted = applyActivityBarOrder([entry("b", 2), entry("a", 1), entry("c", 3)])
    expect(sorted.map((e) => e.id)).toEqual(["a", "b", "c"])
  })

  it("applies a persisted custom order and survives a reload (localStorage)", () => {
    setActivityBarOrder(["c", "a", "b"])
    const sorted = applyActivityBarOrder([entry("a", 1), entry("b", 2), entry("c", 3)])
    expect(sorted.map((e) => e.id)).toEqual(["c", "a", "b"])
    expect(JSON.parse(localStorage.getItem("liaison:activityBarOrder") ?? "[]")).toEqual([
      "c",
      "a",
      "b",
    ])
  })

  it("entries not in the custom order sort after customized ones, by registered order", () => {
    setActivityBarOrder(["c"])
    const sorted = applyActivityBarOrder([entry("a", 2), entry("b", 1), entry("c", 3)])
    expect(sorted.map((e) => e.id)).toEqual(["c", "b", "a"])
  })

  it("moveActivityBarEntry moves an entry down onto a target", () => {
    moveActivityBarEntry(["a", "b", "c"], "a", "c")
    expect(customActivityBarOrder()).toEqual(["b", "c", "a"])
  })

  it("moveActivityBarEntry moves an entry up onto a target", () => {
    moveActivityBarEntry(["a", "b", "c"], "c", "a")
    expect(customActivityBarOrder()).toEqual(["c", "a", "b"])
  })

  it("dropping an entry on itself is a no-op", () => {
    moveActivityBarEntry(["a", "b", "c"], "b", "b")
    expect(customActivityBarOrder()).toEqual([])
  })
})
