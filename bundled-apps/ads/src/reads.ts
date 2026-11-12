// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ungated read tools for the ads app. All handlers authored natively
// as (params, ctx) — the kernel convention.

import { metaFetch, metaFetchPage, metaFetchPaged, isInsightsPending, fromAccountCurrency, type InsightsPending } from "./lib/meta-client"
import { getMetaClient } from "./lib/get-client"
import { fetchInsightsReport, type InsightsReportCtx } from "./insights-report"

// ─── Shared ctx type for reads ────────────────────────────────────────────────

interface ReadCtx {
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
  connections: unknown
}

/** insights_query also keeps async report runs across calls (insights-report.ts). */
type InsightsCtx = ReadCtx & Pick<InsightsReportCtx, "store" | "timers">

// ─── Incompatible breakdown combinations ─────────────────────────────────────
// Meta restricts which breakdown dimensions can be combined in one call.
// Proactively split before calling — never combine and surface the 400 as "no data".
//
// The geo dimensions (region / country) cannot combine with the demographic
// pair (age / gender). But age+gender ARE compatible together, so we split into
// COMPATIBLE SUBSETS — keep age+gender as one call, put each geo dimension in its
// own call — rather than fragmenting into singletons (which over-fragments and
// loses the age×gender cross-tab the caller wanted).

const DEMOGRAPHIC_DIMS = new Set(["age", "gender"])
const GEO_DIMS = new Set(["region", "country"])

function splitBreakdowns(breakdowns: string[]): string[][] {
  if (!breakdowns || breakdowns.length <= 1) return [breakdowns]

  const demographics = breakdowns.filter((b) => DEMOGRAPHIC_DIMS.has(b))
  const geos = breakdowns.filter((b) => GEO_DIMS.has(b))
  const others = breakdowns.filter((b) => !DEMOGRAPHIC_DIMS.has(b) && !GEO_DIMS.has(b))

  // Incompatible iff a geo dim coexists with a demographic dim (or two geo dims).
  const hasConflict = (geos.length > 0 && demographics.length > 0) || geos.length > 1
  if (!hasConflict) return [breakdowns]

  const subsets: string[][] = []
  // Keep the demographic pair (+ any neutral 'others') together as one call.
  if (demographics.length > 0) subsets.push([...demographics, ...others])
  // Each geo dimension gets its own call (with neutral others if no demographics).
  for (const g of geos) subsets.push(demographics.length > 0 ? [g] : [g, ...others])
  // If there were ONLY conflicting geos (no demographics, no others), the above
  // already covers them; nothing else to add.
  return subsets
}

// ─── insights_query ───────────────────────────────────────────────────────────

interface InsightsQueryParams {
  level: "account" | "campaign" | "adset" | "ad"
  date_preset?: string
  time_range?: { since: string; until: string }
  breakdowns?: string[]
  time_increment?: string | number
  fields?: string[]
  /** Scope insights to a specific campaign (filters on campaign.id). */
  campaign_id?: string
  /** Account currency (from account_info) — surfaced in the result so consumers
   *  know what currency the money figures are in. Reads never rescale. */
  currency?: string
}

