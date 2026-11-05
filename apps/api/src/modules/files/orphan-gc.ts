// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const K = sql.raw(schemaRef("kernel"))

import { registerScheduledJob } from "~/infra/jobs/jobs"
import {
  deleteObjects as defaultDeleteObjects,
  listOrgPrefixIter as defaultListOrgPrefixIter,
  type ListedObject,
} from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import { movingOrgIds } from "~/modules/org/transfer-state/state"

const GRACE_WINDOW_MS = 24 * 60 * 60 * 1000
const DELETE_BATCH_SIZE = 500

export interface CollectOptions {
  now?: Date
  listOrgPrefixIter?: (args: { orgId: string }) => AsyncIterable<ListedObject>
}

export async function collectOrphanKeysForOrg(
  orgId: string,
  referencedKeys: Set<string>,
  opts: CollectOptions = {},
): Promise<string[]> {
  const now = opts.now ?? new Date()
  const cutoff = now.getTime() - GRACE_WINDOW_MS
  const lister = opts.listOrgPrefixIter ?? defaultListOrgPrefixIter
  const orphans: string[] = []
  for await (const obj of lister({ orgId })) {
    if (!obj.Key) continue
    if (referencedKeys.has(obj.Key)) continue
    const age = obj.LastModified?.getTime?.() ?? 0
    if (age >= cutoff) continue
    orphans.push(obj.Key)
  }
  return orphans
}

export interface OrphanGcDeps {
  privileged?: <T>(
    orgId: string,
    reason: string,
    fn: (tx: PrivilegedDb) => Promise<T>,
  ) => Promise<T>
  deleteObjects?: typeof defaultDeleteObjects
  listOrgPrefixIter?: (args: { orgId: string }) => AsyncIterable<ListedObject>
  now?: Date
}

export async function loadReferencedKeysForOrg(
  tx: PrivilegedDb,
  orgId: string,
): Promise<Set<string>> {
  const rows = await tx.execute<{ storage_key: string; thumbnail_key: string | null }>(
    sql`SELECT storage_key, thumbnail_key FROM ${K}.files WHERE org_id = ${orgId}`,
  )
  const set = new Set<string>()
  for (const r of rows as unknown as { storage_key: string; thumbnail_key: string | null }[]) {
    if (r.storage_key) set.add(r.storage_key)
    if (r.thumbnail_key) set.add(r.thumbnail_key)
  }
  // Whole-org export archives (`orgs/<org>/exports/`) are no kernel.files row:
  // a completed archive is referenced until it expires (the export sweep
  // deletes it then). A run in flight names no object yet (object_key is set
  // at completion): its multipart upload is invisible until it completes, and
  // the grace window covers the moment between the upload and the row.
  const exports = await tx.execute<{ object_key: string }>(
    sql`SELECT object_key FROM ${K}.org_exports
        WHERE org_id = ${orgId} AND object_key IS NOT NULL AND status = 'completed'
          AND (expires_at IS NULL OR expires_at > now())`,
  )
  for (const r of exports as unknown as { object_key: string }[]) set.add(r.object_key)
  return set
}

/**
 * File parents that only hold a file while a send is in flight. A send copies
 * each attachment there (`attachFileToParent`), reads the copy's bytes, and on
 * success moves the copy onto the sent message. A send that never got that far
 * (refused, failed, or cut off by the execution ceiling) leaves the copy behind
 * for good, counted against the org's quota and listed under the mailbox.
 */
const TRANSIENT_STAGING_PARENTS: ReadonlyArray<{ app: string; entityType: string }> = [
  { app: "mail", entityType: "outbound_staging" },
]

/**
 * Delete the staged attachment COPIES an aborted send left behind. Conservative
 * on every axis: only copies (`copied_from_id` set; an export artifact written
 * straight to the same parent has none and is the user's to keep), only past
 * the 24 h grace window, and never a copy a still-open approval's payload names
 * (pending, deferred or executing). Each removal is a `file:delete` event like
 * a user's delete, so the object goes the same way (the delete-object consumer).
 */
