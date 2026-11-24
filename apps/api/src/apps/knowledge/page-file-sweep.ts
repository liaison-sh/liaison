// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Copies of files made for a page that never came to be.
 *
 * A save copies the files of other pages its text names (body-tokens.ts). On a
 * request transaction the copy's row is written by the privileged pool, which commits
 * on its own: when the page's create then rolls back, the copy is left naming a page
 * that does not exist. Nobody can read it (a file is read through its page), but it
 * holds storage. This sweep removes such copies once they are older than a create
 * can take, and queues the deletion of their bytes, as a file delete does.
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
  return sql`f.app = 'knowledge' AND f.entity_type = 'document' AND f.copied_from_id IS NOT NULL
    AND f.created_at < now() - make_interval(mins => ${graceMinutes})
    AND NOT EXISTS (SELECT 1 FROM ${knowledgeRel("documents")} d
                     WHERE d.org_id = f.org_id AND d.id::text = f.entity_id)`
}

/** Remove every unparented copy older than the grace; returns how many. */
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
