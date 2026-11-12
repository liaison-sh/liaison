// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Snapshot read/write helpers over `ctx.db` + the deterministic refresh-job
// handler (a resumable step, `refreshSnapshotsJob`). The snapshots (`pnl_snapshot`, `cash_snapshot`) are app-private tables
// the kernel persists as `app_pennylane.*`; `home_load` reads them instead of
// the live API. The refresh job re-derives them on a cron.
//
// All money fields persisted as strings (the QuickJS bridge serializes bigint→
// string), parsed back to bigint only where a computation needs it.

import type { StepChunkResult, StepsClient } from "@liaison/app-sdk"
import type { PennylaneClientLike, PennylaneLogger, PennylaneToolCtx } from "./ctx"
import { getClient, PennylaneConnectionError } from "./lib/get-client"
import { PennylaneRateLimitError } from "./lib/pennylane-client"
import { classifyAccount, computePnlSummary, type TbLine } from "./pnl"
import type { Filter, PnlClass } from "./types"

/**
 * Hard cap on pages a single `listAll` aggregation will follow. At the client's
 * 100-row page size this bounds one aggregation to MAX_PAGES × 100 rows, so a
 * runaway / cyclic `next_cursor` can never loop forever. Hitting the cap is
 * surfaced via `logger.warn` (never a silent truncation) so a corrupted total is
 * traceable to incomplete fetching rather than mistaken for the real figure.
 */
const LIST_ALL_MAX_PAGES = 50

/**
 * Fully drain a cursor-paginated Pennylane list endpoint, following
 * `next_cursor`/`has_more` until exhausted. Financial aggregations (trial
 * balance, ledger, transactions, bank accounts) MUST see every row — a
 * single-page read silently truncates to the API default (~50) and corrupts
 * burn / runway / gross-margin. Stops at `LIST_ALL_MAX_PAGES` with a logged
 * warning rather than spinning on a runaway response.
 */
export async function listAll<T>(
  client: PennylaneClientLike,
  path: string,
  opts: { filter?: Filter[]; params?: Record<string, string>; logger?: PennylaneLogger } = {},
): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  let pages = 0
  while (true) {
    const page = await client.list<T>(path, {
      cursor,
      limit: 100,
      filter: opts.filter,
      ...(opts.params ? { params: opts.params } : {}),
    })
    items.push(...page.items)
    pages++
    if (!page.has_more || !page.next_cursor) break
    if (pages >= LIST_ALL_MAX_PAGES) {
      opts.logger?.warn?.(
        `pennylane: ${path} hit the ${LIST_ALL_MAX_PAGES}-page fetch cap; aggregation is truncated and may be understated`,
        { path, pages, fetched: items.length },
      )
      break
    }
    cursor = page.next_cursor
  }
  return items
}

/** Default French PCG mapping when the org has authored no `account_class_map` rows. */
const DEFAULT_ACCOUNT_CLASS_MAP: Record<string, PnlClass> = {
  "70": "revenue",
  "60": "cogs",
  "62": "opex",
}

interface AppConfigRow {
  id: string
  key: string
  value: string
}

/** Resolve the read client: the test-injected one, else the live facade client. */
export async function resolveClient(ctx: PennylaneToolCtx): Promise<PennylaneClientLike> {
  if (ctx.__client) return ctx.__client as PennylaneClientLike
  const facade = await getClient(ctx)
  return facade.client
}

async function readAppConfig(ctx: PennylaneToolCtx, key: string): Promise<string | null> {
  const rows = (await ctx.db.findMany("app_config", { where: { key }, limit: 1 })) as AppConfigRow[]
  return rows[0]?.value ?? null
}

/** The org's account→class prefix mapping, or the French PCG default. */
export async function readAccountClassMap(
  ctx: PennylaneToolCtx,
): Promise<Record<string, PnlClass>> {
  // Primary store: the `account_class_map` schema table (prefix + class rows).
  const rows = (await ctx.db.findMany("account_class_map", { limit: 1000 })) as Array<{
    prefix: string
    class: PnlClass
  }>
  if (rows.length > 0) {
    const out: Record<string, PnlClass> = {}
    for (const r of rows) out[r.prefix] = r.class
    return out
  }
  // Fallback: an `app_config` row carrying the whole map as JSON (test/seed path).
  const raw = await readAppConfig(ctx, "account_class_map")
  if (raw) return JSON.parse(raw) as Record<string, PnlClass>
  return DEFAULT_ACCOUNT_CLASS_MAP
}

export interface ConnectionScope {
  scope: string
  cash_status: "live" | "unavailable"
}

/** The connect-probe verdict recorded at connect time, or null when unset. */
export async function readConnectionScope(ctx: PennylaneToolCtx): Promise<ConnectionScope | null> {
  const raw = await readAppConfig(ctx, "connection_scope")
  return raw ? (JSON.parse(raw) as ConnectionScope) : null
}

