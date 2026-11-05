// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which Drive files have a text form, and getting it: the one rule the agent's
 * `read` tool and the Knowledge sync share, so a file the agent can read is a
 * file the sync imports, and the reverse.
 *
 * - Google Docs and Slides export as plain text, Google Sheets as CSV (Drive
 *   exports the first sheet only).
 * - An Excel workbook (.xlsx) is downloaded and turned into CSV, sheet by
 *   sheet, with the import parser (modules/imports/parsers/xlsx.ts).
 * - Plain text, Markdown, CSV, JSON and the rest of the Knowledge text list
 *   (source-protocol.ts `isTextMime`) are read as they are.
 *
 * Everything else (PDF, images, Word, archives) has no text form here: the
 * sync skips it and says so, and the agent imports it as an attachment.
 */
import { csvCell } from "@liaison/shared"
import { isTextMime } from "~/apps/knowledge/source-protocol"
import { parseXlsx } from "~/modules/imports/parsers/xlsx"
import { bufferRangeSource } from "~/modules/imports/parsers/zip"

export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet"
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation"
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

/** The most text one workbook turns into (characters); the rest is cut, and said. */
export const SPREADSHEET_TEXT_MAX_CHARS = 1_000_000
/** The most rows one workbook turns into, all sheets together. */
export const SPREADSHEET_MAX_ROWS = 20_000

/** The export type that gives a native Google file's text, or null (drawings, forms…). */
export function googleExportMimeFor(mimeType: string): string | null {
  switch (mimeType) {
    case GOOGLE_SHEET_MIME:
      return "text/csv"
    case GOOGLE_DOC_MIME:
    case GOOGLE_SLIDES_MIME:
      return "text/plain"
    default:
      return null
  }
}

/**
 * Whether a Drive file of this type has a text form the Knowledge sync imports
 * (the read tool also reads any other `text/*` file as it is).
 */
export function driveHasText(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return googleExportMimeFor(mimeType) !== null || mimeType === XLSX_MIME || isTextMime(mimeType)
}

/** A short name for a type that has no text form, for the person and the agent. */
export function driveTypeLabel(mimeType: string): string {
  if (mimeType === "application/pdf") return "PDF"
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("video/")) return "video"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.includes("wordprocessingml") || mimeType === "application/msword") return "Word"
  if (mimeType.includes("presentationml") || mimeType === "application/vnd.ms-powerpoint") {
    return "PowerPoint"
  }
  if (mimeType === "application/vnd.ms-excel") return "Excel 97-2003 (.xls)"
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    return `Google ${mimeType.slice("application/vnd.google-apps.".length)}`
  }
  return mimeType
}

/**
 * An Excel workbook as text: each sheet under a `Sheet: <name>` line, then its
 * rows as CSV, the header row first (the first non-empty row, as the import
 * parser reads it). Bounded by {@link SPREADSHEET_TEXT_MAX_CHARS} and
 * {@link SPREADSHEET_MAX_ROWS}: past either, the text ends with a line saying
 * it was cut. A file that is not a workbook throws the parser's error.
 */
export async function xlsxToText(bytes: Uint8Array, name: string): Promise<string> {
  const sheets: Array<{ name: string; columns: string[]; rows: Record<string, unknown>[] }> = []
  let chars = 0
  let rows = 0
  let truncated = false
  for await (const record of parseXlsx(bufferRangeSource(bytes), { name })) {
    if (rows >= SPREADSHEET_MAX_ROWS || chars >= SPREADSHEET_TEXT_MAX_CHARS) {
      truncated = true
      break
    }
    const sheetName = record.path ?? "Sheet"
    let sheet = sheets[sheets.length - 1]
    if (!sheet || sheet.name !== sheetName) {
      sheet = { name: sheetName, columns: [], rows: [] }
      sheets.push(sheet)
    }
    const value =
      record.value && typeof record.value === "object" && !Array.isArray(record.value)
        ? (record.value as Record<string, unknown>)
        : { value: record.value }
    for (const key of Object.keys(value)) {
      if (!sheet.columns.includes(key)) {
        sheet.columns.push(key)
        chars += key.length + 1
      }
    }
    sheet.rows.push(value)
    rows++
    for (const cell of Object.values(value)) chars += String(cell ?? "").length + 1
  }
  const parts: string[] = []
  for (const sheet of sheets) {
    const lines = [`Sheet: ${sheet.name}`, sheet.columns.map(csvCell).join(",")]
    for (const row of sheet.rows) lines.push(sheet.columns.map((c) => csvCell(row[c])).join(","))
    parts.push(lines.join("\n"))
  }
  let text = parts.join("\n\n")
  if (text.length > SPREADSHEET_TEXT_MAX_CHARS) {
    text = text.slice(0, SPREADSHEET_TEXT_MAX_CHARS)
    truncated = true
  }
  if (truncated) {
    text += `\n\n[Cut: the workbook is longer than ${SPREADSHEET_MAX_ROWS} rows or ${SPREADSHEET_TEXT_MAX_CHARS} characters; the rest is not included.]`
  }
  return text
}
