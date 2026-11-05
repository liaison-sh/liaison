// SPDX-License-Identifier: FSL-1.1-ALv2
import { randomUUID } from "node:crypto"
import { type SQL, sql } from "drizzle-orm"
import * as jose from "jose"
import { z } from "zod"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { UUID_RE } from "~/lib/uuid"

const K = sql.raw(schemaRef("kernel"))

import { type StorageDelivery, storageDelivery } from "~/infra/storage/delivery"
import {
  deleteObject as defaultDeleteObject,
  headObject as defaultHeadObject,
  presignGet as defaultPresignGet,
  presignPut as defaultPresignPut,
  putObject as defaultPutObject,
  type HeadResult,
  sanitizeFilename,
} from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import { manifestFileParentRegistry } from "~/modules/apps/app-registries"
import { contentDisposition } from "~/modules/files/content-disposition"
import { capOf, normalizeCaps, noteCapLevel } from "~/modules/org/caps"
import { hasScope } from "~/modules/permissions/permissions"

/** Strip surrounding angle brackets from a Content-ID and trim whitespace. */
function normalizeContentId(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim()
  return v.length === 0 ? null : v
}

const FILE_TOKEN_AUDIENCE = "file-upload"
const FILE_TOKEN_TTL_SECONDS = 15 * 60

export interface FileTokenPayload {
  orgId: string
  userId: string
  app: string
  entityType: string
  entityId: string
  storageKey: string
  filename: string
  mimeType: string
  sizeBytes: number
}

// Defense-in-depth: file tokens are HS256-signed by us (signFileToken), so a
// verified payload is authentic. This schema does NOT guard against forgery — it
// rejects a malformed/missing claim (an absent `storageKey`, a non-number
// `sizeBytes`) before it propagates untyped into S3 HEAD / `kernel.files` writes
// via the blind casts this replaces. Every claim is required (the builder always
// sets all of them); a missing or wrong-typed claim throws in verifyFileToken,
// which confirmUpload already maps to INVALID_TOKEN.
const fileTokenPayloadSchema = z.object({
  orgId: z.string(),
  userId: z.string(),
  app: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  storageKey: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
})

export async function signFileToken(
  payload: FileTokenPayload,
  secret: string = env.JWT_SECRET,
  ttlSeconds: number = FILE_TOKEN_TTL_SECONDS,
): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(FILE_TOKEN_AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key)
}

export async function verifyFileToken(
  token: string,
  secret: string = env.JWT_SECRET,
): Promise<FileTokenPayload> {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jose.jwtVerify(token, key, { audience: FILE_TOKEN_AUDIENCE })
  // Validate the verified claims instead of blind-casting. safeParse → throw a
  // clear error; confirmUpload's try/catch maps any throw here to INVALID_TOKEN.
  const parsed = fileTokenPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`Invalid file token payload: ${parsed.error.message}`)
  }
  return parsed.data
}

// --- Download capability tokens ---------------------------------------------
// The download twin of the upload token: a short-TTL HS256 token that pins ONE
// file's storage key, minted only after an RLS visibility check (getRelayDownloadUrl).
// It is the capability the fileDownloadRelay route trusts, so the object store
// itself never needs a public endpoint — the app streams the bytes. Separate
// audience from the upload token so an upload token can never be replayed as a
// download grant (or vice-versa).
const FILE_DOWNLOAD_TOKEN_AUDIENCE = "file-download"
const FILE_DOWNLOAD_TOKEN_DEFAULT_TTL_SECONDS = 5 * 60
const FILE_DOWNLOAD_TOKEN_MAX_TTL_SECONDS = 15 * 60

export interface FileDownloadTokenPayload {
  orgId: string
  fileId: string
  storageKey: string
  filename: string
  mimeType: string
}

const fileDownloadTokenPayloadSchema = z.object({
  orgId: z.string(),
  fileId: z.string(),
  storageKey: z.string(),
  filename: z.string(),
  mimeType: z.string(),
})

export async function signFileDownloadToken(
  payload: FileDownloadTokenPayload,
  secret: string = env.JWT_SECRET,
  ttlSeconds: number = FILE_DOWNLOAD_TOKEN_DEFAULT_TTL_SECONDS,
): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new jose.SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setAudience(FILE_DOWNLOAD_TOKEN_AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key)
}

export async function verifyFileDownloadToken(
  token: string,
  secret: string = env.JWT_SECRET,
): Promise<FileDownloadTokenPayload> {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jose.jwtVerify(token, key, {
    audience: FILE_DOWNLOAD_TOKEN_AUDIENCE,
  })
  const parsed = fileDownloadTokenPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    throw new Error(`Invalid file download token payload: ${parsed.error.message}`)
  }
  return parsed.data
}

export class FileServiceError extends Error {
  constructor(
    public readonly code:
      | "PARENT_NOT_FOUND"
      | "FORBIDDEN"
      | "FILE_TOO_LARGE"
      | "STORAGE_QUOTA_EXCEEDED"
      | "INVALID_TOKEN"
      | "FILE_VERIFY_FAILED"
      | "STORAGE_UNAVAILABLE"
      | "SESSION_EXPIRED"
      | "TARGET_MISMATCH"
      | "UNSAFE_FILE_TYPE"
      | "ALREADY_CONFIRMED"
      | "NOT_FOUND"
      | "RETAINED",
    message: string,
  ) {
    super(message)
    this.name = "FileServiceError"
  }
}

export interface ParentResolution {
  schemaRef: string
  tableName: string
  joinOn: string
  readScope: string
  writeScope: string
  /**
   * Who may DELETE a file on this parent, beyond writeScope: its uploader, or
   * a holder of this scope. Absent: writeScope (with the parent visible) is
   * enough, as for every kernel parent.
   */
  deleteScope?: string
  /** A soft-delete column: a parent row with it set is not visible for files. */
  softDeleteColumn?: string
  /** Parent rows in an immutable table: their files cannot be deleted within the period. */
  retention?: { retentionYears: number; anchor: string }
}

const KERNEL_PARENTS: Record<string, ParentResolution> = {
  thread: {
    schemaRef: "kernel",
    tableName: "threads",
    joinOn: "id",
    readScope: "kernel:threads:read",
    writeScope: "kernel:threads:write",
  },
  // Messages inherit thread permissions — there is no separate
  // `kernel:messages:*` scope. Anyone with `kernel:threads:write` can attach
  // files to any visible message in the org; `assertParentVisible` provides
  // row-level RLS gating. This matches the kernel's permission model where
  // message authorship and reactions live on top of thread membership.
  message: {
    schemaRef: "kernel",
    tableName: "messages",
    joinOn: "id",
    readScope: "kernel:threads:read",
    writeScope: "kernel:threads:write",
    // Nothing is attached to (or moved onto) a deleted message.
    softDeleteColumn: "deleted_at",
  },
  // Data-subject (GDPR DSR) export bundles are parented to the kernel contact
  // they describe, so the assembled artifact is discoverable on that contact
  // (files_list kernel, contact, <contactId>) and inherits the contact's RLS.
  // readScope/writeScope are kernel:contacts:read/write — a DSR-export caller
  // proves it can SEE the subject's contact (the parent-visibility check) before
  // the bundle is written, exactly like every other fileParent.
  contact: {
    schemaRef: "kernel",
    tableName: "contacts",
    joinOn: "id",
    readScope: "kernel:contacts:read",
    writeScope: "kernel:contacts:write",
  },
  // A document template's own files (migration 0255): a PDF form's sanitized
  // copy and the images its fields print. Every member who reads files reads
  // them (printing needs the template); only an org admin adds or removes one,
  // the same scope that edits the template.
  document_template: {
    schemaRef: "kernel",
    tableName: "document_templates",
    joinOn: "id",
    readScope: "kernel:files:read",
    writeScope: "kernel:org:admin",
  },
  // Sentinel entry for the upload-session staging parent.
  // `readScope` / `writeScope` are never compared directly — `authorizeUpload`
  // and `moveFilesToParent` special-case this entityType and defer permission
  // checks to the session row's stored target parent (see `createUploadSession`
  // / `moveFilesToParent`). Listed here so resolveParent("kernel",
  // "file_upload_session") returns a non-undefined value for join lookups.
  file_upload_session: {
    schemaRef: "kernel",
    tableName: "file_upload_sessions",
    joinOn: "id",
    readScope: "__upload_session_sentinel__",
    writeScope: "__upload_session_sentinel__",
  },
}

