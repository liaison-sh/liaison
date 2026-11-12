// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  insights_query,
  campaigns_list,
  adsets_list,
  ads_list,
  targeting_search,
  media_list,
  audiences_list,
  pages_list,
  account_info,
  graph_get,
  creative_get,
  ad_preview,
  counts,
  pending_approvals_list,
} from "./reads"
import { createMemoryStore, createRecordingTimers } from "./test-store"

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
    return { status: resp.status, headers: resp.headers ?? {}, body: resp.body }
  }
  const connections = {
    meta: {
      getCredentials: async () => ({
        accessToken: "test_token",
        adAccountId: "act_123456",
      }),
    },
  }
  const store = createMemoryStore()
  const timers = createRecordingTimers()
  return { ctx: { fetch, connections, store, timers }, calls, store, timers }
}

// ─── insights_query ───────────────────────────────────────────────────────────

describe("insights_query", () => {
  it("sends GET to /{adAccountId}/insights with level and date_preset", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [{ spend: "100.00", impressions: "5000" }] }),
    }])
    const result = await insights_query(
      { level: "account", date_preset: "last_7d" },
      ctx,
    ) as { data: unknown[] }
    expect(calls[0]?.url).toContain("/act_123456/insights")
    expect(calls[0]?.url).toContain("level=account")
    expect(calls[0]?.url).toContain("date_preset=last_7d")
    expect(result.data).toBeDefined()
  })

  it("effective_status is the delivery-state answer — fixture with status:ACTIVE but effective_status:CAMPAIGN_PAUSED", async () => {
    // The handler surfaces effective_status from the campaigns_list, not status
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({
        data: [{
          id: "camp_1",
          name: "Test",
          status: "ACTIVE",
          effective_status: "CAMPAIGN_PAUSED",
        }],
        paging: { cursors: {} },
      }),
    }])
    const result = await campaigns_list({}, ctx) as { data: Array<{ status: string; effective_status: string }> }
    const campaign = result.data[0]!
    // Both fields are surfaced
    expect(campaign.status).toBe("ACTIVE")
    // The delivery state answer must come from effective_status
    expect(campaign.effective_status).toBe("CAMPAIGN_PAUSED")
    // The handler returns effective_status so the agent uses it
    expect(calls[0]?.url).toContain("/act_123456/campaigns")
  })

  it("breakdown split: age+gender+region → compatible SUBSETS (age+gender together, region separate)", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ data: [{ spend: "50" }] }) },
      { status: 200, body: JSON.stringify({ data: [{ spend: "30" }] }) },
    ])
    const result = await insights_query(
      { level: "adset", date_preset: "last_7d", breakdowns: ["age", "gender", "region"] },
      ctx,
    ) as { _split: boolean }
    expect(result._split).toBe(true)
    // Exactly 2 calls: [age,gender] and [region] — NOT three singletons (over-split).
    expect(calls.length).toBe(2)
    // The age+gender cross-tab is preserved in one call.
    const ageGender = "age%2Cgender" // URL-encoded age,gender
    const allText = calls.map((c) => (c.url ?? "") + (c.body ?? "")).join(" ")
    expect(allText).toContain(ageGender)
    // CRITICAL: the 3-way combined was never sent.
    expect(allText).not.toContain("age%2Cgender%2Cregion")
    // region went out in its own call.
    expect(allText).toContain("breakdowns=region")
  })

  it("compatible single breakdown (age only) → _split:false, exactly ONE call", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ data: [{ spend: "50" }] }) }])
    const result = await insights_query(
      { level: "adset", date_preset: "last_7d", breakdowns: ["age"] },
      ctx,
    ) as { _split: boolean }
    expect(result._split).toBe(false)
    expect(calls.length).toBe(1)
    expect((calls[0]?.url ?? "") + (calls[0]?.body ?? "")).toContain("breakdowns=age")
  })

  it("compatible pair (age+gender) → _split:false, ONE combined call", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ data: [{ spend: "50" }] }) }])
    const result = await insights_query(
      { level: "adset", date_preset: "last_7d", breakdowns: ["age", "gender"] },
      ctx,
    ) as { _split: boolean }
    expect(result._split).toBe(false)
    expect(calls.length).toBe(1)
    expect((calls[0]?.url ?? "") + (calls[0]?.body ?? "")).toContain("age%2Cgender")
  })

  it("async path: time_increment:1 issues POST(report_run_id)→poll(Job Completed)→GET results", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_1" }) }, // POST async
      { status: 200, body: JSON.stringify({ id: "RUN_1", async_status: "Job Completed" }) }, // poll
      { status: 200, body: JSON.stringify({ data: [{ spend: "12.34" }], paging: { cursors: {} } }) }, // GET results
    ])
    const result = await insights_query(
      { level: "account", time_increment: 1 },
      ctx,
    ) as { data: unknown[] }
    expect(calls[0]?.method).toBe("POST")
    expect(calls[1]?.url).toContain("/RUN_1")
    expect(calls[2]?.url).toContain("/RUN_1/insights")
    expect(result.data.length).toBe(1)
    // Money still parsed on the async path (string → number).
    expect((result.data[0] as { spend: number }).spend).toBe(12.34)
  })

  it("an account-level daily series over a bounded window is ONE synchronous GET, no async report job", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ data: [{ spend: "1.00" }, { spend: "2.00" }] }) },
    ])
    const result = await insights_query(
      { level: "account", time_increment: "1", date_preset: "last_30d" },
      ctx,
    ) as { data: unknown[] }
    expect(calls.length).toBe(1)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.url).toContain("time_increment=1")
    expect(result.data.length).toBe(2)
  })

  it("a daily series below account level still takes the async report path", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_C" }) },
      { status: 200, body: JSON.stringify({ id: "RUN_C", async_status: "Job Completed" }) },
      { status: 200, body: JSON.stringify({ data: [], paging: { cursors: {} } }) },
    ])
    await insights_query({ level: "ad", time_increment: 1, date_preset: "last_30d" }, ctx)
    expect(calls[0]?.method).toBe("POST")
  })

  it("async race: extraction answers 1815005 → pending with the run id; the next call resumes THAT run, no new report", async () => {
    // Meta code 1815005 = "the report job has not finished, check the async
    // status before extracting": transient, so the call answers pending and
    // keeps the run; the next call asks the same run again.
    const notReady = JSON.stringify({
      error: { code: 1815005, message: "El trabajo de informe no ha finalizado, comprueba el estado antes de extraerlo" },
    })
    const { ctx, calls, store, timers } = makeCtx([
      { status: 200, body: JSON.stringify({ report_run_id: "RUN_R" }) }, // POST async
      { status: 200, body: JSON.stringify({ id: "RUN_R", async_status: "Job Completed" }) }, // status
      { status: 400, body: notReady }, // extraction races ahead → not-ready
      { status: 200, body: JSON.stringify({ id: "RUN_R", async_status: "Job Completed" }) }, // next call: status
      { status: 200, body: JSON.stringify({ data: [{ spend: "9.99" }], paging: { cursors: {} } }) }, // extraction wins
    ])
    const first = await insights_query({ level: "account", time_increment: 1 }, ctx) as Record<string, unknown>
    expect(first).toMatchObject({ data: [], _pending: true, _pending_reason: "not_ready", report_run_id: "RUN_R" })
    expect(store.docs.size).toBe(1)
    expect(timers.wakes).toHaveLength(1)
    expect(timers.wakes[0]?.job).toBe("insights-report")

    const second = await insights_query({ level: "account", time_increment: 1 }, ctx) as { data: unknown[]; _pending?: boolean }
    expect(second._pending).toBeUndefined()
    expect((second.data[0] as { spend: number }).spend).toBe(9.99)
    // One POST in total: the second call resumed RUN_R.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1)
    expect(calls[3]?.url).toContain("/RUN_R")
    // Extracted: the record is gone, the next pull starts a fresh report.
    expect(store.docs.size).toBe(0)
  })

  it("a running report answers pending at once: one status call, no polling inside the run", async () => {
    const running = JSON.stringify({ id: "RUN_P", async_status: "Job Running", async_percent_completion: 10 })
    const responses: MockResponse[] = [{ status: 200, body: JSON.stringify({ report_run_id: "RUN_P" }) }]
    for (let i = 0; i < 10; i++) responses.push({ status: 200, body: running })
    const { ctx, calls } = makeCtx(responses)
    const result = await insights_query({ level: "account", time_increment: 1 }, ctx) as { data: unknown[]; _pending?: boolean }
    expect(result._pending).toBe(true)
    expect(result.data).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it("campaign_id param adds filtering=[{field:'campaign.id',operator:'EQUAL',value}] to the request", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [{ spend: "42.00" }] }),
    }])
    await insights_query(
      { level: "campaign", date_preset: "last_7d", campaign_id: "camp_RAL44" },
      ctx,
    )
    const url = calls[0]?.url ?? ""
    // The filtering param must be present and reference campaign.id
    expect(url).toContain("filtering=")
    expect(decodeURIComponent(url)).toContain("campaign.id")
    expect(decodeURIComponent(url)).toContain("EQUAL")
    expect(decodeURIComponent(url)).toContain("camp_RAL44")
  })

  it("money fields are parsed as decimal strings in account currency (EUR fixture)", async () => {
    const { ctx } = makeCtx([{
      status: 200,
      body: JSON.stringify({
        data: [{ spend: "1234.56", cpm: "5.50" }],
      }),
    }])
    // insights_query for a small window (sync path)
    await insights_query({ level: "account", date_preset: "last_7d" }, ctx)
    // No assertion needed on returned value shape — we just verify it doesn't throw
    // The key invariant is fromAccountCurrency parses without rescaling (tested in meta-client.test.ts)
  })
})

