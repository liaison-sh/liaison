// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * XLSX without a spreadsheet library: the workbook is a zip, read by ranges
 * (`zip.ts`), and its parts are XML, read with saxes as they inflate. Each
 * sheet's first non-empty row is the header; every later row is a record keyed
 * by it (like CSV), with `path` set to the sheet name. Cells keep their type:
 * shared and inline strings, numbers (dates stay serial numbers), booleans,
 * formula results as stored.
 *
 * Shared strings are held in memory up to 16 MiB; past that they move to a
 * temporary file with an offset index, and past 256 MiB the workbook is
 * refused. A DOCTYPE in any part is refused, as for XML imports.
 */
import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SaxesParser, type SaxesTagPlain } from "saxes"
import { PARSER_RECORD_MAX_BYTES, type ParsedRecord, ParserError, recordTooLarge } from "./common"
import {
  DEFAULT_ZIP_CAPS,
  type RangeSource,
  readZipDirectory,
  readZipEntry,
  ZipBudget,
  type ZipCaps,
  type ZipEntry,
} from "./zip"

export const XLSX_SHARED_STRINGS_MEMORY_BYTES = 16 * 1024 * 1024
export const XLSX_SHARED_STRINGS_MAX_BYTES = 256 * 1024 * 1024

export interface XlsxOptions {
  name?: string
  caps?: ZipCaps
  sharedStringsMemoryBytes?: number
  sharedStringsMaxBytes?: number
}

type SaxHandlers = {
  open?: (tag: SaxesTagPlain) => void
  close?: (name: string) => void
  text?: (text: string) => void
}

/**
 * Stream one XML part of the workbook through saxes handlers, yielding after
 * every inflated chunk so a consumer can hand out what the handlers produced
 * before more is read (back-pressure).
 */
/** Text is handed to saxes in slices this size, so the pending count is checked often. */
const WRITE_SLICE = 64 * 1024

async function* xmlPart(
  src: RangeSource,
  entry: ZipEntry,
  budget: ZipBudget,
  caps: ZipCaps,
  handlers: SaxHandlers,
): AsyncGenerator<void> {
  const parser = new SaxesParser()
  let failure: Error | null = null
  parser.on("error", (err) => {
    failure =
      failure ?? new ParserError("invalid_xlsx", `${entry.name} is not valid XML: ${err.message}`)
    throw failure
  })
  parser.on("doctype", () => {
    failure = new ParserError("xml_dtd_refused", `${entry.name} declares a document type; refused.`)
    throw failure
  })
  parser.on("opentag", (tag) => {
    pending = 0
    handlers.open?.(tag)
  })
  parser.on("closetag", (t) => {
    pending = 0
    handlers.close?.(t.name)
  })
  const onText = (t: string) => {
    pending = 0
    handlers.text?.(t)
  }
  parser.on("text", onText)
  parser.on("cdata", onText)
  // saxes buffers text and attribute values until the event that ends them:
  // count what was written since the last event and refuse past a record's
  // worth. saxes keeps one handler per event, so the handled events reset the
  // count in their wrappers and the others get `seen`.
  let pending = 0
  const seen = () => {
    pending = 0
  }
  for (const ev of [
    "opentagstart",
    "attribute",
    "comment",
    "processinginstruction",
    "xmldecl",
  ] as const) {
    parser.on(ev, seen)
  }
  const write = (text: string) => {
    for (let i = 0; i < text.length; i += WRITE_SLICE) {
      const piece = text.slice(i, i + WRITE_SLICE)
      pending += piece.length
      parser.write(piece)
      if (pending > PARSER_RECORD_MAX_BYTES + WRITE_SLICE) {
        failure = recordTooLarge(
          `A text or attribute run in ${entry.name}`,
          PARSER_RECORD_MAX_BYTES,
          true,
        )
        throw failure
      }
    }
  }
  const decoder = new TextDecoder("utf-8")
  try {
    for await (const chunk of readZipEntry(src, entry, budget, caps)) {
      write(decoder.decode(chunk, { stream: true }))
      yield
    }
    write(decoder.decode())
    parser.close()
    yield
  } catch (err) {
    if (failure) throw failure
    throw err
  }
}

async function readPart(
  src: RangeSource,
  entry: ZipEntry,
  budget: ZipBudget,
  caps: ZipCaps,
  handlers: SaxHandlers,
): Promise<void> {
  for await (const _ of xmlPart(src, entry, budget, caps, handlers)) {
    // handlers do the work
  }
}

