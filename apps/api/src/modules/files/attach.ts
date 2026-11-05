// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Generic, RLS-safe file-attachment primitive.
 *
 * `attachFileToParent` copies any `kernel.files` row the caller can read onto
 * any registered `fileParent` destination. It is the single reusable core
 * behind every agent attachment surface (mail / tickets / threads) and the
 * `files_attachToParent` sandbox bridge. It never moves the source — the
 * source entity keeps its file and the copy gets an independent RLS parent.
 */
import { parseRefToken } from "@liaison/shared"
import { sql } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { files } from "~/db/schema/kernel/files"
import { schemaRef } from "~/db/schema-ref"
import { copyObject as defaultCopyObject } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { UUID_RE } from "~/lib/uuid"
import { fileIsFromOutside } from "~/modules/files/origin"
import {
  assertParentVisible,
  buildStorageKey,
  currentOrgUsageBytes,
  FileServiceError,
  loadOrgSettings,
  lockLiveParent,
  orgQuotaBytes,
  resolveParent,
} from "~/modules/files/service"
import { hasScope } from "~/modules/permissions/permissions"

export { FileServiceError } from "~/modules/files/service"

const K = sql.raw(schemaRef("kernel"))

/** Per-call ceilings for `attachFilesToParent` — model-proofing a runaway agent. */
const MAX_ATTACHMENTS_PER_CALL = 10
const MAX_CUMULATIVE_BYTES = 25 * 1024 * 1024

/**
 * Executable / script file types blocked from being attached anywhere.
 * Enforced in this one core service so the check covers every surface
 * (mail, tickets, threads). HTML / SVG are deliberately NOT blocked —
 * attachments are downloaded (`Content-Disposition: attachment`), never
 * rendered inline, so the active-content XSS surface does not apply.
 *
 * This is an extension/MIME *heuristic*, not a content scan — a renamed
 * binary with a benign extension and MIME is not caught here (malware/AV
 * scanning is a separate, deferred workstream; the human approval gate is
 * the v1 mitigation). It does, however, inspect *every* dotted segment so a
 * double extension (`payload.exe.pdf`) cannot slip past on its last one.
 */
const BLOCKED_EXTENSIONS = new Set([
  "exe",
  "bat",
  "cmd",
  "com",
  "scr",
  "msi",
  "jar",
  "app",
  "dll",
  "sh",
  "ps1",
  "js",
  "jse",
  "vbs",
  "vbe",
  "wsf",
  // Windows-recipient shortcut / autorun / scripting host vectors.
  "lnk",
  "hta",
  "scf",
  "reg",
  "msc",
  "pif",
  "cpl",
  "gadget",
  "ws",
  "wsh",
])
const BLOCKED_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-sh",
  "application/x-bat",
  "application/bat",
  "application/java-archive",
  "application/x-executable",
  "application/vnd.microsoft.portable-executable",
  "application/x-ms-shortcut",
  "text/javascript",
  "application/javascript",
])

/** Extension → the MIME type(s) it maps to in `BLOCKED_MIME_TYPES`, so an
 *  allow-listed extension also lifts its matching MIME block (otherwise the
 *  MIME check alone would still reject the same file). */
const EXTENSION_MIME_TYPES: Record<string, string[]> = {
  exe: ["application/x-msdownload", "application/vnd.microsoft.portable-executable"],
  com: ["application/x-msdos-program"],
  sh: ["application/x-sh"],
  bat: ["application/x-bat", "application/bat"],
  jar: ["application/java-archive"],
  app: ["application/x-executable"],
  lnk: ["application/x-ms-shortcut"],
  js: ["text/javascript", "application/javascript"],
}

/**
 * `LIAISON_ATTACHMENT_ALLOW_EXTENSIONS` (comma-separated, no dots) subtracted
 * from the compile-time denylist — for privileged import paths (e.g. `slack
 * import`) that legitimately need to bring in binary artifacts a normal agent
 * attachment surface must never carry. Computed once per env value; the env
 * var is process-wide config, not per-call, so this doesn't need to be a
 * parameter threaded through every call site.
 */
function parseAllowedExtensions(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  )
}

function effectiveBlockedExtensions(allowed: Set<string>): Set<string> {
  if (allowed.size === 0) return BLOCKED_EXTENSIONS
  return new Set([...BLOCKED_EXTENSIONS].filter((ext) => !allowed.has(ext)))
}

