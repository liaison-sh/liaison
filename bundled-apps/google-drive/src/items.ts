// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Knowledge items (manifest `knowledgeItems`): Drive files Knowledge reaches
// without syncing them, through the person's own Drive account (else the
// organization's, as every tool does).
//   - `searchDriveKnowledge`: Knowledge's federated search (Drive's name and
//     full-text search). Off unless the org turns it on: the manifest says
//     `searchByDefault: false` (PATCH /knowledge/sources/google-drive).
//   - `resolveDriveItem`: one file by its Drive id (a source link, a remote
//     read): name, link, modified time and, when asked, its text.
// The reference is the Drive file id, the one source links always stored.

import type { DriveCtx } from "./ctx"
import { type DriveFile, DriveHttpError, DriveScopeError } from "./drive"
import { sanitizeDriveQuery } from "./model"
import { driveRead, NOT_CONNECTED, personClient, resolved, searchDrive } from "./tools"

export async function searchDriveKnowledge(
  params: { query?: string; limit?: number; cursor?: string | null },
  ctx: DriveCtx,
): Promise<{ results: Array<Record<string, unknown>>; nextCursor: null }> {
  const safeQuery = sanitizeDriveQuery(params.query ?? "")
  const client = await personClient(ctx)
  // Not connected, or nothing to look for: this source has no hits.
  if (!client || !safeQuery) return { results: [], nextCursor: null }
  const hits = await searchDrive(client, safeQuery, Math.min(params.limit ?? 10, 20))
  return {
    results: hits.map((h) => ({
      id: h.driveFileId,
      entity: "file",
      title: h.name,
      ...(h.webViewLink ? { url: h.webViewLink } : {}),
      ...(h.modifiedTime ? { modifiedAt: h.modifiedTime } : {}),
    })),
    nextCursor: null,
  }
}

/** Gone, trashed, or not reachable with this person's access: not visible. */
function invisible(err: unknown): boolean {
  return (
    err instanceof DriveScopeError ||
    (err instanceof DriveHttpError && (err.status === 404 || err.status === 403))
  )
}

export async function resolveDriveItem(
  params: { ref?: string; content?: boolean },
  ctx: DriveCtx,
): Promise<Record<string, unknown>> {
  const ref = params.ref
  if (!ref) throw new Error("ref (a Drive file id) is required")
  const client = await personClient(ctx)
  // No account to ask with is an error, not an invisible file: a link never
  // goes stale because the person verifying it has no Drive connected.
  if (!client) throw new Error(NOT_CONNECTED.error.message)
  let meta: DriveFile
  try {
    meta = await resolved(client, ref)
  } catch (err) {
    if (invisible(err)) return { found: false }
    throw err
  }
  if (meta.trashed) return { found: false }
  let text: string | undefined
  if (params.content) {
    // The file's text when it has one (driveRead's rules); any other file is
    // linked by name and URL only.
    const read = (await driveRead({ driveFileId: ref }, ctx)) as { content?: unknown }
    if (typeof read.content === "string") text = read.content
  }
  return {
    found: true,
    title: meta.name,
    ...(meta.webViewLink ? { url: meta.webViewLink } : {}),
    ...(meta.modifiedTime ? { modifiedAt: meta.modifiedTime } : {}),
    ...(text !== undefined ? { text } : {}),
  }
}
