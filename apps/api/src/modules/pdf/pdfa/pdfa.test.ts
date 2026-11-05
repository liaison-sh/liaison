// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Native PDF/A-3B output of the replayer: the container a Factur-X needs (embedded XML with its
// associated-file wiring, XMP with the PDF/A id and an extension schema, sRGB OutputIntent,
// trailer ID, Info/XMP in sync), the refusals (non-embeddable fonts, CMYK images), and the
// bridge-side parameter validation.

import { describe, expect, test } from "bun:test"
import type { DrawCommand } from "@liaison/shared"
import { type PDFDict, PDFDocument, PDFName } from "pdf-lib"
import {
  CMYK_JPEG,
  EXPECT,
  PDFA_COMMANDS,
  renderSamplePdfA,
  SAMPLE_EXTENSION,
  SAMPLE_XML,
} from "../../../../test-support/pdfa/fixtures"
import { failing, structuralAsserts } from "../../../../test-support/pdfa/structural-asserts"
import { replayDrawCommands } from "../replay"
import { jpegComponents } from "./finalize"
import { parsePdfAParams } from "./params"
import { buildXmp, validateExtensions } from "./xmp"

describe("native PDF/A-3B", () => {
  test("a rendered PDF/A carries every structural element", async () => {
    const bytes = await renderSamplePdfA()
    const results = await structuralAsserts(bytes, EXPECT)
    expect(failing(results)).toEqual([])
    const xmp = new TextDecoder().decode(bytes)
    expect(xmp).toContain("<pdfaid:part>3</pdfaid:part>")
    expect(xmp).toContain("<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>")
  })

  test("the embedded XML bytes round-trip", async () => {
    const bytes = await renderSamplePdfA()
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const af = doc.catalog.lookup(PDFName.of("AF"))
    expect(af).toBeDefined()
    expect(Buffer.from(bytes).includes(Buffer.from("factur-x.xml"))).toBe(true)
    expect(doc.catalog.lookup(PDFName.of("Metadata"))).toBeDefined()
  })

  test("a plain render is unchanged: no XMP, no OutputIntent, no attachment", async () => {
    const bytes = await replayDrawCommands(PDFA_COMMANDS)
    const doc = await PDFDocument.load(bytes)
    expect(doc.catalog.get(PDFName.of("Metadata"))).toBeUndefined()
    expect(doc.catalog.get(PDFName.of("OutputIntents"))).toBeUndefined()
    expect(doc.catalog.get(PDFName.of("AF"))).toBeUndefined()
  })

  test("a base-14 font that cannot be embedded is refused in PDF/A, accepted otherwise", async () => {
    const withTimes: DrawCommand[] = [
      ...PDFA_COMMANDS,
      { op: "embedFont", ref: "t", standardFont: "TimesRoman" },
    ]
    await expect(renderSamplePdfA({ commands: withTimes })).rejects.toThrow(/cannot be embedded/)
    await expect(replayDrawCommands(withTimes)).resolves.toBeInstanceOf(Uint8Array)
  })

  test("a CMYK JPEG logo is skipped in PDF/A (it would be embedded as DeviceCMYK otherwise)", async () => {
    expect(jpegComponents(CMYK_JPEG)).toBe(4)
    const plain = await replayDrawCommands(PDFA_COMMANDS, {
      resolveImage: async () => ({ bytes: CMYK_JPEG, mime: "image/jpeg" }),
    })
    expect(Buffer.from(plain).includes(Buffer.from("/DeviceCMYK"))).toBe(true)
    const pdfa = await renderSamplePdfA({ image: { bytes: CMYK_JPEG, mime: "image/jpeg" } })
    expect(Buffer.from(pdfa).includes(Buffer.from("/DeviceCMYK"))).toBe(false)
    expect(failing(await structuralAsserts(pdfa, EXPECT))).toEqual([])
  })

  test("pdf-lib metadata is not stamped in PDF/A mode (Producer stays the template's)", async () => {
    const doc = await PDFDocument.load(await renderSamplePdfA(), { updateMetadata: false })
    const info = doc.context.lookup(doc.context.trailerInfo.Info) as PDFDict
    expect(doc.getProducer()).toBe("Liaison Invoicing")
    expect(info.get(PDFName.of("CreationDate"))).toBeDefined()
  })
})

describe("PDF/A parameters from the bridge", () => {
  const b64 = Buffer.from(SAMPLE_XML).toString("base64")
  test("valid attachments and extensions parse", () => {
    const p = parsePdfAParams({
      pdfa: "3b",
      attachments: [
        { name: "factur-x.xml", mime: "text/xml", bytesBase64: b64, afRelationship: "Data" },
      ],
      xmp: { extensions: [SAMPLE_EXTENSION] },
    })
    expect(p.pdfa).toBe("3b")
    expect(p.attachments[0]?.bytes.byteLength).toBe(SAMPLE_XML.byteLength)
    expect(p.xmpExtensions).toHaveLength(1)
  })

  test("bad shapes are refused", () => {
    const att = { name: "factur-x.xml", mime: "text/xml", bytesBase64: b64, afRelationship: "Data" }
    expect(() => parsePdfAParams({ pdfa: "2u" })).toThrow()
    expect(() => parsePdfAParams({ attachments: [att] })).toThrow(/only allowed with pdfa/)
    expect(() => parsePdfAParams({ pdfa: "3b", attachments: [{ ...att, name: "../x" }] })).toThrow()
    expect(() => parsePdfAParams({ pdfa: "3b", attachments: [att, att] })).toThrow(/duplicated/)
    expect(() =>
      parsePdfAParams({ pdfa: "3b", attachments: [{ ...att, afRelationship: "Evil" }] }),
    ).toThrow()
    expect(() =>
      parsePdfAParams({ pdfa: "3b", attachments: [{ ...att, bytesBase64: "not base64!" }] }),
    ).toThrow()
    expect(() =>
      parsePdfAParams({
        pdfa: "3b",
        xmp: { extensions: [{ ...SAMPLE_EXTENSION, prefix: "rdf" }] },
      }),
    ).toThrow()
    expect(() =>
      validateExtensions([
        { ...SAMPLE_EXTENSION, properties: [{ name: "a b", value: "x", description: "d" }] },
      ]),
    ).toThrow()
  })

  test("XMP text is escaped", () => {
    const xmp = buildXmp({
      part: 3,
      conformance: "B",
      title: 'A & B <"x">',
      producer: null,
      creatorTool: null,
      createDate: "2026-01-01T00:00:00Z",
      modifyDate: "2026-01-01T00:00:00Z",
      extensions: [],
    })
    expect(xmp).toContain("A &amp; B &lt;&quot;x&quot;&gt;")
  })
})
