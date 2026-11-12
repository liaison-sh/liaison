// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B6 — Read tools (search + get + list).
//
// Each test stubs `ctx.fetch` with a captured Shopify GraphQL response
// fixture and asserts the normalized hit shape. No live Shopify call.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AppContext } from "@liaison/app-sdk"
import { home_load } from "./handlers/home"
import {
  customers_get,
  customers_get_by_external_id,
  customers_search,
  customers_segment_search,
  discounts_search,
  draft_orders_get,
  draft_orders_list,
  fulfillments_get,
  inventory_levels_list,
  locations_list,
  markets_list,
  metafields_list,
  orderFilterTerms,
  orders_get,
  orders_invoice_links,
  orders_search,
  products_get,
  products_search,
  products_short_codes,
  ReadsTestAccess,
  refunds_get,
  returns_search,
  variants_get,
  variants_market_price,
  variants_search,
  variantsSearchQuery,
} from "./reads"

const FIXTURE_DIR = join(import.meta.dir, "__fixtures__", "shopify")
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"))
}

interface FetchCall {
  url: string
  body: string
}

function makeCtx(opts: {
  fetchResponses: unknown[]
  shopDomain?: string | null
  /** When true, no `shop` connection exists — models a fully-unconnected app. */
  noConnection?: boolean
  /** Stubbed cross-app dispatch (`ctx.executeTool`) — only orders_invoice_links uses it. */
  executeTool?: (target: string, args: Record<string, unknown>) => Promise<unknown>
  /** The app's `kernel.apps.config` values (omitted = no config accessor, as in older ctx stubs). */
  config?: Record<string, unknown>
}): { ctx: AppContext; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const responses = [...opts.fetchResponses]
  const shopDomain = opts.shopDomain === null ? null : (opts.shopDomain ?? "demo.myshopify.com")
  const ctx = {
    userId: "u",
    orgId: "o",
    db: {
      findMany: async (entity: string, _opts?: unknown) => {
        if (entity === "install_metadata" && shopDomain) {
          return [{ id: "i1", shopDomain, connectionId: "ca1", apiVersion: "2026-04" }]
        }
        return []
      },
      findOne: async () => null,
      insert: async () => ({ id: "x" }),
      update: async () => undefined,
      updateMany: async () => ({ count: 0 }),
      delete: async () => undefined,
      count: async () => 0,
    },
    emit: async () => undefined,
    enqueueJob: async () => undefined,
    resolveContact: async () => ({}),
    connections: opts.noConnection
      ? {}
      : {
          shop: {
            getAccounts: async () => [
              {
                id: "ca1",
                ownerType: "org" as const,
                ownerId: null,
                identifier: shopDomain ?? "demo.myshopify.com",
                displayName: null,
              },
            ],
            getToken: async () => "test-token",
          },
        },
    ...(opts.config ? { config: { get: async (key: string) => opts.config?.[key] ?? null } } : {}),
    fetch: async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: init?.body ?? "" })
      const next = responses.shift()
      return { status: 200, headers: {}, body: JSON.stringify(next ?? {}) }
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    agent_run: async () => "{}",
    realtime_publish: async () => "{}",
    grants_setUserScopes: async () => "{}",
    bulk: {
      fetchToBlob: async () => ({ blobId: "x", sizeBytes: 0 }),
      iterateJsonl: async function* () {},
      deleteBlob: async () => undefined,
    },
    ...(opts.executeTool ? { executeTool: opts.executeTool } : {}),
  } as unknown as AppContext
  return { ctx, calls }
}

describe("clampLimit", () => {
  it("clamps to MAX_LIMIT=100", () => {
    expect(ReadsTestAccess.clampLimit(999)).toBe(100)
  })
  it("defaults to 25 on non-numeric input", () => {
    expect(ReadsTestAccess.clampLimit("nope")).toBe(25)
  })
  it("respects valid in-range values", () => {
    expect(ReadsTestAccess.clampLimit(42)).toBe(42)
  })
  it("rejects sub-minimum values", () => {
    expect(ReadsTestAccess.clampLimit(0)).toBe(1)
  })
})

