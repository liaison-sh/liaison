// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure summarizer functions — each takes unknown params and returns a card
// descriptor for the approval UI. No imports required: these are pure-value
// transformations only.

// ─── Card descriptor type ─────────────────────────────────────────────────────

export interface SummaryCard {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (v === null || v === undefined) return ""
  return String(v)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Currency exponent table — kept local so the summarizer stays a pure value
// transform (no coupling to the HTTP client). Mirrors lib/meta-client.ts
// CURRENCY_EXPONENT so the approval card can echo the SAME computed minor-unit
// value the handler will send to Meta, making the major→minor conversion
// auditable on the card (removes the major/minor visual mismatch).
const CURRENCY_EXPONENT_MINOR: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  MGA: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
}

/** Convert a major-unit amount to integer minor units for the given currency. */
function toMinorForCard(major: number, currency: string): number {
  const exp = CURRENCY_EXPONENT_MINOR[currency.toUpperCase()] ?? 2
  return Math.round(major * 10 ** exp)
}

/**
 * Render a budget line echoing MAJOR + computed MINOR + currency so the
 * conversion is auditable on the approval card, e.g.
 *   "50.00 USD/day = 5000 minor units (cents)"
 * When no currency is known, fall back to the major-only label.
 */
function budgetEchoLine(major: number, currency: string, suffix: string): string {
  const majorStr = `${major.toFixed(2)}${currency ? ` ${currency}` : ""}${suffix}`
  if (!currency) return `${majorStr} (major units)`
  const minor = toMinorForCard(major, currency)
  return `${majorStr} (major units) = ${minor} minor units sent to Meta`
}

// Audience latency disclosure — included in every audience write summarizer.
const AUDIENCE_POPULATION_DISCLOSURE =
  "⚠ Audience must populate/match before delivery: not immediately usable. " +
  "Population latency: CUSTOMER_LIST/ENGAGEMENT ~24 h, WEBSITE pixel ~1-2 h, " +
  "LOOKALIKE up to 6-24 h after source populates."

// ─── Summarizers ─────────────────────────────────────────────────────────────

export function summarizeCampaign(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const name = str(p.name) || "(unnamed campaign)"
  const objective = str(p.objective) || "unset"
  const status = str(p.status) || "PAUSED"
  const cats =
    Array.isArray(p.special_ad_categories) && p.special_ad_categories.length > 0
      ? (p.special_ad_categories as unknown[]).map(str).join(", ")
      : "none"
  return {
    kind: "create_campaign",
    title: `Create campaign: ${name} (${objective})`,
    lines: [`Status: ${status}`, `Special ad categories: ${cats}`, ...experimentLines(params)],
  }
}

export function summarizeAdset(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const name = str(p.name) || "(unnamed ad set)"
  const campaignId = str(p.campaign_id) || "-"
  const goal = str(p.optimization_goal) || "-"
  const billing = str(p.billing_event) || "-"
  const status = str(p.status) || "PAUSED"

  // Budget params arrive in MAJOR units (same contract as update_budget) — echo
  // major + the computed minor-unit value + currency so the conversion is
  // auditable on the card (no /100 rescale, no hardcoded currency symbol). The
  // currency is the account currency (resolved by the handler at POST time via
  // account_info; the agent should pass it through so the card can show the minor).
  const currency = str(p.currency) || ""
  let budgetLabel = "no budget set"
  let subtitle: string | undefined
  if (p.daily_budget !== undefined) {
    budgetLabel = budgetEchoLine(num(p.daily_budget), currency, "/day")
    subtitle = `Budget: ${budgetLabel}`
  } else if (p.lifetime_budget !== undefined) {
    budgetLabel = budgetEchoLine(num(p.lifetime_budget), currency, " lifetime")
    subtitle = `Budget: ${budgetLabel}`
  }

  return {
    kind: "create_adset",
    title: `Create ad set: ${name}`,
    subtitle,
    lines: [
      `Campaign: ${campaignId}`,
      `Optimization: ${goal} | Billing: ${billing}`,
      `Status: ${status}`,
      `Budget: ${budgetLabel}`,
      ...experimentLines(params),
    ],
  }
}