function effectiveBlockedMimeTypes(allowed: Set<string>): Set<string> {
  if (allowed.size === 0) return BLOCKED_MIME_TYPES
  const liftedMimes = new Set<string>()
  for (const ext of allowed) {
    for (const mime of EXTENSION_MIME_TYPES[ext] ?? []) liftedMimes.add(mime)
  }
  if (liftedMimes.size === 0) return BLOCKED_MIME_TYPES
  return new Set([...BLOCKED_MIME_TYPES].filter((mime) => !liftedMimes.has(mime)))
}

/**
 * True when a file is an executable / script type that must never be attached
 * to an outbound message. Exported so host-side send paths that read source
 * bytes directly (e.g. tickets) enforce the same denylist before dispatch.
 *
 * Every dotted segment of the filename is checked — a double extension such as
 * `payload.exe.pdf` is blocked on its `exe` segment, not waved through on `pdf`.
 *
 * `LIAISON_ATTACHMENT_ALLOW_EXTENSIONS` (read from `env` by default, overridable
 * via `allowExtensionsOverride`, a test seam) subtracts specific extensions, and
 * their matching MIME entries, from the denylist, for files STAFF AUTHORED only
 * (`staffAuthored`: a member of the org uploaded it, or the operator imports it).
 * A file that came from outside (an inbound mail or ticket attachment, an
 * integration import, an agent's own upload) stays on the full denylist. For a
 * stored file, `isBlockedStoredFile` works that out from the file's origin.
 */
export function isBlockedFileType(
  filename: string,
  mimeType: string,
  opts: { staffAuthored?: boolean; allowExtensionsOverride?: string } = {},
): boolean {
  const allowed =
    opts.staffAuthored === true
      ? parseAllowedExtensions(
          opts.allowExtensionsOverride ?? env.LIAISON_ATTACHMENT_ALLOW_EXTENSIONS,
        )
      : new Set<string>()
  const segments = filename.toLowerCase().split(".").slice(1)
  const blockedExtensions = effectiveBlockedExtensions(allowed)
  if (segments.some((s) => blockedExtensions.has(s.trim()))) return true
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? ""
  return effectiveBlockedMimeTypes(allowed).has(mime)
}

/**
 * `isBlockedFileType` for a file already stored: the operator's extension
 * allowance applies only when the file's origin is inside the org
 * (`fileIsFromOutside`, followed through copies). The origin is read only when
 * the allowance would change the answer.
 */
export async function isBlockedStoredFile(
  orgId: string,
  file: { id: string; filename: string; mimeType: string },
  allowExtensionsOverride?: string,
): Promise<boolean> {
  if (!isBlockedFileType(file.filename, file.mimeType)) return false
  if (
    isBlockedFileType(file.filename, file.mimeType, {
      staffAuthored: true,
      allowExtensionsOverride,
    })
  ) {
    return true
  }
  return fileIsFromOutside(orgId, file.id)
}

export interface AttachTarget {
  app: string
  entityType: string
  entityId: string
}

/** Actor categories carried on the kernel event envelope. */
export type AttachActorType = "user" | "agent" | "system" | "mcp"

export interface AttachFileDeps {
  /** RLS client carrying the caller's context — gates which source files are visible. */
  rlsTx: RlsClient
  /** Privileged runner for the idempotency / quota / insert work. */
  privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  orgId: string
  /** Actor the copied file row is attributed to (`uploaded_by`). A non-uuid id
   *  (a system bridge's "system") records no uploader, as `files_importAttachment` does. */
  userId: string
  /**
   * Actor category for the audit trail. Agent-driven attaches MUST pass
   * `"agent"` so the `file:create` timeline entry is not mis-recorded as a
   * human upload (an agent runs as a user, so `userId` alone cannot tell them
   * apart). Defaults to `"agent"` — every current caller is an agent surface.
   */
  actorType?: AttachActorType
  /** Caller's effective scopes — checked against the destination `writeScope`. */
  scopes: string[]
  /** Test seam — defaults to the real S3 `copyObject`. */
  copyObject?: typeof defaultCopyObject
}

