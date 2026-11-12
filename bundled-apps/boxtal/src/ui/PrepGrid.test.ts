// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure-helper tests for PrepGrid (bun:test, no jsdom/Solid render). Mirrors
// ui-logic.test.tsx's discipline: pin the exported pure functions the grid
// relies on for filtering, product-chip derivation, money formatting, and
// offer/label rendering, without mounting the component.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  cartonLabel,
  comparePrepRows,
  currencyExponent,
  effectiveOffer,
  formatMoneyMinor,
  formatOffer,
  formatOfferOption,
  lastSyncLabel,
  matchesPrepFilter,
  nextSort,
  noteChanged,
  noteFromInput,
  orderSortValue,
  PREP_GRID_COLUMNS,
  type PrepOffer,
  type PrepRow,
  packageCountLabel,
  packageCountOptions,
  packageDetailTitle,
  packageDraftChanged,
  packageDraftIsUniform,
  packageDraftOf,
  packageDraftValid,
  packageOverridePayload,
  packageSummaryLine,
  parseNumericInput,
  productLabel,
  productsSummaryList,
  reasonIsRecheckable,
  setCarton,
  setCartonCount,
  sortPrepRows,
  staleQuoteRefs,
} from "./PrepGrid"

function makeRow(overrides: Partial<PrepRow> = {}): PrepRow {
  return {
    order_key: "so:5001",
    document_ref: "doc-1",
    anchor_kind: "invoice",
    invoice_ref: "INV-001",
    order_name: "#1001",
    order_created_at: "2026-07-01T00:00:00.000Z",
    customer: "Alice Example",
    destination: "US",
    order_tags: ["vip"],
    products: "1xES, 1xET2",
    grand_total_minor: 83880,
    currency: "EUR",
    parcels: [{ length: 30, width: 20, height: 15, weight: 2.4 }],
    package_count: 1,
    category: "sale",
    quote: {
      cheapest: {
        carrier: "Chronopost",
        service: "Chrono 13",
        offer_code: "CHRP-18",
        price_ht_minor: 1240,
        price_ttc_minor: 1488,
        currency: "EUR",
        delivery_date: "2026-07-05",
        eta_business_days: 2,
        is_pickup_point: false,
      },
      alternates: [],
      offers: [
        {
          carrier: "Chronopost",
          service: "Chrono 13",
          offer_code: "CHRP-18",
          price_ht_minor: 1240,
          price_ttc_minor: 1488,
          currency: "EUR",
          delivery_date: "2026-07-05",
          eta_business_days: 2,
          is_pickup_point: false,
        },
      ],
      selected_offer_code: null,
      selected: null,
      quoted_at: "2026-07-01T01:00:00.000Z",
      stale: false,
    },
    state: "ready",
    status: "to_prepare",
    status_note: null,
    staff_note: null,
    excluded: false,
    validated: false,
    invoice: {
      state: "issued",
      document_id: "doc-1",
      number: "INV-001",
      approval_id: null,
      kind: "invoice",
    },
    shipment: null,
    recipient: null,
    ...overrides,
  }
}

describe("staff note editing", () => {
  it("stores trimmed text and turns an empty field into a cleared note", () => {
    expect(noteFromInput("  Ship Friday  ")).toBe("Ship Friday")
    expect(noteFromInput("   ")).toBeNull()
    expect(noteFromInput("")).toBeNull()
  })

  it("a blur with nothing changed saves nothing; whitespace-only edits do not count", () => {
    expect(noteChanged("Ship Friday", "Ship Friday ")).toBe(false)
    expect(noteChanged(null, "  ")).toBe(false)
    expect(noteChanged(null, "x")).toBe(true)
    expect(noteChanged("x", "")).toBe(true)
  })
})

// The staff note is a line of the Order cell, never a column: the column pin below is what keeps
// the grid inside the viewport. The narrow Country column (ISO-2) is the one added since; it took
// the code off the Client cell's second line, so the client column did not grow.
describe("staff note lives in the Order cell", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
  it("has no Note header and renders NoteCell inside the order-name cell", () => {
    const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"))
    expect(thead).not.toContain(">Note<")
    const cell = src.slice(src.indexOf("{row.order_name ?? row.invoice_ref}"))
    expect(cell.indexOf("<NoteCell")).toBeLessThan(cell.indexOf("</td>"))
  })
  it("saves with a compare-and-set on the note the row showed", () => {
    expect(src).toContain(
      '"prep_set_note", { order_key: row.order_key, note, expected_note: row.staff_note }',
    )
  })
})

describe("currencyExponent", () => {
  it("2 for common currencies, 0 for zero-decimal currencies", () => {
    expect(currencyExponent("EUR")).toBe(2)
    expect(currencyExponent("usd")).toBe(2)
    expect(currencyExponent("JPY")).toBe(0)
    expect(currencyExponent("krw")).toBe(0)
  })
})

describe("formatMoneyMinor", () => {
  it("splits minor units by the currency's exponent, never a hardcoded /100", () => {
    expect(formatMoneyMinor(83880, "EUR")).toBe("838.80 EUR")
    expect(formatMoneyMinor(1240, "EUR")).toBe("12.40 EUR")
    expect(formatMoneyMinor(23900, "JPY")).toBe("23900 JPY")
    expect(formatMoneyMinor(-150, "EUR")).toBe("-1.50 EUR")
  })
  it("renders an em-dash-free placeholder for missing values", () => {
    expect(formatMoneyMinor(null, "EUR")).toBe("-")
    expect(formatMoneyMinor(100, null)).toBe("-")
  })
})

describe("productsSummaryList", () => {
  it("derives sorted, de-duplicated product tokens across rows", () => {
    const rows = [
      makeRow({ products: "1xES, 2xET2" }),
      makeRow({ document_ref: "doc-2", products: "3xES" }),
      makeRow({ document_ref: "doc-3", products: "-" }),
    ]
    expect(productsSummaryList(rows)).toEqual(["ES", "ET2"])
  })
  it("empty when every row has no resolvable products", () => {
    expect(productsSummaryList([makeRow({ products: "-" })])).toEqual([])
  })
  it("strips invoicing decimal quantity prefixes (01.000x) so tokens dedupe", () => {
    const rows = [
      makeRow({ products: "01.000xAtlas 2, 02.000xHard Cover" }),
      makeRow({ document_ref: "doc-2", products: "1xAtlas 2" }),
    ]
    expect(productsSummaryList(rows)).toEqual(["Atlas 2", "Hard Cover"])
  })
})

describe("productLabel", () => {
  it("names a Shopify variant GID by its trailing id", () => {
    expect(productLabel("gid://shopify/ProductVariant/50468186128715")).toBe("Variant …128715")
  })
  it("cuts a customs description at the separator and caps length", () => {
    expect(
      productLabel(
        "Black Silicone Skin — Replacement touch-sensitive pad for electronic musical instrument.",
      ),
    ).toBe("Black Silicone Skin")
    expect(productLabel("x".repeat(50))).toHaveLength(36)
  })
  it("passes short plain tokens through", () => {
    expect(productLabel("Tessera 2")).toBe("Tessera 2")
  })
})

