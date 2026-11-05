// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Outside effects happen once: the effect ledger (`kernel.effect_ledger`,
 * migration 0226).
 *
 * `effectOnce(orgId, key, fn)` claims `key` in Postgres before `fn` runs and
 * stores `fn`'s result after. A second attempt with the same key (a job run
 * twice, a turn resumed on another process, a model re-calling the same write
 * tool) gets the stored result instead of repeating the effect.
 *
 * Postgres, not Redis: `lib/idempotency.ts` answers OPEN when Redis fails,
 * which is right for client retries but not for a deploy guarantee, and a
 * failover may change Redis.
 *
 * A key's states:
 * - no row: claimed (`pending`, claimed_by = this process), `fn` runs;
 * - `done`: the stored result comes back (`replayed`); logged
 *   `effect_duplicate`, the counter production watches;
 * - `pending`, claimer live and within the TTL: another runner holds it,
 *   `EffectInFlight` is thrown (a job's backoff retries it);
 * - `pending`, claimer not live (instance registry), or older than the TTL:
 *   the effect may or may not have happened. The row becomes `unknown`;
 * - `unknown`: at most once by default: skipped, logged `effect_unknown` and
 *   counted. A caller that can ask the remote side passes `onUnknown`, which
 *   decides: it happened (`done` with its result), it did not (`retry`: run
 *   `fn` now), or skip.
 *
 * `fn` throwing releases the claim (the row is deleted), so a retry runs it.
 *
 * A caller whose call was made with an outcome in doubt (a timeout) turns its
 * own claim `unknown` with `markUnknownEffect`, so the next attempt asks the
 * remote side first.
 *
 * `claimEffect` / `completeEffect` / `releaseEffect` are the same steps one
 * by one, for callers that cannot pass a function across a boundary (the app
 * sandbox bridge).
 */
import { and, eq, lt, or, sql } from "drizzle-orm"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { type EffectLedgerRow, effectLedger } from "~/db/schema/kernel"
import { INSTANCE_ID } from "~/infra/instance-id"
import { isInstanceLive } from "~/infra/instance-registry"
import { rootLogger } from "~/lib/logger"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "effect-once" })

/** A `pending` row older than this is unknown even when its claimer looks live. */
export const DEFAULT_PENDING_TTL_S = 600

/** Another live runner holds the key; retry later. */
export class EffectInFlight extends Error {
  readonly key: string
  readonly claimedBy: string
  constructor(key: string, claimedBy: string) {
    super(`effect ${key} is in flight on ${claimedBy}`)
    this.name = "EffectInFlight"
    this.key = key
    this.claimedBy = claimedBy
  }
}

export type ClaimResult =
  | { state: "claimed" }
  | { state: "done"; result: unknown }
  | { state: "in_flight"; claimedBy: string }
  | { state: "unknown"; claimedBy: string; claimedAt: Date }

export type EffectOutcome<T> =
  /** `fn` ran now. */
  | { status: "ran"; result: T }
  /** The effect had happened already (or `onUnknown` said so): its stored result. */
  | { status: "replayed"; result: T }
  /** It may or may not have happened, and was not run again. */
  | { status: "unknown" }

/** What `onUnknown` decides about an effect whose claimer died mid-way. */
export type UnknownDecision<T> =
  | { outcome: "done"; result: T }
  | { outcome: "retry" }
  | { outcome: "skip" }

export interface EffectOnceOptions<T> {
  pendingTtlS?: number
  onUnknown?:
    | "skip"
    | ((info: { key: string; claimedBy: string; claimedAt: Date }) => Promise<UnknownDecision<T>>)
  /** The claiming process. Default: this process. */
  claimer?: string
  /**
   * What the ledger stores for `fn`'s result (default: the result itself). A
   * caller whose result may carry data that must not persist (decrypted mail,
   * Invariant K) stores its redacted form; a replay then returns that form.
   */
  store?: (result: T) => Promise<unknown>
  /**
   * How long to wait for a key another live runner holds (`in_flight`) to
   * settle before throwing `EffectInFlight`, polled every 200 ms. A turn
   * resumed while its earlier process still finishes the same write waits for
   * that write's stored result instead of failing (S10, H2). Default 0.
   */
  inFlightWaitMs?: number
}

const counters = { unknown: 0, duplicate: 0 }

/** In-process counts of unknown and duplicate attempts since boot. */
export function effectLedgerStats(): { unknown: number; duplicate: number } {
  return { ...counters }
}

