// SPDX-License-Identifier: FSL-1.1-ALv2
import { version } from "../../app.manifest.json"
import { currencyExponent } from "../lib/currency-exponent"

/**
 * The sidebar footer's build stamp. It read "Ads v0.1", a hand typed prefix
 * that stopped tracking the app the moment the manifest moved past 0.1.0: the
 * shipped 0.1.25 build still claimed v0.1, so the footer could not tell you
 * which bundle you were looking at, which is the only thing it is there for.
 * The manifest is the version, so the manifest is what it reads.
 */
// A NAMED import, not the whole manifest: the default import would pull the
// agent instructions and every tool schema into the UI bundle, where the
// bundler can drop an unused named export instead.
export const APP_VERSION: string = version
export const APP_VERSION_LABEL = `Ads v${APP_VERSION}`

export type BadgeTone = "success" | "warning" | "error" | "muted" | "neutral"

export function effectiveStatusTone(effectiveStatus: string): BadgeTone {
  // Maps Meta effective_status to a delivery tone.
  switch (effectiveStatus) {
    case "ACTIVE":
      return "success"
    case "CAMPAIGN_PAUSED":
    case "PAUSED":
    case "ADSET_PAUSED":
    case "AD_PAUSED":
    case "ARCHIVED":
    case "DELETED":
      return "muted"
    case "DISAPPROVED":
    case "WITH_ISSUES":
      return "error"
    case "PENDING_REVIEW":
    case "IN_PROCESS":
    case "PREAPPROVED":
    case "PENDING_BILLING_INFO":
      return "warning"
    default:
      return "neutral"
  }
}

export function formatMoney(value: number | string | null, currency?: string): string {
  if (value === null || value === undefined) return "-"
  const n = typeof value === "string" ? parseFloat(value) : value
  if (!isFinite(n)) return "-"
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currency ?? "USD",
    minimumFractionDigits: currencyExponent(currency ?? "USD") === 0 ? 0 : 2,
    maximumFractionDigits: currencyExponent(currency ?? "USD") === 0 ? 0 : 2,
  }).format(n)
}

export function budgetMinorToMajor(raw: string | number | null, currency: string): number | null {
  if (raw === null || raw === undefined || raw === "") return null
  const n = typeof raw === "string" ? parseFloat(raw) : raw
  if (!isFinite(n)) return null
  const exp = currencyExponent(currency)
  return n / 10 ** exp
}

export interface InsightRow {
  [key: string]: unknown
}

interface InsightsResult {
  data?: unknown[]
  _split?: boolean
}

/**
 * Insight rows out of an `insights_query` answer, split groups flattened.
 *
 * Every read goes through `toolRows`, so a not-connected envelope, a failed
 * read (null) or a payload whose `data` is not an array all read as "no rows"
 * instead of throwing. A deployment with no Meta connection answers HTTP 200
 * with `{ error: { code: "meta_not_connected" } }` as the tool's DATA, and the
 * old direct `(r.data as InsightRow[])[0]` read that as undefined and crashed
 * the dashboard on both tiers.
 */
export function insightRows(result: unknown): InsightRow[] {
  const data = toolData(result as InsightsResult | null | undefined)
  if (!data) return []
  if (!data._split) return toolRows<InsightRow>(data)
  // _split:true means data items are {breakdowns, data} sub-groups
  const out: InsightRow[] = []
  for (const group of toolRows<{ data?: InsightRow[] }>(data)) {
    for (const row of group?.data ?? []) out.push(row)
  }
  return out
}

export function flattenInsights(result: InsightsResult | null | undefined): InsightRow[] {
  return insightRows(result)
}

export function audienceCountLabel(lower: number | null, upper: number | null): string {
  // Check null FIRST before any numeric comparison
  if (lower === null || lower === undefined) return "unavailable"
  if (lower === -1) return "unavailable"
  if (lower < 1000) return "unavailable"
  const fmt = new Intl.NumberFormat("en")
  return `${fmt.format(lower)}-${fmt.format(upper ?? lower)}`
}

// ─── Dashboard (P6) — pure derivations, no DOM ─────────────────────────────────