describe("matchesPrepFilter", () => {
  const base = { search: "", country: "", tag: "", product: "", includeExcluded: false }

  it("hides excluded rows unless includeExcluded", () => {
    const row = makeRow({ excluded: true })
    expect(matchesPrepFilter(row, base)).toBe(false)
    expect(matchesPrepFilter(row, { ...base, includeExcluded: true })).toBe(true)
  })
  it("filters by country (case-insensitive exact match)", () => {
    const row = makeRow({ destination: "US" })
    expect(matchesPrepFilter(row, { ...base, country: "us" })).toBe(true)
    expect(matchesPrepFilter(row, { ...base, country: "FR" })).toBe(false)
  })
  it("filters by tag (case-insensitive exact match against any tag)", () => {
    const row = makeRow({ order_tags: ["VIP", "rush"] })
    expect(matchesPrepFilter(row, { ...base, tag: "vip" })).toBe(true)
    expect(matchesPrepFilter(row, { ...base, tag: "wholesale" })).toBe(false)
  })
  it("filters by product substring", () => {
    const row = makeRow({ products: "1xES, 1xET2" })
    expect(matchesPrepFilter(row, { ...base, product: "ET2" })).toBe(true)
    expect(matchesPrepFilter(row, { ...base, product: "ZZZ" })).toBe(false)
  })
  it("filters by free-text search across invoice/order/customer/destination", () => {
    const row = makeRow({
      invoice_ref: "INV-042",
      order_name: "#2002",
      customer: "Bob Builder",
      destination: "FR",
    })
    expect(matchesPrepFilter(row, { ...base, search: "bob" })).toBe(true)
    expect(matchesPrepFilter(row, { ...base, search: "2002" })).toBe(true)
    expect(matchesPrepFilter(row, { ...base, search: "nomatch" })).toBe(false)
  })
})

const OFFER_HOME: PrepOffer = {
  carrier: "Chronopost",
  service: "Chrono 13",
  offer_code: "CHRP-18",
  price_ht_minor: 1240,
  price_ttc_minor: 1488,
  currency: "EUR",
  delivery_date: null,
  eta_business_days: 2,
  is_pickup_point: false,
}
const OFFER_RELAY: PrepOffer = {
  carrier: "Mondial Relay",
  service: "Point Relais",
  offer_code: "MRLY-Point",
  price_ht_minor: 540,
  price_ttc_minor: 648,
  currency: "EUR",
  delivery_date: null,
  eta_business_days: 3,
  is_pickup_point: true,
}

describe("formatOffer", () => {
  it("renders carrier + formatted money", () => {
    expect(formatOffer(OFFER_HOME)).toBe("Chronopost: 12.40 EUR")
  })
})

describe("formatOfferOption", () => {
  it("labels a home offer with carrier, service, price HT, ETA and a Home tag (no dash punctuation)", () => {
    expect(formatOfferOption(OFFER_HOME)).toBe("Chronopost Chrono 13: 12.40 EUR, 2d, Home")
  })
  it("labels a relay offer with a Relay tag", () => {
    expect(formatOfferOption(OFFER_RELAY)).toBe("Mondial Relay Point Relais: 5.40 EUR, 3d, Relay")
  })
  it("omits the ETA clause when there is no computable ETA", () => {
    expect(formatOfferOption({ ...OFFER_HOME, eta_business_days: null })).toBe(
      "Chronopost Chrono 13: 12.40 EUR, Home",
    )
  })
})

describe("effectiveOffer", () => {
  const base = { alternates: [], offers: [OFFER_HOME, OFFER_RELAY], quoted_at: null, stale: false }
  it("returns the operator's chosen offer when one is selected", () => {
    expect(
      effectiveOffer({
        ...base,
        cheapest: OFFER_HOME,
        selected_offer_code: "MRLY-Point",
        selected: OFFER_RELAY,
      }),
    ).toBe(OFFER_RELAY)
  })
  it("falls back to the cheapest when nothing is chosen", () => {
    expect(
      effectiveOffer({ ...base, cheapest: OFFER_HOME, selected_offer_code: null, selected: null }),
    ).toBe(OFFER_HOME)
  })
})

describe("packageCountLabel", () => {
  it("pluralizes correctly", () => {
    expect(packageCountLabel(1)).toBe("1 package")
    expect(packageCountLabel(2)).toBe("2 packages")
    expect(packageCountLabel(0)).toBe("0 packages")
  })
})

describe("lastSyncLabel", () => {
  it("never synced for null/invalid, otherwise a localized timestamp", () => {
    expect(lastSyncLabel(null)).toBe("Never synced")
    expect(lastSyncLabel("not-a-date")).toBe("Never synced")
    expect(lastSyncLabel("2026-07-01T00:00:00.000Z")).toContain("2026")
  })
})

describe("staleQuoteRefs", () => {
  it("collects stale and quote_missing rows, in row order", () => {
    const rows = [
      makeRow({ document_ref: "fresh" }),
      makeRow({ document_ref: "stale-1", quote: { ...makeRow().quote, stale: true } }),
      makeRow({
        document_ref: "missing-1",
        state: "quote_missing",
        quote: {
          cheapest: null,
          alternates: [],
          offers: [],
          selected_offer_code: null,
          selected: null,
          quoted_at: null,
          stale: false,
        },
      }),
    ]
    expect(staleQuoteRefs(rows)).toEqual(["stale-1", "missing-1"])
  })

  it("skips excluded and needs_fix rows even when their quote is stale", () => {
    const rows = [
      makeRow({
        document_ref: "excluded",
        excluded: true,
        quote: { ...makeRow().quote, stale: true },
      }),
      makeRow({
        document_ref: "broken",
        state: "needs_fix",
        reason: "missing weight",
        quote: { ...makeRow().quote, stale: true },
      }),
    ]
    expect(staleQuoteRefs(rows)).toEqual([])
  })

  it("empty worklist yields no refs", () => {
    expect(staleQuoteRefs([])).toEqual([])
  })
})