export async function insights_query(params: InsightsQueryParams, ctx: InsightsCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)

  const breakdowns = params.breakdowns ?? []
  const breakdownGroups = splitBreakdowns(breakdowns)
  const baseParams: Record<string, unknown> = {
    level: params.level,
    ...(params.date_preset ? { date_preset: params.date_preset } : {}),
    ...(params.time_range ? { time_range: params.time_range } : {}),
    ...(params.time_increment !== undefined ? { time_increment: params.time_increment } : {}),
    fields: (params.fields ?? ["spend", "impressions", "clicks", "cpm", "ctr"]).join(","),
    // Scope to a specific campaign when campaign_id is provided.
    ...(params.campaign_id
      ? { filtering: JSON.stringify([{ field: "campaign.id", operator: "EQUAL", value: params.campaign_id }]) }
      : {}),
  }

  // Proactively split incompatible breakdown combinations
  const results: unknown[] = []
  let pending: InsightsPending | null = null
  for (const group of breakdownGroups) {
    const callParams: Record<string, unknown> = { ...baseParams }
    if (group.length > 0) callParams.breakdowns = group.join(",")

    // Use the Meta async-report path only for pulls that are actually large:
    // a daily time_increment series, or an unbounded query (neither a preset
    // nor an explicit time_range). A plain time_range aggregate (e.g.
    // account-level spend for a week, what metrics_run sends) is one row per
    // breakdown group, read synchronously.
    //
    // An account-level daily series over a bounded window is one row per day
    // (the dashboard's 30 day chart is 30 rows): it goes synchronous too.
    const daily = params.time_increment === 1 || params.time_increment === "1"
    const bounded = Boolean(params.date_preset || params.time_range)
    const isLargePull =
      !bounded || (daily && (params.level !== "account" || group.length > 0))

    let data: unknown[]
    if (isLargePull) {
      // Started (or resumed) as a report run kept across calls; every group
      // starts its run now, so a later call finds them all under way.
      const asyncResult = await fetchInsightsReport(ctx, {
        path: `/${adAccountId}/insights`,
        params: callParams,
        accessToken,
      })
      if (isInsightsPending(asyncResult)) {
        pending ??= asyncResult
        continue
      }
      data = asyncResult
    } else {
      const result = await metaFetch(ctx.fetch, {
        path: `/${adAccountId}/insights`,
        method: "GET",
        params: callParams,
        accessToken,
      }) as { data?: unknown[] }
      data = result.data ?? []
    }

    // Parse money fields as decimal strings — Meta delivers money on reads as
    // major-unit decimal strings, so this is parse-only (never rescale). The
    // account currency is surfaced on the result, not used to rescale.
    for (const row of data) {
      if (typeof row === "object" && row !== null) {
        for (const key of ["spend", "cpm", "cpp", "cpc"] as const) {
          const r = row as Record<string, unknown>
          if (typeof r[key] === "string") {
            r[key] = fromAccountCurrency(r[key] as string)
          }
        }
      }
    }

    if (breakdownGroups.length > 1) {
      results.push({ breakdowns: group, data })
    } else {
      results.push(...data)
    }
  }

  // A report not extractable yet: a structured "data not ready yet" result the
  // UI renders inline, never a thrown 500. Calling again resumes the same run.
  if (pending) {
    return {
      data: [],
      _split: false,
      _pending: true,
      _pending_reason: pending.reason,
      report_run_id: pending.report_run_id,
      currency: params.currency ?? null,
    }
  }

  return { data: results, _split: breakdownGroups.length > 1, currency: params.currency ?? null }
}

// ─── campaigns_list ───────────────────────────────────────────────────────────

interface CampaignsListParams {
  fields?: string[]
  limit?: number
}

export async function campaigns_list(params: CampaignsListParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)
  const fields = (params.fields ?? ["id", "name", "status", "effective_status", "objective", "daily_budget", "lifetime_budget"]).join(",")
  const data = await metaFetchPaged(ctx.fetch, {
    path: `/${adAccountId}/campaigns`,
    method: "GET",
    params: { fields, ...(params.limit ? { limit: params.limit } : {}) },
    accessToken,
  })
  // budget_units: Meta returns daily_budget/lifetime_budget as INTEGER MINOR
  // UNITS (cents for EUR) — without the marker a reader can mistake "3500"
  // for 3,500 in major units and misjudge the budget regime by 100x.
  return { data, budget_units: "minor" }
}

// ─── adsets_list ─────────────────────────────────────────────────────────────

interface AdsetsListParams {
  campaign_id?: string
  fields?: string[]
  limit?: number
}

export async function adsets_list(params: AdsetsListParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)
  const fields = (params.fields ?? [
    "id", "name", "status", "effective_status", "campaign_id",
    "targeting", "daily_budget", "lifetime_budget", "optimization_goal",
    "billing_event", "bid_amount",
  ]).join(",")

  const path = params.campaign_id
    ? `/${params.campaign_id}/adsets`
    : `/${adAccountId}/adsets`

  const data = await metaFetchPaged(ctx.fetch, {
    path,
    method: "GET",
    params: { fields, ...(params.limit ? { limit: params.limit } : {}) },
    accessToken,
  })
  // See campaigns_list: budgets/bids are integer minor units.
  return { data, budget_units: "minor" }
}

// ─── ads_list ─────────────────────────────────────────────────────────────────

