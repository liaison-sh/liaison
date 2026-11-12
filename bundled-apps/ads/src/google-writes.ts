// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated write handlers for the Google Ads arm of the ads app. All handlers
// are authored natively as (params, ctx) — the kernel convention. Every
// handler resolves the token from the `google` OAuth2 connection + config
// from the `google-config` credentials connection via getGoogleClient
// (P4's seam), then calls googleAdsMutate (batch-2 `google-client.ts`).
//
// Money: agent supplies MAJOR units; convert to integer MICROS at the tool
// boundary (MICROS = 1_000_000) — never rescale by 100 (that's Meta's
// minor-unit path). Currency is READ from the account (google_account_info)
// by the agent and passed in — never assumed.
//
// No live calls in this build (Google dev token deferred — BUILD_LEDGER).
// Every handler is fixture-tested behind the batch-2 googleAdsMutate seam.

import { googleAdsMutate, MICROS } from "./lib/google-client"
import { getGoogleClient } from "./lib/google-config"
import {
  type PreflightOutcome,
  preflightGoogleAdCompositeId,
  refuse,
  throwIfRefused,
  toPreflightResult,
} from "./lib/preflight"

interface GoogleWriteCtx {
  connections: unknown
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
}

function toMicros(major: number): number {
  return Math.round(major * MICROS)
}

function stripDashes(raw: string): string {
  return raw.replace(/-/g, "")
}

/** Pass the caller-supplied `experiment` design object through untouched (§5.2) — the
 * handler never inserts an experiments row itself; it only echoes the field back so
 * the summarizer (which cannot read ctx.db) can render the design on the approval card. */
function passExperiment(p: Record<string, unknown>): Record<string, unknown> {
  return p.experiment && typeof p.experiment === "object" ? { experiment: p.experiment } : {}
}

// ─── google_create_campaign (Search + Performance Max) ─────────────────────

interface CreateCampaignParams {
  name: string
  advertising_channel_type: "SEARCH" | "PERFORMANCE_MAX"
  daily_budget: number
  currency: string
  status?: string
  experiment?: unknown
  bidding_strategy?: unknown
}

const ALLOWED_CHANNEL_TYPES = new Set(["SEARCH", "PERFORMANCE_MAX"])

// The API (v24 onward) rejects campaign creates without a bidding strategy on the mutate
// body. Every bidding strategy is a SINGLE key from this set (Google's
// campaign resource models bidding strategy as a oneof) -- the agent may
// pass any one of them; if omitted, default per channel type so the create
// never fails on a missing field the agent forgot.
const ALLOWED_BIDDING_STRATEGY_FIELDS = new Set([
  "manualCpc",
  "maximizeConversions",
  "maximizeConversionValue",
  "targetCpa",
  "targetRoas",
  "targetSpend",
])

function defaultBiddingStrategy(channelType: string): Record<string, unknown> {
  return channelType === "PERFORMANCE_MAX" ? { maximizeConversions: {} } : { manualCpc: {} }
}

/**
 * Shared checker for google_create_campaign's bidding_strategy. Google models
 * the bidding strategy as a oneof, so "exactly one key, from this set" is a
 * shape rule the params schema cannot express (it can only list the allowed
 * properties, not forbid a second one). Both the handler and the manifest
 * `preflight` run this one function.
 */
export function preflightGoogleCreateCampaignParams(
  p: Record<string, unknown>,
): PreflightOutcome<{ biddingStrategy: Record<string, unknown> | null }> {
  const raw = p.bidding_strategy
  if (raw === undefined) return { ok: true, biddingStrategy: null }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return refuse(
      "invalid_params",
      "google_create_campaign: bidding_strategy must be an object with exactly one bidding strategy field " +
        `(one of: ${[...ALLOWED_BIDDING_STRATEGY_FIELDS].join(", ")})`,
    )
  }
  const keys = Object.keys(raw as Record<string, unknown>)
  if (keys.length !== 1 || !ALLOWED_BIDDING_STRATEGY_FIELDS.has(keys[0]!)) {
    return refuse(
      "invalid_params",
      `google_create_campaign: bidding_strategy must carry exactly one recognized field, got [${keys.join(", ")}] ` +
        `(one of: ${[...ALLOWED_BIDDING_STRATEGY_FIELDS].join(", ")})`,
    )
  }
  return { ok: true, biddingStrategy: raw as Record<string, unknown> }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. A malformed bidding strategy only failed after the approver had
