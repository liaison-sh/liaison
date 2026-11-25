// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The file checks of an uploaded PDF: each file gets its own code (and so its
// own screen), a refused file stores nothing, a kept one is counted in its
// report. Then the render child killed on a page deadline and on memory, and
// the virus scanner down, up and finding something.

import { afterEach, describe, expect, it } from "bun:test"
import { createServer, type Server } from "node:net"
import { deflateSync } from "node:zlib"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { plainPdf } from "./fixtures.testutil"
import { PdfRenderTestAccess } from "./runner"
import { checkUploadedPdf } from "./upload"

const ORG = "00000000-0000-4000-8000-0000000000a1"

async function codeOf(bytes: Uint8Array): Promise<string> {
  const out = await checkUploadedPdf(ORG, bytes)
  return out.status === "ok" ? "kept" : out.code
}

async function pages(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < n; i++)
    doc.addPage([300, 400]).drawText(`Page ${i + 1}`, { x: 20, y: 300, size: 12, font })
  return doc.save()
}

const annot = (extra: string) =>
  plainPdf({
    pageExtra: "/Annots [6 0 R]",
    extra: [[6, `<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] ${extra} >>`]],
  })

const REFUSED: Array<[string, () => Promise<Uint8Array> | Uint8Array, string]> = [
  [
    "a file that is not a PDF",
    () => new Uint8Array(Buffer.from("PK\u0003\u0004 word document")),
    "NOT_A_PDF",
  ],
  ["a truncated file", () => plainPdf().subarray(0, 300), "PDF_UNREADABLE"],
  [
    "a 9 MB file",
    () => {
      const big = new Uint8Array(9 * 1024 * 1024)
      big.set(Buffer.from("%PDF-1.7\n"))
      return big
    },
    "PDF_TOO_LARGE",
  ],
  ["a 201-page file", () => pages(201), "PDF_TOO_LARGE"],
  [
    "an inflate bomb",
    () => {
      const bomb = deflateSync(Buffer.alloc(80 * 1024 * 1024))
      const head = Buffer.from(
        `%PDF-1.7\n9 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${bomb.byteLength} >>\nstream\n`,
        "latin1",
      )
      return new Uint8Array(
        Buffer.concat([head, bomb, Buffer.from("\nendstream\nendobj\n%%EOF\n")]),
      )
    },
    "PDF_UNREADABLE",
  ],
  [
    "an owner password",
    () => {
      const text = Buffer.from(
        plainPdf({ extra: [[6, "<< /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >>"]] }),
      ).toString("latin1")
      return new Uint8Array(
        Buffer.from(text.replace("/Root 1 0 R", "/Root 1 0 R /Encrypt 6 0 R"), "latin1"),
      )
    },
    "PDF_ENCRYPTED",
  ],
  [
    "XFA",
    () =>
      plainPdf({ catalogExtra: "/AcroForm << /Fields [] /XFA 6 0 R >>", extra: [[6, "<< >>"]] }),
    "PDF_VARIES_BY_VIEWER",
  ],
  [
    "JavaScript",
    () => plainPdf({ catalogExtra: "/OpenAction << /S /JavaScript /JS (app.alert(1)) >>" }),
    "PDF_ACTIVE_CONTENT",
  ],
  [
    "an open action that runs something",
    () => plainPdf({ catalogExtra: "/OpenAction << /S /URI /URI (https://x.example) >>" }),
    "PDF_ACTIVE_CONTENT",
  ],
  ["a launch action", () => annot("/A << /S /Launch /F (cmd.exe) >>"), "PDF_ACTIVE_CONTENT"],
  [
    "an embedded file",
    () => plainPdf({ catalogExtra: "/Names << /EmbeddedFiles << /Names [] >> >>" }),
    "PDF_ACTIVE_CONTENT",
  ],
  [
    "a layer hidden by default",
    () =>
      plainPdf({
        catalogExtra: "/OCProperties << /OCGs [6 0 R] /D << /OFF [6 0 R] >> >>",
        extra: [[6, "<< /Type /OCG /Name (Draft) >>"]],
      }),
    "PDF_VARIES_BY_VIEWER",
  ],
  [
    "a conditional layer",
    () => plainPdf({ extra: [[6, "<< /Type /OCMD /OCGs [] >>"]] }),
    "PDF_VARIES_BY_VIEWER",
  ],
  ["an annotation that prints and does not show", () => annot("/F 6"), "PDF_VARIES_BY_VIEWER"],
  [
    "an action behind lower-case hex in its names",
    () => annot("/A << /S /#4aavaScript /#4aS (x) >>"),
    "PDF_ACTIVE_CONTENT",
  ],
  [
    "an open action spelled with hex",
    () => plainPdf({ catalogExtra: "/#4fpenAction [3 0 R /Fit]" }),
    "PDF_ACTIVE_CONTENT",
  ],
]

