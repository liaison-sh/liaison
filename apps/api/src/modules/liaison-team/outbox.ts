// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Liaison team outbox (`kernel.control_plane_outbox`, migration 0244).
// Every message to the control plane is a row here until it is delivered,
// permanently refused, cancelled or expired, so nothing is lost while the
// control plane is down.
//
// `drainOnce(now)` runs every minute (`control-plane-outbox`, kernel-jobs.ts):
//   1. housekeeping: rows older than 7 days expire, rows whose parent
//      (`depends_on`) ended undelivered are cancelled, the data of finished
//      rows is purged after 7 days and the rows deleted after 90;
//   2. a short transaction claims up to 20 due rows with FOR UPDATE SKIP
//      LOCKED, marks them `sending` with a 2-minute lease and COMMITS;
//   3. each row is sent outside any transaction (envelope with a fresh `ts`,
//      signed with the instance key except `register`, 10 s timeout) and
//      finished by one short transaction applying the reply (`classifyReply`).
// A drain sends only while its worst case still ends inside half the lease
// (elapsed + timeout <= 1 min) and gives the rest back, so a slow control plane
// never holds a cron slot for minutes nor outlives its own lease. Every finish
// is fenced on the lease it claimed (`lease_until`): a drain that dies after
// its claim leaves the rows to the next drain once the lease runs out, and a
// late finish after another drain took a row over changes nothing. Each row
// uses the drain's clock plus the time spent so far for `ts` and timestamps.
// A reply touches the identity only under `lockLiaisonTeam`, the lock the
// switches take, so a switch-off always wins over a reply in flight.
//
// While the identity is `pending` only `register` rows are sent; the others
// wait, with no attempt counted, and are signed with whatever identity is
// current when they are sent (so a re-registration keeps them). While it is
// `retiring` only its `deregister` is sent; any other row is cancelled.
//
// A `bug-report-attachment` row stores the local file id, never the bytes: the
// bytes are read from object storage when the row is sent (at most 7 MiB) and
// checked against the sha256 the reporter approved. A file that is gone (or
// changed) cancels the row (`source_file_gone` / `source_file_changed`); the
// local file id itself is never sent.

import { createHash, randomUUID } from "node:crypto"
import {
  CELL_BILLING_ENDPOINT,
  CELL_BILLING_ERROR_CODES,
  CELL_BILLING_MESSAGE_TYPES,
  type CellBillingMessageType,
  cellBillingMessageSchemas,
  INSTANCE_ENVELOPE_VERSION,
  INSTANCE_HEADER,
  MAX_FORWARD_ATTACHMENT_BYTES,
  type MessageType,
  messageSchemas,
  REJECTION_CODES,
  registeredReply,
  retryLaterReplySchema,
  SIGNATURE_HEADER,
} from "@liaison/control-plane-contract"
import { signBody } from "@liaison/control-plane-contract/node"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { isManagedEdition } from "~/lib/edition"
import { env, LIAISON_TEAM_DISABLED } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import {
  decryptInstanceKey,
  deleteIdentity,
  encryptInstanceKey,
  type LiaisonTeamIdentity,
  lockLiaisonTeam,
  mintIdentity,
  readIdentity,
  writeIdentity,
} from "./identity"
import { countActiveUsers, registerData } from "./payloads"

const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

const BATCH = 20
const LEASE_MS = 2 * 60_000
const SEND_TIMEOUT_MS = 10_000
const EXPIRE_AFTER_MS = 7 * 24 * 3600_000
const PURGE_AFTER_MS = 7 * 24 * 3600_000
const DELETE_AFTER_MS = 90 * 24 * 3600_000
const BACKOFF_BASE_S = 30
const BACKOFF_MAX_S = 3600
/** A 401 is a clock problem when the reply's `Date` is this far from our clock. */
const CLOCK_SKEW_MS = 120_000
/** 401s re-register only after this long and this many attempts (a rotated master secret). */
const AUTH_FAILING_REREGISTER_MS = 24 * 3600_000
const AUTH_FAILING_REREGISTER_ATTEMPTS = 5
/** A 403 without a code (instance blocked) waits at least an hour. */
const BLOCKED_MIN_BACKOFF_S = 3600

export type OutboxStatus = "pending" | "sending" | "delivered" | "refused" | "cancelled" | "expired"

type Db = Pick<PrivilegedDb, "execute" | "select" | "insert" | "delete">

/** A row's message: a v1 instance message, or a v2 money message to the `cell-billing` webhook. */
export type OutboxMessageType = MessageType | CellBillingMessageType

const CELL_BILLING_TYPES: ReadonlySet<string> = new Set(CELL_BILLING_MESSAGE_TYPES)

