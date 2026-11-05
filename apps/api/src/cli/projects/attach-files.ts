// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `projects attach-files`. Attaches historical files (e.g. Jira attachments
 * downloaded locally) to tasks ALREADY imported by `projects import`, under
 * their original uploader and date.
 *
 * An attachment belongs to the issue, so each file becomes one `kernel.files`
 * row parented to the task itself (app `projects`, entity `task`: the
 * `fileParent` the projects manifest declares), listed on the task page with
 * the files uploaded there. The row is backdated to the record's `createdAt`
 * and `uploaded_by` is the original uploader.
 *
 * One NDJSON line = one original upload batch (one uploader, one moment, N
 * files on one task). `batchKey` is provenance only: idempotency is per FILE.
 * Each file's row id is a deterministic UUID (v5 over the org, the task and the
 * file's `sourceId`) and is also the object segment of its storage key, so:
 *   1. Read transaction: the task (by `external_ref`), and which of the
 *      record's derived ids already exist. Those files are skipped
 *      (`filesSkipped`), never read from disk nor uploaded. An author that
 *      cannot resolve without `--placeholder-unknown-users` fails here.
 *   2. The remaining files: each `path` must stay inside `--files-dir` AFTER
 *      symlink resolution, be a regular file, match its declared `size`, fit
 *      the org `fileSizeLimitMb`, not be a blocked type; then ONE quota check
 *      for the record; then `putObject` each under its deterministic key.
 *   3. Write transaction: the author (a deactivated placeholder with the
 *      flag), then each row `ON CONFLICT (id) DO NOTHING`. A concurrent run
 *      that wins the insert wrote the same bytes under the same key, so a race
 *      leaves no orphaned object. Objects uploaded for a record whose write
 *      then FAILED are counted in `orphanedObjects` (the orphan GC deletes
 *      them after 24 h; a re-run overwrites and adopts them).
 *
 * Each inserted row queues the kernel `file:create` event, the shape the upload
 * path emits for a task file, so images get thumbnails. Like any task-file
 * upload it carries `parentSharedSurface: false`: the attention translator's
 * only `file:create` rule (`file_shared`) requires it true, so the backfill
 * produces no attention row, push or digest.
 *
 * Author: an unknown uploader FAILS the record without the flag. A historical
 * file is never attributed to the import actor: that would falsify the history
 * (same principle as the projects importer). With the flag a deactivated
 * placeholder is the uploader (see `resolveUser` in ./import.ts).
 *
 * `--dry-run` runs every check (schema, task, author, paths, sizes, limits,
 * quota with a running total of the planned bytes) and writes NOTHING: no
 * object, no row, no placeholder (`placeholdersPlanned[]` names them).
 */
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { createInterface } from "node:readline"
import { sql as drizzleSql } from "drizzle-orm"
import { z } from "zod"
import { normalizeEmail, resolveUser } from "~/apps/projects/import-kind"
import { kernelRel, projectsRel } from "~/apps/projects/schema-refs"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { putObject, sanitizeFilename } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { isBlockedFileType } from "~/modules/files/attach"
import {
  buildStorageKey,
  loadOrgSettings,
  type OrgSettings,
  wouldExceedOrgQuota,
} from "~/modules/files/service"

const log = rootLogger.child({ module: "cli-projects-attach-files" })

/** Namespace of the deterministic file ids (fixed forever: changing it would
 *  make every re-run upload everything again). */
const FILE_ID_NAMESPACE = "6f1c2b8e-4d3a-4f6e-9b1d-7a5e0c3f2d18"

const attachFileSchema = z.object({
  // The source system's attachment id: with the task, the file's identity.
  sourceId: z.string().min(1),
  filename: z.string().min(1),
  // Required: it drives the thumbnail (image/*) and the blocked-type check.
  mimeType: z.string().min(1),
  // Declared byte length; when present it must equal the file on disk.
  size: z.number().int().nonnegative().optional().nullable(),
  // Relative to --files-dir; may not escape it.
  path: z.string().min(1),
})

