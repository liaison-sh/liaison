// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Browsers upload import parts straight to the bucket, then read each part's
 * ETag to complete the upload, so the bucket's CORS rule must allow PUT and
 * expose ETag. Checked once at boot (a warning in the logs when it does not)
 * and reported by `GET /api/imports/uploads/config`. Only meaningful when
 * browsers talk to the store (OBJECT_STORAGE_BROWSER_DIRECT); in relay mode
 * nothing is checked.
 */
import { storageDelivery } from "~/infra/storage/delivery"
import { type BucketCorsStatus, checkBucketCorsForMultipart } from "~/infra/storage/multipart"
import { filesLogger as log } from "~/lib/logger"

let cached: { at: number; status: BucketCorsStatus } | null = null
const TTL_MS = 10 * 60 * 1000

export async function importUploadCorsStatus(): Promise<BucketCorsStatus> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.status
  const status = await checkBucketCorsForMultipart()
  cached = { at: Date.now(), status }
  return status
}

/** Boot check: warn when direct browser uploads are on and the bucket's CORS cannot serve them. */
export async function warnOnImportUploadCors(): Promise<void> {
  if (storageDelivery({ sealed: false }) !== "direct") return
  try {
    const status = await importUploadCorsStatus()
    if (!status.ok) {
      log.warn(
        { problems: status.problems },
        "Object storage CORS may block browser import uploads: allow PUT and expose the ETag header (see docs/runbooks/production-bootstrap.md)",
      )
    }
  } catch (err) {
    log.warn({ err }, "Object storage CORS check failed")
  }
}
