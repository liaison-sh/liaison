// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import {
  google_account_info,
  google_adgroups_list,
  google_ads_list,
  google_campaigns_list,
  google_insights_query,
  google_recommendations_list,
  google_search_terms,
} from "./google-reads"
import { GoogleConfigError } from "./lib/google-config"
import { oneAccount, settingsFor } from "./test-connections.testutil"

// ─── makeCtx helper ───────────────────────────────────────────────────────────

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

interface MockResponse {
  status: number
  body: string
}

function makeCtx(fetchResponses: MockResponse[]) {
  const calls: FetchCall[] = []
  let idx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(opts?.method ?? "GET"),
      headers: (opts?.headers ?? {}) as Record<string, string>,
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = fetchResponses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  const connections = {
    google: {
      getAccounts: async () => oneAccount(),
    },
    "google-config": {
      getSettings: async () =>
        settingsFor("google-config", {
          developerToken: "dev_tok_123",
          loginCustomerId: "9998887777",
          customerId: "1234567890",
          merchantId: "mc_1",
        }),
    },
  }
  return { ctx: { fetch, connections }, calls }
}

function noConnCtx(fetchResponses: MockResponse[] = []) {
  const { calls } = makeCtx(fetchResponses)
  const fetch = async () => {
    throw new Error("should not be called — connection is absent")
  }
  return { ctx: { fetch, connections: {} }, calls }
}

function streamBody(results: unknown[]) {
  return JSON.stringify([{ results }])
}

// ─── google_campaigns_list ────────────────────────────────────────────────────

describe("google_campaigns_list", () => {
  it("returns normalized campaign rows from a GAQL campaign search", async () => {
    const { ctx, calls } = makeCtx([
      {
        status: 200,
        body: streamBody([
          {
            campaign: {
              id: "111",
              name: "Search Brand",
              status: "ENABLED",
              advertisingChannelType: "SEARCH",
            },
            campaignBudget: { amountMicros: "50000000" },
          },
        ]),
      },
    ])
    const result = (await google_campaigns_list({}, ctx)) as { campaigns: unknown[] }
    expect(result.campaigns.length).toBe(1)
    const row = result.campaigns[0] as Record<string, unknown>
    expect(row.id).toBe("111")
    expect(row.name).toBe("Search Brand")
    expect(row.status).toBe("ENABLED")
    // Budget micros converted to major units at the tool boundary.
    expect(row.budget_amount).toBe(50)
    expect(calls[0]?.url).toContain("googleAds:searchStream")
    expect(calls[0]?.body).toContain("FROM campaign")
  })

  it("throws an actionable connect-error when the google connection is absent", async () => {
    const { ctx } = noConnCtx()
    await expect(google_campaigns_list({}, ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })
})

// ─── google_adgroups_list ─────────────────────────────────────────────────────

describe("google_adgroups_list", () => {
  it("returns normalized ad group rows, optionally filtered by campaign_id", async () => {
    const { ctx, calls } = makeCtx([
      {
        status: 200,
        body: streamBody([
          { adGroup: { id: "222", name: "Group A", status: "ENABLED" }, campaign: { id: "111" } },
        ]),
      },
    ])
    const result = (await google_adgroups_list({ campaign_id: "111" }, ctx)) as {
      ad_groups: unknown[]
    }
    expect(result.ad_groups.length).toBe(1)
    expect(calls[0]?.body).toContain("FROM ad_group")
    expect(calls[0]?.body).toContain("111")
  })

  it("throws an actionable connect-error when the google connection is absent", async () => {
    const { ctx } = noConnCtx()
    await expect(google_adgroups_list({}, ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })
})

// ─── google_ads_list ───────────────────────────────────────────────────────────

describe("google_ads_list", () => {
  it("returns ad_group_ad rows with RSA asset refs + status", async () => {
    const { ctx } = makeCtx([
      {
        status: 200,
        body: streamBody([
          {
            adGroupAd: {
              ad: { id: "333", responsiveSearchAd: { headlines: [{ text: "Buy now" }] } },
              status: "ENABLED",
            },
          },
        ]),
      },
    ])
    const result = (await google_ads_list({}, ctx)) as { ads: unknown[] }
    expect(result.ads.length).toBe(1)
    const row = result.ads[0] as Record<string, unknown>
    expect(row.id).toBe("333")
    expect(row.status).toBe("ENABLED")
  })

  it("AND-joins both filters when ad_group_id AND campaign_id are both provided", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: streamBody([]) }])
    await google_ads_list({ ad_group_id: "222", campaign_id: "111" }, ctx)
    const body = calls[0]?.body ?? ""
    expect(body).toContain("WHERE ad_group.id = 222 AND campaign.id = 111")
  })

  it("throws an actionable connect-error when the google connection is absent", async () => {
    const { ctx } = noConnCtx()
    await expect(google_ads_list({}, ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })
})

// ─── google_insights_query ────────────────────────────────────────────────────

describe("google_insights_query", () => {
  it("passes the caller's GAQL through, converts micros, attaches account currency", async () => {
    const { ctx, calls } = makeCtx([
      {
        status: 200,
        body: streamBody([
          {
            campaign: { id: "111" },
            metrics: { costMicros: "2500000", clicks: "10", impressions: "1000" },
            segments: { date: "2026-07-01" },
          },
        ]),
      },
    ])
    const result = (await google_insights_query(
      { query: "SELECT campaign.id, metrics.cost_micros FROM campaign", currency: "EUR" },
      ctx,
    )) as { rows: unknown[]; currency: string }
    expect(calls[0]?.body).toContain("SELECT campaign.id")
    const row = result.rows[0] as Record<string, unknown>
    expect(row.cost).toBe(2.5)
    expect(result.currency).toBe("EUR")
  })

  it("rejects a non-SELECT query defensively (read-only allowlist)", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_insights_query({ query: "UPDATE campaign SET status = 'REMOVED'" }, ctx),
    ).rejects.toThrow(/read-only|not allowed|SELECT/i)
  })

  it("rejects a SELECT against a resource not on the read allowlist", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_insights_query({ query: "SELECT keyword_view.id FROM keyword_view" }, ctx),
    ).rejects.toThrow(/not in the read allowlist/i)
  })

  it("accepts a valid GAQL query laden with /* block */ and -- line comments (never over-rejects real reads)", async () => {
    const { ctx, calls } = makeCtx([
      {
        status: 200,
        body: streamBody([{ campaign: { id: "111" }, metrics: { costMicros: "1000000" } }]),
      },
    ])
    const commented =
      "/* fetch spend */ SELECT campaign.id, -- trailing comment on this line\n" +
      "metrics.cost_micros FROM campaign -- read-only\n"
    const result = (await google_insights_query({ query: commented }, ctx)) as { rows: unknown[] }
    expect(result.rows.length).toBe(1)
    expect(calls[0]?.body).toContain("campaign.id")
  })

  it("accepts a FROM resource surrounded by extra whitespace/newlines (tolerant token matching)", async () => {
    const { ctx } = makeCtx([{ status: 200, body: streamBody([{ campaign: { id: "111" } }]) }])
    const spaced = "SELECT campaign.id\nFROM    campaign\n"
    const result = (await google_insights_query({ query: spaced }, ctx)) as { rows: unknown[] }
    expect(result.rows.length).toBe(1)
  })

  it("returns a structured google_not_connected error envelope when the google connection is absent", async () => {
    // Not a throw: the kernel redacts sandboxed handler throws in production
    // ("Tool execution failed"), so the actionable not-connected state is
    // returned as data — callers (metrics, agents) branch on the code.
    const { ctx } = noConnCtx()
    const result = (await google_insights_query(
      { query: "SELECT campaign.id FROM campaign" },
      ctx,
    )) as {
      error?: { code: string; message: string }
    }
    expect(result.error?.code).toBe("google_not_connected")
    expect(result.error?.message).toMatch(/not connected/i)
  })
})