export interface PnlSnapshotRow {
  id?: string
  period: string
  revenue: string
  cogs: string
  opex: string
  other: string
  gross_margin: string
  refreshed_at: string
}

export interface CashSnapshotRow {
  id?: string
  total_by_currency: string
  cash_status: string
  refreshed_at: string
}

export async function readPnlSnapshot(ctx: PennylaneToolCtx): Promise<PnlSnapshotRow | null> {
  const rows = (await ctx.db.findMany("pnl_snapshot", { limit: 1 })) as PnlSnapshotRow[]
  return rows[0] ?? null
}

export async function readCashSnapshot(ctx: PennylaneToolCtx): Promise<CashSnapshotRow | null> {
  const rows = (await ctx.db.findMany("cash_snapshot", { limit: 1 })) as CashSnapshotRow[]
  return rows[0] ?? null
}

// — trial balance: the required period window + the live line shape —

/**
 * The date window `GET /trial_balance` reports on. Both bounds are REQUIRED by the API
 * (`period_start`, `period_end`, YYYY-MM-DD): a call without them answers 400.
 * https://pennylane.readme.io/reference/gettrialbalance
 */
export interface PeriodWindow {
  period_start: string
  period_end: string
}

interface RawFiscalYear {
  start?: string
  finish?: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Last day of a 1-based month, as YYYY-MM-DD (UTC). */
function monthEnd(year: number, month: number): string {
  return isoDate(new Date(Date.UTC(year, month, 0)))
}

/**
 * An explicit period a tool caller asked for, as a window: `YYYY`, `YYYY-MM`, `YYYY-Qn`, or
 * `YYYY-MM-DD..YYYY-MM-DD` (`/` also separates). Anything else (`current`, empty, free text)
 * is null, meaning the current period (`resolveCurrentPeriod`).
 */
export function parsePeriod(period: string | undefined): PeriodWindow | null {
  const p = (period ?? "").trim()
  let m = /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|\/)\s*(\d{4}-\d{2}-\d{2})$/.exec(p)
  if (m) return { period_start: m[1]!, period_end: m[2]! }
  m = /^(\d{4})$/.exec(p)
  if (m) return { period_start: `${m[1]}-01-01`, period_end: `${m[1]}-12-31` }
  m = /^(\d{4})-Q([1-4])$/i.exec(p)
  if (m) {
    const y = Number(m[1])
    const q = Number(m[2])
    return {
      period_start: `${m[1]}-${String(q * 3 - 2).padStart(2, "0")}-01`,
      period_end: monthEnd(y, q * 3),
    }
  }
  m = /^(\d{4})-(\d{2})$/.exec(p)
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    return { period_start: `${m[1]}-${m[2]}-01`, period_end: monthEnd(Number(m[1]), Number(m[2])) }
  }
  return null
}

/**
 * The "current" period: the open fiscal year to date (from `GET /fiscal_years`, the year whose
 * start..finish contains today), else the calendar year to date when no fiscal year covers
 * today or the token cannot read fiscal years (that endpoint needs its own scope). A rate-limit
 * refusal is re-thrown so the caller stops for this tick instead of reporting the wrong window.
 */
