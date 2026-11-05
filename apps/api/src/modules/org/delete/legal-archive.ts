// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The legal-retention archive of an org being deleted (spec S2.6, D2, A21, A26).
//
// What it holds (and nothing else, minimisation):
//   data/<schema>.<table>.<n>.ndjson  the org's LEGAL rows, as `row_to_json`,
//                                     in parts of at most PART_BYTES (a name
//                                     too long for tar becomes
//                                     `data/table-<i>.<n>.ndjson`; manifest.json
//                                     maps every entry to its table). From the
//                                     catalog: every row of an `app_*` table
//                                     under the kernel immutability trigger
//                                     (manifest `immutable`), and the rows a
//                                     table's `legalRetention` marker selects:
//                                     `true` (every row), `{ where }` (rows whose
//                                     columns hold one of the listed values) or
//                                     `{ parent }` (rows whose parent row, in a
//                                     marked table of the same app, is kept).
//   data/kernel.audit_log.<n>.ndjson  the org's audit log.
//   files/<file id>/<name>            every file attached to a kept row (its
//                                     `kernel.files` app and entity id point at
//                                     the row), bytes as stored; the name is cut
//                                     to fit tar (the full one is in files.ndjson).
//   files.ndjson                      those files' `kernel.files` rows.
//   manifest.json                     org id, name, slug, deletedAt, counts,
//                                     retainUntil, the container and encryption,
//                                     and the files whose object was missing.
//
// Container: tar (ustar). The tar is streamed through `age-encryption`
// (`Encrypter.addRecipient(<operator's recipient>)`, `encrypt(ReadableStream)`)
// straight into a multipart upload at `legal-archives/<org id>/<timestamp>.tar.age`,
// outside the org's own prefix, so the org purge never touches it. The
// instance only ever holds the RECIPIENT (a public key): it can write an
// archive and never read one. The operator decrypts with
// `age -d -i <identity file> <archive> | tar -x`.
//
// `kernel.legal_archives` records each archive with `retain_until`
// (LEGAL_ARCHIVE_RETENTION_YEARS after the deletion); a daily leader singleton
// deletes the object once that date has passed. The row is written (pending,
// `recorded_at` null) BEFORE the upload, so an archive whose run died before
// recording it is never kept unindexed: the sweep deletes a pending one after a
// day.
import { Encrypter } from "age-encryption"
import { and, sql as drizzleSql, eq, isNull, lt, or } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { legalArchives, orgDeletions } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { registerSingleton } from "~/infra/leadership"
import { putObjectStream } from "~/infra/storage/multipart"
import { deleteObject, getObjectStream, sanitizeFilename } from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import { IMMUTABLE_TRIGGER_NAME } from "~/modules/apps/ddl"
import { tarEnd, tarEntry, tarHeader, tarNameFits, tarPadding } from "~/modules/org/delete/tar"

const log = rootLogger.child({ module: "legal-archive" })

export const LEGAL_ARCHIVE_FORMAT_VERSION = 1
export const LEGAL_ARCHIVE_PREFIX = "legal-archives"
/** One NDJSON part holds at most this many bytes (a tar entry needs its size first). */
const PART_BYTES = 4 * 1024 * 1024
const BATCH_ROWS = 500
/** Far above any legal archive; the multipart writer aborts past it. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
/** A pending `legal_archives` row older than this lost its run: the sweep deletes it. */
const PENDING_ARCHIVE_MAX_AGE_MS = DAY_MS
/** How deep a `legalRetention.parent` chain is followed. */
const MAX_PARENT_DEPTH = 4
/** The last path segment of a file entry, in bytes (ustar's name field). */
const FILE_NAME_BYTES = 100

/** Thrown when the recipient is not an age recipient. */
export class InvalidLegalArchiveRecipientError extends Error {
  constructor(detail: string) {
    super(`LEGAL_ARCHIVE_RECIPIENT is not an age recipient (age1...): ${detail}`)
    this.name = "InvalidLegalArchiveRecipientError"
  }
}

/** Parse the recipient the way the archive will use it; throws when it is not one. */
export function assertLegalArchiveRecipient(recipient: string): void {
  try {
    new Encrypter().addRecipient(recipient)
  } catch (err) {
    throw new InvalidLegalArchiveRecipientError(err instanceof Error ? err.message : String(err))
  }
}