interface AdsListParams {
  adset_id?: string
  campaign_id?: string
  fields?: string[]
  limit?: number
  /** Opaque Graph cursor from a previous page's `after`. Fetches the next page. */
  after?: string
  /** Fetch AT MOST this many Graph pages in one call (default 1). */
  max_pages?: number
  /** Escape hatch: drain the ENTIRE edge (old unbounded behavior). Off by default. */
  all?: boolean
  /**
   * Meta `filtering` effective-status filter. Defaults to currently-delivering
   * plus paused (the states an operator actually reviews), which keeps the
   * default call cheap on accounts with years of archived/deleted ads. Pass an
   * explicit array (or [] to disable) to widen the set.
   */
  effective_status?: string[]
}

// Currently-delivering + paused-but-recent. Archived/deleted history is the
// long tail that made the unfiltered pull time out, so it is excluded by
// default; callers can widen via `effective_status`.
const ADS_DEFAULT_EFFECTIVE_STATUS = [
  "ACTIVE",
  "PAUSED",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "PENDING_REVIEW",
  "WITH_ISSUES",
]

export async function ads_list(params: AdsListParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)
  const fields = (params.fields ?? [
    "id", "name", "status", "effective_status", "adset_id", "campaign_id", "creative",
  ]).join(",")

  const path = params.adset_id
    ? `/${params.adset_id}/ads`
    : params.campaign_id
    ? `/${params.campaign_id}/ads`
    : `/${adAccountId}/ads`

  // Effective-status filter (Meta filtering grammar, same as campaigns/insights
  // use). Cheap server-side prune of the archived/deleted long tail.
  const statuses = params.effective_status ?? ADS_DEFAULT_EFFECTIVE_STATUS
  const filtering =
    statuses.length > 0
      ? JSON.stringify([{ field: "effective_status", operator: "IN", value: statuses }])
      : undefined

  const baseParams: Record<string, unknown> = {
    fields,
    limit: params.limit ?? 50,
    ...(filtering ? { filtering } : {}),
  }

  // Full-drain escape hatch keeps the previous unbounded behavior available
  // behind an explicit flag.
  if (params.all) {
    const data = await metaFetchPaged(ctx.fetch, {
      path,
      method: "GET",
      params: baseParams,
      accessToken,
    })
    return { data, after: null }
  }

  // Default: one bounded page (fast first paint, never drains the whole edge).
  const { data, after } = await metaFetchPage(ctx.fetch, {
    path,
    method: "GET",
    params: baseParams,
    accessToken,
    maxPages: params.max_pages ?? 1,
    ...(params.after ? { after: params.after } : {}),
  })
  return { data, after }
}

// ─── targeting_search ─────────────────────────────────────────────────────────

interface TargetingSearchParams {
  type: "adgeolocation" | "adinterest" | "adTargetingCategory"
  q: string
  location_types?: string[]
}

export async function targeting_search(params: TargetingSearchParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken } = await getMetaClient(ctx)
  const searchParams: Record<string, unknown> = {
    type: params.type,
    q: params.q,
  }
  if (params.location_types) searchParams.location_types = params.location_types

  return metaFetch(ctx.fetch, {
    path: "/search",
    method: "GET",
    params: searchParams,
    accessToken,
  })
}

// ─── media_list ───────────────────────────────────────────────────────────────

interface MediaListParams {
  type?: "images" | "videos"
  limit?: number
}

export async function media_list(params: MediaListParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)
  const type = params.type ?? "images"

  if (type === "images") {
    const data = await metaFetchPaged(ctx.fetch, {
      path: `/${adAccountId}/adimages`,
      method: "GET",
      params: {
        fields: "hash,name,status,width,height,url",
        ...(params.limit ? { limit: params.limit } : {}),
      },
      accessToken,
    })
    return { type: "images", data }
  } else {
    const data = await metaFetchPaged(ctx.fetch, {
      path: `/${adAccountId}/advideos`,
      method: "GET",
      params: {
        fields: "id,title,description,length,status",
        ...(params.limit ? { limit: params.limit } : {}),
      },
      accessToken,
    })
    return { type: "videos", data }
  }
}

// ─── audiences_list ───────────────────────────────────────────────────────────

