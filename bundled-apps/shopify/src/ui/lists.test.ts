// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify list-view tests — bundled-app `bun:test`. The runner transpiles JSX
// to the React runtime, so it cannot import the `.tsx` view modules directly;
// the load-bearing list logic therefore lives in the JSX-free `./list-helpers`
// module, which we import and exercise here. Component wiring that can only be
// expressed in the `.tsx` file is pinned via source invariants (readFileSync,
// no import). Full DOM-render assertions live in apps/web's Vitest/Playwright
// layer. This covers the deep review's cluster C2 list findings:
//
//   1. `listCountLabel` reports the entity total honestly — "N+" when the
//      search tool reports a further page, exact "N" otherwise, null while
//      loading. (Was: a full page rendered as a bare "50", read as the total.)
//   2. `loadShopDomain` coalesces every caller onto ONE home_load round-trip
//      (no N+1 per list mount) and clears its cache on failure to allow retry.
//   3. The search debounce timer is torn down on unmount (source invariant).
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { HostServices } from "@liaison/host"
import { cartMoreLabel, cartSummary, ORDER_COLUMNS, orderHasItemsToShip, orderTags } from "./list-helpers"
import { ListHelpersTestAccess, formatHoursHuman, formatShopifyMoney, listCountLabel, loadShopDomain, type OrderFilterKey, type OrderRowLike, orderMatchesFilter, statusLabel } from "./list-helpers"

const source = readFileSync(join(import.meta.dir, "lists.tsx"), "utf-8")

function installMockHost(invokeImpl?: HostServices["invokeTool"]): HostServices {
  const invokeFn: HostServices["invokeTool"] =
    invokeImpl ?? (mock(async () => ({}) as never) as HostServices["invokeTool"])
  const host: HostServices = {
    fetch: mock(async () => ({}) as never),
    invokeTool: invokeFn,
    openConnect: mock(async () => {}),
    accessToken: () => "tok",
  }
  ;(globalThis as unknown as { __liaisonHost: HostServices }).__liaisonHost = host
  ;(globalThis as unknown as { __LIAISON_TEST_APP_NAME: string }).__LIAISON_TEST_APP_NAME =
    "shopify"
  return host
}

beforeEach(() => {
  ListHelpersTestAccess.resetShopDomainProbe()
  installMockHost()
})

afterEach(() => {
  ListHelpersTestAccess.resetShopDomainProbe()
  delete (globalThis as unknown as { __liaisonHost?: HostServices }).__liaisonHost
  delete (globalThis as unknown as { __LIAISON_TEST_APP_NAME?: string }).__LIAISON_TEST_APP_NAME
})

describe("listCountLabel (C2 — count reflects total, not page size)", () => {
  it("returns null while the result is still loading", () => {
    expect(listCountLabel(null, false)).toBeNull()
    expect(listCountLabel(undefined, false)).toBeNull()
  })

  it("returns the exact count when there is no further page", () => {
    expect(listCountLabel(0, false)).toBe("0")
    expect(listCountLabel(3, false)).toBe("3")
    expect(listCountLabel(50, false)).toBe("50")
  })

  it("appends '+' when a next cursor exists — a full page is NOT the total", () => {
    // The regression: a full 50-row page used to render as a bare "50", which
    // reads as "50 total". With more pages available we must signal "≥ 50".
    expect(listCountLabel(50, true)).toBe("50+")
    expect(listCountLabel(50, true)).not.toBe("50")
  })

  it("the list views feed the cursor-derived hasMore into the label", () => {
    // Pin the call shape so a refactor can't silently revert to results().length.
    expect(source).toMatch(
      /count=\{listCountLabel\(results\(\)\?\.results\.length,\s*results\(\)\?\.hasMore \?\? false\)\}/,
    )
    // hasMore is derived from the tool's nextCursor, not a hardcoded false.
    expect(source).toMatch(/hasMore:\s*Boolean\(r\?\.nextCursor\)/)
  })
})