export function resolveParent(
  orgId: string,
  app: string,
  entityType: string,
): ParentResolution | undefined {
  if (app === "kernel") return KERNEL_PARENTS[entityType]
  return manifestFileParentRegistry.get([orgId, app, entityType])
}

export function buildStorageKey(args: {
  orgId: string
  app: string
  entityType: string
  entityId: string
  filename: string
  /** The key's object segment. Defaults to a random UUID; an importer passes a
   *  deterministic id so a re-run writes the same key instead of a new object. */
  objectId?: string
}): string {
  const safe = sanitizeFilename(args.filename)
  const uuid = args.objectId ?? randomUUID()
  return `orgs/${args.orgId}/${args.app}/${args.entityType}/${args.entityId}/${uuid}/${safe}`
}

export interface OrgSettings {
  fileSizeLimitMb: number
  /** The operator's storage cap in GB (`organizations.caps.storageGb`); 0 = unlimited. */
  storageQuotaGb: number
}

/**
 * The org's upload limits: the file size from its settings, the storage quota
 * from its caps (modules/org/caps.ts). The quota is the operator's: a missing
 * `caps.storageGb` is unlimited, and the old `settings.storageQuotaGb` (an org
 * admin's setting, migration 0237) is no longer read.
 */
export async function loadOrgSettings(tx: PrivilegedDb, orgId: string): Promise<OrgSettings> {
  const rows = await tx.execute<{ settings: unknown; caps: unknown }>(
    sql`SELECT settings, caps FROM ${K}.organizations WHERE id = ${orgId} LIMIT 1`,
  )
  const row = (rows as unknown as { settings?: Partial<OrgSettings>; caps?: unknown }[])[0]
  const settings = (row?.settings ?? {}) as Partial<OrgSettings>
  return {
    fileSizeLimitMb: settings.fileSizeLimitMb ?? 50,
    storageQuotaGb: capOf(normalizeCaps(row?.caps), "storageGb") ?? 0,
  }
}

/**
 * Effective org storage quota in bytes, or null for UNLIMITED.
 * `storageQuotaGb <= 0` means no quota — the self-hosted default, where the
 * operator owns the disk/bucket and sets a cap only when they want one.
 */
export function orgQuotaBytes(settings: OrgSettings): number | null {
  if (settings.storageQuotaGb <= 0) return null
  return settings.storageQuotaGb * 1024 * 1024 * 1024
}

/**
 * The 80 % / 100 % storage notices to the org admins (modules/org/caps.ts),
 * from bytes actually stored: the usage before a write, or after a write that
 * is being committed (confirmUpload). Never from a size merely attempted: a
 * refused or planned write stores nothing.
 */
export function noteStorageLevel(orgId: string, storedBytes: number, quotaBytes: number): void {
  const gb = 1024 ** 3
  noteCapLevel(orgId, "storageGb", Math.ceil((storedBytes / gb) * 100) / 100, quotaBytes / gb)
}

/**
 * True when storing `addBytes` more would push the org over its quota. The
 * ONE guard every storage path must use: it honors the unlimited posture
 * (`orgQuotaBytes` null) without even querying usage, so no caller can
 * re-derive bytes from `storageQuotaGb` and turn "unlimited" into "zero".
 */
export async function wouldExceedOrgQuota(
  tx: PrivilegedDb,
  orgId: string,
  settings: OrgSettings,
  addBytes: number,
): Promise<boolean> {
  const quotaBytes = orgQuotaBytes(settings)
  if (quotaBytes === null) return false
  const used = await currentOrgUsageBytes(tx, orgId)
  noteStorageLevel(orgId, used, quotaBytes)
  return used + addBytes > quotaBytes
}

/**
 * Why a write is stored even when the org is at its storage quota. Such a write
 * is never refused, but it is still counted in the org's usage and still raises
 * the 80 % / 100 % notices (`noteStoredOrgUsage`).
 *
 * - `system_ingest`: the server stores content arriving from outside on its own
 *   schedule (mail sync, a webhook, a system job), with no person and no agent
 *   acting. Refusing it would silently drop a customer's attachment.
 * - `legal_record`: the file belongs to a row of an immutable table with a legal
 *   retention period (a manifest `immutable.retentionYears` on the file parent's
 *   table, e.g. an issued invoice's original). The kernel already refuses to
 *   delete such files within the period; refusing to store one would lose the
 *   record itself.
 */
export type StorageQuotaExemption = "system_ingest" | "legal_record"

/**
 * The ONE place that decides whether a write is exempt from the storage quota.
 * Both signals come from the host, never from what an app or an agent passes:
 * the bridge's own actor (system, with no agent acting) and the file parent's
 * registration (its table's retention, read from the installed manifest).
 * Anything a person or an agent starts gets `null` and is refused at the quota.
 */
export function storageQuotaExemption(args: {
  actorType: "user" | "agent" | "system" | "mcp"
  actingAgentId: string | null
  parent: Pick<ParentResolution, "retention"> | undefined
}): StorageQuotaExemption | null {
  if (args.actorType === "system" && args.actingAgentId === null) return "system_ingest"
  if (args.parent?.retention) return "legal_record"
  return null
}

/**
 * Re-read the org's stored bytes after a write and feed the 80 % / 100 %
 * notices, so the write that crosses a threshold is the one that tells the
 * admins (an exempt write included: it is never refused, but it is counted).
 * No query at all when the org has no quota. Never throws.
 */
export async function noteStoredOrgUsage(tx: PrivilegedDb, orgId: string): Promise<void> {
  try {
    const quotaBytes = orgQuotaBytes(await loadOrgSettings(tx, orgId))
    if (quotaBytes === null) return
    noteStorageLevel(orgId, await currentOrgUsageBytes(tx, orgId), quotaBytes)
  } catch (err) {
    log.warn({ err, orgId }, "files: could not read the org's storage usage for the notices")
  }
}

export async function currentOrgUsageBytes(tx: PrivilegedDb, orgId: string): Promise<number> {
  const rows = await tx.execute<{ total: string | null }>(
    sql`SELECT COALESCE(SUM(size_bytes), 0)::text AS total FROM ${K}.files WHERE org_id = ${orgId}`,
  )
  const row = (rows as unknown as { total: string | null }[])[0]
  return Number(row?.total ?? 0)
}

/**
 * The delivery for one file: the deployment's decision (storageDelivery), or
 * the caller's override of the deployment switch in tests. The sealed rule
 * applies either way.
 */
function deliveryFor(file: { sealed: boolean }, override?: StorageDelivery): StorageDelivery {
  return storageDelivery(
    file,
    override === undefined ? undefined : { OBJECT_STORAGE_BROWSER_DIRECT: override === "direct" },
  )
}

export interface AuthorizeUploadInput {
  orgId: string
  userId: string
  scopes: string[]
  app: string
  entityType: string
  entityId: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface AuthorizeUploadResult {
  /**
   * Where the browser PUTs the bytes: a presigned object-store URL when
   * `uploadMode` is "direct", the API relay (`/api/file-relay/<token>`) when
   * "relay". Clients key their path off `uploadMode`.
   */
  uploadUrl: string
  uploadMode: StorageDelivery
  fileToken: string
  storageKey: string
}

export interface AuthorizeUploadDeps {
  rlsTx: RlsClient
  privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  presignPut?: typeof defaultPresignPut
  jwtSecret?: string
  tokenTtlSeconds?: number
  /** Overrides the deployment's delivery decision (tests). */
  delivery?: StorageDelivery
  /** Public base for the relay URL. Defaults to env.BASE_URL. */
  baseUrl?: string
}

interface UploadSessionRow {
  target_app: string
  target_entity_type: string
  target_entity_id: string | null
  expires_at: Date
  [key: string]: unknown
}

async function loadUploadSession(
  rlsTx: RlsClient,
  sessionId: string,
): Promise<UploadSessionRow | null> {
  const rows = await rlsTx.execute<UploadSessionRow>(
    sql`SELECT target_app, target_entity_type, target_entity_id, expires_at
        FROM ${K}.file_upload_sessions WHERE id = ${sessionId} LIMIT 1`,
  )
  const list = rows as unknown as UploadSessionRow[]
  if (list.length === 0) return null
  const row = list[0]
  // Postgres returns timestamptz as a Date already, but the mock harness may
  // pass a string. Normalize defensively.
  if (!(row.expires_at instanceof Date)) {
    row.expires_at = new Date(row.expires_at as unknown as string)
  }
  return row
}

// SQL identifier validator. KERNEL_PARENTS values are hardcoded; manifest
// fileParent entries flow through here too, so any manifest with a malformed
// identifier is rejected at the validation boundary instead of being spliced
// raw into SQL.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function assertSafeIdent(value: string, label: string): void {
  if (!IDENT_RE.test(value)) {
    throw new FileServiceError("PARENT_NOT_FOUND", `Unsafe identifier in ${label}`)
  }
}

