// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What an ORGANIZATION Drive connection already put in Knowledge, kept within
 * the shared drives an admin chose (drive-scope.ts).
 *
 * The shared-drives rule stops new reads, but a synced folder could hold
 * documents written while the org connection still read everything the
 * connecting account could see (its My Drive, drives nobody chose). Such content
 * must not stay searchable or readable:
 *
 *   - hidden at once (archived: every Knowledge read and search leaves archived
 *     rows out, and the archive event drops them from the search index) while
 *     the org connection has no shared drive chosen: at the org's first setup
 *     after an upgrade, at every sync of such a folder, and whenever an admin
 *     changes the chosen drives (then the folders sync again right away, which
 *     brings back exactly what the chosen drives hold);
 *   - deleted at the next sync once drives are chosen, for a folder that is not
 *     in one of them (its documents, links and the subcollections the sync made;
 *     the source stays, in error, saying why);
 *   - inside a folder of a chosen drive, the sync itself keeps only that drive's
 *     files (the listing is scoped) and archives the rest.
 *
 * Content synced through a PERSONAL Drive connection is never hidden or deleted
 * here: a folder is the org connection's only when the account it syncs from
 * resolves to the organization's (`gateDriveSourceSync` resolves it exactly; the
 * broader SQL match below only ever HIDES, and a folder hidden by mistake comes
 * back at its next sync).
 */
import { sql as drizzleSql } from "drizzle-orm"
import { driveSourceOwnerOf, resolveDriveAccess } from "~/apps/google-drive/drive-access"
import { PICKED_ROOT_REF } from "~/apps/google-drive/drive-mode"
import { DriveScopeError, makeDriveFetchers } from "~/apps/google-drive/drive-rest"
import { awaitsSharedDrives, sharedDrivesOf } from "~/apps/google-drive/drive-scope"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger } from "~/lib/logger"

const log = appsLogger.child({ module: "google-drive-org-content" })
const K = drizzleSql.raw(schemaRef("kernel"))

export const ORG_DRIVE_NOT_CHOSEN_REASON =
  "Hidden: this folder syncs through the organization's Google Drive connection, which shares no shared drive yet. An admin picks the shared drives the team should see; the folder then syncs again and shows what those drives hold."
export const ORG_DRIVE_RECHECK_REASON =
  "Hidden until the next sync: the organization's shared drives changed, so this folder is read again against them."
export const ORG_DRIVE_OUTSIDE_REASON =
  "Removed: this folder is not in a shared drive the organization's Google Drive connection shares, so its documents were deleted from Knowledge. Move it into a chosen shared drive, add its drive to the chosen ones, or remove this source."

function uuidArray(ids: string[]): ReturnType<typeof drizzleSql> {
  return drizzleSql`${`{${ids.join(",")}}`}::uuid[]`
}

export interface OrgDriveSource {
  id: string
  sourceAccount: string | null
}

/**
 * The org's active Drive folders that may sync through the organization Drive
 * account `identifier`: the folder records that account, or (an older folder)
 * records none while the org has such an account. A folder whose owner holds a
 * personal Drive account of the same address syncs through that one: left out.
 */
async function orgBackedSources(
  tx: Pick<PrivilegedDb, "execute">,
  orgId: string,
  identifier: string,
): Promise<OrgDriveSource[]> {
  return extractRows<{ id: string; source_account: string | null }>(
    await tx.execute(drizzleSql`
      SELECT ss.id::text AS id, ss.source_account
      FROM ${knowledgeRel("synced_sources")} ss
      WHERE ss.org_id = ${orgId}::uuid AND ss.app_name = 'google-drive' AND ss.archived_at IS NULL
        AND (ss.source_account IS NULL OR lower(ss.source_account) = lower(${identifier}))
        AND NOT EXISTS (
          SELECT 1 FROM ${K}.connected_accounts p
          WHERE p.org_id = ss.org_id AND p.app_name = 'google-drive' AND p.status = 'active'
            AND p.owner_type = 'user' AND p.owner_id = COALESCE(ss.owner_user_id, ss.created_by)
            AND (ss.source_account IS NULL OR lower(p.identifier) = lower(ss.source_account))
        )
    `),
  ).map((r) => ({ id: r.id, sourceAccount: r.source_account }))
}