/**
 * Which rows of a marked table are kept: a `where` (every listed column holds
 * one of its values, compared as text) and/or a `parent` (the row's `column`
 * names the `id` of a kept row of `table`). No filter: every row.
 */
export interface LegalRowFilter {
  where?: Array<{ column: string; values: string[] }>
  parent?: { schema: string; table: string; column: string; filter?: LegalRowFilter }
}

export interface LegalTable {
  /** Physical schema (with any test prefix). */
  schema: string
  table: string
  reason: "immutable" | "legalRetention"
  /** Only for `legalRetention`; immutable tables keep every row. */
  filter?: LegalRowFilter
}

/** The manifest part this module reads: each table's `legalRetention` marker. */
export interface LegalRetentionManifest {
  name: string
  schema?: Record<string, unknown> | null
}

type Marker =
  | true
  | {
      where?: Record<string, { in: Array<string | number | boolean> }>
      parent?: { table: string; column: string }
    }

function markerOf(def: unknown): Marker | null {
  const m = (def as { legalRetention?: unknown } | null)?.legalRetention
  if (m === true) return true
  if (m && typeof m === "object") return m as Marker
  return null
}

/**
 * The row filter of `table`'s marker, following `parent` within the app. A
 * parent that is not itself marked keeps the child rows of every parent row.
 */
function filterOf(
  schemaName: string,
  tables: Record<string, unknown>,
  table: string,
  depth: number,
): LegalRowFilter | undefined {
  const marker = markerOf(tables[table])
  if (marker === null || marker === true) return undefined
  const out: LegalRowFilter = {}
  if (marker.where) {
    out.where = Object.entries(marker.where).map(([column, cond]) => ({
      column,
      values: (cond?.in ?? []).map(String),
    }))
  }
  if (marker.parent) {
    if (depth >= MAX_PARENT_DEPTH) {
      throw new Error(`legalRetention parent chain of ${table} is deeper than ${MAX_PARENT_DEPTH}`)
    }
    const parentFilter = filterOf(schemaName, tables, marker.parent.table, depth + 1)
    out.parent = {
      schema: schemaName,
      table: marker.parent.table,
      column: marker.parent.column,
      ...(parentFilter ? { filter: parentFilter } : {}),
    }
  }
  return out
}

/** Tables a manifest marks `legalRetention`, as `app_<name>` physical tables, with their row filter. */
export function legalRetentionTablesOf(manifests: readonly LegalRetentionManifest[]): LegalTable[] {
  const out: LegalTable[] = []
  for (const m of manifests) {
    const tables = (m.schema ?? {}) as Record<string, unknown>
    const schemaName = schemaRef(`app_${m.name.replace(/-/g, "_")}`)
    for (const [table, def] of Object.entries(tables)) {
      if (markerOf(def) === null) continue
      const filter = filterOf(schemaName, tables, table, 0)
      out.push({
        schema: schemaName,
        table,
        reason: "legalRetention",
        ...(filter ? { filter } : {}),
      })
    }
  }
  return out
}

/** The SQL condition a filter puts on `alias` (always parameterised; identifiers quoted). */
function rowFilterSql(
  filter: LegalRowFilter | undefined,
  alias: string,
  orgId: string,
  depth = 0,
): ReturnType<typeof drizzleSql> {
  if (!filter) return drizzleSql``
  const parts: Array<ReturnType<typeof drizzleSql>> = []
  const a = drizzleSql.raw(quoteIdent(alias))
  for (const w of filter.where ?? []) {
    if (w.values.length === 0) {
      parts.push(drizzleSql` AND false`)
      continue
    }
    parts.push(
      drizzleSql` AND ${a}.${drizzleSql.raw(quoteIdent(w.column))}::text IN (${drizzleSql.join(
        w.values.map((v) => drizzleSql`${v}`),
        drizzleSql`, `,
      )})`,
    )
  }
  if (filter.parent) {
    const p = `p${depth}`
    const pRel = drizzleSql.raw(
      `${quoteIdent(filter.parent.schema)}.${quoteIdent(filter.parent.table)}`,
    )
    parts.push(
      drizzleSql` AND ${a}.${drizzleSql.raw(quoteIdent(filter.parent.column))} IN (SELECT ${drizzleSql.raw(quoteIdent(p))}.id FROM ${pRel} ${drizzleSql.raw(quoteIdent(p))} WHERE ${drizzleSql.raw(quoteIdent(p))}.org_id = ${orgId}::uuid${rowFilterSql(filter.parent.filter, p, orgId, depth + 1)})`,
    )
  }
  return drizzleSql.join(parts, drizzleSql``)
}

