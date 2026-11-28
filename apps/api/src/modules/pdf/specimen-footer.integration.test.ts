// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Specimen mark of a document rendered in a demo workspace: the host hands
// the template its own `specimen` value in a demo org and none elsewhere, the
// invoicing footer draws it on every page without touching the body, an
// embedded structured invoice says specimen too, and a real document's drawing
// and text are the same as before the mark existed (the goldens in
// `__goldens__/specimen/`, written from the templates before the change).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { DrawCommand } from "@liaison/app-sdk"
import { decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from "pdf-lib"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { invalidateDemoMarker, visitorMarker } from "~/modules/demo/demo-org"
import { markDemoOrgForTest } from "~/tests/helpers/demo-org"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { buildCii } from "../../../../../bundled-apps/invoicing/src/facturx/cii"
import { fxDocument } from "../../../../../bundled-apps/invoicing/src/facturx/fixtures"
import { extractPdfText } from "./pdf-text"
import { PdfRegistryTestAccess, registerTemplate } from "./registry"
import { getFileBytes, renderPdf } from "./render"
import {
  ciiWithSpecimenNote,
  specimenNoteText,
  specimenTexts,
  storedBytesWithSpecimen,
  withSpecimen,
} from "./specimen"
import {
  commandsJson,
  documentInput,
  GOLDEN_CASES,
  goldenInput,
  goldenPaths,
  pageText,
  readGolden,
  TEMPLATES,
} from "./specimen-goldens"

const EN = "Specimen, fictional company"
const FR = "Spécimen, entreprise fictive"

type TextCmd = { text: string; x: number; y: number; size: number; page: number }

function textCmds(cmds: DrawCommand[]): TextCmd[] {
  return cmds.filter((c) => c.op === "drawText").map((c) => c as unknown as TextCmd)
}

function pageCount(cmds: DrawCommand[]): number {
  return cmds.filter((c) => c.op === "addPage").length
}

/** The vertical extent of a drawn text line: descender to cap height, Helvetica metrics. */
function band(t: TextCmd): [number, number] {
  return [t.y - 0.22 * t.size, t.y + 0.75 * t.size]
}

describe("outside a demo, an invoicing document is drawn as before", () => {
  for (const c of GOLDEN_CASES) {
    test(`outside a demo the template's draw program for ${c.name} is identical to before`, () => {
      const p = goldenPaths(c.name)
      const cmds = TEMPLATES[c.type](goldenInput(c))
      expect(JSON.parse(commandsJson(cmds))).toEqual(JSON.parse(readGolden(p.draw) ?? "null"))
    })

    test(`outside a demo the extracted page text of ${c.name} is unchanged`, async () => {
      const p = goldenPaths(c.name)
      const cmds = TEMPLATES[c.type](goldenInput(c))
      expect(`${await pageText(cmds)}\n`).toBe(readGolden(p.text) ?? "missing golden")
    })
  }

  test("a null or empty specimen draws nothing more", () => {
    const base = TEMPLATES.invoice(documentInput("invoice", 3))
    for (const specimen of [null, {}, { en: "  " }]) {
      const cmds = TEMPLATES.invoice({ ...documentInput("invoice", 3), specimen })
      expect(commandsJson(cmds)).toBe(commandsJson(base))
    }
  })
})

describe("in a demo, the Specimen line", () => {
  test("an invoice rendered in a demo workspace carries the specimen line on every page", async () => {
    const input = { ...documentInput("invoice", 60), specimen: specimenTexts() }
    const cmds = TEMPLATES.invoice(input)
    const pages = pageCount(cmds)
    expect(pages).toBeGreaterThan(1)
    const marked = new Set(
      textCmds(cmds)
        .filter((t) => t.text === EN)
        .map((t) => t.page),
    )
    expect([...marked].sort()).toEqual(Array.from({ length: pages }, (_, i) => i))
    const text = await pageText(cmds)
    expect(text.split(EN).length - 1).toBe(pages)
  })

  test("every document type draws it, in the issuer's language", () => {
    for (const type of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
      const fr = TEMPLATES[type]({
        ...documentInput(type, 2, { french: true }),
        specimen: specimenTexts(),
      })
      expect(textCmds(fr).some((t) => t.text === FR)).toBe(true)
      expect(textCmds(fr).some((t) => t.text === EN)).toBe(false)
      const en = TEMPLATES[type]({ ...documentInput(type, 2), specimen: specimenTexts() })
      expect(textCmds(en).some((t) => t.text === EN)).toBe(true)
    }
  })

  test("on a full last page the specimen line overlaps no body text", () => {
    let fullLastPages = 0
    for (const french of [false, true]) {
      for (let n = 0; n < 40 * 31; n++) {
        const lines = 1 + (n % 40)
        const noteLines = Math.floor(n / 40)
        const input = documentInput("invoice", lines, { french })
        const notes = Array.from({ length: noteLines }, (_, i) => `Note line ${i + 1}`).join("\n")
        const cmds = TEMPLATES.invoice({
          ...input,
          document: { ...input.document, notes },
          specimen: specimenTexts(),
        })
        const texts = textCmds(cmds)
        const last = pageCount(cmds) - 1
        const lowestBody = Math.min(
          ...texts.filter((t) => t.page === last && t.y > 60).map((t) => band(t)[0]),
        )
        if (lowestBody < 86) fullLastPages++
        for (const s of texts.filter((t) => t.text === EN || t.text === FR)) {
          const [lo, hi] = band(s)
          const hits = texts
            .filter((t) => t !== s && t.page === s.page)
            .filter((t) => {
              const [a, b] = band(t)
              return a < hi && b > lo
            })
            .map((t) => `${lines} lines, ${noteLines} notes, page ${t.page}: ${t.text}`)
          expect(hits).toEqual([])
        }
      }
    }
    // The sweep did reach last pages filled to the lowest line the body can take.
    expect(fullLastPages).toBeGreaterThan(0)
  })
})

describe("the host's specimen value", () => {
  test("a specimen value an app passes itself is replaced by the host's, and is absent outside a demo", () => {
    const appData = { title: "x", specimen: { en: "Not a specimen" } }
    expect(withSpecimen(appData, false)).toEqual({ title: "x" })
    expect(withSpecimen(appData, true)).toEqual({ title: "x", specimen: specimenTexts() })
    expect(withSpecimen({ title: "x" }, false)).toEqual({ title: "x" })
    expect(specimenTexts()).toMatchObject({ en: EN, fr: FR })
  })

  test("a CII invoice gets the specimen as its last header note, and other XML is untouched", () => {
    const xml = buildCii(fxDocument())
    const stamped = ciiWithSpecimenNote(xml, specimenNoteText())
    const header = stamped.slice(
      stamped.indexOf("<rsm:ExchangedDocument>"),
      stamped.indexOf("</rsm:ExchangedDocument>"),
    )
    expect(
      header.endsWith(
        `<ram:Content>${EN} / ${FR}</ram:Content><ram:SubjectCode>AAI</ram:SubjectCode></ram:IncludedNote>`,
      ),
    ).toBe(true)
    expect(
      stamped.replace(/<ram:IncludedNote><ram:Content>Specimen[\s\S]*?<\/ram:IncludedNote>/, ""),
    ).toBe(xml)
    expect(ciiWithSpecimenNote("<x/>", "y")).toBe("<x/>")
  })
})

/** A template that prints what it was handed under `specimen`. */
const ECHO_SOURCE = `
globalThis.renderTemplate = (data) => ([
  { op: "embedFont", ref: "f", standardFont: "Helvetica" },
  { op: "addPage", width: 400, height: 200 },
  { op: "drawText", page: 0, text: "specimen=" + (data && data.specimen ? data.specimen.en : "none"), x: 10, y: 100, size: 10, font: "f" },
]);
`

/** The name and text of every file embedded in a PDF, joined. */
async function embeddedText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict)
  const tree = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict)
  const list = tree?.lookupMaybe(PDFName.of("Names"), PDFArray)
  const out: string[] = []
  for (let i = 0; list && i + 1 < list.size(); i += 2) {
    const spec = list.lookup(i + 1, PDFDict)
    const stream = spec.lookup(PDFName.of("EF"), PDFDict).lookup(PDFName.of("F"))
    if (!(stream instanceof PDFRawStream)) continue
    out.push(String(list.lookup(i)), new TextDecoder().decode(decodePDFRawStream(stream).decode()))
  }
  return out.join("\n")
}

