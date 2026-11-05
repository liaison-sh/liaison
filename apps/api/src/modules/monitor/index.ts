// SPDX-License-Identifier: FSL-1.1-ALv2
import { timingSafeEqual } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import { extractRows } from "~/db"
import { getPoolDiagState, getPoolGauges, nestedPrivilegedAcquisitions } from "~/db/pool-diag"
import { withSystemDb } from "~/db/privileged"
import { poolPlan } from "~/db/process-pool-plan"
import { schemaRef } from "~/db/schema-ref"
import { getWorkerHeartbeat } from "~/infra/events/outbox-worker"
import { getBackpressureState } from "~/infra/jobs/backpressure"
import {
  fairnessDegradedLocally,
  fairnessEnabled,
  isFairQueue,
  readQueueFairness,
  readWaitP95Ms,
} from "~/infra/jobs/fairness"
import { readJobMetrics } from "~/infra/jobs/fanout-keys"
import { getJobSchedulerTotal, getQueueHealth } from "~/infra/jobs/jobs"
import { pinnedJobsGate } from "~/infra/jobs/pinned-jobs-gate"
import type { QueueHealth } from "~/infra/jobs/queue-health"
import { env } from "~/lib/env"
import { getDiagErrorState } from "~/lib/error-tracker"
import { monitorLogger as log } from "~/lib/logger"
import { orgRegistryGuardStats } from "~/modules/apps/org-registry-guard"
import {
  type DepStatus,
  probeDb,
  probeMeili,
  probeRedis,
  probeStorage,
  withTimeout,
} from "~/modules/healthz"
import { getSecurityEventDiag } from "~/modules/security/security-events"
import {
  type UpstreamActivity,
  type UpstreamProbeFailure,
  webhookIngestDiag,
  webhookUpstreamProbeApps,
} from "~/modules/webhooks/ingest-health"
import {
  readUpstreamActivity,
  readUpstreamProbeFailures,
} from "~/modules/webhooks/upstream-activity"

export const monitorDiagRoutes = new Hono()

const DIAG_VERSION = 1
// Probe budget per dependency. 200ms proved far too tight for a health VERDICT: any
// GC pause / busy event-loop tick / storage blip read as a down dep for that one poll,
// flapping the watchdog's health-dep signal all day (prod 2026-08-07, 24 criticals +
// a resolved-email flood). 2s still bounds the /diag response well under the
// watchdog's poll interval while only reporting a dep down when it is actually down.
const DIAG_TIMEOUT_MS = 2000

/**
 * Constant-time bearer compare -- the endpoint is reachable by any local process/container
 * sharing the host netns, so a naive `===` would leak timing information about the token.
 * Length check first (timingSafeEqual requires equal-length buffers); a length mismatch is
 * itself "not equal" -> 401, never a throw.
 */
function timingSafeTokenMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided)
  const expectedBuf = Buffer.from(expected)
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

/**
 * DepStatus -> ok|slow|down, mirroring the hub service's B4. "slow" (the loop-lag
 * verdict from withTimeout, now confirmed against the probe's own answer within
 * a bounded grace window) is its own wire status, distinct from "down": it means
 * the event loop was too busy to run the probe's own timeout on schedule and the
 * probe itself answered fine, not that the dependency failed to answer. Anything
 * else (error, timeout after the grace window) is a real failure and reports down.
 */
function mapDbLikeStatus(status: DepStatus): string {
  if (status === "ok") return "ok"
  if (status === "slow") return "slow"
  return "down"
}

/**
 * DepStatus -> ok|slow|degraded for meili/s3. "slow" is carved out the same way as
 * mapDbLikeStatus above; every other non-ok verdict (error, timeout) still degrades
 * rather than pages hard-down for these two, but a genuine failure of either dep is
 * still visible as "degraded" -- ops/monitor's hardDown predicate treats "degraded"
 * as paging, only "ok" and "slow" are exempt.
 */