// ─── google_account_info ──────────────────────────────────────────────────────

describe("google_account_info", () => {
  it("returns BOTH the customer currency/tz AND the conversion actions list", async () => {
    const { ctx } = makeCtx([
      {
        status: 200,
        body: streamBody([
          { customer: { id: "1234567890", currencyCode: "EUR", timeZone: "Europe/Paris" } },
        ]),
      },
      {
        status: 200,
        body: streamBody([
          {
            conversionAction: { id: "1", name: "Purchase", type: "WEBPAGE", status: "ENABLED" },
          },
        ]),
      },
    ])
    const result = (await google_account_info({}, ctx)) as {
      currency: string
      time_zone: string
      conversion_actions: unknown[]
    }
    expect(result.currency).toBe("EUR")
    expect(result.time_zone).toBe("Europe/Paris")
    expect(result.conversion_actions.length).toBe(1)
    const ca = result.conversion_actions[0] as Record<string, unknown>
    expect(ca.name).toBe("Purchase")
  })

  it("returns a structured google_not_connected envelope when the google-config connection is absent", async () => {
    const { ctx } = noConnCtx()
    const result = (await google_account_info({}, ctx)) as { error?: { code: string } }
    expect(result.error?.code).toBe("google_not_connected")
  })
})

// ─── google_search_terms ──────────────────────────────────────────────────────

describe("google_search_terms", () => {
  it("returns search_term_view rows (search term + metrics)", async () => {
    const { ctx } = makeCtx([
      {
        status: 200,
        body: streamBody([
          {
            searchTermView: { searchTerm: "buy widgets online" },
            metrics: { clicks: "5", costMicros: "1000000", conversions: "1" },
          },
        ]),
      },
    ])
    const result = (await google_search_terms({}, ctx)) as { search_terms: unknown[] }
    expect(result.search_terms.length).toBe(1)
    const row = result.search_terms[0] as Record<string, unknown>
    expect(row.search_term).toBe("buy widgets online")
    expect(row.cost).toBe(1)
  })

  it("throws an actionable connect-error when the google connection is absent", async () => {
    const { ctx } = noConnCtx()
    await expect(google_search_terms({}, ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })
})

// ─── google_recommendations_list ──────────────────────────────────────────────

describe("google_recommendations_list", () => {
  it("returns recommendation rows (type, campaign, dismissed)", async () => {
    const { ctx } = makeCtx([
      {
        status: 200,
        body: streamBody([
          {
            recommendation: {
              resourceName: "customers/1234567890/recommendations/999",
              type: "KEYWORD",
              campaign: "customers/1234567890/campaigns/111",
              dismissed: false,
            },
          },
        ]),
      },
    ])
    const result = (await google_recommendations_list({}, ctx)) as { recommendations: unknown[] }
    expect(result.recommendations.length).toBe(1)
    const row = result.recommendations[0] as Record<string, unknown>
    expect(row.type).toBe("KEYWORD")
    expect(row.dismissed).toBe(false)
  })

  it("throws an actionable connect-error when the google connection is absent", async () => {
    const { ctx } = noConnCtx()
    await expect(google_recommendations_list({}, ctx)).rejects.toBeInstanceOf(GoogleConfigError)
  })
})
