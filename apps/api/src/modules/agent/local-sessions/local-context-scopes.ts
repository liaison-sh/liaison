// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * WHAT LIAISON HANDED A LOCAL OR NODE TURN (S11, rule 5; spec-node A18/A50).
 *
 * A turn that runs on someone's machine reads Liaison data through exactly three doors, all of
 * them on this server:
 *
 *   1. its Liaison tool calls, through the agent bound MCP path, which records every scope they
 *      touch (`saveConnectionTurnTaint` and its marks, or the node job's own taint);
 *   2. the agent's definition (`GET /api/agents/:id/definition` -> `composeAgentDefinition`):
 *      the persona plus the memory and skill rows it injects, each with its requiredScopes;
 *   3. the conversation (`turn-context`): the thread's messages and the agent's checkpoint
 *      summary of it, and on a cold resume the recall block, whose scopes that route records
 *      (`recordLocalRecallScopes`) because the hits depend on the moment it ran.
 *
 * This module answers 2 and 3. The caller unions 1. That union is what the turn could have
 * read from Liaison, so it is the reply's stamp: nothing the machine did elsewhere (its own
 * files, the web) is Liaison data under any scope.
 *
 * It replaces stamping the turn's whole effective scope. For an admin talking to an agent
 * whose ceiling is `*`, that effective scope is `*` itself: every local or node reply in a DM
 * then required `*`, history carried it into every later cloud turn of the conversation, and
 * every write whose readers were not all admins was refused.
 *
 * Each part is a SUPERSET of what was actually handed over, never a guess at less: every
 * message of the thread the holder may read (not only the bounded tail), every checkpoint
 * version, every recall ever handed for this conversation to this agent. Over-counting only
 * narrows who sees the reply. Any lookup that fails answers `null`, and the caller falls back
 * to the conservative effective-scope bound.
 */
import { and, eq, isNull } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agentThreadCheckpoints, auditLog, messages } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { composeAgentDefinition } from "~/modules/agent/context/context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { writeAuditLog } from "~/modules/audit/service"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "local-context-scopes" })

/** The audit action under which a cold resume's recall scopes are kept for the conversation. */
export const LOCAL_CONTEXT_RECALL = "agent.local_session.recall"

/**
 * Keep the scopes of a recall block the turn-context route handed to a local session. Written
 * as a REQUIRED audit row: if it cannot be kept the route fails and the desktop resumes warm
 * without the recall, rather than receiving data the reply could not be stamped with.
 */
export async function recordLocalRecallScopes(opts: {
  orgId: string
  threadId: string
  agentId: string
  userId: string
  injectedScopes: readonly (readonly string[])[]
}): Promise<void> {
  const scopes = [...new Set(opts.injectedScopes.flat())].sort()
  if (scopes.length === 0) return
  // No bypass needed to keep it: the system audit context inserts the row
  // bound to this org (audit_log_insert_rls).
  await withRlsContext({ actorType: "system", orgId: opts.orgId, purpose: "audit" }, (tx) =>
    writeAuditLog(
      tx,
      {
        orgId: opts.orgId,
        actorId: opts.userId,
        actorType: "user",
        app: "kernel",
        entityType: "thread",
        entityId: opts.threadId,
        action: LOCAL_CONTEXT_RECALL,
        agentId: opts.agentId,
        metadata: { requiredScopes: scopes },
      },
      { required: true },
    ),
  )
}

/**
 * Every scope the definition and the conversation could have carried into a local or node
 * turn of `agentId` in `threadId`, read as `holderUserId`. Null when any part cannot be read.
 */
export async function localContextScopes(opts: {
  orgId: string
  threadId: string
  holderUserId: string
  agentId: string
  runtime: "local" | "node"
}): Promise<string[] | null> {
  const { orgId, threadId, holderUserId, agentId } = opts
  try {
    const perms = await withPrivilegedDb(orgId, "local-context-scopes-perms", (tx) =>
      loadEffectivePermissions(tx, holderUserId, orgId),
    )
    const actor = {
      actorType: "user" as const,
      userId: holderUserId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants ?? {},
    }
    const out = new Set<string>()

    // The conversation: every message the holder may read (the turn-context route reads under
    // the same RLS), and every checkpoint summary this agent keeps of it.
    const rows = await withRlsContext(actor, (tx) =>
      tx
        .select({ requiredScopes: messages.requiredScopes })
        .from(messages)
        .where(
          and(
            eq(messages.threadId, threadId),
            eq(messages.orgId, orgId),
            isNull(messages.deletedAt),
          ),
        ),
    )
    for (const row of rows) for (const s of row.requiredScopes ?? []) out.add(s)
    const checkpoints = await withPrivilegedDb(orgId, "local-context-scopes-checkpoints", (tx) =>
      tx
        .select({ requiredScopes: agentThreadCheckpoints.requiredScopes })
        .from(agentThreadCheckpoints)
        .where(
          and(
            eq(agentThreadCheckpoints.orgId, orgId),
            eq(agentThreadCheckpoints.threadId, threadId),
            eq(agentThreadCheckpoints.agentId, agentId),
          ),
        ),
    )
    for (const row of checkpoints) for (const s of row.requiredScopes) out.add(s)

    // Recall blocks handed on cold resumes of this conversation.
    const recalls = await withPrivilegedDb(orgId, "local-context-scopes-recall", (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.orgId, orgId),
            eq(auditLog.entityType, "thread"),
            eq(auditLog.entityId, threadId),
            eq(auditLog.action, LOCAL_CONTEXT_RECALL),
            eq(auditLog.agentId, agentId),
          ),
        ),
    )
    for (const row of recalls) {
      const scopes = (row.metadata as { requiredScopes?: unknown } | null)?.requiredScopes
      if (!Array.isArray(scopes)) return null
      for (const s of scopes) if (typeof s === "string") out.add(s)
    }

    // The definition: what composing it injects is recorded exactly as a cloud turn's is.
    const accumulator = createTurnScopeAccumulator({ orgId })
    await composeAgentDefinition({
      agentId,
      requestingActor: actor,
      orgId,
      runtime: opts.runtime,
      turnScopeAccumulator: accumulator,
    })
    for (const s of accumulator.snapshot()) out.add(s)

    return [...out].sort()
  } catch (err) {
    log.warn({ err, threadId, agentId }, "local turn context scopes unreadable")
    return null
  }
}