/** Is this a money message (contract v2, posted to `<endpoint>/cell-billing`)? */
export function isCellBillingType(type: string): type is CellBillingMessageType {
  return CELL_BILLING_TYPES.has(type)
}

/** The control plane base URL, or null when sharing is not available (LIAISON_TEAM_ENDPOINT=""). */
export function liaisonTeamEndpoint(): string | null {
  const v = env.LIAISON_TEAM_ENDPOINT
  return v === LIAISON_TEAM_DISABLED ? null : v.replace(/\/+$/, "")
}

/** Queue one message in the caller's (privileged) transaction. */
export async function enqueue(
  db: Pick<PrivilegedDb, "execute">,
  type: OutboxMessageType,
  data: Record<string, unknown>,
  opts: { dependsOn?: string; now?: Date } = {},
): Promise<{ id: string; messageId: string }> {
  const now = (opts.now ?? new Date()).toISOString()
  const messageId = randomUUID()
  const [row] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO ${K()}.control_plane_outbox
        (type, message_id, depends_on, data, next_attempt_at, created_at, updated_at)
      VALUES (${type}, ${messageId}::uuid, ${opts.dependsOn ?? null}::uuid,
              ${JSON.stringify(data)}::jsonb, ${now}::timestamptz, ${now}::timestamptz,
              ${now}::timestamptz)
      RETURNING id`),
  )
  if (!row) throw new Error("control_plane_outbox insert returned no row")
  return { id: row.id, messageId }
}

/**
 * Cancel every waiting row (`pending`, or `sending` past its lease). A row
 * being sent right now finishes on its own; its reply is then ignored.
 */
export async function cancelPending(
  db: Pick<PrivilegedDb, "execute">,
  reason: string,
  now: Date = new Date(),
): Promise<number> {
  const at = now.toISOString()
  const rows = extractRows(
    await db.execute(drizzleSql`
      UPDATE ${K()}.control_plane_outbox
         SET status = 'cancelled', lease_until = NULL, last_error = ${reason},
             updated_at = ${at}::timestamptz
       WHERE status = 'pending' OR (status = 'sending' AND lease_until < ${at}::timestamptz)
      RETURNING id`),
  )
  return rows.length
}

// ── Reply classification (the Protocol's Response table) ────────────────────

export type ReplyOutcome =
  | { kind: "delivered"; instanceKey?: string }
  /** Retry the same row now (a register duplicate gets a new messageId). */
  | { kind: "retry_now"; error: string; newMessageId: boolean }
  | { kind: "transient"; error: string; retryAfterSeconds?: number }
  | { kind: "refused"; error: string }
  | { kind: "clock"; offsetMs: number; error: string }
  | { kind: "auth"; error: string }
  | { kind: "reregister"; error: string }
  | { kind: "new_identity"; error: string }

export interface SendReply {
  status: number
  headers: Headers
  body: unknown
}

/** The most of a reply body this instance reads: a reply is a small JSON envelope. */
export const REPLY_MAX_BYTES = 64 * 1024
/** The most of any text from a reply kept in an error (stored as `last_error`, shown in Settings). */
const REPLY_TEXT_MAX_CHARS = 200

const clip = (s: string): string =>
  s.length > REPLY_TEXT_MAX_CHARS ? `${s.slice(0, REPLY_TEXT_MAX_CHARS)}…` : s

/**
 * The reply body as text, read up to `REPLY_MAX_BYTES`. A longer body is not a
 * reply this instance understands: it is dropped (empty text, so the outcome is
 * read from the status alone) and the rest of the stream is cancelled.
 */
export async function readReplyText(res: Response): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > REPLY_MAX_BYTES) {
      await reader.cancel().catch(() => {})
      return ""
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function errorMessage(body: unknown): string | null {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as { error?: unknown }).error
    if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
      return clip((e as { message: string }).message)
    }
  }
  return null
}

function retryAfterSeconds(headers: Headers, now: Date): number | undefined {
  const raw = headers.get("retry-after")
  if (!raw) return undefined
  // Never past the outbox's own horizon: a row expires after 7 days anyway.
  const bound = (s: number) => Math.min(s, EXPIRE_AFTER_MS / 1000)
  const n = Number(raw)
  if (Number.isFinite(n) && n >= 0) return bound(Math.ceil(n))
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return bound(Math.max(0, Math.ceil((at - now.getTime()) / 1000)))
}

/** What a reply means for the row that was sent (Protocol, Response handling). */
/**
 * A usage report refused by the control plane's trust check (the cell record
 * or the org's tenancy being changed) is tried this many times in all, on the
 * usual backoff, before it is recorded as refused: such a refusal can heal.
 */
export const USAGE_REPORT_TRUST_RETRIES = 8
const USAGE_REPORT_RETRIED_CODES = new Set(["unpinned_instance", "tenant_not_on_cell"])

export function classifyReply(
  row: { type: string; messageId: string; attempts?: number },
  reply: SendReply,
  ctx: { now: Date; clockOffsetMs: number },
): ReplyOutcome {
  const { status, headers, body } = reply
  const code = errorMessage(body)
  const label = `${status}${code ? ` ${code}` : ""}`
  if (status === 200) {
    const data = (body as { data?: unknown } | null)?.data as Record<string, unknown> | undefined
    if (data && typeof data === "object") {
      // A money message's reply is the answer itself: `{ok:true, ...}`, or a
      // final `{ok:false, code}` (Control decided), except `billing_unavailable`,
      // which asks to try again later.
      if (isCellBillingType(row.type) && typeof data.ok === "boolean") {
        if (data.ok || data.code !== CELL_BILLING_ERROR_CODES.billingUnavailable) {
          // A usage report has no answer but `ok`: any other final answer means the
          // control plane did not record it, which must show as refused (with its
          // code), never as delivered.
          // The app usage report (apps.usage) likewise: a Control that predates
          // it refuses the type, which shows as refused and touches nothing else.
          if (!data.ok && (row.type === "usage.report" || row.type === "apps.usage")) {
            const why = typeof data.code === "string" ? data.code.slice(0, 200) : "refused"
            if (
              USAGE_REPORT_RETRIED_CODES.has(why) &&
              (row.attempts ?? 0) + 1 < USAGE_REPORT_TRUST_RETRIES
            ) {
              return { kind: "transient", error: `200 ${why}` }
            }
            return { kind: "refused", error: `200 ${why}` }
          }
          return { kind: "delivered" }
        }
        return {
          kind: "transient",
          error: "200 billing_unavailable",
          retryAfterSeconds:
            typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : undefined,
        }
      }
      if (row.type === "register") {
        const reg = registeredReply.safeParse(data)
        if (reg.success) return { kind: "delivered", instanceKey: reg.data.instanceKey }
        // A registration is only done once the key is here: a bare ack would
        // leave the identity pending for ever with nothing left to send.
        if (data.type === "ack") {
          return { kind: "transient", error: "200 register acknowledged without an instance key" }
        }
      }
      if (data.type === "ack" && data.messageId === row.messageId) return { kind: "delivered" }
      if (data.received === true && data.duplicate === true) {
        // A register reply lost earlier: ask again under a new messageId and
        // the control plane answers the key again for the same nonce.
        return row.type === "register"
          ? { kind: "retry_now", error: "200 duplicate register", newMessageId: true }
          : { kind: "delivered" }
      }
      const later = retryLaterReplySchema.safeParse(data)
      if (later.success) {
        return {
          kind: "transient",
          error: `retry_later: ${later.data.reason}`,
          retryAfterSeconds:
            later.data.retryAfterSeconds === undefined
              ? undefined
              : Math.min(later.data.retryAfterSeconds, EXPIRE_AFTER_MS / 1000),
        }
      }
    }
    const dropped =
      body && typeof body === "object" && "dropped" in body
        ? clip(String((body as { dropped: unknown }).dropped))
        : "unexpected reply"
    return { kind: "transient", error: `200 not delivered: ${dropped}` }
  }
  if (status === 400 || status === 413 || status === 422) return { kind: "refused", error: label }
  if (status === 401) {
    const date = Date.parse(headers.get("date") ?? "")
    if (!Number.isNaN(date)) {
      // A clock this far off is the reply's, not ours: keep within the outbox's horizon.
      const offsetMs = Math.max(
        -EXPIRE_AFTER_MS,
        Math.min(EXPIRE_AFTER_MS, date - ctx.now.getTime()),
      )
      if (Math.abs(offsetMs - ctx.clockOffsetMs) > CLOCK_SKEW_MS) {
        return { kind: "clock", offsetMs, error: `${label} clock offset ${offsetMs} ms` }
      }
    }
    return { kind: "auth", error: label }
  }
  if (status === 403) {
    if (code === REJECTION_CODES.unknownInstance) return { kind: "reregister", error: label }
    if (code === REJECTION_CODES.notADemoInstance) return { kind: "refused", error: label }
    return {
      kind: "transient",
      error: label,
      retryAfterSeconds: Math.max(BLOCKED_MIN_BACKOFF_S, retryAfterSeconds(headers, ctx.now) ?? 0),
    }
  }
  if (status === 409 && code === REJECTION_CODES.alreadyRegistered) {
    return { kind: "new_identity", error: label }
  }
  return { kind: "transient", error: label, retryAfterSeconds: retryAfterSeconds(headers, ctx.now) }
}

// ── Drain ───────────────────────────────────────────────────────────────────

interface ClaimedRow {
  id: string
  type: OutboxMessageType
  messageId: string
  data: Record<string, unknown>
  attempts: number
  /** The lease this claim holds: every finish is fenced on it. */
  leaseUntil: string
}

export interface DrainOptions {
  /** Default: LIAISON_TEAM_ENDPOINT. */
  endpoint?: string
  /** Default: global fetch. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  /** U(0, 1) for the backoff jitter. Default: Math.random. */
  random?: () => number
  timeoutMs?: number
  /** Milliseconds spent since the drain started. Default: a monotonic clock. */
  elapsedMs?: () => number
}

export interface DrainResult {
  claimed: number
  delivered: number
}

/**
 * One drain cycle starting at `now`. Each row's clock is `now` plus the time
 * the drain has spent so far, so `ts`, the 401 clock check and the stored
 * timestamps stay true however slow the control plane is.
 */
export async function drainOnce(
  now: Date = new Date(),
  opts: DrainOptions = {},
): Promise<DrainResult> {
  const endpoint = opts.endpoint?.replace(/\/+$/, "") ?? liaisonTeamEndpoint()
  if (!endpoint) return { claimed: 0, delivered: 0 }
  const elapsedMs = opts.elapsedMs ?? monotonicSince(performance.now())
  const timeoutMs = opts.timeoutMs ?? SEND_TIMEOUT_MS
  await withSystemDb("liaison-team:outbox-housekeeping", (tx) => housekeeping(tx, now))
  const rows = await claimDue(now)
  let delivered = 0
  for (const [i, row] of rows.entries()) {
    const spent = elapsedMs()
    // Send only while this row's worst case still ends inside half the lease;
    // the rest go back untouched for the next drain.
    if (spent + timeoutMs > LEASE_MS / 2) {
      await releaseRows(rows.slice(i))
      break
    }
    const rowNow = new Date(now.getTime() + spent)
    if (await sendRow(row, endpoint, rowNow, opts)) delivered++
  }
  return { claimed: rows.length, delivered }
}

/**
 * Housekeeping alone (expiry, cancelled children, purge, delete), for the
 * minute job while no endpoint is set: no drain runs then, and a row queued
 * before the endpoint was unset must still end, so a team-only report's
 * undelivered notice fires (team-only.ts).
 */
export async function outboxHousekeeping(now: Date = new Date()): Promise<void> {
  await withSystemDb("liaison-team:outbox-housekeeping", (tx) => housekeeping(tx, now))
}

function monotonicSince(start: number): () => number {
  return () => performance.now() - start
}

async function housekeeping(tx: Db, now: Date): Promise<void> {
  const at = now.toISOString()
  const expireBefore = new Date(now.getTime() - EXPIRE_AFTER_MS).toISOString()
  const expired = extractRows<{ type: string }>(
    await tx.execute(drizzleSql`
      UPDATE ${K()}.control_plane_outbox
         SET status = 'expired', lease_until = NULL, updated_at = ${at}::timestamptz
       WHERE created_at < ${expireBefore}::timestamptz
         AND (status = 'pending' OR (status = 'sending' AND lease_until < ${at}::timestamptz))
      RETURNING type`),
  )
  if (expired.some((r) => r.type === "deregister")) await forgetRetiringIdentity(tx)
  // Children of a row that ended undelivered can never be sent.
  await tx.execute(drizzleSql`
    UPDATE ${K()}.control_plane_outbox c
       SET status = 'cancelled', lease_until = NULL, updated_at = ${at}::timestamptz,
           last_error = 'parent_' || p.status
      FROM ${K()}.control_plane_outbox p
     WHERE c.depends_on = p.id
       AND p.status IN ('refused', 'cancelled', 'expired')
       AND (c.status = 'pending' OR (c.status = 'sending' AND c.lease_until < ${at}::timestamptz))`)
  const purgeBefore = new Date(now.getTime() - PURGE_AFTER_MS).toISOString()
  await tx.execute(drizzleSql`
    UPDATE ${K()}.control_plane_outbox
       SET data = '{}'::jsonb, purged_at = ${at}::timestamptz
     WHERE status IN ('delivered', 'refused', 'cancelled', 'expired')
       AND purged_at IS NULL
       AND updated_at < ${purgeBefore}::timestamptz`)
  const deleteBefore = new Date(now.getTime() - DELETE_AFTER_MS).toISOString()
  await tx.execute(drizzleSql`
    DELETE FROM ${K()}.control_plane_outbox
     WHERE status IN ('delivered', 'refused', 'cancelled', 'expired')
       AND updated_at < ${deleteBefore}::timestamptz`)
}

/** Claim up to BATCH due rows with a lease, in one short committed transaction. */
export async function claimDue(now: Date): Promise<ClaimedRow[]> {
  const at = now.toISOString()
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString()
  return withSystemDb("liaison-team:outbox-claim", async (tx) => {
    const identity = await readIdentity(tx)
    // Without a registered identity only a registration can be sent.
    const onlyRegister = !identity || identity.state === "pending"
    const rows = extractRows<{
      id: string
      type: OutboxMessageType
      message_id: string
      data: Record<string, unknown>
      attempts: number
    }>(
      await tx.execute(drizzleSql`
        WITH due AS (
          SELECT o.id FROM ${K()}.control_plane_outbox o
           WHERE ((o.status = 'pending' AND o.next_attempt_at <= ${at}::timestamptz)
                  OR (o.status = 'sending' AND o.lease_until < ${at}::timestamptz))
             AND (${!onlyRegister} OR o.type = 'register')
             AND (o.depends_on IS NULL OR EXISTS (
                   SELECT 1 FROM ${K()}.control_plane_outbox p
                    WHERE p.id = o.depends_on AND p.status = 'delivered'))
           ORDER BY (o.type = 'register') DESC, o.created_at, o.id
           LIMIT ${BATCH}
           FOR UPDATE OF o SKIP LOCKED
        )
        UPDATE ${K()}.control_plane_outbox t
           SET status = 'sending', lease_until = ${leaseUntil}::timestamptz,
               updated_at = ${at}::timestamptz
          FROM due WHERE t.id = due.id
        RETURNING t.id, t.type, t.message_id, t.data, t.attempts, t.created_at`),
    )
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      messageId: r.message_id,
      data: r.data,
      attempts: r.attempts,
      leaseUntil,
    }))
  })
}

/** Send one claimed row and finish it. True when it was delivered. */
async function sendRow(
  row: ClaimedRow,
  endpoint: string,
  now: Date,
  opts: DrainOptions,
): Promise<boolean> {
  const identity = await withSystemDb("liaison-team:outbox-identity", (tx) => readIdentity(tx))
  let key: string | null = null
  if (row.type === "register") {
    if (identity?.state !== "pending") {
      await finishRow(row, { status: "cancelled", error: "no_pending_identity" }, now)
      return false
    }
  } else {
    if (!identity || identity.state === "pending") {
      await releaseRow(row)
      return false
    }
    // A deregister belongs to the identity that is leaving: never send one
    // signed with an identity that is not retiring.
    if (row.type === "deregister" && identity.state !== "retiring") {
      await finishRow(row, { status: "cancelled", error: "not_retiring" }, now)
      return false
    }
    // Everything else belongs to a registered server: a row queued just as
    // the switch went off (and so missed its cancel) is cancelled, never sent.
    if (row.type !== "deregister" && identity.state !== "registered") {
      await finishRow(row, { status: "cancelled", error: "retiring" }, now)
      return false
    }
    key = decryptInstanceKey(identity)
    if (!key) {
      await withSystemDb("liaison-team:outbox-unreadable-key", (tx) =>
        unreadableKey(tx, row, identity, now),
      )
      await releaseRow(row)
      return false
    }
  }

  // `local` is this server's own bookkeeping (a team-only bug report's org,
  // bug-report-payload.ts TeamOnlyLocal): never part of the message.
  const { local: _local, ...wire } = row.data
  let data: Record<string, unknown> =
    row.type === "register" ? { ...wire, nonce: identity.nonce } : wire
  if (row.type === "bug-report-attachment") {
    const loaded = await attachmentData(row.data)
    if ("cancel" in loaded) {
      await finishRow(row, { status: "cancelled", error: loaded.cancel }, now)
      return false
    }
    if ("transient" in loaded) {
      await applyOutcome(
        row,
        identity,
        { kind: "transient", error: loaded.transient },
        null,
        now,
        opts,
      )
      return false
    }
    data = loaded.data
  }
  const cellBilling = isCellBillingType(row.type)
  const envelope = {
    v: cellBilling ? 2 : INSTANCE_ENVELOPE_VERSION,
    type: row.type,
    messageId: row.messageId,
    instanceId: identity.instanceId,
    ts: new Date(now.getTime() + identity.clockOffsetMs).toISOString(),
    data,
  }
  const parsed = isCellBillingType(row.type)
    ? cellBillingMessageSchemas[row.type].safeParse(envelope)
    : messageSchemas[row.type]?.safeParse(envelope)
  if (!parsed?.success) {
    const error = `invalid_local_message: ${parsed?.error.message ?? `unknown type ${row.type}`}`
    log.error(
      { type: row.type, messageId: row.messageId, error },
      "Liaison team message refused locally",
    )
    await finishRow(row, { status: "refused", error: error.slice(0, 1000) }, now)
    return false
  }
  const rawBody = JSON.stringify(envelope)
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `liaison/${env.LIAISON_VERSION}`,
    [INSTANCE_HEADER]: identity.instanceId,
  }
  if (key) headers[SIGNATURE_HEADER] = signBody(key, rawBody)

  let reply: SendReply
  try {
    const path = cellBilling ? CELL_BILLING_ENDPOINT : row.type
    const res = await (opts.fetch ?? fetch)(`${endpoint}/${path}`, {
      method: "POST",
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(opts.timeoutMs ?? SEND_TIMEOUT_MS),
      redirect: "manual",
    })
    const text = await readReplyText(res)
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    reply = { status: res.status, headers: res.headers, body }
  } catch (err) {
    const error = `network: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000)
    await applyOutcome(row, identity, { kind: "transient", error }, null, now, opts)
    return false
  }
  const outcome = classifyReply(row, reply, { now, clockOffsetMs: identity.clockOffsetMs })
  if (outcome.kind === "refused") {
    log.error(
      { type: row.type, messageId: row.messageId, status: reply.status, error: outcome.error },
      "Liaison team control plane refused a message",
    )
  }
  await applyOutcome(row, identity, outcome, reply.status, now, opts)
  return outcome.kind === "delivered"
}

