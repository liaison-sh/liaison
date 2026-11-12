// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A spreadsheet workbook (.xlsx) as text an agent can read: each sheet under a
 * `Sheet: <name>` line, then its rows as CSV. Used where the host turns a
 * downloaded workbook into text for app code that only handles strings
 * (`ctx.fetch` with `convert: "xlsx-text"`).
 */
import { csvCell } from "@liaison/shared"
import { parseXlsx } from "~/modules/imports/parsers/xlsx"
import { bufferRangeSource } from "~/modules/imports/parsers/zip"

/** The most text one workbook turns into (characters); the rest is cut, and said. */
export const SPREADSHEET_TEXT_MAX_CHARS = 1_000_000
/** The most rows one workbook turns into, all sheets together. */
export const SPREADSHEET_MAX_ROWS = 20_000

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