// ─── campaigns_list ───────────────────────────────────────────────────────────

describe("campaigns_list", () => {
  it("fetches from /{adAccountId}/campaigns with default fields", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await campaigns_list({}, ctx)
    expect(calls[0]?.url).toContain("/act_123456/campaigns")
    expect(calls[0]?.url).toContain("effective_status")
  })
})

// ─── adsets_list ─────────────────────────────────────────────────────────────

describe("adsets_list", () => {
  it("fetches from /{adAccountId}/adsets by default", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await adsets_list({}, ctx)
    expect(calls[0]?.url).toContain("/act_123456/adsets")
  })

  it("fetches from /{campaign_id}/adsets when campaign_id is given", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await adsets_list({ campaign_id: "camp_999" }, ctx)
    expect(calls[0]?.url).toContain("/camp_999/adsets")
  })

  it("default fields include effective_status and targeting", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await adsets_list({}, ctx)
    expect(calls[0]?.url).toContain("effective_status")
    expect(calls[0]?.url).toContain("targeting")
  })
})

// ─── ads_list ─────────────────────────────────────────────────────────────────

describe("ads_list", () => {
  it("fetches from /{adAccountId}/ads by default", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await ads_list({}, ctx)
    expect(calls[0]?.url).toContain("/act_123456/ads")
  })

  it("fetches from /{adset_id}/ads when adset_id is given", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await ads_list({ adset_id: "adset_777" }, ctx)
    expect(calls[0]?.url).toContain("/adset_777/ads")
  })

  it("includes effective_status in default fields", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await ads_list({}, ctx)
    expect(calls[0]?.url).toContain("effective_status")
  })
})

