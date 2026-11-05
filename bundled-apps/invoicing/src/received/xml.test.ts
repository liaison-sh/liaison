// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The supplier-XML reader refuses what an attacker would send (a DTD, entity declarations and
// references, external entities, too many elements, too deep, too long a parse) and reads CII and
// UBL invoices' own figures.
import { describe, expect, it } from "bun:test"
import { extractReceivedFacts, totalsDiffer } from "./extract"
import { parseXmlSafe, XmlRefused } from "./xml"

function refusedCode(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof XmlRefused ? e.code : `other:${String(e)}`
  }
}

const CII = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocument><ram:ID>FS-2026-118</ram:ID><ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">20261103</udt:DateTimeString></ram:IssueDateTime></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Fournisseur Exemple &amp; Fils</ram:Name>
      <ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">732829320</ram:ID></ram:SpecifiedLegalOrganization>
      <ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">FR44732829320</ram:ID></ram:SpecifiedTaxRegistration></ram:SellerTradeParty></ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement><ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">20261203</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:TaxBasisTotalAmount>100.00</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">20.00</ram:TaxTotalAmount><ram:GrandTotalAmount>120.00</ram:GrandTotalAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation></ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`

const UBL = `<?xml version="1.0"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
<cbc:ID>U-9</cbc:ID><cbc:IssueDate>2026-11-04</cbc:IssueDate><cbc:DueDate>2026-12-04</cbc:DueDate><cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
<cac:AccountingSupplierParty><cac:Party><cac:PartyTaxScheme><cbc:CompanyID>FR44732829320</cbc:CompanyID></cac:PartyTaxScheme>
<cac:PartyLegalEntity><cbc:RegistrationName>Fournisseur UBL</cbc:RegistrationName><cbc:CompanyID schemeID="0002">732829320</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">5.50</cbc:TaxAmount></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">105.50</cbc:TaxInclusiveAmount></cac:LegalMonetaryTotal></Invoice>`

describe("safe XML reader: refusals", () => {
  it("refuses a DTD (billion laughs, internal entities)", () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]><lolz>&lol2;</lolz>`
    expect(refusedCode(() => parseXmlSafe(laughs))).toBe("xml_dtd_refused")
  })

  it("refuses an external entity (XXE), with or without the DOCTYPE keyword's case", () => {
    const xxe = `<?xml version="1.0"?><!doctype foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`
    expect(refusedCode(() => parseXmlSafe(xxe))).toBe("xml_dtd_refused")
    expect(refusedCode(() => parseXmlSafe(`<a><!ENTITY x "y"></a>`))).toBe("xml_entity_refused")
  })

  it("refuses an undeclared entity reference instead of expanding or ignoring it", () => {
    expect(refusedCode(() => parseXmlSafe("<a>&xxe;</a>"))).toBe("xml_entity_refused")
    expect(refusedCode(() => parseXmlSafe('<a b="&ext;"/>'))).toBe("xml_entity_refused")
  })

  it("refuses other markup declarations, a bare ampersand, malformed nesting", () => {
    expect(refusedCode(() => parseXmlSafe("<a><!ELEMENT b ANY></a>"))).toBe("xml_dtd_refused")
    expect(refusedCode(() => parseXmlSafe("<a>fish & chips</a>"))).toBe("xml_malformed")
    expect(refusedCode(() => parseXmlSafe("<a><b></a></b>"))).toBe("xml_malformed")
    expect(refusedCode(() => parseXmlSafe("<a></a><b></b>"))).toBe("xml_malformed")
  })

  it("enforces the size, element, depth and time budgets", () => {
    expect(refusedCode(() => parseXmlSafe(`<a>${"x".repeat(2000)}</a>`, { maxBytes: 1000 }))).toBe("xml_too_large")
    expect(refusedCode(() => parseXmlSafe(`<a>${"<b/>".repeat(5000)}</a>`, { maxElements: 1000 }))).toBe("xml_too_complex")
    expect(refusedCode(() => parseXmlSafe(`${"<a>".repeat(300)}${"</a>".repeat(300)}`))).toBe("xml_too_complex")
    let t = 0
    const clock = () => (t += 10)
    expect(refusedCode(() => parseXmlSafe(`<a>${"<b/>".repeat(3000)}</a>`, { timeoutMs: 5 }, clock))).toBe("xml_timeout")
  })

  it("decodes only the predefined entities and character references", () => {
    const el = parseXmlSafe("<a t='&quot;x&quot;'>&lt;b&gt; &amp;amp; &#233;&#x41;</a>")
    expect(el.text).toBe("<b> &amp; éA")
    expect(el.attrs.t).toBe('"x"')
  })
})

describe("received facts", () => {
  it("reads a CII invoice's own figures", () => {
    const r = extractReceivedFacts(CII)
    expect(r).toEqual({
      ok: true,
      facts: {
        format: "cii",
        invoice_number: "FS-2026-118",
        type_code: "380",
        issue_date: "2026-11-03",
        due_date: "2026-12-03",
        currency: "EUR",
        seller: { name: "Fournisseur Exemple & Fils", siren: "732829320", vat_id: "FR44732829320" },
        totals: { before_tax: "100.00", tax: "20.00", total: "120.00" },
      },
    })
  })

  it("reads a UBL invoice's own figures", () => {
    const r = extractReceivedFacts(UBL)
    expect(r.ok && r.facts).toMatchObject({
      format: "ubl",
      invoice_number: "U-9",
      issue_date: "2026-11-04",
      due_date: "2026-12-04",
      seller: { name: "Fournisseur UBL", siren: "732829320", vat_id: "FR44732829320" },
      totals: { before_tax: "100.00", tax: "5.50", total: "105.50" },
    })
  })

  it("a hostile file is an outcome, not a crash; something else than an invoice is named", () => {
    const r = extractReceivedFacts(`<!DOCTYPE x [<!ENTITY a "b">]><x/>`)
    expect(r).toMatchObject({ ok: false, code: "xml_dtd_refused" })
    expect(extractReceivedFacts("<Order/>")).toMatchObject({ ok: false, code: "xml_not_an_invoice" })
  })

  it("compares totals to the cent", () => {
    expect(totalsDiffer({ before_tax: "100.0", tax: "20.0", total: "120.0" }, { before_tax: "100.00", tax: "20.00", total: "120.00" })).toEqual([])
    expect(totalsDiffer({ before_tax: "100.0", tax: "20.0", total: "121.0" }, { before_tax: "100.00", tax: "20.00", total: "120.00" })).toEqual(["total"])
  })
})