/**
 * The declared type of a file parent's key column (`uuid`, `text`, ...), read
 * from the catalog once per process and cached. Null when the column cannot
 * be resolved (never cached, so a table created later is picked up).
 */
const parentKeyTypeCache = new Map<string, string>()

async function parentKeyType(
  tx: Pick<RlsClient, "execute">,
  schema: string,
  table: string,
  column: string,
): Promise<string | null> {
  const key = `${schema}.${table}.${column}`
  const cached = parentKeyTypeCache.get(key)
  if (cached) return cached
  const rows = (await tx.execute<{ t: string }>(
    sql`SELECT format_type(a.atttypid, NULL) AS t
          FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = to_regclass(${`"${schema}"."${table}"`})
           AND a.attname = ${column}
           AND NOT a.attisdropped`,
  )) as unknown as Array<{ t: string }>
  const t = rows[0]?.t ?? null
  if (t) parentKeyTypeCache.set(key, t)
  return t
}

export async function assertParentVisible(
  rlsTx: RlsClient,
  parent: ParentResolution,
  entityId: string,
): Promise<void> {
  const parentSchema = schemaRef(parent.schemaRef)
  assertSafeIdent(parentSchema, "parent schema")
  assertSafeIdent(parent.tableName, "parent tableName")
  assertSafeIdent(parent.joinOn, "parent joinOn")
  const ps = sql.raw(`"${parentSchema}"`)
  const pt = sql.raw(`"${parent.tableName}"`)
  const pj = sql.raw(`"${parent.joinOn}"`)
  let live = sql``
  if (parent.softDeleteColumn) {
    assertSafeIdent(parent.softDeleteColumn, "parent softDeleteColumn")
    live = sql` AND ${sql.raw(`"${parent.softDeleteColumn}"`)} IS NULL`
  }
  // Compare on the key column's own type. A `${pj}::text = $1` predicate
  // cannot use the key's index, so Postgres scans the whole parent table and
  // evaluates its SELECT policy on every row before the filter (the policy is
  // not leakproof). On `kernel.messages` that is the per-row scope match over
  // every message of every thread the caller sits in: ~10 s on production,
  // which outlived the sandbox budget of every app that attaches a file to a
  // message (an issued document posted to its contact thread, a mail sent
  // with attachments). A uuid key is matched as a uuid so the index finds the
  // one row first; anything else keeps the text comparison.
  // Parameterize the entityId so caller-controlled strings can never affect
  // SQL parsing.
  const keyType = await parentKeyType(rlsTx, parentSchema, parent.tableName, parent.joinOn)
  let match: SQL
  if (keyType === "uuid") {
    if (!UUID_RE.test(entityId)) {
      throw new FileServiceError("PARENT_NOT_FOUND", "Parent not visible to user")
    }
    match = sql`${pj} = ${entityId}::uuid`
  } else {
    match = sql`${pj}::text = ${entityId}`
  }
  const parentRows = await rlsTx.execute<{ id: string }>(
    sql`SELECT ${pj}::text AS id FROM ${ps}.${pt} WHERE ${match}${live} LIMIT 1`,
  )
  if ((parentRows as unknown as unknown[]).length === 0) {
    throw new FileServiceError("PARENT_NOT_FOUND", "Parent not visible to user")
  }
}

const UUID_SHAPE_SQL =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

/**
 * When the parent soft deletes (a message), lock its row FOR SHARE and require
 * it live, in a transaction that stays open until the file row is written
 * (the caller's RLS transaction, or the one inserting the row). A message
 * delete updates that row, so the two serialise: an attach that locks first
 * has written its row before the delete can remove the message's files (and
 * is removed with them); one that comes second sees the delete and is
 * refused, instead of landing a file on a message whose attachments were
 * already deleted. The lock is taken by `kernel.lock_live_message` (migration
 * 0178), a SECURITY DEFINER function pinned to the transaction's org:
 * visibility was checked already, a row lock needs UPDATE rights the reader
 * may not hold, and a request transaction cannot elevate. Messages are the
 * only parent with a soft-delete column; another one needs its own function.
 */
export async function lockLiveParent(
  tx: Pick<RlsClient, "execute">,
  orgId: string,
  target: { app: string; entityType: string; entityId: string },
): Promise<void> {
  const parent = resolveParent(orgId, target.app, target.entityType)
  if (!parent?.softDeleteColumn) return
  if (!UUID_RE.test(target.entityId)) {
    throw new FileServiceError("PARENT_NOT_FOUND", "Parent not found")
  }
  if (
    !(
      parent.schemaRef === "kernel" &&
      parent.tableName === "messages" &&
      parent.joinOn === "id" &&
      parent.softDeleteColumn === "deleted_at"
    )
  ) {
    throw new Error(
      `lockLiveParent: no lock function for the soft-deleting parent ${parent.schemaRef}.${parent.tableName}`,
    )
  }
  const [row] = (await tx.execute(
    sql`SELECT ${sql.raw(`"${schemaRef("kernel")}"`)}.lock_live_message(${orgId}::uuid, ${target.entityId}::uuid) AS ok`,
  )) as unknown as Array<{ ok: boolean }>
  if (!row?.ok) {
    throw new FileServiceError("PARENT_NOT_FOUND", "Parent not found or deleted")
  }
}

export async function authorizeUpload(
  input: AuthorizeUploadInput,
  deps: AuthorizeUploadDeps,
): Promise<AuthorizeUploadResult> {
  // Special-case the upload-session staging parent. Authorization defers to
  // the session's stored target so a single staging parent can correctly gate
  // thread / mail / ticket uploads.
  if (input.app === "kernel" && input.entityType === "file_upload_session") {
    const session = await loadUploadSession(deps.rlsTx, input.entityId)
    if (!session) throw new FileServiceError("FORBIDDEN", "Upload session not visible")
    if (session.expires_at.getTime() < Date.now()) {
      throw new FileServiceError("SESSION_EXPIRED", "Upload session expired")
    }
    const target = resolveParent(input.orgId, session.target_app, session.target_entity_type)
    if (!target) {
      throw new FileServiceError("PARENT_NOT_FOUND", "Session target parent unknown")
    }
    if (!hasScope(target.writeScope, input.scopes)) {
      throw new FileServiceError("FORBIDDEN", "Missing write scope on session target")
    }
    if (session.target_entity_id) {
      await assertParentVisible(deps.rlsTx, target, session.target_entity_id)
    }
    // Fall through to quota / size / presign checks below, but with parent
    // pre-validated. Use the session id as the "parent" anchor for storage key
    // construction so the staged file rows are addressable.
    return authorizeUploadCore(input, deps, { skipParentVisibility: true })
  }

  const parent = resolveParent(input.orgId, input.app, input.entityType)
  if (!parent) throw new FileServiceError("PARENT_NOT_FOUND", "Unknown file parent")

  if (!hasScope(parent.writeScope, input.scopes)) {
    throw new FileServiceError("FORBIDDEN", "Forbidden: missing write scope on parent")
  }

  await assertParentVisible(deps.rlsTx, parent, input.entityId)
  return authorizeUploadCore(input, deps, { skipParentVisibility: true })
}