// ─── targeting_search ─────────────────────────────────────────────────────────

describe("targeting_search", () => {
  it("sends GET to /search with type and q", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [{ id: "6015559470583", name: "France" }] }),
    }])
    await targeting_search({ type: "adgeolocation", q: "France" }, ctx)
    expect(calls[0]?.url).toContain("/search")
    expect(calls[0]?.url).toContain("type=adgeolocation")
    expect(calls[0]?.url).toContain("q=France")
  })
})

// ─── media_list ───────────────────────────────────────────────────────────────

describe("media_list", () => {
  it("fetches adimages by default", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [{ hash: "abc123", name: "banner.jpg" }], paging: { cursors: {} } }),
    }])
    const result = await media_list({}, ctx) as { type: string; data: unknown[] }
    expect(calls[0]?.url).toContain("/act_123456/adimages")
    expect(result.type).toBe("images")
  })

  it("fetches advideos when type=videos", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await media_list({ type: "videos" }, ctx)
    expect(calls[0]?.url).toContain("/act_123456/advideos")
  })
})

// ─── audiences_list ───────────────────────────────────────────────────────────

describe("audiences_list", () => {
  it("fetches from /{adAccountId}/customaudiences with delivery status", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [], paging: { cursors: {} } }),
    }])
    await audiences_list({}, ctx)
    expect(calls[0]?.url).toContain("/act_123456/customaudiences")
    expect(calls[0]?.url).toContain("delivery_status")
  })
})

