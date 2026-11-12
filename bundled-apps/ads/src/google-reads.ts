// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Google Ads read tools for the ads app. All handlers authored natively as
// (params, ctx) — the kernel convention. Every handler resolves the token
// from the `google` OAuth2 connection + config from the `google-config`
// credentials connection via getGoogleClient, then calls gaqlSearch. Money
// fields are converted from micros to major units at the tool boundary
// (never rescale by 100 — that is the Meta minor-unit path).

import { gaqlSearch, microsToMajor } from "./lib/google-client"
import { GoogleConfigError, getGoogleClient } from "./lib/google-config"

interface GoogleReadCtx {
  connections: unknown
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
}

// ─── shared GAQL row helpers ───────────────────────────────────────────────────

type Row = Record<string, unknown>

function get(row: Row, path: string): unknown {
  const parts = path.split(".")
  let cur: unknown = row
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined
    cur = (cur as Row)[p]
  }
  return cur
}

function asNumber(v: unknown): number {
  if (typeof v === "number") return v
  if (typeof v === "string" && v !== "") return Number(v)
  return 0
}

// ─── Read-only GAQL allowlist ───────────────────────────────────────────────
//
// searchStream is physically incapable of mutating anything — it is a pure
// read RPC, so scanning for UPDATE/INSERT/DELETE/MUTATE keywords is theatre
// (GAQL has no such statements to begin with; the keywords can only appear
// inside a string literal or comment, never as an actual mutation). The only
// real defensive check is: it must be a SELECT, and its FROM resource must be
// on the allowlist. Comments (/* ... */ and -- to end of line) are stripped
// before matching so a legitimately commented query is never misread.

const ALLOWED_RESOURCES = [
  "campaign",
  "ad_group",
  "ad_group_ad",
  "search_term_view",
  "recommendation",
  "customer",
  "conversion_action",
  "metrics",
]

/** Strip /* block *\/ and -- line comments so they never interfere with keyword/resource matching. */
function stripGaqlComments(query: string): string {
  return query.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ")
}

function assertReadOnlyGaql(query: string): void {
  const stripped = stripGaqlComments(query).trim()
  if (!/^SELECT\b/i.test(stripped)) {
    throw new Error("google_insights_query: query must be a read-only SELECT statement")
  }
  // FROM resource token: letters/digits/underscores, tolerating surrounding
  // whitespace — never rejects a valid GAQL resource name.
  const fromMatch = /\bFROM\s+([a-z0-9_]+)/i.exec(stripped)
  const resource = fromMatch?.[1]?.toLowerCase()
  if (!resource || !ALLOWED_RESOURCES.includes(resource)) {
    throw new Error(
      `google_insights_query: FROM resource "${resource ?? "?"}" is not in the read allowlist (${ALLOWED_RESOURCES.join(", ")})`,
    )
  }
}

// ─── google_campaigns_list ─────────────────────────────────────────────────────

interface CampaignsListParams {
  fields?: string[]
  limit?: number
}

const CAMPAIGNS_GAQL =
  "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, " +
  "campaign_budget.amount_micros FROM campaign"

export async function google_campaigns_list(
  params: CampaignsListParams,
  ctx: GoogleReadCtx,
): Promise<unknown> {
  const { token, config } = await getGoogleClient(ctx)
  const rows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query: CAMPAIGNS_GAQL,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]

  const campaigns = rows.map((r) => ({
    id: get(r, "campaign.id"),
    name: get(r, "campaign.name"),
    status: get(r, "campaign.status"),
    advertising_channel_type: get(r, "campaign.advertisingChannelType"),
    budget_amount: microsToMajor(asNumber(get(r, "campaignBudget.amountMicros"))),
  }))

  return { campaigns, count: campaigns.length }
}

// ─── google_adgroups_list ──────────────────────────────────────────────────────

interface AdGroupsListParams {
  campaign_id?: string
}

export async function google_adgroups_list(
  params: AdGroupsListParams,
  ctx: GoogleReadCtx,
): Promise<unknown> {
  const { token, config } = await getGoogleClient(ctx)
  let query = "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group"
  if (params.campaign_id) {
    query += ` WHERE campaign.id = ${Number(params.campaign_id)}`
  }
  const rows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]

  const ad_groups = rows.map((r) => ({
    id: get(r, "adGroup.id"),
    name: get(r, "adGroup.name"),
    status: get(r, "adGroup.status"),
    campaign_id: get(r, "campaign.id"),
  }))

  return { ad_groups, count: ad_groups.length }
}

// ─── google_ads_list ────────────────────────────────────────────────────────────

interface AdsListParams {
  ad_group_id?: string
  campaign_id?: string
}

export async function google_ads_list(params: AdsListParams, ctx: GoogleReadCtx): Promise<unknown> {
  const { token, config } = await getGoogleClient(ctx)
  let query =
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.status, " +
    "ad_group.id, campaign.id FROM ad_group_ad"
  const filters: string[] = []
  if (params.ad_group_id) filters.push(`ad_group.id = ${Number(params.ad_group_id)}`)
  if (params.campaign_id) filters.push(`campaign.id = ${Number(params.campaign_id)}`)
  if (filters.length > 0) query += ` WHERE ${filters.join(" AND ")}`

  const rows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]

  const ads = rows.map((r) => ({
    id: get(r, "adGroupAd.ad.id"),
    status: get(r, "adGroupAd.status"),
    headlines: get(r, "adGroupAd.ad.responsiveSearchAd.headlines") ?? [],
    ad_group_id: get(r, "adGroup.id"),
    campaign_id: get(r, "campaign.id"),
  }))

  return { ads, count: ads.length }
}