interface AudiencesListParams {
  limit?: number
}

export async function audiences_list(params: AudiencesListParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)
  const data = await metaFetchPaged(ctx.fetch, {
    path: `/${adAccountId}/customaudiences`,
    method: "GET",
    params: {
      fields: "id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status{code,description},operation_status{code,description},retention_days,data_source{type,sub_type},time_created,time_updated,time_content_updated",
      ...(params.limit ? { limit: params.limit } : {}),
    },
    accessToken,
  })
  return { data }
}

// ─── pages_list ───────────────────────────────────────────────────────────────

export async function pages_list(_params: Record<string, never>, ctx: ReadCtx): Promise<unknown> {
  const { accessToken } = await getMetaClient(ctx)
  // SECURITY: never request access_token — a Page access token is a live credential
  // that would land in the LLM context / transcript / persistence. We only need
  // id/name/category to resolve a page_id for create_creative.
  const result = await metaFetch(ctx.fetch, {
    path: "/me/accounts",
    method: "GET",
    params: { fields: "id,name,category" },
    accessToken,
  }) as { data?: unknown[] }
  return { data: result.data ?? [] }
}

// ─── account_info ─────────────────────────────────────────────────────────────

export async function account_info(_params: Record<string, never>, ctx: ReadCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)
  // AdAccount has no `pixel_id` field (Graph rejects it with #100) — pixels are
  // the `adspixels` edge. Expand it in the same GET and surface the first pixel's
  // id as `pixel_id` so the tool's result shape (and the WEBSITE custom-audience
  // flow that consumes it) is unchanged; null when the account has no pixel.
  // No `business` field: it requires the business_management permission most ad
  // tokens lack (Graph #100 hard-fails the whole call) and nothing consumes it.
  const result = (await metaFetch(ctx.fetch, {
    path: `/${adAccountId}`,
    method: "GET",
    params: {
      fields: "id,name,currency,timezone_name,spend_cap,account_status,adspixels{id,name}",
    },
    accessToken,
  })) as Record<string, unknown> & { adspixels?: { data?: Array<{ id?: string }> } }
  const pixel_id = result.adspixels?.data?.[0]?.id ?? null
  const { adspixels: _adspixels, ...rest } = result
  return { ...rest, pixel_id }
}

// ─── graph_get ────────────────────────────────────────────────────────────────

interface GraphGetParams {
  path: string
  fields?: string
}

export async function graph_get(params: GraphGetParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken } = await getMetaClient(ctx)

  // Low-cost path validation: graph_get is GET-only (cannot mutate), but the
  // path is concatenated raw onto the Graph base URL. Reject paths that could
  // point at another host or smuggle a query-string access_token (the real token
  // is sent as a Bearer header). Keeps the GET-only-but-unbounded posture honest.
  const path = String(params.path ?? "")
  if (!path.startsWith("/")) {
    throw new Error(`graph_get: path must start with "/" (got "${path}")`)
  }
  if (path.includes("://")) {
    throw new Error("graph_get: path must be a Graph API path, not a full URL (contains '://')")
  }
  if (path.toLowerCase().includes("access_token=")) {
    throw new Error("graph_get: path must not carry an access_token query param: the token is sent as a Bearer header")
  }

  // An agent often writes the query inline (`/act_1/insights?limit=5`). metaFetch
  // appends its own `?...`, so a raw inline query plus `fields` would produce
  // `?limit=5?fields=...` and Graph would read limit as "5?fields=...". Split
  // the inline query into params; an explicit `fields` wins over an inline one.
  const q = path.indexOf("?")
  const basePath = q === -1 ? path : path.slice(0, q)
  const merged: Record<string, unknown> = {}
  if (q !== -1) {
    for (const pair of path.slice(q + 1).split("&")) {
      if (!pair) continue
      const eq = pair.indexOf("=")
      const rawKey = eq === -1 ? pair : pair.slice(0, eq)
      const rawVal = eq === -1 ? "" : pair.slice(eq + 1)
      const key = decodeQueryPart(rawKey)
      if (key) merged[key] = decodeQueryPart(rawVal)
    }
  }
  if (params.fields) merged.fields = params.fields

  return metaFetch(ctx.fetch, {
    path: basePath,
    method: "GET",
    params: Object.keys(merged).length > 0 ? merged : undefined,
    accessToken,
  })
}

