// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Streaming CSV (csv-parse): a header row names the columns, every later row
 * is one record keyed by those names. A UTF-8 BOM is dropped; the delimiter is
 * detected from the header line (comma, semicolon, tab or pipe, outside
 * quotes) unless given. Quoted fields may hold delimiters, quotes ("") and
 * newlines. Duplicate or empty header names get a suffix so no column is
 * lost.
 */
import { once } from "node:events"
import { type CsvError, parse } from "csv-parse"
import {
  type ByteSource,
  PARSER_RECORD_MAX_BYTES,
  type ParsedRecord,
  ParserError,
  recordTooLarge,
  textChunks,
} from "./common"

export interface CsvOptions {
  /** Field delimiter; detected from the header line when absent. */
  delimiter?: string
  /** Name used in messages (the file name). */
  name?: string
}

const CANDIDATES = [",", ";", "\t", "|"] as const

/** The delimiter that occurs most in the first line, outside quotes (comma on a tie or none). */
export function detectDelimiter(firstLine: string): string {
  const counts = new Map<string, number>(CANDIDATES.map((c) => [c, 0]))
  let quoted = false
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && counts.has(ch)) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  let best = ","
  let bestCount = 0
  for (const c of CANDIDATES) {
    const n = counts.get(c) ?? 0
    if (n > bestCount) {
      best = c
      bestCount = n
    }
  }
  return best
}

function headerNames(row: string[]): string[] {
  const seen = new Map<string, number>()
  return row.map((raw, i) => {
    const base = raw.trim() === "" ? `column_${i + 1}` : raw.trim()
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return n === 1 ? base : `${base}_${n}`
  })
}

/** Text chunks, holding back the start until the first line is known (for detection). */
async function* withFirstLine(
  source: ByteSource,
  onFirstLine: (line: string) => void,
): AsyncGenerator<string> {
  let head = ""
  let done = false
  for await (const text of textChunks(source)) {
    if (done) {
      yield text
      continue
    }
    head += text
    const nl = head.search(/\r?\n/)
    if (nl >= 0 || head.length > PARSER_RECORD_MAX_BYTES) {
      onFirstLine(nl >= 0 ? head.slice(0, nl) : head)
      done = true
      yield head
      head = ""
    }
  }
  if (!done) {
    onFirstLine(head)
    if (head) yield head
  }
}

/** At most this many columns in a row (Excel's own limit is 16,384). */
export const CSV_MAX_COLUMNS = 16_384

/**
 * Refuse a pathological row before the CSV parser buffers it: a line longer
 * than a whole record may be (1 MB since the last newline), or a row with more
 * than CSV_MAX_COLUMNS delimiters outside quotes. Text passes through
 * unchanged, in slices, so the parser never holds more than one row past
 * these bounds.
 */
async function* guardRows(
  chunks: AsyncIterable<string>,
  delimiter: () => string,
  name: string,
): AsyncGenerator<string> {
  let sinceNewline = 0
  let columns = 1
  let quoted = false
  let row = 1
  for await (const text of chunks) {
    const d = delimiter()
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i)
      if (ch === 10) {
        sinceNewline = 0
        if (!quoted) {
          columns = 1
          row++
        }
        continue
      }
      sinceNewline++
      if (ch === 34) quoted = !quoted
      else if (!quoted && text[i] === d && ++columns > CSV_MAX_COLUMNS) {
        throw new ParserError(
          "invalid_csv",
          `Row ${row - 1} of ${name} has more than ${CSV_MAX_COLUMNS} columns; refused.`,
        )
      }
      if (sinceNewline > PARSER_RECORD_MAX_BYTES) {
        throw recordTooLarge(`Row ${row - 1} of ${name}`, PARSER_RECORD_MAX_BYTES, true)
      }
    }
    yield text
  }
}

/** Rows of a CSV as records keyed by the header names. */
export async function* parseCsv(
  source: ByteSource,
  opts: CsvOptions = {},
): AsyncGenerator<ParsedRecord> {
  const name = opts.name ?? "the CSV file"
  let delimiter = opts.delimiter
  const text = withFirstLine(source, (line) => {
    if (!delimiter) delimiter = detectDelimiter(line)
  })
  // Pull the first chunk so the delimiter is known before the parser exists.
  const first = await text.next()
  if (first.done) return
  async function* rest(): AsyncGenerator<string> {
    const slice = 64 * 1024
    const head = first.value as string
    for (let i = 0; i < head.length; i += slice) yield head.slice(i, i + slice)
    for await (const t of text) {
      for (let i = 0; i < t.length; i += slice) yield t.slice(i, i + slice)
    }
  }
  const parser = parse({
    delimiter: delimiter ?? ",",
    bom: true,
    info: true,
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: PARSER_RECORD_MAX_BYTES,
  })
  // Feed the parser by hand (not `pipe`, which drops source errors), so a
  // guard refusal reaches the loop below as the parser's error.
  const guarded = guardRows(rest(), () => delimiter ?? ",", name)
  void (async () => {
    try {
      for await (const t of guarded) {
        if (parser.destroyed) return
        if (!parser.write(t)) {
          // Whichever event loses the race must drop its listeners, or every
          // wait leaves one behind on the parser (thousands over a large file).
          const waiting = new AbortController()
          try {
            await Promise.race([
              once(parser, "drain", { signal: waiting.signal }),
              once(parser, "close", { signal: waiting.signal }),
            ])
          } finally {
            waiting.abort()
          }
        }
      }
      parser.end()
    } catch (err) {
      parser.destroy(err instanceof Error ? err : new Error(String(err)))
    }
  })()
  let columns: string[] | null = null
  let number = 0
  try {
    for await (const item of parser as AsyncIterable<{
      record: string[]
      info: { lines: number }
    }>) {
      const row = item.record
      if (!columns) {
        columns = headerNames(row)
        continue
      }
      number++
      const value: Record<string, string> = {}
      for (let i = 0; i < row.length; i++) {
        const key = i < columns.length ? (columns[i] as string) : `column_${i + 1}`
        value[key] = row[i] as string
      }
      const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
      if (bytes > PARSER_RECORD_MAX_BYTES) {
        throw recordTooLarge(`Row ${number} of ${name} (line ${item.info.lines})`, bytes)
      }
      yield { number, value }
    }
  } catch (err) {
    if (err instanceof ParserError) throw err
    const e = err as CsvError
    if (e?.code === "CSV_MAX_RECORD_SIZE") {
      // The parser reads ahead of what was yielded: its own count (header
      // included) names the row it was in.
      const parsed = (e as { records?: unknown }).records
      const row = typeof parsed === "number" ? parsed : number + 1
      throw recordTooLarge(`Row ${row} of ${name}`, PARSER_RECORD_MAX_BYTES, true)
    }
    const lineNo = (err as { lines?: unknown } | null)?.lines
    const lines = typeof lineNo === "number" ? ` (line ${lineNo})` : ""
    throw new ParserError(
      "invalid_csv",
      `${name} is not valid CSV${lines}: ${e?.message ?? String(err)}`,
    )
  } finally {
    parser.destroy()
  }
}