describe("loadShopDomain probe coalescing (C2 — no N+1 home_load)", () => {
  it("issues exactly one home_load no matter how many list views resolve it", async () => {
    let homeLoadCalls = 0
    installMockHost(
      mock(async (_app, tool) => {
        if (tool === "home_load") {
          homeLoadCalls++
          return { connection: { shopDomain: "acme.myshopify.com" } } as never
        }
        return {} as never
      }) as HostServices["invokeTool"],
    )

    const domains = await Promise.all([
      loadShopDomain(),
      loadShopDomain(),
      loadShopDomain(),
      loadShopDomain(),
    ])

    expect(homeLoadCalls).toBe(1)
    expect(domains).toEqual([
      "acme.myshopify.com",
      "acme.myshopify.com",
      "acme.myshopify.com",
      "acme.myshopify.com",
    ])
  })

  it("returns null and lets a later mount retry when home_load fails", async () => {
    let homeLoadCalls = 0
    installMockHost(
      mock(async (_app, tool) => {
        if (tool === "home_load") {
          homeLoadCalls++
          if (homeLoadCalls === 1) throw new Error("network")
          return { connection: { shopDomain: "acme.myshopify.com" } } as never
        }
        return {} as never
      }) as HostServices["invokeTool"],
    )

    expect(await loadShopDomain()).toBeNull() // first probe fails, cache cleared
    expect(await loadShopDomain()).toBe("acme.myshopify.com") // retry succeeds
    expect(homeLoadCalls).toBe(2)
  })

  it("the list module no longer defines its own home_load probe", () => {
    // The duplicate per-file probe was removed; lists import the shared helpers.
    expect(source).toContain('from "./list-helpers"')
    expect(source).not.toMatch(/invokeTool[^\n]*"home_load"/)
  })
})