// already clicked approve, and after the linked campaign budget had been
// created on the live account.
export async function google_create_campaign_preflight(params: unknown): Promise<unknown> {
  return toPreflightResult(
    preflightGoogleCreateCampaignParams((params ?? {}) as Record<string, unknown>),
  )
}

export async function google_create_campaign(
  params: unknown,
  ctx: GoogleWriteCtx,
): Promise<unknown> {
  const p = params as CreateCampaignParams & Record<string, unknown>
  const { token, config } = await getGoogleClient(ctx)

  const channelType = String(p.advertising_channel_type ?? "")
  if (!ALLOWED_CHANNEL_TYPES.has(channelType)) {
    throw new Error(
      `google_create_campaign: advertising_channel_type must be SEARCH or PERFORMANCE_MAX, got "${channelType}"`,
    )
  }

  const name = String(p.name ?? "")
  if (!name) throw new Error("google_create_campaign: name is required")

  const currency = String(p.currency ?? "")
  if (!currency) {
    throw new Error(
      "google_create_campaign: currency is required: call google_account_info first to get the account currency",
    )
  }

  const dailyBudget = Number(p.daily_budget)
  if (!Number.isFinite(dailyBudget) || dailyBudget <= 0) {
    throw new Error(`google_create_campaign: invalid daily_budget value "${p.daily_budget}"`)
  }
  const amountMicros = toMicros(dailyBudget)

  const checked = throwIfRefused(preflightGoogleCreateCampaignParams(p))
  const biddingStrategy = checked.biddingStrategy ?? defaultBiddingStrategy(channelType)
  const biddingStrategyField = Object.keys(biddingStrategy)[0]!

  // Step 1: create the linked campaign budget.
  const budgetResult = (await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: "campaignBudgets:mutate",
    operations: [
      {
        create: {
          name: `${name} budget`,
          amountMicros: String(amountMicros),
          deliveryMethod: "STANDARD",
        },
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })) as { results?: Array<{ resourceName?: string }> }
  const budgetResourceName = budgetResult.results?.[0]?.resourceName

  // Step 2: create the campaign, status ALWAYS PAUSED on create (SC 2 safety —
  // never ENABLED by an agent, regardless of what the caller passed).
  const campaignResult = (await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: "campaigns:mutate",
    operations: [
      {
        create: {
          name,
          advertisingChannelType: channelType,
          status: "PAUSED",
          campaignBudget: budgetResourceName,
          ...biddingStrategy,
        },
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })) as { results?: Array<{ resourceName?: string }> }
  const campaignResourceName = campaignResult.results?.[0]?.resourceName

  return {
    campaign_resource_name: campaignResourceName,
    campaign_budget_resource_name: budgetResourceName,
    advertising_channel_type: channelType,
    status: "PAUSED",
    daily_budget: dailyBudget,
    daily_budget_micros: amountMicros,
    currency,
    bidding_strategy: biddingStrategy,
    bidding_strategy_type: biddingStrategyField,
    ...passExperiment(p),
  }
}

// ─── google_create_adgroup ──────────────────────────────────────────────────

interface CreateAdGroupParams {
  campaign_id: string
  name: string
  status?: string
  experiment?: unknown
}

export async function google_create_adgroup(
  params: unknown,
  ctx: GoogleWriteCtx,
): Promise<unknown> {
  const p = params as CreateAdGroupParams & Record<string, unknown>
  const { token, config } = await getGoogleClient(ctx)

  const campaignId = String(p.campaign_id ?? "")
  if (!campaignId) throw new Error("google_create_adgroup: campaign_id is required")
  const name = String(p.name ?? "")
  if (!name) throw new Error("google_create_adgroup: name is required")

  const campaignResourceName = `customers/${stripDashes(config.customerId)}/campaigns/${campaignId}`

  const result = (await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: "adGroups:mutate",
    operations: [
      {
        create: {
          name,
          campaign: campaignResourceName,
          status: "PAUSED",
        },
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })) as { results?: Array<{ resourceName?: string }> }

  return {
    resource_name: result.results?.[0]?.resourceName,
    campaign_id: campaignId,
    name,
    status: "PAUSED",
    ...passExperiment(p),
  }
}

