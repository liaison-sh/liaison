// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deep-week-sim meta-ads harness — server-side Meta Graph API v25.0 mock.
//
// THE ads app is a REAL bundled app (bundled-apps/ads). This mock
// stands in ONLY for the external Meta Graph boundary (`graph.facebook.com`) —
// never for the bundle capability itself. It lets the meta-ads chaos scenarios
// drive the real read/write/pause/insights tools end-to-end (account_info →
// insights → digest; gated create chain; ungated pause GET→POST→GET) against a
// deterministic offline book, with no creds and no network.
//
// Why a host-intercept mock (not a loopback HTTP mock the bundle fetches
// directly): the sandbox-fetch bridge (`rpc-bridge.ts:1659`) short-circuits to
// `sandboxEgressOverrides.fetch` when `sandboxEgressOverrides.fetchInterceptsHost(hostname)` claims the
// host, BEFORE the bundle's `graph.facebook.com` domain pin. Intercepting the
// canonical Graph host (exactly as the social/pennylane/boxtal mocks do) keeps
// the entire production read/write path real while making the upstream book
// deterministic.
//
// Modeled 1:1 on social-mock-fetch.ts:
//   * matches on hostname (`graph.facebook.com`), returns canned Graph JSON.
//   * delegates to the REAL `fetch` for every other host (so the shopify /
//     boxtal / pennylane suites on the same spawned server are untouched).
//   * records every request `{ url, method, headers, body, actor }`.
//   * a mutable per-server-process state holds the per-scenario currency + the
//     failure-arm lever; the per-object STATUS map is stateful (GET→POST→GET
//     pause confirm), so meta-ads scenarios run serially within a worker (the
//     default for the chaos runner).

// — recorder —

export interface MetaMockRecord {
  url: string
  method: string
  /** Lowercased header map (Bun normalizes header names to lowercase). */
  headers: Record<string, string>
  /** Actor marker the bridge injects when LIAISON_TEST_INJECT_ACTOR=1. */
  actor: string | null
  body: string | null
  receivedAt: number
}

const records: MetaMockRecord[] = []

export function metaMockAllRequests(): MetaMockRecord[] {
  return [...records]
}

// — mutable per-scenario state —

interface MetaMockState {
  /** Force the next response HTTP status (default 0 = clean 2xx). */
  forceStatus: number
  /** Body to return when forceStatus is set (e.g. a 613+subcode-1487632 envelope). */
  forceErrorBody: string | null
  /** Account currency surfaced by account_info + every money field (default EUR). */
  accountCurrency: string
}

const state: MetaMockState = {
  forceStatus: 0,
  forceErrorBody: null,
  accountCurrency: "EUR",
}

export function setMetaMockMode(patch: {
  forceStatus?: number
  forceErrorBody?: string
  accountCurrency?: string
}): void {
  if (patch.forceStatus !== undefined) state.forceStatus = patch.forceStatus
  if (patch.forceErrorBody !== undefined) state.forceErrorBody = patch.forceErrorBody
  if (patch.accountCurrency !== undefined) state.accountCurrency = patch.accountCurrency
}

export function resetMetaMockState(): void {
  state.forceStatus = 0
  state.forceErrorBody = null
  state.accountCurrency = "EUR"
  records.length = 0
  statusMap.clear()
  createdCampaigns.length = 0
  createdAdsets.length = 0
  createdAds.length = 0
}

// Created-object registries — a POST that creates a campaign/adset/ad appends a
// minimal row here so a SUBSEQUENT list edge reflects it (the agent often
// re-lists after a gated create to confirm; a static list that omits the new
// object confuses the agent into thinking the create failed). Reset per scenario.
const createdCampaigns: Array<Record<string, unknown>> = []
const createdAdsets: Array<Record<string, unknown>> = []
const createdAds: Array<Record<string, unknown>> = []

// — stateful per-object status map (pause GET→POST→GET confirm) —
//
// Every seeded campaign/adset/ad starts ACTIVE; a POST status=PAUSED flips the
// id to PAUSED so the pause handler's confirm-GET (call 3) reads the real paused
// state, and call-1's pre-GET (before any POST) reads ACTIVE. A POST status=ACTIVE
// (set_status resume) flips it back. The map is lazily populated: an id not yet
// seen defaults to ACTIVE on first read.

interface ObjStatus {
  status: string
  effective_status: string
}
const statusMap = new Map<string, ObjStatus>()

