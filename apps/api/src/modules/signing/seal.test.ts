// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seal formula, pinned by a fixed vector (cross-checked with `shasum -a 256`
// over the canonical manifest text). The offline checker reads the same vector.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  buildSealManifest,
  computeSeal,
  parseSealManifest,
  SealInputError,
  trailSha256,
} from "~/modules/signing/seal"

const VECTOR = JSON.parse(
  readFileSync(path.join(import.meta.dir, "test-fixtures/seal-vector.json"), "utf8"),
)

describe("seal", () => {
  it("the seal of the fixed vector is c48adfa472c4af1d9be251778dccdf3fbf313ac6a1bdb3b0412d288e13c7c458", () => {
    const s = computeSeal(VECTOR.input)
    expect(new TextDecoder().decode(s.manifestBytes)).toBe(VECTOR.canonicalManifest)
    expect(s.seal).toBe(VECTOR.seal)
    expect(s.seal).toBe("c48adfa472c4af1d9be251778dccdf3fbf313ac6a1bdb3b0412d288e13c7c458")
    expect({ hashAlg: s.hashAlg, sealVersion: s.sealVersion }).toEqual({
      hashAlg: "sha256",
      sealVersion: 1,
    })
  })

  it("the manifest holds exactly the eight fields, and a changed input changes the seal", () => {
    const s = computeSeal(VECTOR.input)
    expect(Object.keys(s.manifest).sort()).toEqual(
      [
        "agreement",
        "document_sha256",
        "hash",
        "level",
        "signed_pdf_sha256",
        "trail_sha256",
        "v",
        "version",
      ].sort(),
    )
    for (const change of [
      { documentSha256: "0".repeat(64) },
      { signedPdfSha256: "0".repeat(64) },
      { trailSha256: "0".repeat(64) },
      { level: "other" },
      { agreement: "AGR-2026-0002" },
      { version: 3 },
    ]) {
      expect(computeSeal({ ...VECTOR.input, ...change }).seal).not.toBe(VECTOR.seal)
    }
  })

  it("the seal is a plain SHA-256 of the canonical manifest, with no key", () => {
    const s = computeSeal(VECTOR.input)
    expect(createHash("sha256").update(VECTOR.canonicalManifest).digest("hex")).toBe(s.seal)
  })

  it("refuses a hash that is not lowercase hex SHA-256, an empty level and a bad version", () => {
    const bad = [
      { documentSha256: "A".repeat(64) },
      { signedPdfSha256: "ab" },
      { trailSha256: "" },
      { level: "" },
      { agreement: "" },
      { version: 0 },
      { version: 1.5 },
    ]
    for (const change of bad) {
      expect(() => buildSealManifest({ ...VECTOR.input, ...change })).toThrow(SealInputError)
    }
  })

  it("reads a stored manifest back only with exactly its fields, version and hash", () => {
    const m = computeSeal(VECTOR.input).manifest
    expect(parseSealManifest(JSON.parse(JSON.stringify(m)))).toEqual(m)
    expect(() => parseSealManifest({ ...m, extra: 1 })).toThrow(SealInputError)
    expect(() => parseSealManifest({ ...m, v: 2 })).toThrow(SealInputError)
    expect(() => parseSealManifest({ ...m, hash: "sha512" })).toThrow(SealInputError)
  })

  it("the trail hash is SHA-256 of the trail's canonical JSON, whatever the key order", () => {
    const a = [{ type: "sent", at: "2026-11-09", by: "x" }]
    const b = [{ by: "x", at: "2026-11-09", type: "sent" }]
    expect(trailSha256(a)).toBe(trailSha256(b))
    expect(trailSha256(a)).toBe(
      createHash("sha256").update('[{"at":"2026-11-09","by":"x","type":"sent"}]').digest("hex"),
    )
  })
})
