// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Wait for a sub-run's terminal state and shape the result. Two completion
// paths, both observed:
//   1) Redis pub/sub — the worker publishes `agent-run-result:<runId>` on
//      done/failed/cancelled.
//   2) Race fallback — completion may have published *before* the awaiter
//      subscribed. After subscribing we run a single SELECT against
//      `agent_runs.id = <runId>`; if the row is already terminal, we return
//      immediately from the row state and skip the wait.

import { and, eq } from "drizzle-orm"
import Redis from "ioredis"
import { withPrivilegedDb } from "~/db/privileged"
import { agentRuns, threads } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { publishRedis, REDIS_PREFIX, RESP_PROTOCOL } from "~/lib/redis"
import { setTaintFlag } from "~/modules/agent/scopes/taint"
import type { SubRunResult } from "./spawn-agent"

const log = rootLogger.child({ module: "subrun-await" })

function channelKey(runId: string): string {
  return `agent-run-result:${runId}`
}

export async function publishSubRunResult(
  runId: string,
  _orgId: string,
  payload: SubRunResult,
): Promise<void> {
  // BUG FIX (latent — surfaced by E2E run): ioredis applies `keyPrefix` to
  // KEY commands (GET/SET/…) but NOT to PUBLISH channel arguments — verified
  // via `redis-cli MONITOR`. So `publishRedis(channelKey(runId), …)` on a
  // `keyPrefix: REDIS_PREFIX` client publishes to the BARE channel, while
  // `awaitSubRunResult` below subscribes to the MANUALLY-prefixed channel.
  // In E2E (REDIS_PREFIX="w0:") they never match — publish lands on
  // `agent-run-result:<id>`, subscribe listens on
  // `w0:agent-run-result:<id>` — message lost, awaiter times out.
  //
  // Fix: prefix the publish channel manually to match the subscribe channel.
  // Unit tests with REDIS_PREFIX="" remain unaffected (empty prefix = no-op).
  await publishRedis(`${REDIS_PREFIX}${channelKey(runId)}`, JSON.stringify(payload))
}

/**
 * Mark the thread that spawned a sub-run when the sub-run's own thread read outside text, before
 * its result reaches the caller. The worker's own propagation (`propagateTaintToParent`) runs after
 * it publishes, possibly in another process, so the caller would otherwise hand the model the
 * result unmarked, and the calling tool call's stored record would not say it brought outside text
 * in (scopes/taint.ts, `watchTaintMarks`). Marks even an already marked parent, for that record.
 */
export async function markParentIfSubRunReadOutsideText(
  runId: string,
  orgId: string,
): Promise<void> {
  const [run] = await withPrivilegedDb(orgId, "subrun-result-taint", (tx) =>
    tx
      .select({ parentThreadId: agentRuns.parentThreadId, tainted: threads.tainted })
      .from(agentRuns)
      .innerJoin(threads, eq(threads.id, agentRuns.threadId))
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
      .limit(1),
  )
  if (run?.tainted && run.parentThreadId) await setTaintFlag(run.parentThreadId, orgId)
}

export function shapeFromRow(row: typeof agentRuns.$inferSelect): SubRunResult {
  const usage = {
    promptTokens: row.usagePromptTokens ?? 0,
    completionTokens: row.usageCompletionTokens ?? 0,
    creditCost: String(row.creditCost ?? "0"),
  }
  if (row.status === "done") {
    return {
      ok: true,
      runId: row.id,
      output: row.output,
      summary: row.summary,
      usage,
    }
  }
  return {
    ok: false,
    runId: row.id,
    output: null,
    summary: row.summary,
    usage,
    error: {
      code: row.errorCode ?? "unknown",
      message: row.errorMessage ?? "",
    },
  }
}

/** The outcome of a wait its caller stopped. */
function cancelledOutcome(runId: string): SubRunResult {
  return {
    ok: false,
    runId,
    output: null,
    summary: null,
    usage: { promptTokens: 0, completionTokens: 0, creditCost: "0" },
    error: { code: "cancelled", message: "Stopped before the sub-run finished." },
  }
}

/** A failed outcome as the coded Error a `continueOnError: false` caller gets. */
function outcomeError(result: SubRunResult): Error {
  const e = new Error(result.error?.message ?? "")
  ;(e as { code?: string }).code = result.error?.code
  return e
}