export function summarizeAd(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const name = str(p.name) || "(unnamed ad)"
  const adsetId = str(p.adset_id) || "-"
  const creativeId = str(p.creative_id) || "-"
  const status = str(p.status) || "PAUSED"
  return {
    kind: "create_ad",
    title: `Create ad: ${name} (adset: ${adsetId})`,
    lines: [`Creative: ${creativeId}`, `Status: ${status}`],
  }
}

export function summarizeCreative(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const assetFeed = p.asset_feed_spec as Record<string, unknown> | undefined
  const childAttachments = assetFeed?.child_attachments
  const assetImages = assetFeed?.images

  let creativeType = "single"
  if (Array.isArray(childAttachments) && childAttachments.length >= 2) {
    creativeType = "carousel"
  } else if (Array.isArray(assetImages) || assetFeed?.videos !== undefined) {
    creativeType = "dynamic"
  }

  const storySpec = p.object_story_spec as Record<string, unknown> | undefined
  const pageId = str(p.page_id) || str(storySpec?.page_id) || "-"

  return {
    kind: "create_creative",
    title: `Create creative: ${creativeType}`,
    lines: [
      `Page: ${pageId}`,
      `Type: ${creativeType}`,
      ...(creativeType === "carousel"
        ? [`Carousel cards: ${(childAttachments as unknown[]).length}`]
        : []),
    ],
  }
}

export function summarizeUploadImage(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const filename = str(p.filename) || "(unnamed)"
  const bytes = typeof p.image_bytes === "string" ? p.image_bytes.length : 0
  const approxKb = Math.round(bytes / 1024)
  return {
    kind: "upload_image",
    title: "Upload image to ad account",
    lines: [`Filename: ${filename}`, `Base64 size: ~${approxKb} KB`],
  }
}

export function summarizeBudget(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const level = str(p.level) || "adset"
  const objectId = str(p.object_id) || "-"
  // Use the account currency the agent passed (update_budget requires `currency`).
  // Echo major + computed minor so the conversion is auditable — never hardcode €.
  const currency = str(p.currency) || ""

  let budgetDisplay = "-"
  let editHint = ""
  if (p.daily_budget !== undefined) {
    budgetDisplay = budgetEchoLine(num(p.daily_budget), currency, "/day")
    editHint = "(editable, widget:text)"
  } else if (p.lifetime_budget !== undefined) {
    budgetDisplay = budgetEchoLine(num(p.lifetime_budget), currency, " lifetime")
    editHint = "(editable, widget:text)"
  }

  const title = `Update ${level} budget: ${budgetDisplay}`

  return {
    kind: "update_budget",
    title,
    subtitle: `${level} ${objectId}`,
    lines: [
      `Level: ${level}`,
      `Object: ${objectId}`,
      `New budget: ${budgetDisplay} ${editHint}`.trim(),
      ...experimentLines(params),
    ],
  }
}

export function summarizeSetStatus(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const objectId = str(p.object_id) || "-"
  const status = str(p.status) || "-"
  return {
    kind: "set_status",
    title: `Set status: ${objectId} → ${status}`,
    lines: [
      `Object: ${objectId}`,
      `New status: ${status}`,
      // Experiment design only rides the card for the spend-increasing
      // direction (ACTIVE/resume) — a PAUSED-target set_status still uses
      // this summarizer defensively, but the tool itself only accepts an
      // `experiment` param meaningfully when resuming.
      ...(status === "ACTIVE" ? experimentLines(params) : []),
    ],
  }
}

