// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { degrees, PDFDocument } from "pdf-lib"
import { stripPdfRotation } from "./normalize"

async function rotatedPdf(angle: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([792, 612]).setRotation(degrees(angle))
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

describe("stripPdfRotation", () => {
  it("clears /Rotate on every page, keeping dimensions and content boxes", async () => {
    const out = await stripPdfRotation(await rotatedPdf(270))
    const doc = await PDFDocument.load(out)
    const page = doc.getPage(0)
    expect(page.getRotation().angle).toBe(0)
    expect(Math.round(page.getWidth())).toBe(792)
  })

  it("returns the original buffer for non-PDF bytes and for PDFs with no rotation", async () => {
    const notPdf = Buffer.from("hello")
    expect(await stripPdfRotation(notPdf)).toBe(notPdf)
    const plain = await PDFDocument.create()
    plain.addPage([100, 100])
    const bytes = Buffer.from(await plain.save({ useObjectStreams: false }))
    expect(await stripPdfRotation(bytes)).toBe(bytes)
  })

  it("survives unparseable input by returning it unchanged", async () => {
    const junk = Buffer.from("%PDF-1.4 garbage")
    expect(await stripPdfRotation(junk)).toBe(junk)
  })
})
