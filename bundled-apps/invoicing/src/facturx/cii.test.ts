// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, test } from "bun:test"
import { amount, buildCii, businessProcessCode, FacturxBuildError } from "./cii"
import { fxDocument, fxLine } from "./fixtures"
import { facturxInputFrom } from "./input"
import { vatBreakdown, vatCategory } from "./vat-breakdown"

function code(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof FacturxBuildError ? e.code : `other:${String(e)}`
  }
}

describe("buildCii", () => {
  test("business process code is category x payment state", () => {
    expect(businessProcessCode("goods", "due")).toBe("B1")
    expect(businessProcessCode("services", "paid")).toBe("S2")
    expect(businessProcessCode("mixed", "final_after_deposit")).toBe("M4")
  })

  test("amounts use the currency exponent and never carry spaces or grouping", () => {
    expect(amount(123456n, 2)).toBe("1234.56")
    expect(amount(5n, 2)).toBe("0.05")
    expect(amount(23900n, 0)).toBe("23900")
    expect(amount(-150n, 2)).toBe("-1.50")
  })

  test("an invoice carries the French identity terms", () => {
    const x = buildCii(fxDocument())
    expect(x).toContain("<ram:TypeCode>380</ram:TypeCode>")
    expect(x).toContain("<ram:ID>B1</ram:ID>")
    expect(x).toContain("<ram:Content>B2B</ram:Content><ram:SubjectCode>BAR</ram:SubjectCode>")
    expect(x).toContain('<ram:ID schemeID="0002">356000000</ram:ID>')
    expect(x).toContain('<ram:URIID schemeID="0225">356000000</ram:URIID>')
    expect(x).toContain('<ram:ID schemeID="0002">732829320</ram:ID>')
    for (const s of ["PMT", "PMD", "AAB"]) expect(x).toContain(`<ram:SubjectCode>${s}</ram:SubjectCode>`)
    expect(x).not.toContain("TaxPointDate")
    expect(x).not.toMatch(/<ram:(LineTotalAmount|GrandTotalAmount|ChargeAmount)>[^<]* [^<]*</)
  })

  test("VAT on debits emits BT-8 = 5 in every breakdown group and never BT-7", () => {
    const x = buildCii(fxDocument({ vat_on_debits: true, operation_category: "services" }))
    const groups = x.split("<ram:CalculatedAmount>").length - 1
    expect(groups).toBe(2)
    expect(x.split("<ram:DueDateTypeCode>5</ram:DueDateTypeCode>").length - 1).toBe(groups)
    expect(x).not.toContain("TaxPointDate")
    expect(buildCii(fxDocument())).not.toContain("DueDateTypeCode")
  })

  test("already paid: prepaid = total, nothing due, due date = payment date", () => {
    const d = fxDocument({ payment_state: "paid", paid_date: "2026-11-02", due_date: null })
    const x = buildCii(d)
    expect(x).toContain("<ram:ID>B2</ram:ID>")
    expect(x).toContain(`<ram:TotalPrepaidAmount>${amount(d.grand_total_minor, 2)}</ram:TotalPrepaidAmount>`)
    expect(x).toContain("<ram:DuePayableAmount>0.00</ram:DuePayableAmount>")
    expect(x).toContain('<udt:DateTimeString format="102">20261102</udt:DateTimeString></ram:DueDateDateTime>')
  })

  test("a credit note is 381 with BT-25/BT-26", () => {
    const x = buildCii(fxDocument({ type: "credit_note", number: "AV-1", original: { number: "FA-2026-0042", issue_date: "2026-11-03" } }))
    expect(x).toContain("<ram:TypeCode>381</ram:TypeCode>")
    expect(x).toContain("<ram:IssuerAssignedID>FA-2026-0042</ram:IssuerAssignedID>")
    expect(x).toContain('<qdt:DateTimeString format="102">20261103</qdt:DateTimeString>')
    expect(code(() => buildCii(fxDocument({ type: "credit_note", original: null })))).toBe("facturx_original_missing")
  })

  test("non-EUR: BT-6 = EUR and a second VAT total in EUR", () => {
    const x = buildCii(fxDocument({ currency: "USD", tax_total_eur_minor: 12345n }))
    expect(x).toContain("<ram:TaxCurrencyCode>EUR</ram:TaxCurrencyCode><ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>")
    expect(x).toContain('<ram:TaxTotalAmount currencyID="EUR">123.45</ram:TaxTotalAmount>')
    expect(code(() => buildCii(fxDocument({ currency: "USD", tax_total_eur_minor: null })))).toBe("facturx_fx_missing")
  })

  test("delivery address only when given; structured buyer address always", () => {
    expect(buildCii(fxDocument())).toContain("<ram:ApplicableHeaderTradeDelivery></ram:ApplicableHeaderTradeDelivery>")
    const x = buildCii(fxDocument({ delivery: { name: "Dépôt", line1: "9 quai", postcode: "13002", city: "Marseille", country_code: "fr" } }))
    expect(x).toContain("<ram:ShipToTradeParty><ram:Name>Dépôt</ram:Name><ram:PostalTradeAddress><ram:PostcodeCode>13002</ram:PostcodeCode>")
    expect(x).toContain("<ram:CountryID>FR</ram:CountryID>")
  })

  test("incomplete parties and inconsistent totals are refused with a stable code", () => {
    const d = fxDocument()
    expect(code(() => buildCii({ ...d, seller: { ...d.seller, siren: null } }))).toBe("facturx_seller_incomplete")
    expect(code(() => buildCii({ ...d, buyer: { ...d.buyer, address: { ...d.buyer.address, city: " " } } }))).toBe("facturx_buyer_incomplete")
    expect(code(() => buildCii({ ...d, tax_total_minor: d.tax_total_minor + 1n }))).toBe("facturx_totals_inconsistent")
    expect(code(() => buildCii({ ...d, lines: [] }))).toBe("facturx_no_lines")
  })

  test("text is escaped", () => {
    const x = buildCii(fxDocument({ lines: [fxLine(0, 'A & B <"x">', "1", 1000n)] }))
    expect(x).toContain("<ram:Name>A &amp; B &lt;&quot;x&quot;&gt;</ram:Name>")
  })

  test("the same input always builds the same bytes", () => {
    expect(buildCii(fxDocument())).toBe(buildCii(fxDocument()))
  })
})

