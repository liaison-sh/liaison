// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Drive REST calls of one connected account, with its read scope enforced
// HERE, the one place every read path shares (agent tools, Knowledge sync, the
// picker): every call goes through `ctx.fetch` with the account's token added
// by the host (`auth.account`), so this code never holds a token.
//
// - personal scope: the calls as Google answers them;
// - an organization connection's shared-drives scope: a listing runs per chosen
//   drive (`corpora=drive&driveId`) and keeps only files of that drive; a by-id
//   read (metadata, download, export) first checks the file's `driveId` is
//   chosen and refuses it otherwise; with no drive chosen every read is refused.

import type { AppContext } from "@liaison/app-sdk"
import {
  type DriveAccess,
  type DriveScope,
  ORG_UPLOAD_UNSUPPORTED_MESSAGE,
  OUTSIDE_SHARED_DRIVES_MESSAGE,
  SHARED_DRIVES_NOT_CHOSEN_MESSAGE,
  type SharedDrive,
} from "./model"

export const DRIVE_API = "https://www.googleapis.com/drive/v3"
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"

export type DriveFetch = Pick<AppContext, "fetch">

export class DriveHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message)
    this.name = "DriveHttpError"
  }
}

export type DriveScopeCode = "SHARED_DRIVES_NOT_CHOSEN" | "OUTSIDE_SHARED_DRIVES" | "ORG_UPLOAD_UNSUPPORTED"

/**
 * A read refused by the connection's scope. 404 for a file outside the chosen
 * shared drives (to the caller it does not exist), 409 for an org connection
 * with no shared drive chosen (a state to fix, not a missing file).
 */
export class DriveScopeError extends DriveHttpError {
  constructor(readonly code: DriveScopeCode) {
    super(
      code === "OUTSIDE_SHARED_DRIVES" ? 404 : 409,
      code === "SHARED_DRIVES_NOT_CHOSEN"
        ? SHARED_DRIVES_NOT_CHOSEN_MESSAGE
        : code === "ORG_UPLOAD_UNSUPPORTED"
          ? ORG_UPLOAD_UNSUPPORTED_MESSAGE
          : OUTSIDE_SHARED_DRIVES_MESSAGE,
      code,
    )
    this.name = "DriveScopeError"
  }
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  webViewLink?: string
  modifiedTime?: string
  capabilities?: { canDownload?: boolean }
  shortcutDetails?: { targetId?: string; targetMimeType?: string }
  resourceKey?: string
  trashed?: boolean
  driveId?: string
  parents?: string[]
  size?: string
}

export const METADATA_FIELDS =
  "id,name,mimeType,webViewLink,modifiedTime,capabilities,shortcutDetails,resourceKey,trashed,driveId,parents,size"
export const LIST_FIELDS = `files(${METADATA_FIELDS}),incompleteSearch,nextPageToken`

export interface DriveList {
  files: DriveFile[]
  incompleteSearch?: boolean
  nextPageToken?: string
}

function query(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.join("&")
}

function errorOf(status: number, body: string): DriveHttpError {
  let reason: string | undefined
  let message = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string; errors?: Array<{ reason?: string }>; details?: Array<{ reason?: string }> }
    }
    reason = parsed.error?.errors?.[0]?.reason ?? parsed.error?.details?.[0]?.reason
    if (parsed.error?.message) message = parsed.error.message
  } catch {
    // Not JSON: the raw text is the message.
  }
  return new DriveHttpError(status, `Google Drive answered ${status}: ${message}`, reason)
}

/** The shared drives a scope reads, or null for an unrestricted (personal) scope. */
function chosenDrives(scope: DriveScope): readonly SharedDrive[] | null {
  if (scope.kind === "all") return null
  if (scope.drives.length === 0) throw new DriveScopeError("SHARED_DRIVES_NOT_CHOSEN")
  return scope.drives
}

const FANOUT_PREFIX = "sd1."

function encodeFanout(tokens: Record<string, string>): string | undefined {
  if (Object.keys(tokens).length === 0) return undefined
  return FANOUT_PREFIX + encodeURIComponent(JSON.stringify(tokens))
}

function decodeFanout(token: unknown): Record<string, string> | null {
  if (typeof token !== "string" || !token.startsWith(FANOUT_PREFIX)) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(token.slice(FANOUT_PREFIX.length)))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v
    return out
  } catch {
    return null
  }
}