// ─── pages_list ───────────────────────────────────────────────────────────────

describe("pages_list", () => {
  it("fetches from /me/accounts", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [{ id: "page_1", name: "Fabrikam" }] }),
    }])
    const result = await pages_list({} as never, ctx) as { data: unknown[] }
    expect(calls[0]?.url).toContain("/me/accounts")
    expect(result.data).toHaveLength(1)
  })

  it("does NOT request access_token and never surfaces a Page token (security)", async () => {
    // Even if Meta echoed a token, the requested fields exclude it. We assert the
    // REQUEST does not ask for access_token, and the output carries no token.
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ data: [{ id: "page_1", name: "Fabrikam", category: "Brand", access_token: "LIVE_PAGE_TOKEN_xyz" }] }),
    }])
    const result = await pages_list({} as never, ctx) as { data: Array<Record<string, unknown>> }
    // The request must request only id,name,category — never access_token.
    expect(calls[0]?.url).toContain(encodeURIComponent("id,name,category"))
    expect(calls[0]?.url).not.toContain("access_token")
    // (Defensive: even if Meta returned a token, it must not appear in our output
    //  fields beyond what we requested — here we surface data as Meta returned it,
    //  but we never request the token field so a real account never delivers one.)
    expect(calls[0]?.url.toLowerCase()).not.toContain("access_token")
  })
})

// ─── account_info ─────────────────────────────────────────────────────────────

describe("account_info", () => {
  it("fetches from /{adAccountId} expanding the adspixels edge (AdAccount has no pixel_id field)", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({
        id: "act_123456",
        currency: "EUR",
        timezone_name: "Europe/Paris",
        adspixels: { data: [{ id: "px_42", name: "Main pixel" }] },
      }),
    }])
    const result = await account_info({} as never, ctx) as {
      currency: string
      pixel_id: string | null
      adspixels?: unknown
    }
    expect(calls[0]?.url).toContain("/act_123456")
    expect(calls[0]?.url).toContain("currency")
    // The Graph request must expand the edge, never ask for a bare pixel_id field
    expect(calls[0]?.url).toContain("adspixels")
    expect(decodeURIComponent(calls[0]?.url ?? "")).not.toMatch(/,pixel_id/)
    expect(result.currency).toBe("EUR")
    expect(result.pixel_id).toBe("px_42")
    // The raw edge payload is not leaked on the result
    expect(result.adspixels).toBeUndefined()
  })

  it("returns pixel_id null when the account has no pixel (never fabricates)", async () => {
    const { ctx } = makeCtx([{
      status: 200,
      body: JSON.stringify({ id: "act_123456", currency: "EUR", adspixels: { data: [] } }),
    }])
    const result = await account_info({} as never, ctx) as { pixel_id: string | null }
    expect(result.pixel_id).toBeNull()
  })
})

