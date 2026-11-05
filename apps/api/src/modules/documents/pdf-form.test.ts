// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Uploaded AcroForm templates: intake (inspect + sanitize + dry run) and the
// fill + flatten that prints them.
//
// Fixtures are built in-test with pdf-lib, except one: pdf-lib cannot WRITE an
// encrypted PDF, so `__fixtures__/encrypted.pdf` is a committed binary. It is
// synthetic (a 300x200 page with one empty text field "name", no content), made
// with pdf-lib and then encrypted with pypdf 5.1.0:
//   PdfWriter(clone_from=PdfReader("plain.pdf"))
//     .encrypt(user_password="", owner_password="synthetic-owner", algorithm="AES-128")
// The EMPTY user password is the point: such a file opens in any viewer without
// a prompt, and pdf-lib would load it happily with `ignoreEncryption: true`, so
// only a loader that refuses encryption outright turns it away.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { crc32, deflateRawSync, deflateSync, inflateSync } from "node:zlib"
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  type PDFDocument as PDFDocumentType,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
} from "pdf-lib"
import { processAlive } from "../../lib/orphan-exit"
import { MERGE_MAX_OUTPUT_PAGES, MERGE_MAX_TOTAL_INPUT_BYTES } from "../pdf/merge"
import { extractPdfText } from "../pdf/pdf-text"
import {
  dryRunPdfForm,
  fillPdfForm,
  inspectPdfForm,
  listPdfFormFields,
  PDF_FORM_MAX_BYTES,
  PDF_FORM_MAX_INFLATED_BYTES,
  PDF_FORM_MAX_OBJECTS,
  PDF_FORM_MAX_PAGES,
  PdfFormError,
  PdfFormTestAccess,
  preparePdfFormTemplate,
  sanitizePdfForm,
} from "./pdf-form"
import { assertNoActiveContent } from "./pdf-form-core"

const FIXTURES = join(import.meta.dir, "__fixtures__")
const POLISH = "Łukawski"
const JAPANESE = "株式会社"

async function formPdf(
  build?: (doc: PDFDocumentType) => void | Promise<void>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage([595, 842])
  const form = doc.getForm()
  form
    .createTextField("customer.name")
    .addToPage(page, { x: 40, y: 760, width: 300, height: 24, borderWidth: 0 })
  const company = form.createTextField("customer.company")
  company.addToPage(page, { x: 40, y: 720, width: 300, height: 24 })
  form.createCheckBox("terms").addToPage(page, { x: 40, y: 680, width: 14, height: 14 })
  if (build) await build(doc)
  return doc.save({ useObjectStreams: false })
}

/** Decoded content streams of page 1, joined. */
function pageContent(doc: PDFDocumentType): string {
  const contents = doc.getPage(0).node.Contents()
  const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
  return parts
    .map((part) => {
      const stream = part instanceof PDFRef ? doc.context.lookup(part) : part
      if (!(stream instanceof PDFRawStream)) return ""
      const filter = stream.dict.get(PDFName.of("Filter"))?.toString()
      const raw = Buffer.from(stream.contents)
      return (filter === "/FlateDecode" ? inflateSync(raw) : raw).toString("latin1")
    })
    .join("\n")
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof PdfFormError) return err.code
    throw err
  }
  return "resolved"
}

/** Independent of the module's own scanner: every key name reachable anywhere. */
function allKeys(doc: PDFDocumentType): Set<string> {
  const keys = new Set<string>()
  const visit = (obj: PDFObject | undefined): void => {
    if (obj instanceof PDFStream) {
      visit(obj.dict)
    } else if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) {
        keys.add(k.asString())
        visit(v)
      }
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) visit(v)
    }
  }
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj)
  return keys
}

