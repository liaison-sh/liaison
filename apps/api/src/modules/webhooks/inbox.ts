// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The durable webhook inbox (`kernel.webhook_inbox`, migration 0289).
 *
 * Every verified delivery is stored here before its handler runs:
 *
 * - the route stores it `processing` (claimed, with a lease), runs the handler
 *   and settles the row: `done`, `rejected` (the handler refused it, 4xx),
 *   or back to `pending` with a backoff (threw, or a transient status);
 * - a delivery for an org at an app day cap is stored `held` until the next
 *   UTC day, its handler not run;
 * - the `webhook-inbox-replay` job claims a due row and runs it again; the
 *   `webhook-inbox-sweep` job wakes every due row whose job was lost, and a
 *   `processing` row whose lease ended (its process died between store and
 *   settle) is due as well;
 * - a second delivery with the same verified identity (`delivery_hash`) while
 *   `dedup_until` holds finds the row and is not processed again; a row that
 *   is waiting for a retry (`pending`), was refused (`rejected`), dropped or
 *   dead is taken over by the redelivery, which runs it now.
 *
 * Privacy. The table is in the database's backups, so it holds as little as
 * a replay needs: only the provider's event headers are stored
 * (`storedWebhookHeaders`: never credentials, cookies, signatures or the
 * client's address), a settled row keeps no payload and no headers and is
 * deleted once its dedup window closes, and a dead row keeps them for
 * diagnosis for `WEBHOOK_INBOX_DEAD_RETENTION_DAYS` only. Erasing a person
 * clears every payload that names them (modules/erasure/erase-user.ts).
 * Written and read only through the privileged connection (the table is
 * deny-all to the request roles).
 */
import { randomUUID } from "node:crypto"
import { and, eq, inArray, lt, lte, or, sql } from "drizzle-orm"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type WebhookInboxRow, webhookInbox } from "~/db/schema/kernel"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { webhooksLogger as log } from "~/lib/logger"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

/** First attempt included: past it a delivery is `dead`. */
export const WEBHOOK_INBOX_MAX_ATTEMPTS = 8

/** Wait before attempt n+1, after attempt n failed (n = 1..). The last value repeats. */
const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000] as const

export function webhookInboxBackoffMs(attempts: number): number {
  const i = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1
  return BACKOFF_MS[i] as number
}

/** How long a replay's claim holds before the row counts as abandoned. */
export const REPLAY_LEASE_MS = 10 * 60_000

/**
 * Dead rows (payload kept for diagnosis) are deleted this many days after
 * they died: long enough to look at a failure over a weekend, short enough
 * that customer data in a payload does not linger. Settled rows hold no
 * payload and go as soon as their dedup window closes.
 */
export const WEBHOOK_INBOX_DEAD_RETENTION_DAYS = 7

/** Headers that carry no provider event data: never stored, never handed to a handler. */
const DROPPED_HEADER =
  /^(x-forwarded-|x-real-ip$|x-client-ip$|x-cluster-client-ip$|x-original-forwarded-for$|x-envoy-|x-amzn-trace-id$)|(^|-)(authorization|cookie|token|secret|password|signature|hmac|api-key|apikey|auth|session|csrf)(-|$)/

/**
 * The headers of a delivery that are kept: what a handler reads to identify
 * and route an event (the provider's `x-*` event, topic and delivery-id
 * headers), plus `content-type` and `user-agent`. Everything else goes:
 * credentials and cookies, signatures (the verifier already checked them; a
 * replay does not verify again), the forwarding and client-address headers,
 * and the transport ones (`host`, `cf-*`, `forwarded`, ...). Names are
 * lowercased. The handler gets the same set inline and on a replay.
 */
export function storedWebhookHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase()
    const kept = name === "content-type" || name === "user-agent" || name.startsWith("x-")
    if (kept && !DROPPED_HEADER.test(name) && typeof value === "string") out[name] = value
  }
  return out
}

const MAX_ERROR_LENGTH = 1_000

export const WEBHOOK_INBOX_REPLAY_JOB = "webhook-inbox-replay"

/** `delivery_hash` of a row moved in from a previous release's job: `legacy-job:<queue>:<job id>`. */
export const LEGACY_HASH_PREFIX = "legacy-job:"

