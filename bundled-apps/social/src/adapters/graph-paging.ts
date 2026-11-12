// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Newest-first paging over Meta Graph list edges (Page feed, Page and
// Instagram conversations, Instagram media), shared by facebook.ts and
// instagram.ts.
//
// On Graph, `paging.cursors.after` points at OLDER items. Persisting it as the
// sync watermark (the previous design) made every tick read the next older
// page, so a sync only came back to the newest items after walking off the end
// of the list: hours of lag on a busy inbox. Here every tick starts from the
// newest page and stops at a stored per-source high-water mark (`hw`, the
// newest item time already synced). History is a separate, bounded pass
// (`bf`): one page per tick, resumed from its own cursor.
//
// Two list shapes:
//  - "watermark" (conversations, ordered by updated_time): the head pass stops
//    at the first item not newer than `hw`. Anything that changes moves back
//    to the top of the list, so the history pass runs once (a fresh
//    connection, or a gap when more items arrived in one tick than the head
//    budget reads) and then ends.
//  - "rotating" (feed posts and media, ordered by creation time): new comments
//    land on old posts too, so the newest page is read every tick and the
//    history pass rotates over older pages forever, one page per tick.

/** Per-source paging state, persisted inside the adapter's packed cursor. */
export interface ListState {
  /** Newest item time (ISO) already synced; null before the first sync. */
  hw: string | null
  /** Pending history pass: resume from `after`, stop at items not newer than `floor`. */
  bf: { after: string; floor: string | null } | null
}

/** Typed upstream failure, same vocabulary as `DiscoverResult.error`. */
export type GraphError = "CONNECTION_LOST" | "RATE_LIMITED"

export interface GraphPage<T> {
  items: T[]
  next: string | null
  /** The response's usage headers say the app is close to a Graph rate limit. */
  throttled?: boolean
}

/** `UNAVAILABLE`: any other failure (a permission error on one Page, a 5xx):
 *  the source is skipped this tick with its state kept, never read as empty. */
export type ListError = GraphError | "UNAVAILABLE"

export type GraphPageFetch<T> = (
  after: string | null,
) => Promise<GraphPage<T> | { error: ListError }>

/** Graph error codes that mean "throttled", whatever the HTTP status says
 *  (Meta answers most rate limits with a 400 or 403, not a 429): app, user,
 *  page and API-specific limits, plus the business use case limits. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006, 80008, 80014])

/** Above this share of a usage-header budget the optional pages are skipped. */
export const USAGE_THROTTLE_PERCENT = 80

/** Classify a Graph response: CONNECTION_LOST, RATE_LIMITED, or null (usable). */
export function graphError(res: { status: number; body: string }): GraphError | null {
  if (res.status === 401) return "CONNECTION_LOST"
  if (res.status === 429) return "RATE_LIMITED"
  if (res.status >= 400) {
    const code = errorCode(res.body)
    if (code !== null && RATE_LIMIT_CODES.has(code)) return "RATE_LIMITED"
    if (code === 190) return "CONNECTION_LOST" // expired or revoked token
  }
  return null
}

function errorCode(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } }
    return typeof parsed.error?.code === "number" ? parsed.error.code : null
  } catch {
    return null
  }
}

/**
 * True when Meta's usage headers (`x-app-usage`, `x-business-use-case-usage`,
 * `x-page-usage`) report any budget at or above `USAGE_THROTTLE_PERCENT`.
 * Each holds JSON percentages (`call_count`, `total_time`, `total_cputime`).
 */
export function usageThrottled(headers: Record<string, string> | undefined): boolean {
  if (!headers) return false
  let max = 0
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase()
    if (key !== "x-app-usage" && key !== "x-business-use-case-usage" && key !== "x-page-usage")
      continue
    max = Math.max(max, maxPercent(safeJson(v)))
  }
  return max >= USAGE_THROTTLE_PERCENT
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}

function maxPercent(v: unknown): number {
  if (Array.isArray(v)) return v.reduce((m: number, x) => Math.max(m, maxPercent(x)), 0)
  if (v && typeof v === "object") {
    let m = 0
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (
        (k === "call_count" || k === "total_time" || k === "total_cputime") &&
        typeof x === "number"
      ) {
        m = Math.max(m, x)
      } else if (typeof x === "object") {
        m = Math.max(m, maxPercent(x))
      }
    }
    return m
  }
  return 0
}

/** Parse a Graph timestamp. Graph writes offsets as `+0000`, which not every
 *  engine's Date.parse accepts, so the colon is restored first. NaN when absent. */
export function graphTime(s: string | null | undefined): number {
  if (!s) return Number.NaN
  return Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, "$1:$2"))
}

