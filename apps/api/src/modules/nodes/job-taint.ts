// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT A NODE JOB'S RESULT MAY BE QUOTING (A18, A50/F6, S11).
 *
 * Bounded like a locally run reply (`localReplyScope`): what Liaison handed
 * the job besides its tool calls (the agent's definition and the conversation,
 * `localContextScopes`) is always in; unreadable, the conservative effective
 * scope (room floor intersected with the agent's ceiling) stands in, and every
 * other input that cannot be read falls back to the agent's ceiling, never to
 * a shorter set. Never the effective scope by default: for an admin whose
 * agent's ceiling is `*` it is `*`, and history carried that into every later
 * cloud turn of the conversation. Then:
 *
 * - THE JOB'S OWN TAINT, when the job bound its MCP connection: every scope
 *   that connection's calls touched while it ran this job, for the job's
 *   whole life (`job-taint-store.ts`). Not the agent's 15 minute window,
 *   which forgets a long job's early reads and adds another conversation's.
 * - Without a bound connection (a job with no Liaison tools, or a node that
 *   did not say which connection it uses), the agent's window since the job
 *   started, exactly as a local reply is tagged.
 * - Always the job's `sourceRequiredScopes` (A18): the triggering content's
 *   scopes, which the prompt carries to the node whether or not a tool runs.
 *
 * Never taken from the client.
 */
import { withPrivilegedDb } from "~/db/privileged"
import { rootLogger } from "~/lib/logger"
import { localContextScopes } from "~/modules/agent/local-sessions/local-context-scopes"
import { localReplyScope } from "~/modules/agent/local-sessions/local-session-routes"
import { computeEffectiveScopeForTurn } from "~/modules/agent/scopes/effective-scope"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { projectTaintScopesForOrg } from "~/modules/agent/scopes/taint-read-scopes"
import { loadNodeJobTaint } from "./job-taint-store"
import type { NodeJobRow } from "./jobs"

const log = rootLogger.child({ module: "node-job-taint" })

const union = (orgId: string, ...sets: ReadonlyArray<readonly string[]>) =>
  projectTaintScopesForOrg(
    [...new Set(sets.flat())].filter((s) => !UNKNOWN_TURN_TAINT.includes(s)),
    orgId,
  ).sort()

export async function nodeJobReplyScope(job: NodeJobRow, ceiling: string[]): Promise<string[]> {
  const source = job.sourceRequiredScopes ?? []
  const threadId = job.threadId
  // An app job has no conversation (D32): nothing narrower than the ceiling.
  if (!threadId) return union(job.orgId, ceiling, source)

  if (!job.mcpConnectionId) {
    const turnStartedAt = job.startedAt ?? job.claimedAt ?? null
    const base = await localReplyScope(
      job.orgId,
      threadId,
      job.ownerUserId,
      ceiling,
      job.agentId,
      turnStartedAt,
      "node",
    )
    return union(job.orgId, base, source)
  }

  // The fallback bound, computed only when something cannot be read.
  const effectiveScope = async (): Promise<string[]> => {
    try {
      const { effectiveScope } = await withPrivilegedDb(job.orgId, "node-job-reply-scope", (tx) =>
        computeEffectiveScopeForTurn(tx, job.orgId, threadId, job.ownerUserId, ceiling),
      )
      return effectiveScope
    } catch (err) {
      log.warn({ err, jobId: job.id }, "node job effective scope failed, tagging with the ceiling")
      return ceiling
    }
  }

  // What Liaison handed the job besides its tool calls (local-context-scopes.ts).
  const context =
    (await localContextScopes({
      orgId: job.orgId,
      threadId,
      holderUserId: job.ownerUserId,
      agentId: job.agentId,
      runtime: "node",
    })) ?? (await effectiveScope())

  let taint: string[]
  try {
    taint = await loadNodeJobTaint(job.id)
  } catch (err) {
    log.warn({ err, jobId: job.id }, "node job taint unreadable, tagging with the ceiling")
    return union(job.orgId, context, await effectiveScope(), ceiling, source)
  }
  if (taint.some((s) => UNKNOWN_TURN_TAINT.includes(s))) {
    return union(job.orgId, context, await effectiveScope(), ceiling, source)
  }
  return union(job.orgId, context, taint, source)
}