// ── Package editing: manual edit then an explicit re-quote (Quinn, 2026-08-02) ──
//
// The grid used to commit + re-quote on every blur, so typing a carton's three
// dimensions fired three live Boxtal quotes and the operator could not stage an
// edit. Editing is now local: the row goes dirty, a per-row "Refresh quote"
// button appears, and only that button persists the override and re-quotes.
describe("packageDraftOf / packageDraftChanged", () => {
  const row = makeRow({
    parcels: [{ length: 40, width: 30, height: 20, weight: 2.5 }],
    package_count: 1,
  })
  const C = (length: number, width: number, height: number, weight: number) => ({
    length,
    width,
    height,
    weight,
  })

  it("seeds one carton per resolved parcel", () => {
    expect(packageDraftOf(row)).toEqual({ cartons: [C(40, 30, 20, 2.5)] })
  })

  it("seeds a single zeroed carton for a row with no resolved parcel", () => {
    expect(packageDraftOf(makeRow({ parcels: [], package_count: 0 }))).toEqual({
      cartons: [C(0, 0, 0, 0)],
    })
  })

  it("keeps EVERY carton of a mixed shipment, with its own dims and weight", () => {
    // The real shape this editor exists for: one master carton plus three small
    // accessory boxes (INV-2026-3357). Seeding from parcels[0] alone -- the old
    // behaviour -- silently dropped the other three.
    const mixed = makeRow({
      parcels: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8), C(46, 33, 4, 0.8), C(46, 33, 4, 0.8)],
      package_count: 4,
    })
    expect(packageDraftOf(mixed).cartons).toEqual([
      C(58, 38, 42, 20.5),
      C(46, 33, 4, 0.8),
      C(46, 33, 4, 0.8),
      C(46, 33, 4, 0.8),
    ])
  })

  it("expands a uniform row persisted as a quantity up to its stated count", () => {
    const multi = makeRow({ parcels: [C(40, 30, 20, 2.5)], package_count: 3 })
    expect(packageDraftOf(multi).cartons).toEqual([
      C(40, 30, 20, 2.5),
      C(40, 30, 20, 2.5),
      C(40, 30, 20, 2.5),
    ])
  })

  it("is not dirty for an untouched draft, mixed sets included", () => {
    expect(packageDraftChanged(row, packageDraftOf(row))).toBe(false)
    const mixed = makeRow({ parcels: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8)], package_count: 2 })
    expect(packageDraftChanged(mixed, packageDraftOf(mixed))).toBe(false)
  })

  it("goes dirty on any dimension or weight edit, on any carton", () => {
    const base = packageDraftOf(row)
    for (const patch of [{ length: 41 }, { width: 31 }, { height: 21 }, { weight: 2.6 }]) {
      expect(packageDraftChanged(row, setCarton(base, 0, patch))).toBe(true)
    }
    const mixed = makeRow({ parcels: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8)], package_count: 2 })
    // An edit to the SECOND carton must register; the old single-carton model
    // could not even express this.
    expect(packageDraftChanged(mixed, setCarton(packageDraftOf(mixed), 1, { weight: 0.9 }))).toBe(
      true,
    )
  })

  it("goes dirty on a package-count change", () => {
    expect(packageDraftChanged(row, setCartonCount(packageDraftOf(row), 2))).toBe(true)
  })

  it("treats an edit back to the original value as clean (no stale button)", () => {
    const base = packageDraftOf(row)
    expect(packageDraftChanged(row, setCarton(base, 0, { length: 41 }))).toBe(true)
    expect(packageDraftChanged(row, setCarton(base, 0, { length: 40 }))).toBe(false)
  })
})

describe("setCarton / setCartonCount", () => {
  const C = (length: number, width: number, height: number, weight: number) => ({
    length,
    width,
    height,
    weight,
  })
  const mixed = { cartons: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8), C(46, 33, 4, 0.8)] }

  it("setCarton edits one carton and leaves its siblings untouched", () => {
    const next = setCarton(mixed, 1, { weight: 1.2 })
    expect(next.cartons[1]).toEqual(C(46, 33, 4, 1.2))
    expect(next.cartons[0]).toEqual(C(58, 38, 42, 20.5))
    expect(next.cartons[2]).toEqual(C(46, 33, 4, 0.8))
  })

  it("setCarton does not mutate the input draft", () => {
    setCarton(mixed, 0, { length: 99 })
    expect(mixed.cartons[0]).toEqual(C(58, 38, 42, 20.5))
  })

  it("growing a MIXED set keeps every existing carton and clones the last", () => {
    // THE regression this model exists to prevent: the old count dropdown
    // rebuilt the set from carton #1, turning a 20.5 kg master carton plus two
    // 0.8 kg boxes into four 20.5 kg cartons -- a wrong quote and a wrong label.
    const next = setCartonCount(mixed, 4)
    expect(next.cartons).toEqual([
      C(58, 38, 42, 20.5),
      C(46, 33, 4, 0.8),
      C(46, 33, 4, 0.8),
      C(46, 33, 4, 0.8),
    ])
  })

  it("shrinking drops from the end", () => {
    expect(setCartonCount(mixed, 2).cartons).toEqual([C(58, 38, 42, 20.5), C(46, 33, 4, 0.8)])
  })

  it("never goes below one carton", () => {
    expect(setCartonCount(mixed, 0).cartons).toHaveLength(1)
    expect(setCartonCount(mixed, -3).cartons).toHaveLength(1)
  })
})

describe("packageDraftValid", () => {
  const ok = { cartons: [{ length: 40, width: 30, height: 20, weight: 2.5 }] }

  it("requires every dimension and the weight to be positive", () => {
    expect(packageDraftValid(ok)).toBe(true)
    expect(packageDraftValid(setCarton(ok, 0, { length: 0 }))).toBe(false)
    expect(packageDraftValid(setCarton(ok, 0, { weight: 0 }))).toBe(false)
    expect(packageDraftValid(setCarton(ok, 0, { height: -1 }))).toBe(false)
  })

  it("rejects a half-typed input (NaN from an emptied field)", () => {
    expect(packageDraftValid(setCarton(ok, 0, { length: Number.NaN }))).toBe(false)
  })

  it("rejects when ANY carton is incomplete, not just the first", () => {
    // A mixed set is only shippable when every box is fully described.
    const two = setCartonCount(ok, 2)
    expect(packageDraftValid(two)).toBe(true)
    expect(packageDraftValid(setCarton(two, 1, { weight: 0 }))).toBe(false)
  })

  it("rejects an empty set", () => {
    expect(packageDraftValid({ cartons: [] })).toBe(false)
  })
})

describe("packageOverridePayload", () => {
  const C = (length: number, width: number, height: number, weight: number) => ({
    length,
    width,
    height,
    weight,
  })

  it("sends a single carton with no quantity key", () => {
    expect(packageOverridePayload({ cartons: [C(40, 30, 20, 2.5)] })).toEqual(C(40, 30, 20, 2.5))
  })

  it("sends N identical cartons as a quantity, the shape set_package expands", () => {
    // Unchanged wire format for the uniform case: a row that shipped fine before
    // must send byte-identical params after this change.
    expect(
      packageOverridePayload({
        cartons: [C(40, 30, 20, 2.5), C(40, 30, 20, 2.5), C(40, 30, 20, 2.5)],
      }),
    ).toEqual({ ...C(40, 30, 20, 2.5), quantity: 3 })
  })

  it("sends a MIXED set as an array, one entry per carton", () => {
    // shipment_draft_set_package has always accepted SetPackageOverrideItem[];
    // this is the shape the editor could not previously produce.
    expect(packageOverridePayload({ cartons: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8)] })).toEqual([
      C(58, 38, 42, 20.5),
      C(46, 33, 4, 0.8),
    ])
  })

  it("never collapses a mixed set into a quantity", () => {
    const payload = packageOverridePayload({ cartons: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8)] })
    expect(Array.isArray(payload)).toBe(true)
    expect((payload as unknown as Record<string, unknown>).quantity).toBeUndefined()
  })
})