/** S3 says the object does not exist. */
function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404
}

/**
 * The wire data of an attachment row: the stored metadata without the local
 * file id, plus the bytes read now. Cancel when the file is gone or no longer
 * the one approved; transient when storage cannot be read.
 */
async function attachmentData(
  stored: Record<string, unknown>,
): Promise<{ data: Record<string, unknown> } | { cancel: string } | { transient: string }> {
  const { fileId, ...meta } = stored
  if (typeof fileId !== "string") return { cancel: "source_file_gone" }
  const [file] = extractRows<{ storage_key: string }>(
    await withSystemDb("liaison-team:outbox-attachment", (tx) =>
      tx.execute(drizzleSql`
        SELECT storage_key FROM ${K()}.files WHERE id = ${fileId}::uuid`),
    ),
  )
  if (!file) return { cancel: "source_file_gone" }
  let bytes: Buffer
  try {
    bytes = await getObjectBuffer(file.storage_key, undefined, {
      maxBytes: MAX_FORWARD_ATTACHMENT_BYTES,
    })
  } catch (err) {
    if (isMissingObject(err)) return { cancel: "source_file_gone" }
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("maxBytes")) return { cancel: "source_file_changed" }
    return { transient: `storage: ${message}`.slice(0, 1000) }
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== meta.sha256 || bytes.byteLength !== meta.sizeBytes) {
    return { cancel: "source_file_changed" }
  }
  return { data: { ...meta, bytesBase64: bytes.toString("base64") } }
}

