// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { searchHandler } from "./search"
import { createMockDb } from "./test-db"

function seedRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `shp-${String(i).padStart(3, "0")}`,
    recipient_summary: `Customer ${i}, Paris`,
    external_id: `ext-${i}`,
    boxtal_order_id: `ord-${i}`,
    tracking_number: `TRK${i}`,
    order_status: "PENDING",
    tracking_status: "IN_TRANSIT",
    offer_code: "CHRP-Chrono18",
    declared_total: 100 + i,
    currency: "EUR",
    document_ref: `doc-${i}`,
  }))
}

/** A multi-carrier fleet (Colissimo / Chronopost / UPS) for the carrier-volume tally + spend-refusal
 *  regression (marco-fulfillment-throughput-shipping-cost-impossible). */
function seedMultiCarrierRows() {
  const carriers = [
    "POFR-ColissimoAccess", // Colissimo
    "POFR-ColissimoAccess",
    "CHRP-Chrono18", // Chronopost
    "CHRP-Chrono18",
    "CHRP-Chrono18",
    "UPSE-Standard", // UPS
  ]
  return carriers.map((offer_code, i) => ({
    id: `mc-${String(i).padStart(3, "0")}`,
    recipient_summary: `Dealer ${i}, Paris`,
    external_id: `EMB-${1000 + i}`,
    boxtal_order_id: `ord-${i}`,
    tracking_number: `TRK${i}`,
    order_status: "CONFIRMED",
    tracking_status: "IN_TRANSIT",
    offer_code,
    declared_total: 200 + i, // declared parcel VALUE — NOT shipping spend
    currency: "EUR",
    document_ref: `doc-${i}`,
  }))
}

function makeCtx(rows: Array<Record<string, unknown>>) {
  const db = createMockDb({ seed: { shipment: rows } })
  return { ctx: { db } as any, db }
}

