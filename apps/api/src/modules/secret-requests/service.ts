// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SECRET REQUESTS: AN AGENT ASKS, A PERSON TYPES, THE SERVER CHECKS.
//
// The lifecycle of a `kernel.secret_requests` row (migration 0206):
//
//   create    the agent's `request_secret` call, under the turn's RLS context
//             (as the person whose turn it is, in a conversation they are in).
//             One pending row per (conversation, kind, target): a retry returns
//             the same row. The baseline is the store's fingerprints right now.
//   complete  the card, after it posted the secret to the target route. Takes
//             no input but the id: the server reads the store and saves the
//             request only when a fingerprint appeared that is not in the
//             baseline (stored.ts). Nothing new stored is a 409, and nothing
//             changes. Only a holder of the target route's scope may complete.
//   cancel    the requester or a holder of the target's scope.
//   expire    24 hours after creation, by the sweep (and shown as expired
//             before the sweep reaches it).
//
// Every status change runs on the privileged connection with the org taken
// from the row's own lookup, under a row lock, so two admins saving at once
// resolve to one save and one "already saved".

import { connectFailureReason } from "@liaison/shared"
import { and, eq, isNull, lt } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { PrivilegedDb, RlsClient, RlsTx } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents, type SecretRequest, secretRequests, users } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { newStoredSecret, readStoredSecretState } from "~/modules/secret-requests/stored"
import {
  canSubmitRequest,
  isPersonalTarget,
  requestKey,
  type SecretTarget,
  targetFields,
  targetFromRow,
} from "~/modules/secret-requests/targets"

const log = rootLogger.child({ module: "secret-requests" })

export const SECRET_REQUEST_TTL_MS = 24 * 60 * 60 * 1000

export class SecretRequestStateError extends HTTPException {
  readonly currentStatus: string
  constructor(currentStatus: string) {
    super(409, {
      message:
        currentStatus === "saved"
          ? "This secret was already saved."
          : `This request is ${currentStatus}.`,
    })
    this.currentStatus = currentStatus
  }
}

export interface CreateSecretRequestArgs {
  orgId: string
  threadId: string
  requestedBy: string
  agentId: string | null
  target: SecretTarget
  /**
   * The scopes of the turn that filed it (migration 0220): its target holds
   * text the agent chose, so only a reader holding them sees the row. Absent
   * or empty: no scoped read led to it (a setup kickoff, a config tool's card).
   */
  requiredScopes?: readonly string[]
}

/** The status a reader sees: a pending row past its expiry reads as expired. */
export function effectiveStatus(row: SecretRequest, now = new Date()): SecretRequest["status"] {
  return row.status === "pending" && row.expiresAt.getTime() <= now.getTime()
    ? "expired"
    : row.status
}

function eventData(row: SecretRequest) {
  // No conversation, no target fields, no hint: the frame reaches every member
  // who reads threads, and only says that some card changed state, so a card
  // on screen re-reads its row (which RLS then holds to the conversation).
  return { id: row.id, status: row.status }
}

/**
 * File (or find) the pending request for this target in this conversation.
 * Runs on the turn's RLS connection: the insert policy holds the row to the
 * requester's own identity and a conversation they are in.
 */
export async function createSecretRequest(
  db: RlsClient | RlsTx,
  args: CreateSecretRequestArgs,
): Promise<SecretRequest> {
  return (await fileSecretRequest(db, args)).row
}

/**
 * `createSecretRequest`, saying whether the row was already there: a second
 * identical call (in the same turn, or a later one) gets the pending card that
 * is already in the conversation, never a second one.
 */
export async function fileSecretRequest(
  db: RlsClient | RlsTx,
  args: CreateSecretRequestArgs,
): Promise<{ row: SecretRequest; reused: boolean }> {
  const key = requestKey(args.target, args.requestedBy)
  const pendingSame = and(
    eq(secretRequests.orgId, args.orgId),
    eq(secretRequests.threadId, args.threadId),
    eq(secretRequests.kind, args.target.kind),
    eq(secretRequests.targetKey, key),
    eq(secretRequests.status, "pending"),
  )
  const [existing] = await db.select().from(secretRequests).where(pendingSame).limit(1)
  if (existing && effectiveStatus(existing) === "pending") return { row: existing, reused: true }
  if (existing) {
    // Past its expiry and not swept yet: expire it so a fresh one can take its place.
    await expireRow(args.orgId, existing.id)
  }

  const { fingerprints } = await readStoredSecretState(args.orgId, args.target, args.requestedBy)
  const now = new Date()
  const [row] = await db
    .insert(secretRequests)
    .values({
      orgId: args.orgId,
      threadId: args.threadId,
      agentId: args.agentId,
      requestedBy: args.requestedBy,
      kind: args.target.kind,
      target: targetFields(args.target),
      targetKey: key,
      baseline: fingerprints,
      requiredScopes: [...new Set(args.requiredScopes ?? [])].sort(),
      status: "pending",
      createdAt: now,
      expiresAt: new Date(now.getTime() + SECRET_REQUEST_TTL_MS),
    })
    .onConflictDoNothing()
    .returning()
  if (!row) {
    // A concurrent identical call won the pending slot: return its row.
    const [winner] = await db.select().from(secretRequests).where(pendingSame).limit(1)
    if (winner) return { row: winner, reused: true }
    throw new HTTPException(409, { message: "Secret request creation conflicted; please retry" })
  }
  await db.queueEvent({
    app: "kernel",
    entity: "secret_request",
    action: "create",
    entityId: row.id,
    orgId: args.orgId,
    actorId: args.requestedBy,
    actorType: "agent",
    data: eventData(row),
  })
  return { row, reused: false }
}