async function authorizeUploadCore(
  input: AuthorizeUploadInput,
  deps: AuthorizeUploadDeps,
  _opts: { skipParentVisibility: boolean },
): Promise<AuthorizeUploadResult> {
  const settings = await deps.privileged("files:authorize", (tx) =>
    loadOrgSettings(tx, input.orgId),
  )
  const maxBytes = settings.fileSizeLimitMb * 1024 * 1024
  if (input.sizeBytes > maxBytes) {
    throw new FileServiceError("FILE_TOO_LARGE", `Exceeds ${settings.fileSizeLimitMb} MB limit`)
  }

  const quotaBytes = orgQuotaBytes(settings)
  if (quotaBytes !== null) {
    const used = await deps.privileged("files:authorize-quota", (tx) =>
      currentOrgUsageBytes(tx, input.orgId),
    )
    noteStorageLevel(input.orgId, used, quotaBytes)
    if (used + input.sizeBytes > quotaBytes) {
      throw new FileServiceError("STORAGE_QUOTA_EXCEEDED", "Org storage quota exceeded")
    }
  }

  const storageKey = buildStorageKey(input)
  const ttlSeconds = deps.tokenTtlSeconds ?? FILE_TOKEN_TTL_SECONDS
  const fileToken = await signFileToken(
    {
      orgId: input.orgId,
      userId: input.userId,
      app: input.app,
      entityType: input.entityType,
      entityId: input.entityId,
      storageKey,
      filename: sanitizeFilename(input.filename),
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
    },
    deps.jwtSecret,
    ttlSeconds,
  )

  const uploadMode = deliveryFor({ sealed: false }, deps.delivery)
  if (uploadMode === "relay") {
    const base = (deps.baseUrl ?? env.BASE_URL).replace(/\/$/, "")
    const uploadUrl = `${base}/api/file-relay/${encodeURIComponent(fileToken)}`
    return { uploadUrl, uploadMode, fileToken, storageKey }
  }

  // Direct: the presigned PUT pins the key, the exact Content-Type and the
  // exact Content-Length the quota and size checks above just accepted.
  //
  // Residual, by design: the store cannot tell a first write from a second,
  // so until the URL expires its holder (the uploader, nobody else) can PUT
  // again, with the same declared type and length, even after the confirm.
  // The relay refuses that once a row exists (storeRelayedUpload); for the
  // direct URL the bound is its lifetime, kept short for that reason.
  const presign = deps.presignPut ?? defaultPresignPut
  let uploadUrl: string
  try {
    uploadUrl = await presign({
      key: storageKey,
      contentLength: input.sizeBytes,
      contentType: input.mimeType,
      expiresInSec: DIRECT_PUT_TTL_SECONDS,
    })
  } catch (err) {
    log.warn({ err }, "presign PUT failed — storage unavailable")
    throw new FileServiceError("STORAGE_UNAVAILABLE", "Object storage unreachable")
  }
  return {
    uploadUrl,
    uploadMode,
    fileToken,
    storageKey,
  }
}

/** Lifetime of a direct presigned PUT: S3 checks it when the request starts. */
export const DIRECT_PUT_TTL_SECONDS = 5 * 60

/** Lifetime of a file token, and so of a relay upload URL. */
export const UPLOAD_TOKEN_TTL_SECONDS = FILE_TOKEN_TTL_SECONDS

/**
 * The upload-session target an agent's staged upload is recorded under. It is
 * not a file parent: the file itself is parented to the caller-owned session
 * (RLS-visible to its owner only), and only becomes visible to anyone else
 * when a send tool copies it onto a destination the caller can write.
 */
export const AGENT_UPLOAD_SESSION_TARGET = { app: "kernel", entityType: "agent_upload" } as const

export interface AuthorizeAgentUploadInput {
  orgId: string
  userId: string
  filename: string
  mimeType: string
  sizeBytes: number
}

/**
 * Authorize an agent's upload of a file that has no destination entity yet (an
 * MCP client putting a local file into Liaison). Opens a caller-owned upload
 * session, the same staging parent Drive imports and merged PDFs use, then runs
 * the exact size, quota, token and presign checks of a browser upload. The
 * confirm step is the ordinary `confirmUpload`.
 */
export async function authorizeAgentUpload(
  input: AuthorizeAgentUploadInput,
  deps: AuthorizeUploadDeps,
): Promise<AuthorizeUploadResult & { sessionId: string }> {
  const rows = (await deps.rlsTx.execute<{ id: string }>(
    sql`INSERT INTO ${K}.file_upload_sessions (org_id, created_by, target_app, target_entity_type)
        VALUES (${input.orgId}, ${input.userId}, ${AGENT_UPLOAD_SESSION_TARGET.app}, ${AGENT_UPLOAD_SESSION_TARGET.entityType})
        RETURNING id::text AS id`,
  )) as unknown as { id: string }[]
  const sessionId = rows[0]?.id
  if (!sessionId) {
    throw new FileServiceError("STORAGE_UNAVAILABLE", "Failed to open an upload session")
  }
  const result = await authorizeUploadCore(
    {
      ...input,
      scopes: [],
      app: "kernel",
      entityType: "file_upload_session",
      entityId: sessionId,
    },
    deps,
    { skipParentVisibility: true },
  )
  return { ...result, sessionId }
}

export interface CreateUploadSessionInput {
  orgId: string
  userId: string
  scopes: string[]
  targetApp: string
  targetEntityType: string
  targetEntityId: string | null
}

export interface CreateUploadSessionResult {
  id: string
  targetApp: string
  targetEntityType: string
  targetEntityId: string | null
}

export async function createUploadSession(
  input: CreateUploadSessionInput,
  deps: AuthorizeUploadDeps,
): Promise<CreateUploadSessionResult> {
  const target = resolveParent(input.orgId, input.targetApp, input.targetEntityType)
  if (!target) throw new FileServiceError("PARENT_NOT_FOUND", "Unknown target parent")
  if (!hasScope(target.writeScope, input.scopes)) {
    throw new FileServiceError("FORBIDDEN", "Missing write scope on target")
  }
  if (input.targetEntityId) {
    await assertParentVisible(deps.rlsTx, target, input.targetEntityId)
  }
  const rows = await deps.rlsTx.execute<{ id: string }>(
    sql`INSERT INTO ${K}.file_upload_sessions (org_id, created_by, target_app, target_entity_type, target_entity_id)
        VALUES (${input.orgId}, ${input.userId}, ${input.targetApp}, ${input.targetEntityType}, ${input.targetEntityId ?? null})
        RETURNING id`,
  )
  const list = rows as unknown as { id: string }[]
  if (list.length === 0) {
    throw new FileServiceError("STORAGE_UNAVAILABLE", "Failed to insert upload session")
  }
  return {
    id: list[0].id,
    targetApp: input.targetApp,
    targetEntityType: input.targetEntityType,
    targetEntityId: input.targetEntityId ?? null,
  }
}

export interface MoveFilesToParentInput {
  orgId: string
  userId: string
  scopes: string[]
  sourceSessionId: string
  target: { app: string; entityType: string; entityId: string }
  fileIds: string[]
}

export async function moveFilesToParent(
  input: MoveFilesToParentInput,
  deps: AuthorizeUploadDeps,
): Promise<void> {
  // 1) Session must exist, be owned by caller (enforced by owner-RLS), unexpired.
  const session = await loadUploadSession(deps.rlsTx, input.sourceSessionId)
  if (!session) throw new FileServiceError("FORBIDDEN", "Upload session not visible")
  if (session.expires_at.getTime() < Date.now()) {
    throw new FileServiceError("SESSION_EXPIRED", "Upload session expired")
  }

  // 2) Target must match session's stored (app, entityType) and pinned entity if any.
  if (
    session.target_app !== input.target.app ||
    session.target_entity_type !== input.target.entityType
  ) {
    throw new FileServiceError("TARGET_MISMATCH", "Target does not match session target")
  }
  if (session.target_entity_id && session.target_entity_id !== input.target.entityId) {
    throw new FileServiceError(
      "TARGET_MISMATCH",
      "Target entity differs from session-pinned entity",
    )
  }

  // 3) Caller must hold the target's writeScope and target row must be visible.
  const target = resolveParent(input.orgId, input.target.app, input.target.entityType)
  if (!target) throw new FileServiceError("PARENT_NOT_FOUND", "Unknown target parent")
  if (!hasScope(target.writeScope, input.scopes)) {
    throw new FileServiceError("FORBIDDEN", "Missing write scope on target")
  }
  await assertParentVisible(deps.rlsTx, target, input.target.entityId)
  await lockLiveParent(deps.rlsTx, input.orgId, input.target)

  // 4) All requested file ids must currently be parented to this session and belong to this org.
  if (input.fileIds.length === 0) return
  const idList = sql.join(
    input.fileIds.map((id) => sql`${id}`),
    sql`, `,
  )
  const currentRows = await deps.rlsTx.execute<{ id: string }>(
    sql`SELECT id::text AS id FROM ${K}.files
        WHERE org_id = ${input.orgId}
          AND app = 'kernel' AND entity_type = 'file_upload_session' AND entity_id = ${input.sourceSessionId}
          AND id::text IN (${idList})`,
  )
  const found = new Set((currentRows as unknown as { id: string }[]).map((r) => r.id))
  if (found.size !== input.fileIds.length) {
    throw new FileServiceError("FORBIDDEN", "Some files do not belong to the source session")
  }

  // 5) Privileged reparent.
  await deps.privileged("files:move-to-parent", async (tx) => {
    await tx.execute(
      sql`UPDATE ${K}.files
          SET app = ${input.target.app},
              entity_type = ${input.target.entityType},
              entity_id = ${input.target.entityId}
          WHERE org_id = ${input.orgId}
            AND id::text IN (${idList})`,
    )
  })
}