export type DashboardState = "empty" | "loading" | "error" | "populated"

export interface DashboardConnectionFlags {
  meta: boolean
  google: boolean
  merchant: boolean
}

/**
 * Resolves the dashboard's four required states from a coarse resource-shape
 * summary. `loading` always wins while anything is still in flight (avoids
 * flashing an error/empty state mid-fetch); a core (`hasError`) failure wins
 * over `populated`; a still-working arm keeps the board `populated` (per-arm
 * degradation, error chips shown inline); `empty` is a genuine fresh install.
 *
 * `connectionErrored` distinguishes "no arm connected because every platform
 * account read ERRORED" (expired token, outage) from "no arm connected because
 * nothing is set up yet". The former must resolve to `error`, NOT `empty` --
 * rendering an all-arms outage as "Nothing connected / no spend" is a dangerous
 * false signal for an ads operator. It only matters when nothing is connected;
 * while any arm still works the board stays `populated`.
 */
export function deriveDashboardState(input: {
  connected: DashboardConnectionFlags
  loading: boolean
  hasError: boolean
  connectionErrored?: boolean
}): DashboardState {
  if (input.loading) return "loading"
  if (input.hasError) return "error"
  const anyConnected = input.connected.meta || input.connected.google || input.connected.merchant
  if (anyConnected) return "populated"
  if (input.connectionErrored) return "error"
  return "empty"
}

/**
 * One platform arm's connection, with the same meaning as the Settings page:
 * `not_connected` is a normal state (nothing set up yet), `errored` is an
 * outage. Keeping the two apart is what lets a fresh install read as `empty`
 * while an all-arms outage still reads as `error`.
 */
export type ArmStatus = "connected" | "not_connected" | "errored"

/** A settled tool read: its resolved value, or the rejection it threw. */
export type ToolRead = { ok: true; value: unknown } | { ok: false; error: unknown }

/** The machine code on a rejected tool call (the host's ApiError carries `code`). */
export function toolErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === "string" ? code : undefined
}

/** The code of a structured `{ error: { code } }` result; "unknown" when it has none. */
function envelopeErrorCode(value: unknown): string | undefined {
  const error = (value as { error?: { code?: unknown } | null } | null | undefined)?.error
  if (!error) return undefined
  return typeof error.code === "string" ? error.code : "unknown"
}

/** True when a RESOLVED tool value is an error envelope rather than data. */
export function isToolErrorEnvelope(value: unknown): boolean {
  return envelopeErrorCode(value) !== undefined
}

/**
 * The single accessor every panel routes a tool answer through before reading
 * a field off it. A not-connected deployment gets the envelope back as the
 * tool's ANSWER (a resolved 200), so any `result.someField` read on it is a
 * read off an error object: this returns null for that, exactly as it does for
 * a failed read, and the caller falls through to its "no data" branch.
 */
export function toolData<T>(result: T | null | undefined): T | null {
  if (result === null || result === undefined) return null
  return isToolErrorEnvelope(result) ? null : result
}

/**
 * The rows of a list-shaped tool answer. An envelope, a failed read and a
 * payload whose list field is missing or not an array all read as no rows.
 */
export function toolRows<T = Record<string, unknown>>(result: unknown, field = "data"): T[] {
  const data = toolData(result as Record<string, unknown> | null | undefined)
  const rows = data?.[field]
  return Array.isArray(rows) ? (rows as T[]) : []
}

/**
 * Meta arm from `account_info`. The handler rejects with the
 * `meta_not_connected` code when Meta is not set up; any other rejection is an
 * outage. A resolved account is connected only when it carries an id.
 */
export function metaArmStatus(read: ToolRead): ArmStatus {
  if (!read.ok)
    return toolErrorCode(read.error) === "meta_not_connected" ? "not_connected" : "errored"
  // The kernel hands a not-connected envelope back as the tool's ANSWER (a
  // 200), so the resolved value can itself be `{ error: { code } }`: read the
  // code rather than only the absent account id, which would have called a
  // genuine platform error "not connected".
  const code = envelopeErrorCode(read.value)
  if (code !== undefined) return code === "meta_not_connected" ? "not_connected" : "errored"
  const id = (read.value as { id?: unknown } | null | undefined)?.id
  return typeof id === "string" && id !== "" ? "connected" : "not_connected"
}