function mapDerivedStatus(status: DepStatus): string {
  if (status === "ok") return "ok"
  if (status === "slow") return "slow"
  return "degraded"
}

/** Times a dep probe alongside its verdict, for the diag payload's per-dep latencyMs. */
async function timedProbe(
  probe: () => Promise<DepStatus>,
  ms: number,
): Promise<{ status: DepStatus; latencyMs: number }> {
  const start = Date.now()
  const status = await withTimeout(probe, ms)
  return { status, latencyMs: Date.now() - start }
}

/**
 * Upstream-probe reports for the webhook-health signals. A Redis failure or a slow
 * read yields null, and ingest-health then judges neither probe signal this
 * round: an unreadable report is not evidence that a probe stopped.
 */
async function getUpstreamActivityDiag(): Promise<{
  activity: Map<string, UpstreamActivity>
  failures: Map<string, UpstreamProbeFailure>
} | null> {
  const apps = webhookUpstreamProbeApps()
  if (apps.length === 0) return { activity: new Map(), failures: new Map() }
  try {
    return await Promise.race([
      Promise.all([readUpstreamActivity(apps), readUpstreamProbeFailures(apps)]).then(
        ([activity, failures]) => ({ activity, failures }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DIAG_TIMEOUT_MS)),
    ])
  } catch (err) {
    log.warn({ err }, "diag: upstream activity read failed")
    return null
  }
}

async function getOutboxDiag(): Promise<{
  oldestPendingAgeSec: number | null
  deadLetterCount: number
}> {
  try {
    // Cross-org, read-only outbox counters: a system read, no org context.
    const table = `${schemaRef("kernel")}.pending_events`
    return await withSystemDb("monitor-diag-outbox", async (tx) => {
      const [lagRow] = extractRows<{ lag_sec: number | null }>(
        await tx.execute(
          drizzleSql.raw(
            `SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS lag_sec
             FROM ${table} WHERE processed_at IS NULL AND failed_at IS NULL`,
          ),
        ),
      )
      const [dlRow] = extractRows<{ cnt: number }>(
        await tx.execute(
          drizzleSql.raw(`SELECT COUNT(*)::int AS cnt FROM ${table} WHERE failed_at IS NOT NULL`),
        ),
      )
      return {
        oldestPendingAgeSec: lagRow?.lag_sec ?? null,
        deadLetterCount: dlRow?.cnt ?? 0,
      }
    })
  } catch {
    return { oldestPendingAgeSec: null, deadLetterCount: 0 }
  }
}

/**
 * BullMQ backlog and queue age per queue (infra/jobs/queue-health.ts), plus
 * the enqueue backpressure state, for an operator reading /diag. `staleQueues`
 * lists the queues whose oldest runnable job has waited longer than its class
 * allows (two minutes for kernel crons). Before the queue classes, kernel
 * crons sat 58 minutes behind search jobs with nothing here to say so. The
 * liaison-ops watchdog does its own per-class age check straight from Redis;
 * this section is the in-app view of the same numbers.
 */
/** Per-queue fairness counters (fairness.ts); `busyOrgs` is a count, never ids. */
type FairnessDiag = Record<
  string,
  Awaited<ReturnType<typeof readQueueFairness>> & { waitP95Ms: number | null }
>

/** The cron fan-out's counters (fanout-runtime.ts): totals, and per (app, job). */
interface FanoutDiag {
  schedulers: number
  totals: Record<string, number>
  byJob: Record<string, Record<string, number>>
}

/** Fan-out counter fields carried per (app, job) as `<field>:<app>:<job>`. */
const FANOUT_FIELD_RE =
  /^(fanout_ticks|fanout_enqueued|fanout_deduped|fanout_coalesced|fanout_skip_error|legacy_tick_converted|legacy_tick_dropped):(.+)$/

