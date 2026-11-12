// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Disconnecting an app's connected account deletes the Knowledge content the
// app synced only because of it (`knowledge_appSource` op `purgeAccount`, run
// by the app's disconnect subscriber):
//
//   - the app's synced sources whose sync runs on the disconnected account
//     (`synced_sources.source_account`), with the documents and source links
//     materialised from them, their collection memberships and taggings, the
//     subcollections the sync created, and their search documents;
//   - once no connection of the app is left in the org, its cached content
//     (`content_cache_entries` of its source identities).
//
// Kept: files a person explicitly imported, documents a person wrote, links a
// person added by hand. A re-authorization (a new active connection of the same
// account for the same owner) keeps everything.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"

const K = drizzleSql.raw(schemaRef("kernel"))

function knowledgeRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("app_knowledge")}.${name}`)
}

function uuidArray(ids: string[]): ReturnType<typeof drizzleSql> {
  return drizzleSql`${`{${ids.join(",")}}`}::uuid[]`
}

export interface AccountPurgeResult {
  /** The owner still holds an active connection of the account: nothing deleted. */
  kept: boolean
  syncedSources: number
  documents: number
  sourceLinks: number
  cacheEntries: number
  documentIds: string[]
  sourceLinkIds: string[]
}

const EMPTY: AccountPurgeResult = {
  kept: false,
  syncedSources: 0,
  documents: 0,
  sourceLinks: 0,
  cacheEntries: 0,
  documentIds: [],
  sourceLinkIds: [],
}

/**
 * Delete what synced sources materialised: their documents and source links
 * (with collection memberships and taggings), the subcollections the sync
 * created, and, unless `keepSources`, the sources and their root collections.
 * A collection still holding something a user put there stays. Search removal
 * is the caller's (`removeFromSearch`, after the commit).
 */
export async function deleteSyncedSourceContent(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
  sources: Array<{ id: string; root_collection_id: string | null }>,
  opts: { keepSources: boolean },
): Promise<{ documentIds: string[]; sourceLinkIds: string[] }> {
  const sourceIds = sources.map((s) => s.id)
  if (sourceIds.length === 0) return { documentIds: [], sourceLinkIds: [] }
  const documentIds = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${knowledgeRel("documents")}
      WHERE org_id = ${orgId}::uuid AND synced_source_id = ANY(${uuidArray(sourceIds)})
    `),
  ).map((r) => r.id)
  const sourceLinkIds = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${knowledgeRel("source_links")}
      WHERE org_id = ${orgId}::uuid AND synced_source_id = ANY(${uuidArray(sourceIds)})
    `),
  ).map((r) => r.id)
  const targets = [...documentIds, ...sourceLinkIds]
  if (targets.length > 0) {
    await tx.execute(drizzleSql`
      DELETE FROM ${knowledgeRel("collection_memberships")}
      WHERE org_id = ${orgId}::uuid AND target_id = ANY(${uuidArray(targets)})
    `)
    await tx.execute(drizzleSql`
      DELETE FROM ${knowledgeRel("taggings")}
      WHERE org_id = ${orgId}::uuid AND target_id = ANY(${uuidArray(targets)})
    `)
  }
  if (sourceLinkIds.length > 0) {
    await tx.execute(drizzleSql`
      DELETE FROM ${knowledgeRel("source_links")}
      WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidArray(sourceLinkIds)})
    `)
  }
  if (documentIds.length > 0) {
    await tx.execute(drizzleSql`
      DELETE FROM ${knowledgeRel("documents")}
      WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidArray(documentIds)})
    `)
  }
  if (!opts.keepSources) {
    await tx.execute(drizzleSql`
      DELETE FROM ${knowledgeRel("synced_sources")}
      WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidArray(sourceIds)})
    `)
  }
  // The collections the sync created: the subcollections it marks
  // `synced:<sourceId>:...` and, with the sources, their roots (mount points).
  
  const roots = opts.keepSources
    ? []
    : sources.map((s) => s.root_collection_id).filter((id): id is string => !!id)
  const marker = drizzleSql.join(
    sourceIds.map((id) => drizzleSql`c.description LIKE ${`synced:${id}:%`}`),
    drizzleSql` OR `,
  )
  // Leaves first: a collection goes once it holds nothing and has no child left.
  for (let pass = 0; pass < 32; pass++) {
    const gone = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${knowledgeRel("collections")} c
        WHERE c.org_id = ${orgId}::uuid
          AND (${marker} OR c.id = ANY(${uuidArray(roots)}))
          AND NOT EXISTS (
            SELECT 1 FROM ${knowledgeRel("collection_memberships")} cm
            WHERE cm.collection_id = c.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${knowledgeRel("collections")} child
            WHERE child.parent_collection_id = c.id
          )
        RETURNING c.id::text AS id
      `),
    )
    if (gone.length === 0) break
  }
  return { documentIds, sourceLinkIds }
}

