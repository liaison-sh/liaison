// SPDX-License-Identifier: FSL-1.1-ALv2
import { type KnowledgeActor, knowledgeActorFromContext } from "~/apps/knowledge/service"
import type { SyncedSourceRow } from "~/apps/knowledge/synced-sources"

/**
 * Build a privileged KnowledgeActor for the reconciler.
 *
 * - org-shared source: full read scopes within the org. Writes happen via
 *   withPrivilegedDb so RLS WITH CHECK is bypassed; the actor is only used
 *   for adapter callbacks that may consult it.
 * - personal source: actor identity is the source owner. The reconciler
 *   still writes under privileged db, but adapter calls (which exercise
 *   that user's OAuth credentials) need the owner's userId.
 */
export function systemSyncActor(source: SyncedSourceRow): KnowledgeActor {
  const userId = source.ownerUserId ?? source.createdBy
  return knowledgeActorFromContext({
    orgId: source.orgId,
    userId,
    scopes: [
      "knowledge:documents:read",
      "knowledge:documents:create",
      "knowledge:documents:update",
      "knowledge:sources:read",
      "knowledge:sources:manage",
      "knowledge:collections:manage",
    ],
    dimensionGrants: {},
  })
}
