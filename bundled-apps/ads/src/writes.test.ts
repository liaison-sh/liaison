// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  create_campaign,
  create_adset,
  create_ad,
  create_creative,
  upload_image,
  update_budget,
  set_status,
  create_custom_audience,
  create_lookalike_audience,
  add_users_to_audience,
  type CrossAppEnvelope,
} from "./writes"
import {
  summarizeCampaign,
  summarizeAdset,
  summarizeAd,
  summarizeCreative,
  summarizeUploadImage,
  summarizeBudget,
  summarizeSetStatus,
  summarizeCustomAudience,
  summarizeLookalike,
  summarizeAddUsers,
} from "./summarizers"

// ─── makeCtx helper ───────────────────────────────────────────────────────────

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

interface MockResponse {
  status: number
  headers?: Record<string, string>
  body: string
}

function makeCtx(
  fetchResponses: MockResponse[],
  executeToolResponses?: CrossAppEnvelope[],
) {
  const calls: FetchCall[] = []
  let fetchIdx = 0
  let executeToolIdx = 0
  const fetch = async (url: string, opts?: Record<string, unknown>) => {
    calls.push({
      url,
      method: String(opts?.method ?? "GET"),
      headers: (opts?.headers ?? {}) as Record<string, string>,
      body: typeof opts?.body === "string" ? opts.body : undefined,
    })
    const resp = fetchResponses[fetchIdx++]
    if (!resp) throw new Error(`No mock fetch response for call ${fetchIdx} to ${url}`)
    return { status: resp.status, headers: resp.headers ?? {}, body: resp.body }
  }

  const executeToolCalls: Array<{ target: string; args: Record<string, unknown> }> = []
  const executeTool = async (target: string, args: Record<string, unknown>): Promise<CrossAppEnvelope> => {
    executeToolCalls.push({ target, args })
    // Consent-join reads (database:db_read) are on a SEPARATE default lane
    // from the caller-supplied executeToolResponses queue (which existing
    // tests size for the shopify:customers_search call only) — default to a
    // granted consent record for every email so pre-consent-join tests keep
    // passing without per-test consent mocking. Tests exercising consent
    // default-deny behavior use a dedicated ctx (see consent-join describe
    // block) instead of this shared helper.
    if (target === "database:db_read") {
      return { status: "completed", result: [{ ad_consent: "granted", marketing_consent: true }] }
    }
    const resp = executeToolResponses?.[executeToolIdx++]
    return resp ?? { status: "completed", result: { customers: [] } }
  }

  const connections = {
    meta: {
      getCredentials: async () => ({
        accessToken: "test_token",
        adAccountId: "act_123456",
        defaultPageId: "page_1",
      }),
    },
  }
  return { ctx: { fetch, connections, executeTool }, calls, executeToolCalls }
}

// ─── create_campaign ─────────────────────────────────────────────────────────

describe("create_campaign", () => {
  it("POST body literally contains special_ad_categories key with value []", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "camp_1" }) }])
    await create_campaign(
      { name: "Test", objective: "OUTCOME_SALES", special_ad_categories: [] },
      ctx,
    )
    // Assert PRESENCE of special_ad_categories in the POST body (not just value)
    const body = calls[0]?.body ?? ""
    expect(body).toContain("special_ad_categories")
    expect(body).toContain("%5B%5D") // URL-encoded []
  })

  it("rejects legacy objectives with a clear error message", async () => {
    const { ctx } = makeCtx([])
    await expect(
      create_campaign({ name: "Test", objective: "CONVERSIONS" }, ctx),
    ).rejects.toThrow(/OUTCOME_/)
  })

  it("rejects TRAFFIC (legacy)", async () => {
    const { ctx } = makeCtx([])
    await expect(
      create_campaign({ name: "Test", objective: "TRAFFIC" }, ctx),
    ).rejects.toThrow(/OUTCOME_/)
  })

  it("accepts OUTCOME_SALES", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "camp_2" }) }])
    await create_campaign(
      { name: "Sales Camp", objective: "OUTCOME_SALES", special_ad_categories: [] },
      ctx,
    )
    expect(calls[0]?.body).toContain("OUTCOME_SALES")
  })

  it("defaults status to PAUSED", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "c1" }) }])
    await create_campaign({ name: "Camp", objective: "OUTCOME_LEADS" }, ctx)
    expect(calls[0]?.body).toContain("PAUSED")
  })

  it("belt-and-suspenders: handler still emits special_ad_categories=[] even if the param is omitted (P1: schema is now required, but the handler never drops the Meta-mandatory key)", async () => {
    // The manifest now marks special_ad_categories as a REQUIRED param (the kernel
    // rejects an omitting tool-call before dispatch), but the handler keeps a
    // belt-and-suspenders default so a direct handler call never produces a body
    // missing the Meta-mandatory key.
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "c1" }) }])
    await create_campaign({ name: "Camp", objective: "OUTCOME_LEADS" }, ctx)
    const body = calls[0]?.body ?? ""
    expect(body).toContain("special_ad_categories")
    expect(body).toContain("%5B%5D") // URL-encoded []
  })
})

