// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real HTTP IO for the Google Drive REST v3 API.
 *
 * Three responsibilities:
 *   1. Centralise `Authorization: Bearer <token>` + URL composition.
 *   2. Translate HTTP errors into the typed shape the adapter expects
 *      (`OAUTH_REVOKED`, `RATE_LIMITED`, or a generic `DriveHttpError`).
 *   3. Enforce a 10 MB body cap on Google Doc exports so a runaway file
 *      cannot exhaust process memory (IT-5).
 *
 * The factory `makeDriveFetchers(getAccess)` returns a `GoogleDriveAdapterDeps`
 * fragment that can be spread into `createGoogleDriveAdapter`. Callers that
 * want to stub the HTTP layer (tests) bypass the factory and inject the deps
 * directly — there is no shared mutable state.
 *
 * All HTTP IO goes through the SSRF-safe outbound helper (DNS pinning, private-
 * network block, redirect re-validation) so a malicious/misconfigured
 * `DRIVE_API_BASE_URL` cannot be used to reach internal infrastructure.
 */

import {
  type DriveAccess,
  type DriveScope,
  ORG_UPLOAD_UNSUPPORTED_MESSAGE,
  OUTSIDE_SHARED_DRIVES_MESSAGE,
  SHARED_DRIVES_NOT_CHOSEN_MESSAGE,
  type SharedDrive,
} from "~/apps/google-drive/drive-scope"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import { readStreamCapped } from "~/lib/read-capped-body"

const DRIVE_API_BASE = process.env.DRIVE_API_BASE_URL ?? "https://www.googleapis.com/drive/v3"
/** files.create with media travels on the SEPARATE upload host path. Tests
 *  stub the outbound-fetch seam, so the default only matters in production. */
const DRIVE_UPLOAD_API_BASE =
  process.env.DRIVE_UPLOAD_API_BASE_URL ?? "https://www.googleapis.com/upload/drive/v3"
const EXPORT_SIZE_CAP_BYTES = 10 * 1024 * 1024 // 10 MB
/** Binary-download ceiling — a Drive file larger than this cannot be imported. */
const ATTACHMENT_SIZE_CAP_BYTES = 50 * 1024 * 1024 // 50 MB

export class DriveHttpError extends Error {
  status: number
  code?: string
  /** Google's machine reason from the error body (e.g. `storageQuotaExceeded`,
   *  `userRateLimitExceeded`, `insufficientScopes`) — captured so callers can
   *  map a 403 to the RIGHT named error instead of guessing. Never a secret. */
  reason?: string
  constructor(status: number, message: string, code?: string, reason?: string) {
    super(message)
    this.name = "DriveHttpError"
    this.status = status
    this.code = code
    this.reason = reason
  }
}

/** Best-effort extraction of Google's error reason + message from a response
 *  body. Drive error bodies look like
 *  `{"error": {"errors": [{"reason": "...", "message": "..."}], "message": "..."}}`.
 *  Returns nothing on unparseable bodies — the status-only error still throws. */
async function readErrorDetail(res: Response): Promise<{ reason?: string; message?: string }> {
  try {
    const body = (await res.json()) as {
      error?: {
        message?: string
        status?: string
        errors?: Array<{ reason?: string; message?: string }>
      }
    }
    const first = body.error?.errors?.[0]
    return {
      reason: first?.reason ?? body.error?.status,
      message: first?.message ?? body.error?.message,
    }
  } catch {
    return {}
  }
}

