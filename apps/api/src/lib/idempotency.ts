// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A RETRIED WRITE IS APPLIED ONCE (A27).
//
// A client that lost the answer to a write (a network blip, a timeout) sends it
// again with the same idempotency key. The first request to claim the key runs
// the write; any other request with that key waits for it and gets the stored
// result back instead of writing a second time.
//
// The key lives in Redis, so it holds across every API process of the cell:
//   - `{ state: "pending", contentHash }` while the first request runs
//     (NX, short TTL, so a crashed process frees it);
//   - `{ state: "done", contentHash, result }` from the moment the write
//     COMMITTED (long TTL). A throw before the commit deletes the key, so the
//     retry runs the write; a throw after the commit keeps it, so the retry
//     replays and never writes again.
//
// The same key with a different payload is a client bug, never a retry: it is
// refused (422), not replayed.
//
// Every Redis command here is bounded (~1 s). Redis failing is answered OPEN:
// the write proceeds without dedup and a warning is logged. A write that cannot
// be deduplicated is better than a write that cannot be made.

import { createHash } from "node:crypto"
import { boundedBy } from "~/lib/bounded"
import { isTestEnv } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ service: "idempotency" })

/** The Redis subset the key needs, so a test can hand it a store that hangs. */
export interface IdempotencyStore {
  /** SET key value EX ttl NX. True when this caller claimed the key. */
  claim(key: string, value: string, ttlS: number): Promise<boolean>
  get(key: string): Promise<string | null>
  put(key: string, value: string, ttlS: number): Promise<void>
  del(key: string): Promise<void>
}

const redisStore: IdempotencyStore = {
  claim: async (key, value, ttlS) => (await redis.set(key, value, "EX", ttlS, "NX")) === "OK",
  get: (key) => redis.get(key),
  put: async (key, value, ttlS) => {
    await redis.set(key, value, "EX", ttlS)
  },
  del: async (key) => {
    await redis.del(key)
  },
}

let storeForTest: IdempotencyStore | undefined
const store = (): IdempotencyStore => storeForTest ?? redisStore

export interface IdempotencyOptions {
  /** TTL of the pending marker: how long a crashed first request holds the key. */
  pendingTtlS?: number
  /** TTL of the done record: how long a retry is answered from it. */
  doneTtlS?: number
  /** How long a duplicate waits for the first request to finish. */
  waitMs?: number
  /** The bound on each Redis command. */
  redisTimeoutMs?: number
}

const DEFAULTS = {
  pendingTtlS: 60,
  doneTtlS: 86_400,
  waitMs: 5_000,
  redisTimeoutMs: 1_000,
} satisfies Required<IdempotencyOptions>

const POLL_MS = 100

/** The same key with another payload: refused, never replayed. */
export class IdempotencyConflictError extends Error {
  readonly status = 422
  readonly code = "IDEMPOTENCY_KEY_REUSED"
  constructor() {
    super("This request id was already used for a different request")
    this.name = "IdempotencyConflictError"
  }
}

/** The first request with this key is still running past the wait. */
export class IdempotencyInFlightError extends Error {
  readonly status = 409
  readonly code = "IDEMPOTENT_IN_FLIGHT"
  constructor() {
    super("The same request is still being processed. Please retry shortly.")
    this.name = "IdempotencyInFlightError"
  }
}

class IdempotencyRedisTimeout extends Error {
  constructor(what: string, ms: number) {
    super(`idempotency: Redis did not answer ${what} within ${ms} ms`)
    this.name = "IdempotencyRedisTimeout"
  }
}

function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return boundedBy(p, ms, () => new IdempotencyRedisTimeout(what, ms))
}

/** A stable hash of a payload: object keys sorted, so key order never matters. */
export function idempotencyContentHash(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable)
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return createHash("sha256")
    .update(JSON.stringify(stable(value)) ?? "undefined")
    .digest("hex")
}

type Entry<R> =
  | { state: "pending"; contentHash: string }
  | { state: "done"; contentHash: string; result: R }