// ─── create_adset ────────────────────────────────────────────────────────────

describe("create_adset", () => {
  it("passes targeting with custom_audiences and excluded_custom_audiences", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "adset_1" }) }])
    await create_adset(
      {
        campaign_id: "camp_1",
        name: "Test Adset",
        targeting: {
          geo_locations: { countries: ["FR"] },
          custom_audiences: [{ id: "aud_1" }],
          excluded_custom_audiences: [{ id: "aud_2" }],
        },
        optimization_goal: "REACH",
        billing_event: "IMPRESSIONS",
        daily_budget: "50",
        currency: "EUR",
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    expect(body).toContain("custom_audiences")
    expect(body).toContain("excluded_custom_audiences")
    expect(body).toContain("aud_1")
    expect(body).toContain("aud_2")
  })

  it("converts major-unit daily_budget → minor units (EUR: 50 → 5000) — same contract as update_budget", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "adset_b" }) }])
    await create_adset(
      {
        campaign_id: "camp_1",
        name: "Budget Adset",
        targeting: { geo_locations: { countries: ["FR"] } },
        optimization_goal: "REACH",
        billing_event: "IMPRESSIONS",
        daily_budget: "50",
        currency: "EUR",
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    // 50 EUR major → 5000 minor; NOT passed through as 50, NOT double-scaled to 500000
    expect(body).toContain("daily_budget=5000")
    expect(body).not.toContain("daily_budget=50&")
    expect(body).not.toContain("500000")
  })

  it("converts major-unit daily_budget for JPY: 500 → 500 (zero-decimal, no ×100)", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "adset_jpy" }) }])
    await create_adset(
      {
        campaign_id: "camp_1",
        name: "JPY Adset",
        targeting: { geo_locations: { countries: ["JP"] } },
        optimization_goal: "REACH",
        billing_event: "IMPRESSIONS",
        daily_budget: "500",
        currency: "JPY",
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    expect(body).toContain("daily_budget=500")
    expect(body).not.toContain("daily_budget=50000")
  })

  it("passes custom_locations in targeting", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "adset_2" }) }])
    await create_adset(
      {
        campaign_id: "camp_1",
        name: "Geo Adset",
        targeting: {
          geo_locations: {
            custom_locations: [{ latitude: 48.8566, longitude: 2.3522, radius: 40, distance_unit: "kilometer" }],
          },
        },
        optimization_goal: "REACH",
        billing_event: "IMPRESSIONS",
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    expect(body).toContain("custom_locations")
    expect(body).toContain("48.8566")
  })
})

// ─── create_creative ─────────────────────────────────────────────────────────

