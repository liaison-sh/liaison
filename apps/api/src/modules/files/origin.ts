// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"

const K = sql.raw(schemaRef("kernel"))

/**
 * Did this file come from outside the org? A file a member of the org uploaded
 * did not; everything else did, failing closed:
 * - no uploader (an inbound mail or ticket attachment, a webhook or link ingestion, a rendered or
 *   synced file), or an uploader who is not a user of the org;
 * - a mailbox attachment (app `mail`), whoever imported it;
 * - an integration import staged in an upload session (Google Drive), or a merged PDF (its pages
 *   may come from any of those);
 * - a copy (`copied_from_id`) of any of those, followed back to its first source; a chain that
 *   cannot be followed to its end counts as outside.
 * Read privileged: what decides it must not depend on what the caller can see.
 * Used by media analysis (does the analysis taint the turn) and by the
 * attachment type check (does the operator's extension allowance apply).
 */
export async function fileIsFromOutside(orgId: string, fileId: string): Promise<boolean> {
  const rows = await withPrivilegedDb(orgId, "file-origin", async (db) =>
    extractRows<{
      app: string
      copiedFromId: string | null
      member: boolean
      sessionTargetApp: string | null
      sessionTargetEntityType: string | null
      depth: number
    }>(
      await db.execute(sql`
        WITH RECURSIVE chain AS (
          SELECT f.id, f.app, f.entity_type, f.entity_id, f.uploaded_by, f.copied_from_id, 0 AS depth
          FROM ${K}.files f WHERE f.id = ${fileId}::uuid AND f.org_id = ${orgId}::uuid
          UNION ALL
          SELECT f.id, f.app, f.entity_type, f.entity_id, f.uploaded_by, f.copied_from_id, c.depth + 1
          FROM ${K}.files f JOIN chain c ON f.id = c.copied_from_id
          WHERE f.org_id = ${orgId}::uuid AND c.depth < 8
        )
        SELECT c.app, c.copied_from_id AS "copiedFromId", c.depth,
               (u.id IS NOT NULL) AS member,
               s.target_app AS "sessionTargetApp",
               s.target_entity_type AS "sessionTargetEntityType"
        FROM chain c
        LEFT JOIN ${K}.users u ON u.id = c.uploaded_by AND u.org_id = ${orgId}::uuid
        LEFT JOIN ${K}.file_upload_sessions s
          ON c.app = 'kernel' AND c.entity_type = 'file_upload_session'
          AND s.id::text = c.entity_id AND s.org_id = ${orgId}::uuid
        ORDER BY c.depth
      `),
    ),
  )
  if (rows.length === 0) return true
  // The chain must end at a file that is not itself a copy.
  if (rows[rows.length - 1].copiedFromId !== null) return true
  return rows.some(
    (r) =>
      !r.member ||
      r.app === "mail" ||
      r.sessionTargetEntityType === "import" ||
      // A merged PDF carries pages of files the merge does not trace back.
      r.sessionTargetEntityType === "merged_pdf" ||
      r.sessionTargetApp === "google-drive",
  )
}
