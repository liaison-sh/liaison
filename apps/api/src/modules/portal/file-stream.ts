// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A file download on the client portal. Whether the caller may have the file is the
// portal role's decision: `portal.file_allowed` runs first, under the portal's own
// login. Only when it answers true is the one file row read (privileged, because the
// portal role reaches no kernel table) and its bytes streamed from storage as an
// attachment that is never cached. No storage key, signed URL or key material leaves
// this file. A file sealed for its owner (mail attachments) is never served here.
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { type PortalContext, withPortalContext } from "~/db/portal-rls"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel"
import { getObjectStream } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { contentDisposition } from "~/modules/files/content-disposition"

const log = rootLogger.child({ module: "portal-file-stream" })

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Storage reads, replaceable in tests (to prove a refused file is never read). */
export const portalFileStorage = {
  open: (key: string) => getObjectStream(key),
}

/**
 * The file as a download, or null when the portal refuses it (an unknown id, another
 * company's file, an unshared one, a draft's PDF: all the same null).
 */
export async function streamPortalFile(
  ctx: PortalContext,
  fileId: string,
): Promise<Response | null> {
  if (!UUID.test(fileId)) return null
  const allowed = await withPortalContext(ctx, async (tx) => {
    const [row] = extractRows<{ ok: boolean }>(
      await tx.execute(drizzleSql`SELECT portal.file_allowed(${fileId}::uuid) AS ok`),
    )
    return row?.ok === true
  })
  if (!allowed) return null
  const [row] = await withPrivilegedDb(ctx.orgId, "portal-file-stream", (tx) =>
    tx
      .select({
        orgId: files.orgId,
        storageKey: files.storageKey,
        filename: files.filename,
        mimeType: files.mimeType,
        encVersion: files.encVersion,
      })
      .from(files)
      .where(eq(files.id, fileId))
      .limit(1),
  )
  if (!row || row.orgId !== ctx.orgId) return null
  if (Number(row.encVersion ?? 0) !== 0) {
    log.warn({ fileId, orgId: ctx.orgId }, "Portal refused a sealed file")
    return null
  }
  const object = await portalFileStorage.open(row.storageKey)
  const headers: Record<string, string> = {
    "Content-Type": row.mimeType || "application/octet-stream",
    "Content-Disposition": contentDisposition("attachment", row.filename),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
  if (object.contentLength > 0) headers["Content-Length"] = String(object.contentLength)
  return new Response(object.stream, { status: 200, headers })
}