/** The registered apps' manifests (server side: the catalog this process registers). */
async function registeredManifests(): Promise<LegalRetentionManifest[]> {
  const { getDefaultApps } = await import("~/modules/apps/init")
  return (await getDefaultApps()).map((a) => ({ name: String(a.name), schema: a.schema ?? null }))
}

/**
 * Every legal table that exists and carries `org_id`: the immutable ones (the
 * kernel trigger, read from pg_catalog) plus the `legalRetention` ones.
 */
export async function discoverLegalTables(
  manifests: readonly LegalRetentionManifest[],
): Promise<LegalTable[]> {
  const marked = legalRetentionTablesOf(manifests)
  const rows = await withSystemDb("legal-archive-tables", async (tx) =>
    extractRows<{ schema: string; table: string; immutable: boolean }>(
      await tx.execute(drizzleSql`
        SELECT c.table_schema AS schema, c.table_name AS table,
          EXISTS (
            SELECT 1 FROM pg_trigger tr
            JOIN pg_class rel ON rel.oid = tr.tgrelid
            JOIN pg_namespace n ON n.oid = rel.relnamespace
            WHERE tr.tgname = ${IMMUTABLE_TRIGGER_NAME} AND NOT tr.tgisinternal
              AND n.nspname = c.table_schema AND rel.relname = c.table_name
          ) AS immutable
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.column_name = 'org_id' AND t.table_type = 'BASE TABLE'
          AND c.table_schema LIKE 'app\\_%'
        ORDER BY c.table_schema, c.table_name
      `),
    ),
  )
  const byKey = new Map(marked.map((m) => [`${m.schema}.${m.table}`, m]))
  const out: LegalTable[] = []
  for (const r of rows) {
    const m = byKey.get(`${r.schema}.${r.table}`)
    if (r.immutable) out.push({ schema: r.schema, table: r.table, reason: "immutable" })
    else if (m) out.push(m)
  }
  return out
}

/** `<logical schema>.<table>`: the schema without the test prefix. */
function logicalName(schema: string, table: string): string {
  const prefix = schemaRef("")
  const logical = prefix && schema.startsWith(prefix) ? schema.slice(prefix.length) : schema
  return `${logical}.${table}`
}

interface PrimaryKey {
  columns: string[]
  types: string[]
}

async function primaryKeyOf(schema: string, table: string): Promise<PrimaryKey | null> {
  const rows = await withSystemDb("legal-archive-pk", async (tx) =>
    extractRows<{ column: string; type: string }>(
      await tx.execute(drizzleSql`
        SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
        WHERE i.indisprimary AND n.nspname = ${schema} AND c.relname = ${table}
        ORDER BY k.ord
      `),
    ),
  )
  if (rows.length === 0) return null
  return { columns: rows.map((r) => r.column), types: rows.map((r) => r.type) }
}