function fanoutDiagFrom(metrics: Record<string, number>, schedulers: number): FanoutDiag {
  const totals: Record<string, number> = {}
  const byJob: Record<string, Record<string, number>> = {}
  for (const [field, n] of Object.entries(metrics)) {
    const m = FANOUT_FIELD_RE.exec(field)
    if (m) {
      const name = m[1] ?? ""
      const appJob = m[2] ?? ""
      const row = byJob[appJob] ?? {}
      row[name] = n
      byJob[appJob] = row
    } else if (field.startsWith("fanout_") || field.startsWith("legacy_tick_")) {
      totals[field] = n
    }
  }
  return { schedulers, totals, byJob }
}

async function readFairnessAndFanout(
  queueNames: string[],
): Promise<{ enabled: boolean; degraded: boolean; fairness: FairnessDiag; fanout: FanoutDiag }> {
  const fairQueues = queueNames.filter(isFairQueue)
  const [perQueue, metrics, schedulers] = await Promise.all([
    Promise.all(
      fairQueues.map(async (q) => ({
        ...(await readQueueFairness(q)),
        waitP95Ms: await readWaitP95Ms(q),
      })),
    ),
    readJobMetrics(),
    getJobSchedulerTotal(),
  ])
  const fairness: FairnessDiag = {}
  fairQueues.forEach((q, i) => {
    const row = perQueue[i]
    if (row) fairness[q] = row
  })
  return {
    enabled: fairnessEnabled(),
    degraded: fairnessDegradedLocally() || Object.values(fairness).some((f) => f.degraded),
    fairness,
    fanout: fanoutDiagFrom(metrics, schedulers),
  }
}

async function getJobsDiag(): Promise<{
  queues: QueueHealth[]
  staleQueues: string[]
  backpressure: ReturnType<typeof getBackpressureState>
  fairness?: { enabled: boolean; degraded: boolean; queues: FairnessDiag }
  fanout?: FanoutDiag
  error?: true
}> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      (async () => {
        const queues = await getQueueHealth()
        const extra = await readFairnessAndFanout(queues.map((q) => q.queue))
        return { queues, extra }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("queue health timed out")), DIAG_TIMEOUT_MS)
      }),
    ])
    const { queues, extra } = result
    return {
      queues,
      staleQueues: queues.filter((q) => q.stale).map((q) => q.queue),
      backpressure: getBackpressureState(),
      fairness: { enabled: extra.enabled, degraded: extra.degraded, queues: extra.fairness },
      fanout: extra.fanout,
    }
  } catch {
    return { queues: [], staleQueues: [], backpressure: getBackpressureState(), error: true }
  } finally {
    clearTimeout(timer)
  }
}