/**
 * Hide what the folders hold (archive their documents and links, queue the
 * archive events the search indexer drops them on) and say why on each folder.
 * `due` makes the folders sync again at the next scheduler tick.
 */
export async function hideOrgDriveSourceContent(
  orgId: string,
  sourceIds: string[],
  reason: string,
  opts: { due: boolean },
): Promise<{ documents: number; sourceLinks: number }> {
  if (sourceIds.length === 0) return { documents: 0, sourceLinks: 0 }
  return withPrivilegedDb(orgId, "google-drive:hide-org-content", async (tx) => {
    const docs = extractRows<{ id: string; synced_source_id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("documents")}
        SET archived_at = now(), updated_at = now()
        WHERE org_id = ${orgId}::uuid AND synced_source_id = ANY(${uuidArray(sourceIds)})
          AND archived_at IS NULL
        RETURNING id::text AS id, synced_source_id::text AS synced_source_id
      `),
    )
    const links = extractRows<{ id: string; synced_source_id: string }>(
      await tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("source_links")}
        SET archived_at = now(), updated_at = now()
        WHERE org_id = ${orgId}::uuid AND synced_source_id = ANY(${uuidArray(sourceIds)})
          AND archived_at IS NULL
        RETURNING id::text AS id, synced_source_id::text AS synced_source_id
      `),
    )
    for (const [entity, rows] of [
      ["document", docs],
      ["source_link", links],
    ] as const) {
      for (const r of rows) {
        await tx.queueEvent({
          app: "knowledge",
          entity,
          action: "archive",
          entityId: r.id,
          data: { id: r.id, syncedSourceId: r.synced_source_id },
          actorId: "system",
          actorType: "system",
          orgId,
        })
      }
    }
    await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("synced_sources")}
      SET last_sync_status = 'error',
          last_error = ${reason},
          last_sync_at = ${opts.due ? drizzleSql`NULL` : drizzleSql`now()`},
          updated_at = now()
      WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidArray(sourceIds)})
        AND last_sync_status <> 'running'
    `)
    return { documents: docs.length, sourceLinks: links.length }
  })
}

/** The organization's active Drive accounts and the drives each shares. */
async function orgDriveAccounts(tx: Pick<PrivilegedDb, "execute">, orgId: string) {
  return extractRows<{ id: string; identifier: string; metadata: unknown }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, identifier, metadata FROM ${K}.connected_accounts
      WHERE org_id = ${orgId}::uuid AND app_name = 'google-drive' AND connection_name = 'drive'
        AND owner_type = 'org' AND status = 'active'
    `),
  )
}

/**
 * The org's setup after an upgrade (modules/apps/init.ts): the folders of an
 * org Drive connection with no shared drive chosen are hidden now; those of one
 * with drives chosen sync again now (the scoped sync keeps only what the chosen
 * drives hold, and removes a folder that is in none of them).
 */
