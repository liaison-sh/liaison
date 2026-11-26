// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The files of a sealed package, from bytes already checked against the seal:
// the staff evidence file (full trail), one signer's copy per signer (the
// event list keeps IP and user agent on the reader's own events only), and
// one copy with no device at all for a colleague at the client who did not
// sign. Every copy holds the same signed PDF, frozen PDF, manifest bytes,
// seal and timestamp reply as the staff file; only the event list differs, so
// a copy does not rebuild `trail_sha256` and says so.
//
// The zip itself is written by the signing module (modules/signing/evidence-zip.ts),
// which refuses a file that is not the one the manifest names.

import { buildCheckPage } from "@liaison/evidence-check"
import { PDFDocument, type PDFFont, rgb } from "pdf-lib"
import { serverT } from "~/modules/i18n/server-i18n"
import { canonicalJsonBytes } from "~/modules/signing/canonical-json"
import { buildEvidenceZip, type EvidenceZipInput } from "~/modules/signing/evidence-zip"
import { plainText, type SignatureLang } from "./signature-pages"

/** The device fields an event of the trail may carry. */
export const DEVICE_FIELDS = ["ip", "user_agent"] as const

export interface TrailEvent {
  client_action_id: string
  [key: string]: unknown
}

export interface Trail {
  events: TrailEvent[]
  [key: string]: unknown
}

/** Who a copy is for: one signer's client action, or nobody (a colleague's copy). */
export type CopyReader = { clientActionId: string } | { colleague: true }

export const COPY_NOTE =
  "This list leaves out other people's devices. The full list has the fingerprint in the manifest and is kept by the organization."

/**
 * A signer's copy of the trail: every party's name, capacity and time, with
 * IP and user agent only on the reader's own events; none at all for a
 * colleague's copy.
 */
export function signerCopyTrail(trail: Trail, reader: CopyReader): Record<string, unknown> {
  const own = "clientActionId" in reader ? reader.clientActionId : null
  const events = trail.events.map((e) => {
    if (own !== null && e.client_action_id === own) return { ...e }
    const copy: Record<string, unknown> = { ...e }
    for (const f of DEVICE_FIELDS) delete copy[f]
    return copy
  })
  return {
    ...trail,
    events,
    copy: { for: own ?? "colleague", note: COPY_NOTE },
  }
}

export interface CertificateInput {
  lang: SignatureLang
  orgName: string
  agreement: string
  version: number
  title: string
  documentSha256: string
  signedPdfSha256: string
  seal: string
  sealedAt: Date
  timestamped: boolean
  signers: Array<{ name: string; capacity: string }>
}

/** One signer on the certificate: their name, and their capacity when they gave one. */
export function certificateSignerLine(s: { name: string; capacity: string }): string {
  const capacity = (s.capacity ?? "").trim()
  return capacity ? `${s.name}, ${capacity}` : s.name
}

/** A one-page summary of what was signed: plain text, no claim beyond the facts. */
export async function renderCertificate(input: CertificateInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const { embedUnicodeFace } = await import("~/modules/pdf/unicode-fonts")
  const cache = new Map()
  const regular: PDFFont = await embedUnicodeFace(doc, "regular", cache)
  const bold: PDFFont = await embedUnicodeFace(doc, "bold", cache)
  const page = doc.addPage([595.28, 841.89])
  let y = 790
  const line = (text: string, size = 10, font = regular) => {
    page.drawText(plainText(text).slice(0, 110), {
      x: 56,
      y,
      size,
      font,
      color: rgb(0.1, 0.1, 0.1),
    })
    y -= size + 6
  }
  const t = (key: string, params?: Record<string, string | number>) =>
    serverT(input.lang, `agreement-evidence.certificate.${key}`, params)
  line(t("title"), 16, bold)
  line(`${input.orgName}: ${input.title}`)
  line(
    serverT(input.lang, "agreement-evidence.pages.document", {
      agreement: input.agreement,
      version: input.version,
    }),
  )
  y -= 8
  line(t("document_fingerprint"), 10, bold)
  line(input.documentSha256, 8)
  line(t("signed_fingerprint"), 10, bold)
  line(input.signedPdfSha256, 8)
  line(t("seal"), 10, bold)
  line(input.seal, 8)
  line(input.timestamped ? t("stamped") : t("pending"))
  y -= 8
  line(t("signers"), 10, bold)
  for (const s of input.signers) line(certificateSignerLine(s))
  return doc.save({ useObjectStreams: false })
}

export interface PackageFilesInput {
  signedPdf: Uint8Array
  frozenPdf: Uint8Array
  trail: Trail
  manifestBytes: Uint8Array
  seal: string
  timestampReply?: Uint8Array
  certificatePdf: Uint8Array
  sealedAt: Date
  /** The organization that keeps the full event list (named on a copy's checker page). */
  orgName: string
  /** The checker page's language. */
  lang: SignatureLang
  /** Signers' client action ids, one copy each. */
  signerActionIds: string[]
}

export interface PackageFiles {
  evidence: Uint8Array
  signerCopies: Record<string, Uint8Array>
  colleagueCopy: Uint8Array
}

/**
 * One zip of the package. Its checker page (check.html) carries this zip's own
 * event list, so a signer's copy holds nobody else's device there either.
 */
function zipWithCheckPage(
  common: Omit<EvidenceZipInput, "trail" | "trailKind" | "checkHtml">,
  input: PackageFilesInput,
  trail: unknown,
  trailKind: EvidenceZipInput["trailKind"],
): Uint8Array {
  const checkHtml = buildCheckPage({
    manifestBytes: input.manifestBytes,
    trailBytes: canonicalJsonBytes(trail),
    trailKind,
    ...(input.timestampReply ? { timestampReply: input.timestampReply } : {}),
    orgName: input.orgName,
    lang: input.lang,
  })
  return buildEvidenceZip({ ...common, trail, trailKind, checkHtml })
}

/** Build the staff file, each signer's copy and the colleague's copy. */
export function buildPackageFiles(input: PackageFilesInput): PackageFiles {
  const common = {
    signedPdf: input.signedPdf,
    frozenPdf: input.frozenPdf,
    manifestBytes: input.manifestBytes,
    seal: input.seal,
    ...(input.timestampReply ? { timestampReply: input.timestampReply } : {}),
    certificatePdf: input.certificatePdf,
    sealedAt: input.sealedAt,
  }
  const evidence = zipWithCheckPage(common, input, input.trail, "full")
  const signerCopies: Record<string, Uint8Array> = {}
  for (const id of input.signerActionIds) {
    signerCopies[id] = zipWithCheckPage(
      common,
      input,
      signerCopyTrail(input.trail, { clientActionId: id }),
      "signer_copy",
    )
  }
  const colleagueCopy = zipWithCheckPage(
    common,
    input,
    signerCopyTrail(input.trail, { colleague: true }),
    "signer_copy",
  )
  return { evidence, signerCopies, colleagueCopy }
}