describe("create_creative", () => {
  it("emits exact carousel child_attachments shape in POST body", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "creative_1" }) }])
    const childAttachments = [
      { image_hash: "hash1", link: "https://example.com/1", name: "Card 1" },
      { image_hash: "hash2", link: "https://example.com/2", name: "Card 2" },
    ]
    await create_creative(
      {
        object_story_spec: { page_id: "page_1" },
        asset_feed_spec: { child_attachments: childAttachments },
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    expect(body).toContain("child_attachments")
    expect(body).toContain("hash1")
    expect(body).toContain("hash2")
    expect(body).toContain("asset_feed_spec")
  })

  it("emits dynamic asset_feed_spec shape (images, titles, bodies, call_to_action_types)", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "creative_2" }) }])
    await create_creative(
      {
        object_story_spec: { page_id: "page_1" },
        asset_feed_spec: {
          images: [{ hash: "hashA" }, { hash: "hashB" }],
          titles: [{ text: "Title 1" }, { text: "Title 2" }],
          bodies: [{ text: "Body 1" }],
          call_to_action_types: ["SHOP_NOW"],
          link_urls: [{ website_url: "https://example.com" }],
        },
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    expect(body).toContain("asset_feed_spec")
    expect(body).toContain("hashA")
    expect(body).toContain("SHOP_NOW")
  })

  it("pre-rejects carousel with < 2 child_attachments with CAROUSEL_IMAGE in message", async () => {
    const { ctx } = makeCtx([])
    await expect(
      create_creative(
        {
          object_story_spec: { page_id: "page_1" },
          asset_feed_spec: { child_attachments: [{ image_hash: "only_one" }] },
        },
        ctx,
      ),
    ).rejects.toThrow(/CAROUSEL_IMAGE/)
  })

  it("pre-reject for carousel < 2 makes NO fetch calls (calls.length===0)", async () => {
    const { ctx, calls } = makeCtx([])
    await create_creative(
      {
        object_story_spec: { page_id: "page_1" },
        asset_feed_spec: { child_attachments: [{ image_hash: "only_one" }] },
      },
      ctx,
    ).catch(() => {})
    expect(calls.length).toBe(0)
  })
})

// ─── upload_image ─────────────────────────────────────────────────────────────

describe("upload_image", () => {
  it("rejects an image > ~740 KB with NO ctx.fetch call (calls.length===0)", async () => {
    const { ctx, calls } = makeCtx([])
    const tooBig = "A".repeat(986_000) // > 985_000 threshold
    await upload_image({ image_bytes: tooBig }, ctx).catch(() => {})
    expect(calls.length).toBe(0)
  })

  it("rejection message contains '740' AND 'media_list'", async () => {
    const { ctx } = makeCtx([])
    const tooBig = "A".repeat(986_000)
    const err = await upload_image({ image_bytes: tooBig }, ctx).catch((e: Error) => e)
    expect((err as Error).message).toContain("740")
    expect((err as Error).message).toContain("media_list")
  })

  it("accepts image within limit and returns image_hash", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ images: { "banner.jpg": { hash: "abc123", url: "https://..." } } }),
    }])
    const result = await upload_image(
      { image_bytes: "A".repeat(100), filename: "banner.jpg" },
      ctx,
    ) as { image_hash: string }
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toContain("/act_123456/adimages")
    expect(result.image_hash).toBe("abc123")
  })
})

// ─── update_budget ─────────────────────────────────────────────────────────────

describe("update_budget", () => {
  it("converts major-unit budget string → integer minor units (EUR: 50 → 5000)", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ success: true }) }])
    await update_budget(
      { level: "adset", object_id: "adset_99", daily_budget: "50", currency: "EUR" },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    // 50 EUR → 5000 minor units
    expect(body).toContain("5000")
  })

  it("converts major-unit budget for JPY: 500 → 500 (zero-decimal currency, no ×100)", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ success: true }) }])
    await update_budget(
      { level: "campaign", object_id: "camp_99", daily_budget: "500", currency: "JPY" },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    // 500 JPY → 500 minor units (no multiplication). Assert the VALUE, not just the key.
    expect(body).toContain("daily_budget=500")
    expect(body).not.toContain("50000")
  })

  it("REQUIRES currency — errors loudly (no silent EUR default) when currency is absent", async () => {
    const { ctx, calls } = makeCtx([])
    const err = await update_budget(
      { level: "adset", object_id: "adset_x", daily_budget: "50" },
      ctx,
    ).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/currency is required/i)
    // No Meta call made — failed fast before POST
    expect(calls.length).toBe(0)
  })

  it("BudgetCapError (613+1487632) is surfaced without retrying — calls.length===1", async () => {
    const { ctx, calls } = makeCtx([{
      status: 400,
      body: JSON.stringify({ error: { code: 613, error_subcode: 1487632, message: "Budget cap", fbtrace_id: "X" } }),
    }])
    const err = await update_budget(
      { level: "adset", object_id: "adset_1", daily_budget: "50", currency: "EUR" },
      ctx,
    ).catch((e: Error) => e)
    // BudgetCapError is thrown (not silently retried)
    expect(err).toBeDefined()
    expect(calls.length).toBe(1) // exactly one attempt, no retry
  })

  it("summarizeBudget produces editableFields-compatible output with widget:'text' label in major units", () => {
    const summary = summarizeBudget({ level: "adset", object_id: "adset_1", daily_budget: "50", currency: "EUR" })
    expect(summary.kind).toBe("update_budget")
    // Title or lines mention major units not minor
    const allText = [summary.title, summary.subtitle ?? "", ...(summary.lines ?? [])].join(" ")
    expect(allText).toMatch(/50|budget/i)
  })

  it("P1.6: summarizeBudget echoes major + computed minor + currency (auditable conversion, no hardcoded €)", () => {
    const summary = summarizeBudget({ level: "adset", object_id: "adset_1", daily_budget: "50", currency: "USD" })
    const allText = [summary.title, summary.subtitle ?? "", ...(summary.lines ?? [])].join(" ")
    expect(allText).toContain("50.00 USD") // major + real currency, not €
    expect(allText).toContain("5000") // computed minor units (USD: 50 → 5000)
    expect(allText).not.toContain("€") // never hardcode EUR symbol for a USD account
  })

  it("P1.6: summarizeAdset (the A/B card) echoes major + computed minor + currency", () => {
    const summary = summarizeAdset({ name: "AdSet A", campaign_id: "c1", daily_budget: "50", currency: "USD" })
    const allText = [summary.title, summary.subtitle ?? "", ...(summary.lines ?? [])].join(" ")
    expect(allText).toContain("50.00 USD")
    expect(allText).toContain("5000")
  })

  it("P1.6: zero-decimal currency (JPY) — minor echo is NOT ×100", () => {
    const summary = summarizeBudget({ level: "adset", object_id: "adset_1", daily_budget: "500", currency: "JPY" })
    const allText = [summary.title, summary.subtitle ?? "", ...(summary.lines ?? [])].join(" ")
    expect(allText).toContain("500.00 JPY")
    expect(allText).toContain("500 minor units") // 500 JPY → 500 minor, never 50000
    expect(allText).not.toContain("50000")
  })
})