/** The row is still ours: `sending` under the lease this drain claimed. */
const heldBy = (row: ClaimedRow) =>
  drizzleSql`id = ${row.id}::uuid AND status = 'sending'
             AND lease_until = ${row.leaseUntil}::timestamptz`

/** Give a claimed row back untouched (no attempt counted). */
async function releaseRow(row: ClaimedRow): Promise<void> {
  await releaseRows([row])
}

async function releaseRows(rows: ClaimedRow[]): Promise<void> {
  if (rows.length === 0) return
  await withSystemDb("liaison-team:outbox-release", async (tx) => {
    for (const row of rows) {
      await tx.execute(drizzleSql`
        UPDATE ${K()}.control_plane_outbox SET status = 'pending', lease_until = NULL
         WHERE ${heldBy(row)}`)
    }
  })
}

async function finishRow(
  row: ClaimedRow,
  end: { status: "cancelled" | "refused"; error: string },
  now: Date,
  db?: Pick<PrivilegedDb, "execute">,
): Promise<void> {
  const run = (tx: Pick<PrivilegedDb, "execute">) =>
    tx.execute(drizzleSql`
      UPDATE ${K()}.control_plane_outbox
         SET status = ${end.status}, lease_until = NULL, last_error = ${end.error},
             updated_at = ${now.toISOString()}::timestamptz
       WHERE ${heldBy(row)}`)
  if (db) await run(db)
  else await withSystemDb("liaison-team:outbox-finish", run)
}

