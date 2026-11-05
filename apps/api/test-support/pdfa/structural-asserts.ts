// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Own structural asserts for a Factur-X / PDF/A-3B file — the clause families the oxidize-pdf
// smoke check does not cover (embedded-file rules, Info/XMP sync, trailer ID, uncompressed XMP,
// ICC class) plus the Factur-X container rules. Test-only. Each assert has a mutation in
// `src/modules/pdf/pdfa/pdfa-conformance.test.ts` that turns it red.

import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from "pdf-lib"

export interface AssertResult {
  id: string
  ok: boolean
  detail: string
}

export interface ExpectedAttachment {
  name: string
  mime: string
  afRelationship: string
}

export interface ExpectedXmpExtension {
  namespaceUri: string
  prefix: string
  values: Record<string, string>
}

export interface StructuralExpectations {
  attachments: ExpectedAttachment[]
  xmpExtensions: ExpectedXmpExtension[]
}

export const STRUCTURAL_ASSERT_IDS = [
  "header-binary-comment",
  "embedded-file-names",
  "embedded-file-subtype",
  "embedded-file-moddate",
  "af-relationship",
  "catalog-af",
  "xmp-uncompressed",
  "xmp-pdfaid",
  "xmp-extension-schema",
  "xmp-extension-values",
  "info-xmp-sync",
  "output-intent-icc",
  "no-cmyk-images",
  "fonts-embedded",
  "no-encryption",
  "no-javascript",
  "trailer-id",
] as const

function deref(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o
}

function text(o: PDFObject | undefined): string | null {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText()
  return null
}

function nameOf(o: PDFObject | undefined): string | null {
  return o instanceof PDFName ? o.decodeText() : null
}

function streamBytes(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode()
  return (s as unknown as { getContents(): Uint8Array }).getContents()
}