// ─── set_status ───────────────────────────────────────────────────────────────

describe("set_status", () => {
  it("POSTs status update then re-reads effective_status", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ success: true }) },
      { status: 200, body: JSON.stringify({ id: "camp_1", effective_status: "ACTIVE" }) },
    ])
    await set_status({ object_id: "camp_1", status: "ACTIVE" }, ctx)
    // call[0] = POST status update
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.body).toContain("ACTIVE")
    // call[1] = GET to re-read effective_status
    expect(calls[1]?.method).toBe("GET")
    expect(calls[1]?.url).toContain("effective_status")
  })
})

// ─── create_custom_audience ─────────────────────────────────────────────────

describe("create_custom_audience — CUSTOMER_LIST", () => {
  it("calls executeTool with a PLAIN OBJECT arg (not a stringified JSON string)", async () => {
    const { ctx, executeToolCalls } = makeCtx(
      [
        { status: 200, body: JSON.stringify({ id: "aud_1" }) },  // create audience
        { status: 200, body: JSON.stringify({ audience_id: "aud_1", num_received: 1, num_invalid_entries: 0 }) }, // upload users
      ],
      [
        {
          status: "completed",
          result: {
            customers: [{ email: "alice@example.com", phone: null }],
          },
        },
      ],
    )
    await create_custom_audience(
      {
        subtype: "CUSTOMER_LIST",
        name: "Dealers",
        customer_file_source: "USER_PROVIDED_ONLY",
        shopify_customer_query: { tag: "dealer" },
        audience_purpose: "buyer",
      },
      ctx,
    )
    // The executeTool call arg must be a plain object, not a string
    expect(typeof executeToolCalls[0]?.args).toBe("object")
    expect(executeToolCalls[0]?.target).toBe("shopify:customers_search")
  })

  it("POST body contains ONLY 64-char SHA-256 hex — no raw email anywhere in calls[]", async () => {
    const { ctx, calls } = makeCtx(
      [
        { status: 200, body: JSON.stringify({ id: "aud_2" }) },
        { status: 200, body: JSON.stringify({ audience_id: "aud_2", num_received: 1, num_invalid_entries: 0 }) },
      ],
      [
        {
          status: "completed",
          result: {
            customers: [{ email: "bob@test.com", phone: null }],
          },
        },
      ],
    )
    await create_custom_audience(
      {
        subtype: "CUSTOMER_LIST",
        name: "Test List",
        customer_file_source: "USER_PROVIDED_ONLY",
        shopify_customer_query: { tag: "vip" },
        audience_purpose: "buyer",
      },
      ctx,
    )
    // Check ALL calls — no raw email must appear
    const allCallText = calls.map((c) => (c.url ?? "") + (c.body ?? "")).join(" ")
    expect(allCallText).not.toContain("bob@test.com")
    // Must contain a 64-char hex hash
    expect(allCallText).toMatch(/[0-9a-f]{64}/)
  })

  it("phone-only customer (no email) → dropped by consent-join default-deny (no email to join consent on); reported, not silently uploaded", async () => {
    const { ctx, calls } = makeCtx(
      [
        { status: 200, body: JSON.stringify({ id: "aud_ph" }) },
      ],
      [
        {
          status: "completed",
          result: { customers: [{ email: null, phone: "+1 (555) 123-4567" }] },
        },
      ],
    )
    const result = await create_custom_audience(
      {
        subtype: "CUSTOMER_LIST",
        name: "Phone List",
        customer_file_source: "USER_PROVIDED_ONLY",
        shopify_customer_query: { tag: "sms" },
        audience_purpose: "buyer",
      },
      ctx,
    ) as { schema: string[]; users_hashed: number; dropped_no_consent_source: number }
    // Phone-only identifiers have no email to consent-join on — default-deny
    // drops them rather than uploading un-joined. No /users upload call fires.
    expect(result.users_hashed).toBe(0)
    expect(result.dropped_no_consent_source).toBe(1)
    expect(calls.length).toBe(1) // only the create-audience call; no /users upload
    const allCallText = calls.map((c) => (c.url ?? "") + (c.body ?? "")).join(" ")
    expect(allCallText).not.toContain("15551234567")
    expect(allCallText).not.toContain("5551234567")
  })

  it("WEBSITE subtype: sends pixel_id + rule + retention_days", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ id: "aud_3" }) },
    ])
    await create_custom_audience(
      {
        subtype: "WEBSITE",
        name: "Website Visitors",
        pixel_id: "px_42",
        rule: { inclusions: { operator: "or", rules: [{ event_sources: [{ id: "px_42", type: "pixel" }], retention_seconds: 2592000, filter: {} }] } },
        retention_days: 30,
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    expect(body).toContain("WEBSITE")
    expect(body).toContain("px_42")
    expect(body).toContain("retention_days")
  })

  it("ENGAGEMENT subtype: sends object_type + source_id + engagement_type + retention_days", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ id: "aud_4" }) },
    ])
    await create_custom_audience(
      {
        subtype: "ENGAGEMENT",
        name: "IG Engagers",
        object_type: "IG_BUSINESS",
        source_id: "ig_123",
        engagement_type: "IG_BUSINESS_PROFILE_ALL",
        retention_days: 60,
      },
      ctx,
    )
    const body = calls[0]?.body ?? ""
    expect(body).toContain("ENGAGEMENT")
    expect(body).toContain("ig_123")
    expect(body).toContain("IG_BUSINESS_PROFILE_ALL")
  })

  it("audience summarizer includes population/match-latency disclosure", () => {
    const summary = summarizeCustomAudience({ subtype: "CUSTOMER_LIST", name: "Dealers" })
    const text = [summary.title, ...(summary.lines ?? [])].join(" ")
    expect(text.toLowerCase()).toMatch(/populate|match.*latency|not immediately usable|must populate/i)
  })

  it("refuses without audience_purpose (default-deny — never guesses the consent domain)", async () => {
    const { ctx } = makeCtx([{ status: 200, body: JSON.stringify({ id: "aud_np" }) }])
    await expect(
      create_custom_audience(
        {
          subtype: "CUSTOMER_LIST",
          name: "No Purpose",
          customer_file_source: "USER_PROVIDED_ONLY",
          shopify_customer_query: { tag: "x" },
        },
        ctx,
      ),
    ).rejects.toThrow(/audience_purpose/)
  })

  it("RED: an unconsented email never reaches the Meta upload payload (buyer purpose, no ad_consent record)", async () => {
    const executeToolCalls: Array<{ target: string; args: Record<string, unknown> }> = []
    const fetchCalls: Array<{ url: string; body?: string }> = []
    const ctx = {
      fetch: async (url: string, opts?: Record<string, unknown>) => {
        fetchCalls.push({ url, body: typeof opts?.body === "string" ? opts.body : undefined })
        if (fetchCalls.length === 1) return { status: 200, headers: {}, body: JSON.stringify({ id: "aud_unconsented" }) }
        throw new Error("no second Meta call expected — nothing should be uploaded")
      },
      connections: {
        meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
      },
      executeTool: async (target: string, args: Record<string, unknown>) => {
        executeToolCalls.push({ target, args })
        if (target === "shopify:customers_search") {
          return { status: "completed" as const, result: { customers: [{ email: "unconsented@example.com" }] } }
        }
        if (target === "database:db_read") {
          // No record at all for this email — default-deny.
          return { status: "completed" as const, result: [] }
        }
        return { status: "completed" as const, result: [] }
      },
    }
    const result = (await create_custom_audience(
      {
        subtype: "CUSTOMER_LIST",
        name: "Unconsented",
        customer_file_source: "USER_PROVIDED_ONLY",
        shopify_customer_query: { tag: "x" },
        audience_purpose: "buyer",
      },
      ctx,
    )) as { users_hashed: number; dropped_no_consent_source: number }
    expect(result.users_hashed).toBe(0)
    expect(result.dropped_no_consent_source).toBe(1)
    // Only ONE Meta fetch call happened (create audience) — no /users upload,
    // proving the unconsented email never reached the upload payload.
    expect(fetchCalls.length).toBe(1)
  })

  it("surfaces consent_source_unreachable when the consent source itself cannot be reached (never an opaque all-dropped result)", async () => {
    const ctx = {
      fetch: async (_url: string, _opts?: Record<string, unknown>) => {
        return { status: 200, headers: {}, body: JSON.stringify({ id: "aud_unreachable" }) }
      },
      connections: {
        meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
      },
      executeTool: async (target: string) => {
        if (target === "shopify:customers_search") {
          return { status: "completed" as const, result: { customers: [{ email: "someone@example.com" }] } }
        }
        // Every consent-source call (curated db_read AND the db_query
        // fallback) errors — the source itself is down, not merely
        // "no record".
        return { status: "error" as const, error: { code: "connect_error", message: "database app not connected" } }
      },
    }
    const result = (await create_custom_audience(
      {
        subtype: "CUSTOMER_LIST",
        name: "Unreachable",
        customer_file_source: "USER_PROVIDED_ONLY",
        shopify_customer_query: { tag: "x" },
        audience_purpose: "buyer",
      },
      ctx,
    )) as { users_hashed: number; consent_source_unreachable?: boolean }
    expect(result.users_hashed).toBe(0)
    expect(result.consent_source_unreachable).toBe(true)
  })
})