describe("orders_search", () => {
  it("returns normalized hits with entity + currency", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await orders_search({ query: "email:maria@example.com" }, ctx)
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0]!.entity).toBe("order")
    expect(out.results[0]!.id).toMatch(/^gid:\/\/shopify\/Order/)
    expect(out.results[0]!.currency).toBe("USD")
  })

  it("surfaces cancellation facts (cancelledAt/cancelReason) on a cancelled order hit", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/3300",
                    name: "#3300",
                    email: "cancelled@example.com",
                    createdAt: "2026-06-01T00:00:00Z",
                    displayFinancialStatus: "VOIDED",
                    displayFulfillmentStatus: "UNFULFILLED",
                    cancelledAt: "2026-06-02T10:00:00Z",
                    cancelReason: "CUSTOMER",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "50.00", currencyCode: "EUR" },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            ordersCount: { count: 1 },
          },
        },
      ],
    })
    const out = await orders_search({ query: "status:cancelled" }, ctx)
    expect(out.results[0]!.attributes.cancelledAt).toBe("2026-06-02T10:00:00Z")
    expect(out.results[0]!.attributes.cancelReason).toBe("CUSTOMER")
  })

  it("a live (non-cancelled) order surfaces null cancellation facts", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await orders_search({}, ctx)
    expect(out.results[0]!.attributes.cancelledAt).toBeNull()
    expect(out.results[0]!.attributes.cancelReason).toBeNull()
  })

  it("clamps limit to 100", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx, calls } = makeCtx({ fetchResponses: [fixture] })
    await orders_search({ limit: 999 }, ctx)
    expect(calls.length).toBe(1)
    const body = JSON.parse(calls[0]!.body) as { variables?: { first?: number } }
    expect(body.variables?.first).toBe(100)
  })

  it("defaults limit to 25 when omitted", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx, calls } = makeCtx({ fetchResponses: [fixture] })
    await orders_search({}, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables?: { first?: number } }
    expect(body.variables?.first).toBe(25)
  })

  it("throws only when there is neither install_metadata NOR a shop connection", async () => {
    const { ctx } = makeCtx({ fetchResponses: [], shopDomain: null, noConnection: true })
    await expect(orders_search({}, ctx)).rejects.toThrow(/install_metadata/)
  })

  // Boxtal "To prepare" contract: it builds its whole grid by PULLING orders_search, so the
  // internal staff note (Morgan/Quinn's dispatch instructions) must ride on the search hit at
  // the exact key path attributes.note.
  it("exposes the internal staff note at attributes.note", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/4400",
                    name: "#4400",
                    email: "buyer@example.com",
                    createdAt: "2026-09-01T00:00:00Z",
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    note: "Ship with the spare pedal",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "50.00", currencyCode: "EUR" },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            ordersCount: { count: 1 },
          },
        },
      ],
    })
    const out = await orders_search({ query: "name:4400" }, ctx)
    expect(out.results[0]!.attributes.note).toBe("Ship with the spare pedal")
  })

  it("normalizes an absent note to null, never undefined or empty string, on the search hit", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await orders_search({}, ctx)
    expect(out.results[0]!.attributes.note).toBeNull()
  })

  it("self-heals from the active connection when install_metadata is missing (lost connect event)", async () => {
    // install_metadata absent, but an active `shop` connection exists —
    // ensureInstallMetadata reconstructs the row so the tool succeeds instead of
    // failing closed with the opaque "install_metadata row not found".
    const fixture = loadFixture("orders-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture], shopDomain: null })
    const out = await orders_search({}, ctx)
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0]!.entity).toBe("order")
  })

  // Regression (claire-shopify-bf-batch-invoices) — orders_search has no reliable calendar-day filter,
  // but the weak agent appends a `created_at:>…` term BELIEVING it date-scoped the batch, gets back the
  // (unscoped) most-recent orders, and claims it captured precisely "yesterday". The handler must surface
  // an explicit `dateFilterNotice` when the query carries a date/created-at term, turning the silent
  // ignored-filter into a visible signal the agent + judge can reckon with (no silent swallowed filter).
  it("surfaces a dateFilterNotice when the query carries a created_at/date term (silent-ignore → visible)", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await orders_search(
      { query: "financial_status:paid AND created_at:>2026-06-18 AND created_at:<2026-06-19" },
      ctx,
    )
    expect(out.dateFilterNotice, "a created_at term must trigger the notice").toBeDefined()
    // A date term INSIDE the query string is still silently ignored; the notice now points the agent at
    // the real created_at_min/created_at_max date-range params instead of a "cannot ever scope" message.
    expect(out.dateFilterNotice ?? "").toMatch(/silently ignored/i)
    expect(out.dateFilterNotice ?? "").toMatch(/created_at_min/i)
    expect(out.dateFilterNotice ?? "").toMatch(/yesterday/i)
    // The notice is an explicit USER-DISCLOSURE DIRECTIVE (not just an internal fact): the agent must
    // DISCLOSE the bound in its reply and not claim clean coverage (the run-1 gate-fail root cause).
    expect(out.dateFilterNotice ?? "").toMatch(/ACTION REQUIRED/i)
    expect(out.dateFilterNotice ?? "").toMatch(/DISCLOSE/i)
    // The results still come back (the term is just not a scope) — the notice is additive.
    expect(out.results.length).toBeGreaterThan(0)
  })

  it("does NOT emit a dateFilterNotice for a NARROWING (non-date facet) query (no noise)", async () => {
    // A status/email/tag/name/order# filter narrows to the intended set — the no-date-filter notice
    // would be noise, so it is suppressed for these facet-scoped reads.
    const fixture = loadFixture("orders-search.json")
    for (const q of [
      "financial_status:paid",
      "fulfillment_status:unfulfilled",
      "email:claire@example.com",
      "tag:bf2026-dtc",
      "name:#1099",
    ]) {
      const { ctx } = makeCtx({ fetchResponses: [fixture] })
      const out = await orders_search({ query: q }, ctx)
      expect(
        out.dateFilterNotice,
        `narrowing query '${q}' must NOT emit the notice`,
      ).toBeUndefined()
    }
  })

  // Regression (claire-shopify-bf-batch-invoices gate run-3 fail) — the agent pulled the RECENT page with
  // NO date term and NO narrowing facet (just limit:20), so the old date-term-only trigger stayed SILENT;
  // it then claimed "all of yesterday's orders" with no honest bound (the false-completeness fail). A
  // recency-shaped read — empty/absent query, or a non-narrowing query — MUST now surface the date-scope
  // notice so the bound is reliable even when the agent passed no date term.
  it("DOES emit the date-scope notice for a recency-shaped read (no query / no narrowing facet)", async () => {
    const fixture = loadFixture("orders-search.json")
    for (const params of [{}, { limit: 20 }, { query: "" }, { query: "Black Friday" }]) {
      const { ctx } = makeCtx({ fetchResponses: [fixture] })
      const out = await orders_search(params, ctx)
      expect(
        out.dateFilterNotice,
        `recency read ${JSON.stringify(params)} must emit the date-scope notice`,
      ).toBeDefined()
      expect(out.dateFilterNotice ?? "").toMatch(/created_at_min/i)
      expect(out.dateFilterNotice ?? "").toMatch(/ACTION REQUIRED/i)
    }
  })

  // BL (order-tag-segment-modular-expo-leads) — orders_search now BUILDS a real placed-date window via
  // created_at_min / created_at_max (Shopify's `orders(query:)` supports `processed_at:` range natively),
  // so "orders placed during week X" IS server-side queryable. These regressions assert: (1) the params
  // become server-side `processed_at:>=…`/`<=…` terms appended to the query, (2) they COMPOSE with a facet
  // query, (3) using the real date params SUPPRESSES the no-date-filter notice (the window IS the scope —
  // a notice would be a false negative contradicting the working filter), and (4) a bad date FAILS LOUD.
  it("appends server-side processed_at range terms when created_at_min/max are passed", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx, calls } = makeCtx({ fetchResponses: [fixture] })
    await orders_search({ created_at_min: "2026-06-15", created_at_max: "2026-06-21" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables?: { query?: string } }
    const sent = body.variables?.query ?? ""
    expect(sent, "min bound must become a server-side processed_at:>= term").toMatch(
      /processed_at:>='2026-06-15T00:00:00\.000Z'/,
    )
    expect(sent, "a bare max date covers that whole day").toMatch(
      /processed_at:<='2026-06-21T23:59:59\.999Z'/,
    )
  })

  it("says which date a window filters on, and that it never proves two orders adjacent", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await orders_search(
      { created_at_min: "2026-06-01", created_at_max: "2026-06-30" },
      ctx,
    )
    expect(out.dateWindowNotice ?? "").toContain("processedAt")
    expect(out.dateWindowNotice ?? "").toContain("NOT on createdAt")
    expect(out.dateWindowNotice ?? "").toContain("immediately before")
    const { ctx: ctx2 } = makeCtx({ fetchResponses: [fixture] })
    expect(
      (await orders_search({ query: "email:a@b.example" }, ctx2)).dateWindowNotice,
    ).toBeUndefined()
  })

  it("COMPOSES the date window with a facet query (SKU/status + week in one call)", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx, calls } = makeCtx({ fetchResponses: [fixture] })
    await orders_search(
      { query: "sku:RAL-44", created_at_min: "2026-06-15", created_at_max: "2026-06-21" },
      ctx,
    )
    const body = JSON.parse(calls[0]!.body) as { variables?: { query?: string } }
    const sent = body.variables?.query ?? ""
    expect(sent).toContain("sku:RAL-44")
    expect(sent).toMatch(/processed_at:>=/)
    expect(sent).toMatch(/processed_at:<=/)
  })

  it("SUPPRESSES the date-scope notice when the real created_at_min/max params are used", async () => {
    const fixture = loadFixture("orders-search.json")
    for (const params of [
      { created_at_min: "2026-06-15" },
      { created_at_max: "2026-06-21" },
      { created_at_min: "2026-06-15", created_at_max: "2026-06-21" },
      { query: "sku:RAL-44", created_at_min: "2026-06-15", created_at_max: "2026-06-21" },
    ]) {
      const { ctx } = makeCtx({ fetchResponses: [fixture] })
      const out = await orders_search(params, ctx)
      expect(
        out.dateFilterNotice,
        `date-range read ${JSON.stringify(params)} must NOT emit the no-date-filter notice`,
      ).toBeUndefined()
    }
  })

  it("composes total_min/total_max into server-side current_total_price terms", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx, calls } = makeCtx({ fetchResponses: [fixture] })
    await orders_search(
      {
        query: "financial_status:paid",
        total_min: 100,
        total_max: 499.9,
        created_at_min: "2026-06-15",
      },
      ctx,
    )
    const body = JSON.parse(calls[0]!.body) as { variables?: { query?: string } }
    expect(body.variables?.query).toBe(
      "financial_status:paid processed_at:>='2026-06-15T00:00:00.000Z' current_total_price:>=100 current_total_price:<=499.9",
    )
    expect(orderFilterTerms({ total_min: "250" }).amountTerms).toEqual([
      "current_total_price:>=250",
    ])
    expect(orderFilterTerms({}).amountTerms).toEqual([])
  })

  it("FAILS LOUD (BAD_PARAM) on an invalid order-total bound", async () => {
    expect(() => orderFilterTerms({ total_min: "a lot" })).toThrow(
      /total_min must be a non-negative amount/,
    )
    expect(() => orderFilterTerms({ total_max: -5 })).toThrow(
      /total_max must be a non-negative amount/,
    )
    expect(() => orderFilterTerms({ total_min: 500, total_max: 100 })).toThrow(
      /greater than total_max/,
    )
  })

  it("FAILS LOUD (BAD_PARAM) on an unparseable date bound (never silently drops the filter)", async () => {
    const fixture = loadFixture("orders-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    await expect(orders_search({ created_at_min: "last tuesday" }, ctx)).rejects.toThrow(
      /not a valid date/i,
    )
    const { ctx: ctx2 } = makeCtx({ fetchResponses: [fixture] })
    await expect(orders_search({ created_at_max: "2026-13-99" }, ctx2)).rejects.toThrow(
      /not a valid date/i,
    )
  })

  it("derives market from the order's `market:<handle>` tag (criterion #10)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/9",
                    name: "#9",
                    email: "eu@example.com",
                    createdAt: "2026-05-01T00:00:00Z",
                    tags: ["vip", "market:eu"],
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "10", currencyCode: "EUR" },
                      shopMoney: { amount: "10", currencyCode: "USD" },
                    },
                    customer: null,
                  },
                },
              ],
              pageInfo: { endCursor: "oc1", hasNextPage: true },
            },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    expect(out.results[0]!.market).toBe("eu")
    expect(out.results[0]!.currency).toBe("EUR")
    // nextCursor is surfaced for pagination.
    expect(out.nextCursor).toBe("oc1")
  })

  // BL-242 regression: a triage/reroute flow buckets orders by ship-to country (FR vs EU vs US). The
  // search-hit row MUST carry the destination country so the agent can filter without an orders_get
  // round-trip per order — the surface gap that let a 2-order sample masquerade as "no FR orders".
  it("surfaces the order's shipping destination country on the search hit (BL-242)", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/1064",
                    name: "#1064",
                    email: "claudine.moreau@example.com",
                    createdAt: "2026-06-17T00:00:00Z",
                    tags: [],
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "699", currencyCode: "EUR" },
                      shopMoney: { amount: "699", currencyCode: "EUR" },
                    },
                    shippingAddress: {
                      address1: "1 Rue de Rivoli",
                      city: "Paris",
                      zip: "75001",
                      country: "France",
                      countryCode: "FR",
                    },
                    customer: {
                      id: "gid://shopify/Customer/1",
                      email: "claudine.moreau@example.com",
                    },
                  },
                },
                {
                  // No order-level shippingAddress → falls back to the customer's defaultAddress country.
                  node: {
                    id: "gid://shopify/Order/1063",
                    name: "#1063",
                    email: "lukas.becker@example.de",
                    createdAt: "2026-06-16T00:00:00Z",
                    tags: [],
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "699", currencyCode: "EUR" },
                      shopMoney: { amount: "699", currencyCode: "EUR" },
                    },
                    shippingAddress: null,
                    customer: {
                      id: "gid://shopify/Customer/2",
                      email: "lukas.becker@example.de",
                      defaultAddress: {
                        address1: "Oranienstraße 12",
                        city: "Berlin",
                        zip: "10999",
                        country: "Germany",
                        countryCode: "DE",
                      },
                    },
                  },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    expect(out.results[0]!.attributes.shippingCountryCode).toBe("FR")
    expect(out.results[0]!.attributes.shippingCountry).toBe("France")
    // SERVER-COMPUTED EU-membership flag so a fulfillment/customs tick filters "the EU orders" on a fact,
    // not in-context geography it gets wrong (a flash-lite tick mis-classified Germany/DE as non-EU and
    // skipped all DE orders — the auto-fulfill-eu-orders BL-275 runtime fail). FR and DE are both EU.
    expect(out.results[0]!.attributes.euDestination).toBe(true)
    // Fallback path: order has no ship-to, so the customer's defaultAddress country fills the field.
    expect(out.results[1]!.attributes.shippingCountryCode).toBe("DE")
    expect(out.results[1]!.attributes.shippingCountry).toBe("Germany")
    // Germany IS an EU customs-union member — euDestination MUST be true (the mis-classification fix).
    expect(out.results[1]!.attributes.euDestination).toBe(true)
    // The GraphQL query MUST request the country fields (else the row can never carry them).
    const sentQuery = JSON.parse(calls[0]!.body) as { query: string }
    expect(sentQuery.query).toContain("shippingAddress { address1 city zip country countryCode }")
    expect(sentQuery.query).toContain("defaultAddress { address1 city zip country countryCode }")
  })

  // A shipping worklist sets what the customer paid for shipping beside the carrier quote, from the
  // search hit alone (no orders_get per row).
  it("carries the shipping the customer paid on the search hit", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/2001",
                    name: "#2001",
                    tags: [],
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "120.00", currencyCode: "USD" },
                    },
                    shippingLine: {
                      discountedPriceSet: {
                        presentmentMoney: { amount: "45.50", currencyCode: "USD" },
                      },
                    },
                  },
                },
                {
                  node: {
                    id: "gid://shopify/Order/2002",
                    name: "#2002",
                    tags: [],
                    shippingLine: null,
                  },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    expect(out.results[0]!.attributes.shippingAmount).toBe("45.50")
    expect(out.results[0]!.attributes.shippingCurrency).toBe("USD")
    expect(out.results[1]!.attributes.shippingAmount).toBeNull()
    const sentQuery = JSON.parse(calls[0]!.body) as { query: string }
    expect(sentQuery.query).toContain(
      "shippingLine { discountedPriceSet { presentmentMoney { amount currencyCode } } }",
    )
  })

  it("euDestination is FALSE for a non-EU ship-to (GB post-Brexit) and null when no country is visible", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/10",
                    name: "#GB1",
                    shippingAddress: { countryCode: "GB", country: "United Kingdom" },
                  },
                },
                {
                  node: {
                    id: "gid://shopify/Order/11",
                    name: "#NOADDR",
                    shippingAddress: null,
                    customer: { id: "gid://shopify/Customer/9" },
                  },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    // GB is NON-EU (post-Brexit) → euDestination must be false (the discrimination control).
    expect(out.results[0]!.attributes.euDestination).toBe(false)
    // No ship-to country visible at all → null (the tick must orders_get to resolve), never a guessed true.
    expect(out.results[1]!.attributes.euDestination).toBeNull()
  })

  // Regression (detect-fraud-pattern-duplicate-shipto-orders): an address-reuse / resale-fraud triage must
  // be able to cluster recent orders by their ship-to STREET address from ONE orders_search — without an
  // N-query orders_get drill-down per order (which crowds the 10-step turn budget). The search hit now
  // carries the per-row street address (address1 + city + zip), falling back to the customer's
  // defaultAddress when the order has no per-order ship-to. Before this fix only country/countryCode was on
  // the hit, so a duplicate-ship-to cluster (three orders to one forwarding address under different names)
  // was invisible from a bounded search. Same in-context-cluster surface as the country field (BL-242).
  it("surfaces the ship-to street address (address1/city/zip) on the search hit (duplicate-ship-to fraud cluster)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                // Two orders to the SAME forwarding address under DIFFERENT names — the fraud-cluster tell.
                {
                  node: {
                    id: "gid://shopify/Order/2001",
                    name: "#2001",
                    email: "dorian.vance@example.com",
                    createdAt: "2026-06-18T08:00:00Z",
                    tags: ["fraud-cluster"],
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "699", currencyCode: "USD" },
                      shopMoney: { amount: "699", currencyCode: "USD" },
                    },
                    shippingAddress: {
                      address1: "8420 NW 25th St Ste 140",
                      city: "Doral",
                      zip: "33122",
                      country: "United States",
                      countryCode: "US",
                    },
                    customer: {
                      id: "gid://shopify/Customer/2001",
                      email: "dorian.vance@example.com",
                      firstName: "Dorian",
                      lastName: "Vance",
                    },
                  },
                },
                {
                  node: {
                    id: "gid://shopify/Order/2002",
                    name: "#2002",
                    email: "priscilla.holt@example.com",
                    createdAt: "2026-06-18T08:05:00Z",
                    tags: ["fraud-cluster"],
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "699", currencyCode: "USD" },
                      shopMoney: { amount: "699", currencyCode: "USD" },
                    },
                    shippingAddress: {
                      address1: "8420 NW 25th St Ste 140",
                      city: "Doral",
                      zip: "33122",
                      country: "United States",
                      countryCode: "US",
                    },
                    customer: {
                      id: "gid://shopify/Customer/2002",
                      email: "priscilla.holt@example.com",
                      firstName: "Priscilla",
                      lastName: "Holt",
                    },
                  },
                },
                // A genuine distractor with a DISTINCT address (falls back to defaultAddress, no order ship-to).
                {
                  node: {
                    id: "gid://shopify/Order/2003",
                    name: "#2003",
                    email: "maren.eklund@example.com",
                    createdAt: "2026-06-18T07:50:00Z",
                    tags: ["fraud-cluster"],
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "699", currencyCode: "USD" },
                      shopMoney: { amount: "699", currencyCode: "USD" },
                    },
                    shippingAddress: null,
                    customer: {
                      id: "gid://shopify/Customer/2003",
                      email: "maren.eklund@example.com",
                      firstName: "Maren",
                      lastName: "Eklund",
                      defaultAddress: {
                        address1: "12 Birch Lane",
                        city: "Portland",
                        zip: "97205",
                        country: "United States",
                        countryCode: "US",
                      },
                    },
                  },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    // The two cluster members carry the SAME street address — detectable from the search hit alone.
    expect(out.results[0]!.attributes.shippingAddress1).toBe("8420 NW 25th St Ste 140")
    expect(out.results[0]!.attributes.shippingCity).toBe("Doral")
    expect(out.results[0]!.attributes.shippingZip).toBe("33122")
    expect(out.results[1]!.attributes.shippingAddress1).toBe("8420 NW 25th St Ste 140")
    expect(out.results[1]!.attributes.shippingZip).toBe("33122")
    // The distractor has a DISTINCT address (filled from the customer's defaultAddress fallback).
    expect(out.results[2]!.attributes.shippingAddress1).toBe("12 Birch Lane")
    expect(out.results[2]!.attributes.shippingCity).toBe("Portland")
    // The two cluster streets MATCH and differ from the distractor — the in-context cluster signal.
    expect(out.results[0]!.attributes.shippingAddress1).toBe(
      out.results[1]!.attributes.shippingAddress1,
    )
    expect(out.results[0]!.attributes.shippingAddress1).not.toBe(
      out.results[2]!.attributes.shippingAddress1,
    )
  })

  // Regression (morning-cross-app-triage-standup, axis-b): "unshipped weekend orders BY SKU" must be
  // answerable from ONE orders_search(query:'fulfillment_status:unfulfilled') — the search HIT now
  // carries a compact lineItems[] ({sku,title,quantity}) per order, so the agent reads SKUs without an
  // orders_get drill-down per order (and without falling back to home_load's inventory dashboard and
  // fabricating). Before this fix the search projection dropped line items entirely.
  it("surfaces a per-order line-item SKU summary on the search hit (unshipped-orders-by-SKU)", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/1064",
                    name: "#1064",
                    email: "claudine.moreau@example.com",
                    createdAt: "2026-06-14T00:00:00Z",
                    tags: [],
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "799", currencyCode: "EUR" },
                      shopMoney: { amount: "799", currencyCode: "EUR" },
                    },
                    customer: {
                      id: "gid://shopify/Customer/1",
                      email: "claudine.moreau@example.com",
                    },
                    lineItems: {
                      edges: [
                        {
                          node: {
                            title: "Black Friday Studio Bundle",
                            quantity: 1,
                            variant: { sku: "RAL-BNDL" },
                          },
                        },
                        {
                          node: {
                            title: "Windscreen Pack",
                            quantity: 2,
                            variant: { sku: "RAL-WND" },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await orders_search({ query: "fulfillment_status:unfulfilled" }, ctx)
    expect(out.results[0]!.attributes.lineItems).toEqual([
      {
        sku: "RAL-BNDL",
        title: "Black Friday Studio Bundle",
        quantity: 1,
        currentQuantity: null,
        requiresShipping: null,
      },
      {
        sku: "RAL-WND",
        title: "Windscreen Pack",
        quantity: 2,
        currentQuantity: null,
        requiresShipping: null,
      },
    ])
    // The query MUST request line items + their variant SKU (else the row can never carry them).
    const sentQuery = JSON.parse(calls[0]!.body) as { query: string }
    expect(sentQuery.query).toContain("lineItems(first: 10)")
    expect(sentQuery.query).toContain("variant { sku }")
  })

  // BL (auto-fulfill-eu-orders-routine-gate / order-check-prepare-shipment): a PAGING routine that
  // prepares a bounded batch per tick must HONESTLY report "prepared N of totalCount ready orders; the
  // rest continue next tick" — a recency-window guess at "how many remain" FAILS the honest-bounded-batch
  // requirement. orders_search now surfaces a server-side `ordersCount(query:)` over the SAME filter as the
  // page (the customers_search `customersCount` convention), so the agent can read the honest denominator
  // straight off the result instead of guessing it in-context.
  it("surfaces server-side totalCount (ordersCount) so a paging routine can ground a bounded-coverage bound", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            ordersCount: { count: 18 },
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/1",
                    name: "#1001",
                    email: "a@example.com",
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "699", currencyCode: "EUR" },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cur1" },
            },
          },
        },
      ],
    })
    const out = await orders_search(
      { query: "financial_status:paid fulfillment_status:unfulfilled", limit: 1 },
      ctx,
    )
    // The page returned 1 of 18 — totalCount is the honest denominator for "prepared N of totalCount".
    expect(out.totalCount).toBe(18)
    expect(out.results).toHaveLength(1)
    expect(out.nextCursor).toBe("cur1")
    // ordersCount must COUNT THE SAME (effective) filter as the page, so it must ride the SAME query.
    const sentQuery = JSON.parse(calls[0]!.body) as { query: string }
    expect(sentQuery.query).toContain("ordersCount(query: $query)")
  })

  it("falls back totalCount to the page size when ordersCount is absent (never undefined)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/2",
                    name: "#1002",
                    email: "c@example.com",
                    displayFinancialStatus: "PAID",
                    displayFulfillmentStatus: "UNFULFILLED",
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "699", currencyCode: "EUR" },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ],
    })
    const out = await orders_search({ query: "financial_status:paid" }, ctx)
    expect(out.totalCount).toBe(1)
    expect(out.nextCursor).toBeNull()
  })
})