describe("packageDraftIsUniform", () => {
  const C = (length: number, width: number, height: number, weight: number) => ({
    length,
    width,
    height,
    weight,
  })
  it("is true for one carton and for N identical cartons", () => {
    expect(packageDraftIsUniform({ cartons: [C(40, 30, 20, 2.5)] })).toBe(true)
    expect(packageDraftIsUniform({ cartons: [C(40, 30, 20, 2.5), C(40, 30, 20, 2.5)] })).toBe(true)
  })
  it("is false as soon as one carton differs, including only by weight", () => {
    expect(packageDraftIsUniform({ cartons: [C(40, 30, 20, 2.5), C(40, 30, 20, 2.6)] })).toBe(false)
  })
})

describe("cartonLabel", () => {
  it("reads as a compact box description", () => {
    expect(cartonLabel({ length: 46, width: 33, height: 4, weight: 0.8 })).toBe(
      "46x33x4 cm, 0.8 kg",
    )
  })
})

describe("packageSummaryLine", () => {
  const C = (length: number, width: number, height: number, weight: number) => ({
    length,
    width,
    height,
    weight,
  })

  it("reads as dims + weight for a single carton", () => {
    expect(packageSummaryLine({ cartons: [C(58, 36, 7, 1.8)] })).toBe("58x36x7cm 1.8kg")
  })

  it("prefixes the count for N identical cartons, never repeating the dims", () => {
    expect(
      packageSummaryLine({ cartons: [C(58, 36, 7, 1.8), C(58, 36, 7, 1.8), C(58, 36, 7, 1.8)] }),
    ).toBe("3x 58x36x7cm 1.8kg")
  })

  it("collapses a mixed set to a count, never to the first carton's figures", () => {
    const line = packageSummaryLine({
      cartons: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8), C(30, 20, 10, 0.5)],
    })
    expect(line).toBe("mixed (3)")
    expect(line).not.toContain("58")
  })

  it("does not claim a package for an empty draft", () => {
    expect(packageSummaryLine({ cartons: [] })).toBe("0 packages")
  })
})

describe("packageDetailTitle", () => {
  const C = (length: number, width: number, height: number, weight: number) => ({
    length,
    width,
    height,
    weight,
  })

  it("names every carton, so the compact line's hover never hides one", () => {
    const title = packageDetailTitle({ cartons: [C(58, 38, 42, 20.5), C(46, 33, 4, 0.8)] })
    expect(title).toBe("#1 58x38x42 cm, 20.5 kg / #2 46x33x4 cm, 0.8 kg")
  })

  it("still names a single carton (no bare summary that drops the count)", () => {
    expect(packageDetailTitle({ cartons: [C(40, 30, 20, 2.5)] })).toBe("#1 40x30x20 cm, 2.5 kg")
  })
})