describe("inspectPdfForm refuses what it cannot safely print", () => {
  it("refuses an encrypted PDF (even one with an empty user password)", async () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, "encrypted.pdf")))
    // RED guard: the fixture IS loadable when encryption is ignored, so this
    // test fails if the loader ever passes ignoreEncryption.
    const lax = await PDFDocument.load(bytes, { ignoreEncryption: true })
    expect(lax.getForm().getFields().length).toBe(1)
    expect(await codeOf(inspectPdfForm(bytes))).toBe("encrypted")
  })

  it("refuses an XFA form", async () => {
    // Added on the raw AcroForm and saved without appearance updates: pdf-lib's
    // getForm() (which save() calls) deletes an XFA entry it finds.
    const doc = await PDFDocument.load(await formPdf(), { updateMetadata: false })
    const xfa = doc.context.register(doc.context.stream("<xdp:xdp/>"))
    doc.catalog.getAcroForm()?.dict.set(PDFName.of("XFA"), xfa)
    const bytes = await doc.save({ updateFieldAppearances: false, useObjectStreams: false })
    expect(Buffer.from(bytes).toString("latin1").includes("/XFA")).toBe(true)
    expect(await codeOf(inspectPdfForm(bytes))).toBe("xfa")
  })

  it("refuses a PDF without fields", async () => {
    const doc = await PDFDocument.create()
    doc.addPage()
    expect(await codeOf(inspectPdfForm(await doc.save()))).toBe("no_fields")
  })

  it("refuses bytes that are not a PDF", async () => {
    const bytes = new TextEncoder().encode("<html>%PDF-1.7</html>")
    expect(await codeOf(inspectPdfForm(bytes))).toBe("not_a_pdf")
  })

  it("lists the fields with their geometry", async () => {
    const bytes = await formPdf(async (doc) => {
      const f = doc.getForm().getTextField("customer.name")
      f.setMaxLength(40)
      f.acroField.dict.set(PDFName.of("TU"), PDFString.of("Customer name"))
      const dd = doc.getForm().createDropdown("incoterm")
      dd.addOptions(["DAP", "DDP"])
      dd.addToPage(doc.getPage(0), { x: 40, y: 640, width: 100, height: 20 })
    })
    const result = await inspectPdfForm(bytes)
    expect(result.pageCount).toBe(1)
    const name = result.fields.find((f) => f.name === "customer.name")
    expect(name).toMatchObject({
      type: "text",
      page: 0,
      maxLength: 40,
      tooltip: "Customer name",
      multiline: false,
    })
    expect(name?.rect).toMatchObject({ x: 40, y: 760, width: 300, height: 24 })
    expect(result.fields.find((f) => f.name === "terms")?.type).toBe("checkbox")
    expect(result.fields.find((f) => f.name === "incoterm")).toMatchObject({
      type: "dropdown",
      options: ["DAP", "DDP"],
    })
  })
})