/** Read a persisted ListState; anything else (a legacy opaque token) is null. */
export function readListState(v: unknown): ListState | null {
  if (!v || typeof v !== "object") return null
  const o = v as { hw?: unknown; bf?: unknown }
  const hw = typeof o.hw === "string" ? o.hw : null
  let bf: ListState["bf"] = null
  if (o.bf && typeof o.bf === "object") {
    const b = o.bf as { after?: unknown; floor?: unknown }
    if (typeof b.after === "string" && b.after)
      bf = { after: b.after, floor: typeof b.floor === "string" ? b.floor : null }
  }
  return { hw, bf }
}

export interface WalkOptions<T> {
  /** Stored state; null for a source never synced (`fresh`) or one carrying a legacy cursor. */
  state: ListState | null
  /** True when the source has no cursor at all: a new connection, whose history is backfilled. */
  fresh: boolean
  mode: "watermark" | "rotating"
  fetchPage: GraphPageFetch<T>
  timeOf: (item: T) => number
  idOf: (item: T) => string
  /** Head pages per tick (newest first) before the rest is left to the history pass. */
  headPages: number
  /** History pages per tick. */
  backfillPages: number
}

export interface WalkResult<T> {
  items: T[]
  /** State to persist when every item was processed. */
  state: ListState
  /** State to persist when the items could not all be processed for a transient
   *  reason (a rate limit mid-tick): the prior state, so the next tick re-reads. */
  heldState: ListState
}

/**
 * One tick over a newest-first Graph list (see the file header). A failure on
 * the head page fails the walk (the caller keeps its cursor); a failure on a
 * later page ends the walk early with what was read.
 */
export async function walkNewestFirst<T>(
  opts: WalkOptions<T>,
): Promise<WalkResult<T> | { error: ListError }> {
  const prior = opts.state ?? { hw: null, bf: null }
  const hwMs = graphTime(prior.hw)
  const items: T[] = []
  const seen = new Set<string>()
  let newest = hwMs
  const take = (item: T) => {
    const id = opts.idOf(item)
    if (seen.has(id)) return
    seen.add(id)
    items.push(item)
  }

  // ── Head pass: newest first, down to the high-water mark ─────────────────
  let after: string | null = null
  let reachedKnown = false
  let headNext: string | null = null
  let firstNext: string | null = null
  let throttled = false
  for (let p = 0; p < opts.headPages; p++) {
    const page = await opts.fetchPage(after)
    if ("error" in page) {
      if (p === 0) return { error: page.error }
      break
    }
    throttled = throttled || page.throttled === true
    if (p === 0) firstNext = page.next
    for (const item of page.items) {
      const t = opts.timeOf(item)
      if (!Number.isNaN(t) && (Number.isNaN(newest) || t > newest)) newest = t
      const known = !Number.isNaN(hwMs) && !Number.isNaN(t) && t <= hwMs
      if (known) {
        reachedKnown = true
        // A watermark list stops at the first known item; a rotating list keeps
        // the whole newest page (its old posts still collect comments).
        if (opts.mode === "watermark") break
      }
      take(item)
    }
    headNext = page.next
    if (reachedKnown || !page.next || throttled) break
    after = page.next
  }
  const headExhausted = !reachedKnown && headNext !== null

  // ── History pass bookkeeping ─────────────────────────────────────────────
  let bf = prior.bf
  if (opts.mode === "watermark") {
    if (!reachedKnown && headNext === null) {
      bf = null // the head pass read the whole list
    } else if (headExhausted && (opts.fresh || !Number.isNaN(hwMs) || bf)) {
      // More new items than the head budget: continue below them down to the
      // oldest floor still owed (a legacy cursor with no mark owes nothing).
      bf = { after: headNext as string, floor: bf ? bf.floor : prior.hw }
    }
  } else if (!bf && headNext) {
    bf = { after: headNext, floor: null }
  }

  // ── History pass: bounded, skipped when Graph usage is high ──────────────
  if (bf && !throttled) {
    const floorMs = graphTime(bf.floor)
    for (let p = 0; p < opts.backfillPages && bf; p++) {
      const page = await opts.fetchPage(bf.after)
      if ("error" in page) break
      let done = false
      for (const item of page.items) {
        const t = opts.timeOf(item)
        if (
          opts.mode === "watermark" &&
          !Number.isNaN(floorMs) &&
          !Number.isNaN(t) &&
          t <= floorMs
        ) {
          done = true
          break
        }
        take(item)
      }
      if (done || !page.next) {
        // A watermark list's history is complete; a rotating one wraps back to
        // just below the newest page.
        bf =
          opts.mode === "rotating" && firstNext && firstNext !== bf.after
            ? { after: firstNext, floor: null }
            : null
        break
      }
      bf = { after: page.next, floor: bf.floor }
      if (page.throttled) break
    }
  }

  const hw = Number.isNaN(newest) ? prior.hw : new Date(newest).toISOString()
  return { items, state: { hw, bf }, heldState: prior }
}
