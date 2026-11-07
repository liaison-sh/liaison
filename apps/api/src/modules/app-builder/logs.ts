// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Logs of custom apps and draft previews (kernel.app_logs, migration 0276).
//
//  - Writer: a run's `ctx.logger` lines go into a per-run sink (created by the
//    sandbox bridge for a custom app, or for a draft preview the builder marks),
//    flushed in batches when the run ends (`runApp`) and, as a fallback, two
//    seconds after the first unflushed line. Best effort: a write that fails is
//    logged and dropped, never the run's failure. Per run at most 200 lines and
//    256 KiB (the last line kept is a notice saying more were dropped); a
//    message is cut at 4 KiB, fields at 8 KiB.
//  - Each row carries the run's actor and scope tags: the read scopes of the
//    calling turn, the calling tool included (or the app's own scopes for a run
//    no turn started: a job, a webhook). A turn whose taint is unknown is
//    tagged `UNKNOWN_TAINT_TAGS`, which only a full grant covers.
//  - Readers: `readAppLogs` runs in the reader's RLS transaction; the database
//    returns only rows whose every tag the reader's scopes cover, an app's rows
//    to holders of kernel:apps:logs, a draft preview's rows to their run's
//    person only. Log text is written by app code: whoever puts it in an
//    agent's context marks the turn as having read outside text.
//  - Retention: `pruneAppLogs` (kernel job `app-logs-retention`) keeps 7 days
//    and the newest 10,000 rows per (org, app).

import { randomUUID } from "node:crypto"
import { and, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { type AppLogLevel, type AppLogRow, appLogs } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "app-logs" })

export const LOG_MESSAGE_MAX_BYTES = 4 * 1024
export const LOG_FIELDS_MAX_BYTES = 8 * 1024
export const RUN_LOG_MAX_LINES = 200
export const RUN_LOG_MAX_BYTES = 256 * 1024
export const APP_LOG_RETENTION_DAYS = 7
export const APP_LOG_MAX_ROWS_PER_APP = 10_000
export const READ_APP_LOGS_MAX_LIMIT = 200
/** Fallback flush delay after the first unflushed line. */
export const RUN_LOG_FLUSH_DELAY_MS = 2_000
/** The tag of a run whose turn's taint could not be known: only a full grant covers it. */
export const UNKNOWN_TAINT_TAGS: readonly string[] = UNKNOWN_TURN_TAINT

const LEVELS: readonly AppLogLevel[] = ["debug", "info", "warn", "error"]
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isAppLogLevel(value: unknown): value is AppLogLevel {
  return typeof value === "string" && (LEVELS as readonly string[]).includes(value)
}

export interface RunLogTarget {
  orgId: string
  /** The app the lines belong to (a draft preview: the draft's custom app name). */
  app: string
  /** Set for a draft preview's run: its lines are its actor's alone. */
  draftId?: string | null
  /** Given by the caller to find the run's lines again; a fresh uuid otherwise. */
  runId?: string
  /** The person whose run this is (a user id; anything else records none). */
  actorUserId?: string | null
  /** The run's read scopes (see the header). */
  scopeTags: readonly string[]
}

export interface RunLogLine {
  level: AppLogLevel
  message: string
  fields: Record<string, unknown>
  at: Date
}

export interface RunLogSink {
  readonly runId: string
  /** Never throws; past the run's cap the line is counted as dropped. */
  append(level: AppLogLevel, message: unknown, fields?: unknown): void
  /** Every line kept for this run so far (a preview returns them with its result). */
  lines(): readonly RunLogLine[]
  /** Lines refused by the cap. */
  dropped(): number
  /** Writes the unflushed lines. Never throws. */
  flush(): Promise<void>
}

function cutUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  let out = Buffer.from(text).subarray(0, maxBytes).toString("utf8")
  // A cut through a multi-byte character decodes to U+FFFD: drop it.
  while (Buffer.byteLength(out) > maxBytes || out.endsWith("�")) out = out.slice(0, -1)
  return out
}

