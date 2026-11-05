// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The text of an Office Open XML document (Word, Excel, PowerPoint), read in memory.
//
// An attachment's text is what the agent needs from a .docx, .xlsx or .pptx; no model call is
// needed to get it. Everything happens on the bytes in hand: nothing is written to disk or to the
// object store, because the bytes can be the readable copy of an end-to-end encrypted attachment
// (mail-attachment-read.ts). The archive is read with the import parser's zip reader, the XML with
// saxes, with no document type allowed.
//
// BOUNDED WORK. A few kilobytes of deflate can claim gigabytes of XML. Each part is inflated and
// parsed as a stream, chunk by chunk, and reading stops (the inflater with it) once the part has
// produced `OFFICE_PART_MAX_INFLATED_BYTES`, the document `OFFICE_TOTAL_MAX_INFLATED_BYTES`, or the
// text collected reaches `OFFICE_TEXT_MAX_CHARS`: the text read so far is returned with a note that
// it was cut. The zip reader's own caps (a ratio check per entry, a total budget) stay as the
// backstop, tightened to the document's limits.

import { SaxesParser } from "saxes"
import {
  bufferRangeSource,
  DEFAULT_ZIP_CAPS,
  readZipDirectory,
  readZipEntry,
  ZipBudget,
  type ZipCaps,
  type ZipEntry,
} from "~/modules/imports/parsers/zip"

/** The mime types (as file-type sniffs them) read as text here. */
export const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
} as const

export type OfficeFormat = keyof typeof OFFICE_MIME

/** The most text one document hands the agent. Past it the text says it was cut. */
export const OFFICE_TEXT_MAX_CHARS = 60_000

/** The most XML one part (a body, a slide, a sheet, the shared strings) is inflated to. */
export const OFFICE_PART_MAX_INFLATED_BYTES = 4 * 1024 * 1024

/** The most XML one document is inflated to, across its parts. */
export const OFFICE_TOTAL_MAX_INFLATED_BYTES = 16 * 1024 * 1024

/** The zip reader's backstop, at the document's limits: a part may overshoot its cap by one
 *  inflater push (about 4 MiB), never more. */
const OFFICE_ZIP_CAPS: ZipCaps = {
  ...DEFAULT_ZIP_CAPS,
  // No ratio refusal: a part stops inflating at OFFICE_PART_MAX_INFLATED_BYTES whatever its ratio
  // and the text up to there is returned with a [Cut:] note, so a spreadsheet of mostly empty rows
  // still reads. The absolute caps below are what bound the work.
  maxEntryRatio: Number.POSITIVE_INFINITY,
  maxEntries: 20_000,
  totalFloorBytes: OFFICE_TOTAL_MAX_INFLATED_BYTES + 8 * 1024 * 1024,
  maxTotalBytes: OFFICE_TOTAL_MAX_INFLATED_BYTES + 8 * 1024 * 1024,
}

/** What reading one document cost: test and log evidence that the work stayed bounded. */
export interface OfficeTextStats {
  inflatedBytes: number
  truncated: boolean
}

export function officeFormatOf(mime: string): OfficeFormat | null {
  for (const [format, value] of Object.entries(OFFICE_MIME)) {
    if (value === mime) return format as OfficeFormat
  }
  return null
}

export class OfficeTextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OfficeTextError"
  }
}

const SAXES_OPTIONS = { xmlns: false } as const

/** One document's reading: the zip, its budget, and what the reading has cost so far. */
interface Reading {
  bytes: Uint8Array
  budget: ZipBudget
  stats: OfficeTextStats
}

type XmlHandlers = {
  open?: (tag: string, attributes: Record<string, string>) => void
  close?: (tag: string) => void
  text?: (text: string) => void
}

/**
 * Inflate and parse one XML part as a stream. Stops early, without finishing the parse, when the
 * part or the document has inflated its cap or `enough()` says the text collected is enough; the
 * handlers keep what they saw up to there.
 */