/** The org's rows of one table as JSON lines, keyset-paged, one short transaction per batch. */
async function* rowLines(
  schema: string,
  table: string,
  orgId: string,
  stats: { rows: number },
  filter?: LegalRowFilter,
): AsyncGenerator<string> {
  const pk = await primaryKeyOf(schema, table)
  const where = rowFilterSql(filter, "t", orgId)
  const rel = drizzleSql.raw(`${quoteIdent(schema)}.${quoteIdent(table)}`)
  if (!pk) {
    // No primary key to page by: one read (legal tables all have one).
    const rows = await withSystemDb("legal-archive-rows", async (tx) =>
      extractRows<{ line: string }>(
        await tx.execute(
          drizzleSql`SELECT row_to_json(t)::text AS line FROM ${rel} t WHERE t.org_id = ${orgId}::uuid${where}`,
        ),
      ),
    )
    for (const r of rows) {
      stats.rows++
      yield r.line
    }
    return
  }
  const cols = pk.columns.map((c) => `t.${quoteIdent(c)}`).join(", ")
  const keyOut = pk.columns.map((c, i) => `t.${quoteIdent(c)}::text AS __k${i}`).join(", ")
  let after: string[] | null = null
  for (;;) {
    const afterSql: ReturnType<typeof drizzleSql> =
      after === null
        ? drizzleSql``
        : drizzleSql` AND (${drizzleSql.raw(cols)}) > (${drizzleSql.join(
            after.map((v, i) => drizzleSql`${v}::${drizzleSql.raw(pk.types[i] ?? "text")}`),
            drizzleSql`, `,
          )})`
    const rows = await withSystemDb("legal-archive-rows", async (tx) =>
      extractRows<Record<string, string>>(
        await tx.execute(drizzleSql`
          SELECT row_to_json(t)::text AS __line, ${drizzleSql.raw(keyOut)}
          FROM ${rel} t
          WHERE t.org_id = ${orgId}::uuid${where}${afterSql}
          ORDER BY ${drizzleSql.raw(cols)}
          LIMIT ${BATCH_ROWS}
        `),
      ),
    )
    for (const r of rows) {
      stats.rows++
      yield String(r.__line)
    }
    const last = rows[rows.length - 1]
    if (!last || rows.length < BATCH_ROWS) return
    after = pk.columns.map((_, i) => String(last[`__k${i}`]))
  }
}

/** JSON lines cut into tar entries of at most PART_BYTES each: `<base>.<n>.ndjson`. */
async function* ndjsonParts(
  base: string,
  lines: AsyncIterable<string>,
  entries: string[],
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder()
  let part: string[] = []
  let bytes = 0
  let n = 0
  const flush = function* () {
    n++
    const name = `${base}.${String(n).padStart(4, "0")}.ndjson`
    entries.push(name)
    yield* tarEntry(name, encoder.encode(part.join("")))
    part = []
    bytes = 0
  }
  for await (const line of lines) {
    const l = `${line}\n`
    const size = Buffer.byteLength(l)
    if (bytes > 0 && bytes + size > PART_BYTES) yield* flush()
    part.push(l)
    bytes += size
  }
  if (bytes > 0) yield* flush()
}

interface LegalFileRow {
  id: string
  filename: string
  storage_key: string
  line: string
}