/**
 * Subscribe to the per-run result channel and resolve on first message OR
 * on observed-already-terminal DB row. `continueOnError=false` rejects with
 * a coded Error; `continueOnError=true` resolves with the shaped result so
 * the caller can branch on `result.ok`.
 *
 * With a `signal`, an abort cancels the run tree and settles the wait with the
 * cancelled outcome. The wait leaves nothing behind once it settles: the abort
 * listener comes off the caller's signal (one signal outlives many sub-runs)
 * and the subscriber connection closes at once, aborted or not.
 */
export async function awaitSubRunResult(
  runId: string,
  orgId: string,
  opts: {
    continueOnError?: boolean
    timeoutMs?: number
    /** The waiting caller's stop (a chat turn or a parent run): it cancels the run and its
     *  children, and the wait settles with the cancelled outcome at once. */
    signal?: AbortSignal
  } = {},
): Promise<SubRunResult> {
  const { signal } = opts
  const settle = (result: SubRunResult): SubRunResult => {
    if (!result.ok && !opts.continueOnError) throw outcomeError(result)
    return result
  }
  // Dedicated subscriber connection. We can't share `redisSub` here because
  // multiple parallel awaiters would compete on the `message` event handler.
  //
  // BUG FIX (latent — caught by E2E run + unit-test pub/sub timeouts):
  // ioredis applies `keyPrefix` to BOTH regular commands AND pub/sub channel
  // arguments. The publisher (`publishRedis` → `redis.publish`) runs on the
  // main `redis` client which has `keyPrefix: REDIS_PREFIX`, so the channel
  // sent to Redis is `${REDIS_PREFIX}<channel>`. If the subscriber ALSO sets
  // `keyPrefix: REDIS_PREFIX` AND manually pre-prefixes its subscribe arg,
  // ioredis double-prefixes the wire channel — `${REDIS_PREFIX}${REDIS_PREFIX}
  // <channel>` — never matches the publish, message lost, awaiter times out.
  //
  // Correct pattern (mirrors the long-lived `redisSub` in `lib/redis.ts`): the
  // subscriber sets NO `keyPrefix` and manually prefixes its channel arg.
  // Wire form ends up single-prefixed on both sides.
  const sub = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    protocol: RESP_PROTOCOL,
  })

  const prefixedChannel = `${REDIS_PREFIX}${channelKey(runId)}`
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  try {
    // Every way the wait can end, listened for before subscribing, so a result
    // published right after the subscription is never missed.
    const outcome = new Promise<SubRunResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("await_timeout")), opts.timeoutMs ?? 600_000)
      sub.on("messageBuffer", (_channel, raw) => {
        try {
          resolve(JSON.parse(raw.toString("utf8")) as SubRunResult)
        } catch (err) {
          reject(err as Error)
        }
      })
      if (signal) {
        onAbort = () => {
          void (async () => {
            const { cancelSubRunTree } = await import("./subrun-worker")
            await cancelSubRunTree(runId, orgId)
          })()
            .catch((err) => log.error({ err, runId, orgId }, "subrun-await: cancel failed"))
            .finally(() => resolve(cancelledOutcome(runId)))
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      }
    })
    // The early returns below leave `outcome` pending or settled unobserved.
    outcome.catch(() => {})

    if (signal?.aborted) return settle(await outcome)
    await sub.subscribe(prefixedChannel)

    // Race fallback: completion may have published before we subscribed.
    // Poll the row exactly once; if terminal, shape and return immediately.
    const [earlyRow] = await withPrivilegedDb(orgId, "subrun-await-poll", (tx) =>
      tx.select().from(agentRuns).where(eq(agentRuns.id, runId)).limit(1),
    )
    if (
      !signal?.aborted &&
      earlyRow &&
      (earlyRow.status === "done" ||
        earlyRow.status === "failed" ||
        earlyRow.status === "cancelled")
    ) {
      return settle(shapeFromRow(earlyRow))
    }

    return settle(await outcome)
  } finally {
    clearTimeout(timer)
    if (signal && onAbort) signal.removeEventListener("abort", onAbort)
    try {
      await sub.unsubscribe(prefixedChannel)
    } catch (err) {
      log.warn({ err, runId }, "subrun-await unsubscribe failed")
    }
    try {
      await sub.quit()
    } catch {
      // ignore
    }
  }
}