export async function resolveCurrentPeriod(
  client: PennylaneClientLike,
  logger?: PennylaneLogger,
  now: Date = new Date(),
): Promise<PeriodWindow> {
  const today = isoDate(now)
  try {
    const page = await client.list<RawFiscalYear>("/fiscal_years", { limit: 100 })
    const fy = page.items.find(
      (y) =>
        typeof y.start === "string" &&
        typeof y.finish === "string" &&
        ISO_DATE.test(y.start) &&
        ISO_DATE.test(y.finish) &&
        y.start <= today &&
        today <= y.finish,
    )
    if (fy?.start) return { period_start: fy.start, period_end: today }
  } catch (err) {
    if (err instanceof PennylaneRateLimitError) throw err
    logger?.warn?.("pennylane: fiscal years unreadable; using the calendar year to date", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return { period_start: `${today.slice(0, 4)}-01-01`, period_end: today }
}

/** The window for a tool's optional `period` input: the asked period, else the current one. */
export async function resolvePeriodWindow(
  client: PennylaneClientLike,
  period: string | undefined,
  logger?: PennylaneLogger,
): Promise<PeriodWindow> {
  return parsePeriod(period) ?? (await resolveCurrentPeriod(client, logger))
}

/**
 * One `/trial_balance` item. The live v2 shape is `{number, formatted_number, label, debits,
 * credits}` (major-unit decimal strings); `account_code` + a signed `balance` is the shape the
 * firm-scope ledger reconstruction produces.
 */
export interface RawTrialBalanceLine {
  number?: string
  formatted_number?: string
  account_code?: string
  label?: string
  debits?: number | string
  credits?: number | string
  balance?: number | string
}

/**
 * Normalize a trial-balance item to a `TbLine` whose balance sits on the account's natural
 * side, so every P&L bucket reads positive in normal operation: credits − debits for a
 * revenue account, debits − credits for every other account (costs, balance sheet).
 */
export function normalizeTbLine(
  raw: RawTrialBalanceLine,
  mapping: Record<string, PnlClass>,
): TbLine {
  const account_code = String(raw.number ?? raw.account_code ?? "")
  let balance_minor: bigint
  if (raw.debits !== undefined || raw.credits !== undefined) {
    const debitSide = toMinor(raw.debits) - toMinor(raw.credits)
    balance_minor = classifyAccount(account_code, mapping) === "revenue" ? -debitSide : debitSide
  } else {
    balance_minor = toMinor(raw.balance)
  }
  return { account_code, label: raw.label ?? "", balance_minor }
}
interface RawBankAccount {
  currency?: string
  balance?: number | string
}
interface RawTransaction {
  amount?: number | string
}

// Pennylane v2 returns money as MAJOR-unit decimal strings ("120.5", "-45.00"),
// so this must parse the decimal and scale to minor units — `BigInt("120.5")`
// throws "invalid bigint literal" and a bare integer coercion would be 100× off.
function toMinor(v: number | string | undefined): bigint {
  if (v === undefined || v === null || v === "") return 0n
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(v).trim())
  if (!m) return 0n
  const sign = m[1] ?? ""
  const whole = m[2] ?? "0"
  const frac = m[3] ?? ""
  const cents = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2))
  return sign === "-" ? -cents : cents
}

function isApiError403(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 403
}

/** The step the refresh runs as (`ctx.steps`): its cursor carries the partial totals. */
export const REFRESH_STEP = "refresh-snapshots"
/** Pennylane pages one chunk follows: a few seconds of calls, well inside one run. */
export const REFRESH_PAGES_PER_CHUNK = 5

type PnlBuckets = Record<"revenue" | "cogs" | "opex" | "other", string>

/** Where the refresh stands between chunks. Money as strings: the cursor is JSON. */
export interface RefreshCursor {
  /** `tb`: reading the trial balance; `bank`: the bank accounts; `write`: storing both. */
  phase: "tb" | "bank" | "write"
  window: PeriodWindow
  /** The next page of the list being read (null: its first). */
  next: string | null
  /** Pages of that list read so far. */
  pages: number
  pnl: PnlBuckets
  totals: Record<string, string>
  cashStatus: "live" | "unavailable"
}

export type RefreshSnapshotsCtx = PennylaneToolCtx & { steps: StepsClient }

/** Seconds until a rate limit lifts, as a step wake (at least 1 s, at most 15 min). */
function wakeAfter(err: PennylaneRateLimitError): number {
  return Math.min(900, Math.max(1, Math.ceil((err.retryAtMs - Date.now()) / 1000)))
}

/** One page read: `next` set while the list has more (and the page cap is not reached). */
function advance(
  c: RefreshCursor,
  page: { has_more: boolean; next_cursor: string | null },
  path: string,
  fetched: number,
  logger: PennylaneLogger | undefined,
): { more: boolean; cursor: RefreshCursor } {
  const pages = c.pages + 1
  if (page.has_more && page.next_cursor && pages < LIST_ALL_MAX_PAGES) {
    return { more: true, cursor: { ...c, pages, next: page.next_cursor } }
  }
  if (page.has_more && page.next_cursor) {
    logger?.warn?.(
      `pennylane: ${path} hit the ${LIST_ALL_MAX_PAGES}-page fetch cap; aggregation is truncated and may be understated`,
      { path, pages, fetched },
    )
  }
  return { more: false, cursor: { ...c, pages: 0, next: null } }
}

/**
 * Re-derive `pnl_snapshot` + `cash_snapshot` from the live book. Cron handler.
 *
 * A resumable step: each chunk reads at most `REFRESH_PAGES_PER_CHUNK` Pennylane pages and
 * keeps the partial totals in the step's cursor, so no run waits on the whole book and no run
 * holds a transaction; a rate limit stops the run and wakes the next one when it lifts. The
 * last chunk writes both snapshots (each write is an idempotent upsert of a singleton row).
 */
