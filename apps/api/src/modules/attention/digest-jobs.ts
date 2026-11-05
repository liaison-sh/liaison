// SPDX-License-Identifier: FSL-1.1-ALv2
import { groupForKind, type NotificationGrid, resolveLocale } from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const K = sql.raw(schemaRef("kernel"))

import {
  type EmailMessage,
  type EmailProvider,
  EmailRateLimitError,
  getSystemEmailProvider,
  sendEmailOnce,
  systemEmailLeavesThisInstance,
} from "~/infra/email"
import { registerScheduledJob } from "~/infra/jobs/jobs"
import { EffectInFlight } from "~/lib/effect-once"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  attentionTextRedacted,
  dispatchAttentionLive,
  emailEnqueue,
} from "~/modules/notifications/dispatch"
import { type RouterDecision, resolveChannels } from "~/modules/notifications/router"
import { readNotificationChannels } from "~/modules/notifications/settings"
import {
  buildIdempotencyKey,
  type DigestCadence,
  groupByUser,
  type PendingAttentionRow,
  renderDigestEmail,
  shouldFireDailyDigest,
  windowLabel,
} from "./digest"

const log = rootLogger.child({ module: "attention-digest" })

export const URGENT_JOB = "attention-digest-urgent"
export const IMMEDIATE_JOB = "attention-digest-cadence"
export const HOURLY_JOB = "attention-digest-hourly"
export const DAILY_JOB = "attention-digest-daily"

export interface DigestUser {
  userId: string
  orgId: string
  email: string
  digestCadence: "off" | "immediate" | "hourly" | "daily"
  timezone: string
  /** Persisted UI language for localized digest copy (I6); null/absent → en. */
  language?: string | null
  lastDailySentAt: Date | null
  /**
   * The user's effective grid, read at send time: a row whose group's email
   * cell is off now is suppressed rather than sent (a row enqueued before the
   * change, or left pending by a degraded router decision). Absent = defaults.
   */
  grid?: NotificationGrid
}

export interface DigestDeps {
  fetchUrgentPending: () => Promise<PendingAttentionRow[]>
  fetchCadencePending: (cadence: "immediate" | "hourly" | "daily") => Promise<PendingAttentionRow[]>
  loadUser: (userId: string) => Promise<DigestUser | null>
  markRowsSent: (rowIds: string[]) => Promise<void>
  /**
   * Permanently suppress rows that can never be delivered (e.g. user has no
   * email address). Without this, rows stay in `pending` state indefinitely.
   */
  markRowsSuppressed: (rowIds: string[]) => Promise<void>
  setLastDailySent: (userId: string, when: Date) => Promise<void>
  emitDigestFailureAlert: (args: {
    orgId: string
    userId: string
    cadence: DigestCadence
  }) => Promise<void>
  provider: EmailProvider
  baseUrl: string
  now: Date
}

// Rule 5, read once, read everywhere: the digest carries only what is still
// unread when it is sent. A row read on any device since it was queued is
// retired from the digest (`suppressed`) instead of mailed, and both selects
// below skip it.
const RETIRE_READ_ROWS = sql`
  UPDATE ${K}.attention_events
  SET digest_state = 'suppressed'
  WHERE digest_state = 'pending'
    AND read_at IS NOT NULL`

// Cadence 'off' is "every email cell off" (S9): such a user receives no
// digest at all, urgent included, whatever state a row was left in.
const PENDING_QUERY = sql`
  SELECT a.id, a.org_id, a.user_id, a.app, a.entity_type, a.entity_id, a.kind, a.urgency,
         a.summary, a.is_urgent, a.occurred_at, a.metadata->>'threadId' AS thread_id,
         a.metadata->'requiredScopes' AS required_scopes
  FROM ${K}.attention_events a
  LEFT JOIN ${K}.user_preferences p ON p.user_id = a.user_id
  WHERE a.digest_state = 'pending'
    AND a.read_at IS NULL
    AND a.is_urgent = true
    -- A muted (quiet) row is never mailed (rule 7).
    AND NOT COALESCE((a.metadata->>'quiet')::boolean, false)
    AND a.digest_eligible_at <= now()
    AND COALESCE(p.digest_cadence, 'daily') <> 'off'
  ORDER BY a.user_id, a.occurred_at`