/** Classify an object id by its prefix so the confirm-GET returns the right
 *  paused effective_status (campaign vs adset/ad). */
function pausedEffectiveStatus(objectId: string): string {
  if (objectId.startsWith("camp")) return "CAMPAIGN_PAUSED"
  if (objectId.startsWith("adset")) return "ADSET_PAUSED"
  return "PAUSED"
}

function getObjStatus(objectId: string): ObjStatus {
  let cur = statusMap.get(objectId)
  if (!cur) {
    cur = { status: "ACTIVE", effective_status: "ACTIVE" }
    statusMap.set(objectId, cur)
  }
  return cur
}

/** Resolve a seeded/created object's display name (for the pause pre-read, which
 *  asks for `name` so the agent can enumerate paused objects BY NAME). Falls back
 *  to the id when the object is unknown. */
function getObjName(objectId: string): string {
  const all: Array<{ id: string; name?: string }> = [
    ...CAMPAIGNS,
    ...ADSETS,
    ...ADS,
    ...(createdCampaigns as Array<{ id: string; name?: string }>),
    ...(createdAdsets as Array<{ id: string; name?: string }>),
    ...(createdAds as Array<{ id: string; name?: string }>),
  ]
  return all.find((o) => o.id === objectId)?.name ?? objectId
}

// Synthesized values for the exotic Graph fields/edges the typed tools don't
// wrap (the graph_get escape-hatch witness reaches these): delivery_estimate,
// recommendations, issues_info. Returns `undefined` for a non-exotic field so
// the caller leaves it alone. Keyed loosely so both the field-selector form
// (`?fields=delivery_estimate{...}`) and the edge form (`/{id}/delivery_estimate`)
// resolve.
function exoticFieldValue(field: string): unknown {
  const f = field.toLowerCase()
  if (f.includes("delivery_estimate")) {
    return {
      estimate_dau: 12000,
      estimate_mau_lower_bound: 800000,
      estimate_mau_upper_bound: 950000,
      estimate_ready: true,
    }
  }
  if (f.includes("recommendation")) {
    return [
      { code: 1772331, title: "Add more creatives", confidence: "HIGH" },
      { code: 1591956, title: "Broaden your audience", confidence: "MEDIUM" },
    ]
  }
  if (f.includes("issues_info")) {
    return [{ level: "AD", error_code: 1815869, error_summary: "Ad is in review" }]
  }
  return undefined
}

// — host matching + install gate —

/** The single host the meta-client pins (`GRAPH = "https://graph.facebook.com/v25.0"`). */
export function metaMockHandlesHost(hostname: string): boolean {
  return hostname === "graph.facebook.com"
}

/**
 * Default-on deterministic mock; `META_E2E_LIVE === "1"` opts into live creds
 * (a future smoke). Mirrors shouldInstallShopifyMock/shouldInstallBoxtalMock.
 */
export function shouldInstallMetaMock(
  env: { META_E2E_LIVE?: string | undefined; [key: string]: string | undefined } = process.env,
): boolean {
  return env.META_E2E_LIVE !== "1"
}

// — seeded fixture book (HTTP responses, not DB rows) —
//
// One consistent ad account `act_FIXTURE` with 5 campaigns (spend spread so
// top/bottom-3 is unambiguous), ad sets, ads, insights, targeting, media,
// audiences, pages. `adset_RAL44` is a paused-adset fixture. Money fields are
// major-unit decimal STRINGS in `state.accountCurrency` (the read path
// parse-only-never-rescales; the fixture currency is per-scenario).

const CAMPAIGNS = [
  // One ACTIVE-but-not-delivering (the effective_status-honesty fixture).
  {
    id: "camp_RAL44",
    name: "RAL-44 Launch",
    status: "ACTIVE",
    effective_status: "CAMPAIGN_PAUSED",
    objective: "OUTCOME_SALES",
    daily_budget: "5000",
  },
  {
    id: "camp_dealer_eu",
    name: "EU Dealer Awareness",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    objective: "OUTCOME_AWARENESS",
    daily_budget: "4000",
  },
  {
    id: "camp_retarget",
    name: "Retargeting — Cart",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    objective: "OUTCOME_SALES",
    daily_budget: "3000",
  },
  {
    id: "camp_brand",
    name: "Brand — Always-On",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    objective: "OUTCOME_AWARENESS",
    daily_budget: "2000",
  },
  {
    id: "camp_prospect",
    name: "Q3 Prospecting",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    objective: "OUTCOME_TRAFFIC",
    daily_budget: "6000",
  },
] as const

