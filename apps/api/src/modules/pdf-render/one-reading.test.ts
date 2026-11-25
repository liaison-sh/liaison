// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One reading, or refused. Each crafted file holds two copies of the page's
// content, "PRICE EUR 10000" where the cross-reference points and
// "PRICE EUR 100000" where pdf-lib lands. Each must be refused by the
// structure rule alone (the compare stubbed out) and by the compare alone (the
// structure rule stubbed out), so neither check can be removed unnoticed.
// Fixtures are built in code; none is committed as a sample.

import { afterEach, describe, expect, it } from "bun:test"
import { degrees, PDFDocument, PDFName, StandardFonts } from "pdf-lib"
import { checkPdfStructure } from "~/modules/documents/pdf-form-core"
import { basePdf, PdfWriter, PRICE } from "./fixtures.testutil"
import type { PdfRenderError } from "./protocol"
import { firstDifference, intakeUpload, oneReadingChecks } from "./readings"

const real = { ...oneReadingChecks }
afterEach(() => {
  oneReadingChecks.structure = real.structure
  oneReadingChecks.compare = real.compare
})

const noStructure = () => {
  oneReadingChecks.structure = () => ({ sections: 1 })
}
const noCompare = () => {
  oneReadingChecks.compare = () => null
}

async function codeOf(bytes: Uint8Array): Promise<string> {
  try {
    await intakeUpload(bytes)
    return "kept"
  } catch (err) {
    return (err as PdfRenderError).code
  }
}

/** After the last %%EOF: the reviewer's file. */
function afterEof(): Uint8Array {
  const w = basePdf()
  w.xref("/Size 6 /Root 1 0 R")
  w.stream(4, "", PRICE("100000"))
  return w.bytes()
}

/** Before the cross-reference: the named copy first, a later copy after it. */
function beforeXref(): Uint8Array {
  const w = basePdf()
  w.stream(4, "", PRICE("100000"))
  return rewriteWith(w, new Map())
}

/** Writes a table naming every object at its first definition, except overrides. */
function rewriteWith(w: PdfWriter, overrides: Map<number, number | "free">): Uint8Array {
  const text = Buffer.from(w.bytes()).toString("latin1")
  const map = new Map<number, number | "free">()
  for (const m of text.matchAll(/(\d+) 0 obj/g)) {
    const n = Number(m[1])
    if (!map.has(n)) map.set(n, m.index ?? 0)
  }
  for (const [n, v] of overrides) map.set(n, v)
  w.xref("/Size 6 /Root 1 0 R", map)
  return w.bytes()
}

/** An update whose own cross-reference still names the old copy. */
function staleUpdate(): Uint8Array {
  const w = basePdf()
  const old = Buffer.from(w.bytes()).toString("latin1").indexOf("4 0 obj")
  const { at } = w.xref("/Size 6 /Root 1 0 R")
  w.stream(4, "", PRICE("100000"))
  w.xref(`/Size 6 /Root 1 0 R /Prev ${at}`, new Map([[4, old]]))
  return w.bytes()
}