describe("B2B and tax signals on order reads", () => {
  const baseOrder = {
    id: "gid://shopify/Order/3001",
    name: "#3001",
    email: "buyer@example.com",
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    currentTotalPriceSet: { presentmentMoney: { amount: "120.00", currencyCode: "EUR" } },
  }
  const b2bOrder = {
    ...baseOrder,
    totalTaxSet: {
      presentmentMoney: { amount: "20.00", currencyCode: "EUR" },
      shopMoney: { amount: "21.50", currencyCode: "USD" },
    },
    taxExempt: true,
    purchasingEntity: {
      company: { name: "Example Trading Ltd" },
      location: { taxSettings: { taxRegistrationId: "XX000000000" } },
    },
    customer: { id: "gid://shopify/Customer/7", email: "buyer@example.com", taxExempt: true },
  }
  type Attrs = Record<string, unknown>

  it("orders_search carries totalTax, taxExempt, b2bCompany and customerTaxExempt, and asks for them", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { orders: { edges: [{ node: b2bOrder }], pageInfo: {} } } }],
    })
    const out = await orders_search({}, ctx)
    const attrs = out.results[0]?.attributes as Attrs
    expect(attrs.totalTax).toBe("20.00")
    expect(attrs.taxExempt).toBe(true)
    expect(attrs.b2bCompany).toEqual({
      name: "Example Trading Ltd",
      taxRegistrationId: "XX000000000",
    })
    expect(attrs.customerTaxExempt).toBe(true)
    const sent = (JSON.parse(calls[0]?.body ?? "{}") as { query?: string }).query ?? ""
    expect(sent).toContain("totalTaxSet { presentmentMoney { amount } }")
    expect(sent).toContain("purchasingEntity { ... on PurchasingCompany")
    expect(sent).toContain("taxSettings { taxRegistrationId }")
  })

  it("orders_search defaults to null / false for a plain consumer order", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [{ data: { orders: { edges: [{ node: baseOrder }], pageInfo: {} } } }],
    })
    const attrs = (await orders_search({}, ctx)).results[0]?.attributes as Attrs
    expect(attrs.totalTax).toBeNull()
    expect(attrs.taxExempt).toBe(false)
    expect(attrs.b2bCompany).toBeNull()
    expect(attrs.customerTaxExempt).toBe(false)
  })

  it("orders_search hits carry the order's B2B verdict: company, tag, legacy suffix, retail", async () => {
    const plainLine = {
      lineItems: { edges: [{ node: { title: "Kit", quantity: 1, variant: { sku: "KIT-01" } } }] },
    }
    const suffixLine = {
      lineItems: {
        edges: [{ node: { title: "Kit", quantity: 1, variant: { sku: "KIT-01-B2B" } } }],
      },
    }
    const nodes = [
      { ...b2bOrder, ...plainLine, tags: [] },
      { ...baseOrder, ...plainLine, id: "gid://shopify/Order/3002", tags: ["B2B", "Distribution"] },
      { ...baseOrder, ...suffixLine, id: "gid://shopify/Order/3003", tags: [] },
      { ...baseOrder, ...plainLine, id: "gid://shopify/Order/3004", tags: ["vip"] },
    ]
    const { ctx } = makeCtx({
      fetchResponses: [
        { data: { orders: { edges: nodes.map((node) => ({ node })), pageInfo: {} } } },
      ],
      config: { b2bSkuSuffixes: "-B2B" },
    })
    const verdicts = (await orders_search({}, ctx)).results.map(
      (r) => (r.attributes as Attrs).b2bOrder,
    )
    expect(verdicts).toEqual([
      { b2b: true, reason: "b2b_company_buyer" },
      { b2b: true, reason: "b2b_order_tag" },
      { b2b: true, reason: "b2b_sku_suffix" },
      { b2b: false, reason: null },
    ])
  })

  it("a Customer purchasing entity (empty union arm) is not a company", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [{ node: { ...baseOrder, purchasingEntity: {}, taxExempt: false } }],
              pageInfo: {},
            },
          },
        },
      ],
    })
    const attrs = (await orders_search({}, ctx)).results[0]?.attributes as Attrs
    expect(attrs.b2bCompany).toBeNull()
    expect(attrs.taxExempt).toBe(false)
  })

  it("a company without a tax registration id keeps the name and a null id", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    ...baseOrder,
                    purchasingEntity: {
                      company: { name: "Example Trading Ltd" },
                      location: { taxSettings: { taxRegistrationId: null } },
                    },
                  },
                },
              ],
              pageInfo: {},
            },
          },
        },
      ],
    })
    const attrs = (await orders_search({}, ctx)).results[0]?.attributes as Attrs
    expect(attrs.b2bCompany).toEqual({ name: "Example Trading Ltd", taxRegistrationId: null })
  })

  it("orders_get carries the same signals and asks for them", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { order: b2bOrder } }] })
    const out = await orders_get({ id: "gid://shopify/Order/3001" }, ctx)
    const attrs = (out as unknown as { attributes: Attrs }).attributes
    expect(attrs.totalTax).toBe("20.00")
    expect(attrs.taxExempt).toBe(true)
    expect(attrs.b2bCompany).toEqual({
      name: "Example Trading Ltd",
      taxRegistrationId: "XX000000000",
    })
    expect(attrs.customerTaxExempt).toBe(true)
    const sent = (JSON.parse(calls[0]?.body ?? "{}") as { query?: string }).query ?? ""
    expect(sent).toContain("purchasingEntity { ... on PurchasingCompany")
    expect(sent).toContain("taxExempt")
  })

  it("orders_get defaults to null / false when Shopify returns none of the signals", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { order: baseOrder } }] })
    const out = await orders_get({ id: "gid://shopify/Order/3001" }, ctx)
    const attrs = (out as unknown as { attributes: Attrs }).attributes
    expect(attrs.totalTax).toBeNull()
    expect(attrs.taxExempt).toBe(false)
    expect(attrs.b2bCompany).toBeNull()
    expect(attrs.customerTaxExempt).toBe(false)
  })
})