// Per-campaign weekly insights — deterministic spend so a top/bottom-3 ranking
// AND a blended-ROAS division are gradeable. Spend descending: prospect >
// retarget > dealer_eu > brand > RAL44.
const CAMPAIGN_INSIGHTS: Array<{
  campaign_id: string
  campaign_name: string
  spend: string
  impressions: string
  clicks: string
  ctr: string
  cpc: string
  cpm: string
  reach: string
  frequency: string
}> = [
  {
    campaign_id: "camp_prospect",
    campaign_name: "Q3 Prospecting",
    spend: "1820.40",
    impressions: "412000",
    clicks: "6100",
    ctr: "1.48",
    cpc: "0.30",
    cpm: "4.42",
    reach: "210000",
    frequency: "1.96",
  },
  {
    campaign_id: "camp_retarget",
    campaign_name: "Retargeting — Cart",
    spend: "940.10",
    impressions: "98000",
    clicks: "3400",
    ctr: "3.47",
    cpc: "0.28",
    cpm: "9.59",
    reach: "41000",
    frequency: "2.39",
  },
  {
    campaign_id: "camp_dealer_eu",
    campaign_name: "EU Dealer Awareness",
    spend: "610.00",
    impressions: "230000",
    clicks: "1200",
    ctr: "0.52",
    cpc: "0.51",
    cpm: "2.65",
    reach: "150000",
    frequency: "1.53",
  },
  {
    campaign_id: "camp_brand",
    campaign_name: "Brand — Always-On",
    spend: "300.00",
    impressions: "180000",
    clicks: "540",
    ctr: "0.30",
    cpc: "0.56",
    cpm: "1.67",
    reach: "120000",
    frequency: "1.50",
  },
  {
    campaign_id: "camp_RAL44",
    campaign_name: "RAL-44 Launch",
    spend: "120.30",
    impressions: "8000",
    clicks: "90",
    ctr: "1.13",
    cpc: "1.34",
    cpm: "15.04",
    reach: "6500",
    frequency: "1.23",
  },
]

// Account-level insights total (sum of the per-campaign rows above).
const ACCOUNT_INSIGHTS = {
  spend: "3790.80",
  impressions: "928000",
  clicks: "11330",
  ctr: "1.22",
  cpc: "0.33",
  cpm: "4.08",
  reach: "510000",
  frequency: "1.82",
}

const ADSETS = [
  {
    id: "adset_RAL44",
    name: "RAL-44 — US West 18-24",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    campaign_id: "camp_RAL44",
    optimization_goal: "LINK_CLICKS",
    billing_event: "IMPRESSIONS",
    daily_budget: "3000",
    targeting: { geo_locations: { regions: [{ key: "3847" }] }, age_min: 18, age_max: 24 },
  },
  {
    id: "adset_dealer_eu",
    name: "EU Dealers — DE/FR",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    campaign_id: "camp_dealer_eu",
    optimization_goal: "REACH",
    billing_event: "IMPRESSIONS",
    daily_budget: "2000",
    targeting: { geo_locations: { countries: ["DE", "FR"] } },
  },
  {
    id: "adset_prospect_a",
    name: "Q3 Prospecting — Variant A",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    campaign_id: "camp_prospect",
    optimization_goal: "OFFSITE_CONVERSIONS",
    billing_event: "IMPRESSIONS",
    daily_budget: "3500",
    targeting: { geo_locations: { countries: ["US"] } },
  },
  {
    id: "adset_prospect_b",
    name: "Q3 Prospecting — Variant B",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    campaign_id: "camp_prospect",
    optimization_goal: "OFFSITE_CONVERSIONS",
    billing_event: "IMPRESSIONS",
    daily_budget: "2500",
    targeting: { geo_locations: { countries: ["US"] } },
  },
] as const

const ADS = [
  {
    id: "ad_RAL44",
    name: "RAL-44 Launch — Hero",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    adset_id: "adset_RAL44",
    campaign_id: "camp_RAL44",
    creative: { id: "creative_1" },
  },
  {
    id: "ad_dealer_eu",
    name: "EU Dealer — Reel",
    status: "ACTIVE",
    effective_status: "ACTIVE",
    adset_id: "adset_dealer_eu",
    campaign_id: "camp_dealer_eu",
    creative: { id: "creative_2" },
  },
] as const

// — response helpers —

