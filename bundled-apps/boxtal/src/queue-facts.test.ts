// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The buy-time snapshot every Boxtal worklist row carries. Its whole point is that it does NOT
// re-resolve: what these tests pin is that the numbers are the ones that were true when the label
// was bought, and that a row without a snapshot degrades to dashes instead of throwing.
import { describe, expect, it } from "bun:test"
import { buildQueueFacts, EMPTY_QUEUE_FACTS, formatParcelDims, readQueueFacts } from "./queue-facts"

const DRAFT = {
  products: "2xET2, 1xHC",
  parcels: [
    { length: 30, width: 20, height: 10, weight: 2.5 },
    { length: 59, width: 38, height: 16, weight: 8 },
  ],
  recipient: "Emmanuel Plegat",
  recipient_country: "FR",
  category: "repair" as const,
  lineSummaries: [
    { line_kind: "goods", quantity: 2 },
    { line_kind: "goods", quantity: 1 },
    // Neither of these is a thing in the box; counting them made a 3-unit parcel read as 5.
    { line_kind: "shipping", quantity: 1 },
    { line_kind: "software", quantity: 1 },
  ],
}

describe("buildQueueFacts", () => {
  it("snapshots cartons, weight, goods-only units, category and the order", () => {
    const facts = buildQueueFacts(DRAFT, {
      order_name: "#3445",
      order_created_at: "2026-09-10T17:09:16.000Z",
      staff_note: "call before delivery",
    })
    expect(facts).toMatchObject({
      customer: "Emmanuel Plegat",
      destination: "FR",
      items: 3,
      // WHICH items, not just how many: the count alone still sent the operator to the invoice.
      products: "2xET2, 1xHC",
      weight: 10.5,
      package_count: 2,
      category: "repair",
      order_name: "#3445",
      order_created_at: "2026-09-10T17:09:16.000Z",
      staff_note: "call before delivery",
    })
    expect(facts.parcels).toHaveLength(2)
  })

  it("reports unknown as null, never as an empty box", () => {
    // A zero item count means "could not tell", and a row that claims 0 items / 0 kg reads as a
    // real measurement of nothing.
    const facts = buildQueueFacts({ parcels: [], lineSummaries: [] })
    expect(facts.items).toBeNull()
    expect(facts.weight).toBeNull()
    expect(facts.package_count).toBeNull()
    expect(facts.parcels).toEqual([])
  })
})

describe("products", () => {
  it("survives the round trip through the column", () => {
    const facts = buildQueueFacts(DRAFT)
    expect(readQueueFacts(JSON.stringify(facts)).products).toBe("2xET2, 1xHC")
  })

  it("is null, not a dash, when the summary could not name anything", () => {
    // summarizeProducts returns "-" when it has nothing; storing that would render a dash INSIDE
    // the cell's contents line instead of leaving the line out.
    expect(buildQueueFacts({ ...DRAFT, products: "-" }).products).toBeNull()
    expect(buildQueueFacts({ ...DRAFT, products: null }).products).toBeNull()
  })
})

describe("category on a return", () => {
  // Walking prod on 2026-09-14 caught this: both rows in the Returns queue showed the type
  // "sale" against repair returns, because "sale" is what a row carries when nobody set a
  // category. Saying nothing is honest; the Reason column already explains the return.
  it("does not assert the default sale type on an inbound return", () => {
    expect(buildQueueFacts({ ...DRAFT, category: "sale" }, {}, { kind: "return" }).category).toBeNull()
    expect(buildQueueFacts({ ...DRAFT, category: undefined }, {}, { kind: "return" }).category).toBeNull()
  })

  it("keeps a category someone actually chose, on a return as anywhere else", () => {
    expect(buildQueueFacts({ ...DRAFT, category: "repair" }, {}, { kind: "return" }).category).toBe("repair")
  })

  it("leaves outbound shipments alone", () => {
    expect(buildQueueFacts({ ...DRAFT, category: "sale" }, {}, { kind: "outbound" }).category).toBe("sale")
    expect(buildQueueFacts({ ...DRAFT, category: "sale" }).category).toBe("sale")
  })
})

describe("readQueueFacts", () => {
  it("round-trips what buildQueueFacts wrote, through JSON", () => {
    const facts = buildQueueFacts(DRAFT, { order_name: "#3445" })
    expect(readQueueFacts(JSON.parse(JSON.stringify(facts)))).toEqual(facts)
  })

  it("accepts a json column handed back as a string", () => {
    const facts = buildQueueFacts(DRAFT)
    expect(readQueueFacts(JSON.stringify(facts)).weight).toBe(10.5)
  })

  it("degrades to the empty snapshot instead of throwing on anything malformed", () => {
    // A worklist read must not fail because one row holds junk.
    for (const bad of [null, undefined, "", "not json", 42, [], { parcels: "nope" }]) {
      expect(() => readQueueFacts(bad)).not.toThrow()
    }
    expect(readQueueFacts(null)).toEqual(EMPTY_QUEUE_FACTS)
    expect(readQueueFacts("not json")).toEqual(EMPTY_QUEUE_FACTS)
    expect(readQueueFacts({ parcels: "nope" }).parcels).toEqual([])
  })

  it("drops parcel entries that are not parcels", () => {
    expect(readQueueFacts({ parcels: [{ weight: 2, length: 1, width: 1, height: 1 }, "junk", null] }).parcels)
      .toHaveLength(1)
  })
})

describe("formatParcelDims", () => {
  it("lists each carton's dimensions", () => {
    expect(formatParcelDims(DRAFT.parcels)).toBe("30x20x10, 59x38x16")
  })

  it("is empty when the cartons are unknown", () => {
    expect(formatParcelDims([])).toBe("")
  })
})

describe("buy-time SKUs and carrier family (document rules)", () => {
  it("keeps the goods lines' SKUs, de-duplicated, and the carrier family passed at buy", () => {
    const facts = buildQueueFacts(
      {
        lineSummaries: [
          { line_kind: "goods", quantity: 1, external_id: "SKU-A" },
          { line_kind: "goods", quantity: 2, external_id: " SKU-A " },
          { line_kind: "goods", quantity: 1, external_id: "SKU-B" },
          { line_kind: "shipping", quantity: 1, external_id: "SHIP" },
          { line_kind: "goods", quantity: 1, external_id: null },
        ],
      },
      {},
      { carrierFamily: "fedex" },
    )
    expect(facts.skus).toEqual(["SKU-A", "SKU-B"])
    expect(facts.carrier_family).toBe("fedex")
  })

  it("reads them back unchanged, and as null on a row written before they were kept", () => {
    const stored = JSON.stringify({ items: 1, products: "1xA", skus: ["SKU-A"], carrier_family: "ups" })
    expect(readQueueFacts(stored)).toMatchObject({ skus: ["SKU-A"], carrier_family: "ups" })
    expect(readQueueFacts({ items: 1, products: "1xA" })).toMatchObject({ skus: null, carrier_family: null })
    expect(EMPTY_QUEUE_FACTS.skus).toBeNull()
  })
})
