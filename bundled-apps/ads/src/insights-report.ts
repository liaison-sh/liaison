// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Meta async insights reports across runs. A large insights pull is a report
// run Meta builds in the background; no run waits for it. The first call
// starts the run, keeps its id in the app store (`insights_reports`, keyed by a
// digest of the request) and arms a wake-up of the `insights-report` job; every
// later call with the same request resumes THAT run instead of starting a new
// one. The job asks Meta once per wake, re-arms itself with a growing delay
// while the report runs, and parks the finished rows (or the failure) in the
// store, so the caller's next call answers without asking Meta at all.
//
// A record older than REPORT_MAX_AGE_MS is dropped and the next call starts a
// fresh run: insights keep changing, and Meta expires report results.

import { digestHex } from "@liaison/app-sdk/bytes"
import { getMetaClient } from "./lib/get-client"
import {
  checkInsightsReport,
  createInsightsReport,
  type InsightsPending,
  isInsightsPending,
  MetaApiError,
  type MetaAuth,
  RateLimitError,
} from "./lib/meta-client"

export const INSIGHTS_REPORTS = "insights_reports"
export const INSIGHTS_REPORT_JOB = "insights-report"

/** A report run older than this is dropped (its rows too) and started afresh. */
export const REPORT_MAX_AGE_MS = 60 * 60 * 1000
/** First wake-up after a run starts, then doubled per wake up to the cap. */
const FIRST_WAKE_SECONDS = 15
const MAX_WAKE_SECONDS = 300
/** Rows parked by the job only below this size (a store document holds 256 KiB). */
const MAX_PARKED_ROWS_CHARS = 200_000

export interface InsightsReportRecord {
  reportRunId: string
  /** ISO time the run was started. */
  startedAt: string
  /** Wake-ups the job has spent on this run. */
  wakes: number
  /** The finished rows, parked by the job. */
  rows?: unknown[]
  /** Meta's terminal failure, parked by the job. */
  failed?: string
}

interface StoreDoc<T> {
  data: T
  version: number
}

export interface InsightsReportCtx {
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<unknown>
  store: {
    get(collection: string, id: string): Promise<StoreDoc<InsightsReportRecord> | null>
    set(
      collection: string,
      id: string,
      data: InsightsReportRecord,
      opts?: { ifVersion?: number },
    ): Promise<unknown>
    delete(collection: string, id: string): Promise<unknown>
  }
  timers: {
    wakeIn(
      seconds: number,
      jobName: string,
      payload?: Record<string, unknown>,
      opts?: { jobId?: string },
    ): Promise<void>
  }
}

/** Object keys sorted at every level, so equal requests digest alike. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  )
}

/** The store id of a report request: a digest of its path and params. */
export function insightsReportKey(path: string, params: Record<string, unknown>): Promise<string> {
  return digestHex("SHA-256", stableJson({ path, params }))
}

function expired(rec: InsightsReportRecord, now: number): boolean {
  const started = Date.parse(rec.startedAt)
  return !Number.isFinite(started) || now - started > REPORT_MAX_AGE_MS
}

function wakeDelay(wakes: number): number {
  return Math.min(FIRST_WAKE_SECONDS * 2 ** wakes, MAX_WAKE_SECONDS)
}

const wakeOpts = (key: string) => ({ jobId: `insights-report-${key}` })

/**
 * A read-only run (a withheld turn answered again from reads alone) may not
 * write the store or arm a timer: the report is then asked about once and not
 * remembered, which is what a read may do.
 */
function isReadOnlyRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return (
    e?.code === "E_READ_ONLY_RUN_BLOCKED" ||
    String(e?.message ?? "").includes("E_READ_ONLY_RUN_BLOCKED")
  )
}

async function forget(ctx: InsightsReportCtx, key: string): Promise<void> {
  try {
    await ctx.store.delete(INSIGHTS_REPORTS, key)
  } catch (err) {
    if (!isReadOnlyRefusal(err)) throw err
  }
}

/**
 * The rows of an async insights report for this request, or a pending marker
 * carrying the report run a later call resumes. Never waits inside the run.
 */
