// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Meta Graph API v25.0 client — the single outbound HTTP path for the Meta arm of the ads app.
// All handlers compose calls through `metaFetch`. Never import node:* or npm SDKs.

import type { AppContext } from "@liaison/app-sdk"
import { currencyExponent } from "./currency-exponent"

// ─── Version pin ────────────────────────────────────────────────────────────

export const GRAPH = "https://graph.facebook.com/v25.0"

// ─── Currency exponent (delegated to shared module) ──────────────────────────

/**
 * Convert human-readable major units → integer minor units for Meta API writes.
 * toMinorUnits(50, 'EUR') === 5000
 * toMinorUnits(50, 'JPY') === 50
 */
export function toMinorUnits(amount: number, currency: string): number {
  return Math.round(amount * Math.pow(10, currencyExponent(currency)))
}

/**
 * Parse a decimal-string from Meta API reads → major-unit number.
 * The read path must NEVER numerically rescale — Meta returns already-major-unit
 * decimal strings (e.g. "1234.56" EUR = €1234.56, not €12.3456; "50" JPY = ¥50).
 * No currency argument: rescaling never happens on reads, so the exponent is
 * irrelevant here. The account currency is surfaced on the caller's result for
 * labeling, not used for rescaling.
 * fromAccountCurrency("50") === 50
 * fromAccountCurrency("1234.56") === 1234.56
 */
export function fromAccountCurrency(decimalStr: string): number {
  return parseFloat(decimalStr)
}

// ─── Typed errors ────────────────────────────────────────────────────────────

export class MetaApiError extends Error {
  /** HTTP status of the Graph response that carried the error envelope. */
  httpStatus?: number
  /** Meta `error_subcode`, when the envelope carried one. */
  subcode?: number
  constructor(
    message: string,
    public readonly code: number,
    public readonly fbtrace_id?: string,
  ) {
    super(message)
    this.name = "MetaApiError"
  }
}

/** Meta #10 / #200-#299: the app or token lacks the permission for this call. */
export class PermissionError extends MetaApiError {
  constructor(message: string, code: number, fbtrace_id?: string) {
    super(message, code, fbtrace_id)
    this.name = "PermissionError"
  }
}

export class AuthError extends MetaApiError {
  constructor(message: string, code: number, fbtrace_id?: string) {
    super(message, code, fbtrace_id)
    this.name = "AuthError"
  }
}

export class ParamError extends MetaApiError {
  constructor(message: string, fbtrace_id?: string) {
    super(message, 100, fbtrace_id)
    this.name = "ParamError"
  }
}

export class RateLimitError extends MetaApiError {
  constructor(message: string, code: number, fbtrace_id?: string) {
    super(message, code, fbtrace_id)
    this.name = "RateLimitError"
  }
}

export class BudgetCapError extends MetaApiError {
  constructor(message: string, fbtrace_id?: string) {
    super(message, 613, fbtrace_id)
    this.name = "BudgetCapError"
  }
}

export class TransientError extends MetaApiError {
  constructor(message: string, code: number, fbtrace_id?: string) {
    super(message, code, fbtrace_id)
    this.name = "TransientError"
  }
}

// ─── Error envelope parser ────────────────────────────────────────────────────

interface MetaErrorEnvelope {
  error?: {
    message?: string
    type?: string
    code?: number
    error_subcode?: number
    error_user_title?: string
    error_user_msg?: string
    fbtrace_id?: string
  }
}

// Ads Insights / Ads Management business-use-case throttles (80000..80014),
// e.g. "Too many calls ... #insightscallload". Same meaning as #17: back off.
function isBucThrottleCode(code: number): boolean {
  return code >= 80000 && code <= 80014
}

function parseMetaError(body: string, status: number): MetaApiError {
  const err = classifyMetaError(body, status)
  err.httpStatus = status
  return err
}

function classifyMetaError(body: string, status: number): MetaApiError {
  let envelope: MetaErrorEnvelope = {}
  try {
    envelope = JSON.parse(body) as MetaErrorEnvelope
  } catch {
    return new MetaApiError(`HTTP ${status}: ${body}`, status)
  }
  const err = envelope.error ?? {}
  const code = err.code ?? status
  const fbtrace = err.fbtrace_id
  const msg =
    (err.error_user_msg ?? err.message ?? `Meta API error (code ${code})`) +
    (fbtrace ? ` [fbtrace_id: ${fbtrace}]` : "")

  const withSubcode = <E extends MetaApiError>(e: E): E => {
    if (typeof err.error_subcode === "number") e.subcode = err.error_subcode
    return e
  }
  return withSubcode(classifyByCode(err, code, msg, fbtrace))
}