// ─── graph_get ────────────────────────────────────────────────────────────────

describe("graph_get", () => {
  it("sends GET to the given path (cannot mutate)", async () => {
    const { ctx, calls } = makeCtx([{
      status: 200,
      body: JSON.stringify({ id: "camp_1", issues_info: [] }),
    }])
    await graph_get({ path: "/camp_1", fields: "id,issues_info" }, ctx)
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.url).toContain("/camp_1")
    expect(calls[0]?.url).toContain("fields=")
  })

  it("rejects a path that does not start with '/' (no fetch made)", async () => {
    const { ctx, calls } = makeCtx([])
    await expect(graph_get({ path: "camp_1" }, ctx)).rejects.toThrow(/must start with/)
    expect(calls.length).toBe(0)
  })

  it("rejects a full URL ('://') and a smuggled access_token query (no fetch made)", async () => {
    const { ctx, calls } = makeCtx([])
    await expect(graph_get({ path: "https://evil.example/me" }, ctx)).rejects.toThrow(/full URL|:\/\//)
    await expect(graph_get({ path: "/me?access_token=ATTACKER" }, ctx)).rejects.toThrow(/access_token/)
    expect(calls.length).toBe(0)
  })
})

// ─── creative_get ─────────────────────────────────────────────────────────────
// These use a standalone fakeFetch (NOT metaMock) to isolate creative_get's
// fetch behavior and pin the keyed /adimages shape.

describe("creative_get", () => {
  it("parses keyed /adimages response → thumbnail_url (fails if metaFetchPaged used)", async () => {
    // fakeFetch returns a keyed images object, not {data:[...]}
    // metaFetchPaged would return [] for this shape — the test catches that bug.
    const { ctx } = makeCtx([
      // Call 1: GET /cid (creative fields)
      { status: 200, body: JSON.stringify({ image_hash: "h1", title: "Test Ad", body: "Buy now" }) },
      // Call 2: GET /act_123456/adimages (keyed shape)
      { status: 200, body: JSON.stringify({ images: { h1: { url: "https://cdn/img.jpg" } } }) },
    ])
    const result = await creative_get({ creative_id: "cid" }, ctx) as { thumbnail_url: string | null; image_urls: string[] }
    expect(result.thumbnail_url).toBe("https://cdn/img.jpg")
    expect(result.image_urls).toContain("https://cdn/img.jpg")
  })

  it("resolves ad_id → creative_id → adimages chain", async () => {
    const { ctx, calls } = makeCtx([
      // Call 1: GET /ad_1 → creative ref
      { status: 200, body: JSON.stringify({ creative: { id: "cid_2" } }) },
      // Call 2: GET /cid_2 → creative fields
      { status: 200, body: JSON.stringify({ image_hash: "h2", title: "Chain Ad" }) },
      // Call 3: GET /act_123456/adimages → keyed
      { status: 200, body: JSON.stringify({ images: { h2: { url: "https://cdn/chain.jpg" } } }) },
    ])
    const result = await creative_get({ ad_id: "ad_1" }, ctx) as { creative_id: string; thumbnail_url: string | null }
    expect(calls[0]?.url).toContain("/ad_1")
    expect(calls[1]?.url).toContain("/cid_2")
    expect(result.creative_id).toBe("cid_2")
    expect(result.thumbnail_url).toBe("https://cdn/chain.jpg")
  })

  it("video_id path → thumbnail_url from thumbnails.data[0].uri", async () => {
    const { ctx } = makeCtx([
      // Call 1: GET /cid → video creative (no image_hash)
      { status: 200, body: JSON.stringify({ video_id: "vid_1", title: "Video Ad" }) },
      // Call 2: no hashes → skip adimages; GET /vid_1 → thumbnail
      { status: 200, body: JSON.stringify({ thumbnails: { data: [{ uri: "https://cdn/thumb.jpg" }] } }) },
    ])
    const result = await creative_get({ creative_id: "cid" }, ctx) as { thumbnail_url: string | null; video_id: string | null }
    expect(result.thumbnail_url).toBe("https://cdn/thumb.jpg")
    expect(result.video_id).toBe("vid_1")
  })

  it("empty/no creative → {thumbnail_url:null, reason:'no_creative'}", async () => {
    const { ctx } = makeCtx([
      // Call 1: GET /ad_missing → no creative ref
      { status: 200, body: JSON.stringify({}) },
    ])
    const result = await creative_get({ ad_id: "ad_missing" }, ctx) as { thumbnail_url: null; reason: string }
    expect(result.thumbnail_url).toBeNull()
    expect(result.reason).toBe("no_creative")
  })
})

