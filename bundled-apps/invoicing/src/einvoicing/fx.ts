// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ECB reference rates for non-EUR documents. The rate is needed once, at issue: each issuing
// path warms it just before `issueDocument` (one fetch per currency and day, cached in
// `fx_rates`, so every other document issued that day reuses it), and `issueDocument` only reads
// the cache, never the network. A foreign-currency e-invoice with no rate at most 7 days old is
// refused before numbering (`FxRateUnavailableError`, retryable): its Factur-X needs the VAT total
// in EUR, and an issued document never gets it later. Any other document issues without one.
// Rates are foreign units per 1 EUR: EUR = amount / rate, half-up to 2 decimals.
// The sandbox has no typed arrays or Buffer: the response is parsed as plain text.

export const ECB_HOST = "data-api.ecb.europa.eu"
const ECB_PATH = `https://${ECB_HOST}/service/data/EXR`
const USER_AGENT = "Liaison invoicing (fx rates)"

/** A cached rate older than this (against the requested date) is a miss, never a stale guess. */
export const FX_MAX_AGE_DAYS = 7
const DAY_MS = 86_400_000
const FETCH_ATTEMPTS = 2

type Row = Record<string, unknown>

export interface FxFetchCtx {
  fetch?: (
    url: string,
    opts?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<unknown>
}

export interface FxDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number; offset?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
}

export type FxFetchResult =
  | { ok: true; rate: string; rate_date: string }
  | { ok: false; code: "fx_rate_unavailable" }

const UNAVAILABLE: FxFetchResult = { ok: false, code: "fx_rate_unavailable" }

/** Split one CSV line, honouring double-quoted fields. */
function csvFields(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += c
    } else if (c === '"') quoted = true
    else if (c === ",") {
      out.push(cur)
      cur = ""
    } else cur += c
  }
  out.push(cur)
  return out
}

/** `OBS_VALUE` / `TIME_PERIOD` of the last observation of an ECB `csvdata` body; null when none. */
export function parseEcbCsv(text: string): { rate: string; rate_date: string } | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "")
  if (lines.length < 2) return null
  const header = csvFields(lines[0] as string).map((h) => h.trim())
  const iValue = header.indexOf("OBS_VALUE")
  const iDate = header.indexOf("TIME_PERIOD")
  if (iValue < 0 || iDate < 0) return null
  const cells = csvFields(lines[lines.length - 1] as string)
  const rate = (cells[iValue] ?? "").trim()
  const date = (cells[iDate] ?? "").trim()
  if (!/^\d+(\.\d+)?$/.test(rate) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  if (!/[1-9]/.test(rate)) return null
  return { rate, rate_date: date }
}

function envelope(raw: unknown): { status?: number; body?: string } | null {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as { status?: number; body?: string }
    } catch {
      return null
    }
  }
  return (raw ?? null) as { status?: number; body?: string } | null
}

/**
 * The last rate the ECB published on or before `onOrBefore` (YYYY-MM-DD). An empty 200 (no
 * business day in the window) or a transport failure is retried once, then `fx_rate_unavailable`.
 */
export async function fetchEcbRate(
  ctx: FxFetchCtx,
  currency: string,
  onOrBefore: string,
): Promise<FxFetchResult> {
  if (!ctx.fetch || !/^[A-Z]{3}$/.test(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(onOrBefore)) return UNAVAILABLE
  const url = `${ECB_PATH}/D.${currency}.EUR.SP00.A?endPeriod=${onOrBefore}&lastNObservations=1&format=csvdata`
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    try {
      const res = envelope(await ctx.fetch(url, { method: "GET", headers: { "User-Agent": USER_AGENT } }))
      if (res?.status === 200 && typeof res.body === "string") {
        const parsed = parseEcbCsv(res.body)
        if (parsed) return { ok: true, ...parsed }
      }
    } catch {
      // fall through to the retry
    }
  }
  return UNAVAILABLE
}

function dayBefore(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() - days * DAY_MS).toISOString().slice(0, 10)
}

/** Rows per read when scanning the cache newest-first for the rate on or before a date. */
const CACHE_PAGE = 20

/**
 * The cached rate for `currency`: latest `rate_date` ≤ `date`, at most 7 days older than it.
 * The bridge's `where` has equality, `{ in }` and IS NULL but no range operator, so the cache is
 * read ordered by `rate_date` descending a page at a time: rows after `date` (a back-dated
 * document) are skipped, the first row on or before it wins, and the scan stops at the 7-day
 * floor, so a cache of any size is never truncated.
 */