/** Canonical NDJSON record: one original upload batch. */
const attachRecordSchema = z.object({
  // The task's external_ref (as imported by `projects import`).
  externalRef: z.string().min(1),
  // The source's batch id. Provenance only: idempotency is per file.
  batchKey: z.string().min(1).optional().nullable(),
  authorEmail: z.string().optional().nullable(),
  // Only labels a placeholder user (--placeholder-unknown-users).
  authorName: z.string().optional().nullable(),
  // ISO-8601; the files' created_at.
  createdAt: z.string().min(1),
  files: z.array(attachFileSchema).min(1),
})

type AttachRecord = z.infer<typeof attachRecordSchema>

export interface ProjectsAttachFilesReport {
  filesStored: number
  bytesStored: number
  /** Files already attached to their task (a previous run), not re-uploaded. */
  filesSkipped: number
  failed: Array<{ line: number; error: string }>
  /** Deactivated users created by --placeholder-unknown-users (once per email). */
  placeholdersCreated: Array<{ email: string }>
  /** Dry-run only: the placeholders a real run with the flag would create. */
  placeholdersPlanned: Array<{ line: number; email: string }>
  /** Objects uploaded for a record whose write then failed; unreferenced,
   *  deleted by the orphan GC after 24 h. */
  orphanedObjects: number
}

export interface RunProjectsAttachFilesArgs {
  file: string
  filesDir: string
  orgSlug?: string
  dryRun: boolean
  /** An unknown uploader becomes a deactivated org user instead of failing the
   *  record. Off by default: it creates identities, so it must be asked for. */
  placeholderUnknownUsers?: boolean
}

export interface RunProjectsAttachFilesResult {
  exitCode: number
  report: ProjectsAttachFilesReport
}

/** A record-level failure whose message is reported as is. */
class RecordError extends Error {}

/**
 * Parse an ISO-8601 timestamp, also accepting the `±HHMM` offset Jira exports
 * write (`2026-01-02T10:00:00.000+0100`), which is not in the ECMAScript date
 * format. Invalid → null.
 */