/** A page object in two object streams; the cross-reference names the first. */
function pageInTwoStreams(): Uint8Array {
  const w = new PdfWriter().header()
  const o1 = w.obj(1, "<< /Type /Catalog /Pages 2 0 R >>")
  const o2 = w.obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
  const page = (contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents ${contents} 0 R >>`
  const packed = (body: string) => {
    const head = "3 0 "
    return { dict: `/Type /ObjStm /N 1 /First ${head.length}`, data: head + body }
  }
  const o4 = w.stream(4, "", PRICE("10000"))
  const o5 = w.obj(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
  const o6 = w.stream(6, "", PRICE("100000"))
  const a = packed(page(4))
  const o10 = w.stream(10, a.dict, a.data)
  const b = packed(page(6))
  const o11 = w.stream(11, b.dict, b.data)
  w.xrefStream(
    12,
    "/Root 1 0 R",
    new Map<number, { offset: number } | { stream: number; index: number }>([
      [1, { offset: o1 }],
      [2, { offset: o2 }],
      [3, { stream: 10, index: 0 }],
      [4, { offset: o4 }],
      [5, { offset: o5 }],
      [6, { offset: o6 }],
      [10, { offset: o10 }],
      [11, { offset: o11 }],
    ]),
  )
  return w.bytes()
}

/** The page's content freed by a later update: pdf.js reads nothing, pdf-lib the old copy. */
function freedContent(): Uint8Array {
  const w = basePdf()
  const { at } = w.xref("/Size 6 /Root 1 0 R")
  w.xref(`/Size 6 /Root 1 0 R /Prev ${at}`, new Map([[4, "free"]]))
  return w.bytes()
}

const CRAFTED: Array<[string, () => Uint8Array]> = [
  ["a copy after the last end of file", afterEof],
  ["a copy before the cross-reference", beforeXref],
  ["an update whose cross-reference still names the old copy", staleUpdate],
  ["a page object in two object streams", pageInTwoStreams],
]

describe("one reading of an uploaded PDF", () => {
  for (const [name, build] of CRAFTED) {
    it(`${name}: refused by the structure rule alone`, async () => {
      noCompare()
      expect(await codeOf(build())).toBe("PDF_VARIES_BY_VIEWER")
    })
    it(`${name}: refused by the compare alone`, async () => {
      noStructure()
      expect(await codeOf(build())).toBe("PDF_VARIES_BY_VIEWER")
    })
  }

  it("a content object freed by a later update passes the structure rule and is refused by the compare", async () => {
    expect(() => checkPdfStructure(freedContent())).not.toThrow()
    expect(await codeOf(freedContent())).toBe("PDF_VARIES_BY_VIEWER")
    noCompare()
    expect(await codeOf(freedContent())).toBe("kept")
  })

  it("the compare names the first page whose pixels, size or text differ", () => {
    const page = { n: 1, width: 10, height: 10, rgbaSha256: "a", text: "x" }
    expect(firstDifference([page], [page])).toBeNull()
    expect(firstDifference([page], [{ ...page, text: "y" }])).toBe(1)
    expect(firstDifference([page], [{ ...page, rgbaSha256: "b" }])).toBe(1)
    expect(firstDifference([page], [])).toBe(1)
  })
})

describe("files with one reading freeze, and their merge reads the same", () => {
  async function made(edit: (doc: PDFDocument) => Promise<void> | void): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    for (let i = 0; i < 3; i++)
      doc.addPage([595, 842]).drawText(`Clause ${i + 1}`, { x: 72, y: 700, size: 18, font })
    await edit(doc)
    return doc.save()
  }

  it("a clean file", async () => {
    const out = await intakeUpload(await made(() => {}))
    expect(out.pages).toHaveLength(3)
    expect(out.pages[0]?.text).toContain("Clause 1")
    expect(out.scanned).toBe(false)
  })

  it("a well-formed incremental update", async () => {
    const w = basePdf()
    const { at } = w.xref("/Size 6 /Root 1 0 R")
    w.stream(4, "", PRICE("12000"))
    w.xref(`/Size 6 /Root 1 0 R /Prev ${at}`)
    const out = await intakeUpload(w.bytes())
    expect(out.report.revisions).toBe(1)
    expect(out.pages[0]?.text).toContain("PRICE EUR 12000")
  })

  it("pages rotated 90, 180 and 270", async () => {
    const out = await intakeUpload(
      await made((doc) => {
        doc.getPage(0).setRotation(degrees(90))
        doc.getPage(1).setRotation(degrees(180))
        doc.getPage(2).setRotation(degrees(270))
      }),
    )
    expect(out.pages[0]?.width).toBeGreaterThan(out.pages[0]?.height ?? 0)
  })

  it("a square comment", async () => {
    const out = await intakeUpload(
      await made((doc) => {
        const annot = doc.context.obj({
          Type: "Annot",
          Subtype: "Square",
          Rect: [100, 100, 200, 200],
          C: [1, 0, 0],
          Contents: doc.context.obj("Check this") as never,
        })
        doc
          .getPage(0)
          .node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]))
      }),
    )
    expect(out.report.comments).toBe(1)
  })

  it("a filled form field", async () => {
    const out = await intakeUpload(
      await made((doc) => {
        const field = doc.getForm().createTextField("client.name")
        field.setText("Maison Morel")
        field.addToPage(doc.getPage(0), { x: 72, y: 600, width: 200, height: 24 })
      }),
    )
    expect(out.pages).toHaveLength(3)
  })
})