/** One request the caller may see (a participant of its conversation, or its requester). */
export async function getSecretRequest(
  db: RlsClient | RlsTx,
  id: string,
): Promise<SecretRequest | null> {
  const [row] = await db.select().from(secretRequests).where(eq(secretRequests.id, id)).limit(1)
  return row ?? null
}

async function lockRow(
  tx: PrivilegedDb,
  orgId: string,
  id: string,
): Promise<SecretRequest | undefined> {
  const [row] = await tx
    .select()
    .from(secretRequests)
    .where(and(eq(secretRequests.id, id), eq(secretRequests.orgId, orgId)))
    .for("update")
    .limit(1)
  return row
}

async function expireRow(orgId: string, id: string): Promise<void> {
  await withPrivilegedDb(orgId, "secret-request-expire-one", async (tx) => {
    const [row] = await tx
      .update(secretRequests)
      .set({ status: "expired", completedAt: new Date() })
      .where(
        and(
          eq(secretRequests.id, id),
          eq(secretRequests.orgId, orgId),
          eq(secretRequests.status, "pending"),
        ),
      )
      .returning()
    if (row) await queueUpdate(tx, row, null)
  })
}

async function queueUpdate(tx: PrivilegedDb, row: SecretRequest, actorId: string | null) {
  await tx.queueEvent({
    app: "kernel",
    entity: "secret_request",
    action: "update",
    entityId: row.id,
    orgId: row.orgId,
    actorId: actorId ?? undefined,
    actorType: actorId ? "user" : "system",
    data: eventData(row),
  })
}

export interface CompleteSecretRequestArgs {
  orgId: string
  id: string
  userId: string
  scopes: string[]
  /**
   * Save only on this stored secret (a fingerprint from stored.ts): a connect
   * card is saved by the account its own grant stored, never by another one
   * that happens to be new.
   */
  fingerprint?: string
}

/**
 * Save the request when the store holds a secret it did not hold when the
 * agent asked. Nothing new stored: 409, nothing changes. The caller must hold
 * the target route's scope (403 otherwise).
 */
export async function completeSecretRequest(
  args: CompleteSecretRequestArgs,
): Promise<SecretRequest> {
  return withPrivilegedDb(args.orgId, "secret-request-complete", async (tx) => {
    const row = await lockRow(tx, args.orgId, args.id)
    if (!row) throw new HTTPException(404, { message: "Secret request not found" })
    const target = targetFromRow(row.kind, row.target)
    if (!target)
      throw new HTTPException(409, { message: "This request's target is no longer valid." })
    if (!canSubmitRequest(args.orgId, target, args.scopes, args.userId, row.requestedBy)) {
      throw new HTTPException(403, { message: "You cannot save this secret." })
    }
    const status = effectiveStatus(row)
    if (status !== "pending") throw new SecretRequestStateError(status)

    const state = await readStoredSecretState(args.orgId, target, row.requestedBy)
    const fresh = args.fingerprint
      ? state.fingerprints.includes(args.fingerprint) && !row.baseline.includes(args.fingerprint)
        ? { fingerprint: args.fingerprint, hint: state.hints.get(args.fingerprint) ?? null }
        : null
      : newStoredSecret(state, row.baseline)
    if (!fresh) {
      throw new HTTPException(409, {
        message: "Nothing new is stored for this request yet: save the secret first.",
      })
    }
    const [saved] = await tx
      .update(secretRequests)
      .set({
        status: "saved",
        hint: fresh.hint,
        completedBy: args.userId,
        completedAt: new Date(),
      })
      .where(eq(secretRequests.id, row.id))
      .returning()
    if (!saved) throw new HTTPException(404, { message: "Secret request not found" })
    await queueUpdate(tx, saved, args.userId)
    return saved
  })
}

/**
 * The pending requests in an org for one target, any conversation: a secret
 * saved for that target outside its card (a model key in Settings) settles them
 * too, through the same server-side completion check.
 */
export async function pendingRequestIdsForTarget(
  orgId: string,
  target: SecretTarget,
  /** Only the requests asked for this person (a personal connect is theirs alone). */
  requestedBy?: string,
): Promise<string[]> {
  // A personal connect is keyed per person (requestKey); every other target
  // has one key whoever asked.
  const key = isPersonalTarget(target)
    ? requestKey(target, requestedBy ?? "")
    : requestKey(target, "")
  const rows = await withPrivilegedDb(orgId, "secret-request-pending-for-target", (tx) =>
    tx
      .select({ id: secretRequests.id })
      .from(secretRequests)
      .where(
        and(
          eq(secretRequests.orgId, orgId),
          eq(secretRequests.kind, target.kind),
          eq(secretRequests.targetKey, key),
          eq(secretRequests.status, "pending"),
          ...(requestedBy ? [eq(secretRequests.requestedBy, requestedBy)] : []),
        ),
      ),
  )
  return rows.map((r) => r.id)
}