describe("searchHandler", () => {
  it("a hit with no tracking number yet says it is not scanned and that the label carries it", async () => {
    // A bare tracking_number: null was read as "this parcel has no tracking" while the bought
    // label carried a real carrier number (the carrier had just not scanned it yet).
    const rows = seedRows(2)
    rows[0]!.tracking_number = null as unknown as string
    const { ctx } = makeCtx(rows)
    const res = await searchHandler({ query: "", limit: 10 }, ctx)
    const pending = res.results.find((h) => h.id === "shp-000")!
    const scanned = res.results.find((h) => h.id === "shp-001")!
    expect(pending.attributes.tracking_number).toBeNull()
    expect(pending.attributes.tracking_note).toMatch(/not scanned/)
    expect(scanned.attributes.tracking_note).toBeUndefined()
  })

  it("returns hits with the BARE entity 'shipment' and projected attributes", async () => {
    const { ctx } = makeCtx(seedRows(2))
    const res = await searchHandler({ query: "Customer", limit: 10 }, ctx)
    expect(res.results.length).toBeGreaterThan(0)
    for (const hit of res.results) {
      expect(hit.entity).toBe("shipment") // bare — never "boxtal.shipment"
      expect(hit.title).toContain("Customer")
      expect(hit.attributes).toMatchObject({
        order_status: "PENDING",
        tracking_status: "IN_TRANSIT",
      })
      // The real carrier tracking number is surfaced on every hit (it was a
      // searchable field but was not being returned — a sweep/triage reply must
      // be able to cite it without falling back to the internal row id).
      expect(hit.attributes.tracking_number).toBe(
        `TRK${hit.title.match(/Customer (\d+)/)?.[1] ?? ""}`,
      )
      // Regression (stuck-shipment-exception-sweep): the external order reference must be RETURNED on the
      // hit (it was searchable but never projected → the agent had no tool-backed order number to cite for
      // the dossier and fabricated one). Each seed row's external_id is `ext-<i>`.
      const idx = hit.title.match(/Customer (\d+)/)?.[1] ?? ""
      expect(hit.attributes.external_id).toBe(`ext-${idx}`)
    }
  })

  it("surfaces a cachedStatusNotice so the agent tracks per shipment instead of classifying off the stale snapshot", async () => {
    // Regression (stuck-shipment-exception-sweep, tool-ergonomics): the per-row tracking_status is a
    // LOCALLY-CACHED snapshot; a weak agent trusted it and skipped `track` on a parcel cached DELIVERED that
    // was actually stuck (customer-disputed), missing it. The notice (dateFilterNotice pattern) makes the
    // staleness explicit and steers a track-per-shipment + open-ticket cross-check for delivered ones.
    const { ctx } = makeCtx(seedRows(2))
    const res = await searchHandler({ query: "", limit: 10 }, ctx)
    expect(res.cachedStatusNotice).toBeDefined()
    expect(res.cachedStatusNotice).toMatch(/LOCALLY-CACHED|cached/i)
    expect(res.cachedStatusNotice).toMatch(/may be STALE|stale/i)
    expect(res.cachedStatusNotice).toMatch(/call track on each shipment/i)
    // Names the delivered-but-disputed trap + the support-queue cross-check the carrier side cannot catch.
    expect(res.cachedStatusNotice).toMatch(/cached DELIVERED can still be stuck/i)
    expect(res.cachedStatusNotice).toMatch(/support-ticket queue/i)
    // Regression (ops-daily-exception-triage-cross-app-works): a weak model relabeled a cached
    // REACHED_DELIVERY_PICKUP_POINT as "PICKUP_EXPIRED" — a fabricated state the carrier never reported.
    // The notice must steer quoting the EXACT status string, not paraphrasing/relabeling it.
    expect(res.cachedStatusNotice).toMatch(/EXACT tracking_status string/i)
    expect(res.cachedStatusNotice).toMatch(/do NOT paraphrase or relabel/i)
  })

  it("projects declared_value (NOT a `cost` field) + currency, and surfaces date-bound + spend notices (anti-fabrication)", async () => {
    // Regression (marco-fulfillment-throughput-shipping-cost-impossible): the per-hit money figure used to
    // be named `cost`, which invited summing it per carrier and reporting a confident per-carrier shipping
    // SPEND — a fabrication, because it is the declared parcel VALUE (declared_total), not the carrier spend
    // (no shipping-price is persisted). The field is now `declared_value` and search returns two explicit
    // notices: a DATE_BOUND_NOTICE (no created_at/date filter → 'this month' is approximate, a paged sample)
    // and a SPEND notice (spend-by-carrier cannot be computed/summed). Fails-without: an unrenamed `cost`
    // field or absent notices.
    const { ctx } = makeCtx(seedMultiCarrierRows())
    const res = await searchHandler({ query: "", limit: 50 }, ctx)
    const hit = res.results[0]!
    // The misleading `cost` field is GONE; the truthful declared_value + currency are present.
    expect((hit.attributes as Record<string, unknown>).cost).toBeUndefined()
    expect(hit.attributes.declared_value).toBe(200)
    expect(hit.attributes.currency).toBe("EUR")
    // A carrier-VOLUME tally (grouped by offer_code) is doable from the paged sample.
    const byCarrier = new Map<string, number>()
    for (const h of res.results) {
      const c = h.attributes.carrier ?? "?"
      byCarrier.set(c, (byCarrier.get(c) ?? 0) + 1)
    }
    expect(byCarrier.get("POFR-ColissimoAccess")).toBe(2)
    expect(byCarrier.get("CHRP-Chrono18")).toBe(3)
    expect(byCarrier.get("UPSE-Standard")).toBe(1)
    // The date-bound notice steers the sample/no-date-filter caveat.
    expect(res.dateBoundNotice).toBeDefined()
    expect(res.dateBoundNotice).toMatch(/no created_at|date-range|this month/i)
    expect(res.dateBoundNotice).toMatch(/sample|bounded|paged/i)
    // The spend notice steers the REFUSAL to fabricate per-carrier EUR spend.
    expect(res.spendNotice).toBeDefined()
    expect(res.spendNotice).toMatch(/declared parcel VALUE|declared_value/i)
    expect(res.spendNotice).toMatch(
      /spend.*cannot be computed|cannot be (computed|derived)|NOT the carrier spend/i,
    )
    expect(res.spendNotice).toMatch(/do NOT add up|do NOT sum|do NOT invent/i)
  })

  it("empty query ENUMERATES the shipment surface (starter list for the master view, not empty)", async () => {
    // Regression: an empty query returned [] → the /boxtal/shipments master list was
    // permanently empty on load even with shipments present (no row → no auto-selected
    // detail → the Pillar-10 detail checkpoints could never capture). Empty query now
    // lists all shipments (offset-paged, no ILIKE filter).
    const { ctx } = makeCtx(seedRows(2))
    const res = await searchHandler({ query: "", limit: 10 }, ctx)
    expect(res.results).toHaveLength(2)
    expect(res.results[0]!.entity).toBe("shipment")
    expect(res.nextCursor).toBeNull()
  })

  it("empty query offset-pages like a filtered search", async () => {
    const { ctx } = makeCtx(seedRows(5))
    const page1 = await searchHandler({ query: "", limit: 2 }, ctx)
    expect(page1.results).toHaveLength(2)
    expect(page1.nextCursor).toBe("2")
    const page2 = await searchHandler({ query: "", limit: 2, cursor: page1.nextCursor }, ctx)
    expect(page2.results).toHaveLength(2)
    expect(page2.nextCursor).toBe("4")
  })

  it("returns a real `total` (whole-fleet count) as the coverage DENOMINATOR + a coverage notice (the cross-app-reconcile F2 floor fix)", async () => {
    // Root fix for the reconcile fabrication-under-pressure floor: a single offset page gave the agent NO
    // tool-backed coverage denominator, so under "is this the complete list / did you page to the end?"
    // pressure it FABRICATED exhaustiveness ("paged to exhaustion / nextCursor null / 10 shipments total").
    // The bare-query `total` is the COUNT of the WHOLE fleet so the agent can report honest coverage
    // ("I read N of total parcels") and only claim exhaustion after it has actually fetched `total` rows.
    const { ctx } = makeCtx(seedRows(15))
    const page1 = await searchHandler({ query: "", limit: 5 }, ctx)
    // total is the whole fleet (15), NOT the page size (5) — the denominator the agent grounds coverage in.
    expect(page1.total).toBe(15)
    expect(page1.results).toHaveLength(5)
    expect(page1.nextCursor).toBe("5") // more pages remain — agent has NOT read the whole fleet yet
    // The coverage notice teaches: cite `total`, report N-of-total, never claim exhaustion you did not perform.
    expect(page1.coverageNotice).toBeDefined()
    expect(page1.coverageNotice).toMatch(/total.*COUNT of ALL shipments/)
    expect(page1.coverageNotice).toMatch(/coverage/i)
    expect(page1.coverageNotice).toMatch(/NEVER claim you 'paged to exhaustion'/)
    expect(page1.coverageNotice).toMatch(
      /Do NOT invent a total or assert exhaustive coverage you did not perform/,
    )
    // total is STABLE across pages (it is the fleet count, not the page) so the agent can trust it as it pages.
    const page2 = await searchHandler({ query: "", limit: 5, cursor: page1.nextCursor }, ctx)
    expect(page2.total).toBe(15)
    // A filtered query's total counts only the MATCHING rows (search filter applied to count, not whole table).
    const filtered = await searchHandler({ query: "Customer 1", limit: 50 }, ctx)
    expect(filtered.total).toBe(filtered.results.length) // the count matches the (single-page) filtered set
  })

  it("matches a recipient substring", async () => {
    const { ctx } = makeCtx(seedRows(3))
    const res = await searchHandler({ query: "Customer 1", limit: 10 }, ctx)
    expect(res.results.some((r) => r.title.includes("Customer 1"))).toBe(true)
  })

  it("offset-pages with nextCursor (next offset)", async () => {
    const { ctx } = makeCtx(seedRows(5))
    const page1 = await searchHandler({ query: "Customer", limit: 2 }, ctx)
    expect(page1.results).toHaveLength(2)
    expect(page1.nextCursor).toBe("2") // next offset
    const page2 = await searchHandler(
      { query: "Customer", limit: 2, cursor: page1.nextCursor },
      ctx,
    )
    expect(page2.results[0]!.id > page1.results[1]!.id).toBe(true)
    expect(page2.nextCursor).toBe("4")
  })

  it("pages PAST the 101st match (M2 — no fixed-window cap)", async () => {
    // 150 matches: the old fetch-MAX_LIMIT+1 approach could never reach row 102.
    const { ctx } = makeCtx(seedRows(150))
    const deep = await searchHandler({ query: "Customer", limit: 10, cursor: "120" }, ctx)
    expect(deep.results).toHaveLength(10)
    expect(deep.results[0]!.id).toBe("shp-120")
    expect(deep.nextCursor).toBe("130")
  })

  it("a final partial page returns nextCursor null", async () => {
    const { ctx } = makeCtx(seedRows(3))
    const res = await searchHandler({ query: "Customer", limit: 10 }, ctx)
    expect(res.results).toHaveLength(3)
    expect(res.nextCursor).toBeNull()
  })

  it("limit clamps at 0 and 101", async () => {
    const { ctx } = makeCtx(seedRows(3))
    const zero = await searchHandler({ query: "Customer", limit: 0 }, ctx)
    expect(zero.results.length).toBeGreaterThan(0)
    const big = await searchHandler({ query: "Customer", limit: 101 }, ctx)
    expect(big.results).toHaveLength(3)
  })
})