describe("packageCountOptions", () => {
  it("offers 1..10 by default", () => {
    expect(packageCountOptions(1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it("stretches to include a row that already carries more parcels than the default max", () => {
    expect(packageCountOptions(12).at(-1)).toBe(12)
    expect(packageCountOptions(12)).toContain(11)
  })

  it("never drops below a single package", () => {
    expect(packageCountOptions(0)[0]).toBe(1)
  })
})

describe("reasonIsRecheckable (the blocked-row dead end)", () => {
  // "Refresh stale" deliberately skips needs_fix rows and the per-row "Refresh
  // quote" button only appears once a package edit is staged, so a row blocked on
  // a DERIVED value had no way back in this grid at all.
  it("offers a recheck for the derived customs value", () => {
    expect(reasonIsRecheckable("Customs value needs a manual EUR amount")).toBe(true)
    expect(reasonIsRecheckable("Missing customs value")).toBe(true)
  })

  it("does NOT offer one where a human must edit the catalog first", () => {
    // Promising a recheck that cannot possibly clear the block is worse than no
    // button: it sends the operator round a loop instead of to the fix.
    for (const r of [
      "Missing weight",
      "Missing HS code",
      "Missing country of origin",
      "Bad address",
      "No shippable lines",
      "Unresolved pack",
    ]) {
      expect(reasonIsRecheckable(r)).toBe(false)
    }
  })

  it("is false for a row with no reason at all", () => {
    expect(reasonIsRecheckable(undefined)).toBe(false)
  })
})

// Regression (ticket-10196 / ticket-10220): the carton dims and weight were
// `<input type="number">` bound straight to the numeric model, so every
// keystroke round-tripped through `Number()` and back onto the element. That
// destroys anything the browser cannot parse yet: a number input reports "" for
// a half-typed decimal, so "0.5" became 5, and `Number()` normalises a trailing
// zero away, so "4.0" collapsed to "4" mid-typing. The fields now hold the raw
// text while focused and parse it with this, which is what the tests below pin.
describe("parseNumericInput — what the operator typed survives", () => {
  it("keeps a half-typed decimal out of the model instead of reading it as zero", () => {
    // "0." is the exact intermediate state that used to reset the field to "0"
    // and send the next keystroke to the wrong decimal place.
    expect(parseNumericInput("0.")).toBe(0)
    expect(parseNumericInput("")).toBeNull()
    expect(parseNumericInput("   ")).toBeNull()
  })

  it("parses tenths of a kg", () => {
    expect(parseNumericInput("0.5")).toBe(0.5)
    expect(parseNumericInput("2.5")).toBe(2.5)
    expect(parseNumericInput("12.8")).toBe(12.8)
  })

  it("accepts a comma as the decimal separator (French keypad)", () => {
    expect(parseNumericInput("0,5")).toBe(0.5)
    expect(parseNumericInput("12,8")).toBe(12.8)
  })

  it("parses a value with a trailing zero to the same number it displays", () => {
    expect(parseNumericInput("40")).toBe(40)
    expect(parseNumericInput("4.0")).toBe(4)
    expect(parseNumericInput("30")).toBe(30)
  })

  it("rejects junk rather than coercing it to a number", () => {
    for (const junk of ["abc", "1.2.3", "-5", "1e3", "4 5"]) {
      expect(parseNumericInput(junk)).toBeNull()
    }
  })
})

// Structural oracle for the carton editor's list keying.
//
// This one scrapes the source, which is normally the wrong kind of test -- the
// step="0.1" test it sits next to did exactly that and passed for weeks while
// the field was unusable. It earns its place because the invariant IS
// structural and has no pure-function surface to assert against: the editable
// carton list must be keyed by POSITION, not by object reference.
//
// <For> keys by reference. patchCarton builds a new carton object per keystroke,
// so under <For> the edited row's DOM subtree is destroyed and rebuilt on every
// character, the focused <input> is replaced by a fresh element, and every
// keystroke after the first lands on nothing. Typing "40" left "4"; "0.5" left
// "0". That is invisible to every pure-function test in this file, and it was
// caught only by driving the real deployed grid (gestalt walk, 2026-08-27).
//
// The BEHAVIOURAL oracle for this lives in the gestalt walk, which types a
// decimal into a real field and reads back what the field holds. This is the
// cheap tripwire that fails fast in CI if someone reaches for <For> again.
describe("carton editor list keying", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
  const cartonList = src.slice(
    src.indexOf("each={cartons()}") - 200,
    src.indexOf("each={cartons()}") + 200,
  )

  it("iterates the carton list with <Index>, never <For>", () => {
    expect(cartonList).toContain("<Index each={cartons()}>")
    expect(cartonList).not.toContain("<For each={cartons()}>")
  })
})

// ticket-10221: the grid had no sort at all -- rows arrived in whatever order
// prep_list returned, so "work through today's orders by number" meant scrolling
// and remembering where you were.
describe("prep grid sorting", () => {
  const row = (over: Partial<PrepRow>) => makeRow(over)

  it("sorts order names NUMERICALLY, so #99 comes before #100", () => {
    // The trap a plain string compare falls into, and the reason this helper
    // exists rather than a localeCompare on order_name.
    const out = sortPrepRows(
      [row({ order_name: "#100" }), row({ order_name: "#99" }), row({ order_name: "#3362" })],
      { key: "order", dir: "asc" },
    )
    expect(out.map((r) => r.order_name)).toEqual(["#99", "#100", "#3362"])
  })

  it("reverses on desc", () => {
    const out = sortPrepRows([row({ order_name: "#1" }), row({ order_name: "#2" })], {
      key: "order",
      dir: "desc",
    })
    expect(out.map((r) => r.order_name)).toEqual(["#2", "#1"])
  })

  it("sorts a row with NO order name last in both directions", () => {
    // Not a hole in the sequence -- a row with no place in it.
    for (const dir of ["asc", "desc"] as const) {
      const out = sortPrepRows(
        [row({ order_name: null }), row({ order_name: "#5" }), row({ order_name: "#7" })],
        { key: "order", dir },
      )
      expect(out[2]!.order_name).toBeNull()
    }
  })

  it("sorts an UNPRICED row last in both directions, never as cheapest", () => {
    // A null total is unknown, not zero. Burying it at the cheap end would read
    // as a fact the row does not carry.
    for (const dir of ["asc", "desc"] as const) {
      const out = sortPrepRows(
        [
          row({ grand_total_minor: null }),
          row({ grand_total_minor: 5000 }),
          row({ grand_total_minor: 100 }),
        ],
        { key: "total", dir },
      )
      expect(out[2]!.grand_total_minor).toBeNull()
    }
  })

  it("sorts by client name", () => {
    const out = sortPrepRows([row({ customer: "Zed" }), row({ customer: "Ada" })], {
      key: "client",
      dir: "asc",
    })
    expect(out.map((r) => r.customer)).toEqual(["Ada", "Zed"])
  })

  it("sorts by country, a row without one last in both directions", () => {
    const rows = [
      row({ destination: "US", customer: "a" }),
      row({ destination: "", customer: "b" }),
      row({ destination: "DE", customer: "c" }),
    ]
    expect(sortPrepRows(rows, { key: "country", dir: "asc" }).map((r) => r.customer)).toEqual([
      "c",
      "a",
      "b",
    ])
    expect(sortPrepRows(rows, { key: "country", dir: "desc" }).map((r) => r.customer)).toEqual([
      "a",
      "c",
      "b",
    ])
  })

  it("never mutates the array it was given", () => {
    const input = [row({ order_name: "#2" }), row({ order_name: "#1" })]
    sortPrepRows(input, { key: "order", dir: "asc" })
    expect(input.map((r) => r.order_name)).toEqual(["#2", "#1"])
  })

  it("returns the server order untouched when nothing is selected", () => {
    const input = [row({ order_name: "#2" }), row({ order_name: "#1" })]
    expect(sortPrepRows(input, null)).toBe(input)
  })

  it("cycles asc -> desc -> off, so a sort is never a trap", () => {
    expect(nextSort(null, "order")).toEqual({ key: "order", dir: "asc" })
    expect(nextSort({ key: "order", dir: "asc" }, "order")).toEqual({ key: "order", dir: "desc" })
    expect(nextSort({ key: "order", dir: "desc" }, "order")).toBeNull()
  })

  it("switching column starts that column ascending", () => {
    expect(nextSort({ key: "order", dir: "desc" }, "client")).toEqual({ key: "client", dir: "asc" })
  })

  it("falls back to the invoice ref when an order has no name", () => {
    expect(orderSortValue(makeRow({ order_name: null, invoice_ref: "INV-9" })).text).toBe("INV-9")
  })

  it("compares equal rows as equal (stable input order survives)", () => {
    const a = makeRow({ order_name: "#5" }),
      b = makeRow({ order_name: "#5" })
    expect(comparePrepRows(a, b, { key: "order", dir: "asc" })).toBe(0)
  })
})

// ticket-10184: single-carton rows used to render collapsed while mixed sets
// rendered expanded, so dimensions were not scannable down a column and every
// row had to be parsed on its own terms. The default flipped back to collapsed
// (packageSummaryLine fixes the layout overlap with the sticky Actions column),
// but the ORIGINAL defect -- one row shape for mixed sets and a different one
// for uniform sets -- must still never come back: every row opens (or starts
// collapsed) the same way regardless of what is in its carton set.
describe("carton rows render uniformly", () => {
  it("does not condition the default on whether the set is mixed", () => {
    const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
    const decl = src.slice(
      src.indexOf("const [expanded, setExpanded]") - 700,
      src.indexOf("const [expanded, setExpanded]") + 120,
    )
    expect(decl).toContain("createSignal(false)")
    expect(decl).not.toContain("!packageDraftIsUniform(persisted())")
    expect(decl).not.toContain("packageDraftIsUniform(persisted())")
  })
})

// Regression (found by driving the deployed screen, 2026-08-27): the unlinked-orders
// counter-check was loaded with createResource, which participates in Suspense. That read scans
// Shopify and then asks invoicing about each candidate, so sharing the grid's Suspense boundary
// made the ENTIRE To-prepare worklist render nothing until both cross-app round trips finished.
//
// The strip itself is GONE as of the order-driven rework: an order with no invoice is now a ROW,
// so the counter-check has nothing left to count and the grid makes no secondary read at all. That
// is the stronger form of the same guarantee, and it is what this pins now. `prep_unlinked_list`
// survives as an agent tool.
describe("the worklist makes no secondary read that could gate it", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")

  it("no longer calls prep_unlinked_list: an un-invoiced order is a row, not a warning strip", () => {
    expect(src).not.toContain("prep_unlinked_list")
    expect(src).not.toContain("boxtal-prep-unlinked")
  })

  it("has exactly one createResource, the worklist read itself", () => {
    expect(src.match(/createResource/g) ?? []).toHaveLength(1)
  })
})

// A sortable column must LOOK sortable. Hiding the affordance until hover makes
// it indistinguishable from a fixed column, which is the same defect as
// ticket-10174 on the Home rows -- and it was reintroduced here and only caught
// by looking at the rendered grid.
describe("sort affordance is visible at rest", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
  const sortTh = src.slice(src.indexOf("const SortTh"), src.indexOf("const SortTh") + 1800)

  it("dims the arrow rather than hiding it", () => {
    expect(sortTh).toContain("opacity-40")
    expect(sortTh).not.toContain('"opacity-0 ')
  })

  it("uses opacity, never display, so the header cannot resize under the cursor", () => {
    // `aria-hidden` is not the Tailwind `hidden` class; only the latter would
    // change the header's box and shift it as the cursor crosses.
    expect(sortTh.replace(/aria-hidden/g, "")).not.toMatch(/\bhidden\b/)
  })
})

// The poll loop used to be a fixed setInterval(..., 5000) that ignored pollPlan's own intervalMs
// (3000 for invoice_pdf) and timeoutMs entirely, bounded only by accident (labelState itself stops
// asking for "waiting" past LABEL_WAIT_MS). A structural oracle, in the style already used above for
// the carton keying and sort affordance: the pure functions this closure calls are already pinned
// (labelState/pollPlan in prep-row-logic.test.ts), what is missing is proof PrepGrid actually reads
// intervalMs/timeoutMs from the plan rather than a fixed constant.
//
// The per-row cadence/timeout decision itself lives in the exported `pollTick` helper
// (prep-row-logic.ts), extracted so it is unit-testable without a DOM harness; PrepGrid.tsx's tick
// just calls it and acts on the result. So the cadence/timeout assertions read pollTick's own body,
// while the "ticks at 1s" assertion still reads the PrepGrid.tsx setInterval call.
describe("poll loop honours the plan's own cadence and deadline, not a fixed tick", () => {
  const gridSrc = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
  const logicSrc = readFileSync(new URL("./prep-row-logic.ts", import.meta.url), "utf8")
  const tickCall = gridSrc.slice(
    gridSrc.indexOf("const pollTimer = setInterval"),
    gridSrc.indexOf("onCleanup(() => clearInterval(pollTimer))"),
  )
  // Bound the slice on the function's REAL end (the next top level export), never a character
  // count: a fixed window silently stops covering the tail the moment the body grows.
  const pollTickStart = logicSrc.indexOf("export function pollTick")
  const pollTickNextExport = logicSrc.indexOf("\nexport ", pollTickStart + 1)
  const pollTickFn = logicSrc.slice(
    pollTickStart,
    pollTickNextExport === -1 ? logicSrc.length : pollTickNextExport,
  )

  it("ticks at 1s so it can honour a per-row cadence shorter than 5s", () => {
    expect(tickCall).toContain("}, 1000)")
  })

  it("reads intervalMs and timeoutMs off the row's own pollPlan rather than a constant", () => {
    expect(pollTickFn).toContain("plan.intervalMs")
    expect(pollTickFn).toContain("plan.timeoutMs")
    expect(pollTickFn).toContain("pollPlan(row, now)")
  })

  it("tracks when each row's poll window started, so a row is dropped once its OWN timeoutMs elapses", () => {
    expect(pollTickFn).toContain("state.startedAt")
    expect(pollTickFn).toContain("now - state.startedAt > plan.timeoutMs")
  })
})

// patchRow has no per-row generation guard by default: a poll read issued before a mutation starts
// can resolve AFTER the mutation's own patch and silently put the pre-mutation row back on screen
// (findings this fixes). Structural oracle for the same reason as above: the fencing lives inside a
// Solid closure this test file cannot mount.
describe("patchRow fences stale reads behind a per-row ticket", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
  const fn = src.slice(
    src.indexOf("const patchRow = async"),
    src.indexOf("const patchRow = async") + 500,
  )

  it("bumps a per-key ticket before awaiting the read", () => {
    expect(fn).toContain("patchTickets.get(orderKey)")
    expect(fn).toContain("patchTickets.set(orderKey, ticket)")
  })

  it("drops the read if a newer ticket for the same key was issued while it was in flight", () => {
    expect(fn).toContain("patchTickets.get(orderKey) !== ticket")
  })
})