describe("sanitizePdfForm strips active content", () => {
  it("removes OpenAction JS, widget /AA, document JS, embedded files and risky actions", async () => {
    const bytes = await formPdf(async (doc) => {
      const ctx = doc.context
      const js = (code: string) =>
        ctx.obj({ Type: "Action", S: "JavaScript", JS: PDFString.of(code) })
      doc.catalog.set(PDFName.of("OpenAction"), ctx.register(js("app.alert('open')")))
      doc.catalog.set(PDFName.of("AA"), ctx.obj({ WC: js("app.alert('close')") }))
      const widget = doc.getForm().getTextField("customer.name").acroField.getWidgets()[0]
      widget?.dict.set(PDFName.of("AA"), ctx.obj({ K: js("app.alert('key')") }))
      const names = ctx.obj({
        JavaScript: ctx.obj({ Names: [PDFString.of("doc"), ctx.register(js("app.alert('doc')"))] }),
        EmbeddedFiles: ctx.obj({
          Names: [
            PDFString.of("payload.exe"),
            ctx.obj({ Type: "Filespec", F: PDFString.of("payload.exe") }),
          ],
        }),
      })
      doc.catalog.set(PDFName.of("Names"), names)
      const btn = doc.getForm().createButton("send")
      btn.addToPage("Send", doc.getPage(0), { x: 40, y: 600, width: 80, height: 20 })
      btn.acroField
        .getWidgets()[0]
        ?.dict.set(
          PDFName.of("A"),
          ctx.obj({ S: "SubmitForm", F: PDFString.of("https://collector.invalid/") }),
        )
      const link = ctx.register(
        ctx.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [40, 500, 140, 520],
          A: ctx.obj({
            S: "URI",
            URI: PDFString.of("https://example.invalid/"),
            Next: ctx.obj({ S: "Launch", F: PDFString.of("calc.exe") }),
          }),
        }),
      )
      doc.getPage(0).node.addAnnot(link)
    })
    // Sanity: the fixture really carries everything we want gone.
    const before = Buffer.from(bytes).toString("latin1")
    for (const needle of [
      "/OpenAction",
      "/AA",
      "/JS",
      "/EmbeddedFiles",
      "/SubmitForm",
      "/Launch",
    ]) {
      expect(before).toContain(needle)
    }

    const clean = await sanitizePdfForm(bytes)
    const raw = Buffer.from(clean).toString("latin1")
    for (const needle of [
      "/OpenAction",
      "/AA",
      "/JS",
      "/JavaScript",
      "/EmbeddedFiles",
      "/SubmitForm",
      "/Launch",
      "app.alert",
      "payload.exe",
      "calc.exe",
    ]) {
      expect(raw).not.toContain(needle)
    }
    const reloaded = await PDFDocument.load(clean)
    const keys = allKeys(reloaded)
    for (const k of ["/OpenAction", "/AA", "/JS", "/JavaScript", "/EmbeddedFiles"]) {
      expect(keys.has(k)).toBe(false)
    }
    // The form itself survives: the fields are what the template is for.
    expect(reloaded.getForm().getFields().length).toBe(4)
    // The harmless URI action survives; only its Launch continuation goes.
    expect(raw).toContain("example.invalid")
  })

  it("preparePdfFormTemplate returns sanitized bytes plus the field list", async () => {
    const bytes = await formPdf((doc) => {
      doc.catalog.set(
        PDFName.of("OpenAction"),
        doc.context.obj({ S: "JavaScript", JS: PDFString.of("x()") }),
      )
    })
    const prepared = await preparePdfFormTemplate(bytes)
    expect(Buffer.from(prepared.bytes).toString("latin1")).not.toContain("/OpenAction")
    expect(prepared.fields.map((f) => f.name).sort()).toEqual([
      "customer.company",
      "customer.name",
      "terms",
    ])
    expect(await listPdfFormFields(prepared.bytes)).toHaveLength(3)
  })
})

describe("fillPdfForm", () => {
  it("proves the RED state: base-14 appearances throw on the same values", async () => {
    const doc = await PDFDocument.load(await formPdf())
    const form = doc.getForm()
    form.getTextField("customer.name").setText(`Igor ${POLISH}`)
    const helv = await doc.embedFont(StandardFonts.Helvetica)
    expect(() => form.updateFieldAppearances(helv)).toThrow()
  })

  it("fills Polish and Japanese names without a WinAnsi throw, then flattens", async () => {
    const result = await fillPdfForm(await formPdf(), {
      "customer.name": `Igor ${POLISH}`,
      "customer.company": `${JAPANESE}アイシン`,
      terms: true,
    })
    const text = await extractPdfText(result.bytes)
    expect(text).toContain(POLISH)
    expect(text).toContain(JAPANESE)
    const out = await PDFDocument.load(result.bytes)
    expect(out.getForm().getFields()).toHaveLength(0)
  })

  it("prints an unfilled field as a grey placeholder and keeps its value empty", async () => {
    const result = await fillPdfForm(
      await formPdf(),
      { "customer.name": "Ada Lovelace" },
      {},
      { placeholders: { "customer.company": "Company (missing)" } },
    )
    expect(result.values["customer.company"]).toBe("")
    expect(result.blank).toContain("customer.company")
    expect(result.blank).not.toContain("customer.name")
    const text = await extractPdfText(result.bytes)
    expect(text).toContain("Ada Lovelace")
    expect(text).toContain("Company (missing)")
    const out = await PDFDocument.load(result.bytes)
    expect(out.getForm().getFields()).toHaveLength(0)
    // The placeholder is drawn in grey 0.55, not in the field's ink colour.
    expect(pageContent(out)).toContain("0.55 0.55 0.55 rg")
  })

  it("falls back to the tooltip, then the field label, for the placeholder", async () => {
    const bytes = await formPdf((doc) => {
      doc
        .getForm()
        .getTextField("customer.company")
        .acroField.dict.set(PDFName.of("TU"), PDFString.of("Company name"))
    })
    const result = await fillPdfForm(bytes, {})
    const text = await extractPdfText(result.bytes)
    expect(text).toContain("Company name")
    expect(text).toContain("name") // label of customer.name
  })

  it("refuses a value longer than the field's max length rather than truncating", async () => {
    const bytes = await formPdf((doc) => {
      doc.getForm().getTextField("customer.name").setMaxLength(3)
    })
    expect(await codeOf(fillPdfForm(bytes, { "customer.name": "Lovelace" }))).toBe("value_too_long")
  })

  it("draws a mapped image at the widget rect of a signature-like field", async () => {
    // 1x1 opaque PNG.
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ),
    )
    const result = await fillPdfForm(
      await formPdf(),
      { "customer.name": "Ada" },
      { "customer.company": { bytes: png, type: "png" } },
    )
    expect(result.blank).not.toContain("customer.company")
    const out = await PDFDocument.load(result.bytes)
    const resources = out.getPage(0).node.Resources()
    const xobjects = resources?.lookup(PDFName.of("XObject"), PDFDict)
    const kinds = (xobjects?.entries() ?? []).map(([, ref]) =>
      ref instanceof PDFRef
        ? out.context.lookup(ref, PDFStream).dict.get(PDFName.of("Subtype"))?.toString()
        : undefined,
    )
    expect(kinds).toContain("/Image")
  })
})

