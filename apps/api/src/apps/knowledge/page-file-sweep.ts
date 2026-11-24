// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Copies of files made by a save that never landed.
 *
 * A save copies the files of other pages its text names (body-tokens.ts). On a
 * request transaction the copy's row is written by the privileged pool, which commits
 * on its own. When the save then fails, the copy stays:
 * - a create that rolls back leaves a copy naming a page that does not exist. Nobody
 *   can read it (a file is read through its page), but it holds storage;
 * - an update that fails after the copy (a refusal, a lost compare-and-swap) leaves a
 *   copy on the live page that no text of the page names: listed with the page's
 *   files, never shown in it.
 * This sweep removes such copies once they are older than a save can take, and queues
 * the deletion of their bytes, as a file delete does. A copy on a live page is kept
 * while its text or any version of it (an unapplied text included) names it, so a
 * restore finds it, and a copy made with the page itself is never touched: the
 * Knowledge import attaches its files in the page's own transaction, so they share the
 * page's `created_at`, whether or not the text names them.
 */
import { sql } from "drizzle-orm"
import { kernelRel, knowledgeRel } from "~/apps/knowledge/schema-refs"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { knowledgeLogger as log } from "~/lib/logger"
import { sweepSkippingMoving, writeUnlessMoving } from "~/modules/org/transfer-state/skip-moving"

/** A copy younger than this may belong to a create still in flight. */
export const UNPARENTED_COPY_GRACE_MINUTES = 60
const SWEEP_BATCH = 500

function unparented(graceMinutes: number) {
  const documents = knowledgeRel("documents")
  const versions = knowledgeRel("document_versions")
  return sql`f.app = 'knowledge' AND f.entity_type = 'document' AND f.copied_from_id IS NOT NULL
    AND f.created_at < now() - make_interval(mins => ${graceMinutes})
    AND (
      NOT EXISTS (SELECT 1 FROM ${documents} d
                   WHERE d.org_id = f.org_id AND d.id::text = f.entity_id)
      OR EXISTS (SELECT 1 FROM ${documents} d
                  WHERE d.org_id = f.org_id AND d.id::text = f.entity_id
                    AND f.created_at > d.created_at
                    AND strpos(lower(d.body), f.id::text) = 0
                    AND NOT EXISTS (SELECT 1 FROM ${versions} v
                                     WHERE v.org_id = f.org_id AND v.document_id = d.id
                                       AND strpos(lower(v.body), f.id::text) > 0)))`
}

/** Remove every stray copy older than the grace; returns how many. */
export async function sweepUnparentedPageCopies(
  opts: { graceMinutes?: number } = {},
): Promise<number> {
  const grace = opts.graceMinutes ?? UNPARENTED_COPY_GRACE_MINUTES
  const orgs = extractRows<{ org_id: string }>(
    await sweepSkippingMoving((notMoving) =>
      withSystemDb("knowledge-unparented-copies-orgs", (db) =>
        db.execute(sql`
          SELECT DISTINCT f.org_id::text AS org_id FROM ${kernelRel("files")} f
           WHERE ${unparented(grace)} AND ${notMoving(sql.raw("f.org_id"))}`),
      ),
    ),
  )
  let removed = 0
  for (const { org_id: orgId } of orgs) {
    try {
      const n = await writeUnlessMoving(orgId, () =>
        withPrivilegedDb(orgId, "knowledge-unparented-copies", async (tx) => {
          const rows = extractRows<{
            id: string
            entity_id: string
            storage_key: string
            thumbnail_key: string | null
          }>(
            await tx.execute(sql`
              DELETE FROM ${kernelRel("files")} WHERE id IN (
                SELECT f.id FROM ${kernelRel("files")} f
                 WHERE f.org_id = ${orgId}::uuid AND ${unparented(grace)}
                 LIMIT ${SWEEP_BATCH})
              RETURNING id::text AS id, entity_id, storage_key, thumbnail_key`),
          )
          for (const row of rows) {
            await tx.queueEvent({
              app: "kernel",
              entity: "file",
              action: "delete",
              entityId: row.id,
              orgId,
              actorId: "00000000-0000-0000-0000-000000000000",
              actorType: "system",
              data: {
                id: row.id,
                app: "knowledge",
                entityType: "document",
                entityId: row.entity_id,
                storageKey: row.storage_key,
                thumbnailKey: row.thumbnail_key,
              },
            })
          }
          return rows.length
        }),
      )
      if (typeof n === "number") removed += n
    } catch (err) {
      log.error({ err, orgId }, "knowledge: unparented file copies not removed")
    }
  }
  return removed
}