export async function refreshSnapshotsJob(
  ctx: RefreshSnapshotsCtx,
  payload: Record<string, unknown> = {},
): Promise<{ state: string }> {
  let client: PennylaneClientLike
  try {
    client = await resolveClient(ctx)
  } catch (err) {
    // The cron runs in every workspace with the app installed: with no Pennylane connection
    // there is nothing to refresh until one is made. A connection that exists but cannot be
    // used (incomplete credentials) is a fault and still throws.
    if (err instanceof PennylaneConnectionError && err.notConnected) {
      ctx.logger?.info?.("pennylane refresh-snapshots skipped: not connected")
      return { state: "skipped" }
    }
    throw err
  }

  // A fresh trigger (the cron, not a continuation) of a finished refresh starts a new one.
  if (payload._steps === undefined && (await ctx.steps.get(REFRESH_STEP))?.done) {
    await ctx.steps.reset(REFRESH_STEP)
  }

  const chunk = async (saved: RefreshCursor | null): Promise<StepChunkResult<RefreshCursor>> => {
    let c: RefreshCursor | null = saved
    try {
      if (!c) {
        // P&L over the current period (fiscal year to date, else calendar year to date): the
        // trial balance requires the window and answers 400 without it.
        c = {
          phase: "tb",
          window: await resolveCurrentPeriod(client, ctx.logger),
          next: null,
          pages: 0,
          pnl: { revenue: "0", cogs: "0", opex: "0", other: "0" },
          totals: {},
          cashStatus: "live",
        }
      }
      const mapping = await readAccountClassMap(ctx)
      for (let i = 0; i < REFRESH_PAGES_PER_CHUNK && c.phase !== "write"; i++) {
        if (c.phase === "tb") {
          // Fully paginated: a French PCG chart of accounts routinely exceeds one page, and a
          // truncated trial balance silently corrupts gross margin.
          const page = await client.list<RawTrialBalanceLine>("/trial_balance", {
            ...(c.next ? { cursor: c.next } : {}),
            limit: 100,
            params: { ...c.window },
          })
          const part = computePnlSummary(
            page.items.map((l) => normalizeTbLine(l, mapping)),
            mapping,
          )
          const pnl: PnlBuckets = {
            revenue: String(BigInt(c.pnl.revenue) + part.revenue),
            cogs: String(BigInt(c.pnl.cogs) + part.cogs),
            opex: String(BigInt(c.pnl.opex) + part.opex),
            other: String(BigInt(c.pnl.other) + part.other),
          }
          const step = advance({ ...c, pnl }, page, "/trial_balance", page.items.length, ctx.logger)
          c = step.more ? step.cursor : { ...step.cursor, phase: "bank" }
          if (
            c.phase === "bank" &&
            (await readConnectionScope(ctx))?.cash_status === "unavailable"
          ) {
            c = { ...c, phase: "write", cashStatus: "unavailable" }
          }
          continue
        }
        // Cash from the live bank accounts (degrade on 403).
        let page: { items: RawBankAccount[]; has_more: boolean; next_cursor: string | null }
        try {
          page = await client.list<RawBankAccount>("/bank_accounts", {
            ...(c.next ? { cursor: c.next } : {}),
            limit: 100,
          })
        } catch (err) {
          if (!isApiError403(err)) throw err
          c = { ...c, phase: "write", cashStatus: "unavailable", totals: {} }
          continue
        }
        const totals = { ...c.totals }
        for (const a of page.items) {
          const cur = a.currency ?? "EUR"
          totals[cur] = String(BigInt(totals[cur] ?? "0") + toMinor(a.balance))
        }
        const step = advance(
          { ...c, totals },
          page,
          "/bank_accounts",
          page.items.length,
          ctx.logger,
        )
        c = step.more ? step.cursor : { ...step.cursor, phase: "write" }
      }
    } catch (err) {
      if (err instanceof PennylaneRateLimitError) {
        return { done: false, cursor: c, wakeIn: wakeAfter(err) }
      }
      throw err
    }
    if (!c || c.phase !== "write") return { done: false, cursor: c }

    const now = new Date().toISOString()
    const revenue = BigInt(c.pnl.revenue)
    const cogs = BigInt(c.pnl.cogs)
    await upsertSingleton(ctx, "pnl_snapshot", {
      // "current" = the window `resolveCurrentPeriod` picked: fiscal (else calendar) year to date.
      period: "current",
      revenue: c.pnl.revenue,
      cogs: c.pnl.cogs,
      opex: c.pnl.opex,
      other: c.pnl.other,
      gross_margin: String(revenue - cogs),
      refreshed_at: now,
    })
    await upsertSingleton(ctx, "cash_snapshot", {
      total_by_currency: JSON.stringify(c.totals),
      cash_status: c.cashStatus,
      refreshed_at: now,
    })
    return { done: true, cursor: c }
  }

  const run = await ctx.steps.run<RefreshCursor>(REFRESH_STEP, {}, chunk)
  return { state: run.state }
}

async function upsertSingleton(
  ctx: PennylaneToolCtx,
  entity: string,
  data: Record<string, unknown>,
): Promise<void> {
  const rows = (await ctx.db.findMany(entity, { limit: 1 })) as Array<{ id: string }>
  if (rows[0]) await ctx.db.update(entity, rows[0].id, data)
  else await ctx.db.insert(entity, data)
}
