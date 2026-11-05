// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sub run factory: work an agent handed to a sub agent role
// (`kernel.agent_runs`), each with the hidden thread the sub agent worked in,
// as `spawn-agent.ts` persists them.
//
// Privileged raw insert, by category: history. A finished sub run is written
// by the spawn (the queued row and its hidden thread, in one privileged
// transaction) and then by the run itself; a run that finished last week has
// no other writer. The hidden thread goes through the spawn's own helper
// (`insertSubrunThread`), so it has the shape a real spawn gives it. Deterministic ids for the run and its hidden thread, so a
// re-run rewrites nothing.
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { agentRuns } from "~/db/schema/kernel/sub-agent-runs"
import { insertSubrunThread } from "~/modules/agent/subruns/subrun-thread"
import type { SeedContext } from "~/seed/context"

export interface SubRunSeed {
  key: string
  /** The conversation the sub run was spawned from. */
  parentThreadId: string
  /** The agent whose turn spawned it. */
  agentId: string
  /** The person that turn acted for, as the run records its actor. */
  requester: UserContext
  subagentType: string
  prompt: string
  summary: string
  startedAt: Date
  durationMs: number
  failed?: boolean
  promptTokens: number
  completionTokens: number
}

export async function seedSubRuns(
  ctx: SeedContext,
  runs: readonly SubRunSeed[],
): Promise<string[]> {
  if (runs.length === 0) return []
  const ids: string[] = []
  await withPrivilegedDb(ctx.orgId, "seed-sub-runs", async (tx) => {
    for (const r of runs) {
      const runId = ctx.id("sub-run", r.key)
      const threadId = ctx.id("sub-run-thread", r.key)
      const finishedAt = new Date(r.startedAt.getTime() + r.durationMs)
      await insertSubrunThread(tx, {
        id: threadId,
        orgId: ctx.orgId,
        subagentType: r.subagentType,
        description: r.prompt,
        createdBy: r.requester.userId,
        createdAt: r.startedAt,
        updatedAt: finishedAt,
      })
      await tx
        .insert(agentRuns)
        .values({
          id: runId,
          orgId: ctx.orgId,
          parentRunId: null,
          rootRunId: runId,
          threadId,
          parentThreadId: r.parentThreadId,
          agentId: r.agentId,
          subagentType: r.subagentType,
          actor: r.requester,
          effectiveScopes: r.requester.scopes,
          status: r.failed ? "failed" : "done",
          prompt: r.prompt,
          summary: r.summary,
          output: r.failed ? null : { summary: r.summary },
          errorCode: r.failed ? "timeout" : null,
          errorMessage: r.failed ? "The sub agent ran out of time before it finished." : null,
          usagePromptTokens: r.promptTokens,
          usageCompletionTokens: r.completionTokens,
          maxSteps: 12,
          timeoutMs: 300_000,
          schemaRetryBudget: 0,
          attemptCount: 1,
          startedAt: r.startedAt,
          finishedAt,
          createdAt: r.startedAt,
        })
        .onConflictDoNothing({ target: agentRuns.id })
      ids.push(runId)
    }
  })
  return ids
}