// Status and exclusion used to await the tool call before touching the row at all, so an Exclude
// click left the row on screen (and a status click left the tint unmoved) for the whole round trip
// -- the exact lag the rework exists to remove. Each handler now calls `patchRows` BEFORE its
// `runMutation`, and reverts via a second `patchRows` in the tool call's own catch on failure.
describe("setStatus / excludeRow / restoreRow apply optimistically before the round trip", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")

  for (const [name, patched] of [
    ["setStatus", "status, validated: status ==="],
    ["excludeRow", "excluded: true"],
    ["restoreRow", "excluded: false"],
  ] as const) {
    it(`${name} patches the row locally before calling runMutation`, () => {
      const start = src.indexOf(`const ${name} = (row: PrepRow`)
      expect(start, `${name} not found`).toBeGreaterThan(-1)
      const body = src.slice(start, start + 700)
      const patchIdx = body.indexOf("patchRows(")
      const mutationIdx = body.indexOf("return runMutation(")
      expect(patchIdx, `${name} never calls patchRows`).toBeGreaterThan(-1)
      expect(mutationIdx, `${name} never calls runMutation`).toBeGreaterThan(-1)
      expect(patchIdx).toBeLessThan(mutationIdx)
      expect(body).toContain(patched)
    })

    it(`${name} reverts the optimistic row when its tool call fails`, () => {
      const start = src.indexOf(`const ${name} = (row: PrepRow`)
      const body = src.slice(start, start + 700)
      expect(body).toContain("patchRows([previous], [row.order_key])")
    })
  }
})

// The truncation notice used to claim the 250 OLDEST orders were shown, but orders_search pages
// newest first (sortKey CREATED_AT, reverse: true, bundled-apps/shopify/src/reads.ts) -- with more
// than 250 open orders the truncated tail is the OLDEST ones, the opposite of what the old copy
// told the operator.
describe("the truncation notice names the newest-first scan order, not its opposite", () => {
  it("says the 250 shown are the most recent, and that older ones are dropped", () => {
    const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
    expect(src).toContain(
      "Showing the 250 most recently placed open orders. Older ones are not listed.",
    )
    expect(src).not.toContain("oldest open orders")
  })
})

// ticket 16bcb76a: a plugin navigation must go through the host `navigate` primitive. A hard
// window.location navigation tears down the SPA and drops out of the tab system. The prep grid's
// document control no longer NAVIGATES to the invoice (it downloads the PDF through the bearer file
// fetch), but the Approvals link is a navigation (the host's `app.openApprovals()`) and the rule
// still binds the whole file.
describe("in-app navigation", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")

  it("navigates through the host primitive", () => {
    expect(src).toContain("app.openApprovals()")
  })

  it("never hard-navigates via window.location", () => {
    expect(src).not.toContain("window.location.assign")
    expect(src).not.toContain("window.location.href")
  })
})