/**
 * The instance key no longer decrypts (ENCRYPTION_KEY changed, a restore from
 * elsewhere). Registered: register again under a new id. Retiring: the admin
 * opted out, so never register again: forget the identity and end the
 * deregister, which cannot be signed (best effort, as for off-while-pending).
 */
async function unreadableKey(
  tx: Db,
  row: ClaimedRow,
  sentWith: LiaisonTeamIdentity,
  now: Date,
): Promise<void> {
  await lockLiaisonTeam(tx)
  const current = await readIdentity(tx)
  // A switch or another drain changed the identity meanwhile: it decides.
  if (!current || current.instanceId !== sentWith.instanceId) return
  if (current.state === "retiring") {
    await deleteIdentity(tx)
    await finishRow(row, { status: "cancelled", error: "instance_key_unreadable" }, now, tx)
    return
  }
  if (current.state === "registered") await reregister(tx, now, "instance_key_unreadable")
}

function backoffSeconds(attempts: number, random: () => number, retryAfter?: number): number {
  const base = Math.min(BACKOFF_BASE_S * 2 ** attempts, BACKOFF_MAX_S) * (0.8 + 0.4 * random())
  return Math.max(retryAfter ?? 0, base)
}

/** Apply one reply to the row (and the identity) in one short transaction. */
async function applyOutcome(
  row: ClaimedRow,
  sentWith: LiaisonTeamIdentity,
  outcome: ReplyOutcome,
  httpStatus: number | null,
  now: Date,
  opts: DrainOptions,
): Promise<void> {
  const at = now.toISOString()
  const random = opts.random ?? Math.random
  await withSystemDb("liaison-team:outbox-finish", async (tx) => {
    // The switches' lock first: a switch-off committed before this point is
    // read below, and one that comes later waits for this transaction.
    await lockLiaisonTeam(tx)
    const current = await readIdentity(tx)
    // The identity the row was sent with, still current: only then may the
    // reply change it (a switch-off or re-registration in between wins).
    const same = current !== null && current.instanceId === sentWith.instanceId ? current : null

    const update = async (
      set: ReturnType<typeof drizzleSql>,
      error: string | null,
    ): Promise<boolean> => {
      const rows = extractRows(
        await tx.execute(drizzleSql`
          UPDATE ${K()}.control_plane_outbox
             SET ${set}, lease_until = NULL, last_status = ${httpStatus},
                 last_error = ${error === null ? null : error.slice(0, 1000)}, updated_at = ${at}::timestamptz
           WHERE ${heldBy(row)}
          RETURNING id`),
      )
      return rows.length > 0
    }
    const retryAt = (seconds: number) =>
      new Date(now.getTime() + Math.round(seconds * 1000)).toISOString()
    const transient = (retryAfter?: number) =>
      drizzleSql`status = 'pending', attempts = attempts + 1,
                 next_attempt_at = ${retryAt(backoffSeconds(row.attempts, random, retryAfter))}::timestamptz`
    const now_ = drizzleSql`status = 'pending', attempts = attempts + 1,
                            next_attempt_at = ${at}::timestamptz`

    switch (outcome.kind) {
      case "delivered": {
        const ok = await update(
          drizzleSql`status = 'delivered', attempts = attempts + 1, delivered_at = ${at}::timestamptz`,
          null,
        )
        if (!ok || !same) return
        if (row.type === "deregister") {
          if (same.state === "retiring") await deleteIdentity(tx)
          return
        }
        if (row.type === "register" && outcome.instanceKey && same.state === "pending") {
          await writeIdentity(tx, {
            ...same,
            authFailingSince: null,
            keyCiphertext: encryptInstanceKey(outcome.instanceKey),
            state: "registered",
            registeredAt: at,
          })
        } else if (same.authFailingSince) {
          await writeIdentity(tx, { ...same, authFailingSince: null })
        }
        return
      }
      case "retry_now":
        await update(
          outcome.newMessageId ? drizzleSql`${now_}, message_id = ${randomUUID()}::uuid` : now_,
          outcome.error,
        )
        return
      case "transient":
        await update(transient(outcome.retryAfterSeconds), outcome.error)
        return
      case "refused": {
        const ok = await update(
          drizzleSql`status = 'refused', attempts = attempts + 1`,
          outcome.error,
        )
        if (ok && same && row.type === "deregister" && same.state === "retiring") {
          await deleteIdentity(tx)
        }
        return
      }
      case "clock":
        await update(now_, outcome.error)
        if (same) await writeIdentity(tx, { ...same, clockOffsetMs: outcome.offsetMs })
        return
      case "auth": {
        const since = same?.authFailingSince ?? at
        const longEnough =
          now.getTime() - Date.parse(since) >= AUTH_FAILING_REREGISTER_MS &&
          row.attempts + 1 >= AUTH_FAILING_REREGISTER_ATTEMPTS
        if (
          same &&
          longEnough &&
          same.state !== "retiring" &&
          !refuseReregisterWhenManaged("auth_failing_24h")
        ) {
          await update(now_, outcome.error)
          await reregister(tx, now, "auth_failing_24h")
          return
        }
        await update(transient(), outcome.error)
        if (same && !same.authFailingSince) {
          await writeIdentity(tx, { ...same, authFailingSince: at })
        }
        return
      }
      case "reregister":
      case "new_identity": {
        if (row.type === "register") {
          // The register row itself goes again, under a new id and messageId.
          await update(drizzleSql`${now_}, message_id = ${randomUUID()}::uuid`, outcome.error)
          if (same && !refuseReregisterWhenManaged(outcome.error)) {
            await writeIdentity(tx, mintIdentity())
          }
          return
        }
        if (row.type === "deregister") {
          // The control plane does not know this id (any more): leaving is
          // done. Never put it back in the queue, where it would wait for and
          // then deregister whatever identity comes next.
          await update(
            drizzleSql`status = 'delivered', attempts = attempts + 1, delivered_at = ${at}::timestamptz`,
            outcome.error,
          )
          if (same?.state === "retiring") await deleteIdentity(tx)
          return
        }
        if (same?.state === "retiring") {
          // Leaving: nothing but the deregister goes out any more.
          await update(drizzleSql`status = 'cancelled', attempts = attempts + 1`, outcome.error)
          return
        }
        if (refuseReregisterWhenManaged(outcome.error)) {
          // No new identity is coming: back off like any transient failure.
          await update(transient(), outcome.error)
          return
        }
        await update(now_, outcome.error)
        if (same) await reregister(tx, now, outcome.error)
        return
      }
    }
  })
}