describe("orders_get", () => {
  // Walk 2026-10-26: asked about "order #1097", the agent read gid://shopify/Order/1097 and got
  // "not found": 1097 is the order's NUMBER, its id is another number. A reference that names the
  // order by its number, its name or a gid built from the number reads the order behind that name.
  describe("an order named by its number", () => {
    const detail = {
      id: "gid://shopify/Order/6100097",
      name: "#1097",
      email: "buyer@example.com",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      currentTotalPriceSet: { presentmentMoney: { amount: "399.00", currencyCode: "EUR" } },
    }
    const byName = {
      data: {
        orders: {
          edges: [
            { node: { id: "gid://shopify/Order/6110970", name: "#10970" } },
            { node: { id: "gid://shopify/Order/6100097", name: "#1097" } },
          ],
        },
      },
    }

    it("a gid built from the number: the id misses, the name finds it", async () => {
      const { ctx, calls } = makeCtx({
        fetchResponses: [{ data: { order: null } }, byName, { data: { order: detail } }],
      })
      const out = await orders_get({ id: "gid://shopify/Order/1097" }, ctx)
      expect(out.id).toBe("gid://shopify/Order/6100097")
      expect(calls[1]?.body).toContain("name:1097")
      expect(calls[2]?.body).toContain("gid://shopify/Order/6100097")
    })

    it("a #name goes straight to the name lookup", async () => {
      const { ctx, calls } = makeCtx({ fetchResponses: [byName, { data: { order: detail } }] })
      const out = await orders_get({ id: "#1097" }, ctx)
      expect(out.id).toBe("gid://shopify/Order/6100097")
      expect(calls).toHaveLength(2)
    })

    it("a bare number is tried as an id first, then as the order number", async () => {
      const { ctx, calls } = makeCtx({
        fetchResponses: [{ data: { order: null } }, byName, { data: { order: detail } }],
      })
      const out = await orders_get({ id: "1097" }, ctx)
      expect(out.id).toBe("gid://shopify/Order/6100097")
      expect(calls[0]?.body).toContain("gid://shopify/Order/1097")
    })

    it("a bare numeric id reads the order in one call", async () => {
      const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { order: detail } }] })
      const out = await orders_get({ id: "6100097" }, ctx)
      expect(out.id).toBe("gid://shopify/Order/6100097")
      expect(calls).toHaveLength(1)
    })

    it("a number no order carries is still not found (a prefix match does not count)", async () => {
      const { ctx } = makeCtx({
        fetchResponses: [
          { data: { order: null } },
          {
            data: {
              orders: { edges: [{ node: { id: "gid://shopify/Order/6110970", name: "#10970" } }] },
            },
          },
        ],
      })
      await expect(orders_get({ id: "#1097" }, ctx)).rejects.toThrow(/order #1097 not found/)
    })
  })

  it("returns a single normalized order with lineItems[]", async () => {
    const fixture = loadFixture("orders-get.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await orders_get({ id: "gid://shopify/Order/12768070893734" }, ctx)
    expect(out.entity).toBe("order")
    expect(Array.isArray(out.lineItems)).toBe(true)
  })

  it("surfaces po_number when the order carries one, absent when it does not", async () => {
    const base = {
      id: "gid://shopify/Order/2001",
      name: "#2001",
      email: "buyer@example.com",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      currentTotalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
    }
    const { ctx } = makeCtx({
      fetchResponses: [{ data: { order: { ...base, poNumber: "PO-2001" } } }],
    })
    const withPo = await orders_get({ id: "gid://shopify/Order/2001" }, ctx)
    expect((withPo as unknown as { po_number?: string }).po_number).toBe("PO-2001")

    const { ctx: ctx2 } = makeCtx({
      fetchResponses: [{ data: { order: { ...base, poNumber: null } } }],
    })
    const withoutPo = await orders_get({ id: "gid://shopify/Order/2001" }, ctx2)
    expect("po_number" in (withoutPo as unknown as Record<string, unknown>)).toBe(false)
  })

  // A cancelled order read back through orders_get reported itself as still live: the detail
  // query never selected the cancellation fields the normalizer maps, so an operator (and the
  // credit-note flow) saw cancelledAt/cancelReason as null on an order Shopify had cancelled,
  // while the same order showed cancelled in orders_search.
  it("reports the cancellation on a cancelled order, not a null that reads as still live", async () => {
    const base = {
      id: "gid://shopify/Order/2003",
      name: "#2003",
      email: "buyer@example.com",
      displayFinancialStatus: "REFUNDED",
      displayFulfillmentStatus: "UNFULFILLED",
      currentTotalPriceSet: { presentmentMoney: { amount: "0.00", currencyCode: "EUR" } },
      cancelledAt: "2026-09-10T17:05:01Z",
      cancelReason: "OTHER",
    }
    const { ctx, calls } = makeCtx({ fetchResponses: [{ data: { order: base } }] })
    const out = await orders_get({ id: "gid://shopify/Order/2003" }, ctx)
    const attrs = (out as unknown as { attributes: Record<string, unknown> }).attributes
    expect(attrs.cancelledAt).toBe("2026-09-10T17:05:01Z")
    expect(attrs.cancelReason).toBe("OTHER")
    // The fields are only ever populated if the query actually asks for them.
    const sent = calls[0]?.body ?? ""
    expect(sent).toContain("cancelledAt")
    expect(sent).toContain("cancelReason")
  })

  // Boxtal "To prepare" contract: a single-row refresh PULLS orders_get, so the internal staff
  // note must ride at the TOP LEVEL (distinct from attributes.note on the search hit).
  it("exposes the internal staff note at the top level, normalized to null when absent", async () => {
    const base = {
      id: "gid://shopify/Order/2002",
      name: "#2002",
      email: "buyer@example.com",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      currentTotalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
    }
    const { ctx } = makeCtx({
      fetchResponses: [{ data: { order: { ...base, note: "Ship with the spare pedal" } } }],
    })
    const withNote = await orders_get({ id: "gid://shopify/Order/2002" }, ctx)
    expect(withNote.note).toBe("Ship with the spare pedal")

    const { ctx: ctx2 } = makeCtx({
      fetchResponses: [{ data: { order: { ...base, note: null } } }],
    })
    const withoutNote = await orders_get({ id: "gid://shopify/Order/2002" }, ctx2)
    expect(withoutNote.note).toBeNull()

    // Shopify omitting the field entirely (undefined) must also normalize to null.
    const { ctx: ctx3 } = makeCtx({ fetchResponses: [{ data: { order: { ...base } } }] })
    const withAbsentNote = await orders_get({ id: "gid://shopify/Order/2002" }, ctx3)
    expect(withAbsentNote.note).toBeNull()
  })

  it("surfaces customerAddress (canonical) when the order has no per-order shippingAddress (BL-118)", async () => {
    // Regression: backfill-contact-from-order-history — Mason's order #1055 has shippingAddress:null
    // but his customer record carries the Nashville defaultAddress. orders_get must expose that
    // canonical address so the agent doesn't dead-end on the null order address.
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: "gid://shopify/Order/1055",
              name: "#1055",
              email: "mason.reed@example.com",
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "FULFILLED",
              currentTotalPriceSet: { presentmentMoney: { amount: "699.00", currencyCode: "USD" } },
              shippingAddress: null,
              customer: {
                id: "gid://shopify/Customer/24962297888934",
                email: "mason.reed@example.com",
                firstName: "Mason",
                lastName: "Reed",
                phone: null,
                defaultAddress: {
                  address1: "412 Music Row",
                  city: "Nashville",
                  province: "Tennessee",
                  provinceCode: "TN",
                  zip: "37203",
                  country: "United States",
                  countryCode: "US",
                },
              },
            },
          },
        },
      ],
    })
    const out = await orders_get({ id: "gid://shopify/Order/1055" }, ctx)
    expect(out.shippingAddress).toBeNull() // the order itself has no ship-to
    expect(out.customerAddress).not.toBeNull()
    expect(out.customerAddress?.address1).toBe("412 Music Row")
    expect(out.customerAddress?.city).toBe("Nashville")
    expect(out.customerAddress?.zip).toBe("37203")
  })

  // red: drop customAttributes / billingAddress from ORDERS_GET_QUERY's projection -> buyerTaxId and
  // the billing company come back null, and a re-driven invoice loses a VAT number added after checkout.
  it("returns the buyer VAT number from the order's current custom attributes and the billing company", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: "gid://shopify/Order/3001",
              name: "#3001",
              displayFinancialStatus: "PAID",
              currentTotalPriceSet: { presentmentMoney: { amount: "360.00", currencyCode: "EUR" } },
              shippingAddress: null,
              billingAddress: {
                name: "Gina Rossi",
                company: "Rossi Strumenti SRL",
                address1: "Via Roma 1",
                city: "Torino",
                zip: "10100",
                country: "Italy",
                countryCode: "IT",
              },
              customAttributes: [
                { key: "gift", value: "no" },
                { key: "VAT number", value: " IT01234567890 " },
              ],
              customer: null,
            },
          },
        },
      ],
    })
    const out = await orders_get({ id: "gid://shopify/Order/3001" }, ctx)
    expect(out.buyerTaxId).toBe("IT01234567890")
    expect(out.billingAddress?.company).toBe("Rossi Strumenti SRL")
    expect(out.billingAddress?.countryCode).toBe("IT")
    const query = String(calls[0]?.body ?? "")
    expect(query).toContain("customAttributes { key value }")
    expect(query).toContain("billingAddress { name company")
  })

  it("enriches the order-detail shape the OrderPanel renders (fulfillments/refunds/returns + panel fields)", async () => {
    // Regression: OrderPanel reads top-level name/fulfillmentStatus/customer.snake/
    // totalPrice/lineItems.priceSet/fulfillments/refunds/returns — orders_get used to
    // omit all of these, so the panel rendered an almost-empty order (no fulfillment
    // or refund ever shown). The visual-checkpoint gate caught it.
    const order = {
      data: {
        order: {
          id: "gid://shopify/Order/9",
          name: "#1001",
          email: "chaos@liaison.sh",
          tags: ["chaos-run-x"],
          displayFinancialStatus: "REFUNDED",
          displayFulfillmentStatus: "FULFILLED",
          currentTotalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "EUR" } },
          customer: { id: "c1", email: "chaos@liaison.sh", firstName: "Chaos", lastName: "Widget" },
          lineItems: {
            edges: [
              {
                node: {
                  id: "gid://shopify/LineItem/1",
                  title: "Chaos widget",
                  quantity: 1,
                  variant: { id: "v1", title: "Default", sku: "CW-1" },
                  originalUnitPriceSet: {
                    presentmentMoney: { amount: "10.00", currencyCode: "EUR" },
                  },
                },
              },
            ],
          },
          fulfillments: [
            { id: "gid://shopify/Fulfillment/7", status: "SUCCESS", trackingInfo: [] },
          ],
          refunds: [
            {
              id: "gid://shopify/Refund/3",
              note: null,
              totalRefundedSet: { presentmentMoney: { amount: "10.00", currencyCode: "EUR" } },
            },
          ],
          returns: { edges: [] },
        },
      },
    }
    const { ctx } = makeCtx({ fetchResponses: [order] })
    const out = await orders_get({ id: "gid://shopify/Order/9" }, ctx)
    // back-compat
    expect(out.entity).toBe("order")
    // panel header fields
    expect(out.name).toBe("#1001")
    expect(out.fulfillmentStatus).toBe("FULFILLED")
    expect(out.financialStatus).toBe("REFUNDED")
    expect(out.customer).toEqual({
      email: "chaos@liaison.sh",
      first_name: "Chaos",
      last_name: "Widget",
    })
    expect(out.totalPrice).toEqual({ amount: "10.00", currencyCode: "EUR" })
    // line item reshape (id+quantity preserved for refundRunOrder; priceSet + variant.title added)
    expect(out.lineItems[0]).toMatchObject({
      id: "gid://shopify/LineItem/1",
      quantity: 1,
      priceSet: { amount: "10.00", currencyCode: "EUR" },
      variant: { title: "Default", sku: "CW-1" },
    })
    // fulfillments + refunds now present so the panel can render them
    expect(out.fulfillments).toHaveLength(1)
    expect(out.fulfillments[0]).toMatchObject({
      id: "gid://shopify/Fulfillment/7",
      status: "SUCCESS",
    })
    expect(out.refunds).toHaveLength(1)
    expect(out.refunds[0]).toMatchObject({ id: "gid://shopify/Refund/3" })
    expect(Array.isArray(out.returns)).toBe(true)
  })

  it("throws on missing id", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(orders_get({}, ctx)).rejects.toThrow(/id is required/)
  })

  it("throws NOT_FOUND when Shopify returns no order", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { order: null } }] })
    await expect(orders_get({ id: "gid://shopify/Order/0" }, ctx)).rejects.toThrow(/not found/)
  })

  it("surfaces processedAt (true purchase date) for a backdated order — createdAt would read it as new", async () => {
    // Regression: decline-out-of-warranty-return (BL-240). A Gen-1 order backdated via orderCreate
    // (processedAt ≈ 3yr ago) carries createdAt ≈ NOW (record-creation time). A warranty-age decision
    // ("placed >2 years ago, outside the 2-year window") MUST be grounded in processedAt; if the surface
    // only exposed createdAt the agent would read the order as brand-new and could never justify the
    // decline by the order date — leaving the rubric structurally unsatisfiable.
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: "gid://shopify/Order/2200",
              name: "#2200",
              email: "liam.warranty@example.com",
              createdAt: "2026-06-17T00:00:00Z", // record created now (backdated import)
              processedAt: "2023-05-02T00:00:00Z", // true purchase date — >2yr ago
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "FULFILLED",
              currentTotalPriceSet: { presentmentMoney: { amount: "299.00", currencyCode: "EUR" } },
              customer: {
                id: "c2200",
                email: "liam.warranty@example.com",
                firstName: "Out",
                lastName: "OfWarranty",
              },
            },
          },
        },
      ],
    })
    const out = await orders_get({ id: "gid://shopify/Order/2200" }, ctx)
    expect(out.attributes.processedAt).toBe("2023-05-02T00:00:00Z")
    expect(out.attributes.createdAt).toBe("2026-06-17T00:00:00Z")
  })

  it("falls back processedAt to createdAt when absent (standard checkout order)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: "gid://shopify/Order/2201",
              name: "#2201",
              email: "std@example.com",
              createdAt: "2026-05-01T00:00:00Z",
              // no processedAt
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "FULFILLED",
              currentTotalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "EUR" } },
              customer: { id: "c2201", email: "std@example.com" },
            },
          },
        },
      ],
    })
    const out = await orders_get({ id: "gid://shopify/Order/2201" }, ctx)
    expect(out.attributes.processedAt).toBe("2026-05-01T00:00:00Z")
  })
})

// SEAM FIXTURE — the Boxtal "To prepare" cross-app contract, hand-written at
// src/__fixtures__/contract/order-note-contract.json. This asserts the REAL orders_search /
// orders_get handler outputs carry exactly those key paths, so a rename on the shopify side
// (attributes.note, top-level note) fails THIS suite immediately instead of only surfacing as a
// silent gap on the boxtal side.
describe("order note contract fixture matches the real handler output shapes", () => {
  const contract = JSON.parse(
    readFileSync(
      join(import.meta.dir, "__fixtures__", "contract", "order-note-contract.json"),
      "utf8",
    ),
  ) as {
    orders_search_hit: { id: string; name: string; attributes: { note: string } }
    orders_get: { name: string; note: string }
  }

  it("orders_search hit carries the note at attributes.note per the fixture", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: contract.orders_search_hit.id,
                    name: contract.orders_search_hit.name,
                    note: contract.orders_search_hit.attributes.note,
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "10.00", currencyCode: "USD" },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            ordersCount: { count: 1 },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    expect(out.results[0]!.attributes.note).toBe(contract.orders_search_hit.attributes.note)
  })

  it("orders_get carries the note at the top level per the fixture", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: contract.orders_search_hit.id,
              name: contract.orders_get.name,
              note: contract.orders_get.note,
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              currentTotalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
            },
          },
        },
      ],
    })
    const out = await orders_get({ id: contract.orders_search_hit.id }, ctx)
    expect(out.note).toBe(contract.orders_get.note)
    expect(out.name).toBe(contract.orders_get.name)
  })

  it("orders_search carries the long multi line non ASCII note through byte for byte with no truncation", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: contract.orders_search_hit.id,
                    name: contract.orders_search_hit.name,
                    note: contract.orders_search_hit.attributes.note,
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "10.00", currencyCode: "USD" },
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            ordersCount: { count: 1 },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    expect(out.results[0]!.attributes.note).toBe(contract.orders_search_hit.attributes.note)
    expect((out.results[0]!.attributes.note as string).length).toBe(
      contract.orders_search_hit.attributes.note.length,
    )
  })

  it("orders_get carries the long multi line non ASCII note through byte for byte with no truncation", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: contract.orders_search_hit.id,
              name: contract.orders_get.name,
              note: contract.orders_get.note,
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              currentTotalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
            },
          },
        },
      ],
    })
    const out = await orders_get({ id: contract.orders_search_hit.id }, ctx)
    expect(out.note).toBe(contract.orders_get.note)
    expect(out.note!.length).toBe(contract.orders_get.note.length)
  })
})

describe("orders_invoice_links", () => {
  it("resolves gids -> numeric ids for the invoicing lookup, then maps links back to the original gids", async () => {
    const calls: Array<{ target: string; args: Record<string, unknown> }> = []
    const { ctx } = makeCtx({
      fetchResponses: [],
      executeTool: async (target, args) => {
        calls.push({ target, args })
        return {
          status: "completed",
          result: {
            links: [
              {
                shopify_order_id: "1001",
                id: "doc-goods",
                number: "INV-2026-0001",
                type: "invoice",
                scope: "goods",
                status: "issued",
                payment_status: "unpaid",
              },
              {
                shopify_order_id: "1001",
                id: "doc-software",
                number: "INV-2026-0002",
                type: "invoice",
                scope: "software",
                status: "issued",
                payment_status: "unpaid",
              },
            ],
          },
        }
      },
    })
    const out = await orders_invoice_links(
      { order_ids: ["gid://shopify/Order/1001", "gid://shopify/Order/1002"] },
      ctx,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.target).toBe("invoicing:documents_for_orders")
    expect(calls[0]!.args).toEqual({ shopify_order_ids: ["1001", "1002"] })
    expect(out.links).toHaveLength(2)
    expect(out.links.every((l) => l.order_id === "gid://shopify/Order/1001")).toBe(true)
    expect(out.links.map((l) => l.invoice_id).sort()).toEqual(["doc-goods", "doc-software"])
  })

  it("passes a numeric id or an order name through, and maps each link back to the id the caller passed", async () => {
    const calls: Array<Record<string, unknown>> = []
    const { ctx } = makeCtx({
      fetchResponses: [],
      executeTool: async (_target, args) => {
        calls.push(args)
        const ids = args.shopify_order_ids as string[]
        return {
          status: "completed",
          result: {
            links: ids.map((id) => ({
              shopify_order_id: id,
              id: "doc-1097",
              number: "INV-2026-0023",
              type: "invoice",
              scope: "goods",
              status: "issued",
              payment_status: "paid",
            })),
          },
        }
      },
    })
    const asked = ["6100097", "#1097", "1097", "gid://shopify/Order/6100097"]
    const out = await orders_invoice_links({ order_ids: asked }, ctx)
    expect(calls[0]).toEqual({ shopify_order_ids: ["6100097", "#1097", "1097"] })
    expect(out.links.map((l) => l.order_id).sort()).toEqual([...asked].sort())
    expect(out.links.every((l) => l.invoice_id === "doc-1097")).toBe(true)
  })

  it("invoicing returns an error envelope -> { links: [] }", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [],
      executeTool: async () => ({
        status: "error",
        error: { code: "not_installed", message: "invoicing is not installed" },
      }),
    })
    const out = await orders_invoice_links({ order_ids: ["gid://shopify/Order/1001"] }, ctx)
    expect(out).toEqual({ links: [] })
  })

  it("executeTool throws -> { links: [] }", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [],
      executeTool: async () => {
        throw new Error("cross-app dispatch failed")
      },
    })
    const out = await orders_invoice_links({ order_ids: ["gid://shopify/Order/1001"] }, ctx)
    expect(out).toEqual({ links: [] })
  })

  it("empty order_ids -> { links: [] } and NO cross-app call is made", async () => {
    let called = false
    const { ctx } = makeCtx({
      fetchResponses: [],
      executeTool: async () => {
        called = true
        return { status: "completed", result: { links: [] } }
      },
    })
    const out = await orders_invoice_links({ order_ids: [] }, ctx)
    expect(out).toEqual({ links: [] })
    expect(called).toBe(false)

    const out2 = await orders_invoice_links({}, ctx)
    expect(out2).toEqual({ links: [] })
    expect(called).toBe(false)
  })
})