describe("the generating invoice state: a rendering PDF is a wait, not a failure", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")

  // Blueprint success criterion 5 lists `Generating` (a spinner while the PDF renders) as one of
  // the Invoice control's states, but nothing entered it: the backend deliberately never emits it
  // (one documents_download_pdf per row is the O(rows) cost this rework removed), and the download
  // handler turned a still-rendering PDF into a "Try again in a moment" row error. The state is
  // entered HERE, by the interaction that needs the file, and resolved by re-asking for the FILE.
  it("enters `generating` when prep_document_pdf answers generating, instead of erroring the row", () => {
    const dl = src.slice(src.indexOf("const downloadInvoice"), src.indexOf("const printLabel"))
    expect(dl).toContain('setInvoiceState(row, "generating")')
    // The old behaviour: a row error telling the operator to retry by hand. It must be gone.
    expect(dl).not.toContain("Try again in a moment")
  })

  it("resolves the wait by re-asking for the FILE, never by re-reading the row", () => {
    // A row re-read cannot end this wait: prep_list never reports `generating`, so patching the
    // row would clear the spinner without ever delivering the PDF. pollTick (prep-row-logic.ts)
    // keeps invoice_pdf keys out of the batched label read entirely (dueInvoicePdfKeys, a
    // separate array from dueLabelKeys); the tick then resolves each one individually.
    const poll = src.slice(
      src.indexOf("const pollTimer"),
      src.indexOf("onCleanup(() => clearInterval(pollTimer))"),
    )
    expect(poll).toContain("for (const key of dueInvoicePdfKeys) void retryInvoicePdf(key)")
    expect(poll).toContain("patchRowsBatch(dueLabelKeys)")
  })

  it("gives up out loud when the plan's own deadline passes", () => {
    const poll = src.slice(
      src.indexOf("const pollTimer"),
      src.indexOf("onCleanup(() => clearInterval(pollTimer))"),
    )
    const timeout = poll.slice(poll.indexOf("timedOutKeys"))
    expect(timeout).toContain("finishPdf(key,")
    expect(timeout).toContain("taking longer than a minute")
  })
})

