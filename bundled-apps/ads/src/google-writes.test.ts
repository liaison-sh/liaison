// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  google_add_negative_keywords,
  google_create_ad,
  google_create_adgroup,
  google_create_campaign,
  google_create_conversion_action,
  google_set_status,
  google_update_budget,
} from "./google-writes"
import { GoogleConfigError } from "./lib/google-config"

interface FetchCall {
  url: string
  method: string
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
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = fetchResponses[idx++]
    if (!resp) throw new Error(`No mock response for call ${idx} to ${url}`)
    return { status: resp.status, headers: {}, body: resp.body }
  }
  const connections = {
    google: { getToken: async () => "oauth_tok_abc" },
    "google-config": {
      getCredentials: async () => ({
        developerToken: "dev_tok_123",
        loginCustomerId: "9998887777",
        customerId: "1234567890",
        merchantId: "mc_1",
      }),
    },
  }
  return { ctx: { fetch, connections }, calls }
}

function noConnCtx() {
  const fetch = async () => {
    throw new Error("should not be called — connection is absent")
  }
  return { ctx: { fetch, connections: {} } }
}

function mutateOk(resourceName: string) {
  return { status: 200, body: JSON.stringify({ results: [{ resourceName }] }) }
}

// ─── google_create_campaign ────────────────────────────────────────────────