// ─── create_lookalike_audience ───────────────────────────────────────────────

describe("create_lookalike_audience", () => {
  it("value_based with no source value field → Meta declines (100), falls back to similarity + honest-decline", async () => {
    const { ctx, calls } = makeCtx([
      // 1st call: value_based attempt → Meta rejects (ParamError, code 100)
      { status: 400, body: JSON.stringify({ error: { code: 100, message: "Source audience has no value data", fbtrace_id: "v1" } }) },
      // 2nd call: similarity fallback → succeeds
      { status: 200, body: JSON.stringify({ id: "lal_fallback" }) },
    ])
    const result = await create_lookalike_audience(
      {
        source_audience_id: "aud_1",
        country: "FR",
        ratio: 1,
        value_based: true,
      },
      ctx,
    ) as { honest_decline?: string; audience_id?: string; value_based?: boolean }
    // The value-based attempt was made, failed, then fell back to a plain lookalike.
    expect(calls.length).toBe(2)
    expect(result.value_based).toBe(false)
    expect(result.audience_id).toBe("lal_fallback")
    expect(result.honest_decline).toBeDefined()
    expect(result.honest_decline).toMatch(/value|source|plain|similarity/i)
    // The first attempt actually requested a value_based spec (honored, not silently downgraded).
    expect(calls[0]?.body ?? "").toContain("value_based")
  })

  it("value_based when source HAS value data → value-based lookalike created (NOT downgraded)", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ id: "lal_value" }) }, // value_based attempt succeeds
    ])
    const result = await create_lookalike_audience(
      { source_audience_id: "aud_1", country: "FR", ratio: 2, value_based: true },
      ctx,
    ) as { value_based?: boolean; honest_decline?: string; audience_id?: string }
    // Honored — one call, value_based:true, no honest-decline.
    expect(calls.length).toBe(1)
    expect(calls[0]?.body ?? "").toContain("value_based")
    expect(result.value_based).toBe(true)
    expect(result.honest_decline).toBeUndefined()
    expect(result.audience_id).toBe("lal_value")
  })

  it("plain (non-value) lookalike → similarity spec, value_based:false, no honest-decline", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ id: "lal_plain" }) }])
    const result = await create_lookalike_audience(
      { source_audience_id: "aud_1", country: "FR", ratio: 1 },
      ctx,
    ) as { value_based?: boolean; honest_decline?: string }
    expect(calls.length).toBe(1)
    expect(calls[0]?.body ?? "").toContain("similarity")
    expect(result.value_based).toBe(false)
    expect(result.honest_decline).toBeUndefined()
  })

  it("lookalike summarizer includes population/match-latency disclosure", () => {
    const summary = summarizeLookalike({ source_audience_id: "aud_1", country: "FR", ratio: 1 })
    const text = [summary.title, ...(summary.lines ?? [])].join(" ")
    expect(text.toLowerCase()).toMatch(/populate|match.*latency|not immediately usable|must populate/i)
  })
})