/**
 * Google arm from `google_account_info`, which returns `customer_id` when
 * connected and a `google_not_connected` envelope when not.
 */
export function googleArmStatus(read: ToolRead): ArmStatus {
  if (!read.ok) return "errored"
  const customerId = (read.value as { customer_id?: unknown } | null | undefined)?.customer_id
  if (customerId != null && customerId !== "") return "connected"
  const code = envelopeErrorCode(read.value)
  if (code === undefined || code === "google_not_connected") return "not_connected"
  return "errored"
}

/**
 * Merchant Center arm from `merchant_feed_status`: a feed summary when
 * reachable, a `merchant_not_configured` or `google_not_connected` envelope
 * when not set up. An envelope is never a connected feed.
 */
export function merchantArmStatus(read: ToolRead): ArmStatus {
  if (!read.ok) return "errored"
  if (read.value == null) return "not_connected"
  const code = envelopeErrorCode(read.value)
  if (code === undefined) return "connected"
  if (code === "merchant_not_configured" || code === "google_not_connected") return "not_connected"
  return "errored"
}

export interface DashboardArms {
  meta: ArmStatus
  google: ArmStatus
  merchant: ArmStatus
}

/** Folds the three arms into the flags `deriveDashboardState` and the health chips read. */
export function armConnections(arms: DashboardArms): {
  connected: DashboardConnectionFlags
  errored: DashboardConnectionFlags
  anyErrored: boolean
} {
  const errored = {
    meta: arms.meta === "errored",
    google: arms.google === "errored",
    merchant: arms.merchant === "errored",
  }
  return {
    connected: {
      meta: arms.meta === "connected",
      google: arms.google === "connected",
      merchant: arms.merchant === "connected",
    },
    errored,
    anyErrored: errored.meta || errored.google || errored.merchant,
  }
}

/** Health chip for one arm: never "OK" for an arm that is not connected. */
export function armChip(status: ArmStatus): {
  tone: "success" | "neutral" | "error"
  label: string
} {
  if (status === "connected") return { tone: "success", label: "OK" }
  if (status === "not_connected") return { tone: "neutral", label: "not connected" }
  return { tone: "error", label: "error" }
}

/**
 * Whether a card's failure is banner-worthy: true ONLY when EVERY tile in the
 * card failed. A single failed tile (e.g. one transient metrics_run timeout
 * while its sibling loaded fine) renders its own inline degraded state plus a
 * Retry affordance; escalating it to the global "could not load" banner reads
 * as a page-level outage the operator has to triage, when in fact the other
 * tiles are live. An empty tile list is never an error.
 */
export function dashboardCardError(tileErrors: boolean[]): boolean {
  return tileErrors.length > 0 && tileErrors.every(Boolean)
}

interface ZombieCampaignRow {
  id: string
  name: string
  effective_status: string
  [key: string]: unknown
}

interface ZombieSpendRow {
  campaign_id?: string
  campaign_name?: string | null
  spend?: string | number | null
  [key: string]: unknown
}

const ZOMBIE_SPEND_EPSILON = 0.01

/**
 * ACTIVE (effective_status) campaigns with zero/near-zero delivery this
 * window — "delivering nothing despite being live." Matches spend rows by
 * campaign_id first, falling back to campaign_name; no matching row is
 * treated as zero spend (still flagged).
 */
export function zombieCampaigns(
  campaigns: ZombieCampaignRow[],
  spend: ZombieSpendRow[],
): ZombieCampaignRow[] {
  const spendById = new Map<string, number>()
  const spendByName = new Map<string, number>()
  for (const row of spend) {
    const value = Number(row.spend ?? 0)
    const amount = Number.isFinite(value) ? value : 0
    if (row.campaign_id)
      spendById.set(row.campaign_id, (spendById.get(row.campaign_id) ?? 0) + amount)
    if (row.campaign_name)
      spendByName.set(row.campaign_name, (spendByName.get(row.campaign_name) ?? 0) + amount)
  }
  return campaigns.filter((c) => {
    if (c.effective_status !== "ACTIVE") return false
    const total = spendById.has(c.id) ? spendById.get(c.id)! : (spendByName.get(c.name) ?? 0)
    return total < ZOMBIE_SPEND_EPSILON
  })
}

