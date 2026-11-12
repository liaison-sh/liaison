// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Thin Shopify Admin GraphQL client.
//
// Hardening dimensions (each pinned by a test in shopify-client.test.ts):
// - The client never waits inside a run. Pacing belongs to the platform's
//   shared per-connection limiter (manifest `connections.shop.limits`): every
//   call waits there for its turn, across runs and processes.
// - Bucket-aware throttle: when `extensions.cost.throttleStatus.currentlyAvailable`
//   drops below `throttleLowWatermark` (default 100), the client reports a pause
//   long enough for the bucket to refill to the watermark at its `restoreRate`
//   (`onThrottle`, wired to `ctx.limiter.pause`), so the NEXT call to this shop,
//   from any run, waits in the limiter. Malformed/missing `extensions.cost` is
//   treated as "no throttle".
// - 429 retry: up to 3 retries, sent at once: the limiter holds them for the
//   `Retry-After` the 429 carried (it pauses the connection itself); throws after
//   the 4th try.
// - 401 → CONNECTION_LOST (no retry — connection needs admin re-auth).
// - 403 → SCOPE_DENIED (no retry — a Liaison-side scope-grant gap, not a
//   token failure; see decisions.md §0.3d).
// - `paginate({ query, path })` follows `pageInfo.endCursor` until exhausted.
//
// The client is constructor-injected with `fetch` to keep it host-free —
// tests stub the network; production wires `globalThis.fetch`.

export interface ShopifyFetchResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * One Admin API call. The client sets no credential: the fetch it is given
 * carries the connection (`get-client.ts` passes `ctx.fetch` with an `auth`
 * the host turns into `X-Shopify-Access-Token`), so the token never enters
 * app code.
 */
export type ShopifyFetch = (input: {
  url: string
  method: "POST"
  headers: Record<string, string>
  body: string
}) => Promise<ShopifyFetchResponse>

export interface ShopifyClientOptions {
  shop: string
  fetch?: ShopifyFetch
  apiVersion?: string
  /**
   * Override the base URL used for Admin API calls. When set, replaces the
   * default `https://${shop}.myshopify.com` prefix — the apiVersion-suffixed
   * GraphQL path is still appended (`<base>/admin/api/<version>/graphql.json`).
   * Trailing slashes are stripped. Used by the test harness to route requests
   * to a Bun mock instead of real Shopify, and by future multi-region setups.
   */
  baseUrlOverride?: string
  /**
   * The pause reported for a low cost bucket when the response names no
   * `restoreRate`, in ms. Default 1000.
   */
  throttlePauseMs?: number
  /** Below this many available cost points, a pause is reported. Default 100. */
  throttleLowWatermark?: number
  /**
   * A caller on a deadline (a guard with a few seconds of budget): a 429 throws
   * RATE_LIMIT at once instead of retrying. Default false.
   */
  failFast?: boolean
  /**
   * Told how long every call to this shop should hold off (ms, at most 60 s)
   * after a response reported a low cost bucket. Wired to `ctx.limiter.pause`,
   * which holds the shop's next calls from every run and process. A failure
   * here never fails the call that reported it.
   */
  onThrottle?: (pauseMs: number) => unknown
}

export interface ShopifyError extends Error {
  code?: "CONNECTION_LOST" | "SCOPE_DENIED" | "RATE_LIMIT" | "GRAPHQL_ERROR" | "HTTP_ERROR"
  status?: number
}

interface PaginateOptions {
  query: string
  variables?: Record<string, unknown>
  /** Path under `data.` that points at the connection (e.g. "customers"). */
  path: string
  /** Override per-page first count; default 50. */
  first?: number
}

const DEFAULT_API_VERSION = "2026-04"

export class ShopifyClient {
  private readonly shop: string
  private readonly apiVersion: string
  private readonly baseUrlOverride: string | null
  private readonly fetchImpl: ShopifyFetch
  private readonly throttlePauseMs: number
  private readonly throttleLowWatermark: number
  private readonly failFast: boolean
  private readonly onThrottle?: (pauseMs: number) => unknown

  constructor(opts: ShopifyClientOptions) {
    this.shop = opts.shop
    this.apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION
    this.baseUrlOverride = opts.baseUrlOverride ? opts.baseUrlOverride.replace(/\/$/, "") : null
    this.fetchImpl = opts.fetch ?? defaultFetch
    this.throttlePauseMs = opts.throttlePauseMs ?? 1000
    this.throttleLowWatermark = opts.throttleLowWatermark ?? 100
    this.failFast = opts.failFast === true
    this.onThrottle = opts.onThrottle
  }

  /** Run a GraphQL query/mutation against the shop's Admin API. */
  async query<T = unknown>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const base = this.baseUrlOverride ?? `https://${this.shop}.myshopify.com`
    const url = `${base}/admin/api/${this.apiVersion}/graphql.json`
    // `effectiveVars`/`reqBody` are mutable so a single malformed-cursor retry can
    // resend with `after: null` (see the cursor-fallback branch below).
    let effectiveVars = variables
    let reqBody = JSON.stringify({ query, variables: effectiveVars })
    let cursorFallbackUsed = false