// ─── add_users_to_audience ───────────────────────────────────────────────────

describe("add_users_to_audience", () => {
  it("uses the APPEND endpoint (/{audience_id}/users) NOT a replace endpoint", async () => {
    const { ctx, calls } = makeCtx(
      [{ status: 200, body: JSON.stringify({ audience_id: "aud_1", num_received: 1 }) }],
      [{ status: "completed", result: { customers: [{ email: "carol@example.com" }] } }],
    )
    await add_users_to_audience(
      { audience_id: "aud_1", shopify_customer_query: { tag: "premium" }, audience_purpose: "buyer" },
      ctx,
    )
    const postUrl = calls[0]?.url ?? ""
    expect(postUrl).toContain("/aud_1/users")
    expect(calls[0]?.method).toBe("POST")
  })

  it("calls contain ONLY 64-char SHA-256 hex — no raw email", async () => {
    const { ctx, calls } = makeCtx(
      [{ status: 200, body: JSON.stringify({ audience_id: "aud_1", num_received: 1 }) }],
      [{ status: "completed", result: { customers: [{ email: "dave@example.com" }] } }],
    )
    await add_users_to_audience(
      { audience_id: "aud_1", shopify_customer_query: { tag: "premium" }, audience_purpose: "buyer" },
      ctx,
    )
    const allText = calls.map((c) => (c.url ?? "") + (c.body ?? "")).join(" ")
    expect(allText).not.toContain("dave@example.com")
    expect(allText).toMatch(/[0-9a-f]{64}/)
  })

  it("executeTool arg is a PLAIN OBJECT (not pre-stringified)", async () => {
    const { ctx, executeToolCalls } = makeCtx(
      [{ status: 200, body: JSON.stringify({ audience_id: "aud_1", num_received: 0 }) }],
      [{ status: "completed", result: { customers: [] } }],
    )
    await add_users_to_audience(
      { audience_id: "aud_1", shopify_customer_query: { tag: "vip" }, audience_purpose: "buyer" },
      ctx,
    )
    expect(typeof executeToolCalls[0]?.args).toBe("object")
    expect(typeof executeToolCalls[0]?.args).not.toBe("string")
  })

  it("add_users summarizer includes population/match-latency disclosure", () => {
    const summary = summarizeAddUsers({ audience_id: "aud_1" })
    const text = [summary.title, ...(summary.lines ?? [])].join(" ")
    expect(text.toLowerCase()).toMatch(/populate|match.*latency|not immediately usable|must populate/i)
  })

  it("refuses without audience_purpose (default-deny)", async () => {
    const { ctx } = makeCtx([])
    await expect(
      add_users_to_audience({ audience_id: "aud_1", shopify_customer_query: { tag: "x" } }, ctx),
    ).rejects.toThrow(/audience_purpose/)
  })

  it("RED: newsletter purpose keeps only marketing_consent=true — an unconsented email never reaches the upload payload", async () => {
    const fetchCalls: Array<{ url: string }> = []
    const ctx = {
      fetch: async (url: string) => {
        fetchCalls.push({ url })
        throw new Error("no Meta upload call expected — nothing should be uploaded")
      },
      connections: {
        meta: { getCredentials: async () => ({ accessToken: "t", adAccountId: "act_1" }) },
      },
      executeTool: async (target: string, args: Record<string, unknown>) => {
        if (target === "shopify:customers_search") {
          return { status: "completed" as const, result: { customers: [{ email: "no-newsletter-consent@example.com" }] } }
        }
        if (target === "database:db_read") {
          return { status: "completed" as const, result: [{ marketing_consent: false }] }
        }
        return { status: "completed" as const, result: [] }
      },
    }
    const result = (await add_users_to_audience(
      { audience_id: "aud_1", shopify_customer_query: { tag: "x" }, audience_purpose: "newsletter" },
      ctx,
    )) as { users_added: number; dropped_no_consent: number }
    expect(result.users_added).toBe(0)
    expect(result.dropped_no_consent).toBe(1)
    expect(fetchCalls.length).toBe(0) // no /users upload call at all
  })
})