/**
 * Every indirect reference reachable from the trailer of `bytes`, with the ones
 * that resolve to no object. pdf-lib parses by scanning object headers, not by
 * trusting the xref, so a ref it cannot look up is absent from the file: a
 * strict viewer reports it as a broken cross-reference table and repairs it.
 */
async function danglingRefs(bytes: Uint8Array): Promise<{ seen: number; missing: string[] }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const ctx = doc.context
  const seen = new Set<PDFRef>()
  const missing: string[] = []
  const stack: Array<PDFObject | undefined> = [ctx.trailerInfo.Root, ctx.trailerInfo.Info]
  while (stack.length > 0) {
    const obj = stack.pop()
    if (obj instanceof PDFRef) {
      if (seen.has(obj)) continue
      seen.add(obj)
      const target = ctx.lookup(obj)
      if (target === undefined) missing.push(obj.toString())
      else stack.push(target)
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict)
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v)
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray())
    }
  }
  return { seen: seen.size, missing }
}

/** Three text fields, a checkbox and a two-option radio group over two pages. */
async function multiWidgetFormPdf(): Promise<Uint8Array> {
  return formPdf(async (doc) => {
    const form = doc.getForm()
    const second = doc.addPage([595, 842])
    form
      .createTextField("order.reference")
      .addToPage(second, { x: 40, y: 760, width: 300, height: 24 })
    const radio = form.createRadioGroup("delivery")
    radio.addOptionToPage("pickup", second, { x: 40, y: 700, width: 14, height: 14 })
    radio.addOptionToPage("courier", second, { x: 80, y: 700, width: 14, height: 14 })
  })
}

describe("a flattened form leaves no dangling reference", () => {
  it("removes every flattened widget from the page /Annots of a filled form", async () => {
    const result = await fillPdfForm(await multiWidgetFormPdf(), {
      "customer.name": "Ada Lovelace",
      terms: true,
      delivery: "courier",
    })
    const { seen, missing } = await danglingRefs(result.bytes)
    expect(seen).toBeGreaterThan(5)
    expect(missing).toEqual([])
    const out = await PDFDocument.load(result.bytes)
    for (const page of out.getPages()) expect(page.node.Annots()?.size() ?? 0).toBe(0)
  })

  it("leaves no dangling reference in the upload dry run either", async () => {
    const { missing } = await danglingRefs(await dryRunPdfForm(await multiWidgetFormPdf()))
    expect(missing).toEqual([])
  })

  it("keeps a non-widget annotation (a link) on the page", async () => {
    const bytes = await formPdf((doc) => {
      const page = doc.getPage(0)
      const link = doc.context.register(
        doc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [40, 600, 200, 620],
          A: { S: "URI", URI: PDFString.of("https://example.com") },
        }),
      )
      page.node.addAnnot(link)
    })
    const result = await fillPdfForm(bytes, { "customer.name": "Ada" })
    expect((await danglingRefs(result.bytes)).missing).toEqual([])
    const out = await PDFDocument.load(result.bytes)
    expect(out.getPage(0).node.Annots()?.size()).toBe(1)
  })
})