function rowToPending(row: Record<string, unknown>): PendingAttentionRow {
  return {
    id: row.id as string,
    orgId: row.org_id as string,
    userId: row.user_id as string,
    app: row.app as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    kind: row.kind as string,
    urgency: Number(row.urgency),
    summary: row.summary as string,
    isUrgent: !!row.is_urgent,
    occurredAt: new Date(row.occurred_at as string),
    ...(typeof row.thread_id === "string" ? { threadId: row.thread_id } : {}),
    ...(attentionTextRedacted(row.required_scopes) ? { redacted: true } : {}),
  }
}

async function defaultFetchUrgent(): Promise<PendingAttentionRow[]> {
  return withPrivilegedDb(
    "00000000-0000-0000-0000-000000000000",
    "digest:fetch-urgent",
    async (tx: PrivilegedDb) => {
      await tx.execute(RETIRE_READ_ROWS)
      const rows = (await tx.execute(PENDING_QUERY)) as unknown as Record<string, unknown>[]
      return rows.map(rowToPending)
    },
  )
}

async function defaultFetchCadencePending(
  cadence: "immediate" | "hourly" | "daily",
): Promise<PendingAttentionRow[]> {
  return withPrivilegedDb(
    "00000000-0000-0000-0000-000000000000",
    `digest:fetch-${cadence}`,
    async (tx: PrivilegedDb) => {
      // Users without a `user_preferences` row inherit the default cadence
      // ('daily', the column default): a LEFT JOIN + COALESCE keeps the two in sync.
      await tx.execute(RETIRE_READ_ROWS)
      const rows = (await tx.execute(sql`
        SELECT a.id, a.org_id, a.user_id, a.app, a.entity_type, a.entity_id, a.kind,
               a.urgency, a.summary, a.is_urgent, a.occurred_at,
               a.metadata->>'threadId' AS thread_id,
               a.metadata->'requiredScopes' AS required_scopes
        FROM ${K}.attention_events a
        LEFT JOIN ${K}.user_preferences p ON p.user_id = a.user_id
        WHERE a.digest_state = 'pending'
          AND a.read_at IS NULL
          AND a.is_urgent = false
          AND NOT COALESCE((a.metadata->>'quiet')::boolean, false)
          AND a.digest_eligible_at <= now()
          AND COALESCE(p.digest_cadence, 'daily') = ${cadence}
        ORDER BY a.user_id, a.occurred_at`)) as unknown as Record<string, unknown>[]
      return rows.map(rowToPending)
    },
  )
}

// Exported for I6 verification: a test asserts this real SQL reads the
// recipient's persisted `kernel.user_preferences.language` (not a hard-coded
// locale), which is the actual server-side-translation link.
export async function defaultLoadUser(userId: string): Promise<DigestUser | null> {
  return withPrivilegedDb(
    "00000000-0000-0000-0000-000000000000",
    "digest:load-user",
    async (tx: PrivilegedDb) => {
      const rows = (await tx.execute(sql`
        SELECT u.id as user_id, u.org_id, u.email,
               COALESCE(p.digest_cadence, 'daily') as digest_cadence,
               COALESCE(p.timezone, 'UTC') as timezone,
               p.language,
               o.default_locale AS org_default_locale,
               p.last_daily_sent_at,
               p.notification_channels
        FROM ${K}.users u
        JOIN ${K}.organizations o ON o.id = u.org_id
        LEFT JOIN ${K}.user_preferences p ON p.user_id = u.id
        WHERE u.id = ${userId} LIMIT 1`)) as unknown as Array<{
        user_id: string
        org_id: string
        email: string
        digest_cadence: string
        timezone: string
        language: string | null
        org_default_locale: string | null
        last_daily_sent_at: string | Date | null
        notification_channels: unknown
      }>
      const row = rows[0]
      if (!row) return null
      return {
        userId: row.user_id,
        orgId: row.org_id,
        email: row.email,
        digestCadence: row.digest_cadence as DigestUser["digestCadence"],
        timezone: row.timezone ?? "UTC",
        // Explicit choice, else the org default locale (a user who never
        // picked a language reads their org's language, not English).
        language: resolveLocale(row.language, row.org_default_locale),
        // Raw tx.execute returns timestamps as strings (same as occurred_at
        // above). Passing the string through to formatToParts coerces to NaN
        // and throws "date value is not finite" on every daily tick once a
        // digest has been sent — coerce at the boundary.
        lastDailySentAt: row.last_daily_sent_at ? new Date(row.last_daily_sent_at) : null,
        grid: readNotificationChannels(row.notification_channels ?? null).grid,
      }
    },
  )
}