describe("file checks of an uploaded PDF", () => {
  for (const [name, build, code] of REFUSED) {
    it(`${name} is refused ${code}`, async () => {
      expect(await codeOf(await build())).toBe(code)
    })
  }

  it("an empty user password is refused as encrypted, never asked for", async () => {
    const bytes = plainPdf()
    const text = Buffer.from(bytes)
      .toString("latin1")
      .replace(
        "/Root 1 0 R",
        "/Root 1 0 R /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <> /P -4 >>",
      )
    expect(await codeOf(new Uint8Array(Buffer.from(text, "latin1")))).toBe("PDF_ENCRYPTED")
  })

  it("an action shadowed by a later duplicate is refused on its superseded definition", async () => {
    const { basePdf } = await import("./fixtures.testutil")
    const w = basePdf({ catalogExtra: "/OpenAction 6 0 R" })
    w.obj(6, "<< /S /JavaScript /JS (app.alert(1)) >>")
    const { at } = w.xref("/Size 7 /Root 1 0 R")
    w.obj(6, "<< /S /GoTo /D [3 0 R /Fit] >>")
    w.xref(`/Size 7 /Root 1 0 R /Prev ${at}`)
    expect(await codeOf(w.bytes())).toBe("PDF_ACTIVE_CONTENT")
  })

  it("an open action that only goes to a page is kept", async () => {
    const out = await checkUploadedPdf(ORG, plainPdf({ catalogExtra: "/OpenAction [3 0 R /Fit]" }))
    expect(out.status).toBe("ok")
    if (out.status === "ok") expect(out.intake.report.openGoTo).toBe(true)
  })

  it("a signed file is kept and said to be signed", async () => {
    const bytes = plainPdf({
      catalogExtra: "/AcroForm << /Fields [6 0 R] /SigFlags 3 >>",
      pageExtra: "/Annots [6 0 R]",
      extra: [
        [
          6,
          "<< /FT /Sig /T (sig) /Type /Annot /Subtype /Widget /Rect [0 0 0 0] /P 3 0 R /V 7 0 R >>",
        ],
        [
          7,
          "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0 0 0] /Contents <00> >>",
        ],
      ],
    })
    const out = await checkUploadedPdf(ORG, bytes)
    expect(out.status).toBe("ok")
    if (out.status === "ok") expect(out.intake.report.signed).toBe(true)
  })

  it("a scanned file with no text is kept, read as pictures only", async () => {
    const out = await checkUploadedPdf(ORG, plainPdf({ contents: "0 0 1 rg 100 100 200 200 re f" }))
    expect(out.status).toBe("ok")
    if (out.status === "ok") {
      expect(out.intake.scanned).toBe(true)
      expect(out.scanState).toBe("not_run")
    }
  })

  it("a kept file's pictures are WebP of the stated size, at two widths", async () => {
    const out = await checkUploadedPdf(ORG, plainPdf())
    expect(out.status).toBe("ok")
    if (out.status !== "ok") return
    const page = out.intake.pages[0]
    expect(
      Buffer.from(page?.reading ?? "", "base64")
        .subarray(8, 12)
        .toString(),
    ).toBe("WEBP")
    expect(page?.smallWidth).toBeLessThan(page?.width ?? 0)
    expect(out.pagesSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("the render child", () => {
  afterEach(() => PdfRenderTestAccess.setLimits({}))

  it("is killed past its page deadline, and the file is unreadable", async () => {
    PdfRenderTestAccess.setLimits({ pageMs: 1 })
    expect(await codeOf(await pages(3))).toBe("PDF_UNREADABLE")
    const pid = PdfRenderTestAccess.lastPid() as number
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it("is killed past its memory ceiling, and the file is unreadable", async () => {
    PdfRenderTestAccess.setLimits({ maxRssBytes: 1024 * 1024 })
    expect(await codeOf(await pages(3))).toBe("PDF_UNREADABLE")
  })
})

describe("the virus scan", () => {
  let server: Server | null = null
  const saved = process.env.CLAMAV_HOST
  afterEach(() => {
    server?.close()
    server = null
    if (saved === undefined) delete process.env.CLAMAV_HOST
    else process.env.CLAMAV_HOST = saved
  })

  async function clamd(reply: string): Promise<number> {
    server = createServer((socket) => {
      socket.on("data", (chunk) => {
        if (Buffer.from(chunk).includes(Buffer.from([0, 0, 0, 0]))) socket.end(`stream: ${reply}\0`)
      })
    })
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r))
    const addr = server.address()
    return typeof addr === "object" && addr ? addr.port : 0
  }

  it("down: the file is kept, not checked for viruses", async () => {
    process.env.CLAMAV_HOST = "127.0.0.1:1"
    const out = await checkUploadedPdf(ORG, plainPdf())
    expect(out.status === "ok" && out.scanState).toBe("not_run")
  })

  it("up: the file is kept and clean", async () => {
    process.env.CLAMAV_HOST = `127.0.0.1:${await clamd("OK")}`
    const out = await checkUploadedPdf(ORG, plainPdf())
    expect(out.status === "ok" && out.scanState).toBe("clean")
  })

  it("infected: the file is refused and nothing is kept", async () => {
    process.env.CLAMAV_HOST = `127.0.0.1:${await clamd("Eicar-Test-Signature FOUND")}`
    const out = await checkUploadedPdf(ORG, plainPdf())
    expect(out.status).toBe("refused")
    if (out.status === "refused") expect(out.code).toBe("PDF_INFECTED")
  })
})
