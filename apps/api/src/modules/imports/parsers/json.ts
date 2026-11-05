// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Whole-file JSON, up to 48 MB (a larger export must come as JSON Lines).
 *
 * A top-level array yields its elements. A top-level object (a board or
 * workspace export) yields the elements of each array member under that
 * member's name as `path` (`cards`, `lists`, ...), and its other members
 * together as one record under the path `$`. A scalar is one record.
 */
import { type ByteSource, type ParsedRecord, ParserError } from "./common"

export const JSON_WHOLE_FILE_MAX_BYTES = 48 * 1024 * 1024

export async function* parseJson(
  source: ByteSource,
  opts: { name?: string } = {},
): AsyncGenerator<ParsedRecord> {
  const name = opts.name ?? "the JSON file"
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of source) {
    total += chunk.byteLength
    if (total > JSON_WHOLE_FILE_MAX_BYTES) {
      throw new ParserError(
        "json_too_large",
        `${name} is more than ${JSON_WHOLE_FILE_MAX_BYTES / 1024 / 1024} MB; a JSON file is read whole, so larger exports must be JSON Lines (one record per line, .jsonl).`,
      )
    }
    chunks.push(chunk)
  }
  const text = new TextDecoder("utf-8").decode(Buffer.concat(chunks))
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new ParserError(
      "invalid_json",
      `${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (Array.isArray(doc)) {
    for (let i = 0; i < doc.length; i++) yield { number: i + 1, value: doc[i] }
    return
  }
  if (doc === null || typeof doc !== "object") {
    yield { number: 1, value: doc, path: "$" }
    return
  }
  const rest: Record<string, unknown> = {}
  let hasRest = false
  let number = 0
  for (const [key, value] of Object.entries(doc)) {
    if (!Array.isArray(value)) {
      rest[key] = value
      hasRest = true
    }
  }
  if (hasRest) yield { number: ++number, value: rest, path: "$" }
  for (const [key, value] of Object.entries(doc)) {
    if (!Array.isArray(value)) continue
    for (const element of value) yield { number: ++number, value: element, path: key }
  }
}