function parseEntry<R>(raw: string | null): Entry<R> | null {
  if (raw === null) return null
  try {
    const parsed = JSON.parse(raw) as Entry<R>
    if (parsed && (parsed.state === "pending" || parsed.state === "done")) return parsed
  } catch {
    // An unreadable value is treated as absent below.
  }
  return null
}

export interface IdempotentPhases<R, T> {
  /**
   * The write, up to and including its COMMIT. Its result is what a replay is
   * built from, so it must be serialisable (an id, a status). A throw here
   * frees the key: nothing was written, the retry runs it again.
   */
  commit: () => Promise<R>
  /**
   * Everything after the commit (side effects, the answer). A throw here keeps
   * the key: the write is in, a retry replays it and never writes again.
   */
  after: (result: R) => Promise<T>
  /** The answer to a duplicate, from the stored result. Runs no side effect. */
  replay: (result: R) => Promise<T>
}

/**
 * Run a write once per `key`. `contentHash` names the payload: the same key
 * with another hash answers `IdempotencyConflictError` (422). A duplicate that
 * finds the first request still running past `waitMs` answers
 * `IdempotencyInFlightError` (409).
 */
export async function withIdempotency<R, T>(
  key: string,
  contentHash: string,
  phases: IdempotentPhases<R, T>,
  opts: IdempotencyOptions = {},
): Promise<T> {
  const o = { ...DEFAULTS, ...opts }
  const s = store()
  const pending = JSON.stringify({ state: "pending", contentHash } satisfies Entry<R>)
  const claim = () => bounded(s.claim(key, pending, o.pendingTtlS), o.redisTimeoutMs, "claim")

  let claimed: boolean
  try {
    claimed = await claim()
  } catch (err) {
    log.warn({ err, key }, "Idempotency key unavailable: the write proceeds without dedup")
    return runUnguarded(phases)
  }

  if (!claimed) {
    const deadline = Date.now() + o.waitMs
    for (;;) {
      let entry: Entry<R> | null
      try {
        entry = parseEntry<R>(await bounded(s.get(key), o.redisTimeoutMs, "get"))
      } catch (err) {
        log.warn({ err, key }, "Idempotency key unreadable: the write proceeds without dedup")
        return runUnguarded(phases)
      }
      if (entry === null) {
        // The first request failed before its commit (or the key expired): try
        // to become the one that runs it.
        try {
          claimed = await claim()
        } catch (err) {
          log.warn({ err, key }, "Idempotency key unavailable: the write proceeds without dedup")
          return runUnguarded(phases)
        }
        if (claimed) break
        continue
      }
      if (entry.contentHash !== contentHash) throw new IdempotencyConflictError()
      if (entry.state === "done") return phases.replay(entry.result)
      if (Date.now() >= deadline) throw new IdempotencyInFlightError()
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  }

  let result: R
  try {
    result = await phases.commit()
  } catch (err) {
    // Nothing committed: free the key so the retry runs the write.
    try {
      await bounded(s.del(key), o.redisTimeoutMs, "del")
    } catch (delErr) {
      log.warn({ err: delErr, key }, "Idempotency key not freed; it expires with its pending TTL")
    }
    throw err
  }

  // Committed: from here on a retry replays, whatever happens next.
  try {
    const done = JSON.stringify({ state: "done", contentHash, result } satisfies Entry<R>)
    await bounded(s.put(key, done, o.doneTtlS), o.redisTimeoutMs, "put")
  } catch (err) {
    log.warn(
      { err, key },
      "Idempotency result not stored; a retry may answer 409 until the key expires",
    )
  }
  return phases.after(result)
}

async function runUnguarded<R, T>(phases: IdempotentPhases<R, T>): Promise<T> {
  return phases.after(await phases.commit())
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const IdempotencyTestAccess = {
  setStore(s?: IdempotencyStore): void {
    if (!isTestEnv()) throw new Error("IdempotencyTestAccess.setStore is only available in tests")
    storeForTest = s
  },
}