// ─── google_create_ad (RSA) ─────────────────────────────────────────────────

interface CreateAdParams {
  ad_group_id: string
  headlines: string[]
  descriptions: string[]
  final_urls: string[]
}

export async function google_create_ad(params: unknown, ctx: GoogleWriteCtx): Promise<unknown> {
  const p = params as CreateAdParams & Record<string, unknown>
  const { token, config } = await getGoogleClient(ctx)

  const adGroupId = String(p.ad_group_id ?? "")
  if (!adGroupId) throw new Error("google_create_ad: ad_group_id is required")

  const headlines = Array.isArray(p.headlines) ? p.headlines.map(String) : []
  if (headlines.length < 3) {
    throw new Error(
      `google_create_ad: a responsive search ad requires at least 3 headlines, got ${headlines.length}`,
    )
  }
  const descriptions = Array.isArray(p.descriptions) ? p.descriptions.map(String) : []
  if (descriptions.length < 2) {
    throw new Error(
      `google_create_ad: a responsive search ad requires at least 2 descriptions, got ${descriptions.length}`,
    )
  }
  const finalUrls = Array.isArray(p.final_urls) ? p.final_urls.map(String) : []
  if (finalUrls.length === 0)
    throw new Error("google_create_ad: final_urls is required (at least 1)")

  const adGroupResourceName = `customers/${stripDashes(config.customerId)}/adGroups/${adGroupId}`

  const result = (await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: "adGroupAds:mutate",
    operations: [
      {
        create: {
          adGroup: adGroupResourceName,
          status: "PAUSED",
          ad: {
            finalUrls,
            responsiveSearchAd: {
              headlines: headlines.map((text) => ({ text })),
              descriptions: descriptions.map((text) => ({ text })),
            },
          },
        },
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })) as { results?: Array<{ resourceName?: string }> }

  return {
    resource_name: result.results?.[0]?.resourceName,
    ad_group_id: adGroupId,
    status: "PAUSED",
    headline_count: headlines.length,
    description_count: descriptions.length,
  }
}

// ─── google_update_budget ───────────────────────────────────────────────────

interface UpdateBudgetParams {
  budget_resource_name: string
  amount: number
  currency: string
}

export async function google_update_budget(params: unknown, ctx: GoogleWriteCtx): Promise<unknown> {
  const p = params as UpdateBudgetParams & Record<string, unknown>
  const { token, config } = await getGoogleClient(ctx)

  const budgetResourceName = String(p.budget_resource_name ?? "")
  if (!budgetResourceName) {
    throw new Error("google_update_budget: budget_resource_name is required")
  }

  const currency = String(p.currency ?? "")
  if (!currency) {
    throw new Error(
      "google_update_budget: currency is required: call google_account_info first to get the account currency",
    )
  }

  const amount = Number(p.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`google_update_budget: invalid amount value "${p.amount}"`)
  }
  const amountMicros = toMicros(amount)

  await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: "campaignBudgets:mutate",
    operations: [
      {
        update: { resourceName: budgetResourceName, amountMicros: String(amountMicros) },
        updateMask: "amount_micros",
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })

  return {
    budget_resource_name: budgetResourceName,
    amount,
    amount_micros: amountMicros,
    currency,
    ...passExperiment(p),
  }
}

// ─── google_set_status (enable-direction gated) ────────────────────────────

type GoogleObjectType = "campaign" | "ad_group" | "ad"

const SET_STATUS_CONFIG: Record<GoogleObjectType, { mutatePath: string; resource: string }> = {
  campaign: { mutatePath: "campaigns:mutate", resource: "campaigns" },
  ad_group: { mutatePath: "adGroups:mutate", resource: "adGroups" },
  ad: { mutatePath: "adGroupAds:mutate", resource: "adGroupAds" },
}

