// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { unzipSync } from "fflate"
import {
  buildEvidenceZip,
  EvidenceZipError,
  type EvidenceZipInput,
} from "~/modules/signing/evidence-zip"
import { computeSeal, sha256Hex, trailSha256 } from "~/modules/signing/seal"

const enc = (s: string) => new TextEncoder().encode(s)
const frozenPdf = enc("%PDF-1.7 frozen")
const signedPdf = enc("%PDF-1.7 frozen + signature page")
const trail = [
  { type: "sent", at: "2026-11-09", ip: "198.51.100.7" },
  { type: "signed", at: "2026-11-10", ip: "203.0.113.9" },
]
const sealed = computeSeal({
  documentSha256: sha256Hex(frozenPdf),
  signedPdfSha256: sha256Hex(signedPdf),
  trailSha256: trailSha256(trail),
  level: "simple",
  agreement: "AGR-2026-0001",
  version: 1,
})

function input(over: Partial<EvidenceZipInput> = {}): EvidenceZipInput {
  return {
    signedPdf,
    frozenPdf,
    trail,
    trailKind: "full",
    manifestBytes: sealed.manifestBytes,
    seal: sealed.seal,
    timestampReply: new Uint8Array([0x30, 0x00]),
    certificatePdf: enc("%PDF certificate"),
    checkHtml: enc("<!doctype html><title>check</title>"),
    sealedAt: new Date(Date.UTC(2026, 10, 10)),
    ...over,
  }
}

describe("evidence zip", () => {
  it("holds the signed PDF, frozen PDF, trail, manifest, timestamp, certificate and check page", () => {
    const files = unzipSync(buildEvidenceZip(input()))
    expect(Object.keys(files).sort()).toEqual(
      [
        "certificate.pdf",
        "check.html",
        "document.pdf",
        "manifest.json",
        "signed.pdf",
        "timestamp.tsr",
        "trail.json",
      ].sort(),
    )
    expect(sha256Hex(files["manifest.json"]!)).toBe(sealed.seal)
    expect(sha256Hex(files["document.pdf"]!)).toBe(sealed.manifest.document_sha256)
    expect(sha256Hex(files["signed.pdf"]!)).toBe(sealed.manifest.signed_pdf_sha256)
    expect(sha256Hex(files["trail.json"]!)).toBe(sealed.manifest.trail_sha256)
  })

  it("leaves the timestamp out while the stamp is pending, and gives the same bytes twice", () => {
    const pending = unzipSync(buildEvidenceZip(input({ timestampReply: undefined })))
    expect("timestamp.tsr" in pending).toBe(false)
    expect(
      Buffer.from(buildEvidenceZip(input())).equals(Buffer.from(buildEvidenceZip(input()))),
    ).toBe(true)
  })

  it("refuses a frozen PDF, signed PDF, trail, manifest or seal the package does not name", () => {
    const bad: Partial<EvidenceZipInput>[] = [
      { frozenPdf: enc("other") },
      { signedPdf: enc("other") },
      { trail: [...trail, { type: "extra" }] },
      { seal: "0".repeat(64) },
      { manifestBytes: enc(JSON.stringify(sealed.manifest, null, 2)) },
    ]
    for (const change of bad) {
      expect(() => buildEvidenceZip(input(change))).toThrow(EvidenceZipError)
    }
  })

  it("a signer's copy may carry a trail without other people's devices", () => {
    const copy = trail.map((e, i) => (i === 0 ? e : { type: e.type, at: e.at }))
    const files = unzipSync(buildEvidenceZip(input({ trail: copy, trailKind: "signer_copy" })))
    expect(new TextDecoder().decode(files["trail.json"]!)).not.toContain("203.0.113.9")
    expect(sha256Hex(files["manifest.json"]!)).toBe(sealed.seal)
  })
})