export interface DriveClient {
  readonly access: DriveAccess
  list(params: Record<string, unknown>): Promise<DriveList>
  metadata(id: string): Promise<DriveFile>
  /** A file's text: a native file exported as `exportMime`, else downloaded. */
  text(file: DriveFile, exportMime: string | null): Promise<string>
  /** An Excel workbook's sheets as text (the host converts it). */
  workbookText(file: DriveFile): Promise<string>
  sharedDrives(): Promise<SharedDrive[]>
  findTaggedFolder(tagKey: string): Promise<string | null>
  createFolder(name: string, appProperties: Record<string, string>): Promise<string>
  upload(input: {
    name: string
    mimeType: string
    parentId: string
    media: { fileId: string } | { base64: string }
  }): Promise<{ id: string; webViewLink?: string }>
  /** The URL a download of `file` reads (for a host-side import). */
  mediaUrl(file: DriveFile): string
  /** The headers a download of `file` needs besides the token. */
  mediaHeaders(file: DriveFile): Record<string, string>
}

export function driveClient(ctx: DriveFetch, access: DriveAccess): DriveClient {
  const auth = { connection: "drive", account: access.accountId, scheme: "bearer" as const }
  /** Files already checked to sit in a chosen drive (per client). */
  const inScope = new Set<string>()

  async function call(
    url: string,
    opts: { method?: string; headers?: Record<string, string>; body?: unknown; convert?: "xlsx-text"; timeoutMs?: number } = {},
  ): Promise<string> {
    const res = await ctx.fetch(url, { ...(opts as Record<string, unknown>), auth } as never)
    if (res.status < 200 || res.status >= 300) throw errorOf(res.status, res.body)
    return res.body
  }

  async function listOnce(params: Record<string, unknown>): Promise<DriveList> {
    const p = { fields: LIST_FIELDS, ...params }
    const parsed = JSON.parse(await call(`${DRIVE_API}/files?${query(p)}`)) as Partial<DriveList>
    return { ...parsed, files: parsed.files ?? [] }
  }

  async function metadataOnce(id: string): Promise<DriveFile> {
    const q = query({ fields: METADATA_FIELDS, supportsAllDrives: true })
    return JSON.parse(await call(`${DRIVE_API}/files/${encodeURIComponent(id)}?${q}`)) as DriveFile
  }

  async function scopedMetadata(id: string): Promise<DriveFile> {
    const drives = chosenDrives(access.scope)
    let meta: DriveFile
    try {
      meta = await metadataOnce(id)
    } catch (err) {
      // For an org connection a file Google does not know answers exactly as one
      // outside the chosen drives: a member cannot tell which ids exist in the
      // connecting account's own Drive.
      if (drives && err instanceof DriveHttpError && err.status === 404) {
        throw new DriveScopeError("OUTSIDE_SHARED_DRIVES")
      }
      throw err
    }
    if (drives && !drives.some((d) => d.id === meta.driveId)) {
      throw new DriveScopeError("OUTSIDE_SHARED_DRIVES")
    }
    if (drives) inScope.add(id)
    return meta
  }

  async function readable(file: DriveFile): Promise<void> {
    if (chosenDrives(access.scope) && !inScope.has(file.id)) await scopedMetadata(file.id)
  }

  function writable(): void {
    // An organization connection writes nothing: its uploads would land in the
    // connecting account's own My Drive, outside the shared drives the team sees.
    if (access.scope.kind !== "all") throw new DriveScopeError("ORG_UPLOAD_UNSUPPORTED")
  }

  const mediaHeaders = (file: DriveFile): Record<string, string> =>
    // Shared-drive items with a resource key need it for a download (404 otherwise).
    file.resourceKey ? { "X-Goog-Drive-Resource-Keys": `${file.id}/${file.resourceKey}` } : {}

  return {
    access,
    async list(params) {
      const drives = chosenDrives(access.scope)
      if (!drives) return listOnce(params)
      // One listing per chosen drive, merged; the page token carries each
      // drive's own. `corpora`/`driveId` are ours: a caller cannot widen them.
      const tokens = decodeFanout(params.pageToken)
      const targets = tokens ? drives.filter((d) => tokens[d.id]) : drives
      const files: DriveFile[] = []
      const next: Record<string, string> = {}
      let incompleteSearch = false
      for (const drive of targets) {
        const res = await listOnce({
          ...params,
          corpora: "drive",
          driveId: drive.id,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageToken: tokens?.[drive.id],
        })
        for (const f of res.files) {
          // Only files Google says live in this drive.
          if (f.driveId !== drive.id) continue
          inScope.add(f.id)
          files.push(f)
        }
        if (res.nextPageToken) next[drive.id] = res.nextPageToken
        if (res.incompleteSearch) incompleteSearch = true
      }
      const nextPageToken = encodeFanout(next)
      return { files, ...(incompleteSearch ? { incompleteSearch } : {}), ...(nextPageToken ? { nextPageToken } : {}) }
    },
    metadata: scopedMetadata,
    async text(file, exportMime) {
      await readable(file)
      const id = encodeURIComponent(file.id)
      if (exportMime) {
        const q = query({ mimeType: exportMime, supportsAllDrives: true })
        return call(`${DRIVE_API}/files/${id}/export?${q}`)
      }
      const q = query({ alt: "media", supportsAllDrives: true })
      return call(`${DRIVE_API}/files/${id}?${q}`, { headers: mediaHeaders(file) })
    },
    async workbookText(file) {
      await readable(file)
      const q = query({ alt: "media", supportsAllDrives: true })
      return call(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?${q}`, {
        headers: mediaHeaders(file),
        convert: "xlsx-text",
      })
    },
    async sharedDrives() {
      // Google lists only the drives the connecting account is a member of.
      const out: SharedDrive[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 20; page++) {
        const q = query({ pageSize: 100, fields: "drives(id,name),nextPageToken", pageToken })
        const body = JSON.parse(await call(`${DRIVE_API}/drives?${q}`)) as {
          drives?: Array<{ id?: string; name?: string }>
          nextPageToken?: string
        }
        for (const d of body.drives ?? []) if (d.id && d.name) out.push({ id: d.id, name: d.name })
        pageToken = body.nextPageToken
        if (!pageToken) break
      }
      return out
    },
    async findTaggedFolder(tagKey) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tagKey)) throw new Error("Invalid folder tag key")
      writable()
      const res = await listOnce({
        q: `mimeType = 'application/vnd.google-apps.folder' and trashed = false and appProperties has { key='${tagKey}' and value='1' }`,
        pageSize: 1,
        fields: "files(id,name)",
      })
      return res.files[0]?.id ?? null
    },
    async createFolder(name, appProperties) {
      writable()
      const body = await call(`${DRIVE_API}/files?${query({ fields: "id" })}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", appProperties }),
      })
      return (JSON.parse(body) as { id: string }).id
    },
    async upload(input) {
      writable()
      const metadata = JSON.stringify({ name: input.name, mimeType: input.mimeType, parents: [input.parentId] })
      const media =
        "fileId" in input.media
          ? { name: "media", fileId: input.media.fileId, contentType: input.mimeType }
          : { name: "media", base64: input.media.base64, contentType: input.mimeType }
      const q = query({ uploadType: "multipart", fields: "id,webViewLink", supportsAllDrives: true })
      const body = await call(`${DRIVE_UPLOAD_API}/files?${q}`, {
        method: "POST",
        body: {
          related: true,
          multipart: [{ name: "metadata", value: metadata, contentType: "application/json; charset=UTF-8" }, media],
        },
        timeoutMs: 120_000,
      })
      return JSON.parse(body) as { id: string; webViewLink?: string }
    },
    mediaUrl: (file) =>
      `${DRIVE_API}/files/${encodeURIComponent(file.id)}?${query({ alt: "media", supportsAllDrives: true })}`,
    mediaHeaders,
  }
}

/** Whether an error is a refusal by the connection's scope (named for the agent). */
export function scopeRefusal(err: unknown): { error: { code: string; message: string } } | null {
  if (!(err instanceof DriveScopeError)) return null
  return {
    error: {
      code:
        err.code === "SHARED_DRIVES_NOT_CHOSEN"
          ? "shared_drives_not_chosen"
          : err.code === "ORG_UPLOAD_UNSUPPORTED"
            ? "org_drive_upload_unsupported"
            : "outside_shared_drives",
      message: err.message,
    },
  }
}