function decodeQueryPart(raw: string): string {
  const plus = raw.replace(/\+/g, " ")
  try {
    return decodeURIComponent(plus)
  } catch {
    return plus
  }
}

// ─── creative_get ─────────────────────────────────────────────────────────────

interface CreativeGetParams {
  creative_id?: string
  ad_id?: string
}

export async function creative_get(params: CreativeGetParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken, adAccountId } = await getMetaClient(ctx)

  let creativeId = params.creative_id

  // Step 1: If ad_id given and no creative_id, resolve the creative ref
  if (params.ad_id && !creativeId) {
    const adResult = await metaFetch(ctx.fetch, {
      path: `/${params.ad_id}`,
      params: { fields: "creative" },
      accessToken,
    }) as { creative?: { id?: string } }
    creativeId = adResult?.creative?.id
  }

  if (!creativeId) {
    return { creative_id: creativeId, thumbnail_url: null, image_urls: [], video_id: null, headline: null, body: null, reason: "no_creative" }
  }

  // Step 2: Read the creative
  const creative = await metaFetch(ctx.fetch, {
    path: `/${creativeId}`,
    params: { fields: "object_story_spec,asset_feed_spec,title,body,image_hash,video_id,thumbnail_url" },
    accessToken,
  }) as {
    object_story_spec?: { link_data?: { image_hash?: string } }
    asset_feed_spec?: { images?: Array<{ hash?: string }> }
    image_hash?: string
    video_id?: string
    thumbnail_url?: string
    title?: string
    body?: string
  }

  // Collect image_hash values
  const hashes: string[] = []
  if (creative.object_story_spec?.link_data?.image_hash) hashes.push(creative.object_story_spec.link_data.image_hash)
  if (creative.asset_feed_spec?.images) {
    for (const img of creative.asset_feed_spec.images) {
      if (img.hash) hashes.push(img.hash)
    }
  }
  if (creative.image_hash) hashes.push(creative.image_hash)

  const imageUrls: string[] = []

  // Step 3: Resolve hashes to CDN URLs via metaFetch (NOT metaFetchPaged)
  // adAccountId already has the act_ prefix as stored in credentials.
  if (hashes.length > 0) {
    const result = await metaFetch(ctx.fetch, {
      path: `/${adAccountId}/adimages`,
      params: { hashes: JSON.stringify(hashes), fields: "hash,url,permalink_url" },
      accessToken,
    }) as { images?: Record<string, { url?: string }> }

    if (result.images) {
      for (const hash of hashes) {
        const url = result.images[hash]?.url
        if (url) imageUrls.push(url)
      }
    }
  }

  // Step 4: Video thumbnail
  let thumbnailUrl: string | null = imageUrls[0] ?? null
  const videoId = creative.video_id ?? null

  if (videoId && !thumbnailUrl) {
    const videoResult = await metaFetch(ctx.fetch, {
      path: `/${videoId}`,
      params: { fields: "thumbnails{uri},picture" },
      accessToken,
    }) as { thumbnails?: { data?: Array<{ uri?: string }> }; picture?: string }
    thumbnailUrl = videoResult?.thumbnails?.data?.[0]?.uri ?? videoResult?.picture ?? null
  }

  if (!thumbnailUrl && imageUrls.length === 0 && !videoId) {
    return { creative_id: creativeId, thumbnail_url: null, image_urls: [], video_id: null, headline: null, body: null, reason: "no_creative" }
  }

  return {
    creative_id: creativeId,
    thumbnail_url: thumbnailUrl,
    image_urls: imageUrls,
    video_id: videoId,
    headline: creative.title ?? null,
    body: creative.body ?? null,
  }
}

// ─── ad_preview ───────────────────────────────────────────────────────────────

interface AdPreviewParams {
  ad_id?: string
  creative_id?: string
  ad_format?: string
  ad_formats?: string[]
}

interface AdPreviewSingle {
  ad_format: string
  body: string | null
  reason?: string
}