/**
 * The managed edition's identity is provisioned and pinned by the control
 * plane's operator: it never re-mints or registers itself. Where a self-hosted
 * server would, it logs an error for the operator (re-provision the identity)
 * and keeps the identity; true when it refused.
 */
function refuseReregisterWhenManaged(reason: string): boolean {
  if (!isManagedEdition()) return false
  log.error(
    { reason },
    "Liaison team: the control plane no longer accepts this server's identity; the managed edition never registers itself, re-provision the identity",
  )
  return true
}

/**
 * Register again under a new identity: the old one is forgotten, every
 * waiting non-register row stays and is sent under the new id once it is
 * registered.
 */
async function reregister(tx: Db, now: Date, reason: string): Promise<void> {
  if (refuseReregisterWhenManaged(reason)) return
  const at = now.toISOString()
  await tx.execute(drizzleSql`
    UPDATE ${K()}.control_plane_outbox
       SET status = 'cancelled', lease_until = NULL, last_error = ${`superseded: ${reason}`},
           updated_at = ${at}::timestamptz
     WHERE type = 'register'
       AND (status = 'pending' OR (status = 'sending' AND lease_until < ${at}::timestamptz))`)
  await writeIdentity(tx, mintIdentity())
  await enqueue(tx, "register", registerData(await countActiveUsers(tx)), { now })
  log.info({ reason }, "Liaison team: registering again under a new instance id")
}

