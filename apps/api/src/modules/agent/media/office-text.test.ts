// SPDX-License-Identifier: FSL-1.1-ALv2
// office-text.ts: an Office document's text, read in memory with bounded work. A few kilobytes
// of deflate can claim gigabytes of XML; reading must stop at the part and document caps.
import { describe, expect, it } from "bun:test"
import { strToU8, zipSync } from "fflate"
import {
  OFFICE_PART_MAX_INFLATED_BYTES,
  OFFICE_TOTAL_MAX_INFLATED_BYTES,
  type OfficeTextStats,
  officeDocumentText,
} from "~/modules/agent/media/office-text"

/** One inflater push can overshoot a cap by about 4 MiB (zip.ts), never more. */
const ONE_PUSH = 4.5 * 1024 * 1024

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

function docx(documentXml: string): Uint8Array {
  return zipSync({ "word/document.xml": strToU8(documentXml) }, { level: 9 })
}

function stats(): OfficeTextStats {
  return { inflatedBytes: 0, truncated: false }
}

describe("officeDocumentText", () => {
  it("reads a small Word document whole", async () => {
    const s = stats()
    const text = await officeDocumentText(
      docx(
        `<w:document ${W}><w:body><w:p><w:r><w:t>Invoice INV-2207</w:t></w:r></w:p><w:p><w:r><w:t>Total 120 EUR</w:t></w:r></w:p></w:body></w:document>`,
      ),
      "docx",
      s,
    )
    expect(text).toBe("Invoice INV-2207\nTotal 120 EUR")
    expect(s.truncated).toBe(false)
  })

  it("a high-ratio part (40 MB of XML in a few KB) stops inflating at the part cap", async () => {
    const bomb = docx(
      `<w:document ${W}><w:body><w:p><w:r><w:t>First line</w:t></w:r></w:p>${" ".repeat(40 * 1024 * 1024)}<w:p><w:r><w:t>never reached</w:t></w:r></w:p></w:body></w:document>`,
    )
    expect(bomb.byteLength).toBeLessThan(200 * 1024)
    const s = stats()
    const started = Date.now()
    const text = await officeDocumentText(bomb, "docx", s)
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(s.truncated).toBe(true)
    expect(s.inflatedBytes).toBeGreaterThanOrEqual(OFFICE_PART_MAX_INFLATED_BYTES)
    expect(s.inflatedBytes).toBeLessThanOrEqual(OFFICE_PART_MAX_INFLATED_BYTES + ONE_PUSH)
    expect(text).toContain("First line")
    expect(text).not.toContain("never reached")
    expect(text).toContain("[Cut:")
  })

  it("many high-ratio sheets stop at the document's total cap", async () => {
    const sheet = (n: number) =>
      strToU8(
        `<worksheet><sheetData><row><c t="inlineStr"><is><t>sheet ${n}</t></is></c></row>${" ".repeat(3 * 1024 * 1024)}</sheetData></worksheet>`,
      )
    const files: Record<string, Uint8Array> = {}
    for (let n = 1; n <= 12; n++) files[`xl/worksheets/sheet${n}.xml`] = sheet(n)
    const s = stats()
    const text = await officeDocumentText(zipSync(files, { level: 9 }), "xlsx", s)
    expect(s.truncated).toBe(true)
    expect(s.inflatedBytes).toBeLessThanOrEqual(OFFICE_TOTAL_MAX_INFLATED_BYTES + ONE_PUSH)
    expect(text).toContain("sheet 1")
    expect(text).not.toContain("sheet 12")
    expect(text).toContain("[Cut:")
  })

  it("a long text stops reading once it passes the character cap", async () => {
    const para = "<w:p><w:r><w:t>lorem ipsum dolor sit amet</w:t></w:r></w:p>"
    const s = stats()
    const text = await officeDocumentText(
      docx(`<w:document ${W}><w:body>${para.repeat(400_000)}</w:body></w:document>`),
      "docx",
      s,
    )
    // 400k paragraphs are about 24 MB of XML; the text cap is reached long before.
    expect(s.inflatedBytes).toBeLessThan(OFFICE_PART_MAX_INFLATED_BYTES)
    expect(text).toContain("[Cut: the document is longer than")
  })
})