export interface ConfirmUploadDeps {
  /**
   * The authenticated caller's org id. When provided the file token's embedded
   * org id is compared against this value; a mismatch is rejected with
   * FORBIDDEN so a token minted for org A cannot be confirmed by a caller
   * authenticated as org B.
   */
  callerOrgId?: string
  privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  headObject?: typeof defaultHeadObject
  /** Removes an object that failed verification. */
  deleteObject?: typeof defaultDeleteObject
  jwtSecret?: string
}

export interface ConfirmUploadResult {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  thumbnailKey: string | null
  app: string
  entityType: string
  entityId: string
  disposition: string
  contentId: string | null
  originalContentId: string | null
  ordinal: number
  createdAt: Date
}

export interface ConfirmUploadMetadata {
  disposition?: "inline" | "attachment"
  contentId?: string | null
  ordinal?: number
}

/**
 * The per-org lock a confirm takes around its quota check and insert. Lower 64
 * bits of the org UUID: avoids the 32-bit hash collision surface of hashtext()
 * while still fitting the bigint parameter that pg_advisory_xact_lock requires.
 */
async function lockOrgFileRows(tx: PrivilegedDb, orgId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(('x' || right(replace(${orgId}, '-', ''), 16))::bit(64)::bigint)`,
  )
}

// The two-int form of the advisory lock lives in a keyspace apart from the
// single-bigint org lock above. A hashtext collision between two keys only
// makes one wait for the other.
const STORAGE_KEY_LOCK_CLASS = 0x46494c45 // "FILE"

/**
 * The per-object lock. Everything that decides an object's fate takes it
 * FIRST (then, for a confirm, the org lock): the confirm's HEAD, verify,
 * discard or insert, and the relay's ownership check and write. So a row
 * cannot appear between a check and a delete, and a slow store call blocks
 * only that one key.
 */
async function lockStorageKey(tx: PrivilegedDb, storageKey: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${STORAGE_KEY_LOCK_CLASS}::int, hashtext(${storageKey}))`,
  )
}

/**
 * Run `fn` under the per-object lock, told whether a live file row still
 * references the key. The object-deletion job uses it so that a deletion
 * queued for a row that is gone never removes an object a newer row (a
 * retried confirm on the same key) now owns.
 */
export async function withStorageKeyLock<T>(
  orgId: string,
  storageKey: string,
  fn: (referenced: boolean) => Promise<T>,
): Promise<T> {
  return withPrivilegedDb(orgId, "files:storage-key", async (tx) => {
    await lockStorageKey(tx, storageKey)
    return fn(await storageKeyHasRow(tx, storageKey))
  })
}

async function storageKeyHasRow(tx: PrivilegedDb, storageKey: string): Promise<boolean> {
  const rows = await tx
    .select({ id: files.id })
    .from(files)
    .where(sql`${files.storageKey} = ${storageKey}`)
    .limit(1)
  return rows.length > 0
}

/**
 * Delete an object a confirm refused. Called under the key lock with no row
 * owning the key. A failed delete leaves the object to the orphan sweep
 * (orphan-gc.ts); the confirm fails either way.
 */
async function discardRefusedObject(storageKey: string, deps: ConfirmUploadDeps): Promise<void> {
  try {
    await (deps.deleteObject ?? defaultDeleteObject)(storageKey)
  } catch (err) {
    log.warn({ err, key: storageKey }, "discard of refused upload failed")
  }
}

export interface RelayUploadDeps {
  privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  putObject?: typeof defaultPutObject
}

/**
 * Write the bytes of a relayed upload (PUT /api/file-relay/:token). The file
 * token stays valid for its whole TTL, so once a confirm has created the row
 * that owns its key the relay refuses (ALREADY_CONFIRMED): a confirmed file is
 * never overwritten through it. The check and the write hold the key lock the
 * confirm takes, so a confirm cannot slip in between.
 */
export async function storeRelayedUpload(
  payload: FileTokenPayload,
  body: Uint8Array,
  deps: RelayUploadDeps,
): Promise<void> {
  await deps.privileged("files:relay-upload", async (tx) => {
    await lockStorageKey(tx, payload.storageKey)
    if (await storageKeyHasRow(tx, payload.storageKey)) {
      throw new FileServiceError("ALREADY_CONFIRMED", "This upload is already confirmed")
    }
    try {
      await (deps.putObject ?? defaultPutObject)({
        key: payload.storageKey,
        body,
        contentType: payload.mimeType,
      })
    } catch (err) {
      log.error({ err, key: payload.storageKey }, "file relay putObject failed")
      throw new FileServiceError("STORAGE_UNAVAILABLE", "Object storage unreachable")
    }
  })
}

/**
 * The object must be exactly what was authorized. With a direct upload the
 * browser talked to the store alone, so this HEAD is the server's only look at
 * it: a wrong size, type or encoding is deleted here, before any row can point
 * at it, and the confirm fails. Runs under the key lock with no row owning the
 * key.
 */
async function verifyStoredObject(
  payload: FileTokenPayload,
  deps: ConfirmUploadDeps,
): Promise<void> {
  const head = deps.headObject ?? defaultHeadObject
  let headResult: HeadResult
  try {
    headResult = await head(payload.storageKey)
  } catch (err) {
    log.warn({ err, key: payload.storageKey }, "HEAD failed")
    throw new FileServiceError("FILE_VERIFY_FAILED", "Object not found in storage")
  }
  const headContentType = headResult.contentType?.split(";")[0]?.trim().toLowerCase()
  const declaredContentType = payload.mimeType.split(";")[0].trim().toLowerCase()
  // Content-Encoding is not something a presigned PUT can forbid: a client
  // could store gzip bytes labelled gzip, and every later GET would be
  // decoded by the browser into something nobody checked.
  const headEncoding = headResult.contentEncoding?.trim().toLowerCase() ?? ""
  let mismatch: string | null = null
  if (headResult.contentLength !== payload.sizeBytes) {
    mismatch = `Size mismatch: head=${headResult.contentLength} declared=${payload.sizeBytes}`
  } else if (!headContentType) {
    // Storage returned no Content-Type metadata — treat as a verification
    // failure rather than silently skipping the check. A missing type can
    // indicate an object mis-upload or a storage proxy stripping headers.
    mismatch = "Storage returned no Content-Type for the uploaded object"
  } else if (headContentType !== declaredContentType) {
    mismatch = `Content type mismatch: head=${headContentType} declared=${declaredContentType}`
  } else if (headEncoding !== "" && headEncoding !== "identity") {
    mismatch = `Unexpected Content-Encoding: ${headEncoding}`
  }
  if (mismatch) {
    await discardRefusedObject(payload.storageKey, deps)
    throw new FileServiceError("FILE_VERIFY_FAILED", mismatch)
  }
}

/**
 * Confirm an uploaded object exists in storage and persist a `kernel.files`
 * row.
 *
 * Idempotency: callers may retry `confirmUpload` with the same file token.
 * First write wins for `disposition` / `contentId` / `ordinal` — a subsequent
 * confirm with the same `storage_key` returns the existing row's metadata and
 * **does not overwrite** the original values. Clients must therefore submit
 * the final metadata on the first confirm and treat the response as authoritative.
 */
