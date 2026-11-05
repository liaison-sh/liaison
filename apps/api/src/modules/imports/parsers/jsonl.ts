// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Streaming JSON Lines: one JSON value per line, blank lines skipped. A line
 * is never buffered past 1 MB: a longer one fails with its line number.
 */
import {
  type ByteSource,
  PARSER_RECORD_MAX_BYTES,
  type ParsedRecord,
  ParserError,
  recordTooLarge,
} from "./common"

const NL = 0x0a

function lineValue(bytes: Uint8Array, line: number, name: string): unknown {
  let text = new TextDecoder("utf-8", { ignoreBOM: line !== 1 }).decode(bytes)
  if (text.endsWith("\r")) text = text.slice(0, -1)
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new ParserError(
      "invalid_json",
      `Line ${line} of ${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

export async function* parseJsonl(
  source: ByteSource,
  opts: { name?: string } = {},
): AsyncGenerator<ParsedRecord> {
  const name = opts.name ?? "the JSONL file"
  let parts: Uint8Array[] = []
  let partBytes = 0
  let line = 0
  let number = 0
  for await (const chunk of source) {
    let start = 0
    for (;;) {
      const at = chunk.indexOf(NL, start)
      const end = at < 0 ? chunk.byteLength : at
      const piece = chunk.subarray(start, end)
      partBytes += piece.byteLength
      if (partBytes > PARSER_RECORD_MAX_BYTES + 1) {
        throw recordTooLarge(`Line ${line + 1} of ${name}`, PARSER_RECORD_MAX_BYTES, true)
      }
      if (piece.byteLength > 0) parts.push(piece)
      if (at < 0) break
      line++
      const whole = parts.length === 1 ? (parts[0] as Uint8Array) : Buffer.concat(parts)
      parts = []
      partBytes = 0
      const value = lineValue(whole, line, name)
      if (value !== undefined) yield { number: ++number, value }
      start = at + 1
    }
  }
  if (parts.length > 0) {
    line++
    const value = lineValue(Buffer.concat(parts), line, name)
    if (value !== undefined) yield { number: ++number, value }
  }
}