interface SetStatusParams {
  object_id: string
  object_type: GoogleObjectType
  status: "ENABLED" | "PAUSED"
  experiment?: unknown
  /** Required (with ad_id) when object_type is "ad" instead of a composite object_id. */
  ad_group_id?: string
  /** Required (with ad_group_id) when object_type is "ad" instead of a composite object_id. */
  ad_id?: string
}

/**
 * The adGroupAd composite id rule is shared with google_pause: one checker in
 * lib/preflight, the tool name only selecting the message prefix.
 */
function resolveAdObjectId(p: Record<string, unknown>): PreflightOutcome<{ objectId: string }> {
  return preflightGoogleAdCompositeId("google_set_status", p)
}

/**
 * Shared checker for google_set_status. `object_id` is only CONDITIONALLY
 * required (an "ad" target may supply ad_group_id + ad_id instead), so the rule
 * cannot live in the params schema. Both the handler and the manifest
 * `preflight` run this one function.
 */
export function preflightGoogleSetStatusParams(
  p: Record<string, unknown>,
): PreflightOutcome<{ objectId: string; objectType: GoogleObjectType }> {
  const status = String(p.status ?? "")

  // PAUSED must go through the ungated google_pause tool — this tool only
  // ever gates and executes the ENABLED (resume) direction.
  if (status === "PAUSED") {
    return refuse(
      "invalid_params",
      "google_set_status: to pause, use the ungated google_pause tool instead (stopping spend is always safe and does not need approval)",
    )
  }
  if (status !== "ENABLED") {
    return refuse(
      "invalid_params",
      `google_set_status: status must be ENABLED (use google_pause to pause), got "${status}"`,
    )
  }

  const objectType = p.object_type as GoogleObjectType | undefined
  if (!objectType || !SET_STATUS_CONFIG[objectType]) {
    return refuse(
      "invalid_params",
      "google_set_status: object_type must be one of campaign, ad_group, ad",
    )
  }

  let objectId: string
  if (objectType === "ad") {
    const resolved = resolveAdObjectId(p)
    if (!("ok" in resolved)) return resolved
    objectId = resolved.objectId
  } else {
    objectId = String(p.object_id ?? "")
  }
  if (!objectId) {
    return refuse("invalid_params", "google_set_status: object_id is required")
  }

  return { ok: true, objectId, objectType }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. A resume with no resolvable object id only failed after approval.
export async function google_set_status_preflight(params: unknown): Promise<unknown> {
  return toPreflightResult(
    preflightGoogleSetStatusParams((params ?? {}) as Record<string, unknown>),
  )
}

export async function google_set_status(params: unknown, ctx: GoogleWriteCtx): Promise<unknown> {
  const p = params as SetStatusParams & Record<string, unknown>

  const checked = throwIfRefused(preflightGoogleSetStatusParams(p))
  const objectId = checked.objectId
  const objectType = checked.objectType

  const { token, config } = await getGoogleClient(ctx)
  const cfg = SET_STATUS_CONFIG[objectType]
  const resourceName = `customers/${stripDashes(config.customerId)}/${cfg.resource}/${objectId}`

  await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: cfg.mutatePath,
    operations: [
      {
        update: { resourceName, status: "ENABLED" },
        updateMask: "status",
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })

  return {
    object_id: objectId,
    object_type: objectType,
    status: "ENABLED",
    ...passExperiment(p),
  }
}

// ─── google_add_negative_keywords ──────────────────────────────────────────

interface NegativeKeyword {
  text: string
  match_type: "EXACT" | "PHRASE" | "BROAD"
}

interface AddNegativeKeywordsParams {
  ad_group_id?: string
  campaign_id?: string
  keywords: NegativeKeyword[]
}

/**
 * Shared checker for google_add_negative_keywords. The target is a one-of
 * (ad group OR campaign), a cross-field rule the params schema cannot express,
 * so both the handler and the manifest `preflight` run this one function.
 */
export function preflightGoogleAddNegativeKeywordsParams(
  p: Record<string, unknown>,
): PreflightOutcome {
  const keywords = Array.isArray(p.keywords) ? (p.keywords as NegativeKeyword[]) : []
  if (keywords.length === 0) {
    return refuse(
      "invalid_params",
      "google_add_negative_keywords: keywords is required (at least 1)",
    )
  }
  for (const kw of keywords) {
    if (!kw || typeof kw.text !== "string" || !kw.text) {
      return refuse(
        "invalid_params",
        "google_add_negative_keywords: every keyword needs a non-empty text",
      )
    }
  }
  if (!p.ad_group_id && !p.campaign_id) {
    return refuse(
      "invalid_params",
      "google_add_negative_keywords: provide ad_group_id or campaign_id",
    )
  }
  return { ok: true }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. A negative-keyword batch with no target level only failed once the
// approver had already clicked approve.
export async function google_add_negative_keywords_preflight(params: unknown): Promise<unknown> {
  return toPreflightResult(
    preflightGoogleAddNegativeKeywordsParams((params ?? {}) as Record<string, unknown>),
  )
}

export async function google_add_negative_keywords(
  params: unknown,
  ctx: GoogleWriteCtx,
): Promise<unknown> {
  const p = params as AddNegativeKeywordsParams & Record<string, unknown>
  throwIfRefused(preflightGoogleAddNegativeKeywordsParams(p))

  const { token, config } = await getGoogleClient(ctx)

  const keywords = Array.isArray(p.keywords) ? p.keywords : []
  if (keywords.length === 0) {
    throw new Error("google_add_negative_keywords: keywords is required (at least 1)")
  }
  for (const kw of keywords) {
    if (!kw || typeof kw.text !== "string" || !kw.text) {
      throw new Error("google_add_negative_keywords: every keyword needs a non-empty text")
    }
  }

  const adGroupId = p.ad_group_id ? String(p.ad_group_id) : undefined
  const campaignId = p.campaign_id ? String(p.campaign_id) : undefined
  if (!adGroupId && !campaignId) {
    throw new Error("google_add_negative_keywords: provide ad_group_id or campaign_id")
  }

  const isAdGroupLevel = Boolean(adGroupId)
  const mutatePath = isAdGroupLevel ? "adGroupCriteria:mutate" : "campaignCriteria:mutate"
  const parentResourceName = isAdGroupLevel
    ? `customers/${stripDashes(config.customerId)}/adGroups/${adGroupId}`
    : `customers/${stripDashes(config.customerId)}/campaigns/${campaignId}`
  const parentField = isAdGroupLevel ? "adGroup" : "campaign"

  const operations = keywords.map((kw) => ({
    create: {
      [parentField]: parentResourceName,
      negative: true,
      keyword: { text: kw.text, matchType: kw.match_type ?? "BROAD" },
    },
  }))

  const result = (await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: mutatePath,
    operations,
    token,
    loginCustomerId: config.loginCustomerId,
  })) as { results?: Array<{ resourceName?: string }> }

  return {
    level: isAdGroupLevel ? "ad_group" : "campaign",
    parent_id: isAdGroupLevel ? adGroupId : campaignId,
    added: keywords.map((kw, i) => ({
      text: kw.text,
      match_type: kw.match_type ?? "BROAD",
      resource_name: result.results?.[i]?.resourceName,
    })),
  }
}

// ─── google_create_conversion_action ───────────────────────────────────────

interface CreateConversionActionParams {
  name: string
  category: string
  type: string
}

export async function google_create_conversion_action(
  params: unknown,
  ctx: GoogleWriteCtx,
): Promise<unknown> {
  const p = params as CreateConversionActionParams & Record<string, unknown>
  const { token, config } = await getGoogleClient(ctx)

  const name = String(p.name ?? "")
  if (!name) throw new Error("google_create_conversion_action: name is required")
  const category = String(p.category ?? "")
  if (!category) throw new Error("google_create_conversion_action: category is required")
  const type = String(p.type ?? "")
  if (!type) throw new Error("google_create_conversion_action: type is required")

  const result = (await googleAdsMutate(ctx.fetch, {
    customerId: config.customerId,
    path: "conversionActions:mutate",
    operations: [
      {
        create: {
          name,
          category,
          type,
          status: "ENABLED",
        },
      },
    ],
    token,
    loginCustomerId: config.loginCustomerId,
  })) as { results?: Array<{ resourceName?: string }> }

  return {
    resource_name: result.results?.[0]?.resourceName,
    name,
    category,
    type,
  }
}