export async function confirmUpload(
  fileToken: string,
  deps: ConfirmUploadDeps,
  metadata?: ConfirmUploadMetadata,
): Promise<ConfirmUploadResult> {
  let payload: FileTokenPayload
  try {
    payload = await verifyFileToken(fileToken, deps.jwtSecret)
  } catch (err) {
    log.warn({ err }, "file token verification failed")
    throw new FileServiceError("INVALID_TOKEN", "Invalid or expired file token")
  }

  // Org-binding check: the file token embeds the org that authorised the upload.
  // If the calling request was authenticated as a different org, reject — a
  // token minted for org A must never be confirming under org B's session.
  if (deps.callerOrgId !== undefined && payload.orgId !== deps.callerOrgId) {
    log.warn(
      { tokenOrgId: payload.orgId, callerOrgId: deps.callerOrgId },
      "file token orgId does not match authenticated caller",
    )
    throw new FileServiceError("FORBIDDEN", "File token does not belong to this organization")
  }

  // One transaction, key lock first: HEAD, verify, then discard or insert,
  // so nothing about this key can change between the look and the decision.
  return deps.privileged("files:confirm", async (tx) => {
    await lockStorageKey(tx, payload.storageKey)

    const existing = await tx
      .select()
      .from(files)
      .where(sql`${files.storageKey} = ${payload.storageKey}`)
      .limit(1)
    if (existing.length > 0) {
      const row = existing[0]
      return {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        storageKey: row.storageKey,
        thumbnailKey: row.thumbnailKey,
        app: row.app,
        entityType: row.entityType,
        entityId: row.entityId,
        disposition: (row as { disposition?: string }).disposition ?? "attachment",
        contentId: (row as { contentId?: string | null }).contentId ?? null,
        originalContentId: (row as { originalContentId?: string | null }).originalContentId ?? null,
        ordinal: (row as { ordinal?: number }).ordinal ?? 0,
        createdAt: row.createdAt,
      }
    }

    await verifyStoredObject(payload, deps)

    // The parent's row lock BEFORE the org-wide lock: a confirm aimed at a
    // message being deleted waits on that one row, not with every other
    // confirm of the org queued behind it. A parent that is gone refuses the
    // upload, and its object goes now rather than at the orphan sweep.
    try {
      await lockLiveParent(tx, payload.orgId, payload)
    } catch (err) {
      if (err instanceof FileServiceError) await discardRefusedObject(payload.storageKey, deps)
      throw err
    }

    await lockOrgFileRows(tx, payload.orgId)
    const settings = await loadOrgSettings(tx, payload.orgId)
    const quotaBytes = orgQuotaBytes(settings)
    if (quotaBytes !== null) {
      const used = await currentOrgUsageBytes(tx, payload.orgId)
      if (used + payload.sizeBytes > quotaBytes) {
        noteStorageLevel(payload.orgId, used, quotaBytes)
        // The object will never get a row: it goes now, not at the sweep.
        await discardRefusedObject(payload.storageKey, deps)
        throw new FileServiceError("STORAGE_QUOTA_EXCEEDED", "Org storage quota exceeded")
      }
      // The row is written below in this transaction: the level it reaches.
      noteStorageLevel(payload.orgId, used + payload.sizeBytes, quotaBytes)
    }

    // Inline disposition is only meaningful for images. If a caller tagged a
    // non-image as inline (e.g. due to a buggy client or naive MIME sniff),
    // force it to `attachment` so the inline route cannot be coerced into
    // rendering an HTML/SVG payload that claimed `image/*` at upload time.
    let effectiveDisposition: "inline" | "attachment" = metadata?.disposition ?? "attachment"
    if (effectiveDisposition === "inline" && !payload.mimeType.toLowerCase().startsWith("image/")) {
      effectiveDisposition = "attachment"
    }
    const normalizedContentId = normalizeContentId(metadata?.contentId)
    const insertValues = {
      orgId: payload.orgId,
      app: payload.app,
      entityType: payload.entityType,
      entityId: payload.entityId,
      filename: payload.filename,
      mimeType: payload.mimeType,
      sizeBytes: payload.sizeBytes,
      storageKey: payload.storageKey,
      uploadedBy: payload.userId,
      disposition: effectiveDisposition,
      contentId: normalizedContentId,
      originalContentId: metadata?.contentId ?? null,
      ordinal: metadata?.ordinal ?? 0,
    }
    const inserted = await tx.insert(files).values(insertValues).returning()
    const row = inserted[0]

    // Resolve shared-surface metadata so the kernel `file:create` attention
    // translation can emit `file_shared` rows. Threads are the only built-in
    // shared surface today; manifest apps opt in by emitting their own enrichment.
    let parentSharedSurface = false
    let parentParticipantIds: string[] = []
    let parentLabel: string | null = null
    if (row.app === "kernel" && row.entityType === "thread") {
      parentSharedSurface = true
      const participantRows = (await tx.execute(
        sql`SELECT user_id::text AS user_id
              FROM ${K}.thread_participants
              WHERE thread_id = ${row.entityId}::uuid`,
      )) as unknown as Array<{ user_id: string }>
      parentParticipantIds = participantRows.map((p) => p.user_id)
      const threadRows = (await tx.execute(
        sql`SELECT title, handle FROM ${K}.threads WHERE id = ${row.entityId}::uuid LIMIT 1`,
      )) as unknown as Array<{ title: string | null; handle: string | null }>
      const tRow = threadRows[0]
      parentLabel = tRow?.title ?? tRow?.handle ?? null
    }

    await tx.queueEvent({
      app: "kernel",
      entity: "file",
      action: "create",
      entityId: row.id,
      orgId: payload.orgId,
      actorId: payload.userId,
      data: {
        id: row.id,
        app: row.app,
        entityType: row.entityType,
        entityId: row.entityId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        storageKey: row.storageKey,
        parentSharedSurface,
        parentParticipantIds,
        parentLabel,
        // Where a file_shared attention row opens: the thread the file was added to.
        ...(parentSharedSurface
          ? { link: { tabType: "kernel:thread", entityId: row.entityId } }
          : {}),
      },
    })

    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      storageKey: row.storageKey,
      thumbnailKey: row.thumbnailKey,
      app: row.app,
      entityType: row.entityType,
      entityId: row.entityId,
      disposition: (row as { disposition?: string }).disposition ?? insertValues.disposition,
      contentId: (row as { contentId?: string | null }).contentId ?? normalizedContentId,
      originalContentId:
        (row as { originalContentId?: string | null }).originalContentId ??
        insertValues.originalContentId,
      ordinal: (row as { ordinal?: number }).ordinal ?? insertValues.ordinal,
      createdAt: row.createdAt,
    }
  })
}

export interface FileRowSummary {
  id: string
  app: string
  entityType: string
  entityId: string
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  thumbnailKey: string | null
  uploadedBy: string | null
  disposition: string
  contentId: string | null
  originalContentId: string | null
  ordinal: number
  createdAt: Date
}

interface FileRowWithUrls extends FileRowSummary {
  downloadUrl?: string
  thumbnailUrl?: string
}

// Presigned GETs a browser fetches right away: short-lived, and the store is
// told exactly which headers to answer with (presignGet's response overrides).
const DIRECT_GET_TTL_SECONDS = 5 * 60
const DIRECT_GET_CACHE_CONTROL = "private, max-age=60"

/** A presigned GET that downloads the file: always `attachment`, stored type pinned. */
function presignDirectDownload(
  presign: typeof defaultPresignGet,
  row: { storageKey: string; filename: string; mimeType: string },
): Promise<string> {
  return presign({
    key: row.storageKey,
    expiresInSec: DIRECT_GET_TTL_SECONDS,
    responseContentDisposition: contentDisposition("attachment", row.filename),
    responseContentType: row.mimeType,
    responseCacheControl: DIRECT_GET_CACHE_CONTROL,
    // The confirm refuses an encoded object; this pins the answer anyway, so
    // no browser decodes the bytes into something else.
    responseContentEncoding: "identity",
  })
}

/**
 * The relayed thumbnail of a file: the API's authenticated inline route, same
 * origin as the page. Relative on purpose: the web client recognises it and
 * loads it through its authed client (a bare `<img src>` cannot carry the
 * Bearer header the route requires).
 */