export async function sweepAbortedSendStagingCopies(
  tx: PrivilegedDb,
  orgId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - GRACE_WINDOW_MS)
  const parents = sql.join(
    TRANSIENT_STAGING_PARENTS.map(
      (p) => sql`(f.app = ${p.app} AND f.entity_type = ${p.entityType})`,
    ),
    sql` OR `,
  )
  const rows = await tx.execute<SweptStagingCopy>(sql`
    DELETE FROM ${K}.files f
    WHERE f.org_id = ${orgId}
      AND (${parents})
      AND f.copied_from_id IS NOT NULL
      AND f.created_at < ${cutoff.toISOString()}::timestamptz
      AND NOT EXISTS (
        SELECT 1 FROM ${K}.approval_requests ar
        WHERE ar.org_id = f.org_id
          AND ar.status IN ('pending', 'deferred', 'approving')
          AND strpos(ar.current_payload::text, f.id::text) > 0
      )
    RETURNING f.id::text AS id, f.app, f.entity_type AS "entityType", f.entity_id AS "entityId",
              f.storage_key AS "storageKey", f.thumbnail_key AS "thumbnailKey"`)
  const swept = rows as unknown as SweptStagingCopy[]
  for (const row of swept) {
    await tx.queueEvent({
      app: "kernel",
      entity: "file",
      action: "delete",
      entityId: row.id,
      orgId,
      actorId: null,
      actorType: "system",
      data: { ...row },
    })
  }
  return swept.map((r) => r.id)
}

type SweptStagingCopy = {
  id: string
  app: string
  entityType: string
  entityId: string
  storageKey: string
  thumbnailKey: string | null
}

export async function runOrphanGcForOrg(
  orgId: string,
  deps: OrphanGcDeps = {},
): Promise<{ deletedCount: number }> {
  const priv = deps.privileged ?? withPrivilegedDb
  try {
    const swept = await priv(orgId, "files:orphan-gc:staging-copies", (tx) =>
      sweepAbortedSendStagingCopies(tx, orgId, deps.now),
    )
    if (swept.length > 0) {
      log.info({ orgId, count: swept.length }, "orphan GC removed staged copies of aborted sends")
    }
  } catch (err) {
    log.error({ err, orgId }, "orphan GC staging-copy sweep failed")
  }
  const referenced = await priv(orgId, "files:orphan-gc:load-refs", (tx) =>
    loadReferencedKeysForOrg(tx, orgId),
  )
  const orphans = await collectOrphanKeysForOrg(orgId, referenced, {
    now: deps.now,
    listOrgPrefixIter: deps.listOrgPrefixIter,
  })
  if (orphans.length === 0) return { deletedCount: 0 }
  const del = deps.deleteObjects ?? defaultDeleteObjects
  for (let i = 0; i < orphans.length; i += DELETE_BATCH_SIZE) {
    const batch = orphans.slice(i, i + DELETE_BATCH_SIZE)
    try {
      await del(batch)
    } catch (err) {
      log.error({ err, orgId, batchSize: batch.length }, "orphan GC batch delete failed")
    }
  }
  return { deletedCount: orphans.length }
}

export async function processOrphanGc(
  privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>,
): Promise<void> {
  const rows = await privileged("files:orphan-gc:list-orgs", async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`SELECT id FROM ${K}.organizations`)
    return r as unknown as { id: string }[]
  })
  // An org being moved keeps its objects: on the target they arrive before the
  // rows that reference them, so a pass now would delete them as orphans.
  const moving = new Set(await movingOrgIds())
  for (const row of rows) {
    if (moving.has(row.id)) continue
    try {
      await runOrphanGcForOrg(row.id)
    } catch (err) {
      log.error({ err, orgId: row.id }, "orphan GC org failed")
    }
  }
}

export async function registerOrphanGcScheduledJob(): Promise<void> {
  await registerScheduledJob("kernel", "files-orphan-gc", "0 3 * * 0", async () => {
    await processOrphanGc((reason, fn) =>
      withPrivilegedDb("00000000-0000-0000-0000-000000000000", reason, fn),
    )
  })
}
