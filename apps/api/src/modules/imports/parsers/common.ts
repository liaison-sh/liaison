// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What every import parser shares: the error type, the record cap and the
 * byte-stream input. Parsers read a stream and yield records one at a time
 * (`ParsedRecord`), so a file of any size flows through with only the current
 * record in memory; the batcher then groups records for the transform.
 */
import { TRANSFORM_RECORD_MAX_BYTES } from "../transforms/bridge"

export type { ParsedRecord } from "../transforms/batch"

/** A parser's input: a web ReadableStream or any async iterable of bytes. */
export type ByteSource = AsyncIterable<Uint8Array>

/** A record (a CSV row, a JSONL line, an XML element) may be at most 1 MB. */
export const PARSER_RECORD_MAX_BYTES = TRANSFORM_RECORD_MAX_BYTES

export type ParserErrorCode =
  | "record_too_large"
  | "invalid_csv"
  | "invalid_json"
  | "json_too_large"
  | "invalid_xml"
  | "xml_dtd_refused"
  | "invalid_xlsx"
  | "xlsx_shared_strings_too_large"
  | "invalid_zip"
  | "zip_encrypted"
  | "zip_unsupported_method"
  | "zip_too_many_entries"
  | "zip_ratio_exceeded"
  | "zip_decompressed_too_large"

export class ParserError extends Error {
  constructor(
    readonly code: ParserErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ParserError"
  }
}

/** The error for one record over the cap; `bytes` is its size as far as it was read. */
export function recordTooLarge(what: string, bytes: number, atLeast = false): ParserError {
  return new ParserError(
    "record_too_large",
    `${what} is ${atLeast ? "more than " : ""}${bytes} bytes; a record may be at most ${PARSER_RECORD_MAX_BYTES} bytes (1 MB).`,
  )
}

/** Decode a byte source to text chunks (UTF-8, a leading BOM dropped). */
export async function* textChunks(source: ByteSource): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: false })
  for await (const chunk of source) {
    const text = decoder.decode(chunk, { stream: true })
    if (text) yield text
  }
  const tail = decoder.decode()
  if (tail) yield tail
}

/** A byte source over a string or bytes (tests, small inputs). */
export async function* bytesOf(input: string | Uint8Array, chunkSize = 64 * 1024): ByteSource {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    yield bytes.subarray(i, Math.min(bytes.byteLength, i + chunkSize))
  }
}