export function summarizeCustomAudience(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const subtype = str(p.subtype) || "-"
  const name = str(p.name) || "(unnamed audience)"

  const lines: string[] = [`Name: ${name}`, `Subtype: ${subtype}`]

  if (subtype === "CUSTOMER_LIST") {
    const source = str(p.customer_file_source) || "-"
    lines.push(`Source: ${source}`)
    lines.push("Emails/phones will be hashed (SHA-256) host-side. Raw PII is never sent to Meta.")
  } else if (subtype === "WEBSITE") {
    const pixelId = str(p.pixel_id) || "-"
    const retention = num(p.retention_days)
    lines.push(`Pixel: ${pixelId}`)
    lines.push(`Retention: ${retention} days`)
  } else if (subtype === "ENGAGEMENT") {
    const objectType = str(p.object_type) || "-"
    const sourceId = str(p.source_id) || "-"
    const engagementType = str(p.engagement_type) || "-"
    const retention = num(p.retention_days)
    lines.push(`Object type: ${objectType} (${sourceId})`)
    lines.push(`Engagement: ${engagementType}, retention: ${retention} days`)
  }

  lines.push(AUDIENCE_POPULATION_DISCLOSURE)

  return {
    kind: "create_custom_audience",
    title: `Create custom audience: ${subtype}`,
    subtitle: name,
    lines,
  }
}

export function summarizeLookalike(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const sourceId = str(p.source_audience_id) || "-"
  const country = str(p.country) || "-"
  const ratio = num(p.ratio)
  const valueBased = Boolean(p.value_based)

  const lines: string[] = [
    `Source audience: ${sourceId}`,
    `Country: ${country}`,
    `Ratio: ${ratio}% (top ${ratio}% of population)`,
    `Value-based: ${valueBased ? "requested (falls back to similarity if source lacks value data)" : "no"}`,
    AUDIENCE_POPULATION_DISCLOSURE,
  ]

  return {
    kind: "create_lookalike_audience",
    title: `Create lookalike audience: ${ratio}%`,
    subtitle: `${country}, source ${sourceId}`,
    lines,
  }
}

// ─── Experiment-design ride-along (§5.2) ──────────────────────────────────────
//
// When a gated spend tool's params carry an optional `experiment` object,
// append an "Experiment" block to the card so the human approving the SPEND
// sees the DESIGN in the same approval. Summarizers are pure and cannot read
// ctx.db, so the design fields travel as params (the agent copies them from
// the experiment_open call, or from experiment_list before opening a new one).

interface ExperimentDesign {
  experiment_id?: string
  title?: string
  hypothesis?: string
  metric_tier?: string
  minimum_sample?: number
  decision_date?: string
}

function experimentLines(params: unknown): string[] {
  const p = params as Record<string, unknown>
  const exp = p.experiment as ExperimentDesign | undefined
  if (!exp || typeof exp !== "object") return []

  const title = str(exp.title) || "(untitled)"
  const hypothesis = str(exp.hypothesis) || "-"
  const tier = str(exp.metric_tier) || "-"
  const minSample = exp.minimum_sample !== undefined ? String(exp.minimum_sample) : "-"
  const decisionDate = str(exp.decision_date) || "-"
  const linkedNote = exp.experiment_id ? ` (linked: ${str(exp.experiment_id)})` : ""

  return [
    `Experiment: ${title}${linkedNote}`,
    `Hypothesis: ${hypothesis}`,
    `Metric tier: ${tier} | Minimum sample: ${minSample} | Decision date: ${decisionDate}`,
  ]
}

export function summarizeManualSpendAdd(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const channel = str(p.channel) || "(unnamed channel)"
  const site = str(p.site)
  const periodStart = str(p.period_start) || "-"
  const periodEnd = str(p.period_end) || "-"
  const amount = num(p.amount)
  const currency = str(p.currency) || ""

  const lines: string[] = [
    `Channel: ${channel}${site ? ` (${site})` : ""}`,
    `Period: ${periodStart} to ${periodEnd}`,
    `Amount: ${amount.toFixed(2)} ${currency}`.trim(),
  ]
  if (str(p.notes)) lines.push(`Notes: ${str(p.notes)}`)

  return {
    kind: "manual_spend_add",
    title: `Record manual spend: ${channel}: ${amount.toFixed(2)} ${currency}`.trim(),
    subtitle: `${periodStart} to ${periodEnd}`,
    lines,
  }
}