export function parseTimestamp(value: string): Date | null {
  const normalized = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2")
  const d = new Date(normalized)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * The deterministic id of a source attachment on a task: a name-based UUID
 * (RFC 4122 version 5: SHA-1 over the namespace bytes and the name). The same
 * attachment on the same task always gets the same row id and storage key.
 */
export function attachmentFileId(orgId: string, taskId: string, sourceId: string): string {
  const ns = Buffer.from(FILE_ID_NAMESPACE.replace(/-/g, ""), "hex")
  const hash = createHash("sha1")
    .update(ns)
    .update(`${orgId}:${taskId}:${sourceId}`, "utf8")
    .digest()
  hash[6] = (hash[6]! & 0x0f) | 0x50
  hash[8] = (hash[8]! & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Resolve `path` inside `realDir` (already realpath'd), following symlinks: a
 * link inside the directory that points outside it, `..`, an absolute path or
 * a sibling directory sharing the prefix are all rejected (a name that only
 * STARTS with `..`, such as `..notes.png`, is inside). Returns the real path
 * of a regular file and its size, so limits are checked before any read.
 */
async function resolveInsideDir(
  realDir: string,
  path: string,
): Promise<{ real: string; size: number }> {
  if (isAbsolute(path)) throw new RecordError(`file path "${path}" must be relative to --files-dir`)
  let realFile: string
  try {
    realFile = await realpath(resolve(realDir, path))
  } catch {
    throw new RecordError(`file "${path}" not found under --files-dir`)
  }
  const rel = relative(realDir, realFile)
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new RecordError(`file path "${path}" escapes --files-dir`)
  }
  const st = await stat(realFile)
  if (!st.isFile()) throw new RecordError(`file "${path}" is not a regular file`)
  return { real: realFile, size: st.size }
}

interface PendingFile {
  /** Deterministic row id (and storage-key segment). */
  id: string
  /** Index within the record. */
  ordinal: number
  file: AttachRecord["files"][number]
}

interface LoadedFile extends PendingFile {
  filename: string
  bytes: Buffer
}

/** Read and check the files to store (phase 2, before any upload). */
async function loadFiles(
  realDir: string,
  pending: PendingFile[],
  settings: OrgSettings,
): Promise<LoadedFile[]> {
  const limitBytes = settings.fileSizeLimitMb > 0 ? settings.fileSizeLimitMb * 1024 * 1024 : null
  const out: LoadedFile[] = []
  for (const p of pending) {
    const f = p.file
    const at = `files[${p.ordinal}] "${f.filename}"`
    const filename = sanitizeFilename(f.filename)
    // The operator imports these files: the extension allowance applies.
    if (isBlockedFileType(filename, f.mimeType, { staffAuthored: true })) {
      throw new RecordError(`${at}: blocked file type`)
    }
    const { real, size } = await resolveInsideDir(realDir, f.path)
    // From the file's size, before its bytes are loaded: an oversized file is
    // refused without being read into memory.
    if (f.size !== undefined && f.size !== null && f.size !== size) {
      throw new RecordError(`${at}: size ${size} does not match the declared ${f.size}`)
    }
    if (limitBytes !== null && size > limitBytes) {
      throw new RecordError(
        `${at}: ${size} bytes exceeds the org file size limit (${settings.fileSizeLimitMb} MB)`,
      )
    }
    const bytes = await readFile(real)
    if (bytes.byteLength !== size) {
      throw new RecordError(`${at}: file changed while it was read`)
    }
    out.push({ ...p, filename, bytes })
  }
  return out
}

async function findTaskId(
  tx: PrivilegedDb,
  orgId: string,
  externalRef: string,
): Promise<string | null> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${projectsRel("tasks")}
      WHERE org_id = ${orgId}::uuid AND external_ref = ${externalRef}
      LIMIT 1
    `),
  )
  return rows[0]?.id ?? null
}

/** Which of these file ids already exist (a previous run stored them). */
async function existingFileIds(
  tx: PrivilegedDb,
  orgId: string,
  ids: string[],
): Promise<Set<string>> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id FROM ${kernelRel("files")}
      WHERE org_id = ${orgId}::uuid
        AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid)
    `),
  )
  return new Set(rows.map((r) => r.id))
}

/** Does any user (any status) hold this email? The read-only twin of
 *  `resolveUser`'s placeholder lookup, for the dry-run's plan. */
