// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  gatherShopifyNetRevenue,
  gatherManualSpendTotal,
  gatherPlatformSpend,
  gatherAttributionRows,
  gatherAllInputs,
} from "./inputs"
import { createMockDb } from "../test-db"

interface Envelope {
  status: "completed" | "pending_approval" | "error"
  result?: unknown
  error?: { code: string; message: string }
}

const PERIOD = { start: "2026-07-01", end: "2026-07-31" }

function makeExecuteTool(responses: Record<string, Envelope>) {
  return async (target: string): Promise<Envelope> => {
    return responses[target] ?? { status: "error", error: { code: "not_mocked", message: `no mock for ${target}` } }
  }
}

// Real result envelopes (pinned to the actual tool contracts — the earlier
// bare-array/total_price fixtures never matched the live tools and hid a
// silent-zero integration bug found on staging):
//   shopify:orders_search  -> { results: [{ currency, attributes: { totalAmount } }], nextCursor, totalCount }
//   ads:insights_query     -> { data: [{ spend }], ... }
//   ads:google_insights_query -> { rows: [{ cost }], count, currency }
//   database:db_read/db_query -> { rows: [...], truncated } or { error: { code, message } }
function ordersPage(
  hits: Array<{ total: string; currency?: string; shopTotal?: string; shopCurrency?: string }>,
  nextCursor: string | null = null,
  totalCount?: number,
) {
  return {
    results: hits.map((h) => ({
      currency: h.currency ?? "EUR",
      attributes: {
        totalAmount: h.total,
        ...(h.shopTotal !== undefined ? { totalAmountShop: h.shopTotal, shopCurrency: h.shopCurrency ?? "EUR" } : {}),
      },
    })),
    nextCursor,
    totalCount: totalCount ?? hits.length,
  }
}

describe("gatherShopifyNetRevenue", () => {
  it("sums refund-adjusted current totals with source lineage, passing the REAL date-window params", async () => {
    const seenArgs: Record<string, unknown>[] = []
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      if (target !== "shopify:orders_search") {
        return { status: "error", error: { code: "not_mocked", message: `no mock for ${target}` } }
      }
      seenArgs.push(args)
      // Mirror the real tool's validator: a date term must arrive via
      // created_at_min/max — reject the query-string form that the old
      // (broken) implementation used.
      if (typeof args.query === "string" && /created_at/.test(args.query)) {
        return { status: "error", error: { code: "invalid_params", message: "date terms in query are ignored" } }
      }
      if (!args.created_at_min || !args.created_at_max) {
        return { status: "error", error: { code: "invalid_params", message: "missing created_at_min/created_at_max" } }
      }
      return { status: "completed", result: ordersPage([{ total: "1000" }, { total: "300" }]) }
    }
    const result = await gatherShopifyNetRevenue({ executeTool }, PERIOD)
    expect(result.value).toBe(1300)
    expect(result.lineage.source).toContain("shopify")
    expect(result.lineage.calls.length).toBeGreaterThan(0)
    expect(seenArgs[0]?.created_at_min).toBe(PERIOD.start)
    expect(seenArgs[0]?.created_at_max).toBe(PERIOD.end)
  })

  it("cursor-paginates until nextCursor is exhausted and sums every page", async () => {
    let call = 0
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      expect(target).toBe("shopify:orders_search")
      call++
      if (call === 1) {
        expect(args.cursor).toBeUndefined()
        return { status: "completed", result: ordersPage([{ total: "100" }], "cur-2", 3) }
      }
      expect(args.cursor).toBe("cur-2")
      return { status: "completed", result: ordersPage([{ total: "20" }, { total: "3" }], null, 3) }
    }
    const result = await gatherShopifyNetRevenue({ executeTool }, PERIOD)
    expect(call).toBe(2)
    expect(result.value).toBe(123)
    expect(result.lineage.stale).toBeUndefined()
  })

  it("degrades to unavailable (not a throw) when orders_search fails", async () => {
    const executeTool = makeExecuteTool({
      "shopify:orders_search": { status: "error", error: { code: "connect_error", message: "not connected" } },
    })
    const result = await gatherShopifyNetRevenue({ executeTool }, PERIOD)
    expect(result.value).toBeNull()
    expect(result.lineage.unavailable).toBe(true)
  })

  it("sums store-currency (shopMoney) totals when presentment currencies differ across buyers", async () => {
    const executeTool = makeExecuteTool({
      "shopify:orders_search": {
        status: "completed",
        result: ordersPage([
          { total: "1080", currency: "USD", shopTotal: "1000", shopCurrency: "EUR" },
          { total: "430", currency: "GBP", shopTotal: "500", shopCurrency: "EUR" },
        ]),
      },
    })
    const result = await gatherShopifyNetRevenue({ executeTool }, PERIOD)
    expect(result.value).toBe(1500)
    expect(result.lineage.unavailable).toBeUndefined()
  })

  it("degrades to unavailable (value:null) on a currency mismatch across rows -- never a confidently-quoted MIXED sum", async () => {
    const executeTool = makeExecuteTool({
      "shopify:orders_search": {
        status: "completed",
        result: ordersPage([
          { total: "1000", currency: "EUR" },
          { total: "500", currency: "USD" },
        ]),
      },
    })
    const result = await gatherShopifyNetRevenue({ executeTool }, PERIOD)
    expect(result.value).toBeNull()
    expect(result.lineage.unavailable).toBe(true)
    expect(result.lineage.note).toMatch(/currency/i)
  })

  it("returns unavailable with no cross-app enabled", async () => {
    const result = await gatherShopifyNetRevenue({}, PERIOD)
    expect(result.value).toBeNull()
    expect(result.lineage.unavailable).toBe(true)
  })
})