async function driveFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchWithPinnedHost(
    url,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      // Apply a default timeout for Drive API calls when the caller did not
      // supply one. Metadata calls get 15 s; body streaming uses a longer
      // window but is capped at the byte level by readBodyWithSizeCap.
      signal:
        (init as RequestInit & { signal?: AbortSignal }).signal ?? AbortSignal.timeout(15_000),
    },
    {
      requireHttps: true,
      // Off in production; lets a local Drive mock (DRIVE_API_BASE_URL) be used
      // under test/dev without disabling the guard for real deployments.
      allowPrivateHostsInTest: true,
    },
  )
  if (res.status === 401) throw new DriveHttpError(401, "OAuth revoked", "OAUTH_REVOKED")
  if (res.status === 429) throw new DriveHttpError(429, "Rate limited", "RATE_LIMITED")
  if (!res.ok) {
    const detail = await readErrorDetail(res)
    throw new DriveHttpError(
      res.status,
      detail.message ? `Drive HTTP ${res.status}: ${detail.message}` : `Drive HTTP ${res.status}`,
      undefined,
      detail.reason,
    )
  }
  return res
}

/**
 * Read a response body with a hard byte cap. Throws DriveHttpError(413) if
 * the stream exceeds the cap, even when Drive omits content-length. This is
 * the IT-5 floor — a malicious or pathological Google Doc cannot consume
 * unbounded memory by streaming forever.
 */
async function readBodyWithSizeCap(res: Response, capBytes: number): Promise<string> {
  if (!res.body) return await res.text()
  const bytes = await readStreamCapped(res.body, capBytes)
  if (!bytes) throw new DriveHttpError(413, `Drive body exceeds ${capBytes}-byte cap`)
  return new TextDecoder().decode(bytes)
}

/**
 * Read a response body as raw bytes with a hard cap — the binary sibling of
 * `readBodyWithSizeCap`, used by `downloadBytes` to materialise a Drive file
 * for attachment without risking unbounded memory use.
 */
async function readBytesWithSizeCap(res: Response, capBytes: number): Promise<Buffer> {
  const bytes = res.body
    ? await readStreamCapped(res.body, capBytes)
    : Buffer.from(await res.arrayBuffer())
  if (!bytes || bytes.byteLength > capBytes) {
    throw new DriveHttpError(413, `Drive body exceeds ${capBytes}-byte cap`)
  }
  return bytes
}

export interface DriveFileMetadata {
  id: string
  name: string
  mimeType: string
  webViewLink?: string
  modifiedTime?: string
  owners?: Array<{ displayName: string }>
  capabilities?: { canDownload?: boolean }
  shortcutDetails?: { targetId?: string }
  resourceKey?: string
  trashed?: boolean
  /** The shared drive the file lives in; absent for a file in someone's My Drive. */
  driveId?: string
}

const METADATA_FIELDS =
  "id,name,mimeType,webViewLink,modifiedTime,owners,capabilities,shortcutDetails,resourceKey,trashed,driveId"

const LIST_FIELDS =
  "files(id,name,mimeType,webViewLink,modifiedTime,owners,capabilities,shortcutDetails,resourceKey),incompleteSearch,nextPageToken"

/**
 * A read refused by the connection's scope (drive-scope.ts). `status` keeps the
 * callers' existing mappings right: 404 for a file outside the shared drives the
 * org connection shares (to the caller it does not exist), 409 for an org
 * connection with no shared drive chosen yet (a state to fix, not a missing file:
 * a picked item must not be archived as gone because of it).
 */
export class DriveScopeError extends DriveHttpError {
  constructor(
    code: "SHARED_DRIVES_NOT_CHOSEN" | "OUTSIDE_SHARED_DRIVES" | "ORG_UPLOAD_UNSUPPORTED",
  ) {
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

/** The shared drives a scope reads, or null for an unrestricted (personal) scope. */
function chosenDrives(scope: DriveScope): readonly SharedDrive[] | null {
  if (scope.kind === "all") return null
  if (scope.drives.length === 0) throw new DriveScopeError("SHARED_DRIVES_NOT_CHOSEN")
  return scope.drives
}

/** A files.list `fields` value that also returns each file's `driveId`. */
function withDriveIdField(fields: string): string {
  if (/files\([^)]*\bdriveId\b/.test(fields)) return fields
  return fields.includes("files(") ? fields.replace("files(", "files(driveId,") : fields
}

/**
 * The page token of a listing fanned out over several shared drives: each
 * drive's own token, by drive id. Opaque to callers, like Google's.
 */
const FANOUT_TOKEN_PREFIX = "sd1."

function encodeFanoutToken(tokens: Record<string, string>): string | undefined {
  if (Object.keys(tokens).length === 0) return undefined
  return FANOUT_TOKEN_PREFIX + Buffer.from(JSON.stringify(tokens)).toString("base64url")
}

function decodeFanoutToken(token: unknown): Record<string, string> | null {
  if (typeof token !== "string" || !token.startsWith(FANOUT_TOKEN_PREFIX)) return null
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token.slice(FANOUT_TOKEN_PREFIX.length), "base64url").toString("utf8"),
    )
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v
    return out
  } catch {
    return null
  }
}

