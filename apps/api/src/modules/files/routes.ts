// SPDX-License-Identifier: FSL-1.1-ALv2

import { sql } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { storageDelivery } from "~/infra/storage/delivery"
import { getObjectRange, getObjectStream, headObject } from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import { RequestBodyTooLargeError, readRequestBytesWithLimit } from "~/lib/request-body"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import { zValidator } from "~/lib/validate"
import { contentDisposition } from "~/modules/files/content-disposition"
import {
  type FileEncryptionRow,
  parseRangeHeader,
  toEncryptionMetadata,
} from "~/modules/files/encryption-metadata"
import { inlineServedContentType, servedContentType } from "~/modules/files/served-content-type"
import {
  authorizeUpload,
  confirmUpload,
  createUploadSession,
  deleteFile,
  FileServiceError,
  getDownloadUrl,
  isRelayedFileServable,
  listFiles,
  moveFilesToParent,
  storeRelayedUpload,
  verifyFileDownloadToken,
  verifyFileToken,
} from "~/modules/files/service"
import { assertOrgNotDeleting } from "~/modules/org/purge/deleting"

const FILE_CODE_TO_STATUS: Record<string, number> = {
  PARENT_NOT_FOUND: 404,
  FORBIDDEN: 403,
  FILE_TOO_LARGE: 413,
  STORAGE_QUOTA_EXCEEDED: 409,
  INVALID_TOKEN: 401,
  FILE_VERIFY_FAILED: 422,
  STORAGE_UNAVAILABLE: 503,
  SESSION_EXPIRED: 410,
  TARGET_MISMATCH: 409,
  ALREADY_CONFIRMED: 409,
  NOT_FOUND: 404,
  RETAINED: 409,
}

function fileError(err: FileServiceError): Response {
  const status = FILE_CODE_TO_STATUS[err.code] ?? 500
  return Response.json({ error: { message: err.message, code: err.code } }, { status })
}

const uploadUrlSchema = z.object({
  app: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
})

const confirmSchema = z.object({
  fileToken: z.string().min(1),
  disposition: z.enum(["inline", "attachment"]).optional(),
  contentId: z.string().nullish(),
  ordinal: z.number().int().nonnegative().optional(),
})

const uploadSessionSchema = z.object({
  targetApp: z.string().min(1),
  targetEntityType: z.string().min(1),
  targetEntityId: z.string().nullable().optional(),
})

const moveToParentSchema = z.object({
  sourceSessionId: z.string().min(1),
  target: z.object({
    app: z.string().min(1),
    entityType: z.string().min(1),
    entityId: z.string().min(1),
  }),
  fileIds: z.array(z.string().min(1)).min(1).max(1000),
})

export const files = new Hono<AppEnv>()