export interface AttachedFile {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

interface SourceFileRow {
  id: string
  app: string
  entityType: string
  entityId: string
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  disposition: string
  contentId: string | null
  ordinal: number
  /**
   * The sealed-attachment envelope (spec section 5.8). Carried onto the copy so
   * the copy DESCRIBES the bytes it actually holds: `copyObject` duplicates
   * ciphertext verbatim, and a copy row left at `enc_version = 0` claims that
   * ciphertext is a readable PDF. The mail send path reads exactly this column
   * to decide whether it may put the bytes in an outgoing message (Task 9.9),
   * so dropping it here is what would mail an unreadable blob to a customer.
   *
   * The envelope's AAD binds the ORIGINAL file id, so the copy is not openable
   * under the copy's own id. That is deliberate and it is not a regression: the
   * only readable path is the owner's browser decrypting the SOURCE file, which
   * is what the client-fulfilled send supplies.
   */
  encVersion: number
  contentKeyWrapped: Buffer | Uint8Array | null
  contentKeyEpk: Buffer | Uint8Array | null
  encKeyId: number | null
  chunkSize: number | null
  chunkCount: number | null
  plaintextLength: number | string | null
  noncePrefix: Buffer | Uint8Array | null
}

/**
 * Copy one source file onto a destination parent. Validates: the source is
 * visible under the caller's RLS context; the file type is allowed; the
 * destination is a registered `fileParent` the caller may write; org quota.
 * Idempotent — re-running with the same `(target, sourceFileId)` returns the
 * existing copy instead of duplicating it.
 */
export async function attachFileToParent(
  input: { sourceFileId: string; target: AttachTarget },
  deps: AttachFileDeps,
): Promise<AttachedFile> {
  const { sourceFileId, target } = input

  // 1. Load the source under the caller's RLS context — invisible ⇒ rejected.
  const srcRows = await deps.rlsTx.execute<Record<string, unknown>>(
    sql`SELECT id, app, entity_type AS "entityType", entity_id AS "entityId",
               filename, mime_type AS "mimeType", size_bytes AS "sizeBytes",
               storage_key AS "storageKey", disposition,
               content_id AS "contentId", ordinal,
               enc_version AS "encVersion", content_key_wrapped AS "contentKeyWrapped",
               content_key_epk AS "contentKeyEpk", enc_key_id AS "encKeyId",
               chunk_size AS "chunkSize", chunk_count AS "chunkCount",
               plaintext_length AS "plaintextLength", nonce_prefix AS "noncePrefix"
        FROM ${K}.files WHERE id = ${sourceFileId} AND org_id = ${deps.orgId} LIMIT 1`,
  )
  const src = (srcRows as unknown as SourceFileRow[])[0]
  if (!src) {
    throw new FileServiceError("PARENT_NOT_FOUND", "Source file not visible to caller")
  }

  // 2. File-type denylist — blocks executables / scripts on every surface.
  if (await isBlockedStoredFile(deps.orgId, src)) {
    throw new FileServiceError(
      "UNSAFE_FILE_TYPE",
      `File type not allowed as an attachment: ${src.filename}`,
    )
  }

  // 3. Destination must be a registered file parent.
  const parent = resolveParent(deps.orgId, target.app, target.entityType)
  if (!parent) {
    throw new FileServiceError("PARENT_NOT_FOUND", "Unknown destination file parent")
  }

  // 4. Caller must hold the destination's write scope.
  if (!hasScope(parent.writeScope, deps.scopes)) {
    throw new FileServiceError("FORBIDDEN", "Forbidden: missing write scope on destination")
  }

  // 5. Destination row must be visible to the caller.
  await assertParentVisible(deps.rlsTx, parent, target.entityId)
  await lockLiveParent(deps.rlsTx, deps.orgId, target)

  // 6 + 7. Idempotency + quota in one privileged read.
  const precheck = await deps.privileged("files:attach-precheck", async (tx) => {
    const existing = await tx.execute<{ id: string }>(
      sql`SELECT id::text AS id FROM ${K}.files
          WHERE org_id = ${deps.orgId} AND app = ${target.app}
            AND entity_type = ${target.entityType} AND entity_id = ${target.entityId}
            AND copied_from_id = ${sourceFileId}
          LIMIT 1`,
    )
    const hit = (existing as unknown as { id: string }[])[0]
    if (hit) return { existingId: hit.id }

    const settings = await loadOrgSettings(tx, deps.orgId)
    const quotaBytes = orgQuotaBytes(settings)
    if (quotaBytes !== null) {
      const used = await currentOrgUsageBytes(tx, deps.orgId)
      if (used + Number(src.sizeBytes) > quotaBytes) {
        throw new FileServiceError("STORAGE_QUOTA_EXCEEDED", "Org storage quota exceeded")
      }
    }
    return { existingId: null }
  })

  if (precheck.existingId) {
    return {
      id: precheck.existingId,
      filename: src.filename,
      mimeType: src.mimeType,
      sizeBytes: Number(src.sizeBytes),
    }
  }

  // 8 + 9. Build the destination key and server-side-copy the bytes.
  const destKey = buildStorageKey({
    orgId: deps.orgId,
    app: target.app,
    entityType: target.entityType,
    entityId: target.entityId,
    filename: src.filename,
  })
  const copyObject = deps.copyObject ?? defaultCopyObject
  await copyObject({ sourceKey: src.storageKey, destKey })

  // A system caller (a webhook or job bridge) has no user id: no uploader.
  const uploaderId = UUID_RE.test(deps.userId) ? deps.userId : null

  // 10. Persist the copy row + emit a provenance-bearing event. A concurrent
  // gated-handler retry may have raced past the step-6 precheck — the partial
  // UNIQUE index on `copied_from_id` then rejects the loser's INSERT, and we
  // re-read the winner instead of duplicating the attachment.
  let inserted: { id: string; filename: string; mimeType: string; sizeBytes: number }
  try {
    inserted = await deps.privileged("files:attach-insert", async (tx) => {
      const rows = await tx
        .insert(files)
        .values({
          orgId: deps.orgId,
          app: target.app,
          entityType: target.entityType,
          entityId: target.entityId,
          filename: src.filename,
          mimeType: src.mimeType,
          sizeBytes: Number(src.sizeBytes),
          storageKey: destKey,
          uploadedBy: uploaderId,
          disposition: src.disposition,
          contentId: src.contentId,
          ordinal: src.ordinal,
          copiedFromId: sourceFileId,
          // The bytes are copied verbatim, so the envelope that describes them
          // travels with them. See `SourceFileRow` for why this matters.
          encVersion: Number(src.encVersion ?? 0),
          contentKeyWrapped: src.contentKeyWrapped ? Buffer.from(src.contentKeyWrapped) : null,
          contentKeyEpk: src.contentKeyEpk ? Buffer.from(src.contentKeyEpk) : null,
          encKeyId: src.encKeyId === null ? null : Number(src.encKeyId),
          chunkSize: src.chunkSize === null ? null : Number(src.chunkSize),
          chunkCount: src.chunkCount === null ? null : Number(src.chunkCount),
          plaintextLength:
            src.plaintextLength === null || src.plaintextLength === undefined
              ? null
              : Number(src.plaintextLength),
          noncePrefix: src.noncePrefix ? Buffer.from(src.noncePrefix) : null,
        })
        .returning()
      const row = rows[0]

      const actorType = deps.actorType ?? "agent"
      await tx.queueEvent({
        app: "kernel",
        entity: "file",
        action: "create",
        entityId: row.id,
        orgId: deps.orgId,
        actorId: uploaderId ?? "00000000-0000-0000-0000-000000000000",
        actorType,
        data: {
          id: row.id,
          app: target.app,
          entityType: target.entityType,
          entityId: target.entityId,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          storageKey: row.storageKey,
          // Provenance — recorded in the audit timeline (see modules/audit/timeline.ts).
          copiedFromId: sourceFileId,
          actorType,
          sourceApp: src.app,
          sourceEntityType: src.entityType,
          sourceEntityId: src.entityId,
        },
      })
      return {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
      }
    })
  } catch (err) {
    // Lost a concurrent race on the partial UNIQUE index — the winning copy
    // already exists. Re-read and return it so the attach stays idempotent.
    if (isUniqueViolation(err)) {
      const winner = await deps.privileged("files:attach-dedup", async (tx) =>
        tx.execute<{ id: string }>(
          sql`SELECT id::text AS id FROM ${K}.files
              WHERE org_id = ${deps.orgId} AND app = ${target.app}
                AND entity_type = ${target.entityType} AND entity_id = ${target.entityId}
                AND copied_from_id = ${sourceFileId}
              LIMIT 1`,
        ),
      )
      const row = (winner as unknown as { id: string }[])[0]
      if (row) {
        return {
          id: row.id,
          filename: src.filename,
          mimeType: src.mimeType,
          sizeBytes: Number(src.sizeBytes),
        }
      }
    }
    throw err
  }

  return {
    id: inserted.id,
    filename: inserted.filename,
    mimeType: inserted.mimeType,
    sizeBytes: inserted.sizeBytes,
  }
}

/** True when an error (or a wrapped cause) is a Postgres unique-violation (23505). */
function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; depth < 5 && e; depth++) {
    if (typeof e === "object" && (e as { code?: string }).code === "23505") return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/**
 * A file's origin "kind" — drives whether a cross-entity provenance ⚠ flag is
 * meaningful. `conversational` files belong to a customer-facing conversation
 * (ticket / email / thread) — attaching one onto a *different* conversation is
 * the cross-customer-leak case the gate must surface. `source` files are
 * deliberately-fetched material (a Drive import, a knowledge document, a staged
 * upload) — they have no "home conversation", so they are never flagged.
 */
export type OriginKind = "conversational" | "source"

interface OriginInfo {
  label: string
  kind: OriginKind
}

/** Human phrase + kind for a file's origin, keyed by `<app>:<entityType>`. */
const ORIGIN_INFO: Record<string, OriginInfo> = {
  "tickets:ticket": { label: "a ticket", kind: "conversational" },
  "tickets:message": { label: "a ticket", kind: "conversational" },
  "mail:message": { label: "an email conversation", kind: "conversational" },
  "mail:conversation": { label: "an email conversation", kind: "conversational" },
  "mail:draft": { label: "an email draft", kind: "conversational" },
  "mail:outbound_staging": { label: "an email being sent", kind: "conversational" },
  "kernel:thread": { label: "a thread", kind: "conversational" },
  "kernel:message": { label: "a thread", kind: "conversational" },
  "knowledge:document": { label: "a knowledge document", kind: "source" },
  // A Boxtal shipping/return document (e.g. a prepaid return label) materialised
  // as a kernel.files row on its shipment. It is deliberately-fetched shipping
  // material, never a customer's conversation, so it is a `source` origin — it is
  // never flagged ⚠ when attached to a reply, and reads "from a Boxtal shipment".
  "boxtal:shipment": { label: "a Boxtal shipment", kind: "source" },
}

export interface FileOrigin {
  fileId: string
  filename: string
  parent: { app: string; entityType: string; entityId: string }
  /** Human phrase for where the file came from, e.g. "a ticket". */
  label: string
  kind: OriginKind
}

/**
 * Resolve a file's origin — its parent entity, a human label, and its kind —
 * for showing provenance on a gated approval. Returns null when the file is
 * not visible to the caller. The query is org-scoped as defence-in-depth on
 * top of RLS.
 */
export async function describeFileOrigin(
  fileId: string,
  rlsTx: RlsClient,
  orgId: string,
): Promise<FileOrigin | null> {
  // LEFT JOIN the upload-session row so a file staged in `file_upload_session`
  // (a Drive import, a human upload-in-progress) is labelled by where it was
  // imported FROM, not the bare "kernel" app string.
  const rows = await rlsTx.execute<Record<string, unknown>>(
    sql`SELECT f.filename, f.app, f.entity_type AS "entityType", f.entity_id AS "entityId",
               s.target_app AS "sessionApp"
        FROM ${K}.files f
        LEFT JOIN ${K}.file_upload_sessions s
          ON f.entity_type = 'file_upload_session' AND s.id::text = f.entity_id
        WHERE f.id = ${fileId} AND f.org_id = ${orgId} LIMIT 1`,
  )
  const row = (
    rows as unknown as Array<{
      filename: string
      app: string
      entityType: string
      entityId: string
      sessionApp: string | null
    }>
  )[0]
  if (!row) return null

  let label: string
  let kind: OriginKind
  if (row.entityType === "file_upload_session") {
    // Imported / staged material — a deliberate fetch, never a cross-customer leak.
    label = row.sessionApp === "google-drive" ? "Google Drive" : "an imported file"
    kind = "source"
  } else {
    const info = ORIGIN_INFO[`${row.app}:${row.entityType}`]
    label = info?.label ?? row.app
    kind = info?.kind ?? "source"
  }
  return {
    fileId,
    filename: row.filename,
    parent: { app: row.app, entityType: row.entityType, entityId: row.entityId },
    label,
    kind,
  }
}

/**
 * Inputs for `buildAttachmentSummaryLines`. `replyTargetRootId` +
 * `resolveOriginRoot` together drive the cross-entity ⚠ flag: a
 * *conversational* attachment whose home conversation is not the one being
 * replied to is the cross-customer-leak case the human approver must catch.
 */
export interface AttachmentSummaryOptions {
  rlsTx: RlsClient
  orgId: string
  /** The app whose send surface is being summarised (`mail` / `tickets` / `kernel`). */
  surfaceApp: string
  /**
   * The conversation / ticket / thread id the send is replying to. Omitted for
   * compose (a fresh outbound message has no reply target).
   */
  replyTargetRootId?: string
  /**
   * Resolve a *same-app* conversational origin to its root conversation /
   * ticket / thread id, so a file from a different conversation in the same app
   * can be flagged. Supplied by each summariser (it knows its own app schema).
   * Only ever called for `surfaceApp`-app conversational origins.
   */
  resolveOriginRoot?: (origin: FileOrigin) => Promise<string | null>
}

/**
 * Build `summary.lines` entries for a gated send's attachments so the human
 * approver sees each file's name and origin before approving. An attachment is
 * prefixed with ⚠ when it came from a *different conversation* than the one
 * being replied to — either a different app outright, or (via
 * `resolveOriginRoot`) a different conversation/ticket within the same app.
 * That is the cross-customer-leak signal the gate exists to surface. Imported /
 * staged source files (Drive imports, knowledge docs) are never flagged.
 * `@ref:` tokens (pending gated-op outputs) render as a placeholder.
 */
export async function buildAttachmentSummaryLines(
  attachmentIds: string[],
  opts: AttachmentSummaryOptions,
): Promise<string[]> {
  const lines: string[] = []
  for (const raw of attachmentIds) {
    if (parseRefToken(raw)) {
      // The token stays in the line: the sequenced step's summary is rewritten
      // into the step it comes from ("📎 [quote PDF from step 2]") and the file
      // is pending until that step has run.
      lines.push(`📎 ${raw} (attached once that step has run)`)
      continue
    }
    const origin = await describeFileOrigin(raw, opts.rlsTx, opts.orgId)
    if (!origin) {
      lines.push(`📎 (file unavailable: ${raw})`)
      continue
    }
    let flag = ""
    if (origin.kind === "conversational") {
      if (origin.parent.app !== opts.surfaceApp) {
        // Cross-app — unambiguously a different conversation.
        flag = "⚠ "
      } else if (opts.replyTargetRootId && opts.resolveOriginRoot) {
        // Same app — resolve the origin's home conversation and compare.
        const root = await opts.resolveOriginRoot(origin)
        if (root && root !== opts.replyTargetRootId) flag = "⚠ "
      }
    }
    lines.push(`${flag}📎 ${origin.filename} — from ${origin.label}`)
  }
  return lines
}

/**
 * Attach several files onto one destination. Enforces a per-call count cap and
 * a cumulative-size cap so a runaway agent cannot bloat a message or the org
 * quota. The cumulative size is checked **before any copy** — an over-cap batch
 * is rejected whole, never leaving partially-copied files behind. Copies are
 * independent and idempotent.
 */
export async function attachFilesToParent(
  input: { sourceFileIds: string[]; target: AttachTarget },
  deps: AttachFileDeps,
): Promise<AttachedFile[]> {
  const { sourceFileIds, target } = input
  if (sourceFileIds.length > MAX_ATTACHMENTS_PER_CALL) {
    throw new FileServiceError(
      "FILE_TOO_LARGE",
      `Too many attachments in one call (max ${MAX_ATTACHMENTS_PER_CALL})`,
    )
  }
  // Pre-sum the source sizes under the caller's RLS context so an over-cap
  // batch is rejected up front — before the first S3 copy or row insert.
  if (sourceFileIds.length > 0) {
    const idList = sql.join(
      sourceFileIds.map((id) => sql`${id}`),
      sql`, `,
    )
    const sumRows = await deps.rlsTx.execute<{ total: string | null }>(
      sql`SELECT COALESCE(SUM(size_bytes), 0)::text AS total FROM ${K}.files
          WHERE id::text IN (${idList}) AND org_id = ${deps.orgId}`,
    )
    const total = Number((sumRows as unknown as { total: string | null }[])[0]?.total ?? 0)
    if (total > MAX_CUMULATIVE_BYTES) {
      throw new FileServiceError(
        "FILE_TOO_LARGE",
        `Cumulative attachment size exceeds ${MAX_CUMULATIVE_BYTES} bytes`,
      )
    }
  }
  const out: AttachedFile[] = []
  for (const sourceFileId of sourceFileIds) {
    out.push(await attachFileToParent({ sourceFileId, target }, deps))
  }
  return out
}
