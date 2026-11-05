// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent turn factory: finished turns of the turn ledger (`kernel.agent_turns`),
// what an agent did in a thread, a routine run or a sub run.
//
// Privileged raw insert, by category: history. The ledger is written by the
// running turn itself (`runtime/turn-ledger.ts`) while a model answers; a turn
// that finished days ago has no other writer. Rows are written in the ledger's
// own terminal shape (state `done` or `failed`, a heartbeat at the finish)
// under a deterministic id, so a re-run rewrites its own rows and nothing else.

import { withPrivilegedDb } from "~/db/privileged"
import { agentTurns } from "~/db/schema/kernel/agent-turns"
import type { SeedContext } from "~/seed/context"

/** The runner name a seeded turn carries, so no live runner ever claims it. */
export const SEEDED_TURN_RUNNER = "seed"

export interface AgentTurnSeed {
  key: string
  threadId: string
  agentId: string
  origin: "chat" | "thread" | "routine" | "subrun"
  /** The person's message the turn answered, when there is one. */
  userMessageId?: string | null
  /** The agent's reply message, when it wrote one. */
  agentMessageId?: string | null
  /** The routine run or sub run the turn belongs to. */
  runId?: string | null
  startedAt: Date
  finishedAt: Date
  steps: number
  failed?: boolean
}

export async function seedAgentTurns(
  ctx: SeedContext,
  turns: readonly AgentTurnSeed[],
): Promise<string[]> {
  if (turns.length === 0) return []
  const rows = turns.map((t) => ({
    id: ctx.id("agent-turn", t.key),
    orgId: ctx.orgId,
    threadId: t.threadId,
    agentId: t.agentId,
    origin: t.origin,
    userMessageId: t.userMessageId ?? null,
    runId: t.runId ?? null,
    state: (t.failed ? "failed" : "done") as "failed" | "done",
    runnerInstanceId: SEEDED_TURN_RUNNER,
    stepCount: t.steps,
    agentMessageId: t.agentMessageId ?? null,
    errorCode: t.failed ? "tool_error" : null,
    failureReason: (t.failed ? "turn" : null) as "turn" | null,
    heartbeatAt: t.finishedAt,
    createdAt: t.startedAt,
    updatedAt: t.finishedAt,
    finishedAt: t.finishedAt,
  }))
  await withPrivilegedDb(ctx.orgId, "seed-agent-turns", async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200)
      await tx.insert(agentTurns).values(chunk).onConflictDoNothing({ target: agentTurns.id })
    }
  })
  return rows.map((r) => r.id)
}