/**
 * Delete the content an app synced through one disconnected connection, in `tx`.
 * Everything is read from the kernel row by its id: the row must be a
 * connection of this app in this org that is disconnected.
 *
 * A synced source belongs to the ACCOUNT it syncs from (`source_account`):
 * disconnecting one of a person's two accounts deletes only that account's
 * sources. While the same owner still holds an active connection of the account
 * (a re-authorization), nothing is deleted. One account may hold an organization
 * row and a member's personal row: a source of the disconnected row's kind goes
 * with it; a source of the other kind stays while a row it may still read
 * through is active. A source added before the account was recorded goes with
 * its owner's last connection of the app.
 */
export async function purgeAccountSources(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
  appName: string,
  connectionId: string,
): Promise<AccountPurgeResult> {
  const conn = extractRows<{
    owner_type: string
    owner_id: string | null
    identifier: string
    status: string
  }>(
    await tx.execute(drizzleSql`
      SELECT owner_type, owner_id::text AS owner_id, identifier, status
      FROM ${K}.connected_accounts
      WHERE org_id = ${orgId}::uuid AND id = ${connectionId}::uuid AND app_name = ${appName}
    `),
  )[0]
  if (!conn || conn.status !== "disconnected") return { ...EMPTY, kept: true }

  const activeOfApp = async (filter: ReturnType<typeof drizzleSql>) =>
    extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM ${K}.connected_accounts
        WHERE org_id = ${orgId}::uuid AND app_name = ${appName} AND status = 'active'
          ${filter}
      `),
    )[0]?.n ?? 0

  const ownerUserId = conn.owner_type === "user" ? conn.owner_id : null
  const sameOwner =
    ownerUserId != null
      ? drizzleSql`AND owner_type = 'user' AND owner_id = ${ownerUserId}::uuid`
      : drizzleSql`AND owner_type = 'org'`
  if (
    (await activeOfApp(
      drizzleSql`AND lower(identifier) = lower(${conn.identifier}) ${sameOwner}`,
    )) > 0
  ) {
    return { ...EMPTY, kept: true }
  }
  // A folder of the disconnected row's own kind: an org folder for the org's
  // row, the owner's personal folder for a personal row.
  const ownKind =
    ownerUserId != null
      ? drizzleSql`s.owner_user_id = ${ownerUserId}::uuid`
      : drizzleSql`s.owner_user_id IS NULL`
  // Legacy folders (no recorded account) sync on their owner's newest connection:
  // they go only with that owner's last connection.
  const ownerHasConnection =
    ownerUserId != null &&
    (await activeOfApp(drizzleSql`AND owner_type = 'user' AND owner_id = ${ownerUserId}::uuid`)) > 0
  const legacy =
    ownerUserId && !ownerHasConnection
      ? drizzleSql`OR (source_account IS NULL AND COALESCE(owner_user_id, created_by) = ${ownerUserId}::uuid)`
      : drizzleSql``

  const result: AccountPurgeResult = { ...EMPTY, documentIds: [], sourceLinkIds: [] }

  {
    const sources = extractRows<{ id: string; root_collection_id: string | null }>(
      await tx.execute(drizzleSql`
        SELECT s.id::text AS id, s.root_collection_id::text AS root_collection_id
        FROM ${knowledgeRel("synced_sources")} s
        WHERE s.org_id = ${orgId}::uuid AND s.app_name = ${appName}
          AND (
            (lower(s.source_account) = lower(${conn.identifier})
              AND (${ownKind} OR NOT EXISTS (
                SELECT 1 FROM ${K}.connected_accounts ca
                WHERE ca.org_id = ${orgId}::uuid AND ca.app_name = ${appName}
                  AND ca.status = 'active' AND lower(ca.identifier) = lower(${conn.identifier})
                  AND (ca.owner_type = 'org' OR (ca.owner_type = 'user'
                    AND ca.owner_id = COALESCE(s.owner_user_id, s.created_by)))
              )))
            ${legacy}
          )
      `),
    )
    if (sources.length > 0) {
      const deleted = await deleteSyncedSourceContent(tx, orgId, sources, { keepSources: false })
      result.documentIds = deleted.documentIds
      result.sourceLinkIds = deleted.sourceLinkIds
      result.syncedSources = sources.length
      result.documents = result.documentIds.length
      result.sourceLinks = result.sourceLinkIds.length
    }
  }

  // Cached content is shared by the org's connections: it goes with the last one.
  if ((await activeOfApp(drizzleSql``)) === 0) {
    result.cacheEntries = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${knowledgeRel("content_cache_entries")} cce
        USING ${knowledgeRel("source_identities")} si
        WHERE cce.org_id = ${orgId}::uuid AND si.org_id = ${orgId}::uuid
          AND cce.source_identity_id = si.id AND si.source = ${appName}
        RETURNING cce.id::text AS id
      `),
    ).length
  }
  return result
}

