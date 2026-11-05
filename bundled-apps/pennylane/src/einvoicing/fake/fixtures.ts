// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test inputs for the e-invoicing ops: a minimal CII carrying the facts the adapter re-checks
// (BT-1, BT-2, BAR note, buyer legal id and country), fictional parties, booking data.
import type { BookingData, EinvoiceBuyer } from "@liaison/app-sdk/contracts"

export const BUYER_SIREN = "900000001"

export const BUYER: EinvoiceBuyer = {
  contact_ref: "00000000-0000-4000-8000-0000000c0001",
  legal_name: "Client Exemple SARL",
  siren: BUYER_SIREN,
  vat_id: "FR83900000001",
  routing_address: BUYER_SIREN,
  address: { line1: "2 avenue du Test", line2: null, postcode: "69002", city: "Lyon", country_code: "FR" },
}

export function ciiXml(o: { number: string; date: string; bar?: string; buyerSiren?: string; buyerCountry?: string; typeCode?: string }): string {
  const d = o.date.replaceAll("-", "")
  return (
    `<?xml version="1.0" encoding="UTF-8"?><rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">` +
    `<rsm:ExchangedDocument><ram:ID>${o.number}</ram:ID><ram:TypeCode>${o.typeCode ?? "380"}</ram:TypeCode>` +
    `<ram:IssueDateTime><udt:DateTimeString format="102">${d}</udt:DateTimeString></ram:IssueDateTime>` +
    `<ram:IncludedNote><ram:Content>${o.bar ?? "B2B"}</ram:Content><ram:SubjectCode>BAR</ram:SubjectCode></ram:IncludedNote></rsm:ExchangedDocument>` +
    `<rsm:SupplyChainTradeTransaction><ram:ApplicableHeaderTradeAgreement><ram:SellerTradeParty><ram:Name>Maison Exemple SAS</ram:Name>` +
    `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">732829320</ram:ID></ram:SpecifiedLegalOrganization></ram:SellerTradeParty>` +
    `<ram:BuyerTradeParty><ram:Name>Client Exemple SARL</ram:Name><ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${o.buyerSiren ?? BUYER_SIREN}</ram:ID></ram:SpecifiedLegalOrganization>` +
    `<ram:PostalTradeAddress><ram:PostcodeCode>69002</ram:PostcodeCode><ram:CityName>Lyon</ram:CityName><ram:CountryID>${o.buyerCountry ?? "FR"}</ram:CountryID></ram:PostalTradeAddress>` +
    `</ram:BuyerTradeParty></ram:ApplicableHeaderTradeAgreement></rsm:SupplyChainTradeTransaction></rsm:CrossIndustryInvoice>`
  )
}

export function bookingData(o: { number: string; currency?: string; fx_rate?: string | null; treatment?: string; rate_bp?: number; kind?: BookingData["customer"]["kind"] }): BookingData {
  const rate = o.rate_bp ?? 2000
  const sub = 10000
  const tax = Math.round((sub * rate) / 10000)
  return {
    invoice_number: o.number,
    issue_date: "2026-11-03",
    due_date: "2026-12-03",
    currency: o.currency ?? "EUR",
    fx_rate: o.fx_rate ?? null,
    subtotal_minor: sub,
    tax_minor: tax,
    total_minor: sub + tax,
    credit_of: null,
    customer: {
      contact_ref: null,
      kind: o.kind ?? "individual",
      legal_name: "Alex Exemple",
      first_name: null,
      last_name: null,
      vat_id: null,
      country_code: "FR",
      address: { line1: "3 rue Test", line2: null, postcode: "75011", city: "Paris", country_code: "FR" },
    },
    lines: [
      {
        label: "Contrôleur",
        quantity: "1",
        unit_price_minor: sub,
        subtotal_minor: sub,
        tax_minor: tax,
        tax_rate_bp: rate,
        tax_treatment: o.treatment ?? "eu_domestic",
        operation_category: "goods",
      },
    ],
  }
}