export function summarizeDealerProfileUpsert(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const dealerName = str(p.dealer_name) || "(unnamed dealer)"
  const dealerType = str(p.dealer_type) || "-"
  const coverageArea = str(p.coverage_area)

  const lines: string[] = [`Dealer: ${dealerName}`, `Type: ${dealerType}`]
  if (coverageArea) lines.push(`Coverage area: ${coverageArea}`)
  if (str(p.reorder_cadence)) lines.push(`Reorder cadence: ${str(p.reorder_cadence)}`)
  if (str(p.notes)) lines.push(`Notes: ${str(p.notes)}`)

  return {
    kind: "dealer_profile_upsert",
    title: `Upsert dealer profile: ${dealerName}`,
    subtitle: dealerType,
    lines,
  }
}

// ─── Google gated-write summarizers (§5.1) ────────────────────────────────────

export function summarizeGoogleCreateCampaign(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const name = str(p.name) || "(unnamed campaign)"
  const channelType = str(p.advertising_channel_type) || "unset"
  const currency = str(p.currency) || ""
  const budgetLabel =
    p.daily_budget !== undefined
      ? budgetEchoLine(num(p.daily_budget), currency, "/day")
      : "no budget set"

  const biddingStrategy =
    p.bidding_strategy && typeof p.bidding_strategy === "object"
      ? Object.keys(p.bidding_strategy as Record<string, unknown>)[0]
      : undefined

  return {
    kind: "google_create_campaign",
    title: `Create Google campaign: ${name} (${channelType})`,
    subtitle: `Budget: ${budgetLabel}`,
    lines: [
      `Channel type: ${channelType}`,
      `Budget: ${budgetLabel}`,
      `Bidding strategy: ${biddingStrategy ?? "(default for channel type)"}`,
      "Status: PAUSED (campaigns are always created paused, never enabled by an agent)",
      ...experimentLines(params),
    ],
  }
}

export function summarizeGoogleCreateAdgroup(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const name = str(p.name) || "(unnamed ad group)"
  const campaignId = str(p.campaign_id) || "-"
  return {
    kind: "google_create_adgroup",
    title: `Create Google ad group: ${name}`,
    lines: [`Campaign: ${campaignId}`, "Status: PAUSED", ...experimentLines(params)],
  }
}

export function summarizeGoogleCreateAd(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const adGroupId = str(p.ad_group_id) || "-"
  const headlines = Array.isArray(p.headlines) ? (p.headlines as unknown[]).map(str) : []
  const descriptions = Array.isArray(p.descriptions) ? (p.descriptions as unknown[]).map(str) : []
  return {
    kind: "google_create_ad",
    title: `Create Google RSA ad (ad group: ${adGroupId})`,
    lines: [
      `Ad group: ${adGroupId}`,
      `Headlines (${headlines.length}): ${headlines.join(" | ") || "-"}`,
      `Descriptions (${descriptions.length}): ${descriptions.join(" | ") || "-"}`,
      "Status: PAUSED",
    ],
  }
}

export function summarizeGoogleUpdateBudget(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const budgetResourceName = str(p.budget_resource_name) || "-"
  const currency = str(p.currency) || ""
  const budgetLabel = p.amount !== undefined ? budgetEchoLine(num(p.amount), currency, "/day") : "-"

  return {
    kind: "google_update_budget",
    title: `Update Google budget: ${budgetLabel}`,
    subtitle: budgetResourceName,
    lines: [
      `Budget resource: ${budgetResourceName}`,
      `New budget: ${budgetLabel}`,
      ...experimentLines(params),
    ],
  }
}

export function summarizeGoogleSetStatus(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const objectId = str(p.object_id) || "-"
  const objectType = str(p.object_type) || "-"
  const status = str(p.status) || "-"
  return {
    kind: "google_set_status",
    title: `Set Google ${objectType} status: ${objectId} → ${status}`,
    lines: [
      `Object: ${objectId} (${objectType})`,
      `New status: ${status}`,
      ...(status === "ENABLED" ? experimentLines(params) : []),
    ],
  }
}