describe("gatherManualSpendTotal", () => {
  it("sums manual_spend rows overlapping the period", async () => {
    const db = createMockDb({
      seed: {
        manual_spend: [
          { id: "1", channel: "dealer-co-op", period_start: "2026-07-05", period_end: "2026-07-10", amount: 300, currency: "EUR" },
          { id: "2", channel: "print", period_start: "2026-06-01", period_end: "2026-06-30", amount: 999, currency: "EUR" },
        ],
      },
    })
    const result = await gatherManualSpendTotal({ db }, PERIOD)
    expect(result.value).toBe(300)
  })

  it("returns 0 with an unseeded note when the ledger is empty (§5.6 fallback)", async () => {
    const db = createMockDb()
    const result = await gatherManualSpendTotal({ db }, PERIOD)
    expect(result.value).toBe(0)
    expect(result.lineage.note).toMatch(/unseeded/)
  })
})

describe("gatherPlatformSpend", () => {
  it("gathers Meta + Google spend independently — one missing does not block the other", async () => {
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      if (target === "ads:insights_query") {
        // The real tool REQUIRES level and takes time_range {since, until}.
        if (args.level !== "account") {
          return { status: "error", error: { code: "invalid_params", message: "level is required" } }
        }
        const tr = args.time_range as { since?: string; until?: string } | undefined
        if (tr?.since !== PERIOD.start || tr?.until !== PERIOD.end) {
          return { status: "error", error: { code: "invalid_params", message: "bad time_range" } }
        }
        // Real envelope: { data: rows, _split, currency }.
        return { status: "completed", result: { data: [{ spend: 100 }], _split: false, currency: "EUR" } }
      }
      return { status: "error", error: { code: "upstream_500", message: "Google Ads API 500" } }
    }
    const { meta, google } = await gatherPlatformSpend({ executeTool }, PERIOD)
    expect(meta.value).toBe(100)
    expect(google.value).toBeNull()
    expect(google.lineage.unavailable).toBe(true)
  })

  it("counts a NOT-CONNECTED Google arm as 0 spend by absence (structured error envelope), not unavailable", async () => {
    const executeTool = makeExecuteTool({
      "ads:insights_query": { status: "completed", result: { data: [{ spend: 100 }] } },
      // google_insights_query RETURNS the not-connected state as a result
      // envelope (throws are kernel-redacted for sandboxed handlers).
      "ads:google_insights_query": {
        status: "completed",
        result: { error: { code: "google_not_connected", message: "Google not connected: connect the Google account (adwords + content scopes) in app settings" } },
      },
    })
    const { google } = await gatherPlatformSpend({ executeTool }, PERIOD)
    expect(google.value).toBe(0)
    expect(google.lineage.unavailable).toBeUndefined()
    expect(google.lineage.note).toMatch(/absence/)
  })

  it("treats an unknown structured error envelope from Google as unavailable", async () => {
    const executeTool = makeExecuteTool({
      "ads:insights_query": { status: "completed", result: { data: [{ spend: 100 }] } },
      "ads:google_insights_query": { status: "completed", result: { error: { code: "quota_exceeded", message: "daily quota" } } },
    })
    const { google } = await gatherPlatformSpend({ executeTool }, PERIOD)
    expect(google.value).toBeNull()
    expect(google.lineage.unavailable).toBe(true)
    expect(google.lineage.note).toMatch(/quota/)
  })

  it("keeps a CONNECTED-but-failing Google read unavailable (unknown spend must degrade, not zero)", async () => {
    const executeTool = makeExecuteTool({
      "ads:insights_query": { status: "completed", result: { data: [{ spend: 100 }] } },
      "ads:google_insights_query": { status: "error", error: { code: "upstream_500", message: "Google Ads API 500" } },
    })
    const { google } = await gatherPlatformSpend({ executeTool }, PERIOD)
    expect(google.value).toBeNull()
    expect(google.lineage.unavailable).toBe(true)
  })

  it("coerces string bigint conversion_value_minor from the DB transport to a number", async () => {
    const executeTool = makeExecuteTool({
      "database:db_read": {
        status: "completed",
        result: { rows: [{ shopify_order_id: "1", conversion_value_minor: "900", conversion_currency: "EUR", ad_consent: "granted", created_at: "2026-07-07" }], truncated: false },
      },
    })
    const result = await gatherAttributionRows({ executeTool }, PERIOD)
    expect(result.value[0]?.conversion_value_minor).toBe(900)
  })

  it("reads Google spend from the { rows } envelope with the flattened cost field", async () => {
    const executeTool = makeExecuteTool({
      "ads:insights_query": { status: "completed", result: { data: [{ spend: 10 }] } },
      "ads:google_insights_query": { status: "completed", result: { rows: [{ cost: 42.5 }, { cost: 7.5 }], count: 2, currency: "EUR" } },
    })
    const { meta, google } = await gatherPlatformSpend({ executeTool }, PERIOD)
    expect(meta.value).toBe(10)
    expect(google.value).toBe(50)
  })
})