describe("google_create_campaign", () => {
  it("Search campaign: campaigns:mutate create, PAUSED status, budget linked via campaignBudgets:mutate", async () => {
    const { ctx, calls } = makeCtx([
      mutateOk("customers/1234567890/campaignBudgets/111"),
      mutateOk("customers/1234567890/campaigns/222"),
    ])
    const result = (await google_create_campaign(
      {
        name: "Search — Brand",
        advertising_channel_type: "SEARCH",
        daily_budget: 10,
        currency: "EUR",
      },
      ctx,
    )) as { campaign_resource_name?: string; status?: string }

    expect(calls.length).toBe(2)
    expect(calls[0]?.url).toContain("campaignBudgets:mutate")
    expect(calls[0]?.body).toContain("10000000") // 10 EUR -> micros
    expect(calls[1]?.url).toContain("campaigns:mutate")
    expect(calls[1]?.body).toContain("SEARCH")
    expect(calls[1]?.body).toContain("PAUSED")
    expect(result.status).toBe("PAUSED")
  })

  it("Performance Max campaign: advertising_channel_type PERFORMANCE_MAX", async () => {
    const { ctx, calls } = makeCtx([
      mutateOk("customers/1234567890/campaignBudgets/111"),
      mutateOk("customers/1234567890/campaigns/222"),
    ])
    await google_create_campaign(
      {
        name: "PMax — Catalog",
        advertising_channel_type: "PERFORMANCE_MAX",
        daily_budget: 25,
        currency: "USD",
      },
      ctx,
    )
    expect(calls[1]?.body).toContain("PERFORMANCE_MAX")
  })

  it("never creates ENABLED — status is always PAUSED regardless of caller intent", async () => {
    const { ctx, calls } = makeCtx([
      mutateOk("customers/1234567890/campaignBudgets/111"),
      mutateOk("customers/1234567890/campaigns/222"),
    ])
    await google_create_campaign(
      {
        name: "Search — Brand",
        advertising_channel_type: "SEARCH",
        daily_budget: 10,
        currency: "EUR",
        status: "ENABLED",
      },
      ctx,
    )
    expect(calls[1]?.body).toContain("PAUSED")
    expect(calls[1]?.body).not.toContain('"status":"ENABLED"')
  })

  it("rejects an invalid advertising_channel_type", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_create_campaign(
        { name: "x", advertising_channel_type: "DISPLAY", daily_budget: 10, currency: "EUR" },
        ctx,
      ),
    ).rejects.toThrow(/SEARCH|PERFORMANCE_MAX/)
  })

  it("connection-absent -> actionable connect-error, no fetch call", async () => {
    const { ctx } = noConnCtx()
    await expect(
      google_create_campaign(
        { name: "x", advertising_channel_type: "SEARCH", daily_budget: 10, currency: "EUR" },
        ctx,
      ),
    ).rejects.toThrow(GoogleConfigError)
  })

  it("threads the experiment field into the returned payload for the summarizer", async () => {
    const { ctx } = makeCtx([
      mutateOk("customers/1234567890/campaignBudgets/111"),
      mutateOk("customers/1234567890/campaigns/222"),
    ])
    const result = (await google_create_campaign(
      {
        name: "Search — Brand",
        advertising_channel_type: "SEARCH",
        daily_budget: 10,
        currency: "EUR",
        experiment: { title: "Brand test", hypothesis: "h", metric_tier: "blended" },
      },
      ctx,
    )) as { experiment?: unknown }
    expect(result.experiment).toEqual({
      title: "Brand test",
      hypothesis: "h",
      metric_tier: "blended",
    })
  })

  it("defaults bidding_strategy to manualCpc for SEARCH when omitted, embedded in the campaigns:mutate body", async () => {
    const { ctx, calls } = makeCtx([
      mutateOk("customers/1234567890/campaignBudgets/111"),
      mutateOk("customers/1234567890/campaigns/222"),
    ])
    const result = (await google_create_campaign(
      {
        name: "Search — Brand",
        advertising_channel_type: "SEARCH",
        daily_budget: 10,
        currency: "EUR",
      },
      ctx,
    )) as { bidding_strategy_type?: string }
    expect(calls[1]?.body).toContain("manualCpc")
    expect(result.bidding_strategy_type).toBe("manualCpc")
  })

  it("defaults bidding_strategy to maximizeConversions for PERFORMANCE_MAX when omitted", async () => {
    const { ctx, calls } = makeCtx([
      mutateOk("customers/1234567890/campaignBudgets/111"),
      mutateOk("customers/1234567890/campaigns/222"),
    ])
    const result = (await google_create_campaign(
      {
        name: "PMax",
        advertising_channel_type: "PERFORMANCE_MAX",
        daily_budget: 10,
        currency: "EUR",
      },
      ctx,
    )) as { bidding_strategy_type?: string }
    expect(calls[1]?.body).toContain("maximizeConversions")
    expect(result.bidding_strategy_type).toBe("maximizeConversions")
  })

  it("threads a caller-supplied bidding_strategy into the mutate body and the returned payload", async () => {
    const { ctx, calls } = makeCtx([
      mutateOk("customers/1234567890/campaignBudgets/111"),
      mutateOk("customers/1234567890/campaigns/222"),
    ])
    const result = (await google_create_campaign(
      {
        name: "Search — Brand",
        advertising_channel_type: "SEARCH",
        daily_budget: 10,
        currency: "EUR",
        bidding_strategy: { targetCpa: { targetCpaMicros: "5000000" } },
      },
      ctx,
    )) as { bidding_strategy_type?: string; bidding_strategy?: unknown }
    expect(calls[1]?.body).toContain("targetCpa")
    expect(result.bidding_strategy_type).toBe("targetCpa")
    expect(result.bidding_strategy).toEqual({ targetCpa: { targetCpaMicros: "5000000" } })
  })

  it("rejects a bidding_strategy with more than one field", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_create_campaign(
        {
          name: "x",
          advertising_channel_type: "SEARCH",
          daily_budget: 10,
          currency: "EUR",
          bidding_strategy: { manualCpc: {}, targetCpa: {} },
        },
        ctx,
      ),
    ).rejects.toThrow(/exactly one/)
  })

  it("rejects an unrecognized bidding_strategy field", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_create_campaign(
        {
          name: "x",
          advertising_channel_type: "SEARCH",
          daily_budget: 10,
          currency: "EUR",
          bidding_strategy: { bogusStrategy: {} },
        },
        ctx,
      ),
    ).rejects.toThrow(/recognized/)
  })
})

// ─── google_create_adgroup ─────────────────────────────────────────────────

