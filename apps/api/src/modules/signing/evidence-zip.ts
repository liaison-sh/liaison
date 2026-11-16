// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The evidence file of a sealed agreement version: one zip holding the signed
// PDF, the frozen PDF, the trail, the manifest (the exact bytes the seal is
// the SHA-256 of), the timestamp reply when the stamp arrived, the
// certificate PDF and the offline checker page. The same layout serves the
// staff file (full trail) and each signer's copy (a trail with other people's
// devices left out, which therefore does not rebuild `trail_sha256`).
//
// Nothing here hashes anything new: it checks that the bytes it is handed are
// the ones the manifest names, and refuses to write a zip that would lie.
import { zipSync } from "fflate"
import { canonicalJsonBytes } from "~/modules/signing/canonical-json"
import { EVIDENCE_ZIP_ENTRIES } from "~/modules/signing/constants"
import { parseSealManifest, sealManifest, sha256Hex } from "~/modules/signing/seal"

export interface EvidenceZipInput {
  signedPdf: Uint8Array
  frozenPdf: Uint8Array
  /** The trail as stored: the full trail for the staff file, a signer's copy otherwise. */
  trail: unknown
  trailKind: "full" | "signer_copy"
  /** The canonical manifest bytes the seal was computed over. */
  manifestBytes: Uint8Array
  /** The 64-hex seal stored on the package. */
  seal: string
  /** The verified authority reply; absent while the stamp is pending. */
  timestampReply?: Uint8Array
  certificatePdf: Uint8Array
  /** The offline checker page, built by its own package and handed in as bytes. */
  checkHtml: Uint8Array
  /** Entry time in the zip (the seal time), so the same package always gives the same bytes. */
  sealedAt: Date
}

export class EvidenceZipError extends Error {
  readonly code = "evidence_inconsistent"
  constructor(message: string) {
    super(message)
    this.name = "EvidenceZipError"
  }
}

/** Build the zip. Refuses when a file is not the one the manifest names. */
export function buildEvidenceZip(input: EvidenceZipInput): Uint8Array {
  const manifest = parseSealManifest(JSON.parse(new TextDecoder().decode(input.manifestBytes)))
  const resealed = sealManifest(manifest)
  if (Buffer.compare(Buffer.from(resealed.manifestBytes), Buffer.from(input.manifestBytes)) !== 0) {
    throw new EvidenceZipError("the manifest bytes are not canonical")
  }
  if (resealed.seal !== input.seal) throw new EvidenceZipError("the seal does not match")
  if (sha256Hex(input.frozenPdf) !== manifest.document_sha256) {
    throw new EvidenceZipError("the frozen PDF is not the sealed document")
  }
  if (sha256Hex(input.signedPdf) !== manifest.signed_pdf_sha256) {
    throw new EvidenceZipError("the signed PDF is not the sealed one")
  }
  const trailBytes = canonicalJsonBytes(input.trail)
  if (input.trailKind === "full" && sha256Hex(trailBytes) !== manifest.trail_sha256) {
    throw new EvidenceZipError("the trail is not the sealed trail")
  }
  const mtime = input.sealedAt
  const entry = (bytes: Uint8Array): [Uint8Array, { mtime: Date }] => [bytes, { mtime }]
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {
    [EVIDENCE_ZIP_ENTRIES.signedPdf]: entry(input.signedPdf),
    [EVIDENCE_ZIP_ENTRIES.frozenPdf]: entry(input.frozenPdf),
    [EVIDENCE_ZIP_ENTRIES.trail]: entry(trailBytes),
    [EVIDENCE_ZIP_ENTRIES.manifest]: entry(input.manifestBytes),
  }
  if (input.timestampReply) {
    files[EVIDENCE_ZIP_ENTRIES.timestampToken] = entry(input.timestampReply)
  }
  files[EVIDENCE_ZIP_ENTRIES.certificatePdf] = entry(input.certificatePdf)
  files[EVIDENCE_ZIP_ENTRIES.checkHtml] = entry(input.checkHtml)
  return zipSync(files, { level: 6 })
}