// ─── Manifest write-tool invariants (Task 6 manifest.test extension) ─────────

describe("manifest write-tool invariants (raw JSON)", () => {
  const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    tools: Record<string, {
      gated?: boolean
      trustBoundary?: string
      approvalCard?: { summary?: string }
      summarizer?: string
      handler?: string
      editableFields?: Array<{ widget: string }>
    }>
  }

  const WRITE_TOOLS = [
    "create_campaign",
    "create_adset",
    "create_ad",
    "create_creative",
    "upload_image",
    "update_budget",
    "set_status",
    "create_custom_audience",
    "create_lookalike_audience",
    "add_users_to_audience",
  ]

  it("every write tool exists in the manifest", () => {
    for (const name of WRITE_TOOLS) {
      expect(manifest.tools[name], `write tool '${name}' missing from manifest`).toBeDefined()
    }
  })

  it("every write tool has gated:true AND trustBoundary:'user'", () => {
    for (const name of WRITE_TOOLS) {
      const tool = manifest.tools[name]
      expect(tool?.gated, `${name} missing gated:true`).toBe(true)
      expect(tool?.trustBoundary, `${name} missing trustBoundary:'user'`).toBe("user")
    }
  })

  it("every write tool has approvalCard.summary + summarizer", () => {
    for (const name of WRITE_TOOLS) {
      const tool = manifest.tools[name]
      expect(tool?.approvalCard?.summary, `${name} missing approvalCard.summary`).toBeTruthy()
      expect(tool?.summarizer, `${name} missing summarizer`).toBeTruthy()
    }
  })

  it("budget-bearing tools (update_budget) have editableFields with widget:'text'", () => {
    const budgetTool = manifest.tools.update_budget
    expect(budgetTool?.editableFields).toBeDefined()
    const hasText = (budgetTool?.editableFields ?? []).some((f) => f.widget === "text")
    expect(hasText).toBe(true)
  })
})