describe("vatBreakdown", () => {
  test("groups by rate, sums line taxes, highest rate first", () => {
    const g = vatBreakdown(
      [
        { tax_rate_bp: 550, subtotal_minor: 1000n, tax_minor: 55n },
        { tax_rate_bp: 2000, subtotal_minor: 333n, tax_minor: 67n },
        { tax_rate_bp: 2000, subtotal_minor: 333n, tax_minor: 67n },
      ],
      "eu_domestic",
    )
    expect(g).toEqual([
      { category: "S", rate_bp: 2000, basis_minor: 666n, tax_minor: 134n },
      { category: "S", rate_bp: 550, basis_minor: 1000n, tax_minor: 55n },
    ])
  })

  test("zero rate takes the category its treatment names", () => {
    expect(vatCategory(0, "eu_reverse_charge")).toBe("AE")
    expect(vatCategory(0, "us_export")).toBe("G")
    expect(vatCategory(0, "eu_domestic")).toBe("E")
    expect(vatCategory(2000, "eu_reverse_charge")).toBe("S")
  })
})

describe("facturxInputFrom", () => {
  test("BT-23 never reads the current payment status: no recorded state means due", () => {
    const src = (doc: Record<string, unknown>) =>
      facturxInputFrom({
        type: "invoice",
        doc: { number: "FA-1", issued_at: "2026-11-03", operation_category: "goods", ...doc },
        lines: [],
        issuer: {},
      }).payment_state
    expect(src({ payment_status: "paid", paid_at: "2026-11-20" })).toBe("due")
    expect(src({ payment_status: "paid", einvoice: { payment_state: "paid" } })).toBe("paid")
  })
})