function normalizeFields(fields: unknown): Record<string, unknown> {
  if (fields === undefined || fields === null) return {}
  let value: unknown = fields
  if (typeof fields === "string") {
    try {
      value = JSON.parse(fields)
    } catch {
      value = { value: fields }
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) value = { value }
  let text: string
  try {
    text = JSON.stringify(value)
  } catch {
    return { unserializable: true }
  }
  if (Buffer.byteLength(text) <= LOG_FIELDS_MAX_BYTES) return JSON.parse(text)
  return { truncated: true, preview: cutUtf8(text, 1024) }
}

function normalizeTags(tags: readonly string[]): string[] {
  return [
    ...new Set(tags.filter((t) => typeof t === "string" && t !== "" && !t.includes(","))),
  ].sort()
}

/** A run's log sink. Lines are kept in memory and written on flush. */
export function createRunLogSink(target: RunLogTarget): RunLogSink {
  const runId = target.runId && UUID_RE.test(target.runId) ? target.runId : randomUUID()
  const actorUserId =
    target.actorUserId && UUID_RE.test(target.actorUserId) ? target.actorUserId : null
  const scopeTags = normalizeTags(target.scopeTags)
  const kept: RunLogLine[] = []
  let pending: RunLogLine[] = []
  let bytes = 0
  let droppedCount = 0
  let noticeWritten = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> = Promise.resolve()

  const write = async (rows: RunLogLine[]): Promise<void> => {
    if (rows.length === 0) return
    const values = (actor: string | null) =>
      rows.map((r) => ({
        orgId: target.orgId,
        app: target.app,
        draftId: target.draftId ?? null,
        runId,
        actorUserId: actor,
        scopeTags,
        level: r.level,
        message: r.message,
        fields: r.fields,
        at: r.at,
      }))
    const insert = (actor: string | null) =>
      withRlsContext(
        { actorType: "system", orgId: target.orgId, purpose: "job", scopes: [] },
        (tx) => tx.insert(appLogs).values(values(actor)),
      )
    let failure: unknown
    try {
      await insert(actorUserId)
      return
    } catch (err) {
      failure = err
    }
    // The actor is not (or no longer) a person of the org: keep the lines without one.
    if (actorUserId !== null && (failure as { code?: string })?.code === "23503") {
      try {
        await insert(null)
        return
      } catch (retryErr) {
        failure = retryErr
      }
    }
    log.warn(
      { err: failure, orgId: target.orgId, app: target.app, runId, lines: rows.length },
      "app log lines could not be written; dropped",
    )
  }

  const flushNow = (): Promise<void> => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const rows = pending
    pending = []
    if (droppedCount > 0 && !noticeWritten) {
      noticeWritten = true
      const notice: RunLogLine = {
        level: "warn",
        message: `Log limit reached (${RUN_LOG_MAX_LINES} lines or ${RUN_LOG_MAX_BYTES / 1024} KiB per run): later lines were dropped.`,
        fields: {},
        at: new Date(),
      }
      kept.push(notice)
      rows.push(notice)
    }
    inflight = inflight.then(() => write(rows))
    return inflight
  }

  return {
    runId,
    append(level, message, fields) {
      try {
        const lvl = isAppLogLevel(level) ? level : "info"
        const text = cutUtf8(
          typeof message === "string" ? message : String(message),
          LOG_MESSAGE_MAX_BYTES,
        )
        const f = normalizeFields(fields)
        const size = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(f))
        // One line is kept back for the notice that later lines were dropped.
        if (
          noticeWritten ||
          kept.length >= RUN_LOG_MAX_LINES - 1 ||
          bytes + size > RUN_LOG_MAX_BYTES
        ) {
          droppedCount++
          return
        }
        bytes += size
        const line: RunLogLine = { level: lvl, message: text, fields: f, at: new Date() }
        kept.push(line)
        pending.push(line)
        if (!timer) {
          timer = setTimeout(() => void flushNow(), RUN_LOG_FLUSH_DELAY_MS)
          timer.unref?.()
        }
      } catch (err) {
        droppedCount++
        log.debug({ err, app: target.app }, "app log line refused")
      }
    },
    lines: () => kept,
    dropped: () => droppedCount,
    flush: () =>
      pending.length > 0 || (droppedCount > 0 && !noticeWritten) ? flushNow() : inflight,
  }
}

const sinks = new WeakMap<object, RunLogSink>()

/** Binds a run's sink to its bridge, so the run's end (`runApp`) flushes it. */
export function attachRunLogSink(bridge: object, sink: RunLogSink): void {
  sinks.set(bridge, sink)
}

/** The sink bound to a bridge, if any. */
export function runLogSinkOf(bridge: object): RunLogSink | undefined {
  return sinks.get(bridge)
}

/** Flushes the bridge's sink, if it has one. Never throws. */
export async function flushRunLogs(bridge: object): Promise<void> {
  const sink = sinks.get(bridge)
  if (!sink) return
  try {
    await sink.flush()
  } catch (err) {
    log.warn({ err }, "app log flush failed")
  }
}

export interface ReadAppLogsInput {
  /** One of `app` (an app's lines) or `draftId` (a draft preview's lines). */
  app?: string
  draftId?: string
  since?: Date
  /** The lowest level returned (`warn`: warnings and errors). */
  level?: AppLogLevel
  runId?: string
  /** At most 200, default 100. */
  limit?: number
}

