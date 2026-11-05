// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Validation of the PDF/A part of a sandbox `pdf.render` call. Everything here crossed the JSON
// bridge from app code, so it is bounded and shape-checked before any byte reaches pdf-lib.

import type { AfRelationship, PdfAAttachment } from "./finalize"
import { validateExtensions, type XmpExtension } from "./xmp"

export const MAX_PDFA_ATTACHMENTS = 4
export const MAX_PDFA_ATTACHMENT_BYTES = 5 * 1024 * 1024

const AF_RELATIONSHIPS = new Set<AfRelationship>([
  "Data",
  "Source",
  "Alternative",
  "Supplement",
  "Unspecified",
])
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,64}$/
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export class PdfAParamError extends Error {
  readonly code = "invalid_pdfa_params"
  constructor(message: string) {
    super(message)
    this.name = "PdfAParamError"
  }
}

export interface RawPdfAParams {
  pdfa?: unknown
  attachments?: unknown
  xmp?: { extensions?: unknown } | null
}

export interface ParsedPdfAParams {
  pdfa?: "3b"
  attachments: PdfAAttachment[]
  xmpExtensions: XmpExtension[]
}

export function parsePdfAParams(raw: RawPdfAParams): ParsedPdfAParams {
  if (raw.pdfa != null && raw.pdfa !== "3b") throw new PdfAParamError(`pdfa must be "3b"`)
  const pdfa = raw.pdfa === "3b" ? ("3b" as const) : undefined
  const list = raw.attachments == null ? [] : raw.attachments
  if (!Array.isArray(list) || list.length > MAX_PDFA_ATTACHMENTS) {
    throw new PdfAParamError(`attachments must be an array of at most ${MAX_PDFA_ATTACHMENTS}`)
  }
  let xmpExtensions: XmpExtension[]
  try {
    xmpExtensions = validateExtensions(raw.xmp?.extensions)
  } catch (e) {
    throw new PdfAParamError((e as Error).message)
  }
  if (!pdfa && (list.length > 0 || xmpExtensions.length > 0)) {
    throw new PdfAParamError("attachments and xmp extensions are only allowed with pdfa")
  }
  const names = new Set<string>()
  const attachments = list.map((r) => {
    const a = r as Record<string, unknown>
    const name = a.name
    if (typeof name !== "string" || !NAME_RE.test(name) || names.has(name))
      throw new PdfAParamError("attachment name invalid or duplicated")
    names.add(name)
    if (typeof a.mime !== "string" || !MIME_RE.test(a.mime))
      throw new PdfAParamError("attachment mime invalid")
    const rel = a.afRelationship
    if (typeof rel !== "string" || !AF_RELATIONSHIPS.has(rel as AfRelationship))
      throw new PdfAParamError("attachment afRelationship invalid")
    const b64 = a.bytesBase64
    if (
      typeof b64 !== "string" ||
      b64.length === 0 ||
      b64.length % 4 !== 0 ||
      !BASE64_RE.test(b64)
    ) {
      throw new PdfAParamError("attachment bytesBase64 invalid")
    }
    const bytes = new Uint8Array(Buffer.from(b64, "base64"))
    if (bytes.byteLength > MAX_PDFA_ATTACHMENT_BYTES)
      throw new PdfAParamError("attachment too large")
    const description = typeof a.description === "string" ? a.description.slice(0, 256) : undefined
    return {
      name,
      mime: a.mime,
      bytes,
      afRelationship: rel as AfRelationship,
      ...(description ? { description } : {}),
    }
  })
  return { ...(pdfa ? { pdfa } : {}), attachments, xmpExtensions }
}