// The grid has NO standalone Packages column, and the carton summary is a LINE
// of the total cell instead.
//
// Measured 2026-09-08 at 1440x900 with the agent panel open: the grid's scroll
// container is 812px wide, the opaque sticky Actions cell permanently occupies
// its right 238.5px, and a ninth column left the Packages cell at x
// 1096.6-1197.6 -- 23px of it under the sticky cell and the other 78px past the
// container's right edge, so the summary an operator is supposed to scan was
// invisible at rest. Compacting that cell could not fix it: 316px of overflow
// is not absorbed by tightening one column. Folding the summary into the total
// cell (money, shipping estimate, cartons -- the three figures that are read
// together) removed the column and 101px of content width, and the summary now
// renders at x 682.8-788.4, fully inside the viewport and well clear of the
// sticky edge at 881.5.
describe("no standalone Packages column", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
  const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"))

  // Nine since the narrow Country column (ISO-2, about 70px with its header) joined; the
  // headroom measured above (summary end 788.4 vs sticky edge 881.5) is what it spends.
  it("has no Packages header, and exactly nine columns", () => {
    expect(thead).not.toContain("Packages")
    const headers = thead.match(/<(Th|SortTh)\b/g) ?? []
    expect(headers.length).toBe(9)
  })

  it("renders the package cell INSIDE the total cell, under the shipping estimate", () => {
    const total = src.slice(src.indexOf("{formatMoneyMinor(row.grand_total_minor"))
    const estimate = total.indexOf("<ShippingEstimateCell")
    const pkg = total.indexOf("<PackageCell")
    const endOfCell = total.indexOf("</td>")
    expect(estimate).toBeGreaterThan(-1)
    // Both live in this one cell (before its closing tag), estimate first.
    expect(pkg).toBeGreaterThan(estimate)
    expect(pkg).toBeLessThan(endOfCell)
    // Its two fallbacks (no anchor / never synced) keep the ORIGINAL testid, so
    // every existing scenario and tool test still finds the same element.
    expect(total.slice(0, endOfCell)).toContain("boxtal-prep-packages-${row.order_key}")
  })

  // REVERSED 2026-09-08, by the owner, and the oracle turned around with it rather than
  // deleted: "the weird shadow between the actions columns and documents is useless". The
  // border-l-2 + leftward shadow was built to explain an OPAQUE overlay riding over a column
  // that had nowhere to go. That geometry no longer exists: the Actions column un-sticks the
  // moment the table overflows (the test below), so at every width where it IS pinned the
  // table fits and there is nothing behind it to explain. What has to be pinned now is the
  // ABSENCE of that decoration, which is a stronger claim than the old one: no shadow anywhere
  // in the grid, no vertical rule at that boundary, and the opaque ground still gated.
  it("pins the Actions column with NO edge decoration behind it", () => {
    expect(src).not.toContain("STICKY_ACTIONS_EDGE")
    // No box-shadow at all in this screen: the sticky cell was its only user.
    expect(src).not.toContain("shadow-[")
    // No vertical rule at the Actions boundary either -- no other column in the grid has one,
    // so a rule there reads as a data division the row does not have.
    expect(src).not.toContain("border-l-2")
    expect(src).not.toContain("border-l ")
    // The pin itself, and its opaque ground, survive untouched.
    expect(thead).toContain('actionsSticky() ? "right-0" : ""')
    const body = src.slice(src.indexOf("<tbody"))
    const actionsCell = body.slice(body.indexOf("actionsSticky()"))
    expect(actionsCell.slice(0, 300)).toContain("sticky right-0 z-10 bg-bg")
  })

  // The pin is CONDITIONAL. An opaque cell pinned over a table wider than its
  // container paints over content that has nowhere else to go (measured
  // 1440x900, agent panel open: 108.0px of the Document column under it). Below
  // the width where the table fits, Actions is a normal last column and the
  // grid scrolls. The decision is the CONTAINER's, because the agent panel
  // changes the container's width without changing the window's.
  it("un-sticks the Actions column when the table does not fit its container", () => {
    expect(src).toContain("const [actionsSticky, setActionsSticky] = createSignal(true)")
    // The trigger, and the thing it is measured on.
    expect(src).toContain("setActionsSticky(el.scrollWidth <= el.clientWidth)")
    expect(src).toContain("new ResizeObserver(() => measureSticky())")
    // Keyed on the scroll container, never on the window/viewport.
    expect(src).not.toContain("window.innerWidth")
    expect(src).not.toContain("matchMedia")
    // Both halves of the pin are gated: the header cell and the body cell.
    expect(thead).toContain('actionsSticky() ? "right-0" : ""')
    const body = src.slice(src.indexOf("<tbody"))
    expect(body).toContain("actionsSticky()")
    // Un-stuck, the OPAQUE ground comes off with the pin -- an un-pinned cell
    // that still paints bg-bg over the row would not fix anything.
    const actionsCell = body.slice(body.indexOf("actionsSticky()"))
    const gated = actionsCell.slice(0, actionsCell.indexOf(">"))
    expect(gated).toContain("bg-bg")
    expect(gated).toContain(': ""')
    // The container publishes the decision, so the e2e can pin it per geometry.
    expect(src).toContain('data-testid="boxtal-prep-grid-scroller"')
    expect(src).toContain("data-sticky-actions={String(actionsSticky())}")
    // Un-stuck, the scroll is the only way to the actions, and this platform's
    // overlay scrollbar paints nothing at rest (measured 0px of scrollbar), so
    // the affordance is stated in words -- and ONLY while it is true.
    const hint = src.slice(src.indexOf("boxtal-prep-grid-scroll-hint") - 400)
    expect(hint.slice(0, 700)).toContain("<Show when={!actionsSticky()}>")
    expect(hint.slice(0, 900)).toContain("Scroll right to reach them.")
  })

  it("caps the products cell, the only remaining content-driven width", () => {
    const at = src.indexOf("data-testid={`boxtal-prep-products-")
    const cell = src.slice(at - 600, at + 200)
    // The cell's own class attribute, isolated from the comment above it: a source-text oracle
    // that trips on its own explanation is no oracle.
    const cls = /class="([^"]*line-clamp[^"]*)"/.exec(cell)?.[1] ?? ""
    expect(cls, "the products cell must carry a clamped class").not.toBe("")
    // The VERBATIM summary stays reachable: the resolution below may never be the only copy.
    expect(cell).toContain("title={row.products}")
    // NOT `truncate`: whitespace-nowrap took the cell off its two-line wrap and
    // made the column WIDER (84.8px -> 112.8px, grid content 1027px -> 1055px).
    // The cap only caps while the text can still wrap.
    // A clamp, and a REAL one: `line-clamp-N` sets display:-webkit-box, so a `block` next to it
    // silently turns the clamp into a no-op. That is exactly what shipped, and why the "capped"
    // cell printed 13 wrapped lines on the dealer row (measured 275.5px against 93.8px
    // neighbours) instead of the two it claimed.
    expect(/line-clamp-\d/.test(cls)).toBe(true)
    expect(cls.split(/\s+/)).not.toContain("block")
    expect(cls.split(/\s+/)).not.toContain("truncate")
    // And the cap only ever gets TIGHTER than the 168px it was when the column printed raw
    // skus: resolved short codes are what paid for the narrowing, so a future edit that widens
    // the cap back has given the width away again.
    const cap = /max-w-\[(\d+)px\]/.exec(cls)
    expect(cap, "the products cell must carry a max-width cap").not.toBeNull()
    expect(Number(cap![1])).toBeLessThanOrEqual(168)
  })

  // The two content defects the owner read off the prod row on 2026-09-08:
  // `2xEMB-ET2-BLACK-B2B, ... , 1xEMB-ET2-BLACK-B2B` over nine wrapped lines. The arithmetic is
  // proved in product-codes.test.ts; what this pins is that the CELL goes through it, and that
  // the raw summary is still the fallback for a string that is not a quantity list.
  it("renders the products cell through the resolver, never the raw summary", () => {
    const cell = src.slice(
      src.indexOf("data-testid={`boxtal-prep-products-"),
      src.indexOf("data-testid={`boxtal-prep-products-") + 900,
    )
    expect(cell).toContain("productCodes()")
    expect(cell).toContain("productChipLabel(entry.code)")
    // "-" and "2 parcels" are not quantity lists: they print as they are.
    expect(cell).toContain("fallback={row.products}")
    expect(src).toContain(
      "const productCodes = createMemo(() => resolveProductCodes(row.products))",
    )
  })

  // The affordance the owner asked for on the collapsed offer selector: "need some kind of down
  // arrow or some shit". A transparent <select> over a wordmark is invisible as a control, so the
  // trigger has to say it opens something in more than one way at once.
  it("gives the collapsed offer selector a caret, a hover ground and a pointer cursor", () => {
    const trigger = src.slice(
      src.indexOf("-offer-trigger") - 900,
      src.indexOf("-offer-trigger") + 900,
    )
    expect(trigger).toContain("<CaretIcon")
    expect(trigger).toContain("cursor-pointer")
    expect(trigger).toContain("hover:border-border")
    expect(trigger).toContain("hover:bg-surface-hover")
    // Still keyboard-visible, and still the same testid the scenario drives.
    expect(trigger).toContain("focus-within:ring-2")
    expect(src).toContain("`${props.testid}-offer-select`")
    // The caret only exists when a list actually opens: no offers, no promise of one.
    const caretAt = src.indexOf("<CaretIcon")
    const showAt = src.lastIndexOf("<Show when={offers().length > 0}>", caretAt)
    expect(showAt).toBeGreaterThan(-1)
    expect(caretAt - showAt).toBeLessThan(200)
  })
})

// Phone width (spec-responsive.md, "tables collapse or declare surviving
// columns"): the prep grid is a comparison table, so it declares which columns
// survive at 390 px and moves the rest behind a per-row expand.
describe("prep grid phone columns", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")

  it("declares the surviving phone columns explicitly", () => {
    expect(PREP_GRID_COLUMNS.map((c) => c.key)).toEqual([
      "status",
      "order",
      "client",
      "country",
      "products",
      "total",
      "category",
      "document",
      "actions",
    ])
    expect(PREP_GRID_COLUMNS.filter((c) => c.survivesPhone).map((c) => c.key)).toEqual([
      "order",
      "client",
      "actions",
    ])
  })

  it("marks every non surviving column so it only paints from md up, or when the row is expanded", () => {
    for (const col of PREP_GRID_COLUMNS.filter((c) => !c.survivesPhone)) {
      expect(src).toContain(`data-phone-column="${col.key}"`)
    }
    expect(src).toContain("md:table-cell")
  })

  it("gives every row a phone expand that reveals the columns the phone drops", () => {
    expect(src).toContain("boxtal-prep-row-phone-expand-")
    expect(src).toContain("phoneExpanded()")
  })
})

describe("prep grid Country column", () => {
  const src = readFileSync(new URL("./PrepGrid.tsx", import.meta.url), "utf8")
  it("has a sortable Country header and its own country cell with the name on hover", () => {
    const thead = src.slice(src.indexOf("<thead>"), src.indexOf("</thead>"))
    expect(thead).toContain('label="Country"')
    expect(thead).toContain('sortKey="country"')
    expect(src).toContain("data-testid={`boxtal-prep-country-${row.order_key}`}")
    expect(src).toContain("title={countryName(row.destination)}")
  })
})