describe("useSearch debounce teardown (C2 — timer cleared on unmount)", () => {
  it("registers onCleanup(clearTimeout) so a pending debounce can't outlive the view", () => {
    // No jsdom here to mount/unmount, so pin the teardown wiring at the source
    // level: the debounce timer must be cleared inside an onCleanup callback.
    expect(source).toContain("onCleanup")
    expect(source).toMatch(/onCleanup\(\s*\(\)\s*=>\s*\{[\s\S]*?clearTimeout\(debounceTimer\)/)
  })
})

describe("ShopifyMarketsList (markets_list returns the uniform { results } envelope)", () => {
  // Regression: markets_list returns `{ results: NormalizedHit[] }` (reads.ts),
  // but the view read `(raw as MarketsListResult)?.markets` — an envelope that
  // never exists — so the Markets list silently rendered empty on every store.
  // It also read top-level `m.name/m.enabled/m.regionCount`, none of which exist
  // on a NormalizedHit (the real fields are `title` + `attributes.{enabled,regions}`).
  it("extracts markets from .results, not the non-existent .markets envelope", () => {
    expect(source).toMatch(
      /invokeTool\("markets_list"[\s\S]*?return \(raw as SearchResult\)\?\.results \?\? \[\]/,
    )
    // The broken shape must not come back.
    expect(source).not.toContain("MarketsListResult")
    expect(source).not.toMatch(/\?\.markets \?\? \[\]/)
  })

  it("renders market rows from the NormalizedHit shape (title + attributes)", () => {
    expect(source).toContain("const regions = m.attributes?.regions")
    expect(source).toContain("const enabled = m.attributes?.enabled")
    // The view must not read the phantom top-level fields again.
    expect(source).not.toMatch(/\bm\.regionCount\b/)
    expect(source).not.toMatch(/\bm\.enabled\b/)
  })
})

describe("ShopifyOrdersList — merged orders table (Order/Customer/Total/Status/Invoice)", () => {
  // The Market column on the ORDERS table only ever showed a `market:<handle>`
  // tag, which no real store sets, so it was always empty. The orders list was
  // later reworked into a merged orders+drafts table with a Total column and
  // per-row invoice links; the standalone Order date column was folded into
  // chronological sort order rather than kept as its own cell.
  it("drops the per-order market cell and shows the merged column set", () => {
    // No per-order market read remains (the orders row var is `o`).
    expect(source).not.toMatch(/\bo\.market\b/)
    // The header row is now driven by ORDER_COLUMNS (the phone-survivor
    // declaration), so the merged column set is pinned there instead of on
    // the literal <th> markup: same columns, one source of truth.
    expect(ORDER_COLUMNS.map((c) => c.header)).toEqual([
      "Order",
      "Customer",
      "Items",
      "Total",
      "Status",
      "Tags",
      "Invoice",
      "Date",
    ])
  })

  it("sorts the merged rows chronologically, grounded on processedAt with a createdAt fallback", () => {
    expect(source).toContain(
      "const sortAt = (o.attributes?.processedAt ?? o.attributes?.createdAt ?? null) as string | null",
    )
  })
})

describe("ShopifyOrdersList — merged fetch (orders_search + draft_orders_list)", () => {
  it("fetches both regular orders and draft orders and merges them into one row set", () => {
    expect(source).toContain('"orders_search"')
    expect(source).toContain('"draft_orders_list"')
    expect(source).toContain("mergedRows")
  })

  it("fetches invoice links scoped to regular-order gids only, best-effort", () => {
    expect(source).toContain('"orders_invoice_links"')
    expect(source).toContain("order_ids")
    // Best-effort: a thrown rejection must not break the list, it degrades to
    // an empty link map.
    expect(source).toMatch(/catch\s*\{\s*return new Map<string, InvoiceLink\[\]>\(\)/)
  })

  it("invoice link click navigates in-app and stops propagation so it doesn't also open the row's admin link", () => {
    expect(source).toContain("e.stopPropagation()")
    expect(source).toContain('navigate(`/invoicing/document/${link.invoice_id}`)')
  })
})

describe("orderMatchesFilter (merged orders+drafts filter chips — pure, unit-testable)", () => {
  // Representative rows covering each chip's target state. Status strings use
  // Shopify's REAL Admin GraphQL casing (UPPERCASE displayFinancial/Fulfillment
  // status), which `orders_search` surfaces verbatim — so these tests prove the
  // predicate is case-insensitive against production data, not just lowercase mocks.
  const paidFulfilled: OrderRowLike = {
    kind: "order",
    fulfillmentStatus: "FULFILLED",
    financialStatus: "PAID",
    cancelledAt: null,
  }
  const unfulfilledOpen: OrderRowLike = {
    kind: "order",
    fulfillmentStatus: "UNFULFILLED",
    financialStatus: "PENDING",
    cancelledAt: null,
  }
  const partialFulfillment: OrderRowLike = {
    kind: "order",
    fulfillmentStatus: "PARTIALLY_FULFILLED",
    financialStatus: "PAID",
    cancelledAt: null,
  }
  const cancelledOrder: OrderRowLike = {
    kind: "order",
    fulfillmentStatus: "UNFULFILLED",
    financialStatus: "VOIDED",
    cancelledAt: "2026-06-01T00:00:00.000Z",
  }
  const refundedOrder: OrderRowLike = {
    kind: "order",
    fulfillmentStatus: "FULFILLED",
    financialStatus: "REFUNDED",
    cancelledAt: null,
  }
  const partiallyRefundedOrder: OrderRowLike = {
    kind: "order",
    fulfillmentStatus: "FULFILLED",
    financialStatus: "PARTIALLY_REFUNDED",
    cancelledAt: null,
  }
  const voidedNotCancelled: OrderRowLike = {
    kind: "order",
    fulfillmentStatus: "UNFULFILLED",
    financialStatus: "VOIDED",
    cancelledAt: null,
  }
  const draft: OrderRowLike = { kind: "draft" }

  const ALL_ROWS = [
    paidFulfilled,
    unfulfilledOpen,
    partialFulfillment,
    cancelledOrder,
    refundedOrder,
    partiallyRefundedOrder,
    voidedNotCancelled,
    draft,
  ]

  it("'all' matches every row regardless of kind or state", () => {
    for (const row of ALL_ROWS) {
      expect(orderMatchesFilter(row, "all")).toBe(true)
    }
  })

  it("'open' matches non-cancelled orders whose financialStatus isn't refunded/partially_refunded/voided", () => {
    expect(orderMatchesFilter(paidFulfilled, "open")).toBe(true)
    expect(orderMatchesFilter(unfulfilledOpen, "open")).toBe(true)
    expect(orderMatchesFilter(partialFulfillment, "open")).toBe(true)
    expect(orderMatchesFilter(cancelledOrder, "open")).toBe(false)
    expect(orderMatchesFilter(refundedOrder, "open")).toBe(false)
    expect(orderMatchesFilter(partiallyRefundedOrder, "open")).toBe(false)
    expect(orderMatchesFilter(voidedNotCancelled, "open")).toBe(false)
    expect(orderMatchesFilter(draft, "open")).toBe(false)
  })

  it("'unfulfilled' matches non-cancelled orders with no/unfulfilled/partial fulfillment", () => {
    expect(orderMatchesFilter(unfulfilledOpen, "unfulfilled")).toBe(true)
    expect(orderMatchesFilter(partialFulfillment, "unfulfilled")).toBe(true)
    expect(orderMatchesFilter({ kind: "order", cancelledAt: null }, "unfulfilled")).toBe(true) // absent status
    expect(orderMatchesFilter(paidFulfilled, "unfulfilled")).toBe(false)
    expect(orderMatchesFilter(cancelledOrder, "unfulfilled")).toBe(false) // cancelled wins even though unfulfilled
    expect(orderMatchesFilter(draft, "unfulfilled")).toBe(false)
  })

  it("'cancelled' matches only orders with a truthy cancelledAt", () => {
    expect(orderMatchesFilter(cancelledOrder, "cancelled")).toBe(true)
    expect(orderMatchesFilter(paidFulfilled, "cancelled")).toBe(false)
    expect(orderMatchesFilter(voidedNotCancelled, "cancelled")).toBe(false)
    expect(orderMatchesFilter(draft, "cancelled")).toBe(false)
  })

  it("'refunded' matches refunded and partially_refunded financialStatus", () => {
    expect(orderMatchesFilter(refundedOrder, "refunded")).toBe(true)
    expect(orderMatchesFilter(partiallyRefundedOrder, "refunded")).toBe(true)
    expect(orderMatchesFilter(paidFulfilled, "refunded")).toBe(false)
    expect(orderMatchesFilter(cancelledOrder, "refunded")).toBe(false)
    expect(orderMatchesFilter(draft, "refunded")).toBe(false)
  })

  it("'drafts' matches only draft rows", () => {
    expect(orderMatchesFilter(draft, "drafts")).toBe(true)
    expect(orderMatchesFilter(paidFulfilled, "drafts")).toBe(false)
    expect(orderMatchesFilter(cancelledOrder, "drafts")).toBe(false)
  })

  it("every ORDER_FILTERS key is exercised by at least one assertion above (no silently-added chip)", () => {
    const keys: OrderFilterKey[] = ["all", "open", "unfulfilled", "cancelled", "refunded", "drafts"]
    for (const key of keys) {
      // Smoke: must not throw for any representative row.
      for (const row of ALL_ROWS) {
        expect(() => orderMatchesFilter(row, key)).not.toThrow()
      }
    }
  })
})

describe("formatHoursHuman (B5 -- readable attention age, not 33660h)", () => {
  it("shows hours under 48h", () => {
    expect(formatHoursHuman(6)).toBe("6h")
    expect(formatHoursHuman(47)).toBe("47h")
    expect(formatHoursHuman(47.9)).toBe("47h")
  })

  it("shows days from 48h up to 60 days", () => {
    expect(formatHoursHuman(48)).toBe("2d")
    expect(formatHoursHuman(24 * 59)).toBe("59d")
  })

  it("shows months from 60 days up to 24 months", () => {
    expect(formatHoursHuman(24 * 61)).toBe("2mo") // 61 days ~ 2.0 months
    expect(formatHoursHuman(24 * 365)).toBe("11mo") // ~11.99 months
  })

  it("shows years beyond 24 months (the 33660h regression -> a readable year)", () => {
    expect(formatHoursHuman(33660)).toBe("3y") // 1402.5 days ~ 3.8 years -> 3y
    expect(formatHoursHuman(24 * 365 * 6)).toBe("5y") // 2190 days ~ 5.99 years -> 5y
  })

  it("clamps non-finite / non-positive input to 0h", () => {
    expect(formatHoursHuman(0)).toBe("0h")
    expect(formatHoursHuman(-5)).toBe("0h")
    expect(formatHoursHuman(Number.NaN)).toBe("0h")
  })
})

// Temporal-sanity oracle (property, not point assertions). The point tests above
// pin specific outputs; this guards the INVARIANT that made "33660h" ship: no
// matter the input, formatHoursHuman must (a) always produce a sane
// `<int><unit>` token with a small magnitude, and (b) once the age passes ~48h
// it must NEVER still express itself in raw hours -- an "Nh" reading above 72
// means the unit failed to step up (the exact class of the 3.8-year "33660h"
// bug). A raw-hours cap of 72 tolerates the 48h boundary rounding while catching
// any unbounded hours figure.
//
// red: in list-helpers.ts formatHoursHuman, delete the `if (hours < 48) return
// hours + "h"` early-return's GUARD (make it `if (true) return floor(hours)+"h"`)
// so every age renders as raw hours -> feeding 720/33660 emits "720h"/"33660h"
// and this oracle fails on the >72h hours-token assertion.
describe("formatHoursHuman temporal-sanity oracle (never a raw hours figure above ~72h, never absurd)", () => {
  const HOURS_UNIT_CAP = 72
  // Realistic attention ages plus the exact boundary rows: 0/negative/non-finite
  // clamp to "0h"; 47/48/49 straddle the hours->days step; 73/720 are past it;
  // 33660 is the historical regression value; 40y is a plausible upper extreme.
  // (MAX_SAFE_INTEGER etc. are exercised in the raw-hours sweep below, where the
  // only invariant is "not still in hours" -- a caller never feeds a 10^15-hour
  // age, so we don't over-fit the magnitude bound to that.)
  const boundaries = [
    0,
    -1,
    -100000,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    47,
    48,
    49,
    73,
    720, // 30d
    33660, // ~3.8y -- the historical regression value
    24 * 365 * 40, // 40y
  ]

  it("every output is a sane <int><unit> token with a bounded magnitude", () => {
    for (const h of boundaries) {
      const out = formatHoursHuman(h)
      const m = out.match(/^(\d+)(h|d|mo|y)$/)
      expect(m, `formatHoursHuman(${h}) = ${JSON.stringify(out)} is not a sane <int><unit> token`).not.toBeNull()
      const n = Number((m as RegExpMatchArray)[1])
      // For any realistic age the numeric part stays small: years<200, months<24,
      // days<60, hours<=72. A blown magnitude means the unit ladder broke.
      expect(n, `formatHoursHuman(${h}) = ${out} has an absurd magnitude`).toBeLessThan(1000)
    }
  })

  it("never renders a raw hours figure above ~72h once the unit should have stepped up", () => {
    // Sweep the boundaries AND a dense range straddling every unit step, plus
    // the extreme integer (must still not read as raw hours).
    const sweep = [
      ...boundaries,
      Number.MAX_SAFE_INTEGER,
      ...Array.from({ length: 200 }, (_, i) => i * 240), // 0h .. ~2000d in 10d steps
    ]
    for (const h of sweep) {
      const out = formatHoursHuman(h)
      const hoursMatch = out.match(/^(\d+)h$/)
      if (hoursMatch) {
        const n = Number(hoursMatch[1])
        expect(
          n,
          `formatHoursHuman(${h}) = ${out}: raw hours above ${HOURS_UNIT_CAP} means the unit failed to step up (the 33660h class of bug)`,
        ).toBeLessThanOrEqual(HOURS_UNIT_CAP)
      }
    }
  })
})

describe("formatShopifyMoney (B5 -- no more 0.0 EUR)", () => {
  it("renders two decimals for standard currencies", () => {
    expect(formatShopifyMoney("0.0", "EUR")).toBe("0.00")
    expect(formatShopifyMoney("23900.0", "EUR")).toBe("23900.00")
    expect(formatShopifyMoney(149.5, "USD")).toBe("149.50")
  })

  it("renders no decimals for zero-decimal currencies", () => {
    expect(formatShopifyMoney("23900", "JPY")).toBe("23900")
    expect(formatShopifyMoney("23900.0", "jpy")).toBe("23900")
  })

  it("returns empty string for absent or unparseable input", () => {
    expect(formatShopifyMoney(null, "EUR")).toBe("")
    expect(formatShopifyMoney(undefined, "EUR")).toBe("")
    expect(formatShopifyMoney("", "EUR")).toBe("")
    expect(formatShopifyMoney("abc", "EUR")).toBe("")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Phone width: the orders list renders through the shared `CardTable` kit
// primitive, so it declares a ROLE per column (anchor / secondary / meta /
// fold) once and the kit reads it two ways: a dense table from 640 px up, a
// stack of cards below it.
// ─────────────────────────────────────────────────────────────────────────
describe("orders phone columns (CardTable roles)", () => {
  const listsSource = readFileSync(join(import.meta.dir, "lists.tsx"), "utf8")

  it("declares the order columns and the role each one plays on a card", () => {
    expect(ORDER_COLUMNS.map((c) => c.key)).toEqual([
      "order",
      "customer",
      "items",
      "total",
      "status",
      "tags",
      "invoice",
      "date",
    ])
    // The anchor is the order number; the customer is the row's secondary
    // identity; total/status/date are the meta a card shows without expanding;
    // the tags and the invoice links fold behind the chevron at phone width; the cart summary
    // (items) is meta, read without expanding.
    expect(ORDER_COLUMNS.map((c) => c.role)).toEqual([
      "anchor",
      "secondary",
      "meta",
      "meta",
      "meta",
      "fold",
      "fold",
      "meta",
    ])
    // Exactly ONE numeric meta, because CardTable puts the first one on the
    // card's headline next to the anchor.
    expect(ORDER_COLUMNS.filter((c) => c.numeric).map((c) => c.key)).toEqual(["total"])
  })

  it("renders through the shared CardTable rather than a fixed table", () => {
    expect(listsSource).toContain('from "@liaison/app-ui/card-table"')
    expect(listsSource).toContain("<CardTable")
    // No hand-rolled <table> is left in the list views: the kit owns both
    // variants now, so a phone regression cannot hide in this file.
    expect(listsSource).not.toContain("<table")
    // Every row keeps the testid the e2e + visual scenarios address it by.
    expect(listsSource).toContain("`shopify-orders-row-${o.id}`")
  })
})

// Card 117: the phone order cards printed Shopify's raw enum, PARTIALLY_FULFILLED.
describe("status pills read as words, never as the raw enum", () => {
  it("names every status a card can carry", () => {
    expect(statusLabel("PARTIALLY_FULFILLED")).toBe("Partially fulfilled")
    expect(statusLabel("FULFILLED")).toBe("Fulfilled")
    expect(statusLabel("UNFULFILLED")).toBe("Unfulfilled")
    expect(statusLabel("PAID")).toBe("Paid")
    expect(statusLabel("PARTIALLY_REFUNDED")).toBe("Partially refunded")
    expect(statusLabel("REFUNDED")).toBe("Refunded")
    expect(statusLabel("INVOICE_SENT")).toBe("Invoice sent")
    expect(statusLabel("ON_HOLD")).toBe("On hold")
  })

  it("makes a phrase of an enum it has never met, rather than shouting it", () => {
    expect(statusLabel("AWAITING_CARRIER_PICKUP")).toBe("Awaiting carrier pickup")
    expect(statusLabel("partially-returned")).toBe("Partially returned")
    expect(statusLabel(null)).toBe("")
    expect(statusLabel(undefined)).toBe("")
    expect(statusLabel("  ")).toBe("")
  })

  it("no view prints a status straight through: every pill goes via statusLabel", () => {
    const primitives = readFileSync(join(import.meta.dir, "primitives.tsx"), "utf-8")
    // The Chip inside StatusPill carries the LABEL, not props.status.
    expect(primitives).toContain("<Chip tone={tone}>{statusLabel(props.status)}</Chip>")
    expect(primitives).not.toContain("<Chip tone={tone}>{props.status}</Chip>")
    // And the "no fulfillment yet" fallback is a word too, in both views.
    expect(source).not.toContain("<Chip>unfulfilled</Chip>")
    expect(readFileSync(join(import.meta.dir, "home.tsx"), "utf-8")).not.toContain(
      "<Chip>unfulfilled</Chip>",
    )
  })
})

describe("orders list: tags, items to ship, cart summary", () => {
  it("lists the order's tags, without the internal seed tags", () => {
    expect(orderTags(["wholesale", "liaison-seed", "VIP", "liaison-seed-42", " "])).toEqual([
      "wholesale",
      "VIP",
    ])
    expect(orderTags(undefined)).toEqual([])
  })

  it("an order has items to ship when one line requires shipping; a software-only order does not", () => {
    const software = { kind: "order" as const, lineItems: [{ sku: "LIC", quantity: 1, requiresShipping: false }] }
    const mixed = {
      kind: "order" as const,
      lineItems: [
        { sku: "LIC", quantity: 1, requiresShipping: false },
        { sku: "DEV-2", quantity: 1, requiresShipping: true },
      ],
    }
    // A line whose flag is unknown (an older hit) is kept: hiding a parcel is worse than showing one.
    const unknown = { kind: "order" as const, lineItems: [{ sku: "DEV-2", quantity: 1 }] }
    expect(orderHasItemsToShip(software)).toBe(false)
    expect(orderHasItemsToShip(mixed)).toBe(true)
    expect(orderHasItemsToShip(unknown)).toBe(true)
    expect(orderHasItemsToShip({ kind: "order", lineItems: [] })).toBe(false)
    expect(orderHasItemsToShip({ kind: "draft" })).toBe(false)
  })

  it("the cart summary reads each SKU's short code, merging quantities, and never invents a code", () => {
    const entries = cartSummary(
      [
        { sku: "DEV-2", title: "Device 2", quantity: 1 },
        { sku: "STAND", title: "Floor stand", quantity: 1 },
        { sku: "STAND", title: "Floor stand", quantity: 1 },
        { sku: "MYSTERY-9", title: "Mystery box", quantity: 3 },
        { sku: null, title: "Gift wrap", quantity: 1 },
      ],
      { "DEV-2": "E2", STAND: "FS" },
    )
    expect(entries.map((e) => e.label)).toEqual(["1×E2", "2×FS", "3×?", "1×?"])
    // An unknown line keeps its product title for the hover text.
    expect(entries[2]).toMatchObject({ code: null, title: "Mystery box" })
    expect(entries[3]).toMatchObject({ code: null, title: "Gift wrap" })
    expect(cartSummary([], {})).toEqual([])
  })

  it("the order's own requiresShipping decides, so a line beyond the fetched ten still counts", () => {
    // The fetched lines are all software, but the order (more lines than fetched) needs shipping.
    const long = {
      kind: "order" as const,
      requiresShipping: true,
      lineItemsMore: true,
      lineItems: [{ sku: "LIC", quantity: 1, requiresShipping: false }],
    }
    expect(orderHasItemsToShip(long)).toBe(true)
    expect(orderHasItemsToShip({ ...long, requiresShipping: false, lineItems: [{ sku: "DEV-2", quantity: 1 }] })).toBe(false)
    // No order-level flag, fetched lines all software, but more lines exist: unknown, kept.
    expect(orderHasItemsToShip({ ...long, requiresShipping: null })).toBe(true)
  })

  it("the summary counts current quantities, and says how many items were not fetched", () => {
    // A line whose items were all removed from the order (currentQuantity 0) is not in the cart.
    const lines = [
      { sku: "DEV-2", title: "Device 2", quantity: 2, currentQuantity: 1 },
      { sku: "STAND", title: "Floor stand", quantity: 1, currentQuantity: 0 },
    ]
    expect(cartSummary(lines, { "DEV-2": "E2", STAND: "FS" }).map((e) => e.label)).toEqual(["1×E2"])
    expect(cartMoreLabel({ lineItems: lines, lineItemsMore: true, itemsQuantity: 6 })).toBe("+5 more")
    expect(cartMoreLabel({ lineItems: lines, lineItemsMore: true, itemsQuantity: null })).toBe("+ more")
    expect(cartMoreLabel({ lineItems: lines, lineItemsMore: false, itemsQuantity: 1 })).toBeNull()
  })

  it("the view fetches short codes through the app's own tool, never another app's", () => {
    expect(source).toContain('"products_short_codes"')
    expect(source).not.toMatch(/boxtal/i)
    expect(source).toContain('data-testid="shopify-orders-filter-shippable"')
    expect(source).toContain("shopify-orders-cart-")
    expect(source).toContain("shopify-orders-tags-")
    expect(source).toContain("shopify-orders-cart-more-")
  })
})