describe("dryRunPdfForm", () => {
  it("fills every text field with a mixed-script sample and flattens to zero fields", async () => {
    const out = await dryRunPdfForm(await formPdf())
    const doc = await PDFDocument.load(out)
    expect(doc.getForm().getFields()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Hostile structure: every case below hangs, exhausts memory or leaks active
// content through a loader that only races a promise and trusts pdf-lib.
// ---------------------------------------------------------------------------

/** Insert raw object text just before the classic xref table of a pdf-lib save. */
function insertRaw(bytes: Uint8Array, ...parts: Array<string | Uint8Array>): Uint8Array {
  const buf = Buffer.from(bytes)
  const at = buf.lastIndexOf("\nxref\n")
  if (at < 0) throw new Error("fixture has no classic xref table")
  const middle = parts.map((p) =>
    typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p),
  )
  return new Uint8Array(Buffer.concat([buf.subarray(0, at + 1), ...middle, buf.subarray(at + 1)]))
}

/**
 * A page tree whose every node lists the SAME child twice, `depth` levels deep:
 * a few hundred bytes that a recursive walk visits 2^depth times.
 */
async function pageTreeBomb(depth: number): Promise<Uint8Array> {
  const doc = await PDFDocument.load(await formPdf(), { updateMetadata: false })
  const ctx = doc.context
  let node = doc.catalog.get(PDFName.of("Pages"))
  if (!(node instanceof PDFRef)) throw new Error("fixture page root is not a ref")
  for (let level = 1; level <= depth; level++) {
    node = ctx.register(ctx.obj({ Type: "Pages", Kids: [node, node], Count: 2 ** level }))
  }
  doc.catalog.set(PDFName.of("Pages"), node)
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false })
}

/** A real (valid) grayscale PNG of the given size. */
function grayPng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "latin1"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // grayscale
  const raw = Buffer.alloc((width + 1) * height) // filter byte 0 + zero pixels per row
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  )
}