function pdfDateToIso(d: string | null): string | null {
  const m = d
    ? /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}'?\d{2}'?)?/.exec(d)
    : null
  if (!m) return null
  const tz =
    !m[7] || m[7] === "Z" ? "Z" : `${m[7].slice(0, 3)}:${m[7].replace(/'/g, "").slice(3, 5)}`
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`).toISOString().slice(0, 19)
}

function xmpIso(v: string | null): string | null {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 19)
}

function tag(xmp: string, qname: string): string | null {
  const m = new RegExp(`<${qname}>([\\s\\S]*?)</${qname}>`).exec(xmp)
  return m ? (m[1] ?? "").trim() : null
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
}

interface FileSpec {
  dict: PDFDict
  ref: PDFRef | null
}

function embeddedFileSpecs(doc: PDFDocument): FileSpec[] {
  const names = deref(doc, doc.catalog.get(PDFName.of("Names")))
  if (!(names instanceof PDFDict)) return []
  const ef = deref(doc, names.get(PDFName.of("EmbeddedFiles")))
  if (!(ef instanceof PDFDict)) return []
  const out: FileSpec[] = []
  const walk = (node: PDFDict) => {
    const arr = deref(doc, node.get(PDFName.of("Names")))
    if (arr instanceof PDFArray) {
      for (let i = 1; i < arr.size(); i += 2) {
        const raw = arr.get(i)
        const d = deref(doc, raw)
        if (d instanceof PDFDict) out.push({ dict: d, ref: raw instanceof PDFRef ? raw : null })
      }
    }
    const kids = deref(doc, node.get(PDFName.of("Kids")))
    if (kids instanceof PDFArray)
      for (const k of kids.asArray()) {
        const kd = deref(doc, k)
        if (kd instanceof PDFDict) walk(kd)
      }
  }
  walk(ef)
  return out
}

export async function structuralAsserts(
  bytes: Uint8Array,
  expected: StructuralExpectations,
): Promise<AssertResult[]> {
  const results: AssertResult[] = []
  const put = (id: string, ok: boolean, detail = "") => results.push({ id, ok, detail })

  // Binary comment: the second line starts with % and four bytes > 127.
  const nl = bytes.indexOf(0x0a)
  const second = bytes.slice(nl + 1, nl + 6)
  put(
    "header-binary-comment",
    Buffer.from(bytes.slice(0, 5)).toString("latin1") === "%PDF-" &&
      second[0] === 0x25 &&
      [...second.slice(1)].every((b) => b > 127),
  )

  const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true })
  const ctx = doc.context

  // ── Embedded files / associated files ──
  const specs = embeddedFileSpecs(doc)
  const af = deref(doc, doc.catalog.get(PDFName.of("AF")))
  const afRefs =
    af instanceof PDFArray ? af.asArray().map((x) => (x instanceof PDFRef ? x.toString() : "")) : []
  let namesOk = expected.attachments.length > 0
  let subtypeOk = expected.attachments.length > 0
  let modOk = expected.attachments.length > 0
  let relOk = expected.attachments.length > 0
  let afOk = expected.attachments.length > 0
  const notes: string[] = []
  for (const want of expected.attachments) {
    const spec = specs.find(
      (s) =>
        text(s.dict.get(PDFName.of("F"))) === want.name ||
        text(s.dict.get(PDFName.of("UF"))) === want.name,
    )
    if (!spec) {
      namesOk = subtypeOk = modOk = relOk = afOk = false
      notes.push(`no file spec for ${want.name}`)
      continue
    }
    if (
      text(spec.dict.get(PDFName.of("F"))) !== want.name ||
      text(spec.dict.get(PDFName.of("UF"))) !== want.name
    )
      namesOk = false
    if (nameOf(spec.dict.get(PDFName.of("AFRelationship"))) !== want.afRelationship) relOk = false
    if (!spec.ref || !afRefs.includes(spec.ref.toString())) afOk = false
    const efDict = deref(doc, spec.dict.get(PDFName.of("EF")))
    const stream = efDict instanceof PDFDict ? deref(doc, efDict.get(PDFName.of("F"))) : undefined
    if (!(stream instanceof PDFStream)) {
      subtypeOk = modOk = false
      continue
    }
    if (nameOf(stream.dict.get(PDFName.of("Subtype"))) !== want.mime) subtypeOk = false
    const params = deref(doc, stream.dict.get(PDFName.of("Params")))
    if (!(params instanceof PDFDict) || !pdfDateToIso(text(params.get(PDFName.of("ModDate")))))
      modOk = false
  }
  put("embedded-file-names", namesOk, notes.join("; "))
  put("embedded-file-subtype", subtypeOk)
  put("embedded-file-moddate", modOk)
  put("af-relationship", relOk)
  put("catalog-af", afOk)

  // ── XMP ──
  const metaRef = doc.catalog.get(PDFName.of("Metadata"))
  const meta = deref(doc, metaRef)
  let xmp = ""
  if (meta instanceof PDFStream) {
    const uncompressed =
      nameOf(meta.dict.get(PDFName.of("Type"))) === "Metadata" &&
      nameOf(meta.dict.get(PDFName.of("Subtype"))) === "XML" &&
      meta.dict.get(PDFName.of("Filter")) === undefined
    put("xmp-uncompressed", uncompressed)
    xmp = new TextDecoder().decode(streamBytes(meta))
  } else {
    put("xmp-uncompressed", false, "no metadata stream")
  }
  put("xmp-pdfaid", tag(xmp, "pdfaid:part") === "3" && tag(xmp, "pdfaid:conformance") === "B")
  let schemaOk = expected.xmpExtensions.length > 0
  let valuesOk = expected.xmpExtensions.length > 0
  for (const e of expected.xmpExtensions) {
    const declared = new RegExp(
      `<pdfaSchema:namespaceURI>${e.namespaceUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</pdfaSchema:namespaceURI>\\s*<pdfaSchema:prefix>${e.prefix}</pdfaSchema:prefix>([\\s\\S]*?)</pdfaSchema:property>`,
    ).exec(xmp)
    const props = declared
      ? [...(declared[1] ?? "").matchAll(/<pdfaProperty:name>([^<]+)<\/pdfaProperty:name>/g)].map(
          (m) => m[1],
        )
      : []
    for (const [k, v] of Object.entries(e.values)) {
      if (!props.includes(k)) schemaOk = false
      if (
        !new RegExp(
          `xmlns:${e.prefix}="${e.namespaceUri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
        ).test(xmp)
      )
        valuesOk = false
      const got = tag(xmp, `${e.prefix}:${k}`)
      if (got == null || unescapeXml(got) !== v) valuesOk = false
    }
  }
  put("xmp-extension-schema", schemaOk)
  put("xmp-extension-values", valuesOk)

  // Info ↔ XMP
  const info = deref(doc, ctx.trailerInfo.Info as PDFObject | undefined)
  const infoText = (k: string) => (info instanceof PDFDict ? text(info.get(PDFName.of(k))) : null)
  const titleXmp = /<dc:title>\s*<rdf:Alt>\s*<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(xmp)?.[1]
  const sync = [
    ["Producer", infoText("Producer"), tag(xmp, "pdf:Producer")],
    ["Title", infoText("Title"), titleXmp ?? null],
    ["CreationDate", pdfDateToIso(infoText("CreationDate")), xmpIso(tag(xmp, "xmp:CreateDate"))],
    ["ModDate", pdfDateToIso(infoText("ModDate")), xmpIso(tag(xmp, "xmp:ModifyDate"))],
  ] as const
  const mismatches = sync.filter(([, a, b]) => (a ?? null) !== (b == null ? null : unescapeXml(b)))
  put(
    "info-xmp-sync",
    mismatches.length === 0 && pdfDateToIso(infoText("CreationDate")) !== null,
    mismatches.map(([k, a, b]) => `${k}: info=${a} xmp=${b}`).join("; "),
  )

  // OutputIntent with an RGB display/printer ICC profile.
  const intents = deref(doc, doc.catalog.get(PDFName.of("OutputIntents")))
  let iccOk = false
  if (intents instanceof PDFArray) {
    for (const it of intents.asArray()) {
      const d = deref(doc, it)
      if (!(d instanceof PDFDict) || nameOf(d.get(PDFName.of("S"))) !== "GTS_PDFA1") continue
      const prof = deref(doc, d.get(PDFName.of("DestOutputProfile")))
      if (!(prof instanceof PDFStream)) continue
      const icc = streamBytes(prof)
      const cls = Buffer.from(icc.slice(12, 16)).toString("latin1")
      const cs = Buffer.from(icc.slice(16, 20)).toString("latin1")
      const n = prof.dict.get(PDFName.of("N"))
      iccOk = (cls === "mntr" || cls === "prtr") && cs === "RGB " && n?.toString() === "3"
    }
  }
  put("output-intent-icc", iccOk)

  // Walk every object once.
  let cmyk = false
  let unembedded: string[] = []
  let js = false
  // Every dictionary, indirect or nested directly inside another object (an action dictionary
  // is often direct, e.g. a catalog /OpenAction).
  const dicts: PDFDict[] = []
  const collect = (o: PDFObject | undefined, depth: number): void => {
    if (!o || depth > 32 || o instanceof PDFRef) return
    if (o instanceof PDFStream) {
      collect(o.dict, depth + 1)
      return
    }
    if (o instanceof PDFDict) {
      dicts.push(o)
      for (const [, v] of o.entries()) collect(v, depth + 1)
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) collect(v, depth + 1)
    }
  }
  for (const [, obj] of ctx.enumerateIndirectObjects()) collect(obj, 0)
  for (const dict of dicts) {
    if (nameOf(dict.get(PDFName.of("Subtype"))) === "Image") {
      const cs = deref(doc, dict.get(PDFName.of("ColorSpace")))
      if (nameOf(cs) === "DeviceCMYK") cmyk = true
    }
    if (
      nameOf(dict.get(PDFName.of("S"))) === "JavaScript" ||
      dict.has(PDFName.of("JS")) ||
      dict.has(PDFName.of("JavaScript"))
    )
      js = true
    if (nameOf(dict.get(PDFName.of("Type"))) === "Font") {
      const sub = nameOf(dict.get(PDFName.of("Subtype")))
      if (sub === "Type0") continue // judged through its descendant CIDFont
      const fd = deref(doc, dict.get(PDFName.of("FontDescriptor")))
      const embedded =
        fd instanceof PDFDict &&
        (fd.has(PDFName.of("FontFile")) ||
          fd.has(PDFName.of("FontFile2")) ||
          fd.has(PDFName.of("FontFile3")))
      if (!embedded) unembedded = [...unembedded, nameOf(dict.get(PDFName.of("BaseFont"))) ?? "?"]
    }
  }
  put("no-cmyk-images", !cmyk)
  put("fonts-embedded", unembedded.length === 0, unembedded.join(", "))
  put("no-encryption", ctx.trailerInfo.Encrypt === undefined)
  put("no-javascript", !js)
  const id = deref(doc, ctx.trailerInfo.ID as PDFObject | undefined)
  put("trailer-id", id instanceof PDFArray && id.size() === 2)
  return results
}

export function failing(results: AssertResult[]): string[] {
  return results.filter((r) => !r.ok).map((r) => r.id)
}
