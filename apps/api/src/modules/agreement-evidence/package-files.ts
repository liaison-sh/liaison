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

import { PDFDocument, type PDFFont, rgb } from "pdf-lib"
import { buildEvidenceZip } from "~/modules/signing/evidence-zip"
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
  const fr = input.lang === "fr"
  line(fr ? "Certificat de signature" : "Signature certificate", 16, bold)
  line(`${input.orgName}: ${input.title}`)
  line(`${input.agreement}, version ${input.version}`)
  y -= 8
  line(fr ? "Empreinte du document (SHA-256)" : "Document fingerprint (SHA-256)", 10, bold)
  line(input.documentSha256, 8)
  line(fr ? "Empreinte du PDF signé (SHA-256)" : "Signed PDF fingerprint (SHA-256)", 10, bold)
  line(input.signedPdfSha256, 8)
  line(fr ? "Sceau (SHA-256 du manifeste)" : "Seal (SHA-256 of the manifest)", 10, bold)
  line(input.seal, 8)
  line(
    fr
      ? input.timestamped
        ? "Horodatage : reçu d'une autorité extérieure."
        : "Horodatage : en attente, pas encore reçu."
      : input.timestamped
        ? "Timestamp: received from an outside authority."
        : "Timestamp: pending, not received yet.",
  )
  y -= 8
  line(fr ? "Signataires" : "Signers", 10, bold)
  for (const s of input.signers) line(`${s.name}, ${s.capacity}`)
  return doc.save({ useObjectStreams: false })
}

/**
 * The offline checker page placed in every zip. The full checker (hashing the
 * dropped file, recomputing the seal and reading the timestamp) is its own
 * package; until it is wired in, this page states the fingerprints and how to
 * check them by hand, and claims no check.
 */
export function checkPage(input: {
  documentSha256: string
  signedPdfSha256: string
  seal: string
}): Uint8Array {
  const html = [
    "<!doctype html>",
    '<html lang="en"><meta charset="utf-8"><title>Check this document</title>',
    "<body>",
    "<h1>Check this document</h1>",
    "<p>Compute the SHA-256 of signed.pdf and of document.pdf and compare them with these values.",
    " manifest.json holds them; the seal is the SHA-256 of manifest.json's exact bytes.</p>",
    `<p>document.pdf: <code>${input.documentSha256}</code></p>`,
    `<p>signed.pdf: <code>${input.signedPdfSha256}</code></p>`,
    `<p>Seal: <code>${input.seal}</code></p>`,
    "<p>When timestamp.tsr is present: openssl ts -verify -data seal.bin -in timestamp.tsr -CAfile tsa-chain.pem</p>",
    "</body></html>",
  ].join("")
  return new TextEncoder().encode(html)
}

export interface PackageFilesInput {
  signedPdf: Uint8Array
  frozenPdf: Uint8Array
  trail: Trail
  manifestBytes: Uint8Array
  seal: string
  timestampReply?: Uint8Array
  certificatePdf: Uint8Array
  checkHtml: Uint8Array
  sealedAt: Date
  /** Signers' client action ids, one copy each. */
  signerActionIds: string[]
}

export interface PackageFiles {
  evidence: Uint8Array
  signerCopies: Record<string, Uint8Array>
  colleagueCopy: Uint8Array
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
    checkHtml: input.checkHtml,
    sealedAt: input.sealedAt,
  }
  const evidence = buildEvidenceZip({ ...common, trail: input.trail, trailKind: "full" })
  const signerCopies: Record<string, Uint8Array> = {}
  for (const id of input.signerActionIds) {
    signerCopies[id] = buildEvidenceZip({
      ...common,
      trail: signerCopyTrail(input.trail, { clientActionId: id }),
      trailKind: "signer_copy",
    })
  }
  const colleagueCopy = buildEvidenceZip({
    ...common,
    trail: signerCopyTrail(input.trail, { colleague: true }),
    trailKind: "signer_copy",
  })
  return { evidence, signerCopies, colleagueCopy }
}
