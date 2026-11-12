// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Drive knowledge sources (manifest `knowledgeSources`), synced page by page
// by the platform with the cursor this code returns:
//
//   - `folder` (config `{ ref, account? }`): a Drive folder and its subfolders,
//     each subfolder a collection, each file with a text form a document;
//   - `picked` (config `{ account }`): the files and folders a person picked in
//     Google's picker on one account (picker.ts).
//
// A pass walks the tree depth first: one listing page of one folder per run, its
// text files exported or downloaded, its subfolders pushed on the stack the
// cursor carries. The last page prunes what the pass did not see, so a file
// removed in Drive leaves Knowledge. Documents keep their identity across passes
// (keyed by Drive file id), so a file edited in Drive is updated in place.
//
// A source of an ORGANIZATION connection stays within the shared drives an admin
// chose: with none chosen, or for a folder outside them, the pass upserts
// nothing and prunes, so what the folder held is hidden until the choice covers it.

import type { KnowledgeSyncDocument, KnowledgeSyncFolder, KnowledgeSyncResult } from "@liaison/app-sdk"
import type { DriveCtx } from "./ctx"
import { type DriveClient, type DriveFile, DriveScopeError, driveClient } from "./drive"
import {
  accessOf,
  DRIVE_FOLDER_MIME,
  GOOGLE_SHORTCUT_MIME,
  googleExportMimeFor,
  isTextMime,
  pickedItemsOf,
  sourceAccount,
  XLSX_MIME,
} from "./model"

/** Children listed per page (one run): each text file is one more Drive call. */
const PAGE_SIZE = 25
/** Folders waiting on the stack, at most (the cursor stays small). */
const MAX_STACK = 200
const LIST_FIELDS =
  "files(id,name,mimeType,webViewLink,modifiedTime,capabilities,shortcutDetails,resourceKey,trashed,driveId),nextPageToken"

interface Frame {
  /** The folder to list. */
  id: string
  /** The Knowledge folder its children go in: itself, or null for the source's root collection. */
  parent: string | null
}

interface Cursor {
  stack: Frame[]
  pageToken?: string
}

export interface SyncInput {
  sourceId: string
  kind: string
  config: Record<string, unknown>
  cursor: unknown
  /** Whose source it is: a person's own, or the organization's. */
  scope?: "personal" | "organization"
}

function cursorOf(raw: unknown): Cursor | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Cursor).stack)) return null
  return raw as Cursor
}

/** The text of a file, or null when it has none (or it cannot be read now). */
async function textOf(ctx: DriveCtx, client: DriveClient, file: DriveFile): Promise<string | null> {
  const exportMime = googleExportMimeFor(file.mimeType)
  try {
    if (exportMime) return await client.text(file, exportMime)
    if (file.capabilities?.canDownload === false) return null
    if (file.mimeType === XLSX_MIME) return await client.workbookText(file)
    if (isTextMime(file.mimeType)) return await client.text(file, null)
  } catch (err) {
    if (err instanceof DriveScopeError) throw err
    // One unreadable file (too large, a damaged workbook) does not stop the folder.
    ctx.logger.warn("drive sync: a file was skipped", { file: file.id, error: String(err) })
  }
  return null
}

function docOf(file: DriveFile, body: string, parent: string | null): KnowledgeSyncDocument {
  return {
    externalId: file.id,
    title: file.name || "Untitled",
    body,
    ...(file.webViewLink ? { url: file.webViewLink } : {}),
    mimeType: file.mimeType,
    ...(file.modifiedTime ? { modifiedAt: file.modifiedTime, rev: file.modifiedTime } : {}),
    ...(parent ? { folderId: parent } : {}),
  }
}

/** Nothing to read now: hide what the source held (archived until a pass sees it again). */
const HIDE: KnowledgeSyncResult<Cursor> = { done: true, prune: true, nextCursor: null }

async function clientFor(ctx: DriveCtx, input: SyncInput): Promise<DriveClient> {
  const identifier = typeof input.config.account === "string" ? input.config.account : undefined
  const account = await sourceAccount(ctx, input.scope === "personal", identifier)
  if (!account) {
    throw new Error(
      `No active Google Drive connection${identifier ? ` for ${identifier}` : ""} to sync this source through: reconnect Google Drive.`,
    )
  }
  return driveClient(ctx, accessOf(account))
}