describe("rendering through the host", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
  }, 60_000)
  afterAll(async () => {
    await shutdownSandboxPool()
    await releaseTestLock()
  })

  test("a demo invoice's embedded invoice data says specimen, and only a demo render gets the host's specimen", async () => {
    PdfRegistryTestAccess.clear()
    const { id: orgId } = await createTestOrg()
    registerTemplate("invoicing", "invoicing:echo_v1", ECHO_SOURCE)
    const xml = new TextEncoder().encode(buildCii(fxDocument()))
    const render = () =>
      renderPdf(null, {
        orgId,
        callingAppId: "invoicing",
        template_kind: "invoicing:echo_v1",
        data: { specimen: { en: "app-made" } },
        pdfa: "3b",
        attachments: [
          { name: "factur-x.xml", mime: "text/xml", bytes: xml, afRelationship: "Data" },
        ],
      })

    const real = await getFileBytes(null, (await render()).file_id)
    expect(await extractPdfText(real)).toContain("specimen=none")
    const realXml = await embeddedText(real)
    expect(realXml).toContain("<rsm:ExchangedDocument>")
    expect(realXml).not.toContain("Specimen")

    await markDemoOrgForTest(orgId, visitorMarker(1))
    await invalidateDemoMarker(orgId)
    const demo = await getFileBytes(null, (await render()).file_id)
    const text = await extractPdfText(demo)
    expect(text).toContain(`specimen=${EN}`)
    expect(text).not.toContain("app-made")
    // A demo invoice's embedded invoice data says specimen.
    expect(await embeddedText(demo)).toContain(`<ram:Content>${EN} / ${FR}</ram:Content>`)
  }, 60_000)

  test("an invoice's data stored as a file says specimen only in a demo, and only for invoice data the app made", async () => {
    const { id: orgId } = await createTestOrg()
    const cii = new TextEncoder().encode(buildCii(fxDocument()))
    const other = new TextEncoder().encode("<note>Specimen?</note>")
    const store = (bytes: Uint8Array, mimeType = "text/xml", fromNetwork = false) =>
      storedBytesWithSpecimen(orgId, { mimeType, bytes, fromNetwork })

    // Outside a demo every file is stored as the app handed it.
    expect(await store(cii)).toEqual(cii)
    expect(await store(other)).toEqual(other)

    await markDemoOrgForTest(orgId, visitorMarker(1))
    await invalidateDemoMarker(orgId)
    const stamped = new TextDecoder().decode(await store(cii))
    expect(stamped).toBe(ciiWithSpecimenNote(buildCii(fxDocument()), specimenNoteText()))
    // Other XML, another kind of file and a file fetched from a provider are left alone.
    expect(await store(other)).toEqual(other)
    expect(await store(cii, "application/pdf")).toEqual(cii)
    expect(await store(cii, "text/xml", true)).toEqual(cii)
  }, 60_000)
})
