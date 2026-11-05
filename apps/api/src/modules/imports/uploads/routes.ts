// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import upload routes (`/api/imports/uploads`), authenticated. Each route
 * acts on the caller's own uploads only (owner within the org).
 *
 *   POST /                 { filename, mimeType, size } → upload + first part URLs
 *   GET  /config           limits, delivery mode and the bucket CORS check
 *   GET  /:id              upload state, parts received and missing (resume)
 *   POST /:id/sign         { partNumbers } → fresh part URLs
 *   POST /:id/complete     → the upload with its fileId
 *   POST /:id/abort
 */

import type { Context } from "hono"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { storageDelivery } from "~/infra/storage/delivery"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { loadOrgSettings } from "~/modules/files/service"
import { importUploadCorsStatus } from "./cors-check"
import {
  abortImportUpload,
  completeImportUpload,
  createImportUpload,
  getImportUpload,
  IMPORT_SIGN_BATCH,
  ImportUploadError,
  loadImportFileSizeLimitMb,
  signImportUploadParts,
} from "./service"

const createSchema = z.object({
  filename: z.string().min(1).max(1024),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().positive(),
})

const signSchema = z.object({
  partNumbers: z.array(z.number().int().positive()).min(1).max(IMPORT_SIGN_BATCH),
})

const idParam = z.object({ id: z.string().uuid() })

function uploadError(err: ImportUploadError): Response {
  return Response.json({ error: { message: err.message, code: err.code } }, { status: err.status })
}

function caller(c: Context<AppEnv>) {
  const orgId = c.get("orgId")
  return {
    orgId,
    userId: c.get("userId"),
    privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) =>
      withPrivilegedDb(orgId, reason, fn),
  }
}

export const importUploadRoutes = new Hono<AppEnv>()
  .get("/config", async (c) => {
    const orgId = c.get("orgId")
    const limits = await withPrivilegedDb(orgId, "imports:upload-config", async (tx) => ({
      importFileSizeLimitMb: await loadImportFileSizeLimitMb(tx, orgId),
      fileSizeLimitMb: (await loadOrgSettings(tx, orgId)).fileSizeLimitMb,
    }))
    const mode = storageDelivery({ sealed: false })
    return success(c, {
      mode: mode === "direct" ? "multipart" : "relay",
      ...limits,
      ...(mode === "direct" ? { storageCors: await importUploadCorsStatus() } : {}),
    })
  })
  .post("/", zValidator("json", createSchema), async (c) => {
    const body = c.req.valid("json")
    const { orgId, userId, privileged } = caller(c)
    try {
      const result = await withRequestRls(c, (rlsTx) =>
        createImportUpload({ orgId, userId, ...body }, { rlsTx, privileged }),
      )
      return success(c, result)
    } catch (err) {
      if (err instanceof ImportUploadError) return uploadError(err)
      throw err
    }
  })
  .get("/:id", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param")
    const { orgId, userId, privileged } = caller(c)
    try {
      const state = await withRequestRls(c, (rlsTx) =>
        getImportUpload({ orgId, userId, id }, { rlsTx, privileged }),
      )
      return success(c, state)
    } catch (err) {
      if (err instanceof ImportUploadError) return uploadError(err)
      throw err
    }
  })
  .post("/:id/sign", zValidator("param", idParam), zValidator("json", signSchema), async (c) => {
    const { id } = c.req.valid("param")
    const { partNumbers } = c.req.valid("json")
    const { orgId, userId, privileged } = caller(c)
    try {
      const parts = await withRequestRls(c, (rlsTx) =>
        signImportUploadParts({ orgId, userId, id, partNumbers }, { rlsTx, privileged }),
      )
      return success(c, { parts })
    } catch (err) {
      if (err instanceof ImportUploadError) return uploadError(err)
      throw err
    }
  })
  .post("/:id/complete", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param")
    const { orgId, userId, privileged } = caller(c)
    try {
      const done = await withRequestRls(c, (rlsTx) =>
        completeImportUpload({ orgId, userId, id }, { rlsTx, privileged }),
      )
      return success(c, done)
    } catch (err) {
      if (err instanceof ImportUploadError) return uploadError(err)
      throw err
    }
  })
  .post("/:id/abort", zValidator("param", idParam), async (c) => {
    const { id } = c.req.valid("param")
    const { orgId, userId, privileged } = caller(c)
    try {
      const done = await withRequestRls(c, (rlsTx) =>
        abortImportUpload({ orgId, userId, id }, { rlsTx, privileged }),
      )
      return success(c, done)
    } catch (err) {
      if (err instanceof ImportUploadError) return uploadError(err)
      throw err
    }
  })
