// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated write tool handlers for the ads bundled app. All handlers are
// authored natively as (params, ctx) — the kernel convention.
//
// No imports from ~/  or apps/api — only @liaison/app-sdk and local lib/*.

import type { CrossAppEnvelope } from "@liaison/app-sdk"
import { filterByBuyerConsent, filterByNewsletterConsent } from "./lab/consent-join"
import { getMetaClient } from "./lib/get-client"
import { hashIdentifier } from "./lib/hash-identifier"
import { BudgetCapError, metaFetch, ParamError, toMinorUnits } from "./lib/meta-client"
import { type PreflightOutcome, refuse, throwIfRefused, toPreflightResult } from "./lib/preflight"

// ─── Audience PII payload builder ──────────────────────────────────────────────
//
// Meta's /{audience}/users edge matches the `data` rows POSITIONALLY against the
// `schema` array. A phone hash sent under an EMAIL_SHA256 column never matches —
// silent audience corruption. So we build the schema PER IDENTIFIER TYPE: email
// hashes go under EMAIL_SHA256, phone hashes under PHONE_SHA256, using Meta's
// multi-key schema with positional nulls (a phone-only customer = [null, hash]).
// Columns are included only when at least one row carries that identifier.

interface CustomerIdentifiers {
  email?: string | null
  phone?: string | null
}

/**
 * Normalize a shopify:customers_search envelope result into a flat customer array.
 * Accepts either a bare array or a `{customers:[...]}` wrapper; returns `[]` otherwise.
 */
function extractCustomers(result: unknown): CustomerIdentifiers[] {
  if (Array.isArray(result)) return result as CustomerIdentifiers[]
  const wrapped = (result as { customers?: unknown } | null | undefined)?.customers
  if (Array.isArray(wrapped)) return wrapped as CustomerIdentifiers[]
  return []
}

interface AudiencePayload {
  schema: string[]
  data: Array<Array<string | null>>
  /** Number of rows that contributed at least one identifier. */
  rowCount: number
}

// ─── Consent-join enforcement (SC 8, section 5.4) ──────────────────────────
//
// Every CUSTOMER_LIST / add_users_to_audience upload requires a required
// audience_purpose param (default-deny if absent — the handler refuses
// rather than guessing). "buyer" joins purchase-time ad_consent from
// commerce.purchase_attribution; "newsletter" joins subscribers.
// marketing_consent. Consent domains never cross. This is enforcement in
// CODE, not agent instruction.

export type AudiencePurpose = "buyer" | "newsletter"

export interface ConsentJoinOutcome {
  uploaded: number
  dropped_no_consent: number
  dropped_no_consent_source: number
  /** True when the consent source itself could not be reached for ANY lookup — surfaced so an operator sees "consent source unreachable", not an opaque all-dropped result. */
  consent_source_unreachable?: boolean
}

function checkAudiencePurpose(
  p: Record<string, unknown>,
  toolName: string,
): PreflightOutcome<{ purpose: AudiencePurpose }> {
  const purpose = p.audience_purpose
  if (purpose !== "buyer" && purpose !== "newsletter") {
    return refuse(
      "invalid_params",
      `${toolName}: audience_purpose is required and must be "buyer" or "newsletter". The handler refuses rather than guessing which consent domain applies (SC 8 default-deny).`,
    )
  }
  return { ok: true, purpose }
}

async function applyConsentJoin(
  purpose: AudiencePurpose,
  customers: CustomerIdentifiers[],
  ctx: CrossAppCtx,
): Promise<{ customers: CustomerIdentifiers[]; outcome: ConsentJoinOutcome }> {
  const joinFn = purpose === "buyer" ? filterByBuyerConsent : filterByNewsletterConsent
  const result = await joinFn(customers, ctx)
  return {
    customers: result.allowed,
    outcome: {
      uploaded: result.allowed.length,
      dropped_no_consent: result.droppedNoConsent,
      dropped_no_consent_source: result.droppedNoConsentSource,
      ...(result.sourceUnreachable ? { consent_source_unreachable: true } : {}),
    },
  }
}