/** Shared strings, in memory until they pass the memory threshold, then on disk. */
class SharedStrings {
  private memory: string[] = []
  private memoryBytes = 0
  private totalBytes = 0
  private dir: string | null = null
  private fd: number | null = null
  private offsets: number[] = []
  private fileBytes = 0
  constructor(
    private readonly memoryLimit: number,
    private readonly maxBytes: number,
    private readonly name: string,
  ) {}

  add(value: string): void {
    const bytes = Buffer.byteLength(value, "utf8")
    this.totalBytes += bytes
    if (this.totalBytes > this.maxBytes) {
      throw new ParserError(
        "xlsx_shared_strings_too_large",
        `${this.name} holds more than ${this.maxBytes} bytes of shared strings; split the workbook or export it as CSV.`,
      )
    }
    if (this.fd === null && this.memoryBytes + bytes <= this.memoryLimit) {
      this.memory.push(value)
      this.memoryBytes += bytes
      return
    }
    if (this.fd === null) {
      this.dir = mkdtempSync(join(tmpdir(), "liaison-xlsx-strings-"))
      this.fd = openSync(join(this.dir, "strings.bin"), "w+")
    }
    const buf = Buffer.from(value, "utf8")
    writeSync(this.fd, buf, 0, buf.byteLength, this.fileBytes)
    this.offsets.push(this.fileBytes, buf.byteLength)
    this.fileBytes += buf.byteLength
  }

  get(index: number): string | undefined {
    if (index < this.memory.length) return this.memory[index]
    const i = (index - this.memory.length) * 2
    if (this.fd === null || i + 1 >= this.offsets.length) return undefined
    const offset = this.offsets[i] as number
    const length = this.offsets[i + 1] as number
    const buf = Buffer.alloc(length)
    readSync(this.fd, buf, 0, length, offset)
    return buf.toString("utf8")
  }

  get onDisk(): boolean {
    return this.fd !== null
  }

  dispose(): void {
    if (this.fd !== null) closeSync(this.fd)
    if (this.dir) rmSync(this.dir, { recursive: true, force: true })
    this.fd = null
    this.dir = null
  }
}

/** The last column a sheet can have: XFD, index 16383. */
export const XLSX_MAX_COLUMN = 16_383

/** A cell reference's 0-based column, `fallback` without one, or -1 past XFD. */
function columnIndex(ref: string | undefined, fallback: number): number {
  if (!ref) return fallback
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64)
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96)
    else break
    if (n - 1 > XLSX_MAX_COLUMN) return -1
  }
  return n > 0 ? n - 1 : fallback
}

function partPath(target: string): string {
  const t = target.startsWith("/") ? target.slice(1) : `xl/${target}`
  const parts: string[] = []
  for (const seg of t.split("/")) {
    if (seg === "..") parts.pop()
    else if (seg !== "." && seg !== "") parts.push(seg)
  }
  return parts.join("/")
}