// ─── google_insights_query ──────────────────────────────────────────────────────

interface InsightsQueryParams {
  query: string
  currency?: string
}

export async function google_insights_query(
  params: InsightsQueryParams,
  ctx: GoogleReadCtx,
): Promise<unknown> {
  const query = String(params.query ?? "")
  assertReadOnlyGaql(query)

  // Not-connected is an EXPECTED state, not a crash: the kernel redacts
  // sandboxed handler throws in production ("Tool execution failed"), which
  // hides the actionable message from agents and forces the metrics layer to
  // guess. Return it as a structured error envelope instead (the database
  // bridge precedent), so callers can branch on the code deterministically.
  let client: Awaited<ReturnType<typeof getGoogleClient>>
  try {
    client = await getGoogleClient(ctx)
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      return { error: { code: "google_not_connected", message: err.message } }
    }
    throw err
  }
  const { token, config } = client
  const rows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]

  // Convert every recognized micros metric to major units at the boundary.
  // GAQL is explicit (unlike Meta's insights_query, this tool does not split
  // anything) — the caller wrote the SELECT, we only rescale known money fields.
  const normalized = rows.map((r) => {
    const row: Row = { ...r }
    const metrics = get(r, "metrics") as Row | undefined
    if (metrics && typeof metrics === "object") {
      const out: Row = { ...metrics }
      if ("costMicros" in metrics) out.cost = microsToMajor(asNumber(metrics.costMicros))
      if ("conversionsValue" in metrics) {
        out.conversions_value = microsToMajor(asNumber(metrics.conversionsValue))
      }
      if ("clicks" in metrics) out.clicks = asNumber(metrics.clicks)
      if ("impressions" in metrics) out.impressions = asNumber(metrics.impressions)
      if ("conversions" in metrics) out.conversions = asNumber(metrics.conversions)
      row.metrics = out
      // Surface the most commonly requested figure (cost) flattened at the
      // row's top level too, so a simple "spend by campaign" query doesn't
      // require the caller to dig into a nested metrics object.
      if ("costMicros" in metrics) row.cost = microsToMajor(asNumber(metrics.costMicros))
    }
    return row
  })

  return {
    rows: normalized,
    count: normalized.length,
    currency: params.currency ?? null,
  }
}

// ─── google_account_info ───────────────────────────────────────────────────────

const CUSTOMER_GAQL = "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer"
const CONVERSION_ACTIONS_GAQL =
  "SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.status " +
  "FROM conversion_action"

export async function google_account_info(
  _params: Record<string, never>,
  ctx: GoogleReadCtx,
): Promise<unknown> {
  // Not-connected returns a structured envelope (see google_insights_query) —
  // the settings UI and agents branch on the code instead of a redacted throw.
  let client: Awaited<ReturnType<typeof getGoogleClient>>
  try {
    client = await getGoogleClient(ctx)
  } catch (err) {
    if (err instanceof GoogleConfigError) {
      return { error: { code: "google_not_connected", message: err.message } }
    }
    throw err
  }
  const { token, config } = client

  const customerRows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query: CUSTOMER_GAQL,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]
  const customer = customerRows[0] ?? {}

  const conversionRows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query: CONVERSION_ACTIONS_GAQL,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]

  const conversion_actions = conversionRows.map((r) => ({
    id: get(r, "conversionAction.id"),
    name: get(r, "conversionAction.name"),
    type: get(r, "conversionAction.type"),
    status: get(r, "conversionAction.status"),
  }))

  return {
    customer_id: get(customer, "customer.id"),
    currency: get(customer, "customer.currencyCode"),
    time_zone: get(customer, "customer.timeZone"),
    conversion_actions,
  }
}

// ─── google_search_terms ───────────────────────────────────────────────────────

const SEARCH_TERMS_GAQL =
  "SELECT search_term_view.search_term, metrics.clicks, metrics.cost_micros, metrics.conversions " +
  "FROM search_term_view"

export async function google_search_terms(
  _params: Record<string, never>,
  ctx: GoogleReadCtx,
): Promise<unknown> {
  const { token, config } = await getGoogleClient(ctx)
  const rows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query: SEARCH_TERMS_GAQL,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]

  const search_terms = rows.map((r) => ({
    search_term: get(r, "searchTermView.searchTerm"),
    clicks: asNumber(get(r, "metrics.clicks")),
    cost: microsToMajor(asNumber(get(r, "metrics.costMicros"))),
    conversions: asNumber(get(r, "metrics.conversions")),
  }))

  return { search_terms, count: search_terms.length }
}

// ─── google_recommendations_list ───────────────────────────────────────────────

const RECOMMENDATIONS_GAQL =
  "SELECT recommendation.resource_name, recommendation.type, recommendation.campaign, " +
  "recommendation.dismissed FROM recommendation"

export async function google_recommendations_list(
  _params: Record<string, never>,
  ctx: GoogleReadCtx,
): Promise<unknown> {
  const { token, config } = await getGoogleClient(ctx)
  const rows = (await gaqlSearch(ctx.fetch, {
    customerId: config.customerId,
    query: RECOMMENDATIONS_GAQL,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as Row[]

  const recommendations = rows.map((r) => ({
    resource_name: get(r, "recommendation.resourceName"),
    type: get(r, "recommendation.type"),
    campaign: get(r, "recommendation.campaign"),
    dismissed: get(r, "recommendation.dismissed") ?? false,
  }))

  return { recommendations, count: recommendations.length }
}