export async function hideUnscopedOrgDriveContent(orgId: string): Promise<void> {
  const plan = await withPrivilegedDb(orgId, "google-drive:org-content-plan", async (tx) => {
    const out: Array<{ chosen: boolean; sources: OrgDriveSource[] }> = []
    for (const a of await orgDriveAccounts(tx, orgId)) {
      out.push({
        chosen: sharedDrivesOf(a.metadata).length > 0,
        sources: await orgBackedSources(tx, orgId, a.identifier),
      })
    }
    return out
  })
  const hide = plan.filter((p) => !p.chosen).flatMap((p) => p.sources.map((s) => s.id))
  const resync = plan.filter((p) => p.chosen).flatMap((p) => p.sources.map((s) => s.id))
  if (hide.length > 0) {
    const hidden = await hideOrgDriveSourceContent(orgId, hide, ORG_DRIVE_NOT_CHOSEN_REASON, {
      due: false,
    })
    log.info(
      { orgId, sources: hide.length, ...hidden },
      "org Drive content hidden: no shared drive",
    )
  }
  if (resync.length > 0) {
    await withPrivilegedDb(orgId, "google-drive:org-content-resync", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${knowledgeRel("synced_sources")} SET last_sync_at = NULL, updated_at = now()
        WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidArray(resync)})
          AND last_sync_status <> 'running'
      `),
    )
  }
}

/**
 * An admin changed the shared drives of the org account `identifier`: its
 * folders are hidden and sync again at the next tick against the new choice.
 */
export async function onOrgSharedDrivesChanged(orgId: string, identifier: string): Promise<void> {
  const sources = await withPrivilegedDb(orgId, "google-drive:org-content-changed", (tx) =>
    orgBackedSources(tx, orgId, identifier),
  )
  await hideOrgDriveSourceContent(
    orgId,
    sources.map((s) => s.id),
    ORG_DRIVE_RECHECK_REASON,
    { due: true },
  )
}

/** Delete what a folder outside the chosen drives holds; the source stays, saying why. */
async function removeOutsideFolderContent(orgId: string, sourceId: string): Promise<void> {
  const { deleteSyncedSourceContent, removeFromSearch } = await import(
    "~/apps/google-drive/disconnect"
  )
  const deleted = await withPrivilegedDb(
    orgId,
    "google-drive:remove-outside-folder",
    async (tx) => {
      const removed = await deleteSyncedSourceContent(
        tx,
        orgId,
        [{ id: sourceId, root_collection_id: null }],
        { keepSources: true },
      )
      await tx.execute(drizzleSql`
      UPDATE ${knowledgeRel("synced_sources")}
      SET last_sync_status = 'error', last_error = ${ORG_DRIVE_OUTSIDE_REASON},
          last_sync_at = now(), updated_at = now()
      WHERE org_id = ${orgId}::uuid AND id = ${sourceId}::uuid
    `)
      return removed
    },
  )
  try {
    await removeFromSearch(orgId, deleted)
  } catch (err) {
    log.warn({ orgId, sourceId, err }, "could not queue search removals; a reindex drops them")
  }
  log.info(
    {
      orgId,
      sourceId,
      documents: deleted.documentIds.length,
      sourceLinks: deleted.sourceLinkIds.length,
    },
    "org Drive folder outside the chosen shared drives: its content was deleted",
  )
}

/**
 * Before a Drive folder syncs: "skip" when it syncs through an organization
 * connection that shares no drive yet (its content is hidden) or when the
 * folder is in none of the chosen drives (its content is deleted); "sync"
 * otherwise, including every personal connection and any lookup failure (the
 * sync then reports it as before).
 */
export async function gateDriveSourceSync(source: {
  id: string
  orgId: string
  folderRef: string
  ownerUserId: string | null
  createdBy: string
  sourceAccount?: string | null
}): Promise<"sync" | "skip"> {
  let access: Awaited<ReturnType<typeof resolveDriveAccess>>
  try {
    access = await withSystemDb("knowledge-sync-drive-gate", (db) =>
      resolveDriveAccess(db, source.orgId, source.ownerUserId ?? source.createdBy, {
        ...(source.sourceAccount ? { identifier: source.sourceAccount } : {}),
        sourceOwner: driveSourceOwnerOf(source),
      }),
    )
  } catch {
    return "sync"
  }
  if (access.ownerType !== "org") return "sync"
  if (awaitsSharedDrives(access.readScope)) {
    await hideOrgDriveSourceContent(source.orgId, [source.id], ORG_DRIVE_NOT_CHOSEN_REASON, {
      due: false,
    })
    return "skip"
  }
  if (source.folderRef === PICKED_ROOT_REF) return "sync"
  try {
    await makeDriveFetchers(async () => access).getMetadata({ id: source.folderRef })
  } catch (err) {
    if (err instanceof DriveScopeError && err.code === "OUTSIDE_SHARED_DRIVES") {
      await removeOutsideFolderContent(source.orgId, source.id)
      return "skip"
    }
    return "sync"
  }
  return "sync"
}