/** The sheets of a workbook as records, sheet by sheet. */
export async function* parseXlsx(
  src: RangeSource,
  opts: XlsxOptions = {},
): AsyncGenerator<ParsedRecord> {
  const name = opts.name ?? "the workbook"
  const caps = opts.caps ?? DEFAULT_ZIP_CAPS
  const budget = new ZipBudget(src.size, caps)
  const entries = await readZipDirectory(src, caps)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const workbook = byName.get("xl/workbook.xml")
  if (!workbook)
    throw new ParserError("invalid_xlsx", `${name} is not an XLSX workbook (no xl/workbook.xml).`)

  const sheets: Array<{ name: string; rid: string }> = []
  await readPart(src, workbook, budget, caps, {
    open: (tag) => {
      if (tag.name === "sheet") {
        sheets.push({
          name: String(tag.attributes.name ?? ""),
          rid: String(tag.attributes["r:id"] ?? ""),
        })
      }
    },
  })
  const targets = new Map<string, string>()
  const rels = byName.get("xl/_rels/workbook.xml.rels")
  if (rels) {
    await readPart(src, rels, budget, caps, {
      open: (tag) => {
        if (tag.name === "Relationship")
          targets.set(String(tag.attributes.Id), String(tag.attributes.Target))
      },
    })
  }

  const strings = new SharedStrings(
    opts.sharedStringsMemoryBytes ?? XLSX_SHARED_STRINGS_MEMORY_BYTES,
    opts.sharedStringsMaxBytes ?? XLSX_SHARED_STRINGS_MAX_BYTES,
    name,
  )
  try {
    const sst = byName.get("xl/sharedStrings.xml")
    if (sst) {
      let inSi = false
      let inT = false
      let inPhonetic = false
      let current = ""
      await readPart(src, sst, budget, caps, {
        open: (tag) => {
          if (tag.name === "si") {
            inSi = true
            current = ""
          } else if (tag.name === "t" && inSi && !inPhonetic) inT = true
          else if (tag.name === "rPh") inPhonetic = true
        },
        close: (tagName) => {
          if (tagName === "t") inT = false
          else if (tagName === "rPh") inPhonetic = false
          else if (tagName === "si") {
            inSi = false
            strings.add(current)
          }
        },
        text: (t) => {
          if (inSi && inT) current += t
        },
      })
    }

    for (let s = 0; s < sheets.length; s++) {
      const sheet = sheets[s] as { name: string; rid: string }
      const target = targets.get(sheet.rid)
      const entry = byName.get(target ? partPath(target) : `xl/worksheets/sheet${s + 1}.xml`)
      if (!entry) continue
      const ready: ParsedRecord[] = []
      let header: Map<number, string> | null = null
      // Sparse: only the cells that are set, so a far-right cell costs nothing.
      let row = new Map<number, unknown>()
      let nextCol = 0
      let rowHasValue = false
      let cellType = ""
      let cellCol = 0
      let cellText = ""
      let inValue = false
      let number = 0
      let rowBytes = 0
      const finishRow = () => {
        if (!rowHasValue) return
        const cells = [...row.entries()].sort((a, b) => a[0] - b[0])
        if (!header) {
          const seen = new Map<string, number>()
          header = new Map()
          for (const [i, v] of cells) {
            const base =
              v === undefined || v === null || String(v).trim() === ""
                ? `column_${i + 1}`
                : String(v).trim()
            const k = (seen.get(base) ?? 0) + 1
            seen.set(base, k)
            header.set(i, k === 1 ? base : `${base}_${k}`)
          }
          return
        }
        const value: Record<string, unknown> = {}
        for (const [i, v] of cells) value[header.get(i) ?? `column_${i + 1}`] = v
        number++
        const bytes = Buffer.byteLength(JSON.stringify(value), "utf8")
        if (bytes > PARSER_RECORD_MAX_BYTES) {
          throw recordTooLarge(`Row ${number} of sheet "${sheet.name}" in ${name}`, bytes)
        }
        ready.push({ number, value, path: sheet.name })
      }
      const part = xmlPart(src, entry, budget, caps, {
        open: (tag) => {
          if (tag.name === "row") {
            row = new Map()
            nextCol = 0
            rowHasValue = false
            rowBytes = 0
          } else if (tag.name === "c") {
            cellType = String(tag.attributes.t ?? "n")
            cellCol = columnIndex(tag.attributes.r as string | undefined, nextCol)
            if (cellCol < 0) {
              throw new ParserError(
                "invalid_xlsx",
                `Sheet "${sheet.name}" in ${name} has a cell past the last column (XFD); refused.`,
              )
            }
            nextCol = cellCol + 1
            cellText = ""
          } else if (tag.name === "v" || tag.name === "t") {
            inValue = true
          }
        },
        close: (tagName) => {
          if (tagName === "v" || tagName === "t") inValue = false
          else if (tagName === "c") {
            let value: unknown
            if (cellType === "s") value = strings.get(Number(cellText))
            else if (cellType === "b") value = cellText === "1"
            else if (cellType === "inlineStr" || cellType === "str" || cellType === "e")
              value = cellText
            else value = cellText === "" ? undefined : Number(cellText)
            if (value !== undefined && value !== "") {
              row.set(cellCol, value)
              rowHasValue = true
              rowBytes += typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8
              if (rowBytes > PARSER_RECORD_MAX_BYTES) {
                throw recordTooLarge(
                  `Row ${number + 1} of sheet "${sheet.name}" in ${name}`,
                  rowBytes,
                  true,
                )
              }
            }
          } else if (tagName === "row") finishRow()
        },
        text: (t) => {
          if (inValue) cellText += t
        },
      })
      for await (const _ of part) {
        while (ready.length > 0) yield ready.shift() as ParsedRecord
      }
    }
  } finally {
    strings.dispose()
  }
}

/** Test access to the shared-strings store (spill to disk, lookups). */
export const XlsxTestAccess = { SharedStrings }