export function relayThumbnailPath(fileId: string): string {
  return `/api/files/${fileId}/inline?variant=thumb`
}

/** A presigned GET for a server-rendered webp thumbnail, safe to show inline. */
function presignDirectThumbnail(
  presign: typeof defaultPresignGet,
  thumbnailKey: string,
): Promise<string> {
  return presign({
    key: thumbnailKey,
    expiresInSec: DIRECT_GET_TTL_SECONDS,
    responseContentDisposition: "inline",
    responseContentType: "image/webp",
    responseCacheControl: DIRECT_GET_CACHE_CONTROL,
  })
}

export interface GetDownloadUrlDeps {
  rlsTx: RlsClient
  presignGet?: typeof defaultPresignGet
  /** Overrides the deployment's delivery decision (tests). */
  delivery?: StorageDelivery
  /** Relay capability URL options, used when the delivery is "relay". */
  relay?: Omit<RelayDownloadDeps, "rlsTx">
}

export interface GetDownloadUrlResult extends FileRowSummary {
  /**
   * "direct": a presigned object-store GET (attachment disposition, stored
   * type, five minutes). "relay": the API's capability URL
   * (`/api/file-relay-dl/<token>`), which streams the same bytes.
   */
  delivery: StorageDelivery
  downloadUrl: string
  thumbnailUrl?: string
}

export async function getDownloadUrl(
  fileId: string,
  deps: GetDownloadUrlDeps,
): Promise<GetDownloadUrlResult> {
  const rows = await deps.rlsTx.execute<Record<string, unknown>>(
    sql`SELECT id, org_id AS "orgId", app, entity_type AS "entityType", entity_id AS "entityId",
               filename, mime_type AS "mimeType", size_bytes AS "sizeBytes",
               storage_key AS "storageKey", thumbnail_key AS "thumbnailKey",
               uploaded_by AS "uploadedBy",
               disposition, content_id AS "contentId",
               original_content_id AS "originalContentId", ordinal,
               created_at AS "createdAt", enc_version AS "encVersion"
        FROM ${K}.files WHERE id = ${fileId} LIMIT 1`,
  )
  const found = (
    rows as unknown as Array<FileRowSummary & { orgId: string; encVersion?: number | null }>
  )[0]
  if (!found) throw new FileServiceError("PARENT_NOT_FOUND", "File not visible")
  const { orgId, encVersion, ...row } = found
  const summary = { ...row, sizeBytes: Number(row.sizeBytes) }
  const delivery = deliveryFor({ sealed: Number(encVersion ?? 0) > 0 }, deps.delivery)

  if (delivery === "relay") {
    const relay = await mintRelayDownloadUrl({ ...row, orgId }, deps.relay ?? {})
    return { ...summary, delivery, downloadUrl: relay.downloadUrl }
  }

  const presign = deps.presignGet ?? defaultPresignGet
  const downloadUrl = await presignDirectDownload(presign, row)
  let thumbnailUrl: string | undefined
  if (row.thumbnailKey) {
    try {
      thumbnailUrl = await presignDirectThumbnail(presign, row.thumbnailKey)
    } catch (err) {
      log.warn({ err, key: row.thumbnailKey }, "thumbnail presign failed")
    }
  }
  return { ...summary, delivery, downloadUrl, thumbnailUrl }
}

export interface RelayDownloadDeps {
  rlsTx: RlsClient
  /** Public base for the capability URL. Defaults to env.BASE_URL. */
  baseUrl?: string
  ttlSeconds?: number
  jwtSecret?: string
  /** Injectable for tests. */
  signToken?: typeof signFileDownloadToken
}

export interface RelayDownloadResult {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  downloadUrl: string
  expiresInSec: number
}

/** Mint the relay capability URL for one row the caller was shown under RLS. */
async function mintRelayDownloadUrl(
  row: { id: string; orgId: string; filename: string; mimeType: string; storageKey: string },
  deps: Omit<RelayDownloadDeps, "rlsTx">,
): Promise<{ downloadUrl: string; expiresInSec: number }> {
  const ttl = Math.min(
    FILE_DOWNLOAD_TOKEN_MAX_TTL_SECONDS,
    Math.max(60, deps.ttlSeconds ?? FILE_DOWNLOAD_TOKEN_DEFAULT_TTL_SECONDS),
  )
  const sign = deps.signToken ?? signFileDownloadToken
  const token = await sign(
    {
      orgId: row.orgId,
      fileId: row.id,
      storageKey: row.storageKey,
      filename: row.filename,
      mimeType: row.mimeType,
    },
    deps.jwtSecret,
    ttl,
  )
  const base = (deps.baseUrl ?? env.BASE_URL).replace(/\/$/, "")
  return { downloadUrl: `${base}/api/file-relay-dl/${token}`, expiresInSec: ttl }
}

/**
 * Build a short-lived CAPABILITY download URL for one file the caller can see.
 * Unlike getDownloadUrl's direct delivery (a presigned object-store GET, only
 * fetchable when the store is browser reachable), this always routes through
 * the app's own fileDownloadRelay: it RLS-fetches the row (invisible →
 * PARENT_NOT_FOUND), mints an HS256 download token pinning the storage key,
 * and returns `${baseUrl}/api/file-relay-dl/<token>`. The app streams the
 * bytes from internal storage, so the URL works uniformly whether the object
 * store is public or private/loopback (self-hosted SeaweedFS) WITHOUT exposing the
 * store — same trust model as the upload relay. The agent's files_read tool
 * uses it: an agent's HTTP client is not a browser the bucket CORS names.
 */
export async function getRelayDownloadUrl(
  fileId: string,
  deps: RelayDownloadDeps,
): Promise<RelayDownloadResult> {
  const rows = await deps.rlsTx.execute<Record<string, unknown>>(
    sql`SELECT id, org_id AS "orgId", filename, mime_type AS "mimeType",
               size_bytes AS "sizeBytes", storage_key AS "storageKey"
        FROM ${K}.files WHERE id = ${fileId} LIMIT 1`,
  )
  const row = (
    rows as unknown as Array<{
      id: string
      orgId: string
      filename: string
      mimeType: string
      sizeBytes: number | string
      storageKey: string
    }>
  )[0]
  if (!row) throw new FileServiceError("PARENT_NOT_FOUND", "File not visible")
  const relay = await mintRelayDownloadUrl(row, deps)
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes),
    downloadUrl: relay.downloadUrl,
    expiresInSec: relay.expiresInSec,
  }
}

/**
 * Whether a relay download token still names a servable file: the row it was
 * minted for still exists with the same key, and is not the attachment of a
 * deleted message. A token outlives the RLS check that minted it by up to its
 * TTL; a file deleted in that window must stop streaming at once.
 */
export async function isRelayedFileServable(payload: {
  orgId: string
  fileId: string
  storageKey: string
}): Promise<boolean> {
  if (!UUID_RE.test(payload.fileId)) return false
  // Both lookups stay on primary keys: the file by its uuid id, its message
  // parent through the same guarded cast the files SELECT policy uses.
  return withPrivilegedDb(payload.orgId, "files:relay-download-recheck", async (tx) => {
    const rows = await tx.execute<{ ok: number }>(
      sql`SELECT 1 AS ok FROM ${K}.files f
          WHERE f.id = ${payload.fileId}::uuid AND f.org_id = ${payload.orgId}
            AND f.storage_key = ${payload.storageKey}
            AND NOT (f.app = 'kernel' AND f.entity_type = 'message' AND EXISTS (
              SELECT 1 FROM ${K}.messages m
               WHERE m.id = (CASE WHEN f.entity_id ~ ${sql.raw(`'${UUID_SHAPE_SQL}'`)}
                                  THEN f.entity_id::uuid END)
                 AND m.org_id = f.org_id
                 AND m.deleted_at IS NOT NULL))
          LIMIT 1`,
    )
    return (rows as unknown as unknown[]).length > 0
  })
}

export interface ListFilesInput {
  app: string
  entityType: string
  entityId: string
  limit?: number
  offset?: number
  /** Sign download URLs for every row (used by attachment renderers). */
  includeDownloadUrls?: boolean
  /** Caller scopes — used to enforce the parent's declared readScope. */
  orgId?: string
  scopes?: string[]
}

