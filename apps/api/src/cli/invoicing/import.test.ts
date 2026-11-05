// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure-helper tests for the Sufio import CLI — the DB-touching path is
// exercised against staging with --dry-run + the idempotent re-run.
import { describe, expect, it } from "bun:test"
import { approximateTreatment, pdfPathFor, rateToBp, toMinor } from "./import"

describe("invoicing import — amount parsing", () => {
  it("converts plain decimal strings to minor units", () => {
    expect(toMinor("899.00")).toBe(89900n)
    expect(toMinor("78")).toBe(7800n)
    expect(toMinor("0.54")).toBe(54n)
    expect(toMinor("1234.5")).toBe(123450n)
  })
  it("preserves negative credit-note amounts", () => {
    expect(toMinor("-6744.00")).toBe(-674400n)
    expect(toMinor("-0.09")).toBe(-9n)
  })
  it("strips thousands separators", () => {
    expect(toMinor("5,900.00")).toBe(590000n)
    expect(toMinor("-5,900.00")).toBe(-590000n)
  })
  it("treats null/empty as zero and rejects garbage", () => {
    expect(toMinor(null)).toBe(0n)
    expect(toMinor(undefined)).toBe(0n)
    expect(() => toMinor("12.345")).toThrow()
    expect(() => toMinor("abc")).toThrow()
  })
})

describe("invoicing import — VAT rate labels", () => {
  it("parses integer and decimal rates to basis points", () => {
    expect(rateToBp("20%")).toBe(2000)
    expect(rateToBp("VAT (FI ALV) 25.5%")).toBe(2550)
    expect(rateToBp("VAT (HU VAT) 27%")).toBe(2700)
    expect(rateToBp(null)).toBe(0)
    expect(rateToBp("no rate here")).toBe(0)
  })
})

describe("invoicing import — treatment approximation", () => {
  it("buckets FR/EU/rest-of-world", () => {
    expect(approximateTreatment("FR", false)).toBe("fr_domestic")
    expect(approximateTreatment("DE", true)).toBe("eu_reverse_charge")
    expect(approximateTreatment("DE", false)).toBe("eu_destination")
    expect(approximateTreatment("US", false)).toBe("export")
    expect(approximateTreatment("GB", true)).toBe("export")
    expect(approximateTreatment(null, false)).toBe("export")
  })
})

describe("invoicing import — PDF paths from the manifest", () => {
  it("keeps every source_file inside the PDF directory", () => {
    expect(pdfPathFor("/srv/pdfs", "INV-0001.pdf")).toBe("/srv/pdfs/INV-0001.pdf")
    expect(pdfPathFor("/srv/pdfs", "2026/INV-0002.pdf")).toBe("/srv/pdfs/2026/INV-0002.pdf")
    for (const bad of ["../secret.pdf", "/etc/passwd", "a/../../x.pdf", ".", "x\u0000.pdf"]) {
      expect(() => pdfPathFor("/srv/pdfs", bad)).toThrow("inside the PDF directory")
    }
  })
})
