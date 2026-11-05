// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Where an import run's records come from, streamed line by line (never the
 * whole file in memory):
 *
 * - `file`: canonical NDJSON in an uploaded `kernel.files` row. The id is
 *   resolved under the ACTOR's RLS (`files_select`) with an org check, so a run
 *   can only read a file its person can read (A9).
 * - `path`: a local NDJSON file. CLI runs only: the API and the job refuse it
 *   before any read (R10).
 * - `records`: records a client already parsed (the CLI importers, which keep
 *   their own line numbers and validators). CLI runs only.
 *
 * A line longer than one record's cap (1 MB, PARSER_RECORD_MAX_BYTES) refuses
 * the source, as the parsers do.
 *
 * A line is either a bare record (a single-kind run) or an envelope
 * `{"kind": "<app>.<kind>", "record": {...}}`. A `format` other than NDJSON
 * is a standard read host-side into one kind's records (`ics`: an iCalendar
 * file's events, `calendar.event`).
 */
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer, getObjectStream } from "~/infra/storage/object-storage"
import { PARSER_RECORD_MAX_BYTES } from "~/modules/imports/parsers/common"
import { parseIcs } from "~/modules/imports/parsers/ics"
import type { TransformSource } from "~/modules/imports/transform-run"
import { ImportError } from "~/modules/imports/types"

/**
 * The format of a file or path source: canonical NDJSON (the default), or a
 * standard read host-side into one kind's records (`FORMAT_KINDS`).
 */
export type ImportFormat = "ndjson" | "ics"

/** The one kind a standard format's records belong to. */
export const FORMAT_KINDS: Readonly<Record<Exclude<ImportFormat, "ndjson">, string>> = {
  ics: "calendar.event",
}

/** The largest file a whole-file format reads (an ICS export is small text). */
export const WHOLE_FILE_FORMAT_MAX_BYTES = 50 * 1024 * 1024

export type ImportSource =
  | { type: "file"; fileId: string; format?: ImportFormat }
  | { type: "path"; path: string; format?: ImportFormat }
  | { type: "records"; records: AsyncIterable<SourceItem> | Iterable<SourceItem> }
  /** A transform over uploaded files or an API connection (transform-run.ts). */
  | TransformSource

/** One parsed source line: a record (with its kind when the line named one)
 *  or the reason the line could not be read. */
export type SourceItem =
  | { line: number; kind?: string; record: unknown }
  | { line: number; error: string }

/** A file a run reads: visible to the actor, in the actor's org, not sealed. */
export interface ResolvedImportFile {
  id: string
  storageKey: string
  filename: string
  mimeType: string
  sizeBytes: number
}

/**
 * Resolve an uploaded file under the actor's RLS. Refuses a file the actor
 * cannot see (another person's private file, another org's file) and a sealed
 * (end-to-end encrypted) one, whose bytes the server cannot read.
 */
export async function resolveImportFile(
  actor: UserContext,
  fileId: string,
): Promise<ResolvedImportFile> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fileId)) {
    throw new ImportError("file_not_found", "File not found")
  }
  const K = drizzleSql.raw(schemaRef("kernel"))
  const rows = await withRlsContext(actor, async (tx) =>
    extractRows<{
      id: string
      org_id: string
      storage_key: string
      filename: string
      mime_type: string
      size_bytes: string | number
      enc_version: number | null
    }>(
      await tx.execute(drizzleSql`
        SELECT id, org_id, storage_key, filename, mime_type, size_bytes, enc_version
        FROM ${K}.files WHERE id = ${fileId}::uuid LIMIT 1
      `),
    ),
  )
  const row = rows[0]
  if (!row || row.org_id !== actor.orgId) {
    throw new ImportError("file_not_found", "File not found")
  }
  if (Number(row.enc_version ?? 0) > 0) {
    throw new ImportError("invalid_source", "An end-to-end encrypted file cannot be imported")
  }
  return {
    id: row.id,
    storageKey: row.storage_key,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
  }
}