describe("gatherAttributionRows", () => {
  it("prefers the curated database:db_read (real { rows } envelope), widening a date-only period_end to end-of-day", async () => {
    const seen: Record<string, unknown>[] = []
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      if (target !== "database:db_read") {
        return { status: "error", error: { code: "not_mocked", message: `no mock for ${target}` } }
      }
      seen.push(args)
      return {
        status: "completed",
        result: {
          rows: [{ shopify_order_id: "1", conversion_value_minor: 100, conversion_currency: "EUR", ad_consent: "granted", created_at: "2026-07-01" }],
          truncated: false,
        },
      }
    }
    const result = await gatherAttributionRows({ executeTool }, PERIOD)
    expect(result.value.length).toBe(1)
    expect(result.lineage.source).toContain("db_read")
    const params = seen[0]?.params as { period_end?: string }
    expect(params?.period_end).toBe(`${PERIOD.end}T23:59:59.999Z`)
  })

  it("treats a db_read { error } envelope as unavailable and falls back to db_query", async () => {
    const executeTool = makeExecuteTool({
      "database:db_read": { status: "completed", result: { error: { code: "read_not_found", message: "no such read" } } },
      "database:db_query": {
        status: "completed",
        result: { rows: [{ shopify_order_id: "2", conversion_value_minor: 200, conversion_currency: "EUR", ad_consent: "granted", created_at: "2026-07-02" }], truncated: false },
      },
    })
    const result = await gatherAttributionRows({ executeTool }, PERIOD)
    expect(result.value.length).toBe(1)
    expect(result.lineage.source).toContain("db_query")
    expect(result.lineage.note).toMatch(/fallback/i)
  })

  it("falls back to database:db_query when the curated read tool call fails", async () => {
    const seen: Record<string, unknown>[] = []
    const executeTool = async (target: string, args: Record<string, unknown>): Promise<Envelope> => {
      if (target === "database:db_read") {
        return { status: "error", error: { code: "not_found", message: "no such read" } }
      }
      seen.push(args)
      return {
        status: "completed",
        result: { rows: [{ shopify_order_id: "2", conversion_value_minor: 200, conversion_currency: "EUR", ad_consent: "granted", created_at: "2026-07-02" }], truncated: false },
      }
    }
    const result = await gatherAttributionRows({ executeTool }, PERIOD)
    expect(result.value.length).toBe(1)
    expect(result.lineage.source).toContain("db_query")
    // db_query takes ONLY a literal sql string — the period is inlined, never
    // a params array the tool would reject/ignore.
    expect(typeof seen[0]?.sql).toBe("string")
    expect(seen[0]?.params).toBeUndefined()
    expect(String(seen[0]?.sql)).toContain(PERIOD.start)
  })

  it("skips the db_query fallback when period bounds are not plain dates (no SQL smuggling)", async () => {
    const executeTool = makeExecuteTool({
      "database:db_read": { status: "error", error: { code: "connect_error", message: "not connected" } },
      "database:db_query": { status: "completed", result: { rows: [{ shopify_order_id: "x" }], truncated: false } },
    })
    const result = await gatherAttributionRows(
      { executeTool },
      { start: "2026-07-01'; DROP TABLE x; --", end: "2026-07-31" },
    )
    expect(result.value).toEqual([])
    expect(result.lineage.unavailable).toBe(true)
  })

  it("degrades to unavailable (never a crash) when both the curated read and db_query fail", async () => {
    const executeTool = makeExecuteTool({
      "database:db_read": { status: "error", error: { code: "connect_error", message: "database app not connected" } },
      "database:db_query": { status: "error", error: { code: "connect_error", message: "database app not connected" } },
    })
    const result = await gatherAttributionRows({ executeTool }, PERIOD)
    expect(result.value).toEqual([])
    expect(result.lineage.unavailable).toBe(true)
  })
})