type FetchInput = Parameters<typeof fetch>[0]
type FetchInit = Parameters<typeof fetch>[1]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** Parse a form-url-encoded POST body into a flat map (values are raw strings). */
function parseForm(body: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!body) return out
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=")
    if (eq < 0) continue
    const k = decodeURIComponent(pair.slice(0, eq))
    const v = decodeURIComponent(pair.slice(eq + 1))
    out[k] = v
  }
  return out
}

/** Stamp account_currency onto every insights row in the active currency. */
function withCurrency<T extends Record<string, unknown>>(row: T): T & { account_currency: string } {
  return { ...row, account_currency: state.accountCurrency }
}

const DATE_START = "2026-06-15"
const DATE_STOP = "2026-06-21"

function insightsRows(level: string): unknown[] {
  if (level === "campaign" || level === "adset" || level === "ad") {
    return CAMPAIGN_INSIGHTS.map((r) =>
      withCurrency({ ...r, date_start: DATE_START, date_stop: DATE_STOP }),
    )
  }
  return [withCurrency({ ...ACCOUNT_INSIGHTS, date_start: DATE_START, date_stop: DATE_STOP })]
}

/** Best-effort `level` param read from a GET query-string or a POST form body. */
function levelFrom(search: string, form: Record<string, string>): string {
  const qs = new URLSearchParams(search)
  return qs.get("level") ?? form.level ?? "account"
}

// — fetch impl —