describe("orders_search line items for the orders list", () => {
  it("asks for each line's requiresShipping and carries it on the hit with sku, title and tags", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/4400",
                    name: "#4400",
                    tags: ["wholesale"],
                    currentTotalPriceSet: {
                      presentmentMoney: { amount: "10.00", currencyCode: "EUR" },
                    },
                    requiresShipping: true,
                    currentSubtotalLineItemsQuantity: 14,
                    lineItems: {
                      pageInfo: { hasNextPage: true },
                      edges: [
                        {
                          node: {
                            title: "Device 2",
                            quantity: 2,
                            currentQuantity: 1,
                            requiresShipping: true,
                            variant: { sku: "DEV-2" },
                          },
                        },
                        {
                          node: {
                            title: "Licence",
                            quantity: 1,
                            requiresShipping: false,
                            variant: { sku: "LIC" },
                          },
                        },
                        { node: { title: "Old line", quantity: 2, variant: null } },
                      ],
                    },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
            ordersCount: { count: 1 },
          },
        },
      ],
    })
    const out = await orders_search({}, ctx)
    expect(calls[0]!.body).toContain("requiresShipping")
    expect(out.results[0]!.attributes.tags).toEqual(["wholesale"])
    expect(calls[0]!.body).toContain("currentQuantity")
    expect(calls[0]!.body).toContain("currentSubtotalLineItemsQuantity")
    expect(calls[0]!.body).toMatch(/lineItems\(first: 10\) \{ pageInfo \{ hasNextPage \}/)
    expect(out.results[0]!.attributes).toMatchObject({
      requiresShipping: true,
      lineItemsMore: true,
      itemsQuantity: 14,
    })
    expect(out.results[0]!.attributes.lineItems).toEqual([
      { sku: "DEV-2", title: "Device 2", quantity: 2, currentQuantity: 1, requiresShipping: true },
      { sku: "LIC", title: "Licence", quantity: 1, currentQuantity: null, requiresShipping: false },
      { sku: null, title: "Old line", quantity: 2, currentQuantity: null, requiresShipping: null },
    ])
  })
})

describe("products_short_codes", () => {
  it("reads short codes by SKU from the kernel's product attributes", async () => {
    const calls: Array<{ target: string; args: Record<string, unknown> }> = []
    const { ctx } = makeCtx({
      fetchResponses: [],
      executeTool: async (target, args) => {
        calls.push({ target, args })
        return {
          status: "completed",
          result: {
            attributes: [
              { sku: "DEV-2", key: "short_code", value: "E2" },
              { sku: "STAND", key: "short_code", value: " FS " },
              { sku: "BLANK", key: "short_code", value: "" },
            ],
            truncated: false,
          },
        }
      },
    })
    const out = await products_short_codes(
      { skus: ["DEV-2", "STAND", "DEV-2", " ", "UNKNOWN"] },
      ctx,
    )
    expect(calls).toEqual([
      {
        target: "kernel:product_attributes_list",
        args: { skus: ["DEV-2", "STAND", "UNKNOWN"], keys: ["short_code"] },
      },
    ])
    expect(out).toEqual({ codes: { "DEV-2": "E2", STAND: "FS" } })
  })

  it("is best effort: a failed or refused lookup returns no codes, and no SKUs means no call", async () => {
    let called = 0
    const { ctx } = makeCtx({
      fetchResponses: [],
      executeTool: async () => {
        called++
        if (called === 1) throw new Error("boom")
        return { status: "error", error: { code: "forbidden", message: "no" } }
      },
    })
    expect(await products_short_codes({ skus: ["A"] }, ctx)).toEqual({ codes: {} })
    expect(await products_short_codes({ skus: ["A"] }, ctx)).toEqual({ codes: {} })
    expect(await products_short_codes({ skus: [] }, ctx)).toEqual({ codes: {} })
    expect(called).toBe(2)
  })
})

describe("customers_search", () => {
  it("normalizes title from first/last name and extracts market: tag", async () => {
    const fixture = loadFixture("customers-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await customers_search({}, ctx)
    expect(out.results[0]!.entity).toBe("customer")
    expect(out.results[0]!.title).toMatch(/Marie\s+Dupont/)
    expect(out.results[0]!.market).toBe("canada")
    expect(out.results[0]!.currency).toBe("USD")
  })

  it("strips internal liaison-seed* bookkeeping tags from surfaced customer tags (real merchant tags pass through)", async () => {
    const fixture = loadFixture("customers-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await customers_search({}, ctx)
    for (const hit of out.results) {
      const tags = (hit.attributes as Record<string, unknown>).tags as string[]
      // Test-infra seeding tags must NOT reach the agent — they let an adversarial
      // "is this real data?" probe mislabel a genuine customer as synthetic.
      expect(tags.some((t) => t === "liaison-seed" || t.startsWith("liaison-seed-"))).toBe(false)
    }
    // The market: tag (a real merchant convention) still survives somewhere in the set.
    const allTags = out.results.flatMap(
      (h) => (h.attributes as Record<string, unknown>).tags as string[],
    )
    expect(allTags.some((t) => t.startsWith("market:"))).toBe(true)
  })

  it("surfaces server-side totalCount so the agent can ground a partial-coverage bound (reviewed N of totalCount)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            customersCount: { count: 95 },
            customers: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Customer/1",
                    email: "a@example.com",
                    firstName: "A",
                    lastName: "B",
                    tags: [],
                    numberOfOrders: "1",
                    amountSpent: { amount: "1200", currencyCode: "EUR" },
                  },
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cur1" },
            },
          },
        },
      ],
    })
    const out = await customers_search({ limit: 1 }, ctx)
    // The page returned 1 of 95 — totalCount is the honest denominator for "reviewed N of total".
    expect(out.totalCount).toBe(95)
    expect(out.results).toHaveLength(1)
    expect(out.nextCursor).toBe("cur1")
  })

  it("falls back totalCount to the page size when customersCount is absent (never undefined)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            customers: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Customer/2",
                    email: "c@example.com",
                    firstName: "C",
                    lastName: "D",
                    tags: [],
                    numberOfOrders: "0",
                    amountSpent: { amount: "0", currencyCode: "EUR" },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ],
    })
    const out = await customers_search({}, ctx)
    expect(out.totalCount).toBe(1)
    expect(out.nextCursor).toBeNull()
  })
})

describe("customers_segment_search (server-side spend segment)", () => {
  // The affordance behind the ines_week_growth S9 over-claim fix: the agent must
  // be able to build a high-value spend segment WITHOUT enumerating a 1,710-customer
  // base. This tool asks Shopify's segment engine to evaluate `amount_spent > N`
  // server-side, returning ONLY the matching customers + a server-side totalCount —
  // so coverage is complete + bounded in one call, never page-and-extrapolate.
  function segmentResponse(opts: {
    totalCount: number
    members: Array<{
      id: string
      email: string
      first: string
      last: string
      amount: string
      currency: string
      orders: string
    }>
    hasNextPage?: boolean
    endCursor?: string | null
  }) {
    return {
      data: {
        customerSegmentMembers: {
          totalCount: opts.totalCount,
          edges: opts.members.map((m) => ({
            node: {
              id: m.id,
              firstName: m.first,
              lastName: m.last,
              displayName: `${m.first} ${m.last}`,
              defaultEmailAddress: { emailAddress: m.email },
              defaultPhoneNumber: null,
              numberOfOrders: m.orders,
              amountSpent: { amount: m.amount, currencyCode: m.currency },
            },
          })),
          pageInfo: { hasNextPage: opts.hasNextPage ?? false, endCursor: opts.endCursor ?? null },
        },
      },
    }
  }

  it("issues a server-side `amount_spent > N` segment query (not a whole-base enumeration)", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        segmentResponse({
          totalCount: 5,
          members: [
            {
              id: "gid://shopify/CustomerSegmentMember/1",
              email: "marie@example.com",
              first: "Marie",
              last: "Dupont",
              amount: "1495.0",
              currency: "USD",
              orders: "2",
            },
          ],
        }),
      ],
    })
    const out = await customers_segment_search({ minSpend: 1000 }, ctx)
    // The GraphQL request body must carry the server-side spend predicate — this is
    // what makes the segment BOUNDED + COMPLETE instead of a paged whole-base sweep.
    expect(calls[0]!.body).toContain("amount_spent > 1000")
    expect(calls[0]!.body).toContain("customerSegmentMembers")
    // Returns ONLY the matching members + the server-side total of ALL matches.
    expect(out.totalCount).toBe(5)
    expect(out.results[0]!.entity).toBe("customer")
    expect(out.results[0]!.title).toMatch(/Marie\s+Dupont/)
    expect((out.results[0]!.attributes as Record<string, unknown>).email).toBe("marie@example.com")
  })

  it("surfaces each member's native amountSpent + currency so the agent can disclose the unit (no silent EUR assumption)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        segmentResponse({
          totalCount: 2,
          members: [
            {
              id: "gid://shopify/CustomerSegmentMember/1",
              email: "a@example.com",
              first: "A",
              last: "Aa",
              amount: "1495.0",
              currency: "USD",
              orders: "2",
            },
            {
              id: "gid://shopify/CustomerSegmentMember/2",
              email: "b@example.com",
              first: "B",
              last: "Bb",
              amount: "4473.6",
              currency: "USD",
              orders: "1",
            },
          ],
        }),
      ],
    })
    const out = await customers_segment_search({ minSpend: 1000 }, ctx)
    expect(out.results).toHaveLength(2)
    for (const hit of out.results) {
      const spend = (hit.attributes as Record<string, unknown>).amountSpent as {
        amount: string
        currencyCode: string
      }
      expect(spend.currencyCode).toBe("USD")
      expect(hit.currency).toBe("USD")
    }
  })

  it("reports complete coverage when the whole segment fits one page (nextCursor=null, totalCount==page)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        segmentResponse({
          totalCount: 5,
          members: Array.from({ length: 5 }, (_v, i) => ({
            id: `gid://shopify/CustomerSegmentMember/${i + 1}`,
            email: `c${i}@example.com`,
            first: "C",
            last: String(i),
            amount: "1500",
            currency: "USD",
            orders: "1",
          })),
          hasNextPage: false,
          endCursor: null,
        }),
      ],
    })
    const out = await customers_segment_search({ minSpend: 1000, limit: 100 }, ctx)
    // 5 of 5, no further page → the agent has the COMPLETE high-value set, not a sample.
    expect(out.totalCount).toBe(5)
    expect(out.results).toHaveLength(5)
    expect(out.nextCursor).toBeNull()
  })

  it("rejects a missing/invalid minSpend (the threshold is required)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(customers_segment_search({}, ctx)).rejects.toThrow(/minSpend/)
    await expect(customers_segment_search({ minSpend: "abc" }, ctx)).rejects.toThrow(/minSpend/)
    await expect(customers_segment_search({ minSpend: -1 }, ctx)).rejects.toThrow(/minSpend/)
  })

  it("accepts a numeric-string minSpend and passes it through to the segment query", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [segmentResponse({ totalCount: 0, members: [] })],
    })
    const out = await customers_segment_search({ minSpend: "1000" }, ctx)
    expect(calls[0]!.body).toContain("amount_spent > 1000")
    expect(out.totalCount).toBe(0)
    expect(out.results).toHaveLength(0)
  })
})

describe("customers_get", () => {
  it("returns a single normalized customer", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            customer: {
              id: "gid://shopify/Customer/1",
              email: "x@example.com",
              firstName: "X",
              lastName: "Y",
              tags: ["market:us"],
              numberOfOrders: "3",
              amountSpent: { amount: "100", currencyCode: "USD" },
            },
          },
        },
      ],
    })
    const out = await customers_get({ id: "gid://shopify/Customer/1" }, ctx)
    expect(out.entity).toBe("customer")
    expect(out.market).toBe("us")
    // No B2B / tax data from Shopify: exempt defaults to false, no companies.
    expect(out.attributes.taxExempt).toBe(false)
    expect(out.attributes.companies).toEqual([])
  })

  it("surfaces taxExempt and the B2B companies the customer belongs to, and asks for them", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            customer: {
              id: "gid://shopify/Customer/8",
              email: "buyer@example.com",
              tags: [],
              taxExempt: true,
              companyContactProfiles: [
                { company: { name: "Example Trading Ltd" } },
                { company: { name: "Sample Supplies GmbH" } },
                { company: null },
              ],
            },
          },
        },
      ],
    })
    const out = await customers_get({ id: "gid://shopify/Customer/8" }, ctx)
    expect(out.attributes.taxExempt).toBe(true)
    expect(out.attributes.companies).toEqual([
      { name: "Example Trading Ltd" },
      { name: "Sample Supplies GmbH" },
    ])
    const sent = (JSON.parse(calls[0]?.body ?? "{}") as { query?: string }).query ?? ""
    expect(sent).toContain("companyContactProfiles { company { name } }")
    expect(sent).toContain("taxExempt")
  })

  it("surfaces the customer's canonical postal defaultAddress + phone for address backfill (BL-118)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            customer: {
              id: "gid://shopify/Customer/3",
              email: "mason.reed@example.com",
              phone: null,
              firstName: "Mason",
              lastName: "Reed",
              tags: [],
              defaultAddress: {
                address1: "412 Music Row",
                address2: null,
                city: "Nashville",
                province: "Tennessee",
                provinceCode: "TN",
                zip: "37203",
                country: "United States",
                countryCode: "US",
                phone: "+1-615-555-0142",
              },
              numberOfOrders: "4",
              amountSpent: { amount: "1200", currencyCode: "USD" },
            },
          },
        },
      ],
    })
    const out = await customers_get({ id: "gid://shopify/Customer/3" }, ctx)
    const attrs = out.attributes as Record<string, unknown>
    const addr = attrs.defaultAddress as Record<string, unknown> | null
    expect(addr).not.toBeNull()
    expect(addr?.address1).toBe("412 Music Row")
    expect(addr?.city).toBe("Nashville")
    expect(addr?.zip).toBe("37203")
    expect(addr?.province).toBe("Tennessee")
    // phone falls back to the address phone when the customer record has none.
    expect(attrs.phone).toBe("+1-615-555-0142")
  })

  it("defaultAddress is null when the customer has no address on file (no fabrication)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            customer: {
              id: "gid://shopify/Customer/4",
              email: "noaddr@example.com",
              firstName: "No",
              lastName: "Addr",
              tags: [],
              numberOfOrders: "0",
              amountSpent: { amount: "0", currencyCode: "USD" },
            },
          },
        },
      ],
    })
    const out = await customers_get({ id: "gid://shopify/Customer/4" }, ctx)
    const attrs = out.attributes as Record<string, unknown>
    expect(attrs.defaultAddress).toBeNull()
    expect(attrs.phone).toBeNull()
  })

  it("surfaces recentOrders with product titles so the agent can name what the customer bought (BL-117)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            customer: {
              id: "gid://shopify/Customer/2",
              email: "lukas.berg@example.de",
              firstName: "Lukas",
              lastName: "Berg",
              tags: [],
              numberOfOrders: "1",
              amountSpent: { amount: "699", currencyCode: "EUR" },
              orders: {
                edges: [
                  {
                    node: {
                      name: "#1057",
                      lineItems: { edges: [{ node: { title: "Kestrel 6", quantity: 1 } }] },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    })
    const out = await customers_get({ id: "gid://shopify/Customer/2" }, ctx)
    const recentOrders = (out.attributes as Record<string, unknown>).recentOrders as {
      name: string
      items: { title: string; quantity: number }[]
    }[]
    expect(recentOrders).toHaveLength(1)
    expect(recentOrders[0]!.name).toBe("#1057")
    expect(recentOrders[0]!.items[0]!.title).toBe("Kestrel 6")
  })
})

