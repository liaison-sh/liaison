// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE PER-JOB TAINT OF A NODE JOB (A18, A50/F6).
 *
 * A node job's Liaison calls go through the agent-bound MCP gateway like any
 * external runtime's, and that gateway keeps its taint per (org, agent) on a
 * 15 minute sliding window (`mcpTurnTaintKey`). That window is right for
 * refusing writes and wrong for tagging a job result: a job may run for an
 * hour (the window forgets what it read), and the same agent may be talking
 * in another conversation meanwhile (the window adds what it did not read).
 *
 * So the job claims its MCP connection (`bindNodeJobConnection`, at claim),
 * and every scoped call on THAT connection also lands in a set kept for the
 * job's whole life. Keyed by the connection, because the connection is what
 * the gateway knows; mapped to the job, because the job is what the result
 * is. Small and Redis-only, so the gateway pays one read per call and imports
 * nothing heavy.
 *
 * The node holds one MCP connection per agent, and P3's caps let two runs of
 * one agent live at once, so a connection maps to the SET of jobs it is
 * running. A call cannot say which run made it, so it lands on every live
 * job of its connection: a run may be over-tagged, never under-tagged.
 */

import { rootLogger } from "~/lib/logger"
import { redis } from "~/lib/redis"

const log = rootLogger.child({ module: "node-job-taint" })

/**
 * A bound on an orphaned key only: jobs never expire (D11), so a job that
 * waits longer than this before its result loses its exact taint and its
 * result falls back to the ceiling (an absent key on a bound job reads as
 * unknown, see `loadNodeJobTaint`).
 */
export const NODE_JOB_TAINT_TTL_SECONDS = 60 * 60 * 24 * 30

export function nodeJobTaintKey(jobId: string): string {
  return `node-job-taint:${jobId}`
}

/** The jobs an MCP connection is running, while it runs any (a set). */
export function nodeJobConnectionKey(connectionId: string): string {
  return `node-job-conns:${connectionId}`
}

/** Written when a job binds its connection: marks the set as existing (empty is a real answer). */
const BOUND_MARK = "__bound__"

export async function bindNodeJobConnectionKey(connectionId: string, jobId: string): Promise<void> {
  await redis
    .multi()
    .sadd(nodeJobConnectionKey(connectionId), jobId)
    .expire(nodeJobConnectionKey(connectionId), NODE_JOB_TAINT_TTL_SECONDS)
    .sadd(nodeJobTaintKey(jobId), BOUND_MARK)
    .expire(nodeJobTaintKey(jobId), NODE_JOB_TAINT_TTL_SECONDS)
    .exec()
}

/** This job no longer runs on the connection; its other jobs stay. */
export async function unbindNodeJobConnectionKey(
  connectionId: string,
  jobId: string,
): Promise<void> {
  try {
    await redis.srem(nodeJobConnectionKey(connectionId), jobId)
  } catch (err) {
    log.warn({ err, connectionId, jobId }, "node job connection unbind failed")
  }
}

/**
 * The gateway's hook, per scoped call on an agent-bound connection: the
 * scopes join the set of every node job the connection is running. Never
 * throws (a tool call does not fail over bookkeeping); a failure is logged.
 */
export async function recordNodeJobTaint(
  connectionId: string,
  scopes: readonly string[],
): Promise<void> {
  if (scopes.length === 0) return
  try {
    const jobIds = await redis.smembers(nodeJobConnectionKey(connectionId))
    if (jobIds.length === 0) return
    const tx = redis.multi()
    for (const jobId of jobIds) {
      tx.sadd(nodeJobTaintKey(jobId), ...scopes).expire(
        nodeJobTaintKey(jobId),
        NODE_JOB_TAINT_TTL_SECONDS,
      )
    }
    await tx.exec()
  } catch (err) {
    log.warn({ err, connectionId }, "node job taint record failed")
  }
}

/**
 * Every scope the job's connection touched. Throws when the set cannot be
 * read, and when it is missing although the job bound a connection (expired
 * or lost): the caller falls back to the ceiling, never to a shorter set.
 */
export async function loadNodeJobTaint(jobId: string): Promise<string[]> {
  const members = await redis.smembers(nodeJobTaintKey(jobId))
  if (!members.includes(BOUND_MARK)) throw new Error("node job taint missing")
  return members.filter((m) => m !== BOUND_MARK)
}

export async function clearNodeJobTaint(jobId: string): Promise<void> {
  try {
    await redis.del(nodeJobTaintKey(jobId))
  } catch (err) {
    log.warn({ err, jobId }, "node job taint clear failed")
  }
}