async function defaultMarkRowsSent(rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return
  await withPrivilegedDb(
    "00000000-0000-0000-0000-000000000000",
    "digest:mark-sent",
    async (tx: PrivilegedDb) => {
      // `= ANY(${rowIds}::uuid[])` sends the JS array as a single bound
      // parameter, which postgres.js does not coerce into a Postgres array
      // literal — it fails with "malformed array literal" (confirmed live:
      // the attention-digest-urgent job exhausted retries on every tick once
      // an urgency>=70 item existed to mark sent). `sql.join(... IN (...))`
      // is the established pattern elsewhere in this codebase (see
      // files/service.ts, files/attach.ts, search/service.ts) — each id is
      // its own bound parameter, so it round-trips correctly regardless of
      // array length.
      const idList = sql.join(
        rowIds.map((id) => sql`${id}`),
        sql`, `,
      )
      await tx.execute(
        sql`UPDATE ${K}.attention_events
            SET digest_state = 'sent'
            WHERE id IN (${idList})`,
      )
    },
  )
}

async function defaultMarkRowsSuppressed(rowIds: string[]): Promise<void> {
  if (rowIds.length === 0) return
  await withPrivilegedDb(
    "00000000-0000-0000-0000-000000000000",
    "digest:mark-suppressed",
    async (tx: PrivilegedDb) => {
      const idList = sql.join(
        rowIds.map((id) => sql`${id}`),
        sql`, `,
      )
      await tx.execute(
        sql`UPDATE ${K}.attention_events
            SET digest_state = 'suppressed'
            WHERE id IN (${idList})`,
      )
    },
  )
}

async function defaultSetLastDailySent(userId: string, when: Date): Promise<void> {
  await withPrivilegedDb(
    "00000000-0000-0000-0000-000000000000",
    "digest:set-last-daily-sent",
    async (tx: PrivilegedDb) => {
      await tx.execute(
        sql`UPDATE ${K}.user_preferences
            SET last_daily_sent_at = ${when.toISOString()}, updated_at = now()
            WHERE user_id = ${userId}`,
      )
    },
  )
}

async function defaultEmitDigestFailureAlert(args: {
  orgId: string
  userId: string
  cadence: DigestCadence
}): Promise<void> {
  // Spec: "a `system_alert` attention row is emitted for org admins". The row
  // must be visible in Home (email_only = false) so admins see the failure.
  const adminRows = await withPrivilegedDb(
    args.orgId,
    "digest:failure-alert-admins",
    async (tx: PrivilegedDb) =>
      (await tx.execute(sql`
      SELECT DISTINCT u.id::text AS id
      FROM ${K}.users u
      JOIN ${K}.user_roles ur ON ur.user_id = u.id
      JOIN ${K}.role_scope_grants rs ON rs.role_id = ur.role_id
      WHERE u.org_id = ${args.orgId}
        AND u.status = 'active'
        AND rs.scope IN ('*', 'kernel', 'kernel:users', 'kernel:users:admin', 'kernel:org', 'kernel:org:admin')
      UNION
      SELECT DISTINCT u.id::text AS id
      FROM ${K}.users u
      JOIN ${K}.user_scope_grants usg ON usg.user_id = u.id AND usg.org_id = u.org_id
      WHERE u.org_id = ${args.orgId}
        AND u.status = 'active'
        AND usg.scope IN ('*', 'kernel', 'kernel:users', 'kernel:users:admin', 'kernel:org', 'kernel:org:admin')
    `)) as unknown as Array<{ id: string }>,
  )

  // Fallback: if there is no admin in the org (shouldn't happen in prod), at
  // minimum alert the affected user so the failure is not silent.
  const recipients = adminRows.length > 0 ? adminRows.map((r) => r.id) : [args.userId]
  const summary = `Digest failing for user ${args.userId} (${args.cadence}) — please check email provider configuration`
  const now = new Date()
  for (const recipientId of recipients) {
    // Routed like every other producer (S2): the email state and the live
    // channels come from the recipient's decision.
    const decision = await resolveChannels(
      { userId: recipientId, orgId: args.orgId },
      {
        kind: "system_alert",
        app: "kernel",
        entityType: "digest",
        entityId: args.cadence,
        isUrgent: true,
      },
      { now },
    )
    await insertDigestFailureRow(decision, { ...args, summary, now })
  }
}

