// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PDF/A-3B conformance evidence for the kernel renderer (the container half of a Factur-X):
//   - S9 smoke check: oxidize-pdf `PdfAValidator(A3b)` through tools/pdfa-check accepts the file.
//     Calibration on the veraPDF corpus shows it is weak (see tools/pdfa-check/README.md), so it
//     is a smoke check only, never conformance evidence.
//   - S10 own structural asserts: every assert passes on the rendered file, and one mutation per
//     assert turns exactly that assert red.

import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFStream,
  PDFString,
  StandardFonts,
} from "pdf-lib"
import { EXPECT, renderSamplePdfA } from "../../../../test-support/pdfa/fixtures"
import {
  failing,
  STRUCTURAL_ASSERT_IDS,
  structuralAsserts,
} from "../../../../test-support/pdfa/structural-asserts"

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const CRATE = join(ROOT, "tools", "pdfa-check")
const BIN = join(CRATE, "target", "release", "pdfa-check")

function ensureBinary(): void {
  if (existsSync(BIN)) return
  const b = spawnSync("cargo", ["build", "--release", "--quiet"], { cwd: CRATE, encoding: "utf8" })
  if (b.status !== 0)
    throw new Error(`cargo build of tools/pdfa-check failed (Rust toolchain required): ${b.stderr}`)
}