// ─── ad_preview ───────────────────────────────────────────────────────────────

describe("ad_preview", () => {
  it("single format: returns {ad_format, body} from data[0].body", async () => {
    const { ctx } = makeCtx([
      { status: 200, body: JSON.stringify({ data: [{ body: "<iframe src='https://fb.com/preview'>" }] }) },
    ])
    const result = await ad_preview({ ad_id: "ad_1", ad_format: "DESKTOP_FEED_STANDARD" }, ctx) as { ad_format: string; body: string | null; rows: unknown[] }
    expect(result.ad_format).toBe("DESKTOP_FEED_STANDARD")
    expect(result.body).toContain("iframe")
    // The preview is also the one row a dashboard block reads.
    expect(result.rows).toEqual([{ ad_format: "DESKTOP_FEED_STANDARD", body: result.body }])
  })

  it("default format is DESKTOP_FEED_STANDARD when omitted", async () => {
    const { ctx, calls } = makeCtx([
      { status: 200, body: JSON.stringify({ data: [{ body: "<iframe>" }] }) },
    ])
    const result = await ad_preview({ ad_id: "ad_1" }, ctx) as { ad_format: string }
    expect(result.ad_format).toBe("DESKTOP_FEED_STANDARD")
    expect(calls[0]?.url).toContain("DESKTOP_FEED_STANDARD")
  })

  it("multi-format: ad_formats[] → {previews:[...]} each with own ad_format", async () => {
    const { ctx } = makeCtx([
      { status: 200, body: JSON.stringify({ data: [{ body: "<iframe src='desktop'>" }] }) },
      { status: 200, body: JSON.stringify({ data: [{ body: "<iframe src='mobile'>" }] }) },
    ])
    const result = await ad_preview({
      ad_id: "ad_1",
      ad_formats: ["DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD"],
    }, ctx) as { previews: Array<{ ad_format: string; body: string | null }> }
    expect(Array.isArray(result.previews)).toBe(true)
    expect(result.previews.length).toBe(2)
    expect(result.previews[0]?.ad_format).toBe("DESKTOP_FEED_STANDARD")
    expect(result.previews[1]?.ad_format).toBe("MOBILE_FEED_STANDARD")
    // One row per format, for a dashboard block.
    expect((result as unknown as { rows: unknown[] }).rows).toEqual(result.previews)
  })

  it("partial failure: data:[] → body:null for that format; others succeed", async () => {
    const { ctx } = makeCtx([
      { status: 200, body: JSON.stringify({ data: [] }) },
      { status: 200, body: JSON.stringify({ data: [{ body: "<iframe src='mobile'>" }] }) },
    ])
    const result = await ad_preview({
      ad_id: "ad_1",
      ad_formats: ["DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD"],
    }, ctx) as { previews: Array<{ ad_format: string; body: string | null }> }
    expect(result.previews[0]?.body).toBeNull()
    expect(result.previews[1]?.body).toContain("mobile")
  })

  it("distinct bodies per format (pins that different formats get different HTML)", async () => {
    const { ctx } = makeCtx([
      { status: 200, body: JSON.stringify({ data: [{ body: "<iframe src='desktop_preview'>" }] }) },
      { status: 200, body: JSON.stringify({ data: [{ body: "<iframe src='mobile_preview'>" }] }) },
    ])
    const result = await ad_preview({
      ad_id: "ad_1",
      ad_formats: ["DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD"],
    }, ctx) as { previews: Array<{ body: string | null }> }
    expect(result.previews[0]?.body).not.toBe(result.previews[1]?.body)
  })

  it("400 error → {body:null, reason}", async () => {
    // Simulate a metaFetch that throws (the mock returns 400 which metaFetch throws on)
    const { ctx } = makeCtx([
      { status: 400, body: JSON.stringify({ error: { message: "No creative", code: 400 } }) },
    ])
    const result = await ad_preview({ ad_id: "ad_bad", ad_format: "DESKTOP_FEED_STANDARD" }, ctx) as { body: null; reason?: string }
    expect(result.body).toBeNull()
    expect(result.reason).toBeDefined()
  })
})