describe("hostile structure is refused in the isolate, never in the server", () => {
  it(
    "refuses a page tree listing one child twice per level within 5 s and stays alive",
    async () => {
      const bomb = await pageTreeBomb(30)
      const started = Date.now()
      expect(await codeOf(inspectPdfForm(bomb))).toBe("too_complex")
      expect(Date.now() - started).toBeLessThan(5_000)
      // The same process still serves the next upload.
      expect((await inspectPdfForm(await formPdf())).fields).toHaveLength(3)
    },
    { timeout: 20_000 },
  )

  it(
    "hard-kills the isolate when synchronous pdf-lib work outlives the deadline",
    async () => {
      const bomb = await pageTreeBomb(30)
      // Pre-checks off: the only thing between pdf-lib's 2^30-step traversal and
      // a wedged server is the isolate's kill.
      PdfFormTestAccess.setLimits({ timeoutMs: 1_500, structureWalk: false })
      try {
        const started = Date.now()
        expect(await codeOf(inspectPdfForm(bomb))).toBe("parse_timeout")
        expect(Date.now() - started).toBeLessThan(5_000)
        const pid = PdfFormTestAccess.lastPid()
        expect(pid).toBeGreaterThan(0)
        expect(processAlive(pid ?? 0)).toBe(false)
      } finally {
        PdfFormTestAccess.setLimits({})
      }
      expect((await inspectPdfForm(await formPdf())).fields).toHaveLength(3)
    },
    { timeout: 20_000 },
  )

  it(
    "the kernel's CPU limit kills an isolate stuck in synchronous work when no parent polls it",
    async () => {
      const bomb = await pageTreeBomb(30)
      // No wall-clock timer and no RSS poll: what a dead or stalled server
      // leaves behind. Only the rlimit set at spawn stands.
      PdfFormTestAccess.setLimits({ parentKill: false, cpuSeconds: 1, structureWalk: false })
      try {
        const started = Date.now()
        expect(await codeOf(inspectPdfForm(bomb))).toBe("parse_timeout")
        expect(Date.now() - started).toBeLessThan(8_000)
        expect(processAlive(PdfFormTestAccess.lastPid() ?? 0)).toBe(false)
      } finally {
        PdfFormTestAccess.setLimits({})
      }
    },
    { timeout: 30_000 },
  )

  it("refuses a page tree whose node lists itself (a cycle)", async () => {
    const doc = await PDFDocument.load(await formPdf(), { updateMetadata: false })
    const ctx = doc.context
    const root = doc.catalog.get(PDFName.of("Pages"))
    if (!(root instanceof PDFRef)) throw new Error("fixture page root is not a ref")
    ctx.lookup(root, PDFDict).lookup(PDFName.of("Kids"), PDFArray).push(root)
    const bytes = await doc.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
    })
    expect(await codeOf(inspectPdfForm(bytes))).toBe("too_complex")
  })

  it("refuses a field tree listing one kid twice", async () => {
    const doc = await PDFDocument.load(await formPdf(), { updateMetadata: false })
    const ctx = doc.context
    const fields = doc.catalog.getAcroForm()?.dict.lookup(PDFName.of("Fields"), PDFArray)
    const first = fields?.get(0)
    if (!(first instanceof PDFRef)) throw new Error("fixture field is not a ref")
    let node: PDFRef = first
    for (let level = 0; level < 30; level++) {
      node = ctx.register(ctx.obj({ T: PDFString.of(`g${level}`), Kids: [node, node] }))
    }
    fields?.set(0, node)
    const bytes = await doc.save({
      useObjectStreams: false,
      addDefaultPage: false,
      updateFieldAppearances: false,
    })
    expect(await codeOf(inspectPdfForm(bytes))).toBe("too_complex")
  })

  it("refuses a deflate bomb in an object stream by the decompressed-byte budget", async () => {
    const zeros = deflateSync(Buffer.alloc(PDF_FORM_MAX_INFLATED_BYTES + 1024 * 1024))
    const bytes = insertRaw(
      await formPdf(),
      `90 0 obj\n<< /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode /Length ${zeros.length} >>\nstream\n`,
      zeros,
      "\nendstream\nendobj\n",
    )
    expect(await codeOf(inspectPdfForm(bytes))).toBe("too_complex")
  })

  it("refuses more indirect objects than the cap before pdf-lib parses them", async () => {
    const body = "1 0 obj\nnull\nendobj\n".repeat(PDF_FORM_MAX_OBJECTS + 1)
    const bytes = new TextEncoder().encode(`%PDF-1.7\n${body}trailer\n<< >>\n%%EOF\n`)
    expect(await codeOf(inspectPdfForm(bytes))).toBe("too_complex")
  })

  it("refuses an unparseable object a widget action points at (never writes it back)", async () => {
    let ref = ""
    const base = await formPdf((doc) => {
      const target = doc.context.nextRef()
      ref = `${target.objectNumber} 0 obj`
      doc.getForm().getTextField("customer.name").acroField.getWidgets()[0]?.dict.set(KEY_A, target)
    })
    // The stray ")" makes the dict unparseable; a lax loader keeps the object
    // as raw bytes, and so would write the JavaScript back untouched.
    const bytes = insertRaw(base, `${ref}\n<< /S /JavaScript /JS (app.alert(1)) /K ) >>\nendobj\n`)
    const lax = await PDFDocument.load(bytes, { throwOnInvalidObject: false })
    const kept = Buffer.from(await lax.save({ useObjectStreams: false })).toString("latin1")
    expect(kept).toContain("app.alert(1)")
    expect(await codeOf(sanitizePdfForm(bytes))).toBe("parse_failed")
  })
})

const KEY_A = PDFName.of("A")

/** A link annotation on page 1 carrying `action`. */
/** A deflate bomb: a few KB that inflate past the whole decompression budget. */
function flateBomb(): Buffer {
  return deflateSync(Buffer.alloc(PDF_FORM_MAX_INFLATED_BYTES + 1024 * 1024))
}

/** RunLength data (a filter the pre-scan cannot budget): 128 KB of "A" from 2 KB. */
function runLength(): Buffer {
  const runs = new Array<number[]>(1024).fill([0x81, 0x41]).flat()
  return Buffer.from([...runs, 0x80])
}

/** One raw stream object (number 90) inserted before the xref table. */
async function withStream(
  head: string,
  dict: string,
  data: Uint8Array,
  eol = "\n",
): Promise<Uint8Array> {
  return insertRaw(
    await formPdf(),
    `${head}\n<< ${dict} /Length ${data.length} >>\nstream${eol}`,
    data,
    "\nendstream\nendobj\n",
  )
}