type DriveListResult = {
  files?: DriveFileMetadata[]
  incompleteSearch?: boolean
  nextPageToken?: string
}

/**
 * The Drive REST calls of one connection, with its read scope enforced HERE,
 * the one place every read path shares (agent tools, federated Knowledge
 * search, folder sync, by-id reads):
 *
 * - personal scope: the calls as Google answers them;
 * - an org connection's shared-drives scope: a listing runs per chosen drive
 *   (`corpora=drive&driveId`) and keeps only files of that drive; a by-id read
 *   (metadata, download, export) first checks the file's `driveId` is chosen and
 *   refuses it otherwise; with no drive chosen every read is refused.
 *
 * `getAccess` resolves the token and the scope together (drive-access.ts), so no
 * caller can hold one without the other.
 */
export function makeDriveFetchers(getAccess: () => Promise<DriveAccess>) {
  /** Files already checked to sit in a chosen drive (per fetcher instance). */
  const inScope = new Set<string>()

  async function listOnce(
    token: string,
    params: Record<string, unknown>,
  ): Promise<DriveListResult> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      qs.set(k, String(v))
    }
    // Always request a stable field set so the adapter shape is honored.
    if (!qs.has("fields")) qs.set("fields", LIST_FIELDS)
    const res = await driveFetch(`${DRIVE_API_BASE}/files?${qs.toString()}`, token)
    return (await res.json()) as DriveListResult
  }

  async function metadataOnce(token: string, id: string): Promise<DriveFileMetadata> {
    const qs = new URLSearchParams({ fields: METADATA_FIELDS, supportsAllDrives: "true" })
    const res = await driveFetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(id)}?${qs.toString()}`,
      token,
    )
    return (await res.json()) as DriveFileMetadata
  }

  /** The metadata of a file the scope may read; refuses any other. */
  async function scopedMetadata(id: string): Promise<{ token: string; meta: DriveFileMetadata }> {
    const { token, readScope: scope } = await getAccess()
    const drives = chosenDrives(scope)
    let meta: DriveFileMetadata
    try {
      meta = await metadataOnce(token, id)
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
    return { token, meta }
  }

  /**
   * The token for a write (the reports folder and uploads). An organization
   * connection writes nothing: its uploads would land in the connecting
   * account's own My Drive, outside the shared drives the team sees.
   */
  async function tokenToWrite(): Promise<string> {
    const { token, readScope: scope } = await getAccess()
    if (scope.kind !== "all") throw new DriveScopeError("ORG_UPLOAD_UNSUPPORTED")
    return token
  }

  /** The token for a content read of `id`, once the scope may read the file. */
  async function tokenToRead(id: string): Promise<string> {
    const { token, readScope: scope } = await getAccess()
    if (chosenDrives(scope) && !inScope.has(id)) await scopedMetadata(id)
    return token
  }

  return {
    fetchDrive: async (params: Record<string, unknown>): Promise<DriveListResult> => {
      const { token, readScope: scope } = await getAccess()
      const drives = chosenDrives(scope)
      if (!drives) return listOnce(token, params)
      // One listing per chosen drive, merged; the page token carries each
      // drive's own. `corpora`/`driveId` are ours: a caller cannot widen them.
      const tokens = decodeFanoutToken(params.pageToken)
      const targets = tokens ? drives.filter((d) => tokens[d.id]) : drives
      const fields = withDriveIdField(
        typeof params.fields === "string" ? params.fields : LIST_FIELDS,
      )
      const files: DriveFileMetadata[] = []
      const next: Record<string, string> = {}
      let incompleteSearch = false
      for (const drive of targets) {
        const res = await listOnce(token, {
          ...params,
          fields,
          corpora: "drive",
          driveId: drive.id,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          pageToken: tokens?.[drive.id],
        })
        for (const f of res.files ?? []) {
          // Belt and braces: only files Google says live in this drive.
          if (f.driveId !== drive.id) continue
          inScope.add(f.id)
          files.push(f)
        }
        if (res.nextPageToken) next[drive.id] = res.nextPageToken
        if (res.incompleteSearch) incompleteSearch = true
      }
      return {
        files,
        ...(incompleteSearch ? { incompleteSearch } : {}),
        ...(encodeFanoutToken(next) ? { nextPageToken: encodeFanoutToken(next) } : {}),
      }
    },

    getMetadata: async (input: { id: string }): Promise<DriveFileMetadata> =>
      (await scopedMetadata(input.id)).meta,

    /**
     * The shared drives the connecting account is a member of (drives.list).
     * Google lists only the drives of the account itself, so an admin who wants
     * a drive shared connects with an account that is a member of it.
     */
    listSharedDrives: async (): Promise<SharedDrive[]> => {
      const { token } = await getAccess()
      const out: SharedDrive[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 20; page++) {
        const qs = new URLSearchParams({ pageSize: "100", fields: "drives(id,name),nextPageToken" })
        if (pageToken) qs.set("pageToken", pageToken)
        const res = await driveFetch(`${DRIVE_API_BASE}/drives?${qs.toString()}`, token)
        const body = (await res.json()) as {
          drives?: Array<{ id?: string; name?: string }>
          nextPageToken?: string
        }
        for (const d of body.drives ?? []) {
          if (d.id && d.name) out.push({ id: d.id, name: d.name })
        }
        pageToken = body.nextPageToken
        if (!pageToken) break
      }
      return out
    },

    /**
     * The app-owned folders carrying `tagKey` (the reports folder uploads land
     * in). Not a read of anyone's files: the query is fixed here, so it is the
     * one listing the shared-drives scope does not narrow (an org connection's
     * reports folder sits in the connecting account's own Drive).
     */
    findTaggedFolder: async (tagKey: string): Promise<{ id: string } | null> => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tagKey)) throw new Error("Invalid folder tag key")
      const token = await tokenToWrite()
      const res = await listOnce(token, {
        q:
          `mimeType = 'application/vnd.google-apps.folder' and trashed = false and ` +
          `appProperties has { key='${tagKey}' and value='1' }`,
        pageSize: 1,
        fields: "files(id,name)",
      })
      const id = res.files?.[0]?.id
      return id ? { id } : null
    },

    download: async (input: { id: string; resourceKey?: string }): Promise<{ text: string }> => {
      const qs = new URLSearchParams({ alt: "media", supportsAllDrives: "true" })
      const token = await tokenToRead(input.id)
      const headers: Record<string, string> = {}
      // G11: shared-drive items with a resource key require this header for
      // download. Drive returns 404 without it even when the file is shared.
      if (input.resourceKey) {
        headers["X-Goog-Drive-Resource-Keys"] = `${input.id}/${input.resourceKey}`
      }
      const res = await driveFetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(input.id)}?${qs.toString()}`,
        token,
        { headers },
      )
      const text = await readBodyWithSizeCap(res, EXPORT_SIZE_CAP_BYTES)
      return { text }
    },

    /**
     * Download a Drive file's raw bytes (not extracted text) so it can be
     * materialised into a `kernel.files` row and attached to a message.
     * Native Google Docs/Sheets/Slides have no binary form: when the caller
     * passes the file's `mimeType`, this rejects `application/vnd.google-apps.*`
     * with a clear error rather than letting Drive return an opaque 4xx.
     */
    downloadBytes: async (input: {
      id: string
      resourceKey?: string
      mimeType?: string
    }): Promise<{ bytes: Buffer; mimeType: string }> => {
      if ((input.mimeType ?? "").startsWith("application/vnd.google-apps.")) {
        throw new Error(
          "Google Docs, Sheets, and Slides have no binary form and must be exported, not downloaded.",
        )
      }
      const qs = new URLSearchParams({ alt: "media", supportsAllDrives: "true" })
      const token = await tokenToRead(input.id)
      const headers: Record<string, string> = {}
      if (input.resourceKey) {
        headers["X-Goog-Drive-Resource-Keys"] = `${input.id}/${input.resourceKey}`
      }
      const res = await driveFetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(input.id)}?${qs.toString()}`,
        token,
        { headers },
      )
      const bytes = await readBytesWithSizeCap(res, ATTACHMENT_SIZE_CAP_BYTES)
      return {
        bytes,
        mimeType: res.headers.get("content-type") ?? "application/octet-stream",
      }
    },

    /**
     * Create a folder (files.create, metadata-only JSON). Used to mint the
     * app-owned reports folder that `drive.file` uploads land in. The folder
     * is TAGGED via `appProperties` so the lookup can tell it apart from any
     * same-named folder the user created themselves (the token is a UNION of
     * drive.readonly + drive.file, so listings see the whole Drive).
     */
    createFolder: async (input: {
      name: string
      appProperties?: Record<string, string>
    }): Promise<{ id: string }> => {
      const token = await tokenToWrite()
      const qs = new URLSearchParams({ fields: "id" })
      const res = await driveFetch(`${DRIVE_API_BASE}/files?${qs.toString()}`, token, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          name: input.name,
          mimeType: "application/vnd.google-apps.folder",
          ...(input.appProperties ? { appProperties: input.appProperties } : {}),
        }),
      })
      return (await res.json()) as { id: string }
    },

    /**
     * files.create with uploadType=multipart — ONE request carrying the JSON
     * metadata part + the raw file bytes (multipart/related). This is the v1
     * upload path (contentBase64 ≤ 5 MB app-side); resumable uploads are out
     * of scope. Returns the created file's id + webViewLink.
     */
    uploadMultipart: async (input: {
      name: string
      mimeType: string
      bytes: Buffer
      parentId?: string
    }): Promise<{ id: string; webViewLink?: string }> => {
      const token = await tokenToWrite()
      const boundary = `liaison-drive-${crypto.randomUUID()}`
      const metadata = {
        name: input.name,
        mimeType: input.mimeType,
        ...(input.parentId ? { parents: [input.parentId] } : {}),
      }
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: ${input.mimeType}\r\n\r\n`,
          "utf8",
        ),
        input.bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
      ])
      const qs = new URLSearchParams({
        uploadType: "multipart",
        fields: "id,webViewLink",
        supportsAllDrives: "true",
      })
      const res = await driveFetch(`${DRIVE_UPLOAD_API_BASE}/files?${qs.toString()}`, token, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
        // Uploads move more bytes than metadata calls — widen the timeout.
        signal: AbortSignal.timeout(60_000),
      })
      return (await res.json()) as { id: string; webViewLink?: string }
    },

    exportGoogleDoc: async (input: { id: string; mimeType: string }): Promise<{ text: string }> => {
      const qs = new URLSearchParams({
        mimeType: input.mimeType,
        supportsAllDrives: "true",
      })
      const token = await tokenToRead(input.id)
      const res = await driveFetch(
        `${DRIVE_API_BASE}/files/${encodeURIComponent(input.id)}/export?${qs.toString()}`,
        token,
      )
      const text = await readBodyWithSizeCap(res, EXPORT_SIZE_CAP_BYTES)
      return { text }
    },
  }
}

export { EXPORT_SIZE_CAP_BYTES }