/** One failure row for one routed recipient; live channels only when the row is new. */
async function insertDigestFailureRow(
  decision: RouterDecision,
  args: { orgId: string; userId: string; cadence: DigestCadence; summary: string; now: Date },
): Promise<void> {
  if (!decision.channels.in_app.deliver) return
  const email = emailEnqueue(decision, args.now)
  const sourceKey = `attention-digest-failure:${args.orgId}:${args.userId}:${args.cadence}`
  const out = await withPrivilegedDb(
    args.orgId,
    "digest:failure-alert",
    async (tx: PrivilegedDb) =>
      (await tx.execute(sql`
        INSERT INTO ${K}.attention_events
          (org_id, user_id, app, entity_type, entity_id, kind, urgency, summary,
           actor_type, occurred_at, is_urgent, digest_state, digest_eligible_at,
           email_only, source_key)
        VALUES (${args.orgId}, ${decision.userId}, 'kernel', 'digest', ${args.cadence}, 'system_alert',
                90, ${args.summary},
                'system', now(), true, ${email.digestState},
                ${email.digestEligibleAt.toISOString()}, false, ${sourceKey})
        ON CONFLICT (user_id, app, entity_type, entity_id, kind)
          WHERE read_at IS NULL AND email_only = false
          DO UPDATE SET occurred_at = EXCLUDED.occurred_at, summary = EXCLUDED.summary
        RETURNING id, (xmax = 0) AS inserted`)) as unknown as Array<{
        id: string
        inserted: boolean
      }>,
  )
  const row = out[0]
  if (!row?.inserted) return
  await dispatchAttentionLive(decision, {
    notifyId: `attention:${row.id}`,
    summary: args.summary,
    app: "kernel",
    entityType: "digest",
    entityId: args.cadence,
  })
}

/**
 * Split a user's rows by the grid read at send time: rows whose group's email
 * cell is off are suppressed, never sent.
 */
function partitionByGrid(
  rows: PendingAttentionRow[],
  user: DigestUser,
): { send: PendingAttentionRow[]; drop: PendingAttentionRow[] } {
  if (!user.grid) return { send: rows, drop: [] }
  const send: PendingAttentionRow[] = []
  const drop: PendingAttentionRow[] = []
  for (const row of rows) {
    if (user.grid[groupForKind(row.kind)]?.email === false) drop.push(row)
    else send.push(row)
  }
  return { send, drop }
}

function fullDeps(partial: Partial<DigestDeps> = {}): DigestDeps {
  return {
    fetchUrgentPending: partial.fetchUrgentPending ?? defaultFetchUrgent,
    fetchCadencePending: partial.fetchCadencePending ?? defaultFetchCadencePending,
    loadUser: partial.loadUser ?? defaultLoadUser,
    markRowsSent: partial.markRowsSent ?? defaultMarkRowsSent,
    markRowsSuppressed: partial.markRowsSuppressed ?? defaultMarkRowsSuppressed,
    setLastDailySent: partial.setLastDailySent ?? defaultSetLastDailySent,
    emitDigestFailureAlert: partial.emitDigestFailureAlert ?? defaultEmitDigestFailureAlert,
    provider: partial.provider ?? getSystemEmailProvider(),
    baseUrl: partial.baseUrl ?? env.BASE_URL ?? "http://localhost:5173",
    now: partial.now ?? new Date(),
  }
}

