// SPDX-License-Identifier: FSL-1.1-ALv2
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { putObject } from "~/infra/storage/object-storage"

const K = () => drizzleSql.raw(schemaRef("kernel"))

/**
 * An NDJSON file uploaded to a thread only `ownerId` takes part in: readable
 * by that person (files_select follows the thread), by nobody else.
 * The files SELECT policy must be built (rebuildFilesSelectPolicy) first.
 */
export async function uploadPrivateImportFile(
  orgId: string,
  ownerId: string,
  ndjson: string,
): Promise<string> {
  const fileId = crypto.randomUUID()
  const storageKey = `${orgId}/imports-test/${fileId}.ndjson`
  await putObject({
    key: storageKey,
    body: Buffer.from(ndjson),
    contentType: "application/x-ndjson",
  })
  await withPrivilegedDb(orgId, "test-import-file", async (tx) => {
    const threadId = crypto.randomUUID()
    await tx.execute(drizzleSql`
      INSERT INTO ${K()}.threads (id, org_id, handle, title, created_by)
      VALUES (${threadId}::uuid, ${orgId}::uuid, ${`imp-${threadId.slice(0, 8)}`}, 'import upload', ${ownerId}::uuid)
    `)
    await tx.execute(drizzleSql`
      INSERT INTO ${K()}.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${threadId}::uuid, ${ownerId}::uuid, ${orgId}::uuid, 'owner')
    `)
    await tx.execute(drizzleSql`
      INSERT INTO ${K()}.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                size_bytes, storage_key, uploaded_by)
      VALUES (${fileId}::uuid, ${orgId}::uuid, 'kernel', 'thread', ${threadId}, 'import.ndjson',
              'application/x-ndjson', ${Buffer.byteLength(ndjson)}, ${storageKey}, ${ownerId}::uuid)
    `)
  })
  return fileId
}
