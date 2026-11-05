// SPDX-License-Identifier: FSL-1.1-ALv2
//
// G2 — validate-customs-pdf text-extraction unit tests (pure function on
// the extracted PDF text — no need to actually render a PDF in this test).
import { describe, expect, it } from "bun:test"
import { validateCustomsPdfText } from "./validate-customs-pdf"

describe("validateCustomsPdfText (Phase 17 G2)", () => {
  it("passes a complete export PDF text", () => {
    const text = `
      INVOICE INV-2026-0123
      Fabrikam SAS — 12 Rue de la Paix, FR
      Customer: Acme Inc., USA
      Date: 2026-05-28  Incoterm: DAP

      Line 1  Synth module  HS 920710  CoO FR  €450.00
      Line 2  Cable          HS 854442  CoO CN  €30.00

      Subtotal: €480.00
      VAT: €0.00
      Total: €480.00 EUR

      Reverse charge — VAT exempt under Article 196 of EU Directive 2006/112/EC.
    `
    const r = validateCustomsPdfText(text)
    const byField = Object.fromEntries(r.map((c) => [c.field, c]))
    expect(byField.incoterm!.present).toBe(true)
    expect(byField.hs_code!.present).toBe(true)
    expect(byField.country_of_origin!.present).toBe(true)
    expect(byField.currency!.present).toBe(true)
    expect(byField.total_value!.present).toBe(true)
    expect(byField.legal_mention!.present).toBe(true)
  })

  it("flags missing HS code", () => {
    const text = `
      INVOICE INV-1
      Incoterm: DAP
      Line 1 — no HS
      Total: 100.00 EUR
      Reverse charge applies.
    `
    const r = validateCustomsPdfText(text)
    expect(r.find((c) => c.field === "hs_code")?.present).toBe(false)
  })

  it("flags missing incoterm", () => {
    const text = `
      INVOICE INV-2
      Line 1  HS 920710  CoO FR  €100.00
      Total: 100.00 EUR
      Reverse charge.
    `
    const r = validateCustomsPdfText(text)
    expect(r.find((c) => c.field === "incoterm")?.present).toBe(false)
  })

  it("flags missing legal mention", () => {
    const text = `
      INVOICE INV-3
      Incoterm: DDP
      Line 1  HS 920710  CoO FR  €100.00
      Total: 100.00 EUR
    `
    const r = validateCustomsPdfText(text)
    expect(r.find((c) => c.field === "legal_mention")?.present).toBe(false)
  })
})