/** Files attached to a legal row of `t` (same app, entity id = the row's id). */
async function legalFilesOf(t: LegalTable, orgId: string): Promise<LegalFileRow[]> {
  const K = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
  const rel = drizzleSql.raw(`${quoteIdent(t.schema)}.${quoteIdent(t.table)}`)
  const appKey = logicalName(t.schema, t.table).split(".")[0]?.replace(/^app_/, "") ?? ""
  return withSystemDb("legal-archive-files", async (tx) => {
    const hasId = extractRows<{ n: number }>(
      await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = ${t.schema} AND table_name = ${t.table} AND column_name = 'id'
      `),
    )[0]
    if (!hasId?.n) return []
    return extractRows<LegalFileRow>(
      await tx.execute(drizzleSql`
        SELECT f.id::text AS id, f.filename, f.storage_key, row_to_json(f)::text AS line
        FROM ${K}.files f
        WHERE f.org_id = ${orgId}::uuid
          AND replace(f.app, '-', '_') = ${appKey}
          AND f.entity_id IN (SELECT r.id::text FROM ${rel} r WHERE r.org_id = ${orgId}::uuid${rowFilterSql(t.filter, "r", orgId)})
        ORDER BY f.id
      `),
    )
  })
}

/** `s` cut to at most `max` UTF-8 bytes, on a code point boundary. */
function cutToBytes(s: string, max: number): string {
  let out = ""
  let bytes = 0
  for (const ch of s) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > max) break
    out += ch
    bytes += n
  }
  return out
}

/**
 * A file's entry name: `files/<id>/<sanitized name>`, the name cut on code
 * point boundaries so its last segment fits ustar's 100 bytes (the extension
 * kept). The full name is in files.ndjson.
 */
export function fileEntryName(id: string, filename: string): string {
  const safe = sanitizeFilename(filename || "file")
  const dot = safe.lastIndexOf(".")
  const ext = dot > 0 && Buffer.byteLength(safe.slice(dot)) <= 10 ? safe.slice(dot) : ""
  const stem = ext ? safe.slice(0, dot) : safe
  const cut = cutToBytes(stem, FILE_NAME_BYTES - Buffer.byteLength(ext))
  return `files/${id}/${cut || "file"}${ext}`
}

/**
 * The base of a table's data entries: `data/<schema>.<table>`, or
 * `data/table-<index>` when that name (with its `.<n>.ndjson`) would not fit
 * the tar name fields. manifest.json maps every entry to its table either way.
 */
export function dataEntryBase(index: number, logical: string): string {
  const readable = `data/${logical}`
  return tarNameFits(`${readable}.0000.ndjson`) ? readable : `data/table-${index + 1}`
}

function isMissingObject(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404
}

/** Open a file's object; null when the object is gone (recorded as missing, never fatal). */
async function openFileObject(storageKey: string) {
  try {
    return await getObjectStream(storageKey)
  } catch (err) {
    if (isMissingObject(err)) return null
    throw err
  }
}

async function* fileEntry(
  name: string,
  storageKey: string,
  obj: Awaited<ReturnType<typeof getObjectStream>>,
): AsyncGenerator<Uint8Array> {
  yield tarHeader(name, obj.contentLength)
  let written = 0
  for await (const chunk of obj.stream as unknown as AsyncIterable<Uint8Array>) {
    written += chunk.byteLength
    if (written > obj.contentLength) throw new Error(`object ${storageKey} grew while read`)
    yield chunk
  }
  if (written !== obj.contentLength) {
    throw new Error(`object ${storageKey}: read ${written} of ${obj.contentLength} bytes`)
  }
  const pad = tarPadding(written)
  if (pad.byteLength > 0) yield pad
}

export interface LegalArchiveManifest {
  formatVersion: number
  kind: "legal-retention-archive"
  container: "tar"
  encryption: "age"
  rowEncoding: "postgres row_to_json"
  org: { id: string; name: string; slug: string }
  deletedAt: string
  retainUntil: string
  retentionYears: number
  tables: Array<{
    schema: string
    table: string
    reason: string
    /** The `legalRetention` row filter applied, when there was one. */
    filter?: LegalRowFilter
    rows: number
    entries: string[]
  }>
  auditLog: { rows: number; entries: string[] }
  files: {
    count: number
    bytes: number
    /** Files whose `kernel.files` row names an object the store no longer has. */
    missing: Array<{ id: string; storageKey: string; filename: string }>
  }
}

export interface WriteLegalArchiveInput {
  org: { id: string; name: string; slug: string }
  recipient: string
  /** Default: now. */
  deletedAt?: Date
  /** Default: LEGAL_ARCHIVE_RETENTION_YEARS. */
  retentionYears?: number
  /** Default: the manifests of the apps this process registers. */
  manifests?: readonly LegalRetentionManifest[]
  signal?: AbortSignal
  /** Called with the object key before anything is uploaded (the job reserves its index row). */
  beforeUpload?: (archive: { objectKey: string; retainUntil: Date }) => Promise<void>
}

export interface WrittenLegalArchive {
  objectKey: string
  bytes: number
  retainUntil: Date
  manifest: LegalArchiveManifest
}

/** `legal-archives/<org id>/<timestamp>.tar.age`. */
export function legalArchiveObjectKey(orgId: string, at: Date): string {
  return `${LEGAL_ARCHIVE_PREFIX}/${orgId}/${at.toISOString().replace(/[:.]/g, "-")}.tar.age`
}

function addYears(d: Date, years: number): Date {
  const out = new Date(d.getTime())
  out.setUTCFullYear(out.getUTCFullYear() + years)
  return out
}

/**
 * Build the archive of `org`, encrypt it to `recipient` and store it. Writes
 * the object only; the caller records it (`recordLegalArchive`). Nothing is
 * left behind on failure (the multipart upload is aborted).
 */
export async function writeLegalArchive(
  input: WriteLegalArchiveInput,
): Promise<WrittenLegalArchive> {
  const { org, recipient } = input
  assertLegalArchiveRecipient(recipient)
  const deletedAt = input.deletedAt ?? new Date()
  const retentionYears = input.retentionYears ?? env.LEGAL_ARCHIVE_RETENTION_YEARS
  const retainUntil = addYears(deletedAt, retentionYears)
  const tables = await discoverLegalTables(input.manifests ?? (await registeredManifests()))
  const objectKey = legalArchiveObjectKey(org.id, deletedAt)
  await input.beforeUpload?.({ objectKey, retainUntil })
  const manifest: LegalArchiveManifest = {
    formatVersion: LEGAL_ARCHIVE_FORMAT_VERSION,
    kind: "legal-retention-archive",
    container: "tar",
    encryption: "age",
    rowEncoding: "postgres row_to_json",
    org,
    deletedAt: deletedAt.toISOString(),
    retainUntil: retainUntil.toISOString(),
    retentionYears,
    tables: [],
    auditLog: { rows: 0, entries: [] },
    files: { count: 0, bytes: 0, missing: [] },
  }

  async function* tar(): AsyncGenerator<Uint8Array> {
    const fileLines: string[] = []
    for (const [index, t] of tables.entries()) {
      const stats = { rows: 0 }
      const entries: string[] = []
      yield* ndjsonParts(
        dataEntryBase(index, logicalName(t.schema, t.table)),
        rowLines(t.schema, t.table, org.id, stats, t.filter),
        entries,
      )
      manifest.tables.push({
        schema: logicalName(t.schema, t.table).split(".")[0] ?? t.schema,
        table: t.table,
        reason: t.reason,
        ...(t.filter ? { filter: t.filter } : {}),
        rows: stats.rows,
        entries,
      })
      for (const f of await legalFilesOf(t, org.id)) {
        input.signal?.throwIfAborted()
        const obj = await openFileObject(f.storage_key)
        if (!obj) {
          log.warn(
            { orgId: org.id, fileId: f.id, storageKey: f.storage_key },
            "legal file's object is missing; recorded in the archive manifest",
          )
          manifest.files.missing.push({ id: f.id, storageKey: f.storage_key, filename: f.filename })
          fileLines.push(`${f.line}\n`)
          continue
        }
        const name = fileEntryName(f.id, f.filename)
        let size = 0
        for await (const chunk of fileEntry(name, f.storage_key, obj)) {
          size += chunk.byteLength
          yield chunk
        }
        manifest.files.count++
        manifest.files.bytes += size
        fileLines.push(`${f.line}\n`)
      }
    }
    const auditStats = { rows: 0 }
    yield* ndjsonParts(
      `data/kernel.audit_log`,
      rowLines(schemaRef("kernel"), "audit_log", org.id, auditStats),
      manifest.auditLog.entries,
    )
    manifest.auditLog.rows = auditStats.rows
    yield* tarEntry("files.ndjson", new TextEncoder().encode(fileLines.join("")))
    yield* tarEntry("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)))
    yield tarEnd()
  }

  const source = tar()
  const plaintext = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await source.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel() {
      await source.return(undefined)
    },
  })
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  const ciphertext = await encrypter.encrypt(plaintext)
  const bytes = await putObjectStream({
    key: objectKey,
    contentType: "application/octet-stream",
    body: ciphertext as unknown as AsyncIterable<Uint8Array>,
    maxBytes: MAX_ARCHIVE_BYTES,
    ...(input.signal ? { signal: input.signal } : {}),
  })
  return { objectKey, bytes, retainUntil, manifest }
}

/** The counts a ledger and the `legal_archives` row keep. */
export function legalArchiveCounts(m: LegalArchiveManifest): Record<string, unknown> {
  return {
    tables: Object.fromEntries(m.tables.map((t) => [`${t.schema}.${t.table}`, t.rows])),
    auditLog: m.auditLog.rows,
    files: m.files.count,
    fileBytes: m.files.bytes,
    filesMissing: m.files.missing.length,
  }
}

/** Delete an archive's object and mark its row deleted (an aborted deletion, the expiry sweep). */
export async function deleteLegalArchive(objectKey: string): Promise<void> {
  await deleteObject(objectKey)
  await withSystemDb("legal-archive-delete", (tx) =>
    tx
      .update(legalArchives)
      .set({ deletedAt: drizzleSql`now()` })
      .where(and(eq(legalArchives.objectKey, objectKey), isNull(legalArchives.deletedAt))),
  )
}

/**
 * Reserve an archive's `legal_archives` row before its upload: pending
 * (`recorded_at` null) until `recordLegalArchive` completes it. A pending row
 * the run never completed is deleted, object included, by the daily sweep.
 */
export async function reserveLegalArchive(args: {
  org: { id: string; slug: string }
  recipient: string
  objectKey: string
  retainUntil: Date
}): Promise<void> {
  await withSystemDb("legal-archive-reserve", (tx) =>
    tx.insert(legalArchives).values({
      deletedOrgId: args.org.id,
      orgSlug: args.org.slug,
      objectKey: args.objectKey,
      recipient: args.recipient,
      retainUntil: args.retainUntil,
      recordedAt: null,
    }),
  )
}

/**
 * Record a written archive: its `legal_archives` row and, in the same
 * transaction, the ledger's archive key and step, only while `runId` still
 * holds the deletion. False when the run lost it (an `--abort` won): nothing is
 * recorded and the caller deletes the object.
 */
export async function recordLegalArchive(args: {
  deletionId: string
  runId: string
  org: { id: string; slug: string }
  recipient: string
  archive: WrittenLegalArchive
  step: string
}): Promise<boolean> {
  const counts = legalArchiveCounts(args.archive.manifest)
  return withSystemDb("legal-archive-record", async (tx) => {
    const held = await tx
      .update(orgDeletions)
      .set({
        archiveKey: args.archive.objectKey,
        stepsDone: drizzleSql`array_append(array_remove(${orgDeletions.stepsDone}, ${args.step}::text), ${args.step}::text)`,
        counts: drizzleSql`COALESCE(${orgDeletions.counts}, '{}'::jsonb) || ${JSON.stringify({ legalArchive: counts })}::jsonb`,
        updatedAt: drizzleSql`now()`,
      })
      .where(
        and(
          eq(orgDeletions.id, args.deletionId),
          eq(orgDeletions.runId, args.runId),
          eq(orgDeletions.status, "running"),
        ),
      )
      .returning({ id: orgDeletions.id })
    if (held.length === 0) return false
    await tx
      .insert(legalArchives)
      .values({
        deletedOrgId: args.org.id,
        orgSlug: args.org.slug,
        objectKey: args.archive.objectKey,
        recipient: args.recipient,
        bytes: args.archive.bytes,
        counts,
        retainUntil: args.archive.retainUntil,
        recordedAt: drizzleSql`now()`,
      })
      .onConflictDoUpdate({
        target: legalArchives.objectKey,
        set: {
          bytes: args.archive.bytes,
          counts,
          retainUntil: args.archive.retainUntil,
          recordedAt: drizzleSql`now()`,
        },
      })
    return true
  })
}

/**
 * Delete every archive past its `retain_until`, and every pending one (written
 * before its upload, never recorded) older than a day: object, then the row's
 * `deleted_at`. A failed object delete leaves the row for the next sweep.
 */
export async function sweepExpiredLegalArchives(now: Date = new Date()): Promise<number> {
  const pendingBefore = new Date(now.getTime() - PENDING_ARCHIVE_MAX_AGE_MS)
  const due = await withSystemDb("legal-archive-expiry-list", (tx) =>
    tx
      .select({
        id: legalArchives.id,
        objectKey: legalArchives.objectKey,
        orgId: legalArchives.deletedOrgId,
      })
      .from(legalArchives)
      .where(
        and(
          isNull(legalArchives.deletedAt),
          or(
            lt(legalArchives.retainUntil, now),
            and(isNull(legalArchives.recordedAt), lt(legalArchives.createdAt, pendingBefore)),
          ),
        ),
      )
      .orderBy(legalArchives.retainUntil)
      .limit(500),
  )
  let deleted = 0
  for (const r of due) {
    try {
      await deleteLegalArchive(r.objectKey)
      deleted++
    } catch (err) {
      log.error(
        { err, archiveId: r.id, orgId: r.orgId, objectKey: r.objectKey },
        "legal archive past its retention not deleted; the next sweep retries",
      )
    }
  }
  if (deleted > 0) log.info({ deleted }, "legal archives past their retention deleted")
  return deleted
}

/** The daily retention sweep, run once per cell by the leader. */
export function registerLegalArchiveRetention(opts: { everyMs?: number } = {}): void {
  let timer: ReturnType<typeof setInterval> | null = null
  const run = () => {
    sweepExpiredLegalArchives().catch((err: unknown) =>
      log.error({ err }, "legal archive retention sweep failed"),
    )
  }
  registerSingleton({
    name: "legal-archive-retention",
    onAcquired: () => {
      run()
      timer ??= setInterval(run, opts.everyMs ?? DAY_MS)
    },
    onLost: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  })
}
