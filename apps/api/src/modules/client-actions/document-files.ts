// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bytes of a file a client action's target shows: the frozen PDF and the
// server-made page pictures. Read only for the one action whose token was
// posted, only by the file id the app's own read tool returned for it, and only
// in that action's org. A file sealed for a mailbox (`enc_version > 0`) is never
// served here: its key is not the server's.

import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"

const log = rootLogger.child({ module: "client-actions" })

/** A frozen document or page picture is never larger than this on the page. */
const MAX_FILE_BYTES = 35 * 1024 * 1024

export interface TargetFile {
  bytes: Buffer
  mimeType: string
  filename: string
}

/** One file of the target in the action's org, or null when it is absent or not servable. */
export async function readTargetFile(
  orgId: string,
  actionId: string,
  fileId: string,
): Promise<TargetFile | null> {
  const [row] = await withPrivilegedDb(orgId, "client-action-file", async (tx) =>
    extractRows<{
      storage_key: string
      mime_type: string
      filename: string
      enc_version: number | null
    }>(
      await tx.execute(sql`
        SELECT storage_key, mime_type, filename, enc_version
          FROM ${sql.raw(schemaRef("kernel"))}.files
         WHERE id = ${fileId} AND org_id = ${orgId} LIMIT 1
      `),
    ),
  )
  if (!row || Number(row.enc_version ?? 0) > 0) {
    log.warn({ orgId, actionId, fileId }, "client action file missing or not servable")
    return null
  }
  try {
    const got = await getObjectBytes(row.storage_key, { maxBytes: MAX_FILE_BYTES })
    return { bytes: got.bytes, mimeType: row.mime_type, filename: row.filename }
  } catch (err) {
    log.warn({ err, orgId, actionId, fileId }, "client action file read failed")
    return null
  }
}

/**
 * The hex SHA-256 of one stored file of the org, for a target whose app names its file but not
 * its hash (a sandboxed app never hashes): a fingerprint of the bytes as stored, nothing else.
 * Null when the file is absent or not servable here.
 */
export async function storedFileSha256(orgId: string, fileId: string): Promise<string | null> {
  const file = await readTargetFile(orgId, "fingerprint", fileId)
  return file ? createHash("sha256").update(file.bytes).digest("hex") : null
}
