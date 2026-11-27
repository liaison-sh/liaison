// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bytes behind a buyer's download link: one kernel.files row of the link's org, streamed as
// an attachment that is never cached. A file sealed for its owner is never served. No storage
// key or URL leaves this file.
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel"
import { getObjectStream } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { contentDisposition } from "~/modules/files/content-disposition"

const log = rootLogger.child({ module: "buyer-invoices-file" })

/** Storage reads, replaceable in tests. */
export const buyerFileStorage = {
  open: (storageKey: string) => getObjectStream(storageKey),
}

export async function readBuyerFile(
  orgId: string,
  fileId: string,
  filename: string,
): Promise<Response | null> {
  const [row] = await withPrivilegedDb(orgId, "buyer-invoices-file-row", (tx) =>
    tx
      .select({ storageKey: files.storageKey, encVersion: files.encVersion })
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.orgId, orgId)))
      .limit(1),
  )
  if (!row) return null
  if (Number(row.encVersion ?? 0) !== 0) {
    log.warn({ fileId, orgId }, "buyer invoices refused a sealed file")
    return null
  }
  const object = await buyerFileStorage.open(row.storageKey)
  const headers: Record<string, string> = {
    "Content-Type": "application/pdf",
    "Content-Disposition": contentDisposition("attachment", filename),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  }
  if (object.contentLength > 0) headers["Content-Length"] = String(object.contentLength)
  return new Response(object.stream, { status: 200, headers })
}