describe("the pre-scan reads names, strings and keywords as pdf-lib does", () => {
  it("refuses a non-Flate object or xref stream whose names hide behind #xx escapes", async () => {
    const data = runLength()
    for (const dict of [
      "/Type /Obj#53tm /N 1 /First 5 /Filter /RunLengthDecode",
      "/T#79pe /ObjStm /N 1 /First 5 /Filter /LZWDecode",
      "/Type /XR#65f /W [1 1 1] /Size 1 /Filter /RunLengthDecode",
      "/Type /ObjStm /N 1 /First 5 /F#69lter /RunLengthDecode",
    ]) {
      expect(await codeOf(inspectPdfForm(await withStream("90 0 obj", dict, data)))).toBe(
        "too_complex",
      )
    }
  })

  it("refuses an object stream whose /Type or /Filter is an indirect reference", async () => {
    const data = runLength()
    for (const dict of [
      "/Type 1 0 R /N 1 /First 5 /Filter /RunLengthDecode",
      "/Type /ObjStm /N 1 /First 5 /Filter 1 0 R",
      "/Type /ObjStm /N 1 /First 5 /Filter [1 0 R]",
    ]) {
      expect(await codeOf(inspectPdfForm(await withStream("90 0 obj", dict, data)))).toBe(
        "too_complex",
      )
    }
  })

  it("does not stop at an endobj inside a string or a comment of the dict", async () => {
    const bomb = flateBomb()
    for (const dict of [
      "/Note (endobj) /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode",
      "/Note (a \\) (endobj) b) /Type /ObjStm /N 1 /First 5 /Filter /FlateDecode",
      "/Type /ObjStm %endobj\n/N 1 /First 5 /Filter /FlateDecode",
    ]) {
      expect(await codeOf(inspectPdfForm(await withStream("90 0 obj", dict, bomb)))).toBe(
        "too_complex",
      )
    }
  })

  it("finds object headers and stream keywords in every spelling pdf-lib accepts", async () => {
    const bomb = flateBomb()
    const dict = "/Type /ObjStm /N 1 /First 5 /Filter /FlateDecode"
    for (const [head, eol] of [
      ["90 0 %c\nobj", "\n"],
      ["90 0obj", "\n"],
      ["90 0 obj", " \r\n"],
    ] as const) {
      expect(await codeOf(inspectPdfForm(await withStream(head, dict, bomb, eol)))).toBe(
        "too_complex",
      )
    }
  })

  it("budgets a Flate stream to its declared length, past an early endstream in its data", async () => {
    // A stored (uncompressed) deflate block carrying the text "endstream", then
    // the bomb: a scan that cuts at the first endstream inflates only the text.
    const text = Buffer.from("\nendstream\nendobj\n", "latin1")
    const stored = Buffer.alloc(5)
    stored[0] = 0 // not final, stored
    stored.writeUInt16LE(text.length, 1)
    stored.writeUInt16LE(~text.length & 0xffff, 3)
    const data = Buffer.concat([
      Buffer.from([0x78, 0x01]),
      stored,
      text,
      deflateRawSync(Buffer.alloc(PDF_FORM_MAX_INFLATED_BYTES + 1024 * 1024)),
      Buffer.alloc(4),
    ])
    const dict = "/Type /ObjStm /N 1 /First 5 /Filter /FlateDecode"
    expect(await codeOf(inspectPdfForm(await withStream("90 0 obj", dict, data)))).toBe(
      "too_complex",
    )
  })
})

function addLink(doc: PDFDocumentType, action: PDFObject): void {
  const ctx = doc.context
  doc
    .getPage(0)
    .node.addAnnot(
      ctx.register(
        ctx.obj({ Type: "Annot", Subtype: "Link", Rect: [40, 500, 140, 520], A: action }),
      ),
    )
}

