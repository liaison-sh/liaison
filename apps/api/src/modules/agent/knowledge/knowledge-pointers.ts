// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Kernel-maintained `kernel.agent_knowledge_pointers` maintenance.
 *
 * The table records which Knowledge collections an agent has been pointed at,
 * and it is what the agent page's Knowledge tab lists (P4c-T32,
 * `modules/agent/directory/definition-routes.ts`). The migration seeds the
 * roster's pointers once (spec-agents.md, "The migration" step 5); this module
 * is the LIVE write path spec-agents.md calls for ("writable only by the skill
 * and knowledge mutation paths"), so a collection an agent actually writes into
 * afterwards shows up on its page instead of leaving the tab permanently empty.
 *
 * A pointer is recorded when an AGENT's knowledge tool call creates a document
 * in a collection, edits a document that lives in one, or files a document into
 * one. A human's own knowledge write records nothing: the pointer says which
 * collections an AGENT works in.
 *
 * `agent_knowledge_pointers` has no INSERT/UPDATE/DELETE RLS policy at all
 * (migration 0050), so every write here goes through the privileged (BYPASSRLS)
 * connection by construction; there is no other write path.
 */
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agentKnowledgePointers } from "~/db/schema/kernel/agent-knowledge-pointers"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "agent-knowledge-pointers" })

/**
 * Upsert one pointer row per collection. No-ops when no agent is acting (a
 * human request, a job, a cron or a webhook has no acting agent) or when the
 * write touched no collection.
 *
 * Best effort by design: a pointer is a navigational breadcrumb, so a failure
 * to record one must never fail the knowledge write that produced it.
 */
export async function recordAgentKnowledgePointers(params: {
  orgId: string
  agentId: string | null
  collectionIds: readonly (string | null | undefined)[]
}): Promise<void> {
  if (!params.agentId) return
  const collectionIds = [
    ...new Set(
      params.collectionIds.filter((id): id is string => typeof id === "string" && id !== ""),
    ),
  ]
  if (collectionIds.length === 0) return
  const agentId = params.agentId
  try {
    await withPrivilegedDb(params.orgId, "record-agent-knowledge-pointers", (tx) =>
      tx
        .insert(agentKnowledgePointers)
        .values(
          collectionIds.map((collectionId) => ({
            orgId: params.orgId,
            agentId,
            collectionId,
          })),
        )
        .onConflictDoNothing({
          target: [agentKnowledgePointers.agentId, agentKnowledgePointers.collectionId],
        }),
    )
  } catch (err) {
    log.warn(
      { err, orgId: params.orgId, agentId, collectionIds },
      "could not record agent knowledge pointers",
    )
  }
}

/**
 * The same, for a write that names a DOCUMENT rather than a collection (an
 * update): the document's own collection memberships are the collections the
 * agent just worked in.
 */
export async function recordAgentKnowledgePointersForDocument(params: {
  orgId: string
  agentId: string | null
  documentId: string | null | undefined
}): Promise<void> {
  if (!params.agentId || !params.documentId) return
  let collectionIds: string[] = []
  try {
    const rows = await withPrivilegedDb(params.orgId, "read-document-collections", (tx) =>
      tx.execute(drizzleSql`
        SELECT collection_id FROM ${drizzleSql.raw(schemaRef("app_knowledge"))}.collection_memberships
        WHERE org_id = ${params.orgId}::uuid
          AND target_type = 'document'
          AND target_id = ${params.documentId}::uuid
      `),
    )
    collectionIds = extractRows<{ collection_id: string }>(rows).map((r) => r.collection_id)
  } catch (err) {
    log.warn(
      { err, orgId: params.orgId, documentId: params.documentId },
      "could not read the document's collections for its agent knowledge pointers",
    )
    return
  }
  await recordAgentKnowledgePointers({
    orgId: params.orgId,
    agentId: params.agentId,
    collectionIds,
  })
}