// ─── Summarizer purity (pure, no DB/fetch) ────────────────────────────────────

describe("summarizers — pure functions return {kind,title,subtitle?,lines[]}", () => {
  const cases = [
    [summarizeCampaign, { name: "Test", objective: "OUTCOME_SALES" }, "create_campaign"],
    [summarizeAdset, { name: "Adset", campaign_id: "c1" }, "create_adset"],
    [summarizeAd, { name: "Ad", adset_id: "a1", creative_id: "cr1" }, "create_ad"],
    [summarizeCreative, { page_id: "p1" }, "create_creative"],
    [summarizeUploadImage, {}, "upload_image"],
    [summarizeBudget, { level: "adset", object_id: "a1", daily_budget: "50" }, "update_budget"],
    [summarizeSetStatus, { object_id: "o1", status: "ACTIVE" }, "set_status"],
    [summarizeCustomAudience, { subtype: "WEBSITE", name: "Visitors" }, "create_custom_audience"],
    [summarizeLookalike, { source_audience_id: "s1", country: "FR", ratio: 1 }, "create_lookalike_audience"],
    [summarizeAddUsers, { audience_id: "a1" }, "add_users_to_audience"],
  ] as const

  for (const [fn, params, expectedKind] of cases) {
    it(`${String(fn.name)} returns {kind:'${expectedKind}', title, lines[]}`, () => {
      const result = (fn as (p: unknown) => { kind: string; title: string; lines?: string[] })(params)
      expect(result.kind).toBe(expectedKind)
      expect(typeof result.title).toBe("string")
      expect(result.title.length).toBeGreaterThan(0)
      expect(Array.isArray(result.lines)).toBe(true)
    })
  }
})