describe("products_search", () => {
  it("returns normalized hits with variant count + first price", async () => {
    const fixture = loadFixture("products-search.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await products_search({}, ctx)
    expect(out.results[0]!.entity).toBe("product")
    expect(
      (out.results[0]!.attributes as Record<string, unknown>).variantCount,
    ).toBeGreaterThanOrEqual(1)
  })
})

describe("products_get", () => {
  it("returns single product with all variants", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Widget",
              vendor: "ACME",
              status: "ACTIVE",
              totalInventory: 10,
              variants: {
                edges: [
                  {
                    node: {
                      id: "v1",
                      sku: "W-1",
                      price: "9.99",
                      inventoryQuantity: 5,
                      title: "Default",
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    })
    const out = await products_get({ id: "gid://shopify/Product/1" }, ctx)
    expect(out.title).toBe("Widget")
  })

  it("surfaces customs data — native HS code + country of origin + customs-description metafield", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            product: {
              id: "gid://shopify/Product/2",
              title: "Kestrel 2",
              status: "ACTIVE",
              totalInventory: 3,
              customsDescription: { value: "Electronic pad controller" },
              variants: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/ProductVariant/22",
                      sku: "P2P-1",
                      price: "300.00",
                      inventoryQuantity: 3,
                      title: "Black",
                      inventoryItem: { harmonizedSystemCode: "9207.10", countryCodeOfOrigin: "CN" },
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    })
    const out = await products_get({ id: "gid://shopify/Product/2" }, ctx)
    const attrs = out.attributes as {
      customs_description?: string
      variants?: Array<{
        hs_code?: string
        country_of_origin?: string
        customs_description?: string
      }>
    }
    expect(attrs.customs_description).toBe("Electronic pad controller")
    const v = attrs.variants?.[0]
    expect(v?.hs_code).toBe("9207.10")
    expect(v?.country_of_origin).toBe("CN")
    expect(v?.customs_description).toBe("Electronic pad controller")
  })
})

describe("markets_list", () => {
  it("returns normalized markets with base currency + handle", async () => {
    const fixture = loadFixture("markets-list.json")
    const { ctx } = makeCtx({ fetchResponses: [fixture] })
    const out = await markets_list({}, ctx)
    expect(out.results.length).toBeGreaterThan(0)
    const canada = out.results.find((r) => r.title === "Canada")
    expect(canada?.market).toBe("canada")
    expect(canada?.currency).toBe("CAD")
  })
})

// — B6b additions: variants, inventory, fulfillments, returns, refunds, discounts, metafields —

describe("variants_search", () => {
  it("returns normalized variant hits with sku + price", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            productVariants: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/ProductVariant/1",
                    sku: "WIDGET-RED",
                    title: "Red",
                    price: "19.99",
                    inventoryQuantity: 7,
                    displayName: "Widget — Red",
                    product: { id: "gid://shopify/Product/100", title: "Widget" },
                    inventoryItem: { id: "gid://shopify/InventoryItem/55" },
                  },
                },
              ],
              pageInfo: { endCursor: "c1", hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await variants_search({ query: "sku:WIDGET-RED" }, ctx)
    expect(out.results.length).toBe(1)
    expect(out.results[0]!.entity).toBe("variant")
    expect(out.results[0]!.title).toBe("Widget — Red")
    expect((out.results[0]!.attributes as Record<string, unknown>).sku).toBe("WIDGET-RED")
    // The inventory item id must be surfaced so the agent can chain SKU → item → inventory_levels_list
    // (the stock-check scenarios). Without it the documented chain is structurally unobtainable.
    expect((out.results[0]!.attributes as Record<string, unknown>).inventory_item_id).toBe(
      "gid://shopify/InventoryItem/55",
    )
    expect(out.nextCursor).toBe("c1")
  })
})

describe("variants_search filters", () => {
  const variantsPage = {
    data: {
      productVariants: {
        edges: [
          {
            node: {
              id: "gid://shopify/ProductVariant/2",
              sku: "W-OLD",
              title: "Old",
              price: "9.00",
              inventoryQuantity: 0,
              product: { id: "gid://shopify/Product/200", title: "Widget", status: "ARCHIVED" },
            },
          },
        ],
        pageInfo: { endCursor: null, hasNextPage: false },
      },
    },
  }

  it("composes product_status and min_quantity into the server-side query", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [variantsPage] })
    await variants_search(
      { query: "sku:W-*", product_status: ["ACTIVE", "draft"], min_quantity: 1 },
      ctx,
    )
    const body = JSON.parse(calls[0]!.body) as { variables?: { query?: string } }
    expect(body.variables?.query).toBe("sku:W-* product_status:active,draft inventory_quantity:>=1")
    expect(variantsSearchQuery({})).toBeNull()
    expect(variantsSearchQuery({ product_status: "ACTIVE" })).toBe("product_status:active")
    expect(variantsSearchQuery({ min_quantity: "5" })).toBe("inventory_quantity:>=5")
  })

  it("returns the parent product's status on each hit", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [variantsPage] })
    const out = await variants_search({ query: "sku:W-OLD" }, ctx)
    expect((out.results[0]!.attributes as Record<string, unknown>).productStatus).toBe("ARCHIVED")
    expect(JSON.parse(calls[0]!.body).query).toMatch(/product \{ id title status /)
  })

  it("FAILS LOUD (BAD_PARAM) on an unknown status or a fractional quantity", () => {
    expect(() => variantsSearchQuery({ product_status: ["ACTIVE", "SOLD_OUT"] })).toThrow(
      /product_status must list/,
    )
    expect(() => variantsSearchQuery({ product_status: [] })).toThrow(/product_status must list/)
    expect(() => variantsSearchQuery({ min_quantity: 1.5 })).toThrow(
      /min_quantity must be a whole number/,
    )
  })
})

describe("variants_get", () => {
  it("returns single normalized variant", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            productVariant: {
              id: "gid://shopify/ProductVariant/9",
              sku: "X-9",
              title: "Default",
              price: "5.00",
              inventoryQuantity: 3,
              displayName: "X",
              product: { id: "gid://shopify/Product/9", title: "X" },
            },
          },
        },
      ],
    })
    const out = await variants_get({ id: "gid://shopify/ProductVariant/9" }, ctx)
    expect(out.entity).toBe("variant")
    expect(out.id).toMatch(/ProductVariant\/9$/)
  })

  it("throws NOT_FOUND when variant is null", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { productVariant: null } }] })
    await expect(variants_get({ id: "gid://shopify/ProductVariant/0" }, ctx)).rejects.toThrow(
      /not found/,
    )
  })
})

describe("variants_market_price (per-market contextual price)", () => {
  // Mirrors the live dev store: RAL-44/Kestrel 6 base 699 (shop currency USD),
  // US-market contextual price 699 USD. The whole point of the tool is that the
  // reported price comes from Shopify's contextualPricing, not a fabricated FX.
  function ral44UsResponse() {
    return {
      data: {
        productVariant: {
          id: "gid://shopify/ProductVariant/56563565920422",
          sku: "RAL-44",
          title: "Default Title",
          displayName: "Kestrel 6 - Default Title",
          price: "699.00",
          product: { id: "gid://shopify/Product/15342095564966", title: "Kestrel 6" },
          contextualPricing: {
            price: { amount: "699.0", currencyCode: "USD" },
            compareAtPrice: null,
          },
        },
      },
    }
  }

  it("returns the contextual US-market price + currency, distinct from base", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [ral44UsResponse()] })
    const out = await variants_market_price(
      { id: "gid://shopify/ProductVariant/56563565920422", country: "US", marketHandle: "us" },
      ctx,
    )
    expect(out.entity).toBe("variant_market_price")
    // The reported price is the CONTEXTUAL market price, in the market currency.
    expect(out.currency).toBe("USD")
    expect(out.market).toBe("us")
    expect(out.attributes.market_price).toBe("699.0")
    expect(out.attributes.market_currency).toBe("USD")
    expect(out.attributes.country).toBe("US")
    // The home/base price is surfaced alongside so the agent can disambiguate
    // without inventing a conversion.
    expect(out.attributes.base_price).toBe("699.00")
    expect(out.attributes.sku).toBe("RAL-44")
    // The query must carry the requested country into contextualPricing — this is
    // what makes the price market-specific (regression: a market-agnostic read
    // would not pass `country` and would report the base price as the answer).
    const body = JSON.parse(calls[0]!.body) as { variables: Record<string, unknown> }
    expect(body.variables.country).toBe("US")
  })

  it("reports a real FX-converted market price for a foreign market (CA → CAD)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            productVariant: {
              id: "gid://shopify/ProductVariant/56563565920422",
              sku: "RAL-44",
              displayName: "Kestrel 6 - Default Title",
              price: "699.00",
              product: { id: "gid://shopify/Product/15342095564966", title: "Kestrel 6" },
              contextualPricing: {
                price: { amount: "954.0", currencyCode: "CAD" },
                compareAtPrice: null,
              },
            },
          },
        },
      ],
    })
    const out = await variants_market_price(
      { id: "gid://shopify/ProductVariant/56563565920422", country: "CA" },
      ctx,
    )
    // The market currency + price come from Shopify, not a hand-rolled rate.
    expect(out.currency).toBe("CAD")
    expect(out.attributes.market_price).toBe("954.0")
    // No marketHandle passed → market falls back to the country code.
    expect(out.market).toBe("CA")
  })

  it("accepts a bare numeric variant id and normalizes it to a gid", async () => {
    const { ctx, calls } = makeCtx({ fetchResponses: [ral44UsResponse()] })
    await variants_market_price({ id: "56563565920422", country: "US" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables: { id: string } }
    expect(body.variables.id).toBe("gid://shopify/ProductVariant/56563565920422")
  })

  it("rejects a missing or non-ISO country (no silent fallback to base price)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(
      variants_market_price({ id: "gid://shopify/ProductVariant/1" }, ctx),
    ).rejects.toThrow(/country is required/)
    await expect(
      variants_market_price({ id: "gid://shopify/ProductVariant/1", country: "us-market" }, ctx),
    ).rejects.toThrow(/country is required/)
  })

  it("throws NOT_FOUND when the variant does not exist", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { productVariant: null } }] })
    await expect(
      variants_market_price({ id: "gid://shopify/ProductVariant/0", country: "US" }, ctx),
    ).rejects.toThrow(/not found/)
  })

  it("normalizeCountryCode validates ISO alpha-2 shape", () => {
    expect(ReadsTestAccess.normalizeCountryCode("us")).toBe("US")
    expect(ReadsTestAccess.normalizeCountryCode(" Ca ")).toBe("CA")
    expect(ReadsTestAccess.normalizeCountryCode("USA")).toBeNull()
    expect(ReadsTestAccess.normalizeCountryCode("u")).toBeNull()
    expect(ReadsTestAccess.normalizeCountryCode(42)).toBeNull()
  })
})

describe("inventory_levels_list", () => {
  it("returns normalized inventory levels per location", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            inventoryItem: {
              id: "gid://shopify/InventoryItem/1",
              sku: "WIDGET-RED",
              inventoryLevels: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/InventoryLevel/1",
                      location: { id: "gid://shopify/Location/loc1", name: "Main" },
                      quantities: [
                        { name: "available", quantity: 10 },
                        { name: "on_hand", quantity: 12 },
                      ],
                    },
                  },
                  {
                    node: {
                      id: "gid://shopify/InventoryLevel/2",
                      location: { id: "gid://shopify/Location/loc2", name: "Branch" },
                      quantities: [
                        { name: "available", quantity: 3 },
                        { name: "on_hand", quantity: 4 },
                      ],
                    },
                  },
                ],
                pageInfo: { endCursor: "c2", hasNextPage: false },
              },
            },
          },
        },
      ],
    })
    const out = await inventory_levels_list(
      { inventoryItemId: "gid://shopify/InventoryItem/1" },
      ctx,
    )
    expect(out.results.length).toBe(2)
    expect(out.results[0]!.entity).toBe("inventory_level")
    // Reads from the 2024-04+ `quantities(names: […])` projection (the scalar `available` was
    // removed by API 2026-01 — querying it hard-failed the tool). Both on_hand + available surface.
    expect((out.results[0]!.attributes as Record<string, unknown>).on_hand).toBe(12)
    expect((out.results[0]!.attributes as Record<string, unknown>).available).toBe(10)
    expect((out.results[1]!.attributes as Record<string, unknown>).on_hand).toBe(4)
  })

  it("throws on missing inventoryItemId", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(inventory_levels_list({}, ctx)).rejects.toThrow(/inventoryItemId/)
  })

  // Regression (stockout-mid-launch-kestrel-6-oversell): the oversell-crisis reconciliation needs the
  // AUTHORITATIVE committed/oversold signal, not just on_hand/available. `committed` (units reserved
  // against open/unfulfilled orders) MUST surface per location so the agent can compute the oversold
  // delta as committed − on_hand (= −available) and reconcile its hand-tally against it. The judge
  // anchors the oversell on this inventory truth; if committed is absent the agent confuses available
  // (the negative overhang) with on_hand and the counts never match the fixture.
  it("surfaces committed alongside on_hand and available (oversell signal)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            inventoryItem: {
              id: "gid://shopify/InventoryItem/1",
              sku: "RAL-44",
              inventoryLevels: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/InventoryLevel/1",
                      location: { id: "gid://shopify/Location/shop", name: "Shop location" },
                      // Oversold: 70 units committed against 0 on-hand → available -70.
                      quantities: [
                        { name: "available", quantity: -70 },
                        { name: "on_hand", quantity: 0 },
                        { name: "committed", quantity: 70 },
                      ],
                    },
                  },
                  {
                    node: {
                      id: "gid://shopify/InventoryLevel/2",
                      location: { id: "gid://shopify/Location/tls", name: "Toulouse" },
                      quantities: [
                        { name: "available", quantity: 40 },
                        { name: "on_hand", quantity: 40 },
                        { name: "committed", quantity: 0 },
                      ],
                    },
                  },
                ],
                pageInfo: { endCursor: "c2", hasNextPage: false },
              },
            },
          },
        },
      ],
    })
    const out = await inventory_levels_list(
      { inventoryItemId: "gid://shopify/InventoryItem/1" },
      ctx,
    )
    expect(out.results.length).toBe(2)
    const shop = out.results[0]!.attributes as Record<string, unknown>
    const tls = out.results[1]!.attributes as Record<string, unknown>
    expect(shop.on_hand).toBe(0)
    expect(shop.available).toBe(-70)
    expect(shop.committed).toBe(70)
    expect(tls.on_hand).toBe(40)
    expect(tls.committed).toBe(0)
    // The authoritative oversold delta reconciles: total committed (70) − total on_hand (40) = 30,
    // which also equals −(total available) when summed across locations (−(−70 + 40) = 30).
    const totalOnHand = (shop.on_hand as number) + (tls.on_hand as number)
    const totalCommitted = (shop.committed as number) + (tls.committed as number)
    expect(totalCommitted - totalOnHand).toBe(30)
  })
})

