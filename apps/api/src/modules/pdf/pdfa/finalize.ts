// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PDF/A-3B finalisation of a pdf-lib document built by the replayer, natively (no Ghostscript):
//
//   - Info dictionary dates set explicitly and mirrored into the XMP (the document is created with
//     `updateMetadata:false`, so pdf-lib never rewrites Producer/ModDate behind our back);
//   - XMP metadata stream, uncompressed (`/Type/Metadata/Subtype/XML`, no filter), carrying the
//     PDF/A identification, dc:title, xmp dates, pdf:Producer and any extension schema;
//   - sRGB OutputIntent (`GTS_PDFA1`) with the bundled, unmodified ICC v2 display profile;
//   - associated files: each attachment embedded with `/F` + `/UF`, MIME `/Subtype`, `/Params
//     /ModDate`, its `/AFRelationship`, and referenced from the catalog `/AF` array;
//   - trailer `/ID`.
//
// Everything else the profile needs is guaranteed upstream in the replayer: every font embedded
// (Helvetica family → Liberation subsets; Times/Courier refused), no DeviceCMYK images, no
// JavaScript or actions, no encryption.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { PDFDict, type PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib"
import { buildXmp, type XmpExtension } from "./xmp"

export type AfRelationship = "Data" | "Source" | "Alternative" | "Supplement" | "Unspecified"

export interface PdfAAttachment {
  name: string
  mime: string
  bytes: Uint8Array
  afRelationship: AfRelationship
  description?: string
}

export interface PdfAOptions {
  level: "3b"
  attachments?: PdfAAttachment[]
  xmpExtensions?: XmpExtension[]
  /** Creation / modification instant. Defaults to now; fixed by tests. */
  now?: Date
}

const ICC_FILE = "sRGB2014.icc"
let iccCache: Uint8Array | null = null

export function iccDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "assets", "icc")
}

export function srgbIccBytes(): Uint8Array {
  if (iccCache) return iccCache
  iccCache = new Uint8Array(readFileSync(join(iccDir(), ICC_FILE)))
  return iccCache
}

/** `D:YYYYMMDDHHmmSSZ` → the same instant as XMP ISO-8601, second precision. */
export function isoSeconds(d: Date): string {
  return `${d.toISOString().slice(0, 19)}Z`
}

function decodeInfoText(doc: PDFDocument, key: string): string | null {
  const info = doc.context.lookup(doc.context.trailerInfo.Info)
  if (!(info instanceof PDFDict)) return null
  const v = info.get(PDFName.of(key))
  if (v instanceof PDFHexString || v instanceof PDFString) return v.decodeText()
  return null
}

export async function finalizePdfA(doc: PDFDocument, opts: PdfAOptions): Promise<void> {
  const now = new Date(Math.floor((opts.now ?? new Date()).getTime() / 1000) * 1000)
  doc.setCreationDate(now)
  doc.setModificationDate(now)
  const title = decodeInfoText(doc, "Title")
  const producer = decodeInfoText(doc, "Producer")
  const creator = decodeInfoText(doc, "Creator")
  if (title != null) {
    // DisplayDocTitle is recommended alongside a dc:title; harmless for level B.
    doc.setTitle(title, { showInWindowTitleBar: true })
  }

  for (const a of opts.attachments ?? []) {
    await doc.attach(a.bytes, a.name, {
      mimeType: a.mime,
      description: a.description,
      creationDate: now,
      modificationDate: now,
      // pdf-lib's AFRelationship enum values are these exact strings.
      afRelationship: a.afRelationship as never,
    })
  }

  const xmp = buildXmp({
    part: 3,
    conformance: "B",
    title,
    producer,
    creatorTool: creator,
    createDate: isoSeconds(now),
    modifyDate: isoSeconds(now),
    extensions: opts.xmpExtensions ?? [],
  })
  const xmpBytes = new TextEncoder().encode(xmp)
  // `context.stream` (not `flateStream`): PDF/A wants the metadata readable without a filter.
  const metadata = doc.context.stream(xmpBytes, {
    Type: "Metadata",
    Subtype: "XML",
    Length: xmpBytes.length,
  })
  doc.catalog.set(PDFName.of("Metadata"), doc.context.register(metadata))

  const icc = doc.context.flateStream(srgbIccBytes(), { N: 3 })
  const iccRef = doc.context.register(icc)
  const intent = doc.context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    DestOutputProfile: iccRef,
  })
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([doc.context.register(intent)]))

  const id = createHash("sha256")
    .update(xmpBytes)
    .update(String(now.getTime()))
    .digest("hex")
    .slice(0, 32)
  doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id), PDFHexString.of(id)])
}

/** Number of colour components declared by a JPEG's frame header (SOFn), or null if unreadable. */
export function jpegComponents(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let i = 2
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null
    const marker = bytes[i + 1] as number
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number)
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) return bytes[i + 9] ?? null
    i += 2 + len
  }
  return null
}