    let attempt = 0
    while (true) {
      const res = await this.fetchImpl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: reqBody,
      })

      if (res.status === 401) {
        throw makeError("CONNECTION_LOST", "Shopify token rejected (401)", 401)
      }
      if (res.status === 403) {
        throw makeError("SCOPE_DENIED", "Shopify denied operation (403)", 403)
      }
      if (res.status === 429) {
        if (attempt >= 3 || this.failFast) {
          throw makeError("RATE_LIMIT", "Shopify 429 (rate limit) after 3 retries", 429)
        }
        // No wait here: the connection's limiter paused this shop for the
        // 429's Retry-After, so the retry waits there for its turn.
        attempt++
        continue
      }
      if (res.status >= 400) {
        throw makeError(
          "HTTP_ERROR",
          `Shopify HTTP ${res.status}: ${res.body.slice(0, 200)}`,
          res.status,
        )
      }

      const parsed = safeJsonParse(res.body)
      // Bucket-aware throttle: a low bucket pauses the shop's next calls (in
      // the limiter, for every run) until it has refilled to the watermark.
      const throttle = parsed?.extensions?.cost?.throttleStatus
      const pauseMs = throttlePauseFor(throttle, this.throttleLowWatermark, this.throttlePauseMs)
      if (pauseMs > 0 && this.onThrottle) {
        try {
          await this.onThrottle(pauseMs)
        } catch {
          // Pacing is best effort: the provider's own 429 stays the backstop.
        }
      }

      if (parsed?.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
        const message = parsed.errors.map((e: { message?: string }) => e.message ?? "?").join("; ")
        // Malformed-cursor resilience: a weak agent can pass back a fabricated or
        // stale opaque page cursor, which the Admin API rejects with a hard
        // "Malformed cursor" GraphQL error on EVERY call — derailing the agent into
        // treating an architectural wall as a fixable tool bug (chaos: detect-margin
        // l296). Degrade gracefully ONCE: resend the same query from the first page
        // (after:null) so the caller still gets a usable bounded read. A VALID cursor
        // never reaches this branch (it does not error), so real pagination is
        // unaffected; mutations carry no `$after`, so they are untouched.
        if (
          !cursorFallbackUsed &&
          effectiveVars.after != null &&
          /malformed cursor/i.test(message)
        ) {
          cursorFallbackUsed = true
          effectiveVars = { ...effectiveVars, after: null }
          reqBody = JSON.stringify({ query, variables: effectiveVars })
          continue
        }
        throw makeError("GRAPHQL_ERROR", `Shopify GraphQL: ${message}`, res.status)
      }

      return (parsed?.data ?? {}) as T
    }
  }

  /**
   * Iterate edges of a single top-level connection across pages.
   *
   * The query must accept `$first: Int` and `$after: String` and select
   * `edges { node { ... } } pageInfo { hasNextPage endCursor }` under `data.<path>`.
   */
  async *paginate<TNode>(opts: PaginateOptions): AsyncGenerator<TNode, void, unknown> {
    let cursor: string | null = null
    const first = opts.first ?? 50
    while (true) {
      const vars: Record<string, unknown> = { ...(opts.variables ?? {}), first, after: cursor }
      const data = await this.query<Record<string, unknown>>(opts.query, vars)
      const conn = (data as Record<string, unknown>)[opts.path] as
        | {
            edges?: Array<{ node: TNode }>
            pageInfo?: { hasNextPage: boolean; endCursor: string | null }
          }
        | undefined
      if (!conn?.edges) return
      for (const edge of conn.edges) {
        yield edge.node
      }
      if (!conn.pageInfo?.hasNextPage) return
      cursor = conn.pageInfo.endCursor ?? null
      if (!cursor) return
    }
  }
}

// — helpers —

/** The longest pause the limiter takes (`ctx.limiter.pause` caps it there too). */
export const MAX_THROTTLE_PAUSE_MS = 60_000

/**
 * How long the shop's next calls should hold off after a response reported
 * `throttle`: 0 while at least `lowWatermark` cost points are available, else
 * the time the bucket needs to refill to the watermark at its `restoreRate`
 * (points per second), `fallbackMs` when the rate is missing, at most 60 s.
 */
export function throttlePauseFor(
  throttle: { currentlyAvailable?: number; restoreRate?: number } | undefined,
  lowWatermark: number,
  fallbackMs: number,
): number {
  const available = throttle?.currentlyAvailable
  if (typeof available !== "number" || available >= lowWatermark) return 0
  const rate = throttle?.restoreRate
  const ms =
    typeof rate === "number" && rate > 0
      ? Math.ceil(((lowWatermark - available) / rate) * 1000)
      : fallbackMs
  return Math.min(Math.max(ms, 1), MAX_THROTTLE_PAUSE_MS)
}

function makeError(code: ShopifyError["code"], message: string, status?: number): ShopifyError {
  const err = new Error(message) as ShopifyError
  err.code = code
  if (typeof status === "number") err.status = status
  return err
}

function safeJsonParse(s: string): {
  data?: Record<string, unknown>
  errors?: Array<{ message?: string }>
  extensions?: { cost?: { throttleStatus?: { currentlyAvailable?: number; restoreRate?: number } } }
} | null {
  try {
    return s ? JSON.parse(s) : null
  } catch {
    return null
  }
}

const defaultFetch: ShopifyFetch = async (req) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body })
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v
  })
  return { status: res.status, headers, body: await res.text() }
}