describe("fulfillments_get", () => {
  it("returns normalized fulfillment with tracking info", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            fulfillment: {
              id: "gid://shopify/Fulfillment/1",
              status: "SUCCESS",
              createdAt: "2026-05-01T00:00:00Z",
              trackingInfo: [{ company: "DHL", number: "1Z", url: "https://example/track" }],
              order: { id: "gid://shopify/Order/100", name: "#1100" },
              fulfillmentLineItems: { edges: [{ node: { id: "fli1", quantity: 2 } }] },
            },
          },
        },
      ],
    })
    const out = await fulfillments_get({ id: "gid://shopify/Fulfillment/1" }, ctx)
    expect(out.entity).toBe("fulfillment")
    expect(out.title).toBe("#1100")
    expect((out.attributes as Record<string, unknown>).status).toBe("SUCCESS")
  })

  it("throws NOT_FOUND when fulfillment is null", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { fulfillment: null } }] })
    await expect(fulfillments_get({ id: "gid://shopify/Fulfillment/0" }, ctx)).rejects.toThrow(
      /not found/,
    )
  })
})

describe("returns_search (order-scoped — top-level `returns` removed in API 2026-01)", () => {
  it("flattens returns from orders matched by return status, attaching the parent-order context", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            orders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Order/100",
                    name: "#1100",
                    tags: [],
                    returns: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/Return/1",
                            name: "#R1",
                            status: "OPEN",
                            totalQuantity: 2,
                          },
                        },
                      ],
                    },
                  },
                },
              ],
              pageInfo: { endCursor: "c3", hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await returns_search({}, ctx)
    // Queries ORDERS (not the removed top-level `returns`) with a return-status filter.
    const body = JSON.parse(calls[0]!.body) as { query: string; variables: { query: string } }
    expect(body.query).toContain("orders(")
    expect(body.variables.query).toContain("return_status")
    expect(out.results[0]!.entity).toBe("return")
    expect(out.results[0]!.title).toBe("#R1")
    expect((out.results[0]!.attributes as Record<string, unknown>).status).toBe("OPEN")
    expect(
      ((out.results[0]!.attributes as Record<string, unknown>).order as { name: string }).name,
    ).toBe("#1100")
  })

  it("lists a single order's returns when orderId is given", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            order: {
              id: "gid://shopify/Order/100",
              name: "#1100",
              tags: [],
              returns: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/Return/9",
                      name: "#R9",
                      status: "REQUESTED",
                      totalQuantity: 1,
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    })
    const out = await returns_search({ orderId: "gid://shopify/Order/100" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { query: string }
    expect(body.query).toContain("order(id:") // by-id path
    expect(out.results[0]!.title).toBe("#R9")
    expect(out.nextCursor).toBeNull()
  })
})

describe("refunds_get", () => {
  it("returns normalized refund with totalRefunded currency", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            refund: {
              id: "gid://shopify/Refund/1",
              note: "broken",
              createdAt: "2026-05-10T00:00:00Z",
              totalRefundedSet: {
                presentmentMoney: { amount: "25.00", currencyCode: "EUR" },
                shopMoney: { amount: "25.00", currencyCode: "USD" },
              },
              order: { id: "gid://shopify/Order/200", name: "#1200" },
            },
          },
        },
      ],
    })
    const out = await refunds_get({ id: "gid://shopify/Refund/1" }, ctx)
    expect(out.entity).toBe("refund")
    expect(out.currency).toBe("EUR")
    expect((out.attributes as Record<string, unknown>).note).toBe("broken")
  })

  it("throws NOT_FOUND when refund is null", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { refund: null } }] })
    await expect(refunds_get({ id: "gid://shopify/Refund/0" }, ctx)).rejects.toThrow(/not found/)
  })
})

describe("discounts_search", () => {
  it("returns normalized discount-code hits", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            codeDiscountNodes: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/DiscountCodeNode/1",
                    codeDiscount: {
                      __typename: "DiscountCodeBasic",
                      title: "SPRING10",
                      status: "ACTIVE",
                      codes: { edges: [{ node: { code: "SPRING10" } }] },
                      startsAt: "2026-04-01T00:00:00Z",
                      endsAt: "2026-06-01T00:00:00Z",
                    },
                  },
                },
              ],
              pageInfo: { endCursor: "c4", hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await discounts_search({}, ctx)
    expect(out.results[0]!.entity).toBe("discount")
    expect(out.results[0]!.title).toBe("SPRING10")
    expect((out.results[0]!.attributes as Record<string, unknown>).status).toBe("ACTIVE")
  })

  it("surfaces a keywordMatchNotice when scoped by a query keyword (campaign-cleanup non-exhaustiveness)", async () => {
    // deactivate-expired-synth-summit-press-discount-codes: discounts_search is keyword/title-only with no
    // date/tag filter, so a campaign cleanup scoped by keyword cannot be exhaustive. The tool must propagate
    // that caveat (+ the leave-unrelated-codes rule) so the agent discloses it and never claims "deactivated all".
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            codeDiscountNodes: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
          },
        },
      ],
    })
    const out = await discounts_search({ query: "Synth Summit" }, ctx)
    expect(out.keywordMatchNotice).toBeDefined()
    expect(out.keywordMatchNotice).toMatch(/keyword|title/i)
    expect(out.keywordMatchNotice).toMatch(/NO created-date filter|no.*date.*filter/i)
    // The two DISTINCT disclosures must both be demanded, plus the explicit anti-inversion guidance.
    expect(out.keywordMatchNotice).toMatch(/UNDER-INCLUSION/i)
    expect(out.keywordMatchNotice).toMatch(/SILENTLY MISSED|may be INCOMPLETE|might have missed/i)
    expect(out.keywordMatchNotice).toMatch(/OVER-INCLUSION|EXCLUSION STATEMENT|LEAVING UNTOUCHED/i)
    expect(out.keywordMatchNotice).toMatch(
      /never.*'deactivated all'|WRONG framing|NOT a reassurance/i,
    )
  })

  it("omits the keywordMatchNotice when no query keyword was passed (unscoped list)", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            codeDiscountNodes: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } },
          },
        },
      ],
    })
    const out = await discounts_search({}, ctx)
    expect(out.keywordMatchNotice).toBeUndefined()
  })
})

describe("metafields_list", () => {
  it("returns normalized metafields per owner resource", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            product: {
              id: "gid://shopify/Product/1",
              metafields: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/Metafield/1",
                      namespace: "custom",
                      key: "size_chart",
                      value: '{ "s":1 }',
                      type: "json",
                    },
                  },
                ],
                pageInfo: { endCursor: "c5", hasNextPage: false },
              },
            },
          },
        },
      ],
    })
    const out = await metafields_list(
      { ownerId: "gid://shopify/Product/1", ownerType: "Product" },
      ctx,
    )
    expect(out.results[0]!.entity).toBe("metafield")
    expect((out.results[0]!.attributes as Record<string, unknown>).namespace).toBe("custom")
    expect(out.results[0]!.title).toBe("custom.size_chart")
  })

  it("throws on missing ownerId or ownerType", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(metafields_list({}, ctx)).rejects.toThrow(/owner/)
  })
})

// — §1.10 market-context coverage (criterion #10) —
//
// Every read normalizer must surface market context per row: a concrete handle
// where Shopify exposes one (tag-derived on order-family entities), or an
// explicit, documented `null` where the entity is genuinely not market-scoped.
describe("market context per read tool (§1.10 / criterion #10)", () => {
  it("resolves market from tags via the shared marketFromTags helper", () => {
    expect(ReadsTestAccess.marketFromTags(["a", "market:canada", "b"])).toBe("canada")
    expect(ReadsTestAccess.marketFromTags(["a", "b"])).toBeNull()
    expect(ReadsTestAccess.marketFromTags(undefined)).toBeNull()
  })

  it("orders/refunds/returns/fulfillments inherit market from the (parent) order tags", () => {
    const tags = ["market:us"]
    expect(ReadsTestAccess.normalizeOrder({ id: "o", name: "#1", tags }).market).toBe("us")
    expect(
      ReadsTestAccess.normalizeRefund({ id: "r", order: { id: "o", name: "#1", tags } }).market,
    ).toBe("us")
    expect(
      ReadsTestAccess.normalizeReturn({
        id: "rt",
        name: "#R",
        order: { id: "o", name: "#1", tags },
      }).market,
    ).toBe("us")
    expect(
      ReadsTestAccess.normalizeFulfillment({ id: "f", order: { id: "o", name: "#1", tags } })
        .market,
    ).toBe("us")
  })

  it("draft orders inherit market from their own tags", () => {
    expect(
      ReadsTestAccess.normalizeDraftOrder({ id: "d", name: "#D1", tags: ["market:eu"] }).market,
    ).toBe("eu")
  })

  it("genuinely non-market-scoped entities document a null market", () => {
    // Products/variants: catalog read is market-agnostic (no contextual price).
    expect(ReadsTestAccess.normalizeProduct({ id: "p", title: "X" }).market).toBeNull()
    expect(ReadsTestAccess.normalizeVariant({ id: "v" }).market).toBeNull()
    // Inventory levels: location-scoped, not market-scoped.
    expect(
      ReadsTestAccess.normalizeInventoryLevel(
        {
          id: "il",
          location: { id: "l", name: "Main" },
          quantities: [{ name: "on_hand", quantity: 1 }],
        },
        null,
      ).market,
    ).toBeNull()
    // Discounts / metafields: not market-scoped.
    expect(
      ReadsTestAccess.normalizeDiscount({ id: "dc", codeDiscount: { title: "X" } }).market,
    ).toBeNull()
    expect(
      ReadsTestAccess.normalizeMetafield({
        id: "mf",
        namespace: "custom",
        key: "k",
        value: "v",
        type: "single_line_text_field",
      }).market,
    ).toBeNull()
    // Locations: physical sites, not market-scoped.
    expect(ReadsTestAccess.normalizeLocation({ id: "loc", name: "Main" }).market).toBeNull()
  })
})

// — §3.2 added read tools: draft orders, locations, customers-by-external-id —

describe("draft_orders_list", () => {
  it("returns normalized draft orders with market from tags + nextCursor", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/DraftOrder/1",
                    name: "#D1",
                    status: "OPEN",
                    tags: ["market:eu"],
                    createdAt: "2026-05-01T00:00:00Z",
                    totalPriceSet: { presentmentMoney: { amount: "50", currencyCode: "EUR" } },
                    customer: { id: "gid://shopify/Customer/1", email: "x@example.com" },
                  },
                },
              ],
              pageInfo: { endCursor: "dc1", hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await draft_orders_list({}, ctx)
    expect(out.results[0]!.entity).toBe("draft_order")
    expect(out.results[0]!.market).toBe("eu")
    expect(out.results[0]!.currency).toBe("EUR")
    expect(out.nextCursor).toBe("dc1")
  })
})