describe("google_create_adgroup", () => {
  it("adGroups:mutate create with campaign ref", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/adGroups/333")])
    const result = (await google_create_adgroup(
      { campaign_id: "222", name: "Ad group 1" },
      ctx,
    )) as { resource_name?: string }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("adGroups:mutate")
    expect(calls[0]?.body).toContain("campaigns/222")
    expect(calls[0]?.body).toContain("Ad group 1")
    expect(result.resource_name).toContain("adGroups/333")
  })

  it("connection-absent -> connect-error", async () => {
    const { ctx } = noConnCtx()
    await expect(google_create_adgroup({ campaign_id: "222", name: "x" }, ctx)).rejects.toThrow(
      GoogleConfigError,
    )
  })

  it("threads the experiment field into the returned payload for the summarizer", async () => {
    const { ctx } = makeCtx([mutateOk("customers/1234567890/adGroups/333")])
    const result = (await google_create_adgroup(
      {
        campaign_id: "222",
        name: "Ad group 1",
        experiment: { title: "t", hypothesis: "h", metric_tier: "blended" },
      },
      ctx,
    )) as { experiment?: unknown }
    expect(result.experiment).toEqual({ title: "t", hypothesis: "h", metric_tier: "blended" })
  })
})

// ─── google_create_ad (RSA) ─────────────────────────────────────────────────

describe("google_create_ad", () => {
  it("adGroupAds:mutate with a responsive_search_ad asset structure, surfaces headline/description counts", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/adGroupAds/444")])
    const result = (await google_create_ad(
      {
        ad_group_id: "333",
        headlines: ["Buy Tessera 2", "Free Shipping", "Shop Now"],
        descriptions: ["Best field recorder", "Order today"],
        final_urls: ["https://fabrikam.example"],
      },
      ctx,
    )) as { headline_count?: number; description_count?: number }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("adGroupAds:mutate")
    expect(calls[0]?.body).toContain("responsiveSearchAd")
    expect(calls[0]?.body).toContain("Buy Tessera 2")
    expect(calls[0]?.body).toContain("Best field recorder")
    expect(calls[0]?.body).toContain("adGroups/333")
    expect(result.headline_count).toBe(3)
    expect(result.description_count).toBe(2)
  })

  it("rejects fewer than 3 headlines", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_create_ad(
        {
          ad_group_id: "333",
          headlines: ["only one", "only two"],
          descriptions: ["a", "b"],
          final_urls: ["https://x.com"],
        },
        ctx,
      ),
    ).rejects.toThrow(/at least 3 headlines/)
  })

  it("rejects fewer than 2 descriptions", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_create_ad(
        {
          ad_group_id: "333",
          headlines: ["a", "b", "c"],
          descriptions: ["only one"],
          final_urls: ["https://x.com"],
        },
        ctx,
      ),
    ).rejects.toThrow(/at least 2 descriptions/)
  })

  it("rejects zero final_urls", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_create_ad(
        {
          ad_group_id: "333",
          headlines: ["a", "b", "c"],
          descriptions: ["a", "b"],
          final_urls: [],
        },
        ctx,
      ),
    ).rejects.toThrow(/final_urls/)
  })

  it("connection-absent -> connect-error", async () => {
    const { ctx } = noConnCtx()
    await expect(
      google_create_ad(
        {
          ad_group_id: "333",
          headlines: ["a", "b", "c"],
          descriptions: ["a", "b"],
          final_urls: ["https://x.com"],
        },
        ctx,
      ),
    ).rejects.toThrow(GoogleConfigError)
  })
})

// ─── google_update_budget ──────────────────────────────────────────────────

describe("google_update_budget", () => {
  it("campaignBudgets:mutate update, major->micros exact", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/campaignBudgets/111")])
    const result = (await google_update_budget(
      {
        budget_resource_name: "customers/1234567890/campaignBudgets/111",
        amount: 42.5,
        currency: "EUR",
      },
      ctx,
    )) as { amount_micros?: number; amount?: number; currency?: string }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("campaignBudgets:mutate")
    expect(calls[0]?.body).toContain("42500000")
    expect(result.amount_micros).toBe(42_500_000)
    expect(result.amount).toBe(42.5)
    expect(result.currency).toBe("EUR")
  })

  it("connection-absent -> connect-error", async () => {
    const { ctx } = noConnCtx()
    await expect(
      google_update_budget(
        { budget_resource_name: "customers/123/campaignBudgets/1", amount: 10, currency: "EUR" },
        ctx,
      ),
    ).rejects.toThrow(GoogleConfigError)
  })
})

// ─── google_set_status (enable-direction gated) ────────────────────────────