/** A verified delivery, as the route stores it. */
export interface InboxDelivery {
  orgId: string
  appName: string
  endpointName: string
  /** sha256 hex of the verifier's replay key. */
  deliveryHash: string
  dedupTtlSeconds: number
  payload: unknown
  headers: Record<string, string>
  scopes: string[]
}

/** A row claimed by this process: settle it with the same token. */
export interface ClaimedDelivery {
  id: string
  orgId: string
  appName: string
  endpointName: string
  payload: unknown
  headers: Record<string, string>
  scopes: string[]
  attempts: number
  claimToken: string
  /** Moved in from a previous release's `retry-webhook` job (insertLegacyRetry). */
  legacy: boolean
}

function toClaimed(row: WebhookInboxRow): ClaimedDelivery {
  return {
    id: row.id,
    orgId: row.orgId,
    appName: row.appName,
    endpointName: row.endpointName,
    payload: row.payload,
    headers: row.headers ?? {},
    scopes: row.scopes,
    attempts: row.attempts,
    claimToken: row.claimToken as string,
    legacy: row.deliveryHash.startsWith(LEGACY_HASH_PREFIX),
  }
}

const inFuture = (ms: number) => sql`now() + make_interval(secs => ${ms / 1000})`

/**
 * Store a delivery, then either claim it for this process (`processing`, the
 * caller runs the handler now) or hold it (`held` until `holdMs` from now).
 * Returns null for a duplicate: a row with the same identity that is done
 * within its dedup window, held, or being processed under a live lease.
 */
export async function storeDelivery(
  d: InboxDelivery,
  mode: { claimLeaseMs: number } | { holdMs: number },
): Promise<ClaimedDelivery | null> {
  const claiming = "claimLeaseMs" in mode
  const claimToken = randomUUID()
  const rows = await withPrivilegedDb(d.orgId, "webhook-inbox:store", (db) =>
    db
      .insert(webhookInbox)
      .values({
        orgId: d.orgId,
        appName: d.appName,
        endpointName: d.endpointName,
        deliveryHash: d.deliveryHash,
        dedupUntil: inFuture(d.dedupTtlSeconds * 1000),
        payload: d.payload,
        headers: storedWebhookHeaders(d.headers),
        scopes: d.scopes,
        status: claiming ? "processing" : "held",
        attempts: claiming ? 1 : 0,
        dueAt: inFuture(claiming ? mode.claimLeaseMs : mode.holdMs),
        claimToken: claiming ? claimToken : null,
      })
      .onConflictDoUpdate({
        target: [
          webhookInbox.orgId,
          webhookInbox.appName,
          webhookInbox.endpointName,
          webhookInbox.deliveryHash,
        ],
        set: {
          status: sql`excluded.status`,
          payload: sql`excluded.payload`,
          headers: sql`excluded.headers`,
          scopes: sql`excluded.scopes`,
          dedupUntil: sql`excluded.dedup_until`,
          dueAt: sql`excluded.due_at`,
          claimToken: sql`excluded.claim_token`,
          // A row still being retried keeps counting; a settled one starts over.
          attempts: sql`CASE WHEN ${webhookInbox.status} IN ('pending', 'processing')
            THEN ${webhookInbox.attempts} + excluded.attempts ELSE excluded.attempts END`,
          lastError: null,
          settledAt: null,
          updatedAt: sql`now()`,
        },
        setWhere: or(
          inArray(webhookInbox.status, ["pending", "rejected", "dropped", "dead"]),
          and(eq(webhookInbox.status, "done"), lt(webhookInbox.dedupUntil, sql`now()`)),
          and(eq(webhookInbox.status, "processing"), lt(webhookInbox.dueAt, sql`now()`)),
        ),
      })
      .returning(),
  )
  const row = rows[0]
  return row ? toClaimed(row) : null
}

/**
 * Claim a due row for a replay: `pending` or `held` whose time came, or
 * `processing` whose lease ended. Null when it is not due, settled, gone, or
 * claimed by another runner.
 */
