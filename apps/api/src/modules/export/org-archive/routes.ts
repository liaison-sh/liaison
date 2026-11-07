// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Whole-org export over HTTP, mounted at `/api/org/export` behind
 * `requireScope("kernel:org:admin")` (app.ts):
 *
 *   POST /               queue an export of the caller's org → 202 { id, status }
 *                        (409 ORG_EXPORT_RUNNING with `runningId` while one runs)
 *   GET  /               the org's exports, newest first
 *   GET  /:id/download   a link valid 5 minutes (attachment), audited;
 *                        410 for an expired export, 409 for one not completed
 *
 * The link follows the deployment's storage delivery (infra/storage/delivery.ts):
 * a presigned object-store GET when the store is browser reachable
 * (OBJECT_STORAGE_BROWSER_DIRECT), otherwise the API's own capability URL
 * `/api/org-export-dl/:token` (orgExportDownloadRelay below, mounted outside
 * auth), which streams the archive from the store. The token pins the org, the
 * export and its object key; the relay re-checks the export is still completed
 * and unexpired before streaming.
 */

import { Hono } from "hono"
import * as jose from "jose"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { storageDelivery } from "~/infra/storage/delivery"
import { getObjectStream, presignGet } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { assertHostAllowsOrg } from "~/lib/org-host"
import { orgPublicBaseUrl } from "~/lib/org-public-url"
import { enqueueOrgExport } from "~/modules/export/org-archive/job"
import {
  createOrgExport,
  failOrgExport,
  getOrgExport,
  listOrgExports,
  OrgExportRunningError,
  recordOrgExportDownload,
} from "~/modules/export/org-archive/store"
import { contentDisposition } from "~/modules/files/content-disposition"
import { assertOrgNotDeleting } from "~/modules/org/purge/deleting"

const log = rootLogger.child({ module: "org-export-routes" })

export const ORG_EXPORT_DOWNLOAD_TTL_SEC = 300

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const DOWNLOAD_TOKEN_AUDIENCE = "org-export-download"
const downloadTokenSchema = z.object({
  orgId: z.string().regex(UUID),
  exportId: z.string().regex(UUID),
  objectKey: z.string().min(1),
})
type DownloadToken = z.infer<typeof downloadTokenSchema>

async function signOrgExportDownloadToken(payload: DownloadToken): Promise<string> {
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(DOWNLOAD_TOKEN_AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + ORG_EXPORT_DOWNLOAD_TTL_SEC)
    .sign(new TextEncoder().encode(env.JWT_SECRET))
}

/** The token's claims, or null (logged) when its signature, audience or expiry fails. */
async function verifyOrgExportDownloadToken(token: string): Promise<DownloadToken | null> {
  try {
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET), {
      audience: DOWNLOAD_TOKEN_AUDIENCE,
    })
    return downloadTokenSchema.parse(payload)
  } catch (err) {
    log.warn({ err }, "org export download token verification failed")
    return null
  }
}

type OrgExportRow = NonNullable<Awaited<ReturnType<typeof getOrgExport>>>

function isExpired(row: OrgExportRow): boolean {
  return (
    row.status === "expired" ||
    (row.status === "completed" && row.expiresAt !== null && row.expiresAt <= new Date())
  )
}

function archiveFilename(row: OrgExportRow): string {
  return `liaison-org-export-${(row.completedAt ?? row.createdAt).toISOString().slice(0, 10)}.zip`
}