/**
 * decision_date − today, in whole days. Negative when past-due. `null` when
 * decision_date is unset (undecided / no test in flight).
 */
export function daysToDecision(
  decisionDate: string | null | undefined,
  today: string,
): number | null {
  if (!decisionDate) return null
  const decision = new Date(`${decisionDate}T00:00:00Z`).getTime()
  const now = new Date(`${today}T00:00:00Z`).getTime()
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((decision - now) / msPerDay)
}

interface HealthFlagsCampaignRow {
  id: string
  name: string
  effective_status: string
  learning?: boolean
  [key: string]: unknown
}

export interface HealthFlagsResult {
  zombieCount: number
  learningPhaseCount: number
  disapprovedProductsCount: number
  connectionErrors: DashboardConnectionFlags
}

/**
 * Aggregates the dashboard's health-flag panel: zombie ACTIVE campaigns
 * (reuses zombieCampaigns — same derivation as the routine, factored so it's
 * unit-tested independent of the DOM), learning-phase campaigns, Merchant
 * disapproved-product count, and per-connection error state. Zero counts and
 * false connection errors are reported explicitly, never omitted
 * (count-0 anti-rubber-stamp).
 */
export function healthFlags(input: {
  campaigns: HealthFlagsCampaignRow[]
  spend: ZombieSpendRow[]
  merchantDisapprovedCount: number
  connectionErrors: DashboardConnectionFlags
}): HealthFlagsResult {
  return {
    zombieCount: zombieCampaigns(input.campaigns, input.spend).length,
    learningPhaseCount: input.campaigns.filter((c) => c.learning === true).length,
    disapprovedProductsCount: input.merchantDisapprovedCount,
    connectionErrors: { ...input.connectionErrors },
  }
}

/**
 * Sums a numeric money field across insight rows. Meta account-level insights
 * carry `spend` (major-unit decimal string); Google insights carry `cost`
 * (already micros-converted to major by google_insights_query). Both are major
 * units here, so this NEVER rescales — pure addition. Returns null when there
 * are no rows AND no field values (so the caller can distinguish "no data yet"
 * from a genuine zero), otherwise the running total (0 for all-zero rows).
 */
export function weeklySpendTotal(
  rows: Array<Record<string, unknown>> | null | undefined,
  field: "spend" | "cost",
): number | null {
  if (!rows || rows.length === 0) return null
  let total = 0
  let sawValue = false
  for (const row of rows) {
    const raw = row[field]
    if (raw === null || raw === undefined || raw === "") continue
    const n = typeof raw === "string" ? parseFloat(raw) : (raw as number)
    if (Number.isFinite(n)) {
      total += n
      sawValue = true
    }
  }
  return sawValue ? total : null
}

