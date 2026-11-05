// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E3 — Cron handler that drains the deferred queue.
//
// Invoked by the manifest-declared cron job `jobs.deferred-retry` on a
// 5-minute schedule (spec §7). Iterates rows returned by
// `retryEligible(ctx)`, re-invokes the topic-specific handler with the
// persisted payload, and either marks the row processed (success) or
// increments `retry_count` (failure). When a row crosses the dead-letter
// cap with sufficient age, `markPermanentFailure` flips its status.

import {
  collapseDuplicateParks,
  type DeferredCtx,
  type DeferredRow,
  type IdentityChangedAt,
  markPermanentFailure,
  resolveParkAttention,
  retryEligible,
} from "../deferred"

export type DeferredRetryCtx = DeferredCtx

export type DeferredDispatch = (
  row: DeferredRow,
) => Promise<{ status: "ok" } | { status: "still_blocked"; reason: string }>

export interface DeferredRetryResult {
  scanned: number
  succeeded: number
  failed: number
  dead_lettered: number
  /** Duplicate open parks closed by this sweep's self-heal pass. */
  collapsed?: number
  /** True when the sweep stopped early because the shared tx was aborted. */
  aborted?: boolean
}

/**
 * Postgres reports 25P02 ("current transaction is aborted, commands ignored
 * until end of transaction block") on EVERY statement issued after an earlier
 * statement in the same tx failed. Manifest jobs run through the ambient
 * whole-run bridge (createRpcBridge), so ONE aborted statement inside a
 * dispatch poisons the shared tx for the rest of the sweep. Once we see that
 * signature we must stop issuing statements (they will all just re-throw
 * 25P02) and let the sweep end so the tx rolls back cleanly; the affected rows
 * keep their prior retry_count and are picked up on the next sweep.
 */
function isTxAborted(err: unknown): boolean {
  const msg = (err as { message?: string })?.message ?? String(err)
  return msg.includes("25P02") || msg.includes("current transaction is aborted")
}

export async function deferredRetryJob(
  ctx: DeferredRetryCtx,
  dispatch: DeferredDispatch,
  opts?: { now?: Date; batchSize?: number; identityChangedAt?: IdentityChangedAt },
): Promise<DeferredRetryResult> {
  const now = opts?.now ?? new Date()
  // Self-heal first: collapse duplicate open parks of the same order + blocker, so the drain
  // below re-drives each order ONCE instead of once per duplicate row.
  let collapsed = 0
  try {
    collapsed = (await collapseDuplicateParks(ctx)).collapsed
  } catch (err) {
    if (isTxAborted(err)) {
      return { scanned: 0, succeeded: 0, failed: 0, dead_lettered: 0, aborted: true }
    }
  }
  const eligible = await retryEligible(ctx, {
    now,
    batchSize: opts?.batchSize,
    identityChangedAt: opts?.identityChangedAt,
  })

  let succeeded = 0
  let failed = 0
  let dead_lettered = 0
  let scanned = 0

  for (const row of eligible) {
    // Per-event isolation: a dispatch throwing (JS or a pg error) must not
    // abort the WHOLE sweep — capture it and move on. The ONE exception is an
    // aborted shared tx (25P02): every subsequent write would fail identically,
    // so stop the loop instead of hammering the poisoned tx (that cascade is
    // exactly what produced the flood of 25P02 UPDATE failures in prod).
    let outcome: { status: "ok" } | { status: "still_blocked"; reason: string }
    try {
      outcome = await dispatch(row)
    } catch (err) {
      if (isTxAborted(err)) {
        return { scanned, succeeded, failed, dead_lettered, collapsed, aborted: true }
      }
      outcome = { status: "still_blocked", reason: (err as Error).message ?? "unknown_error" }
    }

    scanned += 1

    try {
      if (outcome.status === "ok") {
        await ctx.db.update("deferred_events", row.id, {
          retried_at: now.toISOString(),
          retry_count: row.retry_count + 1,
          status: "resolved",
        })
        succeeded += 1
        // The park is closed: close its attention item (the identity item once no other park
        // waits on the contact).
        await resolveParkAttention(ctx, row)
      } else {
        await ctx.db.update("deferred_events", row.id, {
          retried_at: now.toISOString(),
          retry_count: row.retry_count + 1,
          reason: outcome.reason,
        })
        const updatedRow: DeferredRow = {
          ...row,
          retried_at: now,
          retry_count: row.retry_count + 1,
          reason: outcome.reason,
        }
        const after = await markPermanentFailure(ctx, updatedRow, { now })
        if (after.status === "permanent_failure") {
          dead_lettered += 1
        } else {
          failed += 1
        }
      }
    } catch (err) {
      // The bookkeeping write itself failed. If the tx is aborted, stop the
      // sweep (see isTxAborted); otherwise count this row as failed and carry
      // on — a single row's write failure must not poison the remaining batch.
      if (isTxAborted(err)) {
        return { scanned, succeeded, failed, dead_lettered, collapsed, aborted: true }
      }
      failed += 1
    }
  }

  return {
    scanned,
    succeeded,
    failed,
    dead_lettered,
    collapsed,
  }
}

