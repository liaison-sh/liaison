// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Cut a parser's record stream into transform batches. A batch holds whole
 * records only: at most 200 of them and at most 1 MB serialized, so a call's
 * params (inlined into the sandbox as code text) stay far below the 32 MiB
 * heap. A single record over 1 MB fails the run with its number and size
 * rather than being split or dropped.
 */
import { TRANSFORM_RECORD_MAX_BYTES } from "./bridge"

export const TRANSFORM_BATCH_MAX_RECORDS = 200
export const TRANSFORM_BATCH_MAX_BYTES = 1024 * 1024

/** One parsed record, as every parser yields it. */
export interface ParsedRecord {
  /** 1-based position in its file (a CSV row after the header, a JSONL line, an element). */
  number: number
  value: unknown
  /** Where in the file the record sits (a JSON top-level key, an XLSX sheet), when the format has one. */
  path?: string
}

export interface TransformBatch {
  file: string
  path?: string
  /** Number of the first record of the batch (1-based). */
  firstRecord: number
  records: unknown[]
  bytes: number
}

export class RecordTooLargeError extends Error {
  readonly code = "record_too_large"
  constructor(
    readonly file: string,
    readonly recordNumber: number,
    readonly bytes: number,
  ) {
    super(
      `Record ${recordNumber} of ${file} is ${bytes} bytes serialized; a record may be at most ${TRANSFORM_RECORD_MAX_BYTES} bytes (1 MB).`,
    )
    this.name = "RecordTooLargeError"
  }
}

export interface BatchLimits {
  maxRecords?: number
  maxBytes?: number
}

/**
 * Batches of one file's records. A change of `path` (a new JSON key or sheet)
 * starts a new batch, so every batch has one path.
 */
export async function* batchRecords(
  file: string,
  records: AsyncIterable<ParsedRecord>,
  limits: BatchLimits = {},
): AsyncGenerator<TransformBatch> {
  const maxRecords = limits.maxRecords ?? TRANSFORM_BATCH_MAX_RECORDS
  const maxBytes = limits.maxBytes ?? TRANSFORM_BATCH_MAX_BYTES
  let current: TransformBatch | null = null
  for await (const rec of records) {
    const bytes = Buffer.byteLength(JSON.stringify(rec.value ?? null), "utf8")
    if (bytes > TRANSFORM_RECORD_MAX_BYTES) throw new RecordTooLargeError(file, rec.number, bytes)
    if (
      current &&
      (current.path !== rec.path ||
        current.records.length >= maxRecords ||
        current.bytes + bytes > maxBytes)
    ) {
      yield current
      current = null
    }
    if (!current) {
      current = { file, firstRecord: rec.number, records: [], bytes: 0 }
      if (rec.path !== undefined) current.path = rec.path
    }
    current.records.push(rec.value)
    current.bytes += bytes
  }
  if (current && current.records.length > 0) yield current
}
