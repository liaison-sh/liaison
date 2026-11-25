// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The doors of an uploaded PDF. A crafted file is parsed only by the render
// service's child, which dies on a bomb, a cycle or a deadline with nothing
// stored, and a production server with no render service refuses the upload.
// A file with two readings is refused at freeze by either check alone, and at
// seal a signed copy that reads differently is refused before any hash.

import { afterEach, describe, expect, it } from "bun:test"
import { deflateSync } from "node:zlib"
import { renderTransport } from "~/modules/pdf-render/client"
import { basePdf, PRICE, plainPdf } from "~/modules/pdf-render/fixtures.testutil"
import type { PdfRenderError } from "~/modules/pdf-render/protocol"
import { intakeUpload, oneReadingChecks, sealMerge } from "~/modules/pdf-render/readings"
import { checkUploadedPdf } from "~/modules/pdf-render/upload"

const ORG = "00000000-0000-4000-8000-0000000000b2"
const real = { ...renderTransport, ...oneReadingChecks }

afterEach(() => {
  renderTransport.production = real.production
  renderTransport.socketPath = real.socketPath
  oneReadingChecks.structure = real.structure
  oneReadingChecks.compare = real.compare
})

function twoReadings(): Uint8Array {
  const w = basePdf()
  w.xref("/Size 6 /Root 1 0 R")
  w.stream(4, "", PRICE("100000"))
  return w.bytes()
}

async function refusal(bytes: Uint8Array): Promise<string> {
  try {
    await intakeUpload(bytes)
    return "kept"
  } catch (err) {
    return (err as PdfRenderError).code
  }
}

describe("uploads reach a parser only in the render service", () => {
  it("NT-62: a production server with no render service refuses the upload and parses nothing", async () => {
    renderTransport.production = () => true
    renderTransport.socketPath = () => undefined
    const out = await checkUploadedPdf(ORG, plainPdf())
    expect(out).toMatchObject({ status: "refused", code: "PDF_RENDER_UNAVAILABLE" })
  })

  it("NT-62: an inflate bomb and a cross-reference cycle are refused, and nothing is kept", async () => {
    const bomb = deflateSync(Buffer.alloc(80 * 1024 * 1024))
    const head = Buffer.from(
      `%PDF-1.7\n9 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.byteLength} >>\nstream\n`,
      "latin1",
    )
    const bombFile = new Uint8Array(
      Buffer.concat([head, bomb, Buffer.from("\nendstream\nendobj\n%%EOF\n")]),
    )
    expect(await checkUploadedPdf(ORG, bombFile)).toMatchObject({
      status: "refused",
      code: "PDF_UNREADABLE",
    })
    const w = basePdf()
    const { at } = w.xref("/Size 6 /Root 1 0 R")
    const looped = Buffer.from(w.bytes())
      .toString("latin1")
      .replace("/Root 1 0 R >>", `/Root 1 0 R /Prev ${at} >>`)
    const out = await checkUploadedPdf(ORG, new Uint8Array(Buffer.from(looped, "latin1")))
    expect(out.status).toBe("refused")
    expect(out.status === "refused" && ["PDF_VARIES_BY_VIEWER", "PDF_UNREADABLE"]).toContain(
      out.status === "refused" ? out.code : "",
    )
  })
})

describe("one reading", () => {
  it("NT-68: a file read two ways is refused by the structure rule alone", async () => {
    oneReadingChecks.compare = () => null
    expect(await refusal(twoReadings())).toBe("PDF_VARIES_BY_VIEWER")
  })

  it("NT-68: a file read two ways is refused by the compare alone", async () => {
    oneReadingChecks.structure = () => ({ sections: 1 })
    expect(await refusal(twoReadings())).toBe("PDF_VARIES_BY_VIEWER")
  })

  it("NT-68: at seal, a merge that reads differently gives no signed copy", async () => {
    oneReadingChecks.compare = () => 1
    const frozen = plainPdf()
    let code = "merged"
    try {
      await sealMerge(frozen, plainPdf({ contents: PRICE("signature") }))
    } catch (err) {
      code = (err as PdfRenderError).code
    }
    expect(code).toBe("COPY_DIFFERS")
  })
})