export async function claimForReplay(
  orgId: string,
  id: string,
  leaseMs: number = REPLAY_LEASE_MS,
): Promise<ClaimedDelivery | null> {
  const rows = await withPrivilegedDb(orgId, "webhook-inbox:claim", (db) =>
    db
      .update(webhookInbox)
      .set({
        status: "processing",
        claimToken: randomUUID(),
        attempts: sql`${webhookInbox.attempts} + 1`,
        dueAt: inFuture(leaseMs),
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(webhookInbox.id, id),
          eq(webhookInbox.orgId, orgId),
          inArray(webhookInbox.status, ["pending", "held", "processing"]),
          lte(webhookInbox.dueAt, sql`now()`),
        ),
      )
      .returning(),
  )
  const row = rows[0]
  return row ? toClaimed(row) : null
}

type Settlement =
  | { status: "done" }
  | { status: "rejected"; error: string }
  | { status: "dropped"; error: string }
  | { status: "failed"; error: string }
  | { status: "held"; holdMs: number }

/** What a settle did, for the caller to schedule the next wake. */
export type SettleResult =
  | { state: "done" | "rejected" | "dropped" | "dead" }
  | { state: "pending" | "held"; dueInMs: number; attempts: number }
  /** The claim was lost (the lease ended and another runner took the row). */
  | { state: "lost" }

/**
 * Settle a claimed row, fenced on its claim token. A failure goes back to
 * `pending` with the backoff of its attempt count, or `dead` past the last
 * attempt. A hold does not spend the attempt its claim counted.
 */
export async function settleDelivery(c: ClaimedDelivery, s: Settlement): Promise<SettleResult> {
  const error = "error" in s ? s.error.slice(0, MAX_ERROR_LENGTH) : null
  let set: PgUpdateSetSource<typeof webhookInbox>
  let result: SettleResult
  const settled = {
    payload: null,
    headers: null,
    claimToken: null,
    settledAt: sql`now()`,
    lastError: error,
  }
  if (s.status === "done" || s.status === "rejected" || s.status === "dropped") {
    set = { status: s.status, ...settled }
    result = { state: s.status }
  } else if (s.status === "held") {
    set = {
      status: "held",
      claimToken: null,
      attempts: sql`GREATEST(${webhookInbox.attempts} - 1, 0)`,
      dueAt: inFuture(s.holdMs),
    }
    result = { state: "held", dueInMs: s.holdMs, attempts: Math.max(c.attempts - 1, 0) }
  } else if (c.attempts >= WEBHOOK_INBOX_MAX_ATTEMPTS) {
    // Kept with its payload for diagnosis until retention.
    set = { status: "dead", claimToken: null, settledAt: sql`now()`, lastError: error }
    result = { state: "dead" }
  } else {
    const dueInMs = webhookInboxBackoffMs(c.attempts)
    set = { status: "pending", claimToken: null, dueAt: inFuture(dueInMs), lastError: error }
    result = { state: "pending", dueInMs, attempts: c.attempts }
  }
  const rows = await withPrivilegedDb(c.orgId, "webhook-inbox:settle", (db) =>
    db
      .update(webhookInbox)
      .set({ ...set, updatedAt: sql`now()` })
      .where(
        and(
          eq(webhookInbox.id, c.id),
          eq(webhookInbox.orgId, c.orgId),
          eq(webhookInbox.status, "processing"),
          eq(webhookInbox.claimToken, c.claimToken),
        ),
      )
      .returning({ id: webhookInbox.id }),
  )
  if (rows.length === 0) {
    log.warn(
      { inboxId: c.id, app: c.appName, endpoint: c.endpointName, settle: s.status },
      "webhook inbox: claim lost before settle",
    )
    return { state: "lost" }
  }
  if (result.state === "dead") {
    log.error(
      { inboxId: c.id, app: c.appName, endpoint: c.endpointName, attempts: c.attempts, error },
      "webhook inbox: delivery dead after its last attempt",
    )
  }
  return result
}

/** Settle, logging instead of throwing: the response to the provider never depends on it. */
export async function settleDeliveryQuietly(
  c: ClaimedDelivery,
  s: Settlement,
): Promise<SettleResult | null> {
  try {
    return await settleDelivery(c, s)
  } catch (err) {
    // The row stays `processing` and its lease ending makes it due again.
    log.error(
      { err, inboxId: c.id, app: c.appName, settle: s.status },
      "webhook inbox settle failed",
    )
    return null
  }
}

/** The replay job's dedup id: one wake per row and attempt count. */
export function replayJobId(id: string, attempts: number): string {
  return `webhook-inbox-${id}-${attempts}`
}