export function adFormatLabel(format: string): string {
  switch (format) {
    case "DESKTOP_FEED_STANDARD":
      return "Desktop Feed"
    case "MOBILE_FEED_STANDARD":
      return "Mobile Feed"
    case "INSTAGRAM_STANDARD":
      return "Instagram Feed"
    case "INSTAGRAM_STORY":
      return "Instagram Story"
    default: {
      // title-case fallback
      return format
        .toLowerCase()
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Phone columns (spec-responsive.md).
//
// The campaigns table is a comparison table, so at 390 px it declares which
// columns survive rather than collapsing into cards. The rest stay in the row
// and paint as a stacked block once the row's own accordion expand is open, so
// no cell markup is written twice and the table gains no column.
// ─────────────────────────────────────────────────────────────────────────
export interface TableColumn {
  key: string
  survivesPhone?: boolean
}

export const CAMPAIGN_COLUMNS: TableColumn[] = [
  { key: "expand", survivesPhone: true },
  { key: "name", survivesPhone: true },
  { key: "objective" },
  { key: "status", survivesPhone: true },
  { key: "budget" },
  { key: "actions", survivesPhone: true },
]

export function phoneCellClass(key: string, cols: TableColumn[], expanded: boolean): string {
  if (cols.find((c) => c.key === key)?.survivesPhone) return ""
  return expanded ? "block md:table-cell" : "hidden md:table-cell"
}

// ─── Meta outcomes a person must understand ─────────────────────────────────
//
// A Meta read can come back throttled, refused, rejected or still building.
// Each is an answer with a plain next step, not a generic failure, so every
// panel reads it through these two helpers and renders the same sentence.

export type MetaIssueKind =
  | "rate_limited"
  | "permission"
  | "invalid"
  | "auth"
  | "pending"
  | "failed"

export interface MetaIssue {
  kind: MetaIssueKind
  /** The sentence the person reads. Never a bare "unknown error". */
  text: string
  /** Whether a Retry affordance makes sense for this outcome. */
  retry: boolean
  /** Styled as a notice rather than an error (a report still building). */
  tone: "notice" | "error"
}

const RATE_LIMITED_TEXT = "Meta is limiting requests right now. Try again in a few minutes."
const PENDING_TEXT = "Meta is still preparing this report. Try again in a moment."
const FAILED_TEXT = "Meta could not be reached for this panel. Try again."
// The ToolError message carries the person's sentence first, then the agent's
// next step. The person reads only the first part.
const NEXT_STEP_MARKER = " Next step:"
// Messages that say nothing a person can act on; never shown as the reason.
const OPAQUE_MESSAGES = new Set([
  "Tool execution failed",
  "Internal server error",
  "Request failed",
  "Unknown error",
  "Unknown sandbox error",
])

function personSentence(message: unknown): string | null {
  if (typeof message !== "string") return null
  const cut = message.indexOf(NEXT_STEP_MARKER)
  const head = (cut === -1 ? message : message.slice(0, cut)).trim()
  if (!head || OPAQUE_MESSAGES.has(head)) return null
  return head
}

/**
 * The Meta outcome behind a rejected tool call (the host's ApiError carries
 * `code` and `message`), or behind a resolved `{ error: { code, message } }`
 * envelope. Always returns a readable sentence.
 */
export function metaIssueFromError(err: unknown): MetaIssue {
  const envelope = (err as { error?: { code?: unknown; message?: unknown } } | null | undefined)
    ?.error
  const source =
    envelope && typeof envelope === "object"
      ? envelope
      : (err as { code?: unknown; message?: unknown } | null)
  const code = typeof source?.code === "string" ? source.code : undefined
  const sentence = personSentence(source?.message)
  switch (code) {
    case "meta_rate_limited":
      return { kind: "rate_limited", text: RATE_LIMITED_TEXT, retry: true, tone: "notice" }
    case "meta_permission_denied":
      return {
        kind: "permission",
        text:
          sentence ?? "Meta did not allow this request. The Meta app may be missing a permission.",
        retry: false,
        tone: "error",
      }
    case "meta_invalid_request":
    case "meta_rejected":
      return {
        kind: "invalid",
        text: sentence ?? "Meta rejected this request.",
        retry: false,
        tone: "error",
      }
    case "meta_auth_invalid":
      return {
        kind: "auth",
        text:
          sentence ??
          "Meta no longer accepts the saved access token. Reconnect Meta in the Ads settings.",
        retry: false,
        tone: "error",
      }
    default:
      return { kind: "failed", text: sentence ?? FAILED_TEXT, retry: true, tone: "error" }
  }
}

/** A resolved insights answer that is not rows yet: the report is still building or Meta is throttling. */
export function metaPendingIssue(value: unknown): MetaIssue | null {
  const v = value as { _pending?: unknown; _pending_reason?: unknown } | null | undefined
  if (!v || v._pending !== true) return null
  if (v._pending_reason === "rate_limited") {
    return { kind: "rate_limited", text: RATE_LIMITED_TEXT, retry: true, tone: "notice" }
  }
  return { kind: "pending", text: PENDING_TEXT, retry: true, tone: "notice" }
}