describe("gatherAllInputs", () => {
  it("gathers every source in one call — a thin-P3-data scenario degrades with stale/unavailable flags, no throw", async () => {
    const db = createMockDb()
    const executeTool = makeExecuteTool({
      "shopify:orders_search": { status: "completed", result: ordersPage([]) },
      "ads:insights_query": { status: "completed", result: { data: [] } },
      "ads:google_insights_query": { status: "completed", result: { rows: [], count: 0 } },
      "database:db_read": { status: "error", error: { code: "connect_error", message: "not connected" } },
      "database:db_query": { status: "error", error: { code: "connect_error", message: "not connected" } },
    })
    const result = await gatherAllInputs({ db, executeTool }, PERIOD)
    expect(result.attribution.value).toEqual([])
    expect(result.attribution.lineage.unavailable).toBe(true)
    // Shopify/manual/platform still compute even though hub-DB is thin.
    expect(result.shopifyNetRevenue.value).toBe(0)
    expect(result.manualSpendTotal.value).toBe(0)
  })
})

describe("gatherAllInputs: nested tool fan-out stays within the kernel breadth", () => {
  it("never has more than 2 cross-app calls in flight for one execution, and still gathers every source", async () => {
    // The kernel refuses a third concurrent nested call from one parent
    // execution. Model that: count in-flight calls, refuse (as the pool does)
    // when a third arrives, and hold each call open for a few ticks so the
    // parallel gathers genuinely overlap.
    const db = createMockDb()
    let inflight = 0
    let peak = 0
    const refused: string[] = []
    const responses: Record<string, Envelope> = {
      "shopify:orders_search": { status: "completed", result: ordersPage([{ total: "100.00" }]) },
      "ads:insights_query": { status: "completed", result: { data: [{ spend: 10 }] } },
      "ads:google_insights_query": { status: "completed", result: { rows: [{ cost: 5 }], count: 1 } },
      "database:db_read": { status: "completed", result: { rows: [], truncated: false } },
      "database:db_query": { status: "completed", result: { rows: [], truncated: false } },
    }
    const executeTool = async (target: string): Promise<Envelope> => {
      if (inflight >= 2) {
        refused.push(target)
        throw new Error("Sandbox reentrancy limit reached: nested tool call refused")
      }
      inflight++
      peak = Math.max(peak, inflight)
      try {
        for (let i = 0; i < 5; i++) await Promise.resolve()
        return responses[target] ?? { status: "error", error: { code: "not_mocked", message: target } }
      } finally {
        inflight--
      }
    }
    const result = await gatherAllInputs({ db, executeTool }, PERIOD)
    expect(refused).toEqual([])
    expect(peak).toBeLessThanOrEqual(2)
    expect(result.shopifyNetRevenue.value).toBe(100)
    expect(result.metaSpend.value).toBe(10)
    expect(result.googleSpend.value).toBe(5)
  })
})