/**
 * Wake the replay of a row in `delayMs`. Best-effort: when the queue refuses,
 * the sweep wakes every due row anyway.
 */
export async function wakeReplay(
  orgId: string,
  id: string,
  attempts: number,
  delayMs: number,
): Promise<void> {
  try {
    await enqueueAppJob(
      "kernel",
      WEBHOOK_INBOX_REPLAY_JOB,
      { orgId, inboxId: id },
      { delay: Math.max(0, delayMs), jobId: replayJobId(id, attempts) },
    )
  } catch (err) {
    log.warn({ err, orgId, inboxId: id }, "webhook inbox: replay wake not queued; the sweep will")
  }
}

/** Schedule the next wake a settle asked for. */
export async function wakeAfterSettle(c: ClaimedDelivery, r: SettleResult | null): Promise<void> {
  if (r && (r.state === "pending" || r.state === "held")) {
    await wakeReplay(c.orgId, c.id, r.attempts, r.dueInMs)
  }
}

/** The unsettled rows that are due now, oldest first, leaving moving orgs alone. */
export async function listDueDeliveries(
  limit = 500,
): Promise<Array<{ id: string; orgId: string; attempts: number }>> {
  return sweepSkippingMoving((notMoving) =>
    withSystemDb("webhook-inbox:sweep", (db) =>
      db
        .select({ id: webhookInbox.id, orgId: webhookInbox.orgId, attempts: webhookInbox.attempts })
        .from(webhookInbox)
        .where(
          and(
            inArray(webhookInbox.status, ["pending", "held", "processing"]),
            lte(webhookInbox.dueAt, sql`now()`),
            notMoving(webhookInbox.orgId),
          ),
        )
        .orderBy(webhookInbox.dueAt)
        .limit(limit),
    ),
  )
}

/**
 * Retention (hourly): settled rows once their dedup window closed (they hold
 * no payload, only the identity that dedups a redelivery), dead rows after
 * their own short window.
 */
export async function pruneWebhookInbox(
  deadDays: number = WEBHOOK_INBOX_DEAD_RETENTION_DAYS,
): Promise<{ deleted: number }> {
  return sweepSkippingMoving((notMoving) =>
    withSystemDb("webhook-inbox:retention", async (db) => {
      const deleted = await db
        .delete(webhookInbox)
        .where(
          and(
            or(
              and(
                inArray(webhookInbox.status, ["done", "rejected", "dropped"]),
                lt(webhookInbox.dedupUntil, sql`now()`),
              ),
              and(
                eq(webhookInbox.status, "dead"),
                lt(webhookInbox.settledAt, sql`now() - make_interval(days => ${deadDays})`),
              ),
            ),
            notMoving(webhookInbox.orgId),
          ),
        )
        .returning({ id: webhookInbox.id })
      return { deleted: deleted.length }
    }),
  )
}

/**
 * A `retry-webhook` job of the previous release, moved into the inbox
 * (infra/jobs/webhook-inbox-jobs.ts). Its delivery id, when it carried one,
 * becomes the row id: the replay runs under the same effect-ledger key the
 * job would have, so a job that ran anyway is not applied twice. Idempotent:
 * the same job moved twice is one row. Returns whether a row was added.
 */
export async function insertLegacyRetry(args: {
  id: string
  orgId: string
  appName: string
  endpointName: string
  /** Identifies the job: `legacy-job:<queue>:<job id>`. */
  deliveryHash: string
  payload: unknown
  headers: Record<string, string>
  dueInMs: number
}): Promise<boolean> {
  const rows = await withPrivilegedDb(args.orgId, "webhook-inbox:legacy-drain", (db) =>
    db
      .insert(webhookInbox)
      .values({
        id: args.id,
        orgId: args.orgId,
        appName: args.appName,
        endpointName: args.endpointName,
        deliveryHash: args.deliveryHash,
        dedupUntil: sql`now()`,
        payload: args.payload,
        headers: storedWebhookHeaders(args.headers),
        // The previous release ran its retries with the app's own namespace.
        scopes: [`${args.appName}:*`],
        status: "pending",
        attempts: 0,
        dueAt: inFuture(args.dueInMs),
      })
      .onConflictDoNothing()
      .returning({ id: webhookInbox.id }),
  )
  return rows.length > 0
}
