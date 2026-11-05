// SPDX-License-Identifier: FSL-1.1-ALv2
//
// XMP metadata packet for a PDF/A-3 document: the PDF/A identification (pdfaid part/conformance),
// the Dublin Core title, the XMP basic dates and creator tool, the PDF producer, and any caller
// extension schema (an app's own XMP properties, e.g. a hybrid-invoice standard's) together with its pdfaExtension
// description, which PDF/A requires for every non-predefined property.

export interface XmpExtensionProperty {
  name: string
  value: string
  description: string
  category?: "external" | "internal"
}

export interface XmpExtension {
  /** Human name of the schema (pdfaSchema:schema). */
  schema: string
  namespaceUri: string
  prefix: string
  properties: XmpExtensionProperty[]
}

export interface XmpFields {
  part: 3
  conformance: "B"
  title: string | null
  producer: string | null
  creatorTool: string | null
  /** ISO-8601 instants (UTC) mirrored from the Info dictionary dates. */
  createDate: string
  modifyDate: string
  extensions: XmpExtension[]
}

const PREFIX_RE = /^[a-z][a-zA-Z0-9]{0,15}$/
const NAME_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/
const RESERVED_PREFIXES = new Set([
  "x",
  "rdf",
  "dc",
  "xmp",
  "pdf",
  "pdfaid",
  "pdfaExtension",
  "pdfaSchema",
  "pdfaProperty",
  "xml",
])
export const MAX_XMP_EXTENSIONS = 4
export const MAX_XMP_PROPERTIES = 16
const MAX_TEXT = 512

export class XmpExtensionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "XmpExtensionError"
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Reject anything that is not a plain, bounded extension description (input crosses the bridge). */
export function validateExtensions(exts: unknown): XmpExtension[] {
  if (exts == null) return []
  if (!Array.isArray(exts) || exts.length > MAX_XMP_EXTENSIONS)
    throw new XmpExtensionError("xmp extensions must be an array of at most 4")
  return exts.map((raw) => {
    const e = raw as Partial<XmpExtension>
    if (typeof e.schema !== "string" || !e.schema.trim() || e.schema.length > MAX_TEXT)
      throw new XmpExtensionError("xmp extension schema name invalid")
    if (
      typeof e.namespaceUri !== "string" ||
      !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"]{1,256}$/.test(e.namespaceUri)
    ) {
      throw new XmpExtensionError("xmp extension namespaceUri invalid")
    }
    if (
      typeof e.prefix !== "string" ||
      !PREFIX_RE.test(e.prefix) ||
      RESERVED_PREFIXES.has(e.prefix)
    ) {
      throw new XmpExtensionError("xmp extension prefix invalid")
    }
    if (
      !Array.isArray(e.properties) ||
      e.properties.length === 0 ||
      e.properties.length > MAX_XMP_PROPERTIES
    ) {
      throw new XmpExtensionError("xmp extension properties invalid")
    }
    const properties = e.properties.map((p) => {
      const q = p as Partial<XmpExtensionProperty>
      if (typeof q.name !== "string" || !NAME_RE.test(q.name))
        throw new XmpExtensionError("xmp property name invalid")
      if (typeof q.value !== "string" || q.value.length > MAX_TEXT)
        throw new XmpExtensionError("xmp property value invalid")
      if (typeof q.description !== "string" || q.description.length > MAX_TEXT)
        throw new XmpExtensionError("xmp property description invalid")
      const category = q.category === "internal" ? "internal" : "external"
      return {
        name: q.name,
        value: q.value,
        description: q.description,
        category,
      } as XmpExtensionProperty
    })
    return { schema: e.schema, namespaceUri: e.namespaceUri, prefix: e.prefix, properties }
  })
}

export function buildXmp(f: XmpFields): string {
  const ext = f.extensions
  const extensionSchemas = ext.length
    ? '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" ' +
      'xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">' +
      "<pdfaExtension:schemas><rdf:Bag>" +
      ext
        .map(
          (e) =>
            '<rdf:li rdf:parseType="Resource">' +
            `<pdfaSchema:schema>${esc(e.schema)}</pdfaSchema:schema>` +
            `<pdfaSchema:namespaceURI>${esc(e.namespaceUri)}</pdfaSchema:namespaceURI>` +
            `<pdfaSchema:prefix>${esc(e.prefix)}</pdfaSchema:prefix>` +
            "<pdfaSchema:property><rdf:Seq>" +
            e.properties
              .map(
                (p) =>
                  '<rdf:li rdf:parseType="Resource">' +
                  `<pdfaProperty:name>${esc(p.name)}</pdfaProperty:name>` +
                  "<pdfaProperty:valueType>Text</pdfaProperty:valueType>" +
                  `<pdfaProperty:category>${p.category ?? "external"}</pdfaProperty:category>` +
                  `<pdfaProperty:description>${esc(p.description)}</pdfaProperty:description>` +
                  "</rdf:li>",
              )
              .join("") +
            "</rdf:Seq></pdfaSchema:property>" +
            "</rdf:li>",
        )
        .join("") +
      "</rdf:Bag></pdfaExtension:schemas></rdf:Description>"
    : ""
  const extensionValues = ext
    .map(
      (e) =>
        `<rdf:Description rdf:about="" xmlns:${e.prefix}="${esc(e.namespaceUri)}">` +
        e.properties
          .map((p) => `<${e.prefix}:${p.name}>${esc(p.value)}</${e.prefix}:${p.name}>`)
          .join("") +
        "</rdf:Description>",
    )
    .join("")
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">' +
    `<pdfaid:part>${f.part}</pdfaid:part><pdfaid:conformance>${f.conformance}</pdfaid:conformance>` +
    "</rdf:Description>" +
    (f.title != null
      ? '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(f.title)}</rdf:li></rdf:Alt></dc:title>` +
        "</rdf:Description>"
      : "") +
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">' +
    (f.creatorTool != null ? `<xmp:CreatorTool>${esc(f.creatorTool)}</xmp:CreatorTool>` : "") +
    `<xmp:CreateDate>${f.createDate}</xmp:CreateDate>` +
    `<xmp:ModifyDate>${f.modifyDate}</xmp:ModifyDate>` +
    `<xmp:MetadataDate>${f.modifyDate}</xmp:MetadataDate>` +
    "</rdf:Description>" +
    (f.producer != null
      ? '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">' +
        `<pdf:Producer>${esc(f.producer)}</pdf:Producer>` +
        "</rdf:Description>"
      : "") +
    extensionSchemas +
    extensionValues +
    "</rdf:RDF></x:xmpmeta>\n" +
    '<?xpacket end="w"?>'
  )
}