files.post("/upload-url", zValidator("json", uploadUrlSchema), async (c) => {
  const body = c.req.valid("json")
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const scopes = c.get("scopes") as unknown as string[]

  try {
    const result = await withRequestRls(c, async (rlsTx) =>
      authorizeUpload(
        { orgId, userId, scopes, ...body },
        {
          rlsTx,
          privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
        },
      ),
    )
    return success(c, result)
  } catch (err) {
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
})

files.post("/confirm", zValidator("json", confirmSchema), async (c) => {
  const body = c.req.valid("json")
  const callerOrgId = c.get("orgId")
  try {
    const result = await confirmUpload(
      body.fileToken,
      {
        // Pass callerOrgId so confirmUpload can verify the token belongs to
        // the authenticated caller's org and not a foreign org's file.
        callerOrgId,
        privileged: (reason, fn) => withPrivilegedDb(callerOrgId, reason, fn),
      },
      {
        disposition: body.disposition,
        contentId: body.contentId ?? null,
        ordinal: body.ordinal,
      },
    )
    return success(c, result)
  } catch (err) {
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
})

files.post("/upload-sessions", zValidator("json", uploadSessionSchema), async (c) => {
  const body = c.req.valid("json")
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const scopes = c.get("scopes") as unknown as string[]
  try {
    const result = await withRequestRls(c, async (rlsTx) =>
      createUploadSession(
        {
          orgId,
          userId,
          scopes,
          targetApp: body.targetApp,
          targetEntityType: body.targetEntityType,
          targetEntityId: body.targetEntityId ?? null,
        },
        {
          rlsTx,
          privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
        },
      ),
    )
    return success(c, result)
  } catch (err) {
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
})

files.post("/move-to-parent", zValidator("json", moveToParentSchema), async (c) => {
  const body = c.req.valid("json")
  const userId = c.get("userId")
  const orgId = c.get("orgId")
  const scopes = c.get("scopes") as unknown as string[]
  try {
    await withRequestRls(c, async (rlsTx) =>
      moveFilesToParent(
        {
          orgId,
          userId,
          scopes,
          sourceSessionId: body.sourceSessionId,
          target: body.target,
          fileIds: body.fileIds,
        },
        {
          rlsTx,
          privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
        },
      ),
    )
    return success(c, { moved: body.fileIds.length })
  } catch (err) {
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
})

/**
 * How this deployment delivers file bytes to browsers ("direct" or "relay",
 * infra/storage/delivery.ts). A client reads it once per session, so a relayed
 * download goes straight to the API route without asking per file.
 */
files.get("/delivery", (c) => success(c, { delivery: storageDelivery() }))

const listQuerySchema = z.object({
  app: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
})

files.get("/", zValidator("query", listQuerySchema), async (c) => {
  const q = c.req.valid("query")
  const orgId = c.get("orgId")
  const scopes = c.get("scopes") as unknown as string[]
  try {
    const result = await withRequestRls(c, (rlsTx) =>
      listFiles(
        {
          app: q.app,
          entityType: q.entityType,
          entityId: q.entityId,
          limit: q.limit,
          offset: q.offset,
          orgId,
          scopes,
        },
        { rlsTx },
      ),
    )
    return success(c, result.files, {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    })
  } catch (err) {
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
})

/**
 * Cache-Control for the inline route. File bytes under a given id are
 * immutable (no code path ever rewrites an existing row's storage_key or the
 * bytes behind it), so when the response serves the variant the client asked
 * for it is cacheable long-term. The ONE mutable case: `variant=thumb` was
 * requested but the thumbnail does not exist yet — we fall back to the
 * original, and the thumb may appear later at the SAME URL, so that fallback
 * keeps a short TTL so clients pick up the thumb once it is generated.
 */
export function inlineCacheControl(wantThumb: boolean, servingThumb: boolean): string {
  const servedRequestedVariant = !wantThumb || servingThumb
  return servedRequestedVariant ? "private, max-age=31536000, immutable" : "private, max-age=60"
}

// Authenticated streaming endpoint used for inline image rendering (CID rewrite
// targets this route) and as a download fallback when presigned URLs are not
// appropriate. Enforces RLS via withRequestRls and caps the response size to
// 35 MB (defense in depth — actual quota is per-org).
//
// Hardening:
//   - `X-Content-Type-Options: nosniff` on every response (no MIME sniffing).
//   - `Content-Security-Policy: default-src 'none'; sandbox; img-src 'self' data:`
//     so even if a payload is mis-typed, it cannot execute scripts.
//   - `image/svg+xml` is force-downloaded (SVGs can carry inline JS).
//   - Filename is sanitized so CRLF / quote characters cannot inject headers.
type InlineFileRow = {
  storage_key: string
  thumbnail_key: string | null
  mime_type: string
  filename: string
  size_bytes: number | string
  enc_version: number | string | null
}

files.on(["GET", "HEAD"], "/:id/inline", async (c) => {
  const id = c.req.param("id")
  // `variant=thumb` serves the pre-rendered webp thumbnail when one exists
  // (attachment-card previews); `download=1` forces attachment disposition and
  // streams without the inline byte cap (browser downloads of large files).
  const wantThumb = c.req.query("variant") === "thumb"
  const wantDownload = c.req.query("download") === "1"
  try {
    const row = await withRequestRls(c, async (rlsTx) => {
      const KS = sql.raw(schemaRef("kernel"))
      const rs = await rlsTx.execute<InlineFileRow>(
        sql`SELECT storage_key, thumbnail_key, mime_type, filename, size_bytes, enc_version
              FROM ${KS}.files WHERE id = ${id} LIMIT 1`,
      )
      const list = rs as unknown as InlineFileRow[]
      return list[0] ?? null
    })
    if (!row) {
      return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
    }
    const useThumb = wantThumb && !!row.thumbnail_key
    const mimeType = useThumb ? "image/webp" : row.mime_type
    const lcMime = mimeType.toLowerCase()
    const isSvg = lcMime === "image/svg+xml" || lcMime.startsWith("image/svg+xml;")
    // Treat SVG as non-inline regardless of `image/*` prefix — SVG can carry
    // inline scripts that execute under the site origin.
    const isImage = lcMime.startsWith("image/") && !isSvg
    const headers: Record<string, string> = {
      "Content-Type": inlineServedContentType(mimeType),
      "Cache-Control": inlineCacheControl(wantThumb, useThumb),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      "Referrer-Policy": "no-referrer",
      // A sealed attachment is read chunk by chunk, so the route advertises
      // range support on every response rather than only when asked.
      "Accept-Ranges": "bytes",
      // Emit both filename= (ASCII fallback) and filename*= (RFC 5987,
      // supports non-ASCII) so browsers of all vintages decode the name.
      "Content-Disposition": contentDisposition(
        isImage && !wantDownload ? "inline" : "attachment",
        row.filename,
      ),
    }
    // A sealed object is LONGER than `size_bytes`: that column is the plaintext
    // length, and the stored bytes carry one authentication tag per chunk. The
    // store is the authority on what a range is measured against.
    // A server-managed mail attachment (`enc_version = 2`) is opened here for
    // its owner and served as plain bytes: no browser key is involved, so
    // there is no chunked range to serve.
    if (Number(row.enc_version ?? 0) === 2 && !useThumb) {
      headers["Accept-Ranges"] = "none"
      // HEAD answers from the row (`size_bytes` is the plaintext length) and
      // opens nothing: a probe must not decrypt a whole attachment.
      if (c.req.method === "HEAD") {
        headers["Content-Length"] = String(Number(row.size_bytes))
        return new Response(null, { status: 200, headers })
      }
      const { openManagedFile, ManagedMailAccessError } = await import(
        "~/modules/mailbox-crypto/managed-open"
      )
      const opened = await withRequestRls(c, (rlsTx) =>
        openManagedFile(rlsTx, {
          orgId: c.get("orgId"),
          userId: c.get("userId"),
          fileId: id,
          purpose: { kind: "attachment" },
        }),
      ).catch((err: unknown) => {
        if (err instanceof ManagedMailAccessError) return null
        throw err
      })
      // Someone else's personal mail attachment: the owner alone reads it.
      if (!opened) {
        return c.json(
          { error: { message: "Forbidden", code: "MAILBOX_MANAGED_ACCESS_DENIED" } },
          403,
        )
      }
      headers["Content-Length"] = String(opened.bytes.byteLength)
      return new Response(new Uint8Array(opened.bytes), { status: 200, headers })
    }
    const sealed = Number(row.enc_version ?? 0) > 0 && !useThumb
    const objectKey = useThumb && row.thumbnail_key ? row.thumbnail_key : row.storage_key
    // HEAD short-circuits before bytes read.
    if (c.req.method === "HEAD") {
      headers["Content-Length"] = sealed
        ? String((await headObject(objectKey)).contentLength)
        : String(Number(row.size_bytes))
      return new Response(null, { status: 200, headers })
    }
    // Range requests. The browser asks for the ciphertext bytes covering the
    // chunks it wants, decrypts them in its crypto worker and slices the
    // result; an ordinary file's range is served by the same path, unchanged.
    const rangeHeader = c.req.header("range")
    if (rangeHeader) {
      const total = sealed
        ? (await headObject(objectKey)).contentLength
        : Number(row.size_bytes) || (await headObject(objectKey)).contentLength
      const parsed = parseRangeHeader(rangeHeader, total)
      if (parsed.kind === "unsatisfiable") {
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${total}` },
        })
      }
      if (parsed.kind === "range") {
        const part = await getObjectRange(objectKey, { start: parsed.start, end: parsed.end })
        headers["Content-Range"] = `bytes ${parsed.start}-${parsed.end}/${total}`
        headers["Content-Length"] = String(part.bytes.byteLength)
        return new Response(part.bytes, { status: 206, headers })
      }
    }
    if (wantDownload && !useThumb) {
      // Downloads stream straight from object storage — no in-memory
      // buffering, so the 35 MB inline cap does not apply.
      let result: Awaited<ReturnType<typeof getObjectStream>>
      try {
        result = await getObjectStream(objectKey)
      } catch (err) {
        log.warn({ err, fileId: id }, "getObjectStream failed for download")
        throw new FileServiceError("FILE_VERIFY_FAILED", "Object not available")
      }
      if (result.contentLength > 0) {
        headers["Content-Length"] = String(result.contentLength)
      }
      return new Response(result.stream, { status: 200, headers })
    }
    const result = await getObjectBytes(objectKey, {
      maxBytes: 35 * 1024 * 1024,
    })
    headers["Content-Length"] = String(result.contentLength)
    return new Response(result.bytes, { status: 200, headers })
  } catch (err) {
    if (err instanceof FileServiceError) {
      // Don't leak internal storage keys in client error messages — the
      // helper embeds the key into FILE_VERIFY_FAILED. Map to a generic
      // payload while letting the file service report the code via header.
      if (err.code === "FILE_VERIFY_FAILED") {
        return c.json(
          { error: { message: "Object not available", code: "FILE_VERIFY_FAILED" } },
          502,
        )
      }
      return fileError(err)
    }
    throw err
  }
})

/**
 * Envelope metadata for one file, including the sealed-attachment envelope when
 * there is one (Task 7.3).
 *
 * The client needs this BEFORE it can read a sealed attachment: it carries the
 * wrapped content key, the ephemeral public key, the key id and the three
 * authenticated STREAM values, which together turn a plaintext range into a
 * ciphertext range. None of it opens anything without the user's private key,
 * and the row is still read under the caller's RLS, so a file the caller cannot
 * see is a 404 here exactly as it is everywhere else.
 */
files.get("/:id/metadata", async (c) => {
  const id = c.req.param("id")
  const row = await withRequestRls(c, async (rlsTx) => {
    const KS = sql.raw(schemaRef("kernel"))
    const rs = await rlsTx.execute(
      sql`SELECT id::text AS id, app, entity_type, entity_id::text AS entity_id,
                 filename, mime_type, size_bytes, disposition, content_id,
                 enc_version, content_key_wrapped, content_key_epk, enc_key_id, chunk_size,
                 chunk_count, plaintext_length, nonce_prefix
            FROM ${KS}.files WHERE id = ${id} LIMIT 1`,
    )
    const list = rs as unknown as Array<
      FileEncryptionRow & {
        id: string
        app: string
        entity_type: string
        entity_id: string
        filename: string
        mime_type: string
        size_bytes: number | string
        disposition: string
        content_id: string | null
      }
    >
    return list[0] ?? null
  })
  if (!row) {
    return c.json({ error: { message: "Not found", code: "NOT_FOUND" } }, 404)
  }
  return success(c, {
    id: row.id,
    // The record the file is attached to (the file_shared attention opener reads it).
    app: row.app,
    entityType: row.entity_type,
    entityId: row.entity_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    disposition: row.disposition,
    contentId: row.content_id,
    encryption: toEncryptionMetadata(row),
  })
})

files.get("/:id/download-url", async (c) => {
  const id = c.req.param("id")
  try {
    const result = await withRequestRls(c, (rlsTx) => getDownloadUrl(id, { rlsTx }))
    return success(c, result)
  } catch (err) {
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
})

/**
 * Token-authenticated upload relay, mounted OUTSIDE the auth middleware
 * (`/api/file-relay/:token`). Browsers use it when the presigned PUT URL is
 * not reachable from outside the deployment network (self-hosted SeaweedFS behind
 * a reverse proxy with no public object-storage endpoint). The short-TTL
 * HS256 file token minted by `/files/upload-url` is the capability — it pins
 * org, storage key, MIME type, and byte size, so the relay accepts exactly
 * the upload that was authorized (same trust model as the presigned URL it
 * replaces). The normal `/files/confirm` step still follows; once it has
 * created the row, the relay refuses the token (409 ALREADY_CONFIRMED).
 */
export const fileUploadRelay = new Hono<AppEnv>()

fileUploadRelay.put("/:token", async (c) => {
  const token = c.req.param("token")
  let payload: Awaited<ReturnType<typeof verifyFileToken>>
  try {
    payload = await verifyFileToken(token)
  } catch (err) {
    log.warn({ err }, "file relay token verification failed")
    return c.json(
      { error: { message: "Invalid or expired file token", code: "INVALID_TOKEN" } },
      401,
    )
  }
  // Outside authMw: no upload into an org whose deletion has started.
  await assertOrgNotDeleting(payload.orgId)
  // Reject oversized bodies before buffering when the length is declared.
  const declaredLength = Number(c.req.header("content-length") ?? "0")
  if (declaredLength > payload.sizeBytes) {
    return c.json(
      { error: { message: "Body exceeds authorized size", code: "FILE_TOO_LARGE" } },
      413,
    )
  }
  // Count the stream as it arrives and stop at the authorized size: a client
  // that sends no Content-Length (chunked) must not get the whole body buffered
  // before the size is compared.
  let body: Uint8Array
  try {
    body = await readRequestBytesWithLimit(c.req.raw, payload.sizeBytes)
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      return c.json(
        { error: { message: "Body exceeds authorized size", code: "FILE_TOO_LARGE" } },
        413,
      )
    }
    throw err
  }
  try {
    await storeRelayedUpload(payload, body, {
      privileged: (reason, fn) => withPrivilegedDb(payload.orgId, reason, fn),
    })
  } catch (err) {
    // ALREADY_CONFIRMED (409): a row owns the key, the token is spent.
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
  return c.body(null, 200)
})

/**
 * Token-authenticated DOWNLOAD relay, mounted OUTSIDE the auth middleware
 * (`/api/file-relay-dl/:token`), the mirror of the upload relay above. The
 * short-TTL HS256 download token (minted by getRelayDownloadUrl only after an
 * RLS visibility check) IS the capability — it pins the org + file + storage
 * key, so the relay streams exactly the one authorized object and nothing else.
 * This lets a caller (a browser, or an agent via the files_read tool) fetch a
 * file over the public app host even when the object store has NO public
 * endpoint (self-hosted SeaweedFS on loopback) — the store is never exposed.
 * Always attachment disposition + nosniff/CSP so a mistyped payload can't render
 * or execute under the site origin.
 */
export const fileDownloadRelay = new Hono<AppEnv>()

fileDownloadRelay.on(["GET", "HEAD"], "/:token", async (c) => {
  const token = c.req.param("token")
  let payload: Awaited<ReturnType<typeof verifyFileDownloadToken>>
  try {
    payload = await verifyFileDownloadToken(token)
  } catch (err) {
    log.warn({ err }, "file download relay token verification failed")
    return c.json(
      { error: { message: "Invalid or expired file token", code: "INVALID_TOKEN" } },
      401,
    )
  }
  // Outside authMw: nothing more is served for an org being deleted.
  await assertOrgNotDeleting(payload.orgId)
  const headers: Record<string, string> = {
    // Uploader-declared active types (script, markup, SVG) are served as
    // opaque bytes: this route is on the app origin (served-content-type.ts).
    "Content-Type": servedContentType(payload.mimeType),
    "Cache-Control": "private, max-age=60",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Referrer-Policy": "no-referrer",
    "Content-Disposition": contentDisposition("attachment", payload.filename),
  }
  // The token proves an RLS check passed when it was minted, not that the file
  // still exists: a file deleted since (or a deleted message's attachment)
  // stops streaming now, not when the token expires.
  if (!(await isRelayedFileServable(payload))) {
    return c.json({ error: { message: "File not found", code: "PARENT_NOT_FOUND" } }, 404)
  }
  if (c.req.method === "HEAD") {
    return new Response(null, { status: 200, headers })
  }
  let result: Awaited<ReturnType<typeof getObjectStream>>
  try {
    result = await getObjectStream(payload.storageKey)
  } catch (err) {
    log.warn({ err, fileId: payload.fileId }, "getObjectStream failed for download relay")
    return c.json({ error: { message: "Object not available", code: "FILE_VERIFY_FAILED" } }, 502)
  }
  if (result.contentLength > 0) {
    headers["Content-Length"] = String(result.contentLength)
  }
  return new Response(result.stream, { status: 200, headers })
})

files.delete("/:id", async (c) => {
  const id = c.req.param("id")
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const scopes = c.get("scopes") as unknown as string[]
  try {
    await withRequestRls(c, (rlsTx) =>
      deleteFile(id, {
        orgId,
        userId,
        scopes,
        rlsTx,
        privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
      }),
    )
    return c.body(null, 204)
  } catch (err) {
    if (err instanceof FileServiceError) return fileError(err)
    throw err
  }
})