async function anyUserHoldsEmail(tx: PrivilegedDb, orgId: string, email: string): Promise<boolean> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT id FROM ${kernelRel("users")}
      WHERE org_id = ${orgId}::uuid AND lower(email) = ${email}
        AND email NOT LIKE '%@import.invalid'
      LIMIT 1
    `),
  )
  return rows.length > 0
}

function unresolvedAuthorError(email: string | null): RecordError {
  return email
    ? new RecordError(`author ${email} not found; rerun with --placeholder-unknown-users`)
    : new RecordError("record has no authorEmail: a historical file needs its real uploader")
}

/**
 * Phase 3: the author and the file rows, with their events, in one privileged
 * transaction. Returns the files actually inserted (a concurrent run may have
 * inserted some first).
 */
async function writeFiles(
  orgId: string,
  record: AttachRecord,
  taskId: string,
  createdAt: Date,
  stored: Array<LoadedFile & { storageKey: string }>,
  opts: { placeholders: boolean },
): Promise<{ inserted: Array<LoadedFile & { storageKey: string }>; placeholderCreated: boolean }> {
  return withPrivilegedDb(orgId, "cli-projects-attach-files-write", async (tx) => {
    const author = await resolveUser(tx, orgId, record.authorEmail, record.authorName, opts)
    if (!author) throw unresolvedAuthorError(normalizeEmail(record.authorEmail))

    const at = createdAt.toISOString()
    const inserted: Array<LoadedFile & { storageKey: string }> = []
    for (const f of stored) {
      const rows = extractRows<{ id: string }>(
        await tx.execute(drizzleSql`
          INSERT INTO ${kernelRel("files")}
            (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
             storage_key, uploaded_by, disposition, ordinal, created_at)
          VALUES (${f.id}::uuid, ${orgId}::uuid, 'projects', 'task', ${taskId},
                  ${f.filename}, ${f.file.mimeType}, ${f.bytes.byteLength}, ${f.storageKey},
                  ${author.id}::uuid, 'attachment', ${f.ordinal}, ${at}::timestamptz)
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `),
      )
      if (rows.length === 0) continue
      inserted.push(f)
      // The upload path's event for a task file (files/service.ts
      // confirmUpload): thumbnails run; parentSharedSurface false, so the
      // attention translator notifies nobody.
      await tx.queueEvent({
        app: "kernel",
        entity: "file",
        action: "create",
        entityId: f.id,
        orgId,
        actorId: author.id,
        actorType: "user",
        data: {
          id: f.id,
          app: "projects",
          entityType: "task",
          entityId: taskId,
          filename: f.filename,
          mimeType: f.file.mimeType,
          sizeBytes: f.bytes.byteLength,
          storageKey: f.storageKey,
          parentSharedSurface: false,
          parentParticipantIds: [],
          parentLabel: null,
        },
      })
    }
    return { inserted, placeholderCreated: author.placeholderCreated }
  })
}

/**
 * Run `projects attach-files`. Streams the NDJSON line by line; a bad line is
 * reported in `failed[]` with its line number and the run continues.
 */
export async function runProjectsAttachFiles(
  args: RunProjectsAttachFilesArgs,
): Promise<RunProjectsAttachFilesResult> {
  const report: ProjectsAttachFilesReport = {
    filesStored: 0,
    bytesStored: 0,
    filesSkipped: 0,
    failed: [],
    placeholdersCreated: [],
    placeholdersPlanned: [],
    orphanedObjects: 0,
  }
  const placeholders = args.placeholderUnknownUsers === true

  const resolved = await resolveOrgId(
    args.orgSlug,
    "multiple orgs exist — pass --org <slug> to disambiguate",
  )
  if (!resolved.ok) {
    process.stderr.write(`projects attach-files: ${resolved.message}\n`)
    return { exitCode: 2, report }
  }
  const orgId = resolved.orgId

  let realDir: string
  try {
    realDir = await realpath(args.filesDir)
    if (!(await stat(realDir)).isDirectory()) throw new Error("not a directory")
  } catch {
    process.stderr.write(`projects attach-files: --files-dir ${args.filesDir} is not a directory\n`)
    return { exitCode: 2, report }
  }

  // Dry-run: bytes the run would have stored so far (nothing is committed, so
  // the quota check must add them itself), files already planned, and the
  // placeholder emails already planned.
  let plannedBytes = 0
  const plannedIds = new Set<string>()
  const plannedPlaceholders = new Set<string>()

  const rl = createInterface({
    input: createReadStream(args.file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  let lineNo = 0
  for await (const raw of rl) {
    lineNo++
    const line = raw.trim()
    if (line.length === 0) continue

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      report.failed.push({
        line: lineNo,
        error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      })
      continue
    }
    const validated = attachRecordSchema.safeParse(parsed)
    if (!validated.success) {
      const message = validated.error.issues
        .map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ")
      report.failed.push({ line: lineNo, error: `invalid record: ${message}` })
      continue
    }
    const record = validated.data

    // Objects of this record uploaded but not (yet) referenced by a committed row.
    let uploaded = 0
    try {
      const createdAt = parseTimestamp(record.createdAt)
      if (!createdAt) {
        throw new RecordError(`createdAt is not a valid ISO-8601 timestamp: "${record.createdAt}"`)
      }
      const sourceIds = record.files.map((f) => f.sourceId)
      if (new Set(sourceIds).size !== sourceIds.length) {
        throw new RecordError("files[].sourceId must be unique within a record")
      }

      // Phase 1: task, files already stored, settings, author (read only).
      const pre = await withPrivilegedDb(orgId, "cli-projects-attach-files-read", async (tx) => {
        const taskId = await findTaskId(tx, orgId, record.externalRef)
        if (!taskId) {
          throw new RecordError(`no task with externalRef "${record.externalRef}" in this org`)
        }
        const all: PendingFile[] = record.files.map((file, ordinal) => ({
          id: attachmentFileId(orgId, taskId, file.sourceId),
          ordinal,
          file,
        }))
        const existing = await existingFileIds(
          tx,
          orgId,
          all.map((p) => p.id),
        )
        const pending = all.filter((p) => !existing.has(p.id) && !plannedIds.has(p.id))
        const settings = await loadOrgSettings(tx, orgId)
        const email = normalizeEmail(record.authorEmail)
        let placeholderNeeded = false
        if (pending.length > 0) {
          const active = await resolveUser(tx, orgId, email, null, { placeholders: false })
          if (!active) {
            if (!placeholders || !email || email.endsWith("@import.invalid")) {
              throw unresolvedAuthorError(email)
            }
            placeholderNeeded = !(await anyUserHoldsEmail(tx, orgId, email))
          }
        }
        return { taskId, pending, settings, email, placeholderNeeded }
      })
      const skipped = record.files.length - pre.pending.length
      if (pre.pending.length === 0) {
        report.filesSkipped += skipped
        continue
      }

      // Phase 2: files, then ONE quota check for the record.
      const files = await loadFiles(realDir, pre.pending, pre.settings)
      const recordBytes = files.reduce((n, f) => n + f.bytes.byteLength, 0)
      const overQuota = await withPrivilegedDb(orgId, "cli-projects-attach-files-quota", (tx) =>
        wouldExceedOrgQuota(tx, orgId, pre.settings, recordBytes + plannedBytes),
      )
      if (overQuota) {
        throw new RecordError(
          `the files (${recordBytes} bytes) would exceed the org storage quota ` +
            `(${pre.settings.storageQuotaGb} GB)`,
        )
      }

      if (args.dryRun) {
        report.filesSkipped += skipped
        plannedBytes += recordBytes
        for (const f of files) plannedIds.add(f.id)
        if (pre.placeholderNeeded && pre.email && !plannedPlaceholders.has(pre.email)) {
          plannedPlaceholders.add(pre.email)
          report.placeholdersPlanned.push({ line: lineNo, email: pre.email })
        }
        continue
      }

      const stored: Array<LoadedFile & { storageKey: string }> = []
      for (const f of files) {
        const storageKey = buildStorageKey({
          orgId,
          app: "projects",
          entityType: "task",
          entityId: pre.taskId,
          filename: f.filename,
          objectId: f.id,
        })
        await putObject({ key: storageKey, body: f.bytes, contentType: f.file.mimeType })
        uploaded++
        stored.push({ ...f, storageKey })
      }

      // Phase 3. A file a concurrent run inserted first is a skip; its object
      // is that row's (same key, same bytes), not an orphan.
      const written = await writeFiles(orgId, record, pre.taskId, createdAt, stored, {
        placeholders,
      })
      uploaded = 0
      report.filesStored += written.inserted.length
      report.bytesStored += written.inserted.reduce((n, f) => n + f.bytes.byteLength, 0)
      report.filesSkipped += skipped + (stored.length - written.inserted.length)
      if (written.placeholderCreated && pre.email) {
        report.placeholdersCreated.push({ email: pre.email })
      }
    } catch (err) {
      report.orphanedObjects += uploaded
      const message = err instanceof Error ? err.message : String(err)
      if (!(err instanceof RecordError)) {
        log.error({ err, line: lineNo, externalRef: record.externalRef }, "attach-files failed")
      }
      report.failed.push({ line: lineNo, error: message })
    }
  }

  return { exitCode: report.failed.length > 0 ? 1 : 0, report }
}
