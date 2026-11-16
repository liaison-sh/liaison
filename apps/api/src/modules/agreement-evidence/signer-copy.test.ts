// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { unzipSync } from "fflate"
import { EVIDENCE_ZIP_ENTRIES } from "~/modules/signing/constants"
import { computeSeal, sha256Hex, trailSha256 } from "~/modules/signing/seal"
import { buildPackageFiles, checkPage, signerCopyTrail, type Trail } from "./package-files"

const enc = (s: string) => new TextEncoder().encode(s)
const frozenPdf = enc("%PDF-1.7 frozen")
const signedPdf = enc("%PDF-1.7 frozen + signature pages")
const A = "aaaaaaaa-0000-4000-8000-00000000000a"
const B = "bbbbbbbb-0000-4000-8000-00000000000b"
const trail: Trail = {
  v: 1,
  agreement: "AG-2026-001",
  version: 1,
  events: [
    {
      client_action_id: A,
      typed_name: "Paul Morel",
      capacity: "Gérant",
      ip: "198.51.100.7",
      user_agent: "UA-of-Paul",
    },
    {
      client_action_id: B,
      typed_name: "Anne Morel",
      capacity: "Associée",
      ip: "203.0.113.9",
      user_agent: "UA-of-Anne",
    },
  ],
}
const sealed = computeSeal({
  documentSha256: sha256Hex(frozenPdf),
  signedPdfSha256: sha256Hex(signedPdf),
  trailSha256: trailSha256(trail),
  level: "ses",
  agreement: "AG-2026-001",
  version: 1,
})

function build() {
  return buildPackageFiles({
    signedPdf,
    frozenPdf,
    trail,
    manifestBytes: sealed.manifestBytes,
    seal: sealed.seal,
    timestampReply: new Uint8Array([0x30, 0x00]),
    certificatePdf: enc("%PDF certificate"),
    checkHtml: checkPage({
      documentSha256: sealed.manifest.document_sha256,
      signedPdfSha256: sealed.manifest.signed_pdf_sha256,
      seal: sealed.seal,
    }),
    sealedAt: new Date(Date.UTC(2026, 10, 10)),
    signerActionIds: [A, B],
  })
}

const allText = (zip: Uint8Array) =>
  Object.values(unzipSync(zip))
    .map((b) => new TextDecoder().decode(b))
    .join("\n")

describe("signer's copy", () => {
  it("no other signer's IP or user agent in any entry, and seal bytes equal the staff file's", () => {
    const files = build()
    const staff = unzipSync(files.evidence)
    const paul = files.signerCopies[A] as Uint8Array
    const anne = files.signerCopies[B] as Uint8Array
    const paulText = allText(paul)
    expect(paulText).toContain("198.51.100.7")
    expect(paulText).toContain("UA-of-Paul")
    expect(paulText).not.toContain("203.0.113.9")
    expect(paulText).not.toContain("UA-of-Anne")
    const anneText = allText(anne)
    expect(anneText).not.toContain("198.51.100.7")
    expect(anneText).not.toContain("UA-of-Paul")
    for (const copy of [paul, anne, files.colleagueCopy]) {
      const entries = unzipSync(copy)
      for (const name of [
        EVIDENCE_ZIP_ENTRIES.manifest,
        EVIDENCE_ZIP_ENTRIES.signedPdf,
        EVIDENCE_ZIP_ENTRIES.frozenPdf,
        EVIDENCE_ZIP_ENTRIES.timestampToken,
      ]) {
        expect(
          Buffer.compare(
            Buffer.from(entries[name] as Uint8Array),
            Buffer.from(staff[name] as Uint8Array),
          ),
        ).toBe(0)
      }
      expect(sha256Hex(entries[EVIDENCE_ZIP_ENTRIES.manifest] as Uint8Array)).toBe(sealed.seal)
    }
  })

  it("the colleague's copy holds no device at all and every party's name", () => {
    const text = allText(build().colleagueCopy)
    for (const v of ["198.51.100.7", "203.0.113.9", "UA-of-Paul", "UA-of-Anne"])
      expect(text).not.toContain(v)
    expect(text).toContain("Paul Morel")
    expect(text).toContain("Anne Morel")
  })

  it("a copy's event list says it leaves out other people's devices, and the staff trail is unchanged", () => {
    const copy = signerCopyTrail(trail, { clientActionId: A })
    expect(JSON.stringify(copy)).toContain("leaves out other people's devices")
    expect(trailSha256(trail)).toBe(sealed.manifest.trail_sha256)
    const staff = JSON.parse(
      new TextDecoder().decode(unzipSync(build().evidence)[EVIDENCE_ZIP_ENTRIES.trail]),
    )
    expect(staff.events[1].ip).toBe("203.0.113.9")
  })
})