function oxidize(bytes: Uint8Array): {
  valid: boolean
  errors: Array<{ code: string }>
  parse_error: string | null
} {
  ensureBinary()
  const dir = mkdtempSync(join(tmpdir(), "pdfa-check-"))
  try {
    const f = join(dir, "doc.pdf")
    writeFileSync(f, bytes)
    const r = spawnSync(BIN, ["--level", "3b", f], { encoding: "utf8" })
    return JSON.parse(r.stdout.trim())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function edit(
  bytes: Uint8Array,
  fn: (doc: PDFDocument) => void | Promise<void>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  await fn(doc)
  return doc.save({ useObjectStreams: false })
}

function fileSpec(doc: PDFDocument): PDFDict {
  const af = doc.catalog.lookup(PDFName.of("AF"), PDFArray)
  return doc.context.lookup(af.get(0), PDFDict)
}

function efStream(doc: PDFDocument): PDFStream {
  const ef = fileSpec(doc).lookup(PDFName.of("EF"), PDFDict)
  return ef.lookup(PDFName.of("F"), PDFStream)
}

function xmpOf(doc: PDFDocument): string {
  const s = doc.catalog.lookup(PDFName.of("Metadata"), PDFStream)
  const bytes =
    s instanceof PDFRawStream && s.dict.get(PDFName.of("Filter"))
      ? decodePDFRawStream(s).decode()
      : (s as PDFRawStream).contents
  return new TextDecoder().decode(bytes)
}

function setXmp(doc: PDFDocument, xmp: string, compress = false): void {
  const bytes = new TextEncoder().encode(xmp)
  const stream = compress
    ? doc.context.flateStream(bytes, { Type: "Metadata", Subtype: "XML" })
    : doc.context.stream(bytes, { Type: "Metadata", Subtype: "XML", Length: bytes.length })
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(stream))
}

type Mutation = (bytes: Uint8Array) => Promise<Uint8Array>

const MUTATIONS: Record<(typeof STRUCTURAL_ASSERT_IDS)[number], Mutation> = {
  "header-binary-comment": async (b) => {
    const out = new Uint8Array(b)
    const nl = out.indexOf(0x0a)
    out.set(new TextEncoder().encode("%abcd"), nl + 1)
    return out
  },
  "embedded-file-names": (b) =>
    edit(b, (d) => fileSpec(d).set(PDFName.of("UF"), PDFString.of("invoice.xml"))),
  "embedded-file-subtype": (b) =>
    edit(b, (d) =>
      efStream(d).dict.set(PDFName.of("Subtype"), PDFName.of("application/octet-stream")),
    ),
  "embedded-file-moddate": (b) =>
    edit(
      b,
      (d) =>
        void efStream(d).dict.lookup(PDFName.of("Params"), PDFDict).delete(PDFName.of("ModDate")),
    ),
  "af-relationship": (b) =>
    edit(b, (d) => fileSpec(d).set(PDFName.of("AFRelationship"), PDFName.of("Source"))),
  "catalog-af": (b) => edit(b, (d) => void d.catalog.delete(PDFName.of("AF"))),
  "xmp-uncompressed": (b) => edit(b, (d) => setXmp(d, xmpOf(d), true)),
  "xmp-pdfaid": (b) =>
    edit(b, (d) =>
      setXmp(d, xmpOf(d).replace("<pdfaid:part>3</pdfaid:part>", "<pdfaid:part>2</pdfaid:part>")),
    ),
  "xmp-extension-schema": (b) =>
    edit(b, (d) =>
      setXmp(
        d,
        xmpOf(d).replace(
          "<pdfaProperty:name>ConformanceLevel</pdfaProperty:name>",
          "<pdfaProperty:name>Level</pdfaProperty:name>",
        ),
      ),
    ),
  "xmp-extension-values": (b) =>
    edit(b, (d) =>
      setXmp(d, xmpOf(d).replace("<fx:Version>1.0</fx:Version>", "<fx:Version>2.0</fx:Version>")),
    ),
  "info-xmp-sync": (b) => edit(b, (d) => d.setProducer("Something else")),
  "output-intent-icc": (b) =>
    edit(b, (d) => {
      const intent = d.catalog.lookup(PDFName.of("OutputIntents"), PDFArray).lookup(0, PDFDict)
      const prof = intent.lookup(PDFName.of("DestOutputProfile"), PDFStream) as PDFRawStream
      const icc = new Uint8Array(decodePDFRawStream(prof).decode())
      icc.set(new TextEncoder().encode("scnr"), 12)
      intent.set(
        PDFName.of("DestOutputProfile"),
        d.context.register(d.context.flateStream(icc, { N: 3 })),
      )
    }),
  "no-cmyk-images": (b) =>
    edit(b, (d) => {
      d.context.register(
        d.context.stream(new Uint8Array([0, 0, 0, 0]), {
          Type: "XObject",
          Subtype: "Image",
          Width: 1,
          Height: 1,
          BitsPerComponent: 8,
          ColorSpace: "DeviceCMYK",
        }),
      )
    }),
  "fonts-embedded": (b) =>
    edit(b, async (d) => {
      const courier = await d.embedFont(StandardFonts.Courier)
      d.getPage(0).drawText("x", { x: 10, y: 10, size: 8, font: courier })
    }),
  "no-encryption": (b) =>
    edit(b, (d) => {
      d.context.trailerInfo.Encrypt = d.context.register(
        d.context.obj({ Filter: "Standard", V: 1, R: 2 }),
      )
    }),
  "no-javascript": (b) =>
    edit(b, (d) =>
      d.catalog.set(
        PDFName.of("OpenAction"),
        d.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") }),
      ),
    ),
  "trailer-id": (b) =>
    edit(b, (d) => {
      d.context.trailerInfo.ID = undefined
    }),
}

describe("PDF/A-3B conformance of the kernel renderer", () => {
  test("S9 smoke: oxidize-pdf PdfAValidator(A3b) accepts the rendered file", async () => {
    const r = oxidize(await renderSamplePdfA())
    expect(r.parse_error).toBeNull()
    expect(r.errors).toEqual([])
    expect(r.valid).toBe(true)
  }, 300_000)

  test("S9 smoke can say no: an encrypted-marked file is rejected", async () => {
    const r = oxidize(await MUTATIONS["no-encryption"](await renderSamplePdfA()))
    expect(r.valid).toBe(false)
  }, 300_000)

  test("S10: every structural assert passes on the rendered file and on an unmutated round trip", async () => {
    const bytes = await renderSamplePdfA()
    const results = await structuralAsserts(bytes, EXPECT)
    expect(results.map((r) => r.id).sort()).toEqual([...STRUCTURAL_ASSERT_IDS].sort())
    expect(failing(results)).toEqual([])
    expect(failing(await structuralAsserts(await edit(bytes, () => {}), EXPECT))).toEqual([])
  })

  for (const id of STRUCTURAL_ASSERT_IDS) {
    test(`S10 mutation turns '${id}' red`, async () => {
      const mutated = await MUTATIONS[id](await renderSamplePdfA())
      const red = failing(await structuralAsserts(mutated, EXPECT))
      expect(red).toContain(id)
    })
  }
})