function classifyByCode(
  err: NonNullable<MetaErrorEnvelope["error"]>,
  code: number,
  msg: string,
  fbtrace: string | undefined,
): MetaApiError {
  // 190/102 → AuthError
  if (code === 190 || code === 102) return new AuthError(msg, code, fbtrace)
  // 10 and 200..299 → PermissionError (app or token lacks the permission)
  if (code === 10 || (code >= 200 && code <= 299)) return new PermissionError(msg, code, fbtrace)
  // 100 → ParamError
  if (code === 100) return new ParamError(msg, fbtrace)
  // 613 + subcode 1487632 → BudgetCapError; bare 613 → RateLimitError
  if (code === 613) {
    if (err.error_subcode === 1487632) return new BudgetCapError(msg, fbtrace)
    return new RateLimitError(msg, code, fbtrace)
  }
  // 4/17/32 → RateLimitError (generic throttle)
  if (code === 4 || code === 17 || code === 32 || isBucThrottleCode(code)) {
    return new RateLimitError(msg, code, fbtrace)
  }
  // 1/2/341 → TransientError
  if (code === 1 || code === 2 || code === 341) return new TransientError(msg, code, fbtrace)
  return new MetaApiError(msg, code, fbtrace)
}

// ─── Throttle check ──────────────────────────────────────────────────────────

const THROTTLE_WARN_THRESHOLD = 75 // percent

/**
 * Inspect Meta usage headers and return a human-readable WARNING string if any
 * usage figure is above the warn threshold — or `null` if not throttled.
 *
 * IMPORTANT: this NEVER throws. A successful 2xx response must be returned to the
 * caller; throttle headers only inform post-error backoff / surface a warning,
 * they must not discard a completed read. Handles BOTH header shapes:
 *   - flat object:   X-App-Usage = {"call_count":85,"total_time":30,...}
 *   - nested arrays: X-Business-Use-Case-Usage = {"<id>":[{"call_count":80,...}]}
 */
function checkThrottleHeaders(headers: Record<string, string>): string | null {
  for (const header of [
    "x-business-use-case-usage",
    "x-ad-account-usage",
    "x-app-usage",
    "x-fb-ads-insights-throttle",
  ]) {
    const val = headers[header]
    if (!val) continue
    try {
      const parsed = JSON.parse(val) as Record<string, unknown>

      // Flat shape: a top-level numeric call_count (the common X-App-Usage form).
      if (
        typeof parsed.call_count === "number" &&
        parsed.call_count > THROTTLE_WARN_THRESHOLD
      ) {
        return `Meta API throttle warning: ${header} call_count at ${parsed.call_count}%`
      }

      // Nested-array shape: arrays of business-use-case objects with call_count.
      for (const v of Object.values(parsed)) {
        if (!Array.isArray(v)) continue
        for (const item of v) {
          if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).call_count === "number" &&
            (item as { call_count: number }).call_count > THROTTLE_WARN_THRESHOLD
          ) {
            return `Meta API throttle warning: ${header} usage at ${(item as { call_count: number }).call_count}%`
          }
        }
      }
    } catch {
      // Ignore parse errors on unexpected header shapes — never break a read.
    }
  }
  return null
}

// ─── metaFetch ───────────────────────────────────────────────────────────────

// The fetch shape metaFetch accepts. Deliberately the LOOSE handler/sandbox shape
// (`opts?: Record<string,unknown>` → `Promise<unknown>`) that every ads
// handler ctx and unit-test mock already exposes — NOT the precise
// `AppContext["fetch"]`. The precise SDK fetch is assignable to this looser type,
// and metaFetch casts the result to FetchResult internally. Widening the param
// here (rather than narrowing every ctx interface + test mock) keeps handlers and
// mocks assignable without any `as` casts at the callsites.
export type MetaFetch = (
  url: string,
  opts?: Record<string, unknown>,
) => Promise<unknown>

// Compile-time guard: the precise SDK fetch must remain assignable to MetaFetch,
// so production ctx.fetch (the real bridge) works through metaFetch unchanged.
type _AssertSdkFetchAssignable = AppContext["fetch"] extends MetaFetch ? true : never
const _sdkFetchAssignable: _AssertSdkFetchAssignable = true
void _sdkFetchAssignable

export interface MetaFetchOptions {
  path: string
  method?: "GET" | "POST" | "DELETE"
  params?: Record<string, unknown>
  accessToken: string
}