export function summarizeGoogleAddNegativeKeywords(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const adGroupId = str(p.ad_group_id)
  const campaignId = str(p.campaign_id)
  const level = adGroupId ? `ad group ${adGroupId}` : `campaign ${campaignId}`
  const keywords = Array.isArray(p.keywords) ? (p.keywords as Array<Record<string, unknown>>) : []
  const keywordLines = keywords.map((kw) => `${str(kw.text)} (${str(kw.match_type) || "BROAD"})`)

  return {
    kind: "google_add_negative_keywords",
    title: `Add ${keywords.length} negative keyword(s) to ${level}`,
    lines: [
      `Level: ${level}`,
      "⚠ Bulk negatives silently suppress delivery: review every keyword below.",
      ...keywordLines.map((l) => `- ${l}`),
    ],
  }
}

export function summarizeGoogleCreateConversionAction(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const name = str(p.name) || "(unnamed conversion action)"
  const category = str(p.category) || "-"
  const type = str(p.type) || "-"
  return {
    kind: "google_create_conversion_action",
    title: `Create Google conversion action: ${name}`,
    lines: [`Category: ${category}`, `Type: ${type}`],
  }
}

export function summarizeAddUsers(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const audienceId = str(p.audience_id) || "-"
  const query = p.shopify_customer_query as Record<string, unknown> | undefined

  const lines: string[] = [
    `Audience: ${audienceId}`,
    `Query: ${query ? JSON.stringify(query) : "-"}`,
    "Emails/phones hashed (SHA-256) host-side before upload. Raw PII is never sent to Meta.",
    AUDIENCE_POPULATION_DISCLOSURE,
  ]

  return {
    kind: "add_users_to_audience",
    title: `Add users to audience: ${audienceId}`,
    lines,
  }
}

// ─── Pause summarizers (all pauses are gated) ─────────────────────────────────

// Shared caveat echoed on every pause approval card — pausing takes effect on
// approval and does not preserve learning-phase progress.
const PAUSE_DELIVERY_NOTE =
  "Pausing stops delivery immediately on approval and resets learning-phase progress."

/** Collect the object ids a Meta pause targets from either object_id or object_ids[]. */
function metaPauseIds(p: Record<string, unknown>): string[] {
  const ids: string[] = []
  if (typeof p.object_id === "string" && p.object_id) ids.push(p.object_id)
  if (Array.isArray(p.object_ids)) {
    for (const id of p.object_ids) {
      if (typeof id === "string" && id && !ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

export function summarizePause(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const ids = metaPauseIds(p)
  const reason = str(p.reason) || "agent-paused"
  const idList = ids.length > 0 ? ids.join(", ") : "-"

  const lines: string[] =
    ids.length > 0
      ? ids.map((id) => `Object: ${id} | reason: ${reason}`)
      : [`Object: - | reason: ${reason}`]
  lines.push(PAUSE_DELIVERY_NOTE)

  return {
    kind: "pause",
    title: `Pause ${ids.length} Meta object(s)`,
    subtitle: idList,
    lines,
  }
}

export function summarizeGooglePause(params: unknown): SummaryCard {
  const p = params as Record<string, unknown>
  const objectType = str(p.object_type) || "-"
  const reason = str(p.reason) || "agent-paused"
  // Google pauses target a single object; "ad" may arrive as a composite or as
  // ad_group_id + ad_id — surface whichever id the agent passed.
  const objectId =
    str(p.object_id) ||
    (str(p.ad_group_id) && str(p.ad_id) ? `${str(p.ad_group_id)}~${str(p.ad_id)}` : "") ||
    "-"

  return {
    kind: "google_pause",
    title: "Pause 1 Google object(s)",
    subtitle: `${objectType} ${objectId}`,
    lines: [`Object: ${objectId} (${objectType}) | reason: ${reason}`, PAUSE_DELIVERY_NOTE],
  }
}