/** Parse one NDJSON line into a source item (envelope or bare record). */
export function parseSourceLine(raw: string, line: number): SourceItem | null {
  const text = raw.trim()
  if (text.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      line,
      error: `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    "kind" in parsed &&
    "record" in parsed &&
    Object.keys(parsed).length === 2 &&
    typeof parsed.kind === "string"
  ) {
    return { line, kind: parsed.kind, record: parsed.record }
  }
  return { line, record: parsed }
}

function lineTooLong(lineNo: number): ImportError {
  return new ImportError(
    "invalid_source",
    `line ${lineNo} is more than ${PARSER_RECORD_MAX_BYTES} bytes; a record may be at most ${PARSER_RECORD_MAX_BYTES} bytes (1 MB)`,
  )
}

/** Lines of a byte stream; a line (newline or not yet) past the record cap is refused. */
async function* linesOfWebStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  let lineNo = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    let nl = buffered.indexOf("\n")
    while (nl !== -1) {
      lineNo++
      const line = buffered.slice(0, nl).replace(/\r$/, "")
      if (Buffer.byteLength(line) > PARSER_RECORD_MAX_BYTES) throw lineTooLong(lineNo)
      yield line
      buffered = buffered.slice(nl + 1)
      nl = buffered.indexOf("\n")
    }
    // No newline yet: never buffer more than one record's worth.
    if (buffered.length > PARSER_RECORD_MAX_BYTES) throw lineTooLong(lineNo + 1)
  }
  buffered += decoder.decode()
  if (buffered.length > 0) {
    if (Buffer.byteLength(buffered) > PARSER_RECORD_MAX_BYTES) throw lineTooLong(lineNo + 1)
    yield buffered
  }
}

async function* linesOfPath(path: string): AsyncGenerator<string> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  let lineNo = 0
  for await (const raw of rl) {
    lineNo++
    if (Buffer.byteLength(raw) > PARSER_RECORD_MAX_BYTES) throw lineTooLong(lineNo)
    yield raw
  }
}

function tooLargeForFormat(): ImportError {
  return new ImportError(
    "invalid_source",
    `the file is larger than ${WHOLE_FILE_FORMAT_MAX_BYTES / 1024 / 1024} MB, the most this format reads`,
  )
}

/**
 * Stream a source's items. `file` sources must have been resolved first
 * (`resolveImportFile`); the storage key comes from that resolution, never
 * from the request.
 */
export async function* readSource(
  source: ImportSource,
  resolvedFile: ResolvedImportFile | null,
): AsyncGenerator<SourceItem> {
  if (source.type === "records") {
    for await (const item of source.records) yield item
    return
  }
  if (source.type === "transform") {
    // The runner stages a transform source first and reads its spool.
    throw new ImportError("invalid_source", "A transform source is read through its staged spool")
  }
  if (source.format === "ics") {
    let bytes: Buffer
    if (source.type === "path") {
      const size = (await stat(source.path)).size
      if (size > WHOLE_FILE_FORMAT_MAX_BYTES) throw tooLargeForFormat()
      bytes = await readFile(source.path)
    } else {
      if (!resolvedFile) throw new ImportError("invalid_source", "File source was not resolved")
      if (resolvedFile.sizeBytes > WHOLE_FILE_FORMAT_MAX_BYTES) throw tooLargeForFormat()
      bytes = await getObjectBuffer(resolvedFile.storageKey)
    }
    const { events, errors } = parseIcs(bytes.toString("utf8"))
    let line = 0
    for (const error of errors) yield { line: 0, error }
    for (const record of events) yield { line: ++line, record }
    return
  }
  let lines: AsyncGenerator<string>
  if (source.type === "path") {
    lines = linesOfPath(source.path)
  } else {
    if (!resolvedFile) throw new ImportError("invalid_source", "File source was not resolved")
    lines = linesOfWebStream((await getObjectStream(resolvedFile.storageKey)).stream)
  }
  let lineNo = 0
  for await (const raw of lines) {
    lineNo++
    const item = parseSourceLine(raw, lineNo)
    if (item) yield item
  }
}