async function buildAudiencePayload(customers: CustomerIdentifiers[]): Promise<AudiencePayload> {
  let hasEmail = false
  let hasPhone = false
  const rows: Array<{ email?: string; phone?: string }> = []

  for (const c of customers) {
    const row: { email?: string; phone?: string } = {}
    if (typeof c.email === "string" && c.email) {
      row.email = await hashIdentifier("email", c.email)
      hasEmail = true
    }
    if (typeof c.phone === "string" && c.phone) {
      row.phone = await hashIdentifier("phone", c.phone)
      hasPhone = true
    }
    if (row.email || row.phone) rows.push(row)
  }

  const schema: string[] = []
  if (hasEmail) schema.push("EMAIL_SHA256")
  if (hasPhone) schema.push("PHONE_SHA256")

  // Build positional data rows aligned to the schema columns (null where absent).
  const data: Array<Array<string | null>> = rows.map((r) => {
    const cols: Array<string | null> = []
    if (hasEmail) cols.push(r.email ?? null)
    if (hasPhone) cols.push(r.phone ?? null)
    return cols
  })

  return { schema, data, rowCount: rows.length }
}

// ─── Cross-app envelope type ───────────────────────────────────────────────────
//
// The K4 contract lives in @liaison/app-sdk, NOT on AppContext: the ctx below
// types `executeTool` with it.

export type { CrossAppEnvelope }

export interface CrossAppCtx {
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
  connections: unknown
  executeTool?: (target: string, args: Record<string, unknown>) => Promise<CrossAppEnvelope>
  // Injected by the kernel when re-running a gated tool after approval (the
  // edited approval payload). Declared here so the re-entry check needs no
  // type escape. Mirrors app-sdk/src/types.ts AppContext.approval.
  approval?: unknown
}

// ─── OUTCOME_* objective guard ────────────────────────────────────────────────

const LEGACY_OBJECTIVES = new Set([
  "BRAND_AWARENESS",
  "REACH",
  "TRAFFIC",
  "ENGAGEMENT",
  "APP_INSTALLS",
  "VIDEO_VIEWS",
  "LEAD_GENERATION",
  "CONVERSIONS",
  "CATALOG_SALES",
  "STORE_TRAFFIC",
  "MESSAGES",
  "LOCAL_AWARENESS",
  "OFFER_CLAIMS",
  "PAGE_LIKES",
  "POST_ENGAGEMENT",
  "EVENT_RESPONSES",
])

// ─── create_campaign ──────────────────────────────────────────────────────────

export async function create_campaign(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  const { auth, adAccountId } = await getMetaClient(ctx)

  const objective = String(p.objective ?? "")
  if (!objective.startsWith("OUTCOME_") || LEGACY_OBJECTIVES.has(objective)) {
    throw new Error(
      `Invalid campaign objective "${objective}". ` +
        "Meta requires OUTCOME_* objectives (e.g. OUTCOME_SALES, OUTCOME_LEADS, " +
        "OUTCOME_AWARENESS, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_APP_PROMOTION). " +
        "Legacy objectives (CONVERSIONS, TRAFFIC, etc.) are no longer accepted.",
    )
  }

  // special_ad_categories MUST always be present in the POST body — Meta 400s on absence.
  const specialAdCategories = Array.isArray(p.special_ad_categories) ? p.special_ad_categories : []

  const postParams: Record<string, unknown> = {
    name: String(p.name ?? ""),
    objective,
    special_ad_categories: specialAdCategories,
    status: String(p.status ?? "PAUSED"),
  }

  const result = (await metaFetch(ctx.fetch, {
    path: `/${adAccountId}/campaigns`,
    method: "POST",
    params: postParams,
    auth,
  })) as { id?: string }

  return { id: result.id, campaign: result }
}

// ─── create_adset ─────────────────────────────────────────────────────────────

/**
 * Shared checker for create_adset — the only knowable-at-staging rule is the
 * shape of the major-unit budget strings. Both the handler and the manifest
 * `preflight` run THIS function, so they can never drift.
 */