export interface ListFilesDeps {
  rlsTx: RlsClient
  presignGet?: typeof defaultPresignGet
  /** Overrides the deployment's delivery decision (tests). */
  delivery?: StorageDelivery
}

export interface ListFilesResult {
  files: FileRowWithUrls[]
  total: number
  limit: number
  offset: number
}

const LIST_MAX_LIMIT = 100
const LIST_DEFAULT_LIMIT = 50

export async function listFiles(
  input: ListFilesInput,
  deps: ListFilesDeps,
): Promise<ListFilesResult> {
  // Enforce the parent entity's declared readScope when caller scopes are
  // provided. Kernel parents (thread, message) are globally gated via
  // requireScope at the router level; manifest app parents declare their own
  // readScope here so listing files under a restricted parent is denied even if
  // the caller has a kernel-wide scope.
  if (input.orgId && input.scopes) {
    const parent = resolveParent(input.orgId, input.app, input.entityType)
    if (
      parent &&
      parent.readScope !== "__upload_session_sentinel__" &&
      !hasScope(parent.readScope, input.scopes)
    ) {
      throw new FileServiceError("FORBIDDEN", "Missing read scope on parent")
    }
  }

  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, input.limit ?? LIST_DEFAULT_LIMIT))
  const offset = Math.max(0, input.offset ?? 0)
  const rowsRaw = await deps.rlsTx.execute<Record<string, unknown>>(
    sql`SELECT id, app, entity_type AS "entityType", entity_id AS "entityId",
               filename, mime_type AS "mimeType", size_bytes AS "sizeBytes",
               storage_key AS "storageKey", thumbnail_key AS "thumbnailKey",
               uploaded_by AS "uploadedBy",
               disposition, content_id AS "contentId",
               original_content_id AS "originalContentId", ordinal,
               created_at AS "createdAt", enc_version AS "encVersion"
        FROM ${K}.files
        WHERE app = ${input.app} AND entity_type = ${input.entityType} AND entity_id = ${input.entityId}
        ORDER BY ordinal ASC, created_at ASC, id ASC
        LIMIT ${limit} OFFSET ${offset}`,
  )
  const rows = rowsRaw as unknown as Array<FileRowSummary & { encVersion?: number | null }>
  const totalRows = await deps.rlsTx.execute<{ total: string | null }>(
    sql`SELECT COUNT(*)::text AS total FROM ${K}.files
        WHERE app = ${input.app} AND entity_type = ${input.entityType} AND entity_id = ${input.entityId}`,
  )
  const totalRow = (totalRows as unknown as { total: string | null }[])[0]
  const total = Number(totalRow?.total ?? 0)

  // Direct delivery signs pinned URLs (attachment, stored type, webp
  // thumbnails). Relayed delivery hands out NO object-store URL at all: the
  // browser never talks to the store then, and its CSP does not name the store
  // (`browserStorageOrigin` is null), so a presigned thumbnail on a plain-http
  // store was blocked by img-src. The thumbnail goes through the API instead
  // (`relayThumbnailPath`, the authenticated inline route), and a download is
  // minted on demand through `getDownloadUrl`'s relay capability URL.
  const presign = deps.presignGet ?? defaultPresignGet
  const files: FileRowWithUrls[] = await Promise.all(
    rows.map(async ({ encVersion, ...row }) => {
      const out: FileRowWithUrls = { ...row, sizeBytes: Number(row.sizeBytes) }
      const sealed = Number(encVersion ?? 0) > 0
      const direct = deliveryFor({ sealed: false }, deps.delivery) === "direct"
      // A direct deployment relays a sealed file (storageDelivery): no URL.
      if (direct && sealed) return out
      if (!direct) {
        if (row.thumbnailKey && row.mimeType.startsWith("image/") && !sealed) {
          out.thumbnailUrl = relayThumbnailPath(row.id)
        }
        return out
      }
      if (input.includeDownloadUrls) {
        try {
          out.downloadUrl = await presignDirectDownload(presign, row)
        } catch (err) {
          log.warn({ err, fileId: row.id }, "list download presign failed")
        }
      }
      if (row.thumbnailKey && row.mimeType.startsWith("image/")) {
        try {
          out.thumbnailUrl = await presignDirectThumbnail(presign, row.thumbnailKey)
        } catch (err) {
          log.warn({ err, fileId: row.id }, "list thumbnail presign failed")
        }
      }
      return out
    }),
  )
  return { files, total, limit, offset }
}

export interface DeleteFileDeps {
  orgId: string
  userId: string
  scopes: string[]
  /**
   * The caller's own RLS transaction. The file row is read privileged, so the
   * write scope alone would let anyone who learned a file id delete an
   * attachment in a thread or contact they cannot see; the parent must also be
   * visible to the caller, exactly as for upload and move.
   */
  rlsTx: RlsClient
  privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
}

export async function deleteFile(fileId: string, deps: DeleteFileDeps): Promise<void> {
  await deps.privileged("files:delete", async (tx) => {
    const rows = await tx.execute<Record<string, unknown>>(
      sql`SELECT id, app, entity_type AS "entityType", entity_id AS "entityId",
                 filename, mime_type AS "mimeType", size_bytes AS "sizeBytes",
                 storage_key AS "storageKey", thumbnail_key AS "thumbnailKey",
                 uploaded_by AS "uploadedBy", created_at AS "createdAt"
          FROM ${K}.files WHERE id = ${fileId} AND org_id = ${deps.orgId} LIMIT 1`,
    )
    const row = (rows as unknown as FileRowSummary[])[0]
    if (!row) throw new FileServiceError("PARENT_NOT_FOUND", "File not found")

    const parent = resolveParent(deps.orgId, row.app, row.entityType)
    if (!parent) throw new FileServiceError("PARENT_NOT_FOUND", "Unknown file parent")
    // Files still parented to an upload-session sentinel have an unmatched
    // sentinel scope on `parent.writeScope`. Allow the original uploader to
    // delete their own staged file in that case so users can recover from a
    // composer mistake without waiting for the orphan GC sweep.
    if (row.app === "kernel" && row.entityType === "file_upload_session") {
      if (row.uploadedBy !== deps.userId) {
        throw new FileServiceError("FORBIDDEN", "Cannot delete another user's staged file")
      }
    } else if (!hasScope(parent.writeScope, deps.scopes)) {
      throw new FileServiceError("FORBIDDEN", "Forbidden: missing write scope on parent")
    } else {
      await assertParentVisible(deps.rlsTx, parent, row.entityId)
      if (
        parent.deleteScope &&
        row.uploadedBy !== deps.userId &&
        !hasScope(parent.deleteScope, deps.scopes)
      ) {
        throw new FileServiceError(
          "FORBIDDEN",
          "Only the person who added this file, or an administrator, can remove it",
        )
      }
    }

    // A legal record's file (its parent row lives in an immutable table) is retained.
    if (parent.retention) {
      const ps = sql.raw(`"${schemaRef(parent.schemaRef)}"`)
      const pt = sql.raw(`"${parent.tableName}"`)
      const pj = sql.raw(`"${parent.joinOn}"`)
      const pa = sql.raw(`"${parent.retention.anchor}"`)
      const years = parent.retention.retentionYears
      const retained = await tx.execute<{ retained: boolean }>(
        sql`SELECT (${pa} > now() - make_interval(years => ${years})) AS retained
            FROM ${ps}.${pt} WHERE ${pj}::text = ${String(row.entityId)} LIMIT 1`,
      )
      if ((retained as unknown as Array<{ retained: boolean }>)[0]?.retained) {
        throw new FileServiceError(
          "RETAINED",
          `This file is a legal record kept for ${years} years and cannot be deleted.`,
        )
      }
    }

    await tx.execute(sql`DELETE FROM ${K}.files WHERE id = ${fileId}`)

    await tx.queueEvent({
      app: "kernel",
      entity: "file",
      action: "delete",
      entityId: row.id,
      orgId: deps.orgId,
      actorId: deps.userId,
      data: {
        id: row.id,
        app: row.app,
        entityType: row.entityType,
        entityId: row.entityId,
        storageKey: row.storageKey,
        thumbnailKey: row.thumbnailKey,
      },
    })
    // The object goes after this transaction commits: the event above is
    // what the files-delete-object durable consumer acts on.
  })
}