export async function fetchInsightsReport(
  ctx: InsightsReportCtx,
  opts: { path: string; params: Record<string, unknown>; auth: MetaAuth },
): Promise<unknown[] | InsightsPending> {
  const key = await insightsReportKey(opts.path, opts.params)
  let doc = await ctx.store.get(INSIGHTS_REPORTS, key)
  if (doc && expired(doc.data, Date.now())) {
    await forget(ctx, key)
    doc = null
  }
  if (doc?.data.failed) {
    await forget(ctx, key)
    throw new MetaApiError(doc.data.failed, 0)
  }
  if (doc?.data.rows) {
    await forget(ctx, key)
    return doc.data.rows
  }

  let reportRunId = doc?.data.reportRunId
  if (!reportRunId) {
    reportRunId = await createInsightsReport(ctx.fetch, opts)
    const record: InsightsReportRecord = {
      reportRunId,
      startedAt: new Date().toISOString(),
      wakes: 0,
    }
    try {
      await ctx.store.set(INSIGHTS_REPORTS, key, record, { ifVersion: 0 })
      await ctx.timers.wakeIn(wakeDelay(0), INSIGHTS_REPORT_JOB, { report: key }, wakeOpts(key))
    } catch (err) {
      if ((err as { code?: unknown })?.code === "version_conflict") {
        // A concurrent call started the same report first: follow that one.
        const other = await ctx.store.get(INSIGHTS_REPORTS, key)
        if (other?.data.reportRunId) reportRunId = other.data.reportRunId
      } else if (!isReadOnlyRefusal(err)) {
        throw err
      }
    }
  }

  let answer: unknown[] | InsightsPending
  try {
    answer = await checkInsightsReport(ctx.fetch, { reportRunId, auth: opts.auth })
  } catch (err) {
    // A failed or unknown run is not resumed: the next call starts afresh.
    if (!(err instanceof RateLimitError)) await forget(ctx, key)
    throw err
  }
  if (!isInsightsPending(answer)) await forget(ctx, key)
  return answer
}

/**
 * The `insights-report` job: one look at a stored report run per wake. Parks
 * the rows or the failure for the next call, or re-arms itself while the run
 * is still building. A record that is gone, finished or too old ends it.
 */
export async function insightsReportJob(
  payload: { report?: unknown },
  ctx: InsightsReportCtx & { connections: unknown },
): Promise<{ state: string }> {
  // `report`: the store id of the report record (insightsReportKey).
  const key = typeof payload?.report === "string" ? payload.report : ""
  if (!key) return { state: "no_key" }
  const doc = await ctx.store.get(INSIGHTS_REPORTS, key)
  if (!doc) return { state: "gone" }
  const rec = doc.data
  if (rec.rows || rec.failed) return { state: "parked" }
  if (expired(rec, Date.now())) {
    await ctx.store.delete(INSIGHTS_REPORTS, key)
    return { state: "expired" }
  }

  let auth: MetaAuth
  try {
    ;({ auth } = await getMetaClient(ctx))
  } catch (err) {
    // Meta disconnected since the report started: nothing left to ask.
    await ctx.store.delete(INSIGHTS_REPORTS, key)
    return { state: "not_connected" }
  }

  let answer: unknown[] | InsightsPending
  try {
    answer = await checkInsightsReport(ctx.fetch, { reportRunId: rec.reportRunId, auth })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await ctx.store.set(
      INSIGHTS_REPORTS,
      key,
      { ...rec, failed: message },
      { ifVersion: doc.version },
    )
    return { state: "failed" }
  }

  if (!isInsightsPending(answer)) {
    if (JSON.stringify(answer).length <= MAX_PARKED_ROWS_CHARS) {
      await ctx.store.set(
        INSIGHTS_REPORTS,
        key,
        { ...rec, rows: answer },
        { ifVersion: doc.version },
      )
      return { state: "parked" }
    }
    // Too large to park: the next call extracts it from Meta itself.
    return { state: "ready" }
  }

  const wakes = rec.wakes + 1
  await ctx.store.set(INSIGHTS_REPORTS, key, { ...rec, wakes }, { ifVersion: doc.version })
  await ctx.timers.wakeIn(wakeDelay(wakes), INSIGHTS_REPORT_JOB, { report: key }, wakeOpts(key))
  return { state: answer.reason }
}