/** One page of a depth-first walk from `cursor`. */
async function walk(
  ctx: DriveCtx,
  client: DriveClient,
  cursor: Cursor,
): Promise<KnowledgeSyncResult<Cursor>> {
  const frame = cursor.stack[cursor.stack.length - 1]
  if (!frame) return { done: true, prune: true, nextCursor: null }
  const res = await client.list({
    q: `'${frame.id}' in parents and trashed = false`,
    pageSize: PAGE_SIZE,
    fields: LIST_FIELDS,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageToken: cursor.pageToken,
  })
  const documents: KnowledgeSyncDocument[] = []
  const folders: KnowledgeSyncFolder[] = []
  const pushed: Frame[] = []
  for (const file of res.files) {
    if (file.mimeType === DRIVE_FOLDER_MIME) {
      folders.push({ externalId: file.id, name: file.name || "Untitled folder", parentExternalId: frame.parent })
      pushed.push({ id: file.id, parent: file.id })
      continue
    }
    if (file.mimeType === GOOGLE_SHORTCUT_MIME) continue
    const body = await textOf(ctx, client, file)
    if (body !== null) documents.push(docOf(file, body, frame.parent))
  }
  const stack = res.nextPageToken ? cursor.stack : cursor.stack.slice(0, -1)
  const next: Cursor = { stack: [...stack, ...pushed], ...(res.nextPageToken ? { pageToken: res.nextPageToken } : {}) }
  if (next.stack.length > MAX_STACK) {
    throw new Error(`This Drive folder tree is too wide to sync (over ${MAX_STACK} folders waiting): sync a smaller folder.`)
  }
  const done = next.stack.length === 0
  return {
    documents: { upsert: documents },
    ...(folders.length > 0 ? { folders: { upsert: folders } } : {}),
    nextCursor: done ? null : next,
    done,
    ...(done ? { prune: true } : {}),
  }
}

/** `knowledgeSources.folder`: a Drive folder and its subfolders. */
export async function syncDriveFolder(input: SyncInput, ctx: DriveCtx): Promise<KnowledgeSyncResult<Cursor>> {
  const ref = typeof input.config.ref === "string" ? input.config.ref : ""
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(ref)) throw new Error("This Drive source names no folder (config.ref)")
  const client = await clientFor(ctx, input)
  let cursor = cursorOf(input.cursor)
  try {
    if (!cursor) {
      // A pass starts: the root must be readable through the account's scope.
      if (client.access.scope.kind === "sharedDrives") await client.metadata(ref)
      cursor = { stack: [{ id: ref, parent: null }] }
    }
    return await walk(ctx, client, cursor)
  } catch (err) {
    if (err instanceof DriveScopeError) {
      ctx.logger.warn("drive sync: outside the organization's chosen shared drives, content hidden", {
        source: input.sourceId,
        code: err.code,
      })
      return HIDE
    }
    throw err
  }
}

/** `knowledgeSources.picked`: what a person picked on one account. */
export async function syncPickedFiles(input: SyncInput, ctx: DriveCtx): Promise<KnowledgeSyncResult<Cursor>> {
  const client = await clientFor(ctx, input)
  const account = (await ctx.accounts.list("drive")).find((a) => a.id === client.access.accountId)
  const picked = account ? pickedItemsOf(account.metadata) : []
  let cursor = cursorOf(input.cursor)
  try {
    if (!cursor) {
      // First page: the picked files themselves (no folder), and the picked folders pushed.
      const documents: KnowledgeSyncDocument[] = []
      const folders: KnowledgeSyncFolder[] = []
      const stack: Frame[] = []
      for (const item of picked) {
        let meta: DriveFile
        try {
          meta = await client.metadata(item.id)
        } catch (err) {
          if (err instanceof DriveScopeError && err.code === "SHARED_DRIVES_NOT_CHOSEN") throw err
          // A pick that is gone (deleted, access revoked) is left out: the prune removes it.
          continue
        }
        if (meta.trashed) continue
        if (meta.mimeType === DRIVE_FOLDER_MIME) {
          folders.push({ externalId: meta.id, name: meta.name || item.name, parentExternalId: null })
          stack.push({ id: meta.id, parent: meta.id })
          continue
        }
        const body = await textOf(ctx, client, meta)
        if (body !== null) documents.push(docOf(meta, body, null))
      }
      const done = stack.length === 0
      return {
        documents: { upsert: documents },
        ...(folders.length > 0 ? { folders: { upsert: folders } } : {}),
        nextCursor: done ? null : { stack },
        done,
        ...(done ? { prune: true } : {}),
      }
    }
    return await walk(ctx, client, cursor)
  } catch (err) {
    if (err instanceof DriveScopeError) return HIDE
    throw err
  }
}