describe("google_set_status", () => {
  it("sets ENABLED via mutate", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/campaigns/222")])
    const result = (await google_set_status(
      { object_id: "222", object_type: "campaign", status: "ENABLED" },
      ctx,
    )) as { status?: string }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("campaigns:mutate")
    expect(calls[0]?.body).toContain("ENABLED")
    expect(result.status).toBe("ENABLED")
  })

  it("rejects a PAUSED target with a hint to use google_pause", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_set_status({ object_id: "222", object_type: "campaign", status: "PAUSED" }, ctx),
    ).rejects.toThrow(/google_pause/)
  })

  it("connection-absent -> connect-error", async () => {
    const { ctx } = noConnCtx()
    await expect(
      google_set_status({ object_id: "222", object_type: "campaign", status: "ENABLED" }, ctx),
    ).rejects.toThrow(GoogleConfigError)
  })

  it("object_type=ad builds the composite adGroupAd resourceName from ad_group_id+ad_id, never a bare ad id", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/adGroupAds/77~444")])
    const result = (await google_set_status(
      { object_type: "ad", status: "ENABLED", ad_group_id: "77", ad_id: "444" },
      ctx,
    )) as { object_id?: string }
    expect(calls[0]?.url).toContain("adGroupAds:mutate")
    expect(calls[0]?.body).toContain("adGroupAds/77~444")
    expect(result.object_id).toBe("77~444")
  })

  it("object_type=ad accepts a pre-composed object_id (adGroupId~adId)", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/adGroupAds/88~555")])
    await google_set_status({ object_id: "88~555", object_type: "ad", status: "ENABLED" }, ctx)
    expect(calls[0]?.body).toContain("adGroupAds/88~555")
  })

  it("object_type=ad without ad_group_id/ad_id or a composite object_id throws an actionable error", async () => {
    const { ctx } = makeCtx([])
    await expect(
      google_set_status({ object_id: "333", object_type: "ad", status: "ENABLED" }, ctx),
    ).rejects.toThrow(/composite/)
  })
})

// ─── google_add_negative_keywords ──────────────────────────────────────────

describe("google_add_negative_keywords", () => {
  it("adGroupCriteria:mutate adds negative keyword criteria, enumerated", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/adGroupCriteria/1")])
    const result = (await google_add_negative_keywords(
      {
        ad_group_id: "333",
        keywords: [
          { text: "free", match_type: "BROAD" },
          { text: "cheap", match_type: "PHRASE" },
        ],
      },
      ctx,
    )) as { added?: unknown[] }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("adGroupCriteria:mutate")
    expect(calls[0]?.body).toContain("negative")
    expect(calls[0]?.body).toContain("free")
    expect(calls[0]?.body).toContain("cheap")
    expect(result.added?.length).toBe(2)
  })

  it("campaign-level negatives via campaignCriteria:mutate", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/campaignCriteria/1")])
    await google_add_negative_keywords(
      { campaign_id: "222", keywords: [{ text: "free", match_type: "BROAD" }] },
      ctx,
    )
    expect(calls[0]?.url).toContain("campaignCriteria:mutate")
  })

  it("connection-absent -> connect-error", async () => {
    const { ctx } = noConnCtx()
    await expect(
      google_add_negative_keywords(
        { ad_group_id: "333", keywords: [{ text: "free", match_type: "BROAD" }] },
        ctx,
      ),
    ).rejects.toThrow(GoogleConfigError)
  })
})

// ─── google_create_conversion_action ───────────────────────────────────────

describe("google_create_conversion_action", () => {
  it("conversionActions:mutate create", async () => {
    const { ctx, calls } = makeCtx([mutateOk("customers/1234567890/conversionActions/999")])
    const result = (await google_create_conversion_action(
      { name: "Web purchase", category: "PURCHASE", type: "WEBPAGE" },
      ctx,
    )) as { resource_name?: string }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("conversionActions:mutate")
    expect(calls[0]?.body).toContain("Web purchase")
    expect(calls[0]?.body).toContain("PURCHASE")
    expect(result.resource_name).toContain("conversionActions/999")
  })

  it("connection-absent -> connect-error", async () => {
    const { ctx } = noConnCtx()
    await expect(
      google_create_conversion_action({ name: "x", category: "PURCHASE", type: "WEBPAGE" }, ctx),
    ).rejects.toThrow(GoogleConfigError)
  })
})