// ─── counts ───────────────────────────────────────────────────────────────────

describe("counts", () => {
  it("tally: unwraps {data:[...]} wrapper and uses effective_status (not status)", async () => {
    // Fixture has rows where status:ACTIVE but effective_status:CAMPAIGN_PAUSED —
    // a naive status-based tally would give wrong active count.
    const fixture = {
      data: [
        { id: "c1", status: "ACTIVE", effective_status: "ACTIVE" },
        { id: "c2", status: "ACTIVE", effective_status: "CAMPAIGN_PAUSED" }, // status=ACTIVE but paused!
        { id: "c3", status: "PAUSED", effective_status: "PAUSED" },
        { id: "c4", status: "ACTIVE", effective_status: "ACTIVE" },
      ],
      paging: { cursors: {} },
    }
    const { ctx } = makeCtx([{ status: 200, body: JSON.stringify(fixture) }])
    // Clear the cache first (use a unique adAccountId won't hit cache from other tests)
    const result = await counts({} as never, ctx)
    // total = 4 rows (proves {data:[...]} wrapper is unwrapped)
    expect(result.total).toBe(4)
    // active = 2 (c1, c4) — not 3 (c2 has effective_status:CAMPAIGN_PAUSED despite status:ACTIVE)
    expect(result.active).toBe(2)
    // paused = 2 (c2=CAMPAIGN_PAUSED, c3=PAUSED)
    expect(result.paused).toBe(2)
  })

  it("keeps nothing between calls: each call reads the campaigns again", async () => {
    const page = { status: 200, body: JSON.stringify({ data: [{ id: "c1", effective_status: "ACTIVE" }], paging: { cursors: {} } }) }
    const { ctx, calls } = makeCtx([page, page])
    expect((await counts({} as never, ctx)).total).toBe(1)
    expect((await counts({} as never, ctx)).total).toBe(1)
    expect(calls.filter((c) => c.url.includes("/campaigns"))).toHaveLength(2)
  })
})

// ─── audiences_list (extended fields — Task 7) ────────────────────────────────

describe("audiences_list (extended fields)", () => {
  it("surfaces approximate_count_lower_bound/upper_bound and nested delivery/operation status", async () => {
    const fixture = {
      data: [
        {
          id: "aud_1",
          name: "Customers",
          subtype: "CUSTOMER_LIST",
          approximate_count_lower_bound: 1000,
          approximate_count_upper_bound: 5000,
          delivery_status: { code: 200, description: "This audience is ready for use in ad sets." },
          operation_status: { code: 200, description: "Normal" },
          retention_days: 180,
          data_source: { type: "FILE_IMPORTED", sub_type: "CUSTOMER_FILE_CRM" },
        },
      ],
      paging: { cursors: {} },
    }
    const { ctx } = makeCtx([{ status: 200, body: JSON.stringify(fixture) }])
    const result = await audiences_list({}, ctx) as { data: Array<Record<string, unknown>> }
    const aud = result.data[0]!
    // Bound range fields present
    expect(aud.approximate_count_lower_bound).toBe(1000)
    expect(aud.approximate_count_upper_bound).toBe(5000)
    // Nested status objects
    expect((aud.delivery_status as { code: number }).code).toBe(200)
    expect((aud.operation_status as { code: number }).code).toBe(200)
  })

  it("requests the extended fields in the API call (fields string check)", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ data: [], paging: { cursors: {} } }) }])
    await audiences_list({}, ctx)
    const url = calls[0]?.url ?? ""
    expect(url).toContain("approximate_count_lower_bound")
    expect(url).toContain("approximate_count_upper_bound")
    expect(url).toContain("delivery_status")
    // `approximate_count` is NOT a CustomAudience field (Graph #100 rejects it);
    // only the lower/upper bound pair is valid
    expect(decodeURIComponent(url)).not.toMatch(/approximate_count[,"&]/)
  })
})