export function makeMetaMockFetch(realFetch: typeof fetch = fetch): typeof fetch {
  return (async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url
    let host: string
    let path: string
    let search: string
    try {
      const parsed = new URL(url)
      host = parsed.hostname
      path = parsed.pathname
      search = parsed.search
    } catch {
      return realFetch(input, init)
    }

    if (!metaMockHandlesHost(host)) {
      return realFetch(input, init)
    }

    const method = (init?.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {}
    if (init?.headers) {
      const h = new Headers(init.headers)
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
    }
    const body = typeof init?.body === "string" ? init.body : null
    records.push({
      url,
      method,
      headers,
      actor: headers["x-liaison-actor"] ?? null,
      body,
      receivedAt: Date.now(),
    })

    // Failure-arm lever (e.g. force a 613/subcode-1487632 body for the rate-cap arm).
    if (state.forceStatus !== 0) {
      return jsonResponse(
        state.forceErrorBody
          ? JSON.parse(state.forceErrorBody)
          : { error: { message: "forced", code: state.forceStatus } },
        state.forceStatus,
      )
    }

    // The graph base is `/v25.0`; strip it to a bare path so the segment matching
    // below is version-agnostic.
    const p = path.replace(/^\/v\d+\.\d+/, "")
    // Social's post-backs (reply, DM, like) share this host. This mock is first
    // in the chain, so it used to answer them with its unhandled-path 404: every
    // approved Facebook post-back "failed" as gone and the social mock behind it
    // never saw (or recorded) the call. They are the social mock's to answer.
    if (
      method === "POST" &&
      (/\/comments$/.test(p) || /\/likes$/.test(p) || /^\/me\/messages$/.test(p))
    ) {
      return realFetch(input, init)
    }
    const form = method === "POST" ? parseForm(body) : {}
    // Segments of the bare path (no leading/trailing empties).
    const segs = p.split("/").filter(Boolean)
    const qs = new URLSearchParams(search)

    // ── Async insights report-run protocol ───────────────────────────────────
    // POST /act_*/insights with async=true → { report_run_id }
    if (method === "POST" && /\/act_[^/]+\/insights$/.test(p)) {
      return jsonResponse({ report_run_id: "rr_1" })
    }
    // GET /rr_1 → status (Job Completed on the FIRST poll)
    if (method === "GET" && /^\/rr_[^/]+$/.test(p)) {
      return jsonResponse({
        id: segs[0],
        async_status: "Job Completed",
        async_percent_completion: 100,
      })
    }
    // GET /rr_1/insights → results (paged; last page omits paging.next)
    if (method === "GET" && /^\/rr_[^/]+\/insights$/.test(p)) {
      // The async path is taken on no-date-preset OR daily time_increment; the
      // level lives in the ORIGINAL POST. We can't see it on the GET, so default
      // to per-campaign rows when the query asked for them, else account.
      const lvl = qs.get("level") ?? "account"
      return jsonResponse({ data: insightsRows(lvl), paging: {} })
    }

    // ── Sync insights GET /act_*/insights ────────────────────────────────────
    if (method === "GET" && /\/act_[^/]+\/insights$/.test(p)) {
      const lvl = levelFrom(search, form)
      return jsonResponse({
        data: insightsRows(lvl),
        paging: { cursors: { after: "c1" } },
      })
    }

    // ── List edges (campaigns/adsets/ads) — seeded fixtures + created objects ──
    // GET /act_*/campaigns
    if (method === "GET" && /\/act_[^/]+\/campaigns$/.test(p)) {
      // Overlay statusMap so a Pause/Resume → re-list reflects the updated status.
      const data = [...CAMPAIGNS, ...createdCampaigns].map((row) => {
        const cur = statusMap.get((row as { id: string }).id)
        if (!cur) return row
        return { ...row, status: cur.status, effective_status: cur.effective_status }
      })
      return jsonResponse({ data, paging: { cursors: { after: "c1" } } })
    }
    // GET /{campaign_id}/adsets and GET /act_*/adsets
    if (method === "GET" && /\/adsets$/.test(p)) {
      const parent = segs[segs.length - 2]
      const all = [...ADSETS, ...createdAdsets]
      const filtered = parent?.startsWith("camp")
        ? all.filter((a) => (a as { campaign_id?: string }).campaign_id === parent)
        : all
      // Overlay statusMap
      const data = filtered.map((row) => {
        const cur = statusMap.get((row as { id: string }).id)
        if (!cur) return row
        return { ...row, status: cur.status, effective_status: cur.effective_status }
      })
      return jsonResponse({ data, paging: { cursors: { after: "c1" } } })
    }
    // GET /{adset_id}/ads, /{campaign_id}/ads, /act_*/ads
    if (method === "GET" && /\/ads$/.test(p)) {
      const parent = segs[segs.length - 2]
      const all: Array<Record<string, unknown>> = [...ADS, ...createdAds]
      let filtered: Array<Record<string, unknown>> = all
      if (parent?.startsWith("adset"))
        filtered = all.filter((a) => (a as { adset_id?: string }).adset_id === parent)
      else if (parent?.startsWith("camp"))
        filtered = all.filter((a) => (a as { campaign_id?: string }).campaign_id === parent)
      // Overlay statusMap
      const data = filtered.map((row) => {
        const cur = statusMap.get(row.id as string)
        if (!cur) return row
        return { ...row, status: cur.status, effective_status: cur.effective_status }
      })
      return jsonResponse({ data, paging: { cursors: { after: "c1" } } })
    }

    // ── Targeting search ─────────────────────────────────────────────────────
    // GET /search?type=...
    if (method === "GET" && /^\/search$/.test(p)) {
      const type = qs.get("type") ?? ""
      if (type === "adgeolocation") {
        return jsonResponse({
          data: [
            {
              key: "3847",
              name: "California",
              type: "region",
              country_code: "US",
              country_name: "United States",
            },
            {
              key: "3924",
              name: "Oregon",
              type: "region",
              country_code: "US",
              country_name: "United States",
            },
            {
              key: "3961",
              name: "Washington",
              type: "region",
              country_code: "US",
              country_name: "United States",
            },
            {
              key: "3859",
              name: "Nevada",
              type: "region",
              country_code: "US",
              country_name: "United States",
            },
            {
              key: "3805",
              name: "Arizona",
              type: "region",
              country_code: "US",
              country_name: "United States",
            },
          ],
        })
      }
      if (type === "adinterest" || type === "adTargetingCategory") {
        return jsonResponse({
          data: [
            {
              id: "6003020834693",
              name: "Synthesizer",
              type: "interests",
              audience_size_lower_bound: 18000000,
              audience_size_upper_bound: 21000000,
            },
            {
              id: "6003277229371",
              name: "Music production",
              type: "interests",
              audience_size_lower_bound: 90000000,
              audience_size_upper_bound: 110000000,
            },
            {
              id: "6002991239659",
              name: "Electronic music",
              type: "interests",
              audience_size_lower_bound: 200000000,
              audience_size_upper_bound: 240000000,
            },
            {
              id: "6003130044117",
              name: "Fernwave Live",
              type: "interests",
              audience_size_lower_bound: 2000000,
              audience_size_upper_bound: 2400000,
            },
          ],
        })
      }
      return jsonResponse({ data: [] })
    }

    // ── Media ────────────────────────────────────────────────────────────────
    // GET /act_*/adimages
    if (method === "GET" && /\/act_[^/]+\/adimages$/.test(p)) {
      // creative_get step-3 uses ?hashes=["IMGHASH1"] and expects a keyed images object.
      // media_list uses the normal {data:[...]} branch.
      const hashesParam = qs.get("hashes")
      if (hashesParam) {
        // Return keyed by hash: { images: { IMGHASH1: { url, permalink_url } } }
        let hashes: string[] = []
        try {
          hashes = JSON.parse(hashesParam)
        } catch {
          hashes = [hashesParam]
        }
        const images: Record<string, { url: string; permalink_url: string }> = {}
        for (const h of hashes) {
          images[h] = {
            url: `https://example.com/meta-mock/${h}.jpg`,
            permalink_url: `https://www.facebook.com/photo/?fbid=${h}`,
          }
        }
        return jsonResponse({ images })
      }
      return jsonResponse({
        data: [
          { hash: "IMGHASH1", name: "hero-1.jpg", status: "ACTIVE", width: 1080, height: 1080 },
        ],
        paging: { cursors: { after: "c1" } },
      })
    }
    // POST /act_*/adimages (upload_image)
    if (method === "POST" && /\/act_[^/]+\/adimages$/.test(p)) {
      return jsonResponse({ images: { bytes: { hash: "IMGHASH_NEW" } } })
    }
    // GET /act_*/advideos
    if (method === "GET" && /\/act_[^/]+\/advideos$/.test(p)) {
      return jsonResponse({
        data: [
          {
            id: "vid_1",
            title: "Tessera II Demo Reel",
            description: "demo",
            length: 30,
            status: "ready",
          },
        ],
        paging: { cursors: { after: "c1" } },
      })
    }

    // ── Audiences ─────────────────────────────────────────────────────────────
    // GET /act_*/customaudiences
    if (method === "GET" && /\/act_[^/]+\/customaudiences$/.test(p)) {
      return jsonResponse({
        data: [
          {
            id: "aud_customers",
            name: "Dealers + Customers — email",
            subtype: "CUSTOMER_LIST",
            approximate_count: 4200,
            approximate_count_lower_bound: 4000,
            approximate_count_upper_bound: 5000,
            retention_days: 180,
            data_source: {
              type: "THIRD_PARTY_IMPORTER",
              sub_type: "TE_PARTNER_DATA_FILE_CUSTOM_AUDIENCE",
            },
            delivery_status: { code: 200, description: "Audience is ready" },
            operation_status: { code: 200, description: "Normal" },
          },
          {
            id: "aud_small",
            name: "Small Test Audience",
            subtype: "WEBSITE",
            approximate_count_lower_bound: -1,
            approximate_count_upper_bound: -1,
            retention_days: 30,
            delivery_status: { code: 400, description: "Not deliverable" },
            operation_status: { code: 200, description: "Normal" },
          },
        ],
        paging: { cursors: { after: "c1" } },
      })
    }
    // POST /act_*/customaudiences (create_custom_audience / lookalike)
    if (method === "POST" && /\/act_[^/]+\/customaudiences$/.test(p)) {
      return jsonResponse({ id: "aud_new" })
    }
    // POST /{audience_id}/users (add_users)
    if (method === "POST" && /^\/aud_[^/]+\/users$/.test(p)) {
      return jsonResponse({ audience_id: segs[0], num_received: 4200, num_invalid_entries: 0 })
    }

    // ── Pages ─────────────────────────────────────────────────────────────────
    // GET /me/accounts (NEVER surface an access_token)
    if (method === "GET" && /^\/me\/accounts$/.test(p)) {
      return jsonResponse({
        data: [{ id: "page_1", name: "Resonant Audio Labs", category: "Musical Instrument Store" }],
      })
    }
    // GET /me/adaccounts (the agent sometimes reaches for this via graph_get to
    // enumerate ad accounts) — return the fixture account.
    if (method === "GET" && /^\/me\/adaccounts$/.test(p)) {
      return jsonResponse({
        data: [
          {
            id: "act_FIXTURE",
            account_id: "FIXTURE",
            name: "Resonant Audio Labs — Meta Ads",
            currency: state.accountCurrency,
            account_status: 1,
          },
        ],
      })
    }

    // ── Gated create edges ─────────────────────────────────────────────────────
    // Each create appends a minimal row to the created-object registry so a
    // subsequent list edge reflects it (a unique id per create so an A/B chain
    // that creates two ads gets two distinct ids).
    if (method === "POST" && /\/act_[^/]+\/campaigns$/.test(p)) {
      // Meta returns HTTP 400 when special_ad_categories is absent from the POST
      // body — even an empty [] must be sent explicitly. Mirror that here so a weak
      // model that omits the param gets the same corrective error the real Graph API
      // emits (a silent default would let bad data sail through to approval).
      if (!("special_ad_categories" in form)) {
        return jsonResponse(
          {
            error: {
              message:
                "(#100) special_ad_categories is required. Pass [] when the campaign is not in a special ad category (EMPLOYMENT, CREDIT, HOUSING).",
              type: "OAuthException",
              code: 100,
              error_subcode: 1487329,
              fbtrace_id: "metamock_special_ad_categories",
            },
          },
          400,
        )
      }
      const id = `camp_new_${createdCampaigns.length + 1}`
      createdCampaigns.push({
        id,
        name: form.name ?? "New Campaign",
        status: form.status ?? "PAUSED",
        effective_status: "CAMPAIGN_PAUSED",
        objective: form.objective ?? "OUTCOME_TRAFFIC",
        daily_budget: form.daily_budget ?? null,
      })
      return jsonResponse({ id })
    }
    if (method === "POST" && /\/act_[^/]+\/adsets$/.test(p)) {
      const id = `adset_new_${createdAdsets.length + 1}`
      createdAdsets.push({
        id,
        name: form.name ?? "New Ad Set",
        status: form.status ?? "PAUSED",
        effective_status: "ADSET_PAUSED",
        campaign_id: form.campaign_id ?? null,
        daily_budget: form.daily_budget ?? null,
      })
      return jsonResponse({ id })
    }
    if (method === "POST" && /\/act_[^/]+\/ads$/.test(p)) {
      const id = `ad_new_${createdAds.length + 1}`
      createdAds.push({
        id,
        name: form.name ?? "New Ad",
        status: form.status ?? "PAUSED",
        effective_status: "ADSET_PAUSED",
        adset_id: form.adset_id ?? null,
      })
      return jsonResponse({ id })
    }
    if (method === "POST" && /\/act_[^/]+\/adcreatives$/.test(p)) {
      return jsonResponse({ id: "creative_new" })
    }

    // ── Per-object POST dispatch (pause / set_status / update_budget) ──────────
    // POST /{objectId} — same path, different actions by body.
    if (
      method === "POST" &&
      segs.length === 1 &&
      !segs[0]!.startsWith("act_") &&
      !segs[0]!.startsWith("rr_")
    ) {
      const objectId = segs[0]!
      const status = form.status
      if (status === "PAUSED") {
        statusMap.set(objectId, {
          status: "PAUSED",
          effective_status: pausedEffectiveStatus(objectId),
        })
        return jsonResponse({ id: objectId, success: true })
      }
      if (status === "ACTIVE") {
        statusMap.set(objectId, { status: "ACTIVE", effective_status: "ACTIVE" })
        return jsonResponse({ id: objectId, status: "ACTIVE", success: true })
      }
      // update_budget (daily_budget / lifetime_budget) — no status flip.
      return jsonResponse({ id: objectId, success: true })
    }

    // ── Account info GET /act_* ────────────────────────────────────────────────
    if (method === "GET" && /^\/act_[^/]+$/.test(p)) {
      return jsonResponse({
        id: segs[0],
        name: "Resonant Audio Labs — Meta Ads",
        currency: state.accountCurrency,
        timezone_name: "Europe/Paris",
        spend_cap: "500000",
        account_status: 1,
        business: { id: "biz_1", name: "Resonant Audio Labs" },
        pixel_id: "pixel_1",
      })
    }

    // ── Ad previews GET /{ad_id}/previews ─────────────────────────────────────
    if (method === "GET" && segs.length === 2 && segs[1] === "previews") {
      const adId = segs[0]!
      const adFormats = qs.get("ad_format")
        ? [qs.get("ad_format")!]
        : ["DESKTOP_FEED_STANDARD", "MOBILE_FEED_STANDARD", "INSTAGRAM_STANDARD", "INSTAGRAM_STORY"]
      return jsonResponse({
        data: adFormats.map((fmt) => ({
          body: `<iframe src="https://www.facebook.com/ads/preview/mock/${adId}/${fmt.toLowerCase()}" width="300" height="250" scrolling="no" style="border:none"></iframe>`,
          width: 300,
          height: 250,
        })),
        paging: {},
      })
    }

    // ── graph_get EDGE form GET /{objectId}/{edge} (e.g. delivery_estimate) ───
    // The escape-hatch witness asks for the delivery/reach estimate; the agent
    // may reach it as an EDGE (/{adset}/delivery_estimate) or a FIELD selector
    // (?fields=delivery_estimate{...}). Serve both. recommendations/issues_info
    // are the other exotic edges the diagnosis scenarios reach.
    if (
      method === "GET" &&
      segs.length === 2 &&
      !segs[0]!.startsWith("act_") &&
      !segs[0]!.startsWith("rr_")
    ) {
      const edge = segs[1]!
      const exotic = exoticFieldValue(edge)
      if (exotic !== undefined)
        return jsonResponse({ data: Array.isArray(exotic) ? exotic : [exotic] })
      // Unknown edge — empty page (let the agent fall back / report honestly).
      return jsonResponse({ data: [], paging: {} })
    }

    // ── Creative detail GET /{creative_id}?fields=... ────────────────────────
    if (method === "GET" && segs.length === 1 && segs[0]!.startsWith("creative_")) {
      const creativeId = segs[0]!
      return jsonResponse({
        id: creativeId,
        thumbnail_url: "https://example.com/meta-mock/thumbnail.jpg",
        image_hash: "IMGHASH1",
        object_story_spec: {
          link_data: {
            image_hash: "IMGHASH1",
            message: "Discover the Tessera II",
            link: "https://fabrikam.example/tessera-ii",
            name: "Tessera II — Now Available",
            description: "The most advanced musical surface. Shop now.",
          },
        },
        object_type: "SHARE",
        name: "Tessera II Creative",
        status: "ACTIVE",
        effective_object_story_id: `page_1_${creativeId}`,
      })
    }

    // ── Per-object status GET /{objectId}?fields=id,status,effective_status ────
    // (pause/set_status pre-read + confirm-read; graph_get escape hatch).
    if (
      method === "GET" &&
      segs.length === 1 &&
      !segs[0]!.startsWith("act_") &&
      !segs[0]!.startsWith("rr_")
    ) {
      const objectId = segs[0]!
      const fields = qs.get("fields") ?? ""
      if (fields.includes("status") && fields.includes("effective_status")) {
        const cur = getObjStatus(objectId)
        // Include `name` when requested (pause pre-read asks for it so the agent
        // can enumerate paused objects BY NAME in its reply).
        const base: Record<string, unknown> = {
          id: objectId,
          status: cur.status,
          effective_status: cur.effective_status,
        }
        if (fields.includes("name")) base.name = getObjName(objectId)
        return jsonResponse(base)
      }
      // graph_get generic field-echo on a known object — start from the known row
      // (or a thin object) and MERGE IN any exotic requested fields
      // (delivery_estimate{...}, recommendations, issues_info) with synthesized
      // values, so a graph_get for a field the typed tools don't wrap returns real
      // values instead of silently dropping the field.
      const known =
        ADSETS.find((a) => a.id === objectId) ??
        CAMPAIGNS.find((c) => c.id === objectId) ??
        (ADS as unknown as Array<Record<string, unknown>>).find((a) => a.id === objectId)
      const base: Record<string, unknown> = known
        ? { ...known }
        : { id: objectId, name: "Fixture object", daily_budget: "3000" }
      // Parse the requested top-level field names (strip any `{...}` subselector).
      const requested = fields
        .split(",")
        .map((f) =>
          f
            .trim()
            .replace(/\{[\s\S]*$/, "")
            .trim(),
        )
        .filter(Boolean)
      for (const fld of requested) {
        const v = exoticFieldValue(fld)
        if (v !== undefined) base[fld] = v
        // Echo the field from the known object if it exists (e.g. "creative" from an ad row)
        else if (known && fld in known) base[fld] = (known as Record<string, unknown>)[fld]
      }
      // If no fields were requested at all and it's an unknown object, include a
      // delivery_estimate so a bare graph_get still returns something useful.
      if (!known && requested.length === 0) {
        base.delivery_estimate = exoticFieldValue("delivery_estimate")
      }
      return jsonResponse(base)
    }

    // ── Account-level graph_get field-echo GET /act_*?fields=... ──────────────
    // (already handled by the /act_* account_info above — that returns the full
    //  account subset, which is the right behavior for a graph_get on the account.)

    // Unhandled Graph path — 404 with an inspectable body (fail loud, never a
    // silent empty page that the agent might fabricate around).
    return jsonResponse({ error: { message: `meta-mock: unhandled ${method} ${p}`, code: 0 } }, 404)
  }) as typeof fetch
}
