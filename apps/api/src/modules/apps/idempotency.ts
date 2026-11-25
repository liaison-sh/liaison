// SPDX-License-Identifier: FSL-1.1-ALv2
import { createHash } from "node:crypto"
import { appsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"

const PENDING_TTL_S = 60
const COMPLETED_TTL_S = 24 * 60 * 60

export type IdempotencyEnvelope = { data: unknown } | { blocked: unknown }

export type ReserveOutcome =
  | { outcome: "reserved" }
  | { outcome: "hit"; cached: IdempotencyEnvelope }
  | { outcome: "conflict" }
  | { outcome: "in_flight" }

/** Stable JSON: object keys sorted at every depth, so key order never changes a hash. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
    .join(",")}}`
}

/** sha256 hex of the canonical JSON of `params` (tool-call keys reuse it). */
export function hashParams(params: unknown): string {
  return createHash("sha256").update(canonicalize(params)).digest("hex")
}

/**
 * The caller-scoped form of an idempotency key: a stored answer is one caller's (read under
 * their access, stamped for their turn), so another caller with the same key runs as their own.
 */
export function callerIdempotencyKey(
  actor: { actorType: string; userId?: string | null; agentId?: string | null },
  plainKey: string,
): string {
  return `${actor.actorType}:${actor.userId ?? "-"}:${actor.agentId ?? "-"}:${plainKey}`
}

function key(orgId: string, targetTool: string, idemKey: string): string {
  return `app_idem:${orgId}:${targetTool}:${idemKey}`
}

/**
 * The set of caller-scoped entries made under one plain key. A tool call's cache entry is
 * keyed per caller, while a cleanup that undoes the call (an app deleting what it created,
 * so its retry runs fresh) names only the plain key: it clears every entry listed here.
 */
function indexKey(orgId: string, targetTool: string, plainKey: string): string {
  return `app_idem_idx:${orgId}:${targetTool}:${plainKey}`
}

export async function reserveIdempotency(
  orgId: string,
  targetTool: string,
  idemKey: string,
  params: unknown,
  /** The caller's own key when `idemKey` is a caller-scoped form of it. */
  plainKey?: string,
): Promise<ReserveOutcome> {
  const k = key(orgId, targetTool, idemKey)
  const requestHash = hashParams(params)
  const reserved = await redis.set(
    k,
    JSON.stringify({ status: "pending", requestHash }),
    "EX",
    PENDING_TTL_S,
    "NX",
  )
  if (reserved && plainKey !== undefined && plainKey !== idemKey) {
    const idx = indexKey(orgId, targetTool, plainKey)
    await redis.multi().sadd(idx, k).expire(idx, COMPLETED_TTL_S).exec()
  }
  if (reserved) return { outcome: "reserved" }
  const existing = await redis.get(k)
  if (!existing) return { outcome: "reserved" }
  const parsed = JSON.parse(existing) as {
    status: "pending" | "succeeded" | "blocked"
    requestHash: string
    response?: IdempotencyEnvelope
  }
  const sameParams = parsed.requestHash === requestHash
  if (parsed.status === "pending") return { outcome: sameParams ? "in_flight" : "conflict" }
  if (!sameParams) return { outcome: "conflict" }
  if (!parsed.response) return { outcome: "reserved" }
  return { outcome: "hit", cached: parsed.response }
}

/**
 * Marks an idempotency reservation as complete and caches the response.
 *
 * `finalize` runs only AFTER the underlying side effect has already committed.
 * If the pending reservation key has since expired (TTL elapsed while the
 * operation was in flight), the response simply cannot be cached — but the work
 * is done. We must NOT turn that into an error: a thrown error would propagate
 * past the side effect's commit, the caller would treat the (successful)
 * operation as failed and retry, and the retry would re-run the side effect
 * (e.g. re-insert an inbound message) — the exact duplicate the idempotency key
 * exists to prevent. So we log a warning and return; the only consequence of an
 * expired reservation is that a same-key retry will re-execute rather than
 * replay the cached envelope.
 */
export async function finalizeIdempotency(
  orgId: string,
  targetTool: string,
  idemKey: string,
  params: unknown,
  response: IdempotencyEnvelope,
): Promise<void> {
  const k = key(orgId, targetTool, idemKey)
  const requestHash = hashParams(params)
  const status = "data" in response ? "succeeded" : "blocked"
  // `XX` = only write if the key still exists (the pending reservation must not
  // have expired). If the key is gone, `set` returns null: the response was NOT
  // cached, but the side effect already committed, so this is a best-effort
  // no-op rather than a failure.
  const result = await redis.set(
    k,
    JSON.stringify({ status, requestHash, response }),
    "EX",
    COMPLETED_TTL_S,
    "XX",
  )
  if (result === null) {
    log.warn(
      { orgId, targetTool, idemKey },
      "Idempotency reservation expired before the result could be cached; the operation already committed so the response was not persisted (a same-key retry will re-execute instead of replaying)",
    )
  }
}

export async function invalidateIdempotency(
  orgId: string,
  targetTool: string,
  idemKey: string,
): Promise<void> {
  const idx = indexKey(orgId, targetTool, idemKey)
  const scoped = await redis.smembers(idx)
  await redis.del(key(orgId, targetTool, idemKey), ...scoped, idx)
}
