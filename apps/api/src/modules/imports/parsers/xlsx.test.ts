// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { collect, failure } from "./__test-helpers__/collect"
import { buildZip, type FixtureEntry } from "./__test-helpers__/zip-writer"
import type { ParserError } from "./common"
import { parseXlsx, XLSX_SHARED_STRINGS_MAX_BYTES } from "./xlsx"
import { bufferRangeSource } from "./zip"

const NS =
  'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

function workbook(opts: {
  strings: string[]
  sheets: Array<{ name: string; rows: string }>
  doctype?: boolean
}): Uint8Array {
  const entries: FixtureEntry[] = [
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0"?><workbook ${NS}><sheets>${opts.sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${opts.sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("")}</Relationships>`,
    },
    {
      name: "xl/sharedStrings.xml",
      data: `<?xml version="1.0"?>${opts.doctype ? '<!DOCTYPE sst [<!ENTITY a "b">]>' : ""}<sst ${NS}>${opts.strings
        .map((s) =>
          s.startsWith("rich:")
            ? `<si><r><t>${s.slice(5, 8)}</t></r><r><t>${s.slice(8)}</t></r><rPh><t>ignored</t></rPh></si>`
            : `<si><t>${s}</t></si>`,
        )
        .join("")}</sst>`,
    },
    ...opts.sheets.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: `<?xml version="1.0"?><worksheet ${NS}><sheetData>${s.rows}</sheetData></worksheet>`,
    })),
  ]
  return buildZip(entries)
}

const STRINGS = ["Name", "Amount", "Paid", "Acme SARL", "rich:BigCorp"]
const SHEET1 = `
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
  <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>1234.5</v></c><c r="C2" t="b"><v>1</v></c></row>
  <row r="4"><c r="A4" t="s"><v>4</v></c><c r="C4" t="b"><v>0</v></c></row>
  <row r="5"><c r="A5" t="inlineStr"><is><t>Inline Ltd</t></is></c><c r="B5" t="str"><v>formula text</v></c></row>`

describe("parseXlsx", () => {
  it("reads sheets as records keyed by the header row, keeping cell types", async () => {
    const src = bufferRangeSource(
      workbook({
        strings: STRINGS,
        sheets: [
          { name: "Invoices", rows: SHEET1 },
          {
            name: "Notes",
            rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Note</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>hello</t></is></c></row>',
          },
        ],
      }),
    )
    const rows = await collect(parseXlsx(src, { name: "book.xlsx" }))
    expect(rows).toEqual([
      { number: 1, value: { Name: "Acme SARL", Amount: 1234.5, Paid: true }, path: "Invoices" },
      { number: 2, value: { Name: "BigCorp", Paid: false }, path: "Invoices" },
      { number: 3, value: { Name: "Inline Ltd", Amount: "formula text" }, path: "Invoices" },
      { number: 1, value: { Note: "hello" }, path: "Notes" },
    ])
  })

  it("moves shared strings to disk past the memory threshold with the same results", async () => {
    const src = bufferRangeSource(
      workbook({ strings: STRINGS, sheets: [{ name: "Invoices", rows: SHEET1 }] }),
    )
    const rows = await collect(parseXlsx(src, { sharedStringsMemoryBytes: 8 }))
    expect(rows.map((r) => r.value)).toEqual([
      { Name: "Acme SARL", Amount: 1234.5, Paid: true },
      { Name: "BigCorp", Paid: false },
      { Name: "Inline Ltd", Amount: "formula text" },
    ])
  })

  it("refuses shared strings past the cap (256 MiB by default)", async () => {
    expect(XLSX_SHARED_STRINGS_MAX_BYTES).toBe(256 * 1024 * 1024)
    const src = bufferRangeSource(
      workbook({ strings: ["x".repeat(600), "y".repeat(600)], sheets: [{ name: "S", rows: "" }] }),
    )
    const err = await failure(parseXlsx(src, { name: "book.xlsx", sharedStringsMaxBytes: 1000 }))
    expect((err as ParserError).code).toBe("xlsx_shared_strings_too_large")
    expect(err.message).toContain("book.xlsx holds more than 1000 bytes of shared strings")
  })

  it("refuses a DOCTYPE in any part", async () => {
    const src = bufferRangeSource(
      workbook({ strings: STRINGS, sheets: [{ name: "S", rows: SHEET1 }], doctype: true }),
    )
    expect(((await failure(parseXlsx(src))) as ParserError).code).toBe("xml_dtd_refused")
  })

  it("refuses a zip that is not a workbook", async () => {
    const src = bufferRangeSource(buildZip([{ name: "readme.txt", data: "hi" }]))
    const err = await failure(parseXlsx(src, { name: "book.xlsx" }))
    expect((err as ParserError).code).toBe("invalid_xlsx")
  })
})

/** Letters that do not compress well, so the zip ratio cap stays out of the way. */
function noise(n: number): string {
  let x = 12345
  let out = ""
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    out += String.fromCharCode(97 + (x % 26))
  }
  return out
}

describe("parseXlsx: hostile cell references and text", () => {
  it("refuses a column past XFD without walking to it", async () => {
    const src = bufferRangeSource(
      workbook({
        strings: ["Name"],
        sheets: [
          {
            name: "S",
            rows: '<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="5"><c r="ZZZZZZ5"><v>1</v></c></row>',
          },
        ],
      }),
    )
    const started = Date.now()
    const err = await failure(parseXlsx(src, { name: "book.xlsx" }))
    expect((err as ParserError).code).toBe("invalid_xlsx")
    expect(err.message).toContain("XFD")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("a sparse row far to the right stays cheap", async () => {
    const src = bufferRangeSource(
      workbook({
        strings: ["Name"],
        sheets: [
          {
            name: "S",
            rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="XFD1" t="inlineStr"><is><t>Last</t></is></c></row><row r="2"><c r="XFD2"><v>7</v></c></row>',
          },
        ],
      }),
    )
    const rows = await collect(parseXlsx(src))
    expect(rows.map((r) => r.value)).toEqual([{ Last: 7 }])
  })

  it("refuses a cell value over the record cap while it is still being read", async () => {
    const src = bufferRangeSource(
      workbook({
        strings: ["Name"],
        sheets: [
          {
            name: "S",
            rows: `<row r="1"><c r="A1" t="inlineStr"><is><t>${noise(3 * 1024 * 1024)}</t></is></c></row>`,
          },
        ],
      }),
    )
    const err = await failure(parseXlsx(src))
    expect((err as ParserError).code).toBe("record_too_large")
  })
})