async function forgetRetiringIdentity(tx: Db): Promise<void> {
  const identity = await readIdentity(tx)
  if (identity?.state === "retiring") await deleteIdentity(tx)
}

/** Counts for Settings > System (operator only). */
export async function outboxCounts(db: Pick<PrivilegedDb, "execute">): Promise<{
  pending: number
  failed: number
  expired: number
  lastDeliveredAt: string | null
  lastError: string | null
}> {
  const [row] = extractRows<{
    pending: number
    failed: number
    expired: number
    last_delivered_at: string | null
    last_error: string | null
  }>(
    await db.execute(drizzleSql`
      SELECT
        count(*) FILTER (WHERE status IN ('pending', 'sending'))::int AS pending,
        count(*) FILTER (WHERE status = 'refused')::int AS failed,
        count(*) FILTER (WHERE status = 'expired')::int AS expired,
        max(delivered_at)::text AS last_delivered_at,
        (SELECT last_error FROM ${K()}.control_plane_outbox
          WHERE last_error IS NOT NULL AND status <> 'delivered'
          ORDER BY updated_at DESC LIMIT 1) AS last_error
      FROM ${K()}.control_plane_outbox`),
  )
  return {
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    expired: row?.expired ?? 0,
    lastDeliveredAt: row?.last_delivered_at ?? null,
    lastError: row?.last_error ?? null,
  }
}