export async function ad_preview(params: AdPreviewParams, ctx: ReadCtx): Promise<unknown> {
  const { accessToken } = await getMetaClient(ctx)
  const targetId = params.ad_id ?? params.creative_id

  const fetchPreview = async (fmt: string): Promise<AdPreviewSingle> => {
    try {
      const result = await metaFetch(ctx.fetch, {
        path: `/${targetId}/previews`,
        params: { ad_format: fmt },
        accessToken,
      }) as { data?: Array<{ body?: string }> }
      const body = result?.data?.[0]?.body ?? null
      return { ad_format: fmt, body }
    } catch (err) {
      return { ad_format: fmt, body: null, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  // `rows`: one row per format, the list a dashboard block reads (the single-format answer keeps
  // its fields at the top level too).
  if (params.ad_formats && params.ad_formats.length > 0) {
    const previews = await Promise.all(params.ad_formats.map(fetchPreview))
    return { previews, rows: previews }
  }

  const fmt = params.ad_format ?? "DESKTOP_FEED_STANDARD"
  const single = await fetchPreview(fmt)
  return { ...single, rows: [single] }
}

// ─── counts ───────────────────────────────────────────────────────────────────

interface CountsResult {
  active: number
  paused: number
  total: number
}

const PAUSED_STATUSES = new Set(["CAMPAIGN_PAUSED", "PAUSED", "ADSET_PAUSED", "AD_PAUSED"])

export async function counts(_params: Record<string, never>, ctx: ReadCtx): Promise<CountsResult> {
  // Recomputed on every call: a run keeps nothing in module state.
  await getMetaClient(ctx)
  // campaigns_list returns { data: Campaign[] }
  const { data } = (await campaigns_list({}, ctx)) as { data: Array<{ effective_status: string }> }

  let active = 0
  let paused = 0
  for (const row of data) {
    if (row.effective_status === "ACTIVE") active++
    else if (PAUSED_STATUSES.has(row.effective_status)) paused++
  }

  return { active, paused, total: data.length }
}

// ─── pending_approvals_list ────────────────────────────────────────────────────
//
// The dashboard's Pending Approvals tile reads the count of ads-app approvals
// waiting on the caller. Approvals are a kernel affordance, not a Meta read:
// the kernel bridge exposes `ctx.kernel.listApprovals(toolNamePrefix, limit)`
// to every sandbox app (RLS-scoped to the caller's org and decidable set), so
// we prefix on "ads:" to return only this app's gated writes (pause, budget
// changes, audience uploads). Mirrors invoicing's pendingApprovalsList.

/** Kernel affordance the bridge injects onto ctx (typed locally; the app-sdk
 *  AppContext does not surface it, matching invoicing's ReadsKernel). */
interface ApprovalsKernel {
  listApprovals(toolNamePrefix?: string, limit?: number): Promise<unknown[]>
}

interface PendingApproval {
  id: string
  tool_name: string
  summary: string
  created_at: string
  requested_by_user_id: string
}

interface PendingApprovalsResult {
  count: number
  approvals: PendingApproval[]
}

const APPROVALS_MAX_LIMIT = 50

export async function pending_approvals_list(
  params: { limit?: number },
  ctx: ReadCtx,
): Promise<PendingApprovalsResult> {
  const kernel = (ctx as unknown as { kernel?: ApprovalsKernel }).kernel
  if (!kernel || typeof kernel.listApprovals !== "function") {
    // No kernel affordance on this ctx (e.g. a bare-fetch unit ctx): report an
    // empty, non-erroring queue rather than throwing — the tile degrades to a
    // nav affordance, it does not crash the dashboard.
    return { count: 0, approvals: [] }
  }
  const limit = Number.isFinite(params?.limit)
    ? Math.min(Math.max(1, Math.floor(Number(params.limit))), APPROVALS_MAX_LIMIT)
    : APPROVALS_MAX_LIMIT
  const rows = await kernel.listApprovals("ads:", limit)
  const approvals: PendingApproval[] = rows.map((row) => {
    const r = row as Record<string, unknown>
    const summary = r.summary as { headline?: string } | undefined
    return {
      id: String(r.id),
      tool_name: String(r.toolName ?? ""),
      summary: summary?.headline ?? "",
      created_at: (r.createdAt as string) ?? new Date(0).toISOString(),
      requested_by_user_id: String(r.requestedBy ?? ""),
    }
  })
  return { count: approvals.length, approvals }
}