export const orgExportRoutes = new Hono<AppEnv>()
  .post("/", async (c) => {
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    let row: Awaited<ReturnType<typeof createOrgExport>>
    try {
      row = await createOrgExport(orgId, { userId, via: "settings" })
    } catch (err) {
      if (err instanceof OrgExportRunningError) {
        return c.json(
          { error: { message: err.message, code: err.code, runningId: err.runningId } },
          409,
        )
      }
      throw err
    }
    try {
      await enqueueOrgExport({ orgId, exportId: row.id })
    } catch (err) {
      log.error({ err, orgId, exportId: row.id }, "org export enqueue failed")
      const detail = err instanceof Error ? err.message : String(err)
      await failOrgExport(orgId, row.id, { code: "QUEUE_FAILED", detail })
      return c.json(
        {
          error: {
            message: "The export could not be queued. Try again.",
            code: "ORG_EXPORT_QUEUE_FAILED",
          },
        },
        503,
      )
    }
    return c.json({ data: { id: row.id, status: row.status } }, 202)
  })
  .get("/", async (c) => {
    return c.json({ data: await listOrgExports(c.get("orgId")) })
  })
  .get("/:id/download", async (c) => {
    const orgId = c.get("orgId")
    const id = c.req.param("id")
    const row = UUID.test(id) ? await getOrgExport(orgId, id) : null
    if (!row) return c.json({ error: { message: "Export not found", code: "NOT_FOUND" } }, 404)
    if (isExpired(row)) {
      return c.json(
        { error: { message: "This export has expired", code: "ORG_EXPORT_EXPIRED" } },
        410,
      )
    }
    if (row.status !== "completed" || !row.objectKey) {
      return c.json(
        {
          error: {
            message: "This export has no archive to download",
            code: "ORG_EXPORT_NOT_READY",
          },
        },
        409,
      )
    }
    const delivery = storageDelivery()
    const url =
      delivery === "direct"
        ? await presignGet({
            key: row.objectKey,
            expiresInSec: ORG_EXPORT_DOWNLOAD_TTL_SEC,
            responseContentDisposition: `attachment; filename="${archiveFilename(row)}"`,
            responseContentType: "application/zip",
          })
        : `${(await orgPublicBaseUrl(orgId)).replace(/\/$/, "")}/api/org-export-dl/${await signOrgExportDownloadToken(
            {
              orgId,
              exportId: id,
              objectKey: row.objectKey,
            },
          )}`
    await recordOrgExportDownload(orgId, id, c.get("userId"))
    return c.json({ data: { url, delivery, expiresInSec: ORG_EXPORT_DOWNLOAD_TTL_SEC } })
  })

/**
 * The download relay (`/api/org-export-dl/:token`), mounted OUTSIDE the auth
 * middleware like the file download relay: the short-lived signed token, minted
 * by `GET /api/org/export/:id/download` only for a `kernel:org:admin` of the
 * org, is the capability. The export must still be completed, unexpired and
 * hold the pinned object, so a token outliving its export streams nothing.
 */
export const orgExportDownloadRelay = new Hono<AppEnv>()

orgExportDownloadRelay.on(["GET", "HEAD"], "/:token", async (c) => {
  const token = await verifyOrgExportDownloadToken(c.req.param("token"))
  if (!token) {
    return c.json(
      { error: { message: "Invalid or expired download link", code: "INVALID_TOKEN" } },
      401,
    )
  }
  // Host binding (lib/org-host.ts): org A's link works on A's host only.
  await assertHostAllowsOrg(c, token.orgId)
  // Outside authMw, so the deletion guard runs here: once an org's deletion
  // has started, a link minted before it stops working (410 ORG_DELETED).
  await assertOrgNotDeleting(token.orgId)
  const row = await getOrgExport(token.orgId, token.exportId)
  if (!row || row.objectKey !== token.objectKey) {
    return c.json({ error: { message: "Export not found", code: "NOT_FOUND" } }, 404)
  }
  if (isExpired(row) || row.status !== "completed") {
    return c.json(
      { error: { message: "This export has expired", code: "ORG_EXPORT_EXPIRED" } },
      410,
    )
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/zip",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "Content-Disposition": contentDisposition("attachment", archiveFilename(row)),
  }
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers })
  let result: Awaited<ReturnType<typeof getObjectStream>>
  try {
    result = await getObjectStream(token.objectKey)
  } catch (err) {
    log.error(
      { err, orgId: token.orgId, exportId: token.exportId },
      "org export archive could not be read from object storage",
    )
    return c.json(
      { error: { message: "The archive is not available", code: "ORG_EXPORT_UNAVAILABLE" } },
      502,
    )
  }
  if (result.contentLength > 0) headers["Content-Length"] = String(result.contentLength)
  return new Response(result.stream, { status: 200, headers })
})