/**
 * Count and log (`effect_unknown`) a claim that came back unknown and is not
 * run again here. effectOnce calls it when it skips; the sandbox bridge calls it
 * for an app's unknown claim, which the app then skips or settles.
 */
export function noteUnknownEffect(orgId: string, key: string, claimedBy: string): void {
  counters.unknown++
  log.warn({ orgId, key, claimedBy }, "effect_unknown")
}

/**
 * The process a claimer names. A claimer is a process's instance id, or
 * `<instance id>:<run>` for one run inside it (the app sandbox bridge).
 */
function claimerInstance(claimedBy: string): string {
  const at = claimedBy.indexOf(":")
  return at === -1 ? claimedBy : claimedBy.slice(0, at)
}

/** Is the claimer that holds a pending row still running? Unreadable = live. */
async function claimerLive(claimedBy: string, claimer: string): Promise<boolean> {
  const instance = claimerInstance(claimedBy)
  if (claimedBy === claimer || instance === INSTANCE_ID) return true
  try {
    return await isInstanceLive(instance)
  } catch (err) {
    // Liveness cannot be read: keep it in flight; the TTL bounds the wait.
    log.warn({ err, claimedBy }, "effect_claimer_liveness_unreadable")
    return true
  }
}

async function readRow(orgId: string, key: string): Promise<EffectLedgerRow | null> {
  const rows = await withPrivilegedDb(orgId, "effect-once:read", (tx) =>
    tx
      .select()
      .from(effectLedger)
      .where(and(eq(effectLedger.orgId, orgId), eq(effectLedger.key, key)))
      .limit(1),
  )
  return rows[0] ?? null
}

/**
 * Claim `key` for `claimer`. A `pending` row whose claimer is dead or past the
 * TTL is turned `unknown` here (compare-and-set on its claim, so a claimer that
 * finishes in the meantime wins).
 */
export async function claimEffect(
  orgId: string,
  key: string,
  opts?: { pendingTtlS?: number; claimer?: string },
): Promise<ClaimResult> {
  const claimer = opts?.claimer ?? INSTANCE_ID
  const ttlMs = (opts?.pendingTtlS ?? DEFAULT_PENDING_TTL_S) * 1000
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await withPrivilegedDb(orgId, "effect-once:claim", (tx) =>
      tx
        .insert(effectLedger)
        .values({ orgId, key, state: "pending", claimedBy: claimer })
        .onConflictDoNothing()
        .returning({ key: effectLedger.key }),
    )
    if (inserted.length > 0) return { state: "claimed" }

    const row = await readRow(orgId, key)
    if (!row) continue // released between the insert and the read: claim again
    if (row.state === "done") {
      counters.duplicate++
      log.warn({ orgId, key, claimedBy: row.claimedBy }, "effect_duplicate")
      return { state: "done", result: row.result ?? null }
    }
    if (row.state === "unknown") {
      return { state: "unknown", claimedBy: row.claimedBy, claimedAt: row.claimedAt }
    }
    const stale = Date.now() - row.claimedAt.getTime() > ttlMs
    if (!stale && (await claimerLive(row.claimedBy, claimer))) {
      return { state: "in_flight", claimedBy: row.claimedBy }
    }
    const marked = await withPrivilegedDb(orgId, "effect-once:mark-unknown", (tx) =>
      tx
        .update(effectLedger)
        .set({ state: "unknown" })
        .where(
          and(
            eq(effectLedger.orgId, orgId),
            eq(effectLedger.key, key),
            eq(effectLedger.state, "pending"),
            eq(effectLedger.claimedBy, row.claimedBy),
            // The same claim, not a later one (Date has ms precision, the column µs).
            lt(effectLedger.claimedAt, new Date(row.claimedAt.getTime() + 1)),
          ),
        )
        .returning({ key: effectLedger.key }),
    )
    if (marked.length > 0) {
      log.warn({ orgId, key, claimedBy: row.claimedBy, stale }, "effect_claim_lost")
      return { state: "unknown", claimedBy: row.claimedBy, claimedAt: row.claimedAt }
    }
    // The row changed under us (completed or released): read it again.
  }
  throw new Error(`effect ${key}: the claim kept changing under concurrent writers`)
}

/**
 * Store the result of a claimed effect. `"lost"` when `claimer` no longer
 * holds the claim (it was judged dead and its row is `unknown`).
 */