interface FetchResult {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Single outbound HTTP path to the Meta Graph API.
 * - Sets Authorization: Bearer
 * - Form-encodes params (object/array values → JSON.stringify'd strings)
 * - Parses non-2xx → typed errors
 * - Checks throttle headers
 */
export async function metaFetch(
  fetch: MetaFetch,
  opts: MetaFetchOptions,
): Promise<unknown> {
  const { path, method = "GET", params, accessToken } = opts
  const url = `${GRAPH}${path}`

  // Form-encode params: object/array values → JSON.stringify'd strings
  let body: string | undefined
  let queryString = ""
  if (params && Object.keys(params).length > 0) {
    const parts: string[] = []
    for (const [k, v] of Object.entries(params)) {
      const strVal =
        typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(strVal)}`)
    }
    const encoded = parts.join("&")
    if (method === "GET") {
      queryString = `?${encoded}`
    } else {
      body = encoded
    }
  }

  const result = (await fetch(url + queryString, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(body ? { body } : {}),
  })) as FetchResult

  // Non-2xx → typed error. Throttle headers inform the message but the error
  // class is driven by the body's error code (post-error backoff lives here).
  if (result.status < 200 || result.status >= 300) {
    throw parseMetaError(result.body, result.status)
  }

  // Successful 2xx: NEVER throw on throttle headers — returning the completed
  // read is correct even on a busy-but-OK account. Surface a warning only.
  const throttleWarning = checkThrottleHeaders(result.headers ?? {})
  if (throttleWarning) {
    console.warn(`[ads] ${throttleWarning}`)
  }

  return JSON.parse(result.body)
}

// ─── Cursor-paged fetch ───────────────────────────────────────────────────────

const SANDBOX_FETCH_MAX_RESPONSE_BYTES = 1_000_000
const MAX_PAGES = 20

interface PagedResponse {
  data: unknown[]
  paging?: {
    cursors?: { after?: string }
    next?: string
  }
}

/**
 * Fetch all pages of a cursor-paged Meta API edge, accumulating within the 1 MB cap.
 */
export async function metaFetchPaged(
  fetch: MetaFetch,
  opts: MetaFetchOptions,
): Promise<unknown[]> {
  const accumulated: unknown[] = []
  let afterCursor: string | undefined
  let pages = 0
  let totalBytes = 0

  while (pages < MAX_PAGES) {
    const params: Record<string, unknown> = { ...(opts.params ?? {}) }
    if (afterCursor) params.after = afterCursor

    const result = await metaFetch(fetch, { ...opts, params }) as PagedResponse

    const data = Array.isArray(result.data) ? result.data : []
    accumulated.push(...data)

    // Rough byte tracking
    totalBytes += JSON.stringify(data).length
    if (totalBytes > SANDBOX_FETCH_MAX_RESPONSE_BYTES) break

    const next = result.paging?.cursors?.after
    if (!next || !result.paging?.next) break
    afterCursor = next
    pages++
  }

  return accumulated
}

/**
 * Bounded, cursor-aware variant of metaFetchPaged. Fetches AT MOST `maxPages`
 * pages (starting from `after` when supplied) and returns both the accumulated
 * rows and the next-page cursor, so a caller can render one fast page and offer
 * a "load more" affordance instead of draining the whole edge in one sandboxed
 * call (which times out on large accounts). Passing maxPages:1 yields exactly
 * one Graph page. `after: null` in the result means there are no more pages.
 */
export async function metaFetchPage(
  fetch: MetaFetch,
  opts: MetaFetchOptions & { maxPages?: number; after?: string },
): Promise<{ data: unknown[]; after: string | null }> {
  const maxPages = opts.maxPages && opts.maxPages > 0 ? opts.maxPages : 1
  const accumulated: unknown[] = []
  let afterCursor: string | undefined = opts.after
  let pages = 0
  let totalBytes = 0
  let nextCursor: string | null = null

  while (pages < maxPages) {
    const params: Record<string, unknown> = { ...(opts.params ?? {}) }
    if (afterCursor) params.after = afterCursor

    const result = (await metaFetch(fetch, { ...opts, params })) as PagedResponse

    const data = Array.isArray(result.data) ? result.data : []
    accumulated.push(...data)

    const next = result.paging?.cursors?.after
    const hasNext = Boolean(next && result.paging?.next)
    nextCursor = hasNext ? (next as string) : null

    totalBytes += JSON.stringify(data).length
    if (totalBytes > SANDBOX_FETCH_MAX_RESPONSE_BYTES) break
    if (!hasNext) break
    afterCursor = next
    pages++
  }

  return { data: accumulated, after: nextCursor }
}

// ─── Async insights report-run ────────────────────────────────────────────────
//
// A large insights pull is a Meta report run: POST creates it, GET /<run id>
// tells its status, GET /<run id>/insights extracts it once complete. A run
// never waits for it: `createInsightsReport` starts one, `checkInsightsReport`
// asks ONCE and answers rows, "still running" or "throttled". The caller keeps
// the run id and asks again in a later run (insights-report.ts).

interface InsightsJobStatus {
  id: string
  async_status?: string
  async_percent_completion?: number
}

// Meta's terminal failure states for an async report run.
const INSIGHTS_FAILURE_STATES = new Set(["Job Failed", "Job Skipped"])

// Meta Graph error code for "the report job hasn't finished yet, check the async
// status before extracting" (surfaced in the account language, e.g. French). It
// is a transient race, NOT a failure: the status edge can flip to "Job
// Completed" a beat before the results edge has materialised. Treat it as
// "still running". Graph delivers it as `error_subcode` under a generic
// top-level code (#100), so match either field.
const INSIGHTS_NOT_READY_CODE = 1815005

function isInsightsNotReady(err: unknown): boolean {
  return (
    err instanceof MetaApiError &&
    (err.code === INSIGHTS_NOT_READY_CODE || err.subcode === INSIGHTS_NOT_READY_CODE)
  )
}

// The report is extractable only once the status says "Job Completed" AND the
// completion reaches 100. A status without the percentage is taken at its word.
function isInsightsJobDone(status: InsightsJobStatus): boolean {
  if (status.async_status !== "Job Completed") return false
  const pct = status.async_percent_completion
  return typeof pct !== "number" || pct >= 100
}

/**
 * An insights report that is not extractable yet: still running, racing its
 * extraction, or throttled. Callers surface it as a structured "data not ready
 * yet" result the UI can render, never as a thrown 500; `report_run_id` is the
 * run a later call resumes (insights-report.ts keeps it).
 */
export interface InsightsPending {
  _pending: true
  report_run_id: string
  reason: "still_running" | "not_ready" | "rate_limited"
}

export function isInsightsPending(v: unknown): v is InsightsPending {
  return typeof v === "object" && v !== null && (v as { _pending?: unknown })._pending === true
}

/** Start an async insights report run (POST to the /insights edge); its run id. */
export async function createInsightsReport(
  fetch: MetaFetch,
  opts: { path: string; params: Record<string, unknown>; accessToken: string },
): Promise<string> {
  const jobResult = (await metaFetch(fetch, {
    path: opts.path,
    method: "POST",
    params: { ...opts.params, async: "true" },
    accessToken: opts.accessToken,
  })) as { report_run_id?: string }
  const reportRunId = jobResult.report_run_id
  if (!reportRunId) {
    throw new MetaApiError("No report_run_id in async insights response", 0)
  }
  return reportRunId
}

/**
 * Ask a report run once: its rows when complete and extractable (paged under
 * 1 MB, never ctx.bulk: Meta answers JSON envelopes, not JSONL), else a pending
 * marker. A throttle answer is pending too: asking again only deepens it.
 * Throws on Meta's terminal failure states ("Job Failed", "Job Skipped") and
 * on any other Meta error.
 */
export async function checkInsightsReport(
  fetch: MetaFetch,
  opts: { reportRunId: string; accessToken: string },
): Promise<unknown[] | InsightsPending> {
  const { reportRunId, accessToken } = opts
  const pending = (reason: InsightsPending["reason"]): InsightsPending => ({
    _pending: true,
    report_run_id: reportRunId,
    reason,
  })
  let status: InsightsJobStatus
  try {
    status = (await metaFetch(fetch, {
      path: `/${reportRunId}`,
      method: "GET",
      accessToken,
    })) as InsightsJobStatus
  } catch (err) {
    if (err instanceof RateLimitError) return pending("rate_limited")
    throw err
  }
  if (status.async_status && INSIGHTS_FAILURE_STATES.has(status.async_status)) {
    throw new MetaApiError(
      `Async insights job ${reportRunId} reported terminal state "${status.async_status}", not retrying.`,
      0,
    )
  }
  if (!isInsightsJobDone(status)) return pending("still_running")
  try {
    return await metaFetchPaged(fetch, {
      path: `/${reportRunId}/insights`,
      method: "GET",
      accessToken,
    })
  } catch (err) {
    if (isInsightsNotReady(err)) return pending("not_ready")
    if (err instanceof RateLimitError) return pending("rate_limited")
    throw err
  }
}