let sendDigestMailOnce: typeof sendEmailOnce = sendEmailOnce

interface SendOutcome {
  sent: boolean
  retryable: boolean
  retryAfterMs?: number
}

async function sendBatch(
  cadence: DigestCadence,
  rows: PendingAttentionRow[],
  user: DigestUser,
  deps: DigestDeps,
  attempt: "live" | "final",
): Promise<SendOutcome> {
  const message: EmailMessage = renderDigestEmail({
    rows,
    baseUrl: deps.baseUrl,
    now: deps.now,
    toAddress: user.email,
    locale: user.language,
  })
  message.idempotencyKey = buildIdempotencyKey(
    cadence,
    user.userId,
    windowLabel(cadence, deps.now),
    rows.map((r) => r.id),
  )
  try {
    // Through the effect ledger (S11): a digest job re-run after a crash or a
    // hand-back finds the key done and does not mail the same rows again. An
    // `unknown` outcome (an earlier run died mid-send) is not re-sent either:
    // at most once, and the rows are marked sent.
    await sendDigestMailOnce(user.orgId, deps.provider, message)
    return { sent: true, retryable: false }
  } catch (err) {
    if (err instanceof EffectInFlight) {
      // Another runner holds this very digest: leave the rows pending.
      log.info({ userId: user.userId, cadence }, "digest already being sent elsewhere")
      return { sent: false, retryable: true }
    }
    if (err instanceof EmailRateLimitError) {
      log.warn(
        { userId: user.userId, retryAfterMs: err.retryAfterMs },
        "digest rate-limited — leaving rows pending",
      )
      return { sent: false, retryable: true, retryAfterMs: err.retryAfterMs }
    }
    log.error({ err, userId: user.userId, cadence, attempt }, "digest send failed")
    if (attempt === "final") {
      try {
        await deps.emitDigestFailureAlert({
          orgId: user.orgId,
          userId: user.userId,
          cadence,
        })
      } catch (alertErr) {
        log.error({ err: alertErr, userId: user.userId }, "Failed to emit digest failure alert")
      }
    }
    if (attempt === "live") {
      // BullMQ retries on throw
      throw err
    }
    return { sent: false, retryable: false }
  }
}

export interface DigestRunOpts {
  attempt?: "live" | "final"
}

// Worker-side pause: when Resend signals 429 with retry-after, every digest job
// short-circuits subsequent ticks until the resume time passes. Honors spec:
// "digest workers can pause for the indicated retry-after window."
let _rateLimitedUntilMs = 0

export function isDigestRateLimited(nowMs: number = Date.now()): boolean {
  return nowMs < _rateLimitedUntilMs
}

function setRateLimited(retryAfterMs?: number): void {
  const delay = Math.max(1000, retryAfterMs ?? 60_000)
  _rateLimitedUntilMs = Math.max(_rateLimitedUntilMs, Date.now() + delay)
}

/**
 * No digest leaves an instance whose system mail cannot (a demo box refuses
 * every send): the jobs skip there, quietly, instead of throwing on each tick
 * into BullMQ retries and an error log per attempt. The rows stay pending.
 */
function digestMailCannotLeave(): boolean {
  return !systemEmailLeavesThisInstance()
}