export async function completeEffect(
  orgId: string,
  key: string,
  result: unknown,
  claimer: string = INSTANCE_ID,
): Promise<"ok" | "lost"> {
  const rows = await withPrivilegedDb(orgId, "effect-once:complete", (tx) =>
    tx
      .update(effectLedger)
      .set({ state: "done", result: result ?? null, doneAt: sql`now()` })
      .where(
        and(
          eq(effectLedger.orgId, orgId),
          eq(effectLedger.key, key),
          eq(effectLedger.state, "pending"),
          eq(effectLedger.claimedBy, claimer),
        ),
      )
      .returning({ key: effectLedger.key }),
  )
  if (rows.length > 0) return "ok"
  log.error({ orgId, key, claimer }, "effect_complete_lost_claim")
  return "lost"
}

/** Delete `claimer`'s pending claim (the effect threw and did not happen). */
export async function releaseEffect(
  orgId: string,
  key: string,
  claimer: string = INSTANCE_ID,
): Promise<void> {
  await withPrivilegedDb(orgId, "effect-once:release", (tx) =>
    tx
      .delete(effectLedger)
      .where(
        and(
          eq(effectLedger.orgId, orgId),
          eq(effectLedger.key, key),
          eq(effectLedger.state, "pending"),
          eq(effectLedger.claimedBy, claimer),
        ),
      ),
  )
}

/**
 * Turn `claimer`'s pending claim into `unknown` now: the call was made and its
 * outcome is in doubt (a timeout, a server error from the other side), so the
 * next attempt must ask the remote side before calling again. False when
 * `claimer` no longer holds the claim.
 */
export async function markUnknownEffect(
  orgId: string,
  key: string,
  claimer: string = INSTANCE_ID,
): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "effect-once:mark-unknown-own", (tx) =>
    tx
      .update(effectLedger)
      .set({ state: "unknown" })
      .where(
        and(
          eq(effectLedger.orgId, orgId),
          eq(effectLedger.key, key),
          eq(effectLedger.state, "pending"),
          eq(effectLedger.claimedBy, claimer),
        ),
      )
      .returning({ key: effectLedger.key }),
  )
  return rows.length > 0
}

/** Record what `onUnknown` learned: the effect happened, with this result. */
async function resolveUnknownDone(orgId: string, key: string, result: unknown): Promise<void> {
  await withPrivilegedDb(orgId, "effect-once:resolve-done", (tx) =>
    tx
      .update(effectLedger)
      .set({ state: "done", result: result ?? null, doneAt: sql`now()` })
      .where(
        and(
          eq(effectLedger.orgId, orgId),
          eq(effectLedger.key, key),
          eq(effectLedger.state, "unknown"),
        ),
      ),
  )
}

/** Take an unknown key back as a fresh claim (`onUnknown` said it did not happen). */
async function reclaimUnknown(orgId: string, key: string, claimer: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "effect-once:reclaim", (tx) =>
    tx
      .update(effectLedger)
      .set({ state: "pending", claimedBy: claimer, claimedAt: sql`now()` })
      .where(
        and(
          eq(effectLedger.orgId, orgId),
          eq(effectLedger.key, key),
          eq(effectLedger.state, "unknown"),
        ),
      )
      .returning({ key: effectLedger.key }),
  )
  return rows.length > 0
}

/**
 * Settle an `unknown` key from what the caller learned from the remote side:
 * `done` stores `result` (the effect happened); `retry` takes the key back as
 * a fresh claim for `claimer`, who then runs the effect and completes it.
 * False when the key is no longer `unknown` (another runner settled it).
 * For callers that decide across a boundary (the app sandbox bridge).
 */
export async function settleUnknownEffect(
  orgId: string,
  key: string,
  decision: { outcome: "done"; result: unknown } | { outcome: "retry" },
  claimer: string = INSTANCE_ID,
): Promise<boolean> {
  if (decision.outcome === "retry") return reclaimUnknown(orgId, key, claimer)
  const rows = await withPrivilegedDb(orgId, "effect-once:settle-done", (tx) =>
    tx
      .update(effectLedger)
      .set({ state: "done", result: decision.result ?? null, doneAt: sql`now()` })
      .where(
        and(
          eq(effectLedger.orgId, orgId),
          eq(effectLedger.key, key),
          eq(effectLedger.state, "unknown"),
        ),
      )
      .returning({ key: effectLedger.key }),
  )
  return rows.length > 0
}

async function runClaimed<T>(
  orgId: string,
  key: string,
  claimer: string,
  fn: () => Promise<T>,
  store?: (result: T) => Promise<unknown>,
): Promise<EffectOutcome<T>> {
  let result: T
  try {
    result = await fn()
  } catch (err) {
    await releaseEffect(orgId, key, claimer).catch((releaseErr) =>
      log.error({ err: releaseErr, orgId, key }, "effect_release_failed"),
    )
    throw err
  }
  await completeEffect(orgId, key, store ? await store(result) : result, claimer)
  return { status: "ran", result }
}

