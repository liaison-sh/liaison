// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The files a page shows: its own (parented to it) and any other file its text names,
 * read under the reader's row security, so a file the reader cannot read is not listed.
 */
import { fileIdsOf } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { kernelRel } from "~/apps/knowledge/schema-refs"
import { extractRows, type RlsClient } from "~/db"

/** At most this many files are listed for one page. */
export const PAGE_FILES_LIMIT = 200

export interface PageFile {
  id: string
  filename: string
  mimeType: string
}

export async function pageFilesOf(
  tx: RlsClient,
  page: { id: string; orgId: string; body: string },
): Promise<PageFile[]> {
  const named = fileIdsOf(page.body ?? "")
  return extractRows<PageFile>(
    await tx.execute(sql`
      SELECT id::text AS id, filename, mime_type AS "mimeType"
        FROM ${kernelRel("files")}
       WHERE org_id = ${page.orgId}::uuid
         AND ((app = 'knowledge' AND entity_type = 'document' AND entity_id = ${page.id})
              OR id = ANY(${`{${named.join(",")}}`}::uuid[]))
       ORDER BY created_at, id
       LIMIT ${PAGE_FILES_LIMIT}`),
  )
}