export async function runDigestUrgentOnce(
  partial: Partial<DigestDeps> = {},
  opts: DigestRunOpts = {},
): Promise<void> {
  if (digestMailCannotLeave() || isDigestRateLimited()) return
  const deps = fullDeps(partial)
  const attempt = opts.attempt ?? "live"
  const rows = await deps.fetchUrgentPending()
  const groups = groupByUser(rows)
  for (const [userId, userRows] of groups) {
    const user = await deps.loadUser(userId)
    if (!user?.email) {
      // User has no deliverable email address — suppress rows so they don't
      // accumulate indefinitely in the pending queue.
      log.debug({ userId }, "digest: user has no email address, suppressing attention rows")
      await deps.markRowsSuppressed(userRows.map((r) => r.id))
      continue
    }
    const { send, drop } = partitionByGrid(userRows, user)
    if (drop.length > 0) await deps.markRowsSuppressed(drop.map((r) => r.id))
    if (send.length === 0) continue
    const outcome = await sendBatch("urgent", send, user, deps, attempt)
    if (outcome.sent) {
      await deps.markRowsSent(send.map((r) => r.id))
    } else if (outcome.retryable) {
      setRateLimited(outcome.retryAfterMs)
      return
    }
  }
}

async function runCadenceOnce(
  cadence: "immediate" | "hourly" | "daily",
  partial: Partial<DigestDeps> = {},
  opts: DigestRunOpts = {},
): Promise<void> {
  if (digestMailCannotLeave() || isDigestRateLimited()) return
  const deps = fullDeps(partial)
  const attempt = opts.attempt ?? "live"
  const rows = await deps.fetchCadencePending(cadence)
  const groups = groupByUser(rows)
  for (const [userId, userRows] of groups) {
    const user = await deps.loadUser(userId)
    if (!user?.email) {
      // User has no deliverable email address — suppress rows so they don't
      // accumulate indefinitely in the pending queue.
      log.debug({ userId }, "digest: user has no email address, suppressing attention rows")
      await deps.markRowsSuppressed(userRows.map((r) => r.id))
      continue
    }
    if (cadence === "daily") {
      if (!shouldFireDailyDigest(deps.now, user.timezone, user.lastDailySentAt)) continue
    }
    const { send, drop } = partitionByGrid(userRows, user)
    if (drop.length > 0) await deps.markRowsSuppressed(drop.map((r) => r.id))
    if (send.length === 0) continue
    const outcome = await sendBatch(cadence, send, user, deps, attempt)
    if (outcome.sent) {
      await deps.markRowsSent(send.map((r) => r.id))
      if (cadence === "daily") {
        await deps.setLastDailySent(userId, deps.now)
      }
    } else if (outcome.retryable) {
      setRateLimited(outcome.retryAfterMs)
      return
    }
  }
}

export const runDigestCadenceOnce = (partial: Partial<DigestDeps> = {}, opts: DigestRunOpts = {}) =>
  runCadenceOnce("immediate", partial, opts)

export const runDigestHourlyOnce = (partial: Partial<DigestDeps> = {}, opts: DigestRunOpts = {}) =>
  runCadenceOnce("hourly", partial, opts)

export async function runDigestDailyAt(
  now: Date,
  partial: Partial<DigestDeps> = {},
  opts: DigestRunOpts = {},
): Promise<void> {
  await runCadenceOnce("daily", { ...partial, now }, opts)
}

export async function registerDigestScheduledJobs(): Promise<void> {
  await registerScheduledJob("kernel", URGENT_JOB, "*/1 * * * *", async () => {
    await runDigestUrgentOnce()
  })
  await registerScheduledJob("kernel", IMMEDIATE_JOB, "*/1 * * * *", async () => {
    await runDigestCadenceOnce()
  })
  await registerScheduledJob("kernel", HOURLY_JOB, "0 * * * *", async () => {
    await runDigestHourlyOnce()
  })
  await registerScheduledJob("kernel", DAILY_JOB, "*/5 * * * *", async () => {
    await runDigestDailyAt(new Date())
  })
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const DigestJobsTestAccess = {
  rowToPending,
  fetchUrgent: defaultFetchUrgent,
  fetchCadencePending: defaultFetchCadencePending,
  /**
   * Replace the once-door for a unit test whose fixtures are not real orgs
   * (the ledger row needs one); `null` restores `sendEmailOnce`.
   */
  setSendOnce(fn: typeof sendEmailOnce | null): void {
    sendDigestMailOnce = fn ?? sendEmailOnce
  },
  resetRateLimit(): void {
    _rateLimitedUntilMs = 0
  },
}