export interface AppLogEntry {
  id: string
  app: string
  draftId: string | null
  runId: string
  actorUserId: string | null
  level: AppLogLevel
  message: string
  fields: Record<string, unknown>
  at: string
}

export class AppLogsQueryError extends Error {
  readonly code = "invalid_query"
}

function toEntry(r: AppLogRow): AppLogEntry {
  return {
    id: r.id,
    app: r.app,
    draftId: r.draftId,
    runId: r.runId,
    actorUserId: r.actorUserId,
    level: r.level,
    message: r.message,
    fields: r.fields,
    at: r.at.toISOString(),
  }
}

/**
 * Log lines, newest first, in the READER's RLS transaction: the database keeps
 * every row whose tags the reader's scopes do not cover (and other people's
 * draft preview lines) out.
 */
export async function readAppLogs(tx: RlsClient, input: ReadAppLogsInput): Promise<AppLogEntry[]> {
  if ((input.app === undefined) === (input.draftId === undefined)) {
    throw new AppLogsQueryError("give one of app or draftId")
  }
  if (input.draftId !== undefined && !UUID_RE.test(input.draftId)) {
    throw new AppLogsQueryError("draftId is not a draft id")
  }
  if (input.runId !== undefined && !UUID_RE.test(input.runId)) {
    throw new AppLogsQueryError("runId is not a run id")
  }
  if (input.level !== undefined && !isAppLogLevel(input.level)) {
    throw new AppLogsQueryError(`level is one of ${LEVELS.join(", ")}`)
  }
  const limit = Math.max(1, Math.min(READ_APP_LOGS_MAX_LIMIT, Math.floor(input.limit ?? 100)))
  const where: SQL[] = [
    input.app !== undefined ? eq(appLogs.app, input.app) : eq(appLogs.draftId, input.draftId!),
  ]
  if (input.since) where.push(gte(appLogs.at, input.since))
  if (input.runId) where.push(eq(appLogs.runId, input.runId))
  if (input.level) where.push(inArray(appLogs.level, LEVELS.slice(LEVELS.indexOf(input.level))))
  const rows = await tx
    .select()
    .from(appLogs)
    .where(and(...where))
    .orderBy(desc(appLogs.at), desc(appLogs.id))
    .limit(limit)
  return rows.map(toEntry)
}

const PRUNE_BATCH = 5_000

/**
 * Retention: rows older than 7 days, then each (org, app)'s rows past its
 * newest 10,000. An org being moved keeps its rows until the move ends.
 */
export async function pruneAppLogs(
  opts: { now?: Date; retentionDays?: number; maxRowsPerApp?: number } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date()
  const days = opts.retentionDays ?? APP_LOG_RETENTION_DAYS
  const keep = opts.maxRowsPerApp ?? APP_LOG_MAX_ROWS_PER_APP
  const cutoff = new Date(now.getTime() - days * 86_400_000)
  let deleted = 0
  for (;;) {
    const result = await sweepSkippingMoving((notMoving) =>
      withSystemDb("app-logs-retention", (db) =>
        db.execute(sql`
          WITH doomed AS (
            SELECT id FROM ${appLogs}
            WHERE ${lt(appLogs.at, cutoff)} AND ${notMoving(sql`org_id`)}
            LIMIT ${PRUNE_BATCH}
          )
          DELETE FROM ${appLogs} l USING doomed WHERE l.id = doomed.id
          RETURNING l.id
        `),
      ),
    )
    const n = extractRows(result).length
    deleted += n
    if (n < PRUNE_BATCH) break
  }
  const result = await sweepSkippingMoving((notMoving) =>
    withSystemDb("app-logs-retention", (db) =>
      db.execute(sql`
        WITH busy AS (
          SELECT org_id, app FROM ${appLogs}
          WHERE ${notMoving(sql`org_id`)}
          GROUP BY org_id, app
          HAVING count(*) > ${keep}
        ),
        ranked AS (
          SELECT l.id, row_number() OVER (PARTITION BY l.org_id, l.app ORDER BY l.at DESC, l.id DESC) AS rn
          FROM ${appLogs} l JOIN busy b ON b.org_id = l.org_id AND b.app = l.app
        )
        DELETE FROM ${appLogs} l USING ranked r WHERE l.id = r.id AND r.rn > ${keep}
        RETURNING l.id
      `),
    ),
  )
  deleted += extractRows(result).length
  if (deleted > 0) log.info({ count: deleted }, "app logs retention cleanup")
  return { deleted }
}