/** Remove the deleted (or hidden) documents and links from search, after the commit. */
export async function removeFromSearch(
  orgId: string,
  result: Pick<AccountPurgeResult, "documentIds" | "sourceLinkIds">,
): Promise<void> {
  if (result.documentIds.length === 0 && result.sourceLinkIds.length === 0) return
  const [{ recordLiveIndex }, { entityLiveIndexItem }, { collectSearchableRegistrations }] =
    await Promise.all([
      import("~/modules/search/live-index-queue"),
      import("~/modules/search/indexer"),
      import("~/modules/search/searchable-entities"),
    ])
  const regs = collectSearchableRegistrations(orgId).entities
  const typeOf = (table: string) =>
    regs.find((e) => e.app === "knowledge" && e.tableName === table)?.entityType ?? null
  const items = []
  for (const [table, ids] of [
    ["documents", result.documentIds],
    ["source_links", result.sourceLinkIds],
  ] as const) {
    const entityType = typeOf(table)
    if (!entityType) continue
    for (const entityId of ids) {
      items.push(
        entityLiveIndexItem({ action: "delete", orgId, app: "knowledge", entityType, entityId }),
      )
    }
  }
  for (let i = 0; i < items.length; i += 1000) await recordLiveIndex(items.slice(i, i + 1000))
}

/** Purge for the bridge: the content of the app's sources a disconnected account synced. */
export async function purgeDisconnectedAccount(
  orgId: string,
  appName: string,
  connectionId: string,
): Promise<Omit<AccountPurgeResult, "documentIds" | "sourceLinkIds">> {
  const result = await withPrivilegedDb(orgId, `${appName}:purge-on-disconnect`, (tx) =>
    purgeAccountSources(tx, orgId, appName, connectionId),
  )
  if (!result.kept) {
    try {
      await removeFromSearch(orgId, result)
    } catch (err) {
      log.warn(
        { orgId, appName, err: (err as Error).message },
        "disconnect: could not queue the search removals; a reindex drops them",
      )
    }
  }
  const { documentIds: _d, sourceLinkIds: _s, ...summary } = result
  log.info({ orgId, appName, ...summary }, "disconnect: synced content of the account deleted")
  return summary
}
