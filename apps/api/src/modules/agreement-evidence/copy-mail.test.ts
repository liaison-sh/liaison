// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The words of a signer's copy: the organization named, never an empty name, and a recorded
// approval (a change request) never called a signature. The certificate's signer line has no
// empty capacity.
import { describe, expect, it } from "bun:test"
import { copyMailWords } from "./copy-mail"
import { certificateSignerLine } from "./package-files"

describe("a signer's copy mail", () => {
  it("names the organization in the body", () => {
    const w = copyMailWords("en", false)
    expect(w.subject("AG-1", 1)).toBe("Your signed copy: AG-1, version 1")
    const body = w.body("Maison Alpha", "Website")
    expect(body).toContain('signed "Website" with Maison Alpha.')
    expect(body).toContain("without Maison Alpha.")
  })

  it("an approved change request reads as an approval, not a signature, in both languages", () => {
    for (const lang of ["en", "fr"] as const) {
      const w = copyMailWords(lang, true)
      const all = `${w.subject("CR-2", 1)} ${w.body("Maison Alpha", "Booking page")}`
      expect(all).not.toMatch(/sign|signé/i)
      expect(all).toContain("CR-2")
      expect(all).toContain("Maison Alpha")
    }
  })

  it("a certificate's signer line leaves out a capacity nobody gave", () => {
    expect(certificateSignerLine({ name: "Paul Garnier", capacity: "" })).toBe("Paul Garnier")
    expect(certificateSignerLine({ name: "Paul Garnier", capacity: "Director" })).toBe(
      "Paul Garnier, Director",
    )
  })
})