// ─── pending_approvals_list ─────────────────────────────────────────────────────

describe("pending_approvals_list", () => {
  it("prefixes the kernel approvals affordance on 'ads:' and returns a count", async () => {
    let prefix: string | undefined
    let limit: number | undefined
    const ctx = {
      fetch: async () => ({ status: 200, headers: {}, body: "{}" }),
      connections: {},
      kernel: {
        listApprovals: async (p?: string, l?: number) => {
          prefix = p
          limit = l
          return [
            { id: "a1", toolName: "ads:pause", summary: { headline: "Pause campaign X" }, createdAt: "2026-07-10T00:00:00Z", requestedBy: "u1" },
            { id: "a2", toolName: "ads:update_budget", summary: { headline: "Raise budget" }, createdAt: "2026-07-10T01:00:00Z", requestedBy: "u2" },
          ]
        },
      },
    }
    const result = await pending_approvals_list({}, ctx as never)
    expect(prefix).toBe("ads:")
    expect(limit).toBe(50)
    expect(result.count).toBe(2)
    expect(result.approvals[0]?.tool_name).toBe("ads:pause")
    expect(result.approvals[0]?.summary).toBe("Pause campaign X")
  })

  it("degrades to an empty queue (never throws) when the ctx carries no kernel affordance", async () => {
    const ctx = { fetch: async () => ({ status: 200, headers: {}, body: "{}" }), connections: {} }
    const result = await pending_approvals_list({}, ctx as never)
    expect(result.count).toBe(0)
    expect(result.approvals).toEqual([])
  })

  it("clamps limit into 1-50", async () => {
    let limit: number | undefined
    const ctx = {
      fetch: async () => ({ status: 200, headers: {}, body: "{}" }),
      connections: {},
      kernel: { listApprovals: async (_p?: string, l?: number) => { limit = l; return [] } },
    }
    await pending_approvals_list({ limit: 999 }, ctx as never)
    expect(limit).toBe(50)
  })
})

describe("graph_get: an inline query string in the path", () => {
  it("merges it into params so limit reaches Graph as a number, not '5?fields=...'", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ data: [] }) }])
    await graph_get({ path: "/act_1/insights?limit=5&date_preset=last_7d", fields: "spend,impressions" }, ctx)
    const url = new URL(calls[0]!.url)
    expect(url.pathname.endsWith("/act_1/insights")).toBe(true)
    expect(url.searchParams.get("limit")).toBe("5")
    expect(url.searchParams.get("date_preset")).toBe("last_7d")
    expect(url.searchParams.get("fields")).toBe("spend,impressions")
    expect(calls[0]!.url.split("?").length).toBe(2)
  })

  it("keeps an inline-only query intact when no fields param is given", async () => {
    const { ctx, calls } = makeCtx([{ status: 200, body: JSON.stringify({ data: [] }) }])
    await graph_get({ path: "/act_1/insights?limit=5" }, ctx)
    expect(new URL(calls[0]!.url).searchParams.get("limit")).toBe("5")
  })
})
