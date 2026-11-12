// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { hasWrongReturnCategory, missesProducts, needsQueueFacts } from "./queue-facts-backfill"

describe("needsQueueFacts", () => {
  it("selects a live, document-anchored row with no snapshot", () => {
    expect(needsQueueFacts({ id: "s1", document_ref: "inv-1", order_status: "CONFIRMED" })).toBe(
      true,
    )
    expect(needsQueueFacts({ id: "s1", document_ref: "inv-1", queue_facts: null })).toBe(true)
    // An empty object or an empty json string is "no snapshot", not "a snapshot of nothing".
    expect(needsQueueFacts({ id: "s1", document_ref: "inv-1", queue_facts: {} })).toBe(true)
    expect(needsQueueFacts({ id: "s1", document_ref: "inv-1", queue_facts: "{}" })).toBe(true)
  })

  it("never re-does a row that already has one: a real buy-time snapshot outranks a re-resolution", () => {
    expect(
      needsQueueFacts({
        id: "s1",
        document_ref: "inv-1",
        queue_facts: { items: 2, products: "2xET2", parcels: [] },
      }),
    ).toBe(false)
  })

  it("skips cancelled rows and rows with nothing to resolve from", () => {
    expect(needsQueueFacts({ id: "s1", document_ref: "inv-1", order_status: "CANCELLED" })).toBe(
      false,
    )
    expect(needsQueueFacts({ id: "s1", document_ref: null })).toBe(false)
  })
})

describe("hasWrongReturnCategory", () => {
  // The one value the backfill is allowed to overwrite: a return typed "sale" by the first
  // backfill run, which is how two repair returns came to read as sales on prod.
  it("redoes an inbound return whose snapshot claims sale", () => {
    expect(hasWrongReturnCategory("return", { category: "sale" })).toBe(true)
    expect(
      needsQueueFacts({
        id: "r1",
        kind: "return",
        document_ref: "inv-1",
        queue_facts: { category: "sale", items: 1 },
      }),
    ).toBe(true)
    expect(
      needsQueueFacts({
        id: "r1",
        kind: "return",
        document_ref: "inv-1",
        queue_facts: JSON.stringify({ category: "sale" }),
      }),
    ).toBe(true)
  })

  it("leaves outbound sales and deliberately-typed returns alone", () => {
    expect(hasWrongReturnCategory("outbound", { category: "sale" })).toBe(false)
    expect(hasWrongReturnCategory("return", { category: "repair" })).toBe(false)
    expect(hasWrongReturnCategory("return", { category: null })).toBe(false)
    expect(
      needsQueueFacts({
        id: "s1",
        document_ref: "inv-1",
        queue_facts: { category: "sale", items: 2, products: "2xET2" },
      }),
    ).toBe(false)
  })
})

describe("missesProducts", () => {
  it("redoes a snapshot that knows the count but not what the items are", () => {
    expect(missesProducts({ items: 3 })).toBe(true)
    expect(
      needsQueueFacts({ id: "s1", document_ref: "inv-1", queue_facts: { items: 3, parcels: [] } }),
    ).toBe(true)
  })

  it("leaves a complete snapshot, and one that genuinely knows neither, alone", () => {
    expect(missesProducts({ items: 3, products: "2xET2" })).toBe(false)
    expect(missesProducts({ items: null, products: null })).toBe(false)
  })
})
