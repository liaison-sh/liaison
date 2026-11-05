// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client job queue (spec section 5.3c, blueprint phase 11).
//
// Headless work that used to read message bodies cannot run on the server any
// more, so a server-side trigger writes an ENVELOPE-ONLY row here and the
// user's browser drains it when it is next open and unlocked. Everything in
// this module is control-plane state: it lives in `kernel`, deliberately
// outside the mail app's entity machinery (tool projection, event emission,
// timeline), which is the machinery Invariant K forbids for mail data.
//
// Three things here are correctness properties rather than conveniences:
//
//   * The claim is ONE conditional UPDATE. Two tabs unlocked at once must not
//     both run the same job, and a read-then-write would let them: under READ
//     COMMITTED the loser blocks on the row, re-evaluates the predicate after
//     the winner commits, and matches nothing.
//   * A job is swept before it is listed or claimed. A tab that dies mid-drain
//     leaves a lease behind, and a lease nobody reclaims is a job that silently
//     never runs.
//   * A job that runs out of attempts or out of time becomes `failed` or
//     `expired` and STAYS VISIBLE. Dropping it would be the one failure mode
//     this queue may not have: the user asked for work and would never learn it
//     did not happen.
//
// Nothing here ever holds a result in the clear. `result_ciphertext` is sealed
// by the browser to the user's own key before it is posted, and this module
// treats it as opaque bytes.

import { and, asc, sql as drizzleSql, eq, inArray, isNull } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient } from "~/db"
import { mailboxClientJobs } from "~/db/schema/kernel"
import { assertEnvelopeOnlyPayload } from "~/modules/mailbox-jobs/payload-guard"

/**
 * v1 kinds: read-mostly work only. Anything that sends mail, converts a ticket
 * or writes to another app stays an in-session action, because partial
 * completion over a tab that can close mid-turn is unsound (spec 5.3c, 14).
 */
export const CLIENT_JOB_KINDS = [
  "summarise",
  "triage_label",
  "index_backfill",
  "migration_verify",
] as const
export type ClientJobKind = (typeof CLIENT_JOB_KINDS)[number]

export const CLIENT_JOB_STATUSES = ["pending", "claimed", "done", "failed", "expired"] as const
export type ClientJobStatus = (typeof CLIENT_JOB_STATUSES)[number]

/** How long a claim holds the job. Long enough for a decrypt plus a server-side
 *  turn, short enough that a closed tab does not strand the work for an hour. */
export const CLAIM_LEASE_MS = 5 * 60 * 1000

/** Attempts spent before the job stops retrying and becomes visible instead. */
export const MAX_ATTEMPTS = 3

/** A job nobody drained in a week is stale work, not pending work. */
export const JOB_TTL_DAYS = 7

export interface ClientJobView {
  id: string
  kind: string
  status: ClientJobStatus
  accountId: string | null
  payload: Record<string, unknown>
  attempts: number
  claimedBySession: string | null
  claimedAt: string | null
  leaseExpiresAt: string | null
  expiresAt: string | null
  completedAt: string | null
  createdAt: string
  /** Metadata, never the blob: a listing that carried every result would make a
   *  single request the whole history of what the mailbox owner ran. */
  hasResult: boolean
}

export interface ClaimView extends ClientJobView {
  /** Echoed so the drainer can stop working when its lease is gone. */
  leaseExpiresAt: string
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

function toView(row: typeof mailboxClientJobs.$inferSelect): ClientJobView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status as ClientJobStatus,
    accountId: row.accountId ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    attempts: row.attempts,
    claimedBySession: row.claimedBySession ?? null,
    claimedAt: iso(row.claimedAt),
    leaseExpiresAt: iso(row.leaseExpiresAt),
    expiresAt: iso(row.expiresAt),
    completedAt: iso(row.completedAt),
    createdAt: row.createdAt.toISOString(),
    hasResult: (row.resultCiphertext?.byteLength ?? 0) > 0,
  }
}

function owned(userId: string, orgId: string) {
  return and(eq(mailboxClientJobs.userId, userId), eq(mailboxClientJobs.orgId, orgId))
}

/**
 * Age the queue: expire what ran out of time, then hand back what ran out of
 * lease. The order matters. A job whose TTL has passed AND whose lease has
 * dropped is `expired`, not `pending`: expiry is terminal and retrying it would
 * resurrect work the user was already told had lapsed.
 */
