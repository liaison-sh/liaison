// SPDX-License-Identifier: FSL-1.1-ALv2
/** Test-only: a small Excel workbook built at test time (inline strings and numbers). */
import { buildZip } from "~/modules/imports/parsers/__test-helpers__/zip-writer"

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

/** A workbook whose cells are inline strings or numbers, sheet by sheet. */
export function workbookBytes(sheets: Array<{ name: string; rows: unknown[][] }>): Uint8Array {
  const cell = (v: unknown, ref: string) =>
    typeof v === "number"
      ? `<c r="${ref}"><v>${v}</v></c>`
      : `<c r="${ref}" t="inlineStr"><is><t>${String(v)}</t></is></c>`
  const col = (i: number) => String.fromCharCode(65 + i)
  return buildZip([
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${NS}><sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    },
    ...sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0"?><worksheet ${NS}><sheetData>${s.rows
        .map(
          (row, r) =>
            `<row r="${r + 1}">${row.map((v, c) => cell(v, `${col(c)}${r + 1}`)).join("")}</row>`,
        )
        .join("")}</sheetData></worksheet>`,
    })),
  ])
}