async function getDbDiag(): Promise<{ activeConnections: number; maxConnections: number }> {
  try {
    // Server-wide connection counters: a system read, no org context.
    return await withSystemDb("monitor-diag-db", async (tx) => {
      const [connRow] = extractRows<{ cnt: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS cnt FROM pg_stat_activity WHERE datname = current_database()`,
        ),
      )
      const [maxRow] = extractRows<{ max_connections: string }>(
        await tx.execute(drizzleSql`SHOW max_connections`),
      )
      return {
        activeConnections: connRow?.cnt ?? 0,
        maxConnections: Number(maxRow?.max_connections ?? 0),
      }
    })
  } catch {
    return { activeConnections: 0, maxConnections: 0 }
  }
}

type MailIngestReason =
  | "connection_not_active"
  | "connection_missing"
  | "sync_stalled"
  | "account_error"
  | "initial_sync_wedged"
  | "watch_expired"

// A mailbox whose connection is still "active" but whose last successful sync is older than this
// is treated as silently stalled (dead push watch, wedged worker, revoked-but-not-yet-errored
// token). The tickets incremental cron runs every 5 min, so a healthy mailbox refreshes lastSyncAt
// well within an hour; > this age means many consecutive ticks failed. Override via env.
const MAIL_INGEST_STALE_SEC = Number(process.env.MAIL_INGEST_STALE_SEC ?? 3600)

interface MailIngestUnhealthy {
  emailAddress: string | null
  connectionStatus: string
  reason: MailIngestReason
  statusMessage: string | null
  lastSyncAgeSec: number | null
}

interface MailIngestDiag {
  mailboxInboxes: number
  unhealthyInboxes: number
  oldestSyncAgeSec: number | null
  unhealthy: MailIngestUnhealthy[]
}

/**
 * Mailbox-ingest health. Catches the silent failure where a tickets mailbox inbox still shows
 * "active" in Settings but inbound support email has stopped becoming tickets, while every other
 * /diag signal stays green (no error signature, no heartbeat miss, no dep outage).
 *
 * Anchored on the tickets `inboxes` row + its backing `kernel.connected_accounts` connection.
 * A kind='mailbox' tickets inbox ingests email DIRECTLY off its kernel OAuth connection via the
 * tickets sync jobs -- it has NO `app_mail.accounts` row (that table backs the separate Mail app,
 * a different subsystem). An earlier version joined app_mail.accounts and reported `no_mail_account`
 * for every correctly-connected tickets mailbox, paging hourly forever (2026-07-09). Health now
 * derives ONLY from the connection: a mailbox inbox is unhealthy when its backing connected_account
 * is either
 *   - MISSING (connected_account_id null, or pointing at a deleted/orphaned row)  -> connection_missing, OR
 *   - present but not 'active' (status 'error' / 'disconnected', e.g. token revoked) -> connection_not_active, OR
 *   - active but SILENTLY STALLED -- the tickets incremental sync stamps `metadata.gmail.lastSyncAt`
 *     (ISO) on every successful run (every ~5 min); if the newest one is older than
 *     MAIL_INGEST_STALE_SEC the mailbox is ingesting nothing while still showing "active" (dead push
 *     watch, wedged worker) -> sync_stalled. A mailbox that has never recorded a lastSyncAt (e.g. just
 *     connected, or a pre-upgrade account before its first post-fix sync) is NOT flagged, so a rollout
 *     or an in-flight initial sync never false-pages.
 * Read under liaison_admin (BYPASSRLS): the request-role connection sets no org GUC, so
 * app_tickets.inboxes RLS filters to zero rows AND kernel.connected_accounts RLS throws (its
 * ::uuid cast on an empty org GUC). Wrapped so a schema drift never 500s the whole payload.
 */
async function getMailIngestDiag(): Promise<MailIngestDiag> {
  const empty: MailIngestDiag = {
    mailboxInboxes: 0,
    unhealthyInboxes: 0,
    oldestSyncAgeSec: null,
    unhealthy: [],
  }
  try {
    const inboxes = `${schemaRef("app_tickets")}.inboxes`
    const connectedAccounts = `${schemaRef("kernel")}.connected_accounts`
    const rows = await withSystemDb("mail-ingest-diag", (db) =>
      db
        .execute(
          drizzleSql.raw(
            `SELECT
               i.email_address AS email_address,
               i.connected_account_id AS connected_account_id,
               ca.status AS connection_status,
               ca.status_message AS status_message,
               ca.connection_name AS connection_name,
               ca.metadata AS metadata
             FROM ${inboxes} i
             LEFT JOIN ${connectedAccounts} ca ON ca.id = i.connected_account_id
             WHERE i.kind = 'mailbox' AND i.archived_at IS NULL`,
          ),
        )
        .then((r) => extractRows<Record<string, unknown>>(r)),
    )
    const unhealthy: MailIngestUnhealthy[] = []
    let oldestSyncAgeSec: number | null = null
    const nowMs = Date.now()
    for (const r of rows) {
      // ca.status is NULL when connected_account_id is null OR points at a row that
      // no longer exists (orphaned). Both mean "no live connection" for this inbox.
      const hasConnectionRow = (r.connection_status as string | null) != null
      const connectionStatus = (r.connection_status as string | null) ?? "missing"
      const statusMessage = (r.status_message as string | null) ?? null

      // Sync freshness (only meaningful for an active connection). Read the newest
      // lastSyncAt the tickets sync stamped into metadata.gmail; imap stamps its own
      // cursor timestamp under metadata.imap when present.
      const meta = (r.metadata as Record<string, any> | null) ?? {}
      const lastSyncAtRaw =
        (meta.gmail?.lastSyncAt as string | undefined) ??
        (meta.imap?.lastSyncAt as string | undefined) ??
        null
      const lastSyncMs = lastSyncAtRaw ? Date.parse(lastSyncAtRaw) : Number.NaN
      const lastSyncAgeSec = Number.isFinite(lastSyncMs)
        ? Math.max(0, Math.floor((nowMs - lastSyncMs) / 1000))
        : null
      if (
        lastSyncAgeSec != null &&
        (oldestSyncAgeSec == null || lastSyncAgeSec > oldestSyncAgeSec)
      ) {
        oldestSyncAgeSec = lastSyncAgeSec
      }

      let reason: MailIngestReason | null = null
      if (!hasConnectionRow) reason = "connection_missing"
      else if (connectionStatus !== "active") reason = "connection_not_active"
      // A connected-but-stalled mailbox: it still shows "active" but has recorded no successful
      // sync in over MAIL_INGEST_STALE_SEC. Never-synced (lastSyncAgeSec null) is left un-flagged.
      else if (lastSyncAgeSec != null && lastSyncAgeSec > MAIL_INGEST_STALE_SEC) {
        reason = "sync_stalled"
      }
      if (reason) {
        unhealthy.push({
          emailAddress: (r.email_address as string | null) ?? null,
          connectionStatus,
          reason,
          statusMessage,
          lastSyncAgeSec,
        })
      }
    }
    // Mail-app accounts (app_mail.accounts) are a SEPARATE ingest subsystem from tickets
    // mailbox inboxes: personal/shared mailboxes synced by the mail app's own jobs. They have
    // their own failure modes the tickets join above cannot see (prod 2026-07-11: an account
    // wedged in sync_status='syncing' for 10+ hours after its initial-sync job died on an
    // oversized message -- zero alerts, because only tickets inboxes were watched):
    //   - sync_status='error'  -> the sync loop marked the account broken (e.g. token revoked);
    //     the user must reconnect                                        -> account_error
    //   - sync_status IN ('pre-sync','syncing') and the backfill chain has not saved progress
    //     (sync_state.pageSavedAt, falling back to updated_at for pre-marker rows) in over
    //     MAIL_INGEST_STALE_SEC: a healthy initial sync saves cursor progress onto the row every
    //     page (seconds apart), so a stale marker means the chain is dead and the account will
    //     never reach 'active'. updated_at alone would be masked by the concurrent incremental
    //     writer, which also touches the row                             -> initial_sync_wedged
    //   - sync_status='active' with a push watch whose expiry has passed by more than the stale
    //     window: the renewal cron is failing, push is dead, and only the online-user-gated poll
    //     is left                                                        -> watch_expired
    // An 'active' account with merely old last_sync_at is deliberately NOT flagged: the scheduled
    // poll skips accounts with no online users, so quiet nights would false-page.
    let mailAccounts = 0
    try {
      const accounts = `${schemaRef("app_mail")}.accounts`
      const accountRows = await withSystemDb("mail-ingest-diag-accounts", (db) =>
        db
          .execute(
            drizzleSql.raw(
              `SELECT email_address, sync_status, last_sync_error,
                      EXTRACT(EPOCH FROM (now() - COALESCE(
                        (sync_state->>'pageSavedAt')::timestamptz, updated_at
                      )))::int AS updated_age_sec,
                      EXTRACT(EPOCH FROM (now() - last_sync_at))::int AS last_sync_age_sec,
                      sync_state->>'watchExpiry' AS watch_expiry
               FROM ${accounts} a
               WHERE disconnected_at IS NULL
                 -- A personal mailbox waiting for its owner to enroll in mailbox
                 -- encryption (never enrolled, grace elapsed, or just reset) fetches
                 -- nothing by design and sits in 'pre-sync' until the owner acts. That
                 -- is not a dead sync chain, and paging on it cries wolf. Read through
                 -- to_jsonb so a schema without the column still runs the whole check.
                 AND NOT (owner_type = 'user'
                          AND to_jsonb(a) ->> 'encryption_state' IN ('pending_enrollment', 'paused'))`,
            ),
          )
          .then((r) => extractRows<Record<string, unknown>>(r)),
      )
      mailAccounts = accountRows.length
      const nowEpochMs = Date.now()
      for (const r of accountRows) {
        const syncStatus = (r.sync_status as string | null) ?? "unknown"
        const updatedAgeSec = (r.updated_age_sec as number | null) ?? null
        const lastSyncAgeSec = (r.last_sync_age_sec as number | null) ?? null
        const watchExpiryMs = r.watch_expiry ? Number(r.watch_expiry) : Number.NaN

        let reason: MailIngestReason | null = null
        if (syncStatus === "error") reason = "account_error"
        else if (
          (syncStatus === "pre-sync" || syncStatus === "syncing") &&
          updatedAgeSec != null &&
          updatedAgeSec > MAIL_INGEST_STALE_SEC
        ) {
          reason = "initial_sync_wedged"
        } else if (
          syncStatus === "active" &&
          Number.isFinite(watchExpiryMs) &&
          nowEpochMs - watchExpiryMs > MAIL_INGEST_STALE_SEC * 1000
        ) {
          reason = "watch_expired"
        }
        if (reason) {
          unhealthy.push({
            emailAddress: (r.email_address as string | null) ?? null,
            connectionStatus: syncStatus,
            reason,
            statusMessage: (r.last_sync_error as string | null) ?? null,
            lastSyncAgeSec: lastSyncAgeSec ?? updatedAgeSec,
          })
        }
      }
    } catch {
      // app_mail not installed / schema drift: tickets coverage above still reports.
    }

    return {
      mailboxInboxes: rows.length + mailAccounts,
      unhealthyInboxes: unhealthy.length,
      oldestSyncAgeSec,
      unhealthy,
    }
  } catch {
    return empty
  }
}

/**
 * GET /diag -- top-level (mounted like /healthz, BEFORE maintenanceMiddleware -- see
 * app.ts), bearer-token guarded. Each sub-collector wrapped so a single dependency outage
 * never 500s the whole payload while auth passes.
 */
monitorDiagRoutes.get("/", async (c) => {
  const authHeader = c.req.header("Authorization") ?? ""
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : ""

  if (!env.MONITOR_TOKEN || !timingSafeTokenMatch(provided, env.MONITOR_TOKEN)) {
    return c.json({ error: "unauthorized" }, 401)
  }

  const [db, redisProbe, meili, storage, outbox, dbDiag, mailIngest, jobs, upstreamActivity] =
    await Promise.all([
      timedProbe(probeDb, DIAG_TIMEOUT_MS),
      timedProbe(probeRedis, DIAG_TIMEOUT_MS),
      timedProbe(probeMeili, DIAG_TIMEOUT_MS),
      timedProbe(probeStorage, DIAG_TIMEOUT_MS),
      getOutboxDiag(),
      getDbDiag(),
      getMailIngestDiag(),
      getJobsDiag(),
      getUpstreamActivityDiag(),
    ])
  const dbStatus = db.status
  const redisStatus = redisProbe.status
  const meiliStatus = meili.status
  const storageStatus = storage.status

  const deps = {
    postgres: mapDbLikeStatus(dbStatus),
    redis: mapDbLikeStatus(redisStatus),
    meili: mapDerivedStatus(meiliStatus),
    s3: mapDerivedStatus(storageStatus),
  }
  const depLatencyMs = {
    postgres: db.latencyMs,
    redis: redisProbe.latencyMs,
    meili: meili.latencyMs,
    s3: storage.latencyMs,
  }
  // 59 criticals in the wild produced a diag body of "see diag payload" with no
  // way to tell WHICH dep went non-ok. Warn (never error): a dep that is merely
  // slow or degraded is an expected, transient condition, and the watchdog treats
  // pino level >= 50 as severe -- an error here would page on its own.
  if (Object.values(deps).some((v) => v !== "ok")) {
    log.warn({ deps, depLatencyMs }, "diag dependency probe reported a non-ok status")
  }

  return c.json({
    diagVersion: DIAG_VERSION,
    appVersion: env.LIAISON_VERSION,
    uptimeSec: Math.floor(process.uptime()),
    errorSignatures: getDiagErrorState().errorSignatures,
    // Security alert signals since boot (guess ceilings, lockouts, MCP client
    // registrations), per kind: modules/security/security-events.ts.
    securityEvents: getSecurityEventDiag(),
    outbox,
    worker: getWorkerHeartbeat(),
    // Job queues: backlog, oldest-runnable age and `stale` per queue, plus the
    // enqueue backpressure state (Redis memory ratio, refusals since boot).
    jobs,
    // U4.16 — main RLS/request pool pressure (see db/pool-diag.ts + db/rls.ts).
    // A rising inFlight with a healthy postgres dep AND non-zero
    // acquireTimeouts/statementTimeouts is the leading indicator of the
    // sandbox-wedge failure mode found live on staging 2026-07-06 (every
    // app-tickets tool/job timing out at executeInSandbox once the pool was
    // silently exhausted) — the watchdog should alert on this BEFORE the pool
    // fully wedges, not after.
    rlsPool: getPoolDiagState(),
    // Every pool's planned max, slots held now and at most, waiting transactions
    // and acquire timeouts (db/pool-diag.ts), and the plan they come from
    // (db/pool-plan.ts: sizes, sources, the topology's sums and verdict).
    // docs/self-hosting/pools.md reads them.
    pools: getPoolGauges(),
    nestedPrivilegedAcquisitions: nestedPrivilegedAcquisitions(),
    poolPlan,
    // Whole-run jobs-pool holders admitted at once, waiting, longest wait
    // (infra/jobs/pinned-jobs-gate.ts).
    pinnedJobs: pinnedJobsGate.state(),
    // Org registry reads that reached an org before its first-touch setup (H3).
    orgSetup: orgRegistryGuardStats(),
    // Mailbox-ingest health -- a mailbox inbox that still reads "active" while its OAuth
    // connection has silently died (inbound support email stops becoming tickets). See
    // getMailIngestDiag; the watchdog fires `mail-ingest` critical on unhealthyInboxes > 0.
    mailIngest,
    // Inbound mail dropped automatically before reaching a ticket (auto-responder
    // and list headers, forum notifications, our own Sent copies),
    // per reason since the process started. These drops are silent by design, so
    // a real customer behind a mailing-list tool shows up here and nowhere else.
    inboundMailDrops: (await import("~/apps/tickets/inbound")).inboundDropCountsByReason(),
    // Inbound-webhook ingest health, judged per app by its declared webhook-health
    // contract: `rejectingApps` (a live sender we refuse), `missedDeliveryApps` (the
    // app's probe saw an upstream change that never reached us) and `staleProbeApps`
    // (the probe itself stopped reporting). See modules/webhooks/ingest-health.ts.
    webhookIngest: webhookIngestDiag(
      Date.now(),
      upstreamActivity?.activity ?? null,
      upstreamActivity?.failures,
    ),
    deps,
    // Per-dep probe latency, alongside the log.warn above -- the diagnostic that was
    // missing when 59 health-dep criticals fired with nothing to say which dep tripped.
    depLatencyMs,
    db: dbDiag,
  })
})