export interface CancelSecretRequestArgs {
  orgId: string
  id: string
  userId: string
  scopes: string[]
}

/** Cancel a pending request: its requester, or a holder of the target's scope. */
export async function cancelSecretRequest(args: CancelSecretRequestArgs): Promise<SecretRequest> {
  return withPrivilegedDb(args.orgId, "secret-request-cancel", async (tx) => {
    const row = await lockRow(tx, args.orgId, args.id)
    if (!row) throw new HTTPException(404, { message: "Secret request not found" })
    const target = targetFromRow(row.kind, row.target)
    const mayCancel =
      row.requestedBy === args.userId ||
      (target !== null &&
        canSubmitRequest(args.orgId, target, args.scopes, args.userId, row.requestedBy))
    if (!mayCancel) throw new HTTPException(403, { message: "You cannot cancel this request." })
    const status = effectiveStatus(row)
    if (status !== "pending") throw new SecretRequestStateError(status)
    const [cancelled] = await tx
      .update(secretRequests)
      .set({ status: "cancelled", completedBy: args.userId, completedAt: new Date() })
      .where(eq(secretRequests.id, row.id))
      .returning()
    if (!cancelled) throw new HTTPException(404, { message: "Secret request not found" })
    await queueUpdate(tx, cancelled, args.userId)
    return cancelled
  })
}

/** The sweep: every pending request past its expiry becomes expired, across orgs. */
export async function expireSecretRequests(now = new Date()): Promise<{ expired: number }> {
  return withSystemDb("secret-request-expiry", async (db) => {
    const rows = await db
      .update(secretRequests)
      .set({ status: "expired", completedAt: now })
      .where(and(eq(secretRequests.status, "pending"), lt(secretRequests.expiresAt, now)))
      .returning()
    for (const row of rows) await queueUpdate(db, row, null)
    return { expired: rows.length }
  })
}

/**
 * Claim the agent's follow-up turn for a saved request, once: whoever claims
 * first runs it. False when it was claimed already.
 */
export async function claimSecretRequestTurn(orgId: string, id: string): Promise<boolean> {
  return withPrivilegedDb(orgId, "secret-request-turn-claim", async (tx) => {
    const [row] = await tx
      .update(secretRequests)
      .set({ turnClaimedAt: new Date() })
      .where(
        and(
          eq(secretRequests.id, id),
          eq(secretRequests.orgId, orgId),
          isNull(secretRequests.turnClaimedAt),
        ),
      )
      .returning({ id: secretRequests.id })
    return Boolean(row)
  })
}

/** Who asked, in words, for the card: the agent's name and the person it asked for. */
export async function requestPeople(
  orgId: string,
  row: Pick<SecretRequest, "agentId" | "requestedBy">,
): Promise<{ agentName: string | null; requesterName: string | null }> {
  // `orgId` is the caller's own org (the route's session): the row it names
  // was read under that person's RLS, and both lookups stay in that org.
  return withPrivilegedDb(orgId, "secret-request-people", async (tx) => {
    const [person] = await tx
      .select({ name: users.name })
      .from(users)
      .where(and(eq(users.id, row.requestedBy), eq(users.orgId, orgId)))
      .limit(1)
    const [agent] = row.agentId
      ? await tx
          .select({ name: agents.displayName })
          .from(agents)
          .where(and(eq(agents.id, row.agentId), eq(agents.orgId, orgId)))
          .limit(1)
      : []
    return { agentName: agent?.name ?? null, requesterName: person?.name ?? null }
  })
}

/**
 * A connect card's consent failed at the callback (refused, denied, another
 * owner holds the account): the card is told the reason code over its own
 * event, so it shows why instead of going back to its form in silence. Only
 * the closed set of codes travels (`connectFailureReason`), never text the
 * provider or the callback wrote; the row itself stays pending, for a retry.
 * Best effort: a failure is logged, never thrown.
 */
export async function announceConnectFailure(
  orgId: string,
  requestId: string,
  rawReason: string,
): Promise<void> {
  try {
    const failure = connectFailureReason(rawReason)
    await withPrivilegedDb(orgId, "secret-request-connect-failure", async (tx) => {
      const [row] = await tx
        .select()
        .from(secretRequests)
        .where(
          and(
            eq(secretRequests.id, requestId),
            eq(secretRequests.orgId, orgId),
            eq(secretRequests.kind, "oauth_connect"),
            eq(secretRequests.status, "pending"),
          ),
        )
        .limit(1)
      if (!row) return
      await tx.queueEvent({
        app: "kernel",
        entity: "secret_request",
        action: "update",
        entityId: row.id,
        orgId,
        actorType: "system",
        data: { ...eventData(row), failure },
      })
    })
  } catch (err) {
    log.warn({ err, orgId, secretRequestId: requestId }, "connect failure not told to its card")
  }
}