export function preflightCreateAdsetParams(p: Record<string, unknown>): PreflightOutcome {
  if (p.daily_budget !== undefined) {
    const majorAmount = Number(p.daily_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      return refuse(
        "invalid_params",
        `create_adset: invalid daily_budget value "${p.daily_budget}"`,
      )
    }
  } else if (p.lifetime_budget !== undefined) {
    const majorAmount = Number(p.lifetime_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      return refuse(
        "invalid_params",
        `create_adset: invalid lifetime_budget value "${p.lifetime_budget}"`,
      )
    }
  }
  return { ok: true }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. An unparseable budget string only failed after the approver clicked
// approve; now it is refused at the call site, where the agent can fix it.
export async function create_adset_preflight(params: unknown): Promise<unknown> {
  return toPreflightResult(preflightCreateAdsetParams((params ?? {}) as Record<string, unknown>))
}

export async function create_adset(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  throwIfRefused(preflightCreateAdsetParams(p))
  const { auth, adAccountId } = await getMetaClient(ctx)

  const postParams: Record<string, unknown> = {
    campaign_id: String(p.campaign_id ?? ""),
    name: String(p.name ?? ""),
    optimization_goal: String(p.optimization_goal ?? ""),
    billing_event: String(p.billing_event ?? "IMPRESSIONS"),
    status: String(p.status ?? "PAUSED"),
  }

  // targeting passes through as-is to Meta
  if (p.targeting !== undefined) {
    postParams.targeting = p.targeting
  }

  // Budget — agent supplies MAJOR units (e.g. "50.00"); convert to integer minor
  // units via the account-currency exponent, exactly like update_budget. Standardized
  // major-in → minor-to-Meta across ALL budget tools (no per-tool unit divergence).
  const currency = String(p.currency ?? "EUR")
  if (p.daily_budget !== undefined) {
    const majorAmount = Number(p.daily_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      throw new Error(`create_adset: invalid daily_budget value "${p.daily_budget}"`)
    }
    postParams.daily_budget = toMinorUnits(majorAmount, currency)
  } else if (p.lifetime_budget !== undefined) {
    const majorAmount = Number(p.lifetime_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      throw new Error(`create_adset: invalid lifetime_budget value "${p.lifetime_budget}"`)
    }
    postParams.lifetime_budget = toMinorUnits(majorAmount, currency)
  }

  const result = (await metaFetch(ctx.fetch, {
    path: `/${adAccountId}/adsets`,
    method: "POST",
    params: postParams,
    auth,
  })) as { id?: string }

  return { id: result.id, adset: result }
}

// ─── create_ad ────────────────────────────────────────────────────────────────

export async function create_ad(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  const { auth, adAccountId } = await getMetaClient(ctx)

  const postParams: Record<string, unknown> = {
    adset_id: String(p.adset_id ?? ""),
    name: String(p.name ?? ""),
    creative: { creative_id: String(p.creative_id ?? "") },
    status: String(p.status ?? "PAUSED"),
  }

  const result = (await metaFetch(ctx.fetch, {
    path: `/${adAccountId}/ads`,
    method: "POST",
    params: postParams,
    auth,
  })) as { id?: string }

  return { id: result.id, ad: result }
}

// ─── create_creative ──────────────────────────────────────────────────────────

export async function create_creative(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  const { auth, adAccountId } = await getMetaClient(ctx)

  // PRE-VALIDATE carousel: child_attachments must have at least 2 items
  const assetFeedSpec = p.asset_feed_spec as Record<string, unknown> | undefined
  if (assetFeedSpec !== undefined) {
    const childAttachments = assetFeedSpec.child_attachments
    if (Array.isArray(childAttachments) && childAttachments.length < 2) {
      throw new Error(
        `carousel requires at least 2 images but ${childAttachments.length} provided. ` +
          "Add more images to the asset_feed_spec.child_attachments array. " +
          "[CAROUSEL_IMAGE]",
      )
    }
  }

  const postParams: Record<string, unknown> = {
    object_story_spec: p.object_story_spec,
  }

  if (p.page_id !== undefined) {
    postParams.page_id = p.page_id
  }

  if (assetFeedSpec !== undefined) {
    postParams.asset_feed_spec = assetFeedSpec
  }

  const result = (await metaFetch(ctx.fetch, {
    path: `/${adAccountId}/adcreatives`,
    method: "POST",
    params: postParams,
    auth,
  })) as { id?: string }

  return { id: result.id, creative: result }
}

// ─── upload_image ─────────────────────────────────────────────────────────────

// Base64-encoded image bytes threshold: source image > ~740 KB → base64 > ~985000 chars
const IMAGE_BYTES_LIMIT = 985_000

export async function upload_image(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  const imageBytes = String(p.image_bytes ?? "")

  // PRE-CHECK: reject oversized images before calling Meta
  if (imageBytes.length > IMAGE_BYTES_LIMIT) {
    throw new Error(
      `Image too large: base64 payload is ${imageBytes.length} chars ` +
        `(source exceeds ~740 KB). Compress or resize the image first. ` +
        "Use media_list to discover existing images in the account. [media_list]",
    )
  }

  const { auth, adAccountId } = await getMetaClient(ctx)

  const postParams: Record<string, unknown> = {
    bytes: imageBytes,
  }
  if (p.filename) {
    postParams.name = String(p.filename)
  }

  const result = (await metaFetch(ctx.fetch, {
    path: `/${adAccountId}/adimages`,
    method: "POST",
    params: postParams,
    auth,
  })) as { images?: Record<string, { hash?: string }> }

  // Extract image_hash from Meta response envelope
  const images = result.images ?? {}
  const firstKey = Object.keys(images)[0]
  const imageHash = firstKey ? images[firstKey]?.hash : undefined

  return { image_hash: imageHash, images: result.images }
}

// ─── update_budget ────────────────────────────────────────────────────────────

/**
 * Shared checker for update_budget. `isReEntry` mirrors the handler's existing
 * skip: on the post-approval re-run the edited payload may legitimately carry
 * neither budget field. The manifest `preflight` always passes false (nothing
 * has been approved yet at staging).
 */
export function preflightUpdateBudgetParams(
  p: Record<string, unknown>,
  isReEntry: boolean,
): PreflightOutcome {
  const objectId = String(p.object_id ?? "")
  if (!objectId) {
    return refuse("invalid_params", "update_budget: object_id is required")
  }

  if (!isReEntry) {
    if (p.daily_budget === undefined && p.lifetime_budget === undefined) {
      return refuse("invalid_params", "update_budget: provide daily_budget or lifetime_budget")
    }
  }

  if (!p.currency) {
    return refuse(
      "invalid_params",
      "update_budget: currency is required. Call account_info first to get the account currency " +
        "(major→minor unit conversion differs per currency, e.g. JPY has 0 decimals).",
    )
  }

  if (p.daily_budget !== undefined) {
    const majorAmount = Number(p.daily_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      return refuse(
        "invalid_params",
        `update_budget: invalid daily_budget value "${p.daily_budget}"`,
      )
    }
  }
  if (p.lifetime_budget !== undefined) {
    const majorAmount = Number(p.lifetime_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      return refuse(
        "invalid_params",
        `update_budget: invalid lifetime_budget value "${p.lifetime_budget}"`,
      )
    }
  }

  return { ok: true }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. A budget change with no amount, or with no account currency, used to
// reach the approver and then fail in the handler.
export async function update_budget_preflight(params: unknown): Promise<unknown> {
  return toPreflightResult(
    preflightUpdateBudgetParams((params ?? {}) as Record<string, unknown>, false),
  )
}

export async function update_budget(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>

  // Check for re-entry via approval field — skip re-validation on re-entry
  const isReEntry = Boolean(ctx.approval)

  // Validate BEFORE touching the connection or Meta — same shared checker the
  // manifest preflight runs, so the two can never drift.
  throwIfRefused(preflightUpdateBudgetParams(p, isReEntry))

  const { auth } = await getMetaClient(ctx)

  const level = String(p.level ?? "adset") as "campaign" | "adset"
  const objectId = String(p.object_id ?? "")

  if (!objectId) {
    throw new Error("update_budget: object_id is required")
  }

  // Build budget params — convert major-unit → minor units
  // The agent passes major-unit strings or numbers (e.g. "50.00" or 50)
  const postParams: Record<string, unknown> = {}

  if (!isReEntry) {
    if (p.daily_budget === undefined && p.lifetime_budget === undefined) {
      throw new Error("update_budget: provide daily_budget or lifetime_budget")
    }
  }

  // Currency is REQUIRED — no silent EUR default. A wrong assumption silently
  // mis-converts budgets for non-EUR / zero-decimal accounts (JPY 500 → 50000).
  // The agent must read account_info first and pass the real currency.
  if (!p.currency) {
    throw new Error(
      "update_budget: currency is required: call account_info first to get the account currency " +
        "(major→minor unit conversion differs per currency, e.g. JPY has 0 decimals).",
    )
  }
  const currency = String(p.currency)

  if (p.daily_budget !== undefined) {
    const majorAmount = Number(p.daily_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      throw new Error(`update_budget: invalid daily_budget value "${p.daily_budget}"`)
    }
    postParams.daily_budget = toMinorUnits(majorAmount, currency)
  }

  if (p.lifetime_budget !== undefined) {
    const majorAmount = Number(p.lifetime_budget)
    if (!Number.isFinite(majorAmount) || majorAmount <= 0) {
      throw new Error(`update_budget: invalid lifetime_budget value "${p.lifetime_budget}"`)
    }
    postParams.lifetime_budget = toMinorUnits(majorAmount, currency)
  }

  try {
    const result = await metaFetch(ctx.fetch, {
      path: `/${objectId}`,
      method: "POST",
      params: postParams,
      auth,
    })

    return {
      success: true,
      level,
      object_id: objectId,
      applied: postParams,
      meta_response: result,
    }
  } catch (err) {
    if (err instanceof BudgetCapError) {
      // Surface budget-change cap clearly — no retry
      throw new Error(
        `Meta limits budget changes to ~4/hour on this ad set (error 613+1487632). ` +
          `Wait ~1 hour before retrying. Original error: ${err.message}`,
      )
    }
    throw err
  }
}

// ─── set_status ───────────────────────────────────────────────────────────────

export async function set_status(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  const { auth } = await getMetaClient(ctx)

  const objectId = String(p.object_id ?? "")
  const status = String(p.status ?? "")

  if (!objectId) throw new Error("set_status: object_id is required")
  if (status !== "ACTIVE" && status !== "PAUSED") {
    throw new Error(`set_status: status must be ACTIVE or PAUSED, got "${status}"`)
  }

  await metaFetch(ctx.fetch, {
    path: `/${objectId}`,
    method: "POST",
    params: { status },
    auth,
  })

  // Re-read effective_status after execution
  const refreshed = (await metaFetch(ctx.fetch, {
    path: `/${objectId}`,
    method: "GET",
    params: { fields: "id,status,effective_status" },
    auth,
  })) as { id?: string; status?: string; effective_status?: string }

  return {
    object_id: objectId,
    requested_status: status,
    status: refreshed.status,
    effective_status: refreshed.effective_status,
  }
}

// ─── create_custom_audience ───────────────────────────────────────────────────

/**
 * Shared checker for create_custom_audience — EVERY rule that is knowable from
 * the params plus the ctx capabilities, in one place, run by both the handler
 * and the manifest `preflight`.
 *
 * The `ctx.executeTool` check is the load-bearing one: it used to sit AFTER the
 * audience had already been POSTed to Meta, so a call made without cross-app
 * calls enabled left an ORPHAN empty audience on the live ad account.
 */
export function preflightCreateCustomAudienceParams(
  p: Record<string, unknown>,
  ctx: Pick<CrossAppCtx, "executeTool">,
): PreflightOutcome<{ purpose?: AudiencePurpose }> {
  const subtype = String(p.subtype ?? "")

  if (subtype === "CUSTOMER_LIST") {
    const purposeCheck = checkAudiencePurpose(p, "create_custom_audience")
    if (!("ok" in purposeCheck)) return purposeCheck

    if (!p.shopify_customer_query) {
      return refuse(
        "invalid_params",
        "create_custom_audience (CUSTOMER_LIST): shopify_customer_query is required",
      )
    }
    if (!ctx.executeTool) {
      return refuse(
        "invalid_params",
        "create_custom_audience: ctx.executeTool not available (cross-app calls not enabled)",
      )
    }
    return { ok: true, purpose: purposeCheck.purpose }
  }

  if (subtype === "WEBSITE") {
    if (!String(p.pixel_id ?? "")) {
      return refuse("invalid_params", "create_custom_audience (WEBSITE): pixel_id is required")
    }
    return { ok: true }
  }

  if (subtype === "ENGAGEMENT") return { ok: true }

  return refuse(
    "invalid_params",
    `create_custom_audience: unknown subtype "${subtype}". ` +
      "Expected CUSTOMER_LIST, WEBSITE, or ENGAGEMENT.",
  )
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. This tool POSTs a real audience to the live ad account before it
// ever reached its later guards, so an incomplete approved call left an empty
// orphan audience behind. Refuse it at staging instead.
export async function create_custom_audience_preflight(
  params: unknown,
  ctx: CrossAppCtx,
): Promise<unknown> {
  return toPreflightResult(
    preflightCreateCustomAudienceParams((params ?? {}) as Record<string, unknown>, ctx),
  )
}

export async function create_custom_audience(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  // EVERY knowable check runs BEFORE any Meta call: an audience POSTed and then
  // abandoned on a later failure is an orphan on the live ad account.
  throwIfRefused(preflightCreateCustomAudienceParams(p, ctx))

  const { auth, adAccountId } = await getMetaClient(ctx)
  const subtype = String(p.subtype ?? "") as "CUSTOMER_LIST" | "WEBSITE" | "ENGAGEMENT"
  const name = String(p.name ?? "")

  if (subtype === "CUSTOMER_LIST") {
    const customerFileSource = String(p.customer_file_source ?? "USER_PROVIDED_ONLY")
    const shopifyQuery = p.shopify_customer_query as Record<string, unknown> | undefined
    const audiencePurpose = throwIfRefused(
      checkAudiencePurpose(p, "create_custom_audience"),
    ).purpose

    if (!shopifyQuery) {
      throw new Error("create_custom_audience (CUSTOMER_LIST): shopify_customer_query is required")
    }

    // The cross-app capability is required to fill this audience — checked here
    // too (never only inside the preflight) and BEFORE the audience POST.
    if (!ctx.executeTool) {
      throw new Error(
        "create_custom_audience: ctx.executeTool not available (cross-app calls not enabled)",
      )
    }

    // Step 1: create the audience
    const audienceResult = (await metaFetch(ctx.fetch, {
      path: `/${adAccountId}/customaudiences`,
      method: "POST",
      params: { name, subtype: "CUSTOMER_LIST", customer_file_source: customerFileSource },
      auth,
    })) as { id?: string }

    const audienceId = audienceResult.id
    if (!audienceId) throw new Error("create_custom_audience: Meta did not return audience id")

    // Step 2: pull customers from Shopify
    if (!ctx.executeTool) {
      throw new Error(
        "create_custom_audience: ctx.executeTool not available, cross-app calls are not enabled",
      )
    }
    // MUST pass plain object — NOT pre-stringified JSON (sandbox __wrap auto-stringifies)
    const envelope = await ctx.executeTool("shopify:customers_search", shopifyQuery)

    if (envelope.status === "error") {
      throw new Error(`Shopify customers_search failed: ${envelope.error.message}`)
    }
    if (envelope.status === "pending_approval") {
      throw new Error("Shopify customers_search requires approval, cannot proceed")
    }

    // Step 2.5: consent-join enforcement (SC 8, section 5.4) — BEFORE
    // buildAudiencePayload/hash+upload. Default-deny: any email lacking a
    // purpose-appropriate consent record is dropped, never uploaded.
    const pulledCustomers = extractCustomers(envelope.result)
    const { customers: consentedCustomers, outcome } = await applyConsentJoin(
      audiencePurpose,
      pulledCustomers,
      ctx,
    )

    // Step 3: extract + hash identifiers PER TYPE — NEVER send raw PII to Meta,
    // and NEVER label a phone hash as EMAIL_SHA256 (Meta matches positionally).
    const payload = await buildAudiencePayload(consentedCustomers)

    // Step 4: upload hashed users to Meta with the per-identifier schema
    if (payload.rowCount > 0) {
      await metaFetch(ctx.fetch, {
        path: `/${audienceId}/users`,
        method: "POST",
        params: {
          payload: {
            schema: payload.schema,
            data: payload.data,
          },
        },
        auth,
      })
    }

    return {
      audience_id: audienceId,
      subtype: "CUSTOMER_LIST",
      audience_purpose: audiencePurpose,
      users_hashed: payload.rowCount,
      schema: payload.schema,
      raw_pii_sent: false,
      ...outcome,
    }
  }

  if (subtype === "WEBSITE") {
    const pixelId = String(p.pixel_id ?? "")
    if (!pixelId) throw new Error("create_custom_audience (WEBSITE): pixel_id is required")

    const result = (await metaFetch(ctx.fetch, {
      path: `/${adAccountId}/customaudiences`,
      method: "POST",
      params: {
        name,
        subtype: "WEBSITE",
        pixel_id: pixelId,
        rule: p.rule,
        retention_days: p.retention_days,
      },
      auth,
    })) as { id?: string }

    return { audience_id: result.id, subtype: "WEBSITE" }
  }

  if (subtype === "ENGAGEMENT") {
    const result = (await metaFetch(ctx.fetch, {
      path: `/${adAccountId}/customaudiences`,
      method: "POST",
      params: {
        name,
        subtype: "ENGAGEMENT",
        object_type: p.object_type,
        source_id: p.source_id,
        engagement_type: p.engagement_type,
        retention_days: p.retention_days,
      },
      auth,
    })) as { id?: string }

    return { audience_id: result.id, subtype: "ENGAGEMENT" }
  }

  throw new Error(
    `create_custom_audience: unknown subtype "${subtype}". ` +
      "Expected CUSTOMER_LIST, WEBSITE, or ENGAGEMENT.",
  )
}

// ─── create_lookalike_audience ────────────────────────────────────────────────

export async function create_lookalike_audience(
  params: unknown,
  ctx: CrossAppCtx,
): Promise<unknown> {
  const p = params as Record<string, unknown>
  const { auth, adAccountId } = await getMetaClient(ctx)

  const sourceAudienceId = String(p.source_audience_id ?? "")
  const country = String(p.country ?? "")
  const ratio = Number(p.ratio ?? 1)
  const valueBased = Boolean(p.value_based)

  if (!sourceAudienceId)
    throw new Error("create_lookalike_audience: source_audience_id is required")
  if (!country) throw new Error("create_lookalike_audience: country is required")
  if (ratio < 1 || ratio > 10) throw new Error("create_lookalike_audience: ratio must be 1-10")

  const audienceName = `Lookalike (${country}, ${ratio}%) from ${sourceAudienceId}`

  const createLookalike = async (type: "value_based" | "similarity") => {
    return (await metaFetch(ctx.fetch, {
      path: `/${adAccountId}/customaudiences`,
      method: "POST",
      params: {
        name: audienceName,
        subtype: "LOOKALIKE",
        origin_audience_id: sourceAudienceId,
        lookalike_spec: {
          country,
          ratio: ratio / 100,
          type,
        },
      },
      auth,
    })) as { id?: string }
  }

  // Honor value_based when requested: ATTEMPT it. Only fall back to a plain
  // similarity lookalike if Meta actually rejects it (the source carries no
  // value/LTV field) — never downgrade unconditionally.
  if (valueBased) {
    try {
      const result = await createLookalike("value_based")
      return {
        audience_id: result.id,
        subtype: "LOOKALIKE",
        source_audience_id: sourceAudienceId,
        country,
        ratio,
        value_based: true,
      }
    } catch (err) {
      // Meta declines value-based when the source has no value data (a ParamError,
      // code 100). Fall back to a plain similarity lookalike + honest-decline note.
      if (err instanceof ParamError) {
        const fallback = await createLookalike("similarity")
        return {
          audience_id: fallback.id,
          subtype: "LOOKALIKE",
          source_audience_id: sourceAudienceId,
          country,
          ratio,
          value_based: false,
          honest_decline:
            "Value-based lookalike was requested but the source audience carries no " +
            `purchase-value/LTV data (Meta: ${err.message}), so a plain similarity ` +
            "lookalike instead.",
        }
      }
      throw err
    }
  }

  const result = await createLookalike("similarity")
  return {
    audience_id: result.id,
    subtype: "LOOKALIKE",
    source_audience_id: sourceAudienceId,
    country,
    ratio,
    value_based: false,
  }
}

// ─── add_users_to_audience ────────────────────────────────────────────────────

/** Shared checker for add_users_to_audience, run by both the handler and the preflight. */
export function preflightAddUsersToAudienceParams(
  p: Record<string, unknown>,
  ctx: Pick<CrossAppCtx, "executeTool">,
): PreflightOutcome {
  if (!String(p.audience_id ?? "")) {
    return refuse("invalid_params", "add_users_to_audience: audience_id is required")
  }
  if (!p.shopify_customer_query) {
    return refuse("invalid_params", "add_users_to_audience: shopify_customer_query is required")
  }
  const purposeCheck = checkAudiencePurpose(p, "add_users_to_audience")
  if (!("ok" in purposeCheck)) return purposeCheck
  if (!ctx.executeTool) {
    return refuse("invalid_params", "add_users_to_audience: ctx.executeTool not available")
  }
  return { ok: true }
}

// WHY: a gated call must not be parked for a human when the data it needs is
// missing. A PII upload with no audience, no query or no consent domain used to
// reach the approver and only then refuse.
export async function add_users_to_audience_preflight(
  params: unknown,
  ctx: CrossAppCtx,
): Promise<unknown> {
  return toPreflightResult(
    preflightAddUsersToAudienceParams((params ?? {}) as Record<string, unknown>, ctx),
  )
}

export async function add_users_to_audience(params: unknown, ctx: CrossAppCtx): Promise<unknown> {
  const p = params as Record<string, unknown>
  throwIfRefused(preflightAddUsersToAudienceParams(p, ctx))

  const { auth } = await getMetaClient(ctx)

  const audienceId = String(p.audience_id ?? "")
  if (!audienceId) throw new Error("add_users_to_audience: audience_id is required")

  const shopifyQuery = p.shopify_customer_query as Record<string, unknown> | undefined
  if (!shopifyQuery) throw new Error("add_users_to_audience: shopify_customer_query is required")

  const audiencePurpose = throwIfRefused(checkAudiencePurpose(p, "add_users_to_audience")).purpose

  if (!ctx.executeTool) {
    throw new Error("add_users_to_audience: ctx.executeTool not available")
  }

  // MUST pass plain object — sandbox __wrap auto-stringifies on the way in
  const envelope = await ctx.executeTool("shopify:customers_search", shopifyQuery)

  if (envelope.status === "error") {
    throw new Error(`Shopify customers_search failed: ${envelope.error.message}`)
  }
  if (envelope.status === "pending_approval") {
    throw new Error("Shopify customers_search requires approval, cannot proceed")
  }

  // Consent-join enforcement (SC 8, section 5.4) — BEFORE
  // buildAudiencePayload/hash+upload. Default-deny: any email lacking a
  // purpose-appropriate consent record is dropped, never uploaded.
  const pulledCustomers = extractCustomers(envelope.result)
  const { customers: consentedCustomers, outcome } = await applyConsentJoin(
    audiencePurpose,
    pulledCustomers,
    ctx,
  )

  // Hash identifiers PER TYPE — NEVER send raw PII; phone→PHONE_SHA256, email→EMAIL_SHA256
  const payload = await buildAudiencePayload(consentedCustomers)

  // APPEND endpoint — this is NOT a replace; it adds users to the existing audience
  if (payload.rowCount > 0) {
    await metaFetch(ctx.fetch, {
      path: `/${audienceId}/users`,
      method: "POST",
      params: {
        payload: {
          schema: payload.schema,
          data: payload.data,
        },
      },
      auth,
    })
  }

  return {
    audience_id: audienceId,
    audience_purpose: audiencePurpose,
    users_added: payload.rowCount,
    schema: payload.schema,
    raw_pii_sent: false,
    append_only: true,
    ...outcome,
  }
}