export async function sweepJobs(tx: RlsClient, userId: string, orgId: string): Promise<void> {
  await tx
    .update(mailboxClientJobs)
    .set({ status: "expired", claimedBySession: null, leaseExpiresAt: null })
    .where(
      and(
        owned(userId, orgId),
        inArray(mailboxClientJobs.status, ["pending", "claimed"]),
        drizzleSql`${mailboxClientJobs.expiresAt} IS NOT NULL AND ${mailboxClientJobs.expiresAt} <= now()`,
      ),
    )

  await tx
    .update(mailboxClientJobs)
    .set({
      // The attempt was already counted at claim time, so a dropped lease only
      // decides whether there is another one left to spend.
      status: drizzleSql`CASE WHEN ${mailboxClientJobs.attempts} >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'pending' END`,
      claimedBySession: null,
      claimedAt: null,
      leaseExpiresAt: null,
    } as never)
    .where(
      and(
        owned(userId, orgId),
        eq(mailboxClientJobs.status, "claimed"),
        drizzleSql`${mailboxClientJobs.leaseExpiresAt} IS NOT NULL AND ${mailboxClientJobs.leaseExpiresAt} <= now()`,
      ),
    )
}

export interface ListOptions {
  /** Defaults to the actionable set: what is waiting, running, or needs saying. */
  status?: ClientJobStatus[]
  limit?: number
}

const DEFAULT_LIST_STATUSES: ClientJobStatus[] = ["pending", "claimed", "failed", "expired"]

export async function listJobs(
  tx: RlsClient,
  userId: string,
  orgId: string,
  options: ListOptions = {},
): Promise<ClientJobView[]> {
  await sweepJobs(tx, userId, orgId)
  const statuses = options.status?.length ? options.status : DEFAULT_LIST_STATUSES
  const rows = await tx
    .select()
    .from(mailboxClientJobs)
    .where(and(owned(userId, orgId), inArray(mailboxClientJobs.status, statuses)))
    .orderBy(asc(mailboxClientJobs.createdAt))
    .limit(Math.min(Math.max(options.limit ?? 100, 1), 500))
  return rows.map(toView)
}

async function readOne(
  tx: RlsClient,
  userId: string,
  orgId: string,
  jobId: string,
): Promise<typeof mailboxClientJobs.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(mailboxClientJobs)
    .where(and(owned(userId, orgId), eq(mailboxClientJobs.id, jobId)))
    .limit(1)
  return row
}

/**
 * Take the lease, single winner.
 *
 * The whole decision is the WHERE clause of one UPDATE, which is what makes two
 * concurrently unlocked devices safe with no lock of our own: the second
 * statement waits on the row, re-reads it after the first commits, and finds a
 * status that no longer satisfies the predicate.
 */
export async function claimJob(
  tx: RlsClient,
  userId: string,
  orgId: string,
  jobId: string,
  sessionId: string,
): Promise<ClaimView> {
  if (!sessionId.trim()) {
    throw new HTTPException(400, { message: "a claim needs a session id" })
  }
  await sweepJobs(tx, userId, orgId)

  const [row] = await tx
    .update(mailboxClientJobs)
    .set({
      status: "claimed",
      claimedBySession: sessionId,
      claimedAt: drizzleSql`now()` as never,
      leaseExpiresAt:
        drizzleSql`now() + ${drizzleSql.raw(`interval '${CLAIM_LEASE_MS} milliseconds'`)}` as never,
      attempts: drizzleSql`${mailboxClientJobs.attempts} + 1` as never,
    })
    .where(
      and(
        owned(userId, orgId),
        eq(mailboxClientJobs.id, jobId),
        eq(mailboxClientJobs.status, "pending"),
        drizzleSql`${mailboxClientJobs.attempts} < ${MAX_ATTEMPTS}`,
      ),
    )
    .returning()

  if (!row) {
    const current = await readOne(tx, userId, orgId, jobId)
    // RLS already hides another user's job, so "not in my own queue" is a 404
    // and never an existence oracle over someone else's mailbox.
    if (!current) throw new HTTPException(404, { message: "job not found" })
    throw new HTTPException(409, {
      message: `job is ${current.status} and cannot be claimed`,
    })
  }
  const view = toView(row)
  return { ...view, leaseExpiresAt: view.leaseExpiresAt ?? new Date().toISOString() }
}