describe("actions are allowlisted", () => {
  it("removes an action whose /S is an indirect reference to /Launch", async () => {
    const bytes = await formPdf((doc) => {
      const ctx = doc.context
      addLink(doc, ctx.obj({ S: ctx.register(PDFName.of("Launch")), F: PDFString.of("calc.exe") }))
    })
    const raw = Buffer.from(await sanitizePdfForm(bytes)).toString("latin1")
    expect(raw).not.toContain("calc.exe")
    expect(raw).not.toContain("/Launch")
  })

  it("keeps GoTo, standard Named and http(s)/mailto URI; strips everything else", async () => {
    const bytes = await formPdf((doc) => {
      const ctx = doc.context
      const page = doc.getPage(0).ref
      addLink(doc, ctx.obj({ S: "GoTo", D: [page, PDFName.of("Fit")] }))
      addLink(doc, ctx.obj({ S: "Named", N: "NextPage" }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of("https://kept.invalid/") }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of("mailto:kept@example.invalid") }))
      addLink(doc, ctx.obj({ S: "Thread", D: 0 }))
      addLink(doc, ctx.obj({ S: "Movie", T: PDFString.of("movie-gone") }))
      addLink(doc, ctx.obj({ S: "Sound", Sound: PDFString.of("sound-gone") }))
      addLink(doc, ctx.obj({ S: "Hide", T: PDFString.of("hide-gone") }))
      addLink(doc, ctx.obj({ S: "SetOCGState", State: [PDFName.of("OFF")] }))
      addLink(doc, ctx.obj({ S: "Named", N: "SaveAs" }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of("java\tscript:alert('tab')") }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of(" JaVaScRiPt:alert('case')") }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of("vbscript:msgbox('vb')") }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of("data:text/html,data-gone") }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of("file:///etc/file-gone") }))
      addLink(doc, ctx.obj({ S: "URI", URI: PDFString.of("\\\\unc-host\\share") }))
      addLink(
        doc,
        ctx.obj({
          S: "GoTo",
          D: [page, PDFName.of("Fit")],
          Next: [ctx.obj({ S: "Thread", D: 1 }), ctx.obj({ S: "Named", N: "PrevPage" })],
        }),
      )
      addLink(doc, ctx.obj({ S: 7 }))
    })
    const clean = await sanitizePdfForm(bytes)
    const raw = Buffer.from(clean).toString("latin1")
    for (const gone of [
      "/Thread",
      "/Movie",
      "/Sound",
      "/Hide",
      "/SetOCGState",
      "/SaveAs",
      "script:",
      "ScRiPt",
      "vbscript",
      "data-gone",
      "file-gone",
      "unc-host",
    ]) {
      expect(raw).not.toContain(gone)
    }
    for (const kept of [
      "kept.invalid",
      "kept@example.invalid",
      "/NextPage",
      "/PrevPage",
      "/GoTo",
    ]) {
      expect(raw).toContain(kept)
    }
  })
})

describe("fill inputs are bounded", () => {
  it("refuses an image wider than 4096 px before embedding it", async () => {
    const result = codeOf(
      fillPdfForm(
        await formPdf(),
        {},
        { "customer.company": { bytes: grayPng(5_000, 1), type: "png" } },
      ),
    )
    expect(await result).toBe("image_invalid")
  })

  it("still embeds an image at the size cap", async () => {
    const result = await fillPdfForm(
      await formPdf(),
      {},
      { "customer.company": { bytes: grayPng(4_096, 1), type: "png" } },
    )
    expect(result.blank).not.toContain("customer.company")
  })

  it("refuses a text value over 10,000 characters when the field has no max length", async () => {
    const code = await codeOf(fillPdfForm(await formPdf(), { "customer.name": "x".repeat(10_001) }))
    expect(code).toBe("value_too_long")
  })
})

describe("the post-save re-scan", () => {
  it("refuses bytes that still carry active content (sanitize_failed)", async () => {
    const dirty = await formPdf((doc) => {
      doc.catalog.set(
        PDFName.of("OpenAction"),
        doc.context.obj({ S: "JavaScript", JS: PDFString.of("x()") }),
      )
    })
    expect(await codeOf(assertNoActiveContent(dirty))).toBe("sanitize_failed")
    expect(await codeOf(assertNoActiveContent(await formPdf()))).toBe("resolved")
  })

  it("keeps the upload caps equal to the merge caps", () => {
    expect(PDF_FORM_MAX_BYTES).toBe(MERGE_MAX_TOTAL_INPUT_BYTES)
    expect(PDF_FORM_MAX_PAGES).toBe(MERGE_MAX_OUTPUT_PAGES)
  })
})