export async function cachedRate(
  db: Pick<FxDb, "findMany">,
  currency: string,
  date: string,
): Promise<{ rate: string; rate_date: string } | null> {
  const floor = dayBefore(date, FX_MAX_AGE_DAYS)
  for (let offset = 0; ; offset += CACHE_PAGE) {
    const rows = (await db.findMany("fx_rates", {
      where: { currency },
      orderBy: { rate_date: "desc" },
      limit: CACHE_PAGE,
      offset,
    })) as Row[]
    for (const r of rows) {
      const d = typeof r.rate_date === "string" ? r.rate_date : null
      const rate = typeof r.rate === "string" ? r.rate : null
      if (!d || d > date) continue
      if (d < floor) return null
      if (rate) return { rate, rate_date: d }
    }
    if (rows.length < CACHE_PAGE) return null
  }
}

/** `amount / rate` in EUR minor units, half-up (away from zero) at 2 decimals; `exp` = the
 *  source currency's minor-unit exponent. Exact bigint arithmetic on the decimal rate string. */
export function eurMinor(amountMinor: bigint, rate: string, exp = 2): bigint {
  const [whole = "0", frac = ""] = rate.split(".")
  const num = BigInt(whole + frac)
  if (num <= 0n) throw new Error("fx rate must be positive")
  const scale = 10n ** BigInt(frac.length)
  const negative = amountMinor < 0n
  const abs = negative ? -amountMinor : amountMinor
  const numerator = abs * 100n * scale
  const denominator = (10n ** BigInt(exp)) * num
  const q = (2n * numerator + denominator) / (2n * denominator)
  return negative ? -q : q
}

async function store(db: FxDb, currency: string, rate: string, rateDate: string, now: Date): Promise<boolean> {
  const existing = (await db.findMany("fx_rates", { where: { currency, rate_date: rateDate }, limit: 1 })) as Row[]
  if (existing.length > 0) return false
  await db.insert("fx_rates", { currency, rate_date: rateDate, rate, fetched_at: now })
  return true
}

/**
 * Best-effort warm-up, run by each issuing path just before `issueDocument`: fetch the rate for
 * `date` and cache it. Never throws; a miss leaves the cache as it was, and `issueDocument` decides
 * whether the document can go without a rate.
 */
export async function warmFxRate(
  ctx: FxFetchCtx & { db: FxDb },
  currency: string,
  date: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    if (!currency || currency === "EUR") return
    const day = date.slice(0, 10)
    const hit = await cachedRate(ctx.db, currency, day)
    if (hit && hit.rate_date === day) return
    const res = await fetchEcbRate(ctx, currency, day)
    if (res.ok) await store(ctx.db, currency, res.rate, res.rate_date, now)
  } catch {
    // warm-up is optional
  }
}

/** The day whose rate a document snapshots: its issue date, else today (as `issueDocument`). */
export function fxIssueDate(issuedAt: string | null | undefined, now: Date = new Date()): string {
  return (issuedAt ?? now.toISOString()).slice(0, 10)
}

/**
 * Raised by `issueDocument` before numbering when a foreign-currency e-invoice has no cached rate
 * (the ECB was unreachable when the issuing path warmed it). Nothing is persisted; issuing again
 * later succeeds once the ECB answers.
 */
export class FxRateUnavailableError extends Error {
  readonly code = "fx_rate_unavailable"
  readonly retryable = true
  constructor(readonly currency: string, readonly date: string) {
    super(
      `A ${currency} e-invoice needs its VAT total in EUR at the ECB reference rate, and no rate on or ` +
        `in the ${FX_MAX_AGE_DAYS} days before ${date} could be fetched (the ECB did not answer). Nothing was ` +
        "issued and no number was used: issue it again in a few minutes.",
    )
    this.name = "FxRateUnavailableError"
  }
}

/** The typed, retryable tool error for an `FxRateUnavailableError`. */
export function fxRateUnavailableEnvelope(err: FxRateUnavailableError): {
  status: "error"
  error: { code: string; message: string; retryable: true }
} {
  return { status: "error", error: { code: err.code, message: err.message, retryable: true } }
}