export interface CompleteInput {
  sessionId: string
  status: "done" | "failed"
  /**
   * Base64 of a blob the browser sealed to the user's own key. There is
   * deliberately no free-text field beside it: a "reason" or "error" string
   * written by a client that has just decrypted a mailbox is exactly the shape
   * of an accidental plaintext leak back into the control plane.
   */
  resultCiphertext?: string | null
}

/** One megabyte of sealed summary is far past anything a read-mostly job
 *  produces, and short of anything that makes a request a memory event. */
export const MAX_RESULT_BYTES = 1024 * 1024

export async function completeJob(
  tx: RlsClient,
  userId: string,
  orgId: string,
  jobId: string,
  input: CompleteInput,
): Promise<ClientJobView> {
  const blob = input.resultCiphertext ? Buffer.from(input.resultCiphertext, "base64") : null
  if (blob && blob.byteLength > MAX_RESULT_BYTES) {
    throw new HTTPException(413, { message: "result is too large" })
  }

  const [row] = await tx
    .update(mailboxClientJobs)
    .set({
      status: input.status,
      completedAt: drizzleSql`now()` as never,
      leaseExpiresAt: null,
      resultCiphertext: blob ? new Uint8Array(blob) : null,
    })
    .where(
      and(
        owned(userId, orgId),
        eq(mailboxClientJobs.id, jobId),
        eq(mailboxClientJobs.status, "claimed"),
        eq(mailboxClientJobs.claimedBySession, input.sessionId),
      ),
    )
    .returning()

  if (!row) {
    const current = await readOne(tx, userId, orgId, jobId)
    if (!current) throw new HTTPException(404, { message: "job not found" })
    // The lease moved on. Accepting the result anyway would let a tab that woke
    // up from a long sleep overwrite the work another device has since done.
    throw new HTTPException(409, {
      message: `job is ${current.status} and is not held by this session`,
    })
  }
  return toView(row)
}

export interface EnqueueInput {
  kind: string
  payload: unknown
  accountId?: string | null
  /**
   * Enqueue at most once per identical (kind, account, payload): when a job
   * with the same content already exists for this user, its id is returned
   * and nothing is written. A resumed mail sync re-runs its envelope triggers
   * for a message it had stored; this keeps that from queueing the job twice.
   */
  dedupe?: boolean
}

/**
 * Write one job. Shared by the sandbox bridge and by any server-side caller, so
 * the kind check and the envelope-only check exist in exactly one place.
 */
export async function enqueueJob(
  tx: RlsClient,
  userId: string,
  orgId: string,
  input: EnqueueInput,
): Promise<{ jobId: string }> {
  if (!CLIENT_JOB_KINDS.includes(input.kind as ClientJobKind)) {
    throw new HTTPException(400, {
      message: `kind must be one of ${CLIENT_JOB_KINDS.join(", ")}, got "${input.kind}"`,
    })
  }
  const payload = JSON.parse(assertEnvelopeOnlyPayload(input.payload ?? {}))
  if (input.dedupe) {
    const [existing] = await tx
      .select({ id: mailboxClientJobs.id })
      .from(mailboxClientJobs)
      .where(
        and(
          eq(mailboxClientJobs.orgId, orgId),
          eq(mailboxClientJobs.userId, userId),
          eq(mailboxClientJobs.kind, input.kind),
          input.accountId
            ? eq(mailboxClientJobs.accountId, input.accountId)
            : isNull(mailboxClientJobs.accountId),
          drizzleSql`${mailboxClientJobs.payload} = ${JSON.stringify(payload)}::jsonb`,
        ),
      )
      .limit(1)
    if (existing) return { jobId: existing.id }
  }
  const [row] = await tx
    .insert(mailboxClientJobs)
    .values({
      orgId,
      userId,
      accountId: input.accountId ?? null,
      kind: input.kind,
      payload,
      expiresAt: drizzleSql`now() + ${drizzleSql.raw(`interval '${JOB_TTL_DAYS} days'`)}` as never,
    })
    .returning({ id: mailboxClientJobs.id })
  if (!row) throw new HTTPException(500, { message: "job insert returned no row" })
  return { jobId: row.id }
}
