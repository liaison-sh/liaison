// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared E2E helpers for the generic agent file-attachment feature.
 *
 *  - `seedFileOnEntity`     — INF-1: upload a real file onto any registered
 *                             `fileParent` entity through the production
 *                             presign → object-store PUT → confirm path.
 *  - `seedDriveConnection`  — INF-3: a user-owned Google Drive connection
 *                             (the seed engine's `connections.mock`) so the
 *                             `drive_*` tools can resolve an OAuth token.
 *  - `parseMimeAttachments` — INF-2: extract attachment parts (filename,
 *                             content type, raw bytes) from a captured RFC 2822
 *                             buffer.
 */
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { simpleParser } from "mailparser"
import { seedFactory } from "./seed-factory"

/**
 * Upload a file onto an entity via the real `/api/files/*` HTTP path:
 * presigned URL → real `PUT` to the object store → `POST /api/files/confirm`. The file
 * lands as a `kernel.files` row parented to `(app, entityType, entityId)` —
 * exactly how a human upload arrives. Returns the new file id + the bytes so
 * a caller can later assert a copied attachment is byte-identical.
 */
export async function seedFileOnEntity(
  env: WorkerEnv,
  token: string,
  params: {
    app: string
    entityType: string
    entityId: string
    filename: string
    mimeType: string
    bytes: Buffer
  },
): Promise<{ fileId: string; storageKey: string; bytes: Buffer }> {
  const presign = await api(env.serverUrl, "/api/files/upload-url", {
    token,
    body: {
      app: params.app,
      entityType: params.entityType,
      entityId: params.entityId,
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: params.bytes.byteLength,
    },
  })
  if (presign.status !== 200) {
    throw new Error(`upload-url failed: ${presign.status} ${JSON.stringify(presign.body)}`)
  }
  const { uploadUrl, fileToken, storageKey } = presign.body.data as {
    uploadUrl: string
    fileToken: string
    storageKey: string
  }

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": params.mimeType },
    body: params.bytes,
  })
  if (!put.ok) {
    throw new Error(`Object store PUT failed: ${put.status} ${await put.text()}`)
  }

  const confirm = await api(env.serverUrl, "/api/files/confirm", {
    token,
    body: { fileToken },
  })
  if (confirm.status !== 200) {
    throw new Error(`confirm failed: ${confirm.status} ${JSON.stringify(confirm.body)}`)
  }
  return {
    fileId: (confirm.body.data as { id: string }).id,
    storageKey,
    bytes: params.bytes,
  }
}

/**
 * A user-owned Google Drive connection, made by the seed engine's
 * `connections.mock` factory in the server under test, so the `drive_*`
 * bridge methods resolve a token via `getTokenForConnection(... "google-drive",
 * "drive")`. It is `ownerType: "user"` owned by `userId`: the
 * `connected_accounts` RLS policy only exposes org-level accounts for
 * `app_name='kernel'`, so an org-owned Drive account would be RLS-invisible to
 * the resolving user. The server seals the access token with its own key.
 */
export async function seedDriveConnection(
  env: WorkerEnv,
  params: { orgId: string; userId: string; accessToken?: string },
): Promise<{ id: string; accessToken: string }> {
  const accessToken = params.accessToken ?? "drive-test-access-token"
  const { id } = await seedFactory<{ id: string }>(env, params.orgId, "connections.mock", {
    appName: "google-drive",
    connectionName: "drive",
    ownerType: "user",
    userId: params.userId,
    identifier: "drive@org.test",
    displayName: "Google Drive",
    kind: { type: "oauth2", accessToken },
  })
  return { id, accessToken }
}

export interface ParsedMimeAttachment {
  filename: string
  contentType: string
  bytes: Buffer
}

/**
 * Extract attachment parts from a captured RFC 2822 buffer. Wraps
 * `mailparser.simpleParser` — the same parser the SMTP fixture uses — so a
 * scenario can assert an outbound attachment decoded byte-for-byte to its
 * source. Inline parts (no filename) are skipped.
 */
export async function parseMimeAttachments(raw: Buffer): Promise<ParsedMimeAttachment[]> {
  const mail = await simpleParser(raw)
  return mail.attachments
    .filter((a) => typeof a.filename === "string" && a.filename.length > 0)
    .map((a) => ({
      filename: a.filename as string,
      contentType: a.contentType,
      bytes: Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content),
    }))
}