async function walkPart(
  reading: Reading,
  entry: ZipEntry,
  handlers: XmlHandlers,
  enough: () => boolean,
): Promise<void> {
  const name = entry.name
  const parser = new SaxesParser(SAXES_OPTIONS)
  let failure: Error | null = null
  parser.on("error", (err) => {
    failure ??= new OfficeTextError(`${name} is not valid XML (${err.message}).`)
    throw failure
  })
  parser.on("doctype", () => {
    failure = new OfficeTextError(`${name} declares a document type; refused.`)
    throw failure
  })
  parser.on("opentag", (tag) => {
    const attributes: Record<string, string> = {}
    for (const [key, value] of Object.entries(tag.attributes)) {
      attributes[key] = typeof value === "string" ? value : String(value)
    }
    handlers.open?.(tag.name, attributes)
  })
  parser.on("closetag", (tag) => handlers.close?.(tag.name))
  parser.on("text", (t) => handlers.text?.(t))
  parser.on("cdata", (t) => handlers.text?.(t))

  const decoder = new TextDecoder("utf-8")
  let partBytes = 0
  let stopped = false
  try {
    for await (const chunk of readZipEntry(
      bufferRangeSource(reading.bytes),
      entry,
      reading.budget,
      OFFICE_ZIP_CAPS,
    )) {
      partBytes += chunk.byteLength
      reading.stats.inflatedBytes += chunk.byteLength
      parser.write(decoder.decode(chunk, { stream: true }))
      if (
        partBytes >= OFFICE_PART_MAX_INFLATED_BYTES ||
        reading.stats.inflatedBytes >= OFFICE_TOTAL_MAX_INFLATED_BYTES ||
        enough()
      ) {
        // Leaving the loop closes the generator: nothing more is inflated.
        stopped = true
        break
      }
    }
    if (stopped) reading.stats.truncated = true
    else parser.write(decoder.decode()).close()
  } catch (err) {
    if (failure) throw failure
    if (err instanceof OfficeTextError) throw err
    throw new OfficeTextError(
      `Could not read ${name} (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
}

/** True once the document's budget is spent: no further part is read. */
function exhausted(reading: Reading): boolean {
  return reading.stats.inflatedBytes >= OFFICE_TOTAL_MAX_INFLATED_BYTES
}

/** Paragraph text of a Word body or a slide: `textTag` runs, one line per `paragraphTag`. */
async function paragraphs(
  reading: Reading,
  entry: ZipEntry,
  textTag: string,
  paragraphTag: string,
  budgetChars: number,
): Promise<string> {
  const lines: string[] = []
  let line = ""
  let inText = false
  let chars = 0
  await walkPart(
    reading,
    entry,
    {
      open: (tag) => {
        if (tag === textTag) inText = true
        else if (tag === "w:tab") line += "\t"
        else if (tag === "w:br" || tag === "a:br") line += "\n"
      },
      close: (tag) => {
        if (tag === textTag) inText = false
        else if (tag === paragraphTag) {
          lines.push(line)
          chars += line.length + 1
          line = ""
        }
      },
      text: (t) => {
        if (inText) line += t
      },
    },
    () => chars + line.length > budgetChars,
  )
  if (line) lines.push(line)
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** One sheet as tab-separated rows, shared strings resolved. */
async function sheetRows(
  reading: Reading,
  entry: ZipEntry,
  shared: string[],
  budgetChars: number,
): Promise<string> {
  const rows: string[] = []
  let chars = 0
  let cells: string[] = []
  let cellType = ""
  let value = ""
  let inValue = false
  await walkPart(
    reading,
    entry,
    {
      open: (tag, attributes) => {
        if (tag === "row") cells = []
        else if (tag === "c") {
          cellType = attributes.t ?? ""
          value = ""
        } else if (tag === "v" || tag === "t") inValue = true
      },
      close: (tag) => {
        if (tag === "v" || tag === "t") inValue = false
        else if (tag === "c") {
          cells.push(cellType === "s" ? (shared[Number(value)] ?? "") : value)
        } else if (tag === "row") {
          if (cells.some((c) => c !== "")) {
            const row = cells.join("\t")
            rows.push(row)
            chars += row.length + 1
          }
        }
      },
      text: (t) => {
        if (inValue) value += t
      },
    },
    () => chars > budgetChars,
  )
  return rows.join("\n")
}

async function sharedStrings(reading: Reading, entry: ZipEntry): Promise<string[]> {
  const out: string[] = []
  let current = ""
  let inItem = false
  let inText = false
  await walkPart(
    reading,
    entry,
    {
      open: (tag) => {
        if (tag === "si") {
          inItem = true
          current = ""
        } else if (tag === "t" && inItem) inText = true
      },
      close: (tag) => {
        if (tag === "t") inText = false
        else if (tag === "si") {
          out.push(current)
          inItem = false
        }
      },
      text: (t) => {
        if (inText) current += t
      },
    },
    // The whole table is needed to resolve cells; the part and document caps bound it.
    () => false,
  )
  return out
}

/** `ppt/slides/slide12.xml` sorts after `slide2.xml`. */
function numbered(prefix: string, entries: ZipEntry[]): ZipEntry[] {
  const pattern = new RegExp(`^${prefix}(\\d+)\\.xml$`)
  return entries
    .filter((e) => pattern.test(e.name))
    .sort((a, b) => Number(pattern.exec(a.name)?.[1]) - Number(pattern.exec(b.name)?.[1]))
}

function capped(text: string, truncated: boolean): string {
  if (text.length > OFFICE_TEXT_MAX_CHARS) {
    return `${text.slice(0, OFFICE_TEXT_MAX_CHARS)}\n\n[Cut: the document is longer than ${OFFICE_TEXT_MAX_CHARS} characters; the rest is not included.]`
  }
  if (truncated) {
    return `${text}\n\n[Cut: the document is too large to read whole; the rest is not included.]`
  }
  return text
}

/**
 * The plain text of a .docx, .xlsx or .pptx held in memory. Throws `OfficeTextError` with a
 * plain message when the archive is not that kind of document, or is malformed. A document past
 * the inflate caps is read up to them and its text says it was cut. `stats`, when given, is
 * filled with what the reading cost.
 */
export async function officeDocumentText(
  bytes: Uint8Array,
  format: OfficeFormat,
  stats: OfficeTextStats = { inflatedBytes: 0, truncated: false },
): Promise<string> {
  let entries: ZipEntry[]
  try {
    entries = await readZipDirectory(bufferRangeSource(bytes), OFFICE_ZIP_CAPS)
  } catch (err) {
    throw new OfficeTextError(
      `The file is not a readable ${format} document (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  const reading: Reading = {
    bytes,
    budget: new ZipBudget(bytes.byteLength, OFFICE_ZIP_CAPS),
    stats,
  }
  const byName = new Map(entries.map((e) => [e.name, e]))
  // A little past the cap, so `capped` can tell a cut text from one that just fits.
  const charBudget = OFFICE_TEXT_MAX_CHARS + 1

  if (format === "docx") {
    const body = byName.get("word/document.xml")
    if (!body) throw new OfficeTextError("The file is not a Word document (no word/document.xml).")
    return capped(await paragraphs(reading, body, "w:t", "w:p", charBudget), stats.truncated)
  }

  if (format === "pptx") {
    const slides = numbered("ppt/slides/slide", entries)
    if (slides.length === 0) {
      throw new OfficeTextError("The file is not a PowerPoint deck (no slides).")
    }
    const parts: string[] = []
    let length = 0
    for (const [index, slide] of slides.entries()) {
      if (exhausted(reading) || length > OFFICE_TEXT_MAX_CHARS) {
        stats.truncated = true
        break
      }
      const text = await paragraphs(reading, slide, "a:t", "a:p", charBudget - length)
      parts.push(`Slide ${index + 1}:\n${text}`)
      length += text.length
    }
    return capped(parts.join("\n\n"), stats.truncated)
  }

  const sharedEntry = byName.get("xl/sharedStrings.xml")
  const shared = sharedEntry ? await sharedStrings(reading, sharedEntry) : []
  const sheets = numbered("xl/worksheets/sheet", entries)
  if (sheets.length === 0)
    throw new OfficeTextError("The file is not an Excel workbook (no sheets).")
  const parts: string[] = []
  let length = 0
  for (const [index, sheet] of sheets.entries()) {
    if (exhausted(reading) || length > OFFICE_TEXT_MAX_CHARS) {
      stats.truncated = true
      break
    }
    const text = await sheetRows(reading, sheet, shared, charBudget - length)
    parts.push(`Sheet ${index + 1}:\n${text}`)
    length += text.length
  }
  return capped(parts.join("\n\n"), stats.truncated)
}
