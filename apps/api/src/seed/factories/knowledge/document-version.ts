// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A page-history row (`app_knowledge.document_versions`) written as the stored text a past edit
// left, for a test that needs a version holding exact text (a legacy body, an unapplied draft).

import { sql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { md5 } from "~/apps/knowledge/versions"
import { withPrivilegedDb } from "~/db/privileged"

export interface DocumentVersionSeed {
  orgId: string
  documentId: string
  kind: string
  title: string
  body: string
  authorId: string
  revision?: number
}

/** Insert one user-authored version row for a page. */
export async function seedDocumentVersion(v: DocumentVersionSeed): Promise<void> {
  await withPrivilegedDb(v.orgId, "seed-document-version", (tx) =>
    tx.execute(sql`
      INSERT INTO ${knowledgeRel("document_versions")}
        (org_id, document_id, kind, title, body, body_md5, revision, author_type, author_id,
         started_at, created_at, updated_at, required_scopes)
      VALUES (${v.orgId}::uuid, ${v.documentId}::uuid, ${v.kind}, ${v.title}, ${v.body},
              ${md5(v.body)}, ${v.revision ?? 1}, 'user', ${v.authorId}::uuid, clock_timestamp(),
              clock_timestamp(), clock_timestamp(), '{}'::text[])`),
  )
}