/**
 * Run `fn` at most once for `(orgId, key)`; see the module comment. The
 * stored result is `fn`'s return value as JSON: a replay returns that JSON,
 * so `T` must survive a JSON round trip.
 */
export async function effectOnce<T>(
  orgId: string,
  key: string,
  fn: () => Promise<T>,
  opts: EffectOnceOptions<T> = {},
): Promise<EffectOutcome<T>> {
  const claimer = opts.claimer ?? INSTANCE_ID
  const claimOpts = {
    claimer,
    ...(opts.pendingTtlS !== undefined ? { pendingTtlS: opts.pendingTtlS } : {}),
  }
  let claim = await claimEffect(orgId, key, claimOpts)
  const waitUntil = Date.now() + (opts.inFlightWaitMs ?? 0)
  while (claim.state === "in_flight" && Date.now() < waitUntil) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, waitUntil - Date.now())))
    claim = await claimEffect(orgId, key, claimOpts)
  }
  switch (claim.state) {
    case "claimed":
      return runClaimed(orgId, key, claimer, fn, opts.store)
    case "done":
      // The ledger holds what fn returned (JSON); the caller's T is that value.
      return { status: "replayed", result: claim.result as T }
    case "in_flight":
      throw new EffectInFlight(key, claim.claimedBy)
    case "unknown": {
      const decide = opts.onUnknown
      const decision: UnknownDecision<T> =
        decide && decide !== "skip"
          ? await decide({ key, claimedBy: claim.claimedBy, claimedAt: claim.claimedAt })
          : { outcome: "skip" }
      if (decision.outcome === "done") {
        await resolveUnknownDone(orgId, key, decision.result)
        return { status: "replayed", result: decision.result }
      }
      if (decision.outcome === "retry" && (await reclaimUnknown(orgId, key, claimer))) {
        return runClaimed(orgId, key, claimer, fn, opts.store)
      }
      noteUnknownEffect(orgId, key, claim.claimedBy)
      return { status: "unknown" }
    }
  }
}

/** How long a `done` row is kept (`effect-ledger-retention`). */
export const EFFECT_LEDGER_RETENTION_DAYS = 30

/**
 * How long an `unknown` row is kept. Far longer than a done row: while it
 * exists, a site that still retries (a parked mail, a deposit the platform
 * could not be asked about) meets it as unknown; once deleted, the next retry
 * would claim the key fresh and call out blind.
 */
export const EFFECT_LEDGER_UNKNOWN_RETENTION_DAYS = 365

/**
 * The daily `effect-ledger-retention` job:
 * - deletes `done` rows older than `days` (by `done_at`), which no retry can
 *   still need;
 * - turns `pending` rows older than `days` into `unknown`: their claimer is
 *   long gone, and nobody may claim the key fresh;
 * - deletes `unknown` rows older than `unknownDays` (by `claimed_at`).
 */
export async function pruneEffectLedger(
  days: number = EFFECT_LEDGER_RETENTION_DAYS,
  unknownDays: number = EFFECT_LEDGER_UNKNOWN_RETENTION_DAYS,
): Promise<{ deleted: number; abandoned: number }> {
  const cutoff = sql`now() - make_interval(days => ${days})`
  const unknownCutoff = sql`now() - make_interval(days => ${unknownDays})`
  // An org being moved keeps its rows as they are until the move ends.
  return sweepSkippingMoving((notMoving) =>
    withSystemDb("effect-once:retention", async (tx) => {
      const deleted = await tx
        .delete(effectLedger)
        .where(
          and(
            or(
              and(eq(effectLedger.state, "done"), lt(effectLedger.doneAt, cutoff)),
              and(eq(effectLedger.state, "unknown"), lt(effectLedger.claimedAt, unknownCutoff)),
            ),
            notMoving(effectLedger.orgId),
          ),
        )
        .returning({ key: effectLedger.key })
      const abandoned = await tx
        .update(effectLedger)
        .set({ state: "unknown" })
        .where(
          and(
            eq(effectLedger.state, "pending"),
            lt(effectLedger.claimedAt, cutoff),
            notMoving(effectLedger.orgId),
          ),
        )
        .returning({ key: effectLedger.key })
      return { deleted: deleted.length, abandoned: abandoned.length }
    }),
  )
}