describe("draft_orders_get", () => {
  it("returns a single draft order with lineItems[]", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/2",
              name: "#D2",
              status: "OPEN",
              tags: [],
              lineItems: { edges: [{ node: { id: "li1", title: "Widget", quantity: 1 } }] },
            },
          },
        },
      ],
    })
    const out = await draft_orders_get({ id: "gid://shopify/DraftOrder/2" }, ctx)
    expect(out.entity).toBe("draft_order")
    expect(Array.isArray(out.lineItems)).toBe(true)
    expect(out.market).toBeNull()
  })

  it("names the connected shop when install_metadata is missing (lost connect event), as the client does", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrder: { id: "gid://shopify/DraftOrder/3", name: "#D3", status: "OPEN", tags: [] },
          },
        },
      ],
      shopDomain: null,
    })
    const out = await draft_orders_get({ id: "gid://shopify/DraftOrder/3" }, ctx)
    expect(out.draftOrder.shopDomain).toBe("demo.myshopify.com")
  })

  it("throws NOT_FOUND when draft order is null", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { draftOrder: null } }] })
    await expect(draft_orders_get({ id: "gid://shopify/DraftOrder/0" }, ctx)).rejects.toThrow(
      /not found/,
    )
  })

  it("nested draftOrder.poNumber (the shape invoicing's draft-order sync actually reads via shopify:draft_orders_get -> result.draftOrder) is camelCase and always present", async () => {
    // Consumer: bundled-apps/invoicing/src/handlers/shopify-draft-order.ts's fetchDraftOrder()
    // reads `envelope.result.draftOrder` and casts it straight to its own NormalizedDraftOrder
    // type (camelCase throughout) -- it never looks at this tool result's top-level po_number.
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/60",
              name: "#D60",
              status: "OPEN",
              tags: [],
              poNumber: "PO-DRAFT-60",
              lineItems: { edges: [] },
            },
          },
        },
      ],
    })
    const out = await draft_orders_get({ id: "gid://shopify/DraftOrder/60" }, ctx)
    expect(out.draftOrder.poNumber).toBe("PO-DRAFT-60")
    expect("po_number" in out.draftOrder).toBe(false)

    const { ctx: ctx2 } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/61",
              name: "#D61",
              status: "OPEN",
              tags: [],
              poNumber: null,
              lineItems: { edges: [] },
            },
          },
        },
      ],
    })
    const out2 = await draft_orders_get({ id: "gid://shopify/DraftOrder/61" }, ctx2)
    expect(out2.draftOrder.poNumber).toBeNull()
  })

  it("order-then-draft PO fallback: resolves the draft's own poNumber when the completed order's field is empty", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/50",
              name: "#D50",
              status: "COMPLETED",
              tags: [],
              poNumber: "PO-DRAFT-50",
              order: { id: "gid://shopify/Order/50", name: "#1050", poNumber: null },
              lineItems: { edges: [] },
            },
          },
        },
      ],
    })
    const out = await draft_orders_get({ id: "gid://shopify/DraftOrder/50" }, ctx)
    expect((out as unknown as { po_number?: string }).po_number).toBe("PO-DRAFT-50")
  })

  it("order-then-draft PO fallback: the completed order's own poNumber wins when present", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/51",
              name: "#D51",
              status: "COMPLETED",
              tags: [],
              poNumber: "PO-DRAFT-51",
              order: { id: "gid://shopify/Order/51", name: "#1051", poNumber: "PO-ORDER-51" },
              lineItems: { edges: [] },
            },
          },
        },
      ],
    })
    const out = await draft_orders_get({ id: "gid://shopify/DraftOrder/51" }, ctx)
    expect((out as unknown as { po_number?: string }).po_number).toBe("PO-ORDER-51")
  })

  it("throws on missing id", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(draft_orders_get({}, ctx)).rejects.toThrow(/id is required/)
  })
})

describe("locations_list", () => {
  it("returns normalized locations with null market", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [
        {
          data: {
            locations: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/Location/1",
                    name: "Main Warehouse",
                    isActive: true,
                    address: { country: "United States", countryCode: "US", city: "NYC" },
                  },
                },
              ],
              pageInfo: { endCursor: "lc1", hasNextPage: false },
            },
          },
        },
      ],
    })
    const out = await locations_list({}, ctx)
    expect(out.results[0]!.entity).toBe("location")
    expect(out.results[0]!.title).toBe("Main Warehouse")
    expect(out.results[0]!.market).toBeNull()
    expect(out.nextCursor).toBe("lc1")
  })
})

describe("customers_get_by_external_id", () => {
  it("normalizes a bare numeric external id into a Customer GID and resolves it", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            customer: {
              id: "gid://shopify/Customer/55",
              email: "ext@example.com",
              firstName: "Ext",
              lastName: "Id",
              tags: ["market:ca"],
              numberOfOrders: "2",
              amountSpent: { amount: "20", currencyCode: "CAD" },
            },
          },
        },
      ],
    })
    const out = await customers_get_by_external_id({ externalId: "55" }, ctx)
    expect(out.entity).toBe("customer")
    expect(out.market).toBe("ca")
    const body = JSON.parse(calls[0]!.body) as { variables?: { id?: string } }
    expect(body.variables?.id).toBe("gid://shopify/Customer/55")
  })

  it("passes a full GID through unchanged", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [{ data: { customer: { id: "gid://shopify/Customer/9", tags: [] } } }],
    })
    await customers_get_by_external_id({ externalId: "gid://shopify/Customer/9" }, ctx)
    const body = JSON.parse(calls[0]!.body) as { variables?: { id?: string } }
    expect(body.variables?.id).toBe("gid://shopify/Customer/9")
  })

  it("throws on missing externalId", async () => {
    const { ctx } = makeCtx({ fetchResponses: [] })
    await expect(customers_get_by_external_id({}, ctx)).rejects.toThrow(/externalId is required/)
  })

  it("throws NOT_FOUND when no customer matches", async () => {
    const { ctx } = makeCtx({ fetchResponses: [{ data: { customer: null } }] })
    await expect(customers_get_by_external_id({ externalId: "0" }, ctx)).rejects.toThrow(
      /not found/,
    )
  })
})

describe("home_load recentOrders line-item SKU summary", () => {
  // Regression: the Home order list must carry each order's line-item SKUs so a cross-app
  // standup ("list the unshipped weekend orders BY SKU", morning-cross-app-triage-standup) can
  // be answered from the single home_load call — without an orders_get drill-down per order.
  // home_load fires 4 GraphQL probes via Promise.all in array order (recentOrders first), and the
  // makeCtx fetch stub serves fetchResponses FIFO, so recentOrders consumes the first response.
  it("returns lineItems[] (sku/title/quantity) per recent order", async () => {
    const recentOrders = {
      data: {
        orders: {
          edges: [
            {
              node: {
                id: "gid://shopify/Order/1",
                name: "#1062",
                createdAt: "2026-06-14T10:00:00Z",
                displayFulfillmentStatus: "UNFULFILLED",
                currentTotalPriceSet: {
                  presentmentMoney: { amount: "789.00", currencyCode: "EUR" },
                },
                customer: { displayName: "Lukas Becker", email: "lukas.becker@example.com" },
                lineItems: {
                  edges: [
                    { node: { title: "Modular Bundle", quantity: 1, sku: "RAL-MOD" } },
                    { node: { title: "Windscreen Pack", quantity: 2, sku: "RAL-WND" } },
                  ],
                },
              },
            },
          ],
        },
      },
    }
    const empty = { data: {} }
    const { ctx } = makeCtx({ fetchResponses: [recentOrders, empty, empty, empty] })
    const out = (await home_load({}, ctx)) as {
      recentOrders: {
        orders: Array<{
          name: string
          lineItems: Array<{ sku: string | null; title: string | null; quantity: number }>
        }>
      }
    }
    expect(out.recentOrders.orders).toHaveLength(1)
    expect(out.recentOrders.orders[0]!.lineItems).toEqual([
      { sku: "RAL-MOD", title: "Modular Bundle", quantity: 1 },
      { sku: "RAL-WND", title: "Windscreen Pack", quantity: 2 },
    ])
  })
})

describe("home_load attention.lowInventory de-noise", () => {
  // Regression (morning-cross-app-triage-standup, axis-b de-noise): the low-stock attention list must
  // surface only CATALOGUED, trackable products — not a store's seeded demo/sample products (gift
  // cards, the Shopify demo snowboards, un-SKU'd placeholder controllers). The store-agnostic signal is
  // SKU presence: a real catalogued variant carries a SKU; the dev-store sample products do not. Before
  // this fix the list was dominated by gift-card/snowboard/placeholder noise, which both buried the real
  // low-stock items AND tempted the agent to read the inventory dashboard as the org's order data.
  // home_load fires 4 probes in array order (recentOrders, unfulfilled, lowInventory, pendingReturns);
  // makeCtx serves fetchResponses FIFO, so lowInventory is the 3rd response.
  it("drops un-SKU'd demo/placeholder variants and keeps only catalogued (SKU-bearing) low-stock rows", async () => {
    const empty = { data: {} }
    const lowInventory = {
      data: {
        productVariants: {
          edges: [
            // demo/sample noise — no SKU → dropped
            {
              node: {
                id: "gid://shopify/ProductVariant/1",
                sku: null,
                title: null,
                inventoryQuantity: 0,
                product: { id: "p1", title: "Gift Card", productType: "giftcard" },
              },
            },
            {
              node: {
                id: "gid://shopify/ProductVariant/2",
                sku: null,
                title: null,
                inventoryQuantity: -6,
                product: { id: "p2", title: "Kestrel Pocket Recorder", productType: "" },
              },
            },
            {
              node: {
                id: "gid://shopify/ProductVariant/3",
                sku: "  ",
                title: null,
                inventoryQuantity: -6,
                product: { id: "p3", title: "Foam Windscreen", productType: "" },
              },
            },
            // real catalogued low-stock — has SKU → kept
            {
              node: {
                id: "gid://shopify/ProductVariant/4",
                sku: "RAL-CASE",
                title: "Default",
                inventoryQuantity: 4,
                product: { id: "p4", title: "Travel Case", productType: "" },
              },
            },
            {
              node: {
                id: "gid://shopify/ProductVariant/5",
                sku: "RAL-TC",
                title: "Default",
                inventoryQuantity: 9,
                product: { id: "p5", title: "Timecode Module", productType: "" },
              },
            },
          ],
        },
      },
    }
    const { ctx, calls } = makeCtx({ fetchResponses: [empty, empty, lowInventory, empty] })
    const out = (await home_load({}, ctx)) as {
      attention: { lowInventory: Array<{ sku: string | null; productTitle: string }> }
    }
    expect(out.attention.lowInventory.map((r) => r.sku)).toEqual(["RAL-CASE", "RAL-TC"])
    expect(out.attention.lowInventory.map((r) => r.productTitle)).toEqual([
      "Travel Case",
      "Timecode Module",
    ])
    // The low-inventory query also drops gift cards at the query layer (they have no physical stock).
    const lowInvCall = calls.find((c) => c.body.includes("LowInventory"))
    expect(lowInvCall).toBeDefined()
    const sentQuery = JSON.parse(lowInvCall!.body) as { query: string }
    expect(sentQuery.query).toContain("product_type:-giftcard")
  })
})

describe("orders_get / fulfillments_get carry the B2B verdict the fulfilment card reads", () => {
  const order = (extra: Record<string, unknown>) => ({
    data: {
      order: { id: "gid://shopify/Order/3001", name: "#3001", lineItems: { edges: [] }, ...extra },
    },
  })
  const skuLines = {
    lineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/LineItem/1",
            title: "Kestrel",
            quantity: 1,
            sku: "KS6-44-B2B",
            variant: { sku: "KS6-44-B2B" },
          },
        },
      ],
    },
  }

  it("a company buyer is B2B", async () => {
    const { ctx } = makeCtx({
      fetchResponses: [order({ purchasingEntity: { company: { name: "Example Trading Ltd" } } })],
    })
    const out = (await orders_get({ id: "gid://shopify/Order/3001" }, ctx)) as unknown as Record<
      string,
      unknown
    >
    expect(out.b2bOrder).toEqual({ b2b: true, reason: "b2b_company_buyer" })
  })

  it("a line sku with a configured suffix is B2B; without the setting it is retail", async () => {
    const marked = makeCtx({
      fetchResponses: [order(skuLines)],
      config: { b2bSkuSuffixes: "-b2b" },
    })
    const a = (await orders_get(
      { id: "gid://shopify/Order/3001" },
      marked.ctx,
    )) as unknown as Record<string, unknown>
    expect(a.b2bOrder).toEqual({ b2b: true, reason: "b2b_sku_suffix" })
    const plain = makeCtx({ fetchResponses: [order(skuLines)], config: {} })
    const b = (await orders_get(
      { id: "gid://shopify/Order/3001" },
      plain.ctx,
    )) as unknown as Record<string, unknown>
    expect(b.b2bOrder).toEqual({ b2b: false, reason: null })
  })

  it("reads the ORDER LINE's sku, as the fulfilment handler does (not the variant's current sku)", async () => {
    const lines = {
      lineItems: {
        edges: [
          {
            node: {
              id: "gid://shopify/LineItem/1",
              title: "Kestrel",
              quantity: 1,
              sku: "KS6-44-B2B",
              variant: { sku: "KS6-44" },
            },
          },
        ],
      },
    }
    const { ctx, calls } = makeCtx({
      fetchResponses: [order(lines)],
      config: { b2bSkuSuffixes: "-b2b" },
    })
    const out = (await orders_get({ id: "gid://shopify/Order/3001" }, ctx)) as {
      b2bOrder?: unknown
    }
    expect(out.b2bOrder).toEqual({ b2b: true, reason: "b2b_sku_suffix" })
    expect((JSON.parse(calls[0]!.body) as { query: string }).query).toMatch(
      /node \{ id title quantity sku /,
    )
  })

  it("carries the org's shipping email policy (unset reads as caller)", async () => {
    const set = makeCtx({
      fetchResponses: [order({})],
      config: { customerShippingEmail: "retail_only" },
    })
    const a = (await orders_get({ id: "gid://shopify/Order/3001" }, set.ctx)) as unknown as Record<
      string,
      unknown
    >
    expect(a.shippingEmailPolicy).toBe("retail_only")
    const unset = makeCtx({ fetchResponses: [order({})], config: {} })
    const b = (await orders_get(
      { id: "gid://shopify/Order/3001" },
      unset.ctx,
    )) as unknown as Record<string, unknown>
    expect(b.shippingEmailPolicy).toBe("caller")
  })

  it("the settings unreadable: no verdict and no policy (the card then promises nothing)", async () => {
    const { ctx } = makeCtx({ fetchResponses: [order(skuLines)] })
    const out = (await orders_get({ id: "gid://shopify/Order/3001" }, ctx)) as unknown as Record<
      string,
      unknown
    >
    expect(out.b2bOrder).toBeUndefined()
    expect(out.shippingEmailPolicy).toBeUndefined()
  })

  it("fulfillments_get reads its order's signals and carries the verdict", async () => {
    const { ctx, calls } = makeCtx({
      fetchResponses: [
        {
          data: {
            fulfillment: {
              id: "gid://shopify/Fulfillment/7",
              order: {
                id: "gid://shopify/Order/3001",
                name: "#3001",
                purchasingEntity: { company: { name: "Example Trading Ltd" } },
              },
            },
          },
        },
      ],
      config: {},
    })
    const out = await fulfillments_get({ id: "gid://shopify/Fulfillment/7" }, ctx)
    expect((out.attributes as Record<string, unknown>).b2bOrder).toEqual({
      b2b: true,
      reason: "b2b_company_buyer",
    })
    expect((out.attributes as Record<string, unknown>).shippingEmailPolicy).toBe("caller")
    expect((JSON.parse(calls[0]!.body) as { query: string }).query).toContain("PurchasingCompany")
  })
})
