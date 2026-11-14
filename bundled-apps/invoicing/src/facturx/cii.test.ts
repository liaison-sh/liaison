// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, test } from "bun:test"
import { amount, buildCii, businessProcessCode, FacturxBuildError, typeCode } from "./cii"
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
    for (const s of ["PMT", "PMD", "AAB"])
      expect(x).toContain(`<ram:SubjectCode>${s}</ram:SubjectCode>`)
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
    expect(x).toContain(
      `<ram:TotalPrepaidAmount>${amount(d.grand_total_minor, 2)}</ram:TotalPrepaidAmount>`,
    )
    expect(x).toContain("<ram:DuePayableAmount>0.00</ram:DuePayableAmount>")
    expect(x).toContain(
      '<udt:DateTimeString format="102">20261102</udt:DateTimeString></ram:DueDateDateTime>',
    )
  })

  test("a credit note is 381 with BT-25/BT-26", () => {
    const x = buildCii(
      fxDocument({
        type: "credit_note",
        number: "AV-1",
        original: { number: "FA-2026-0042", issue_date: "2026-11-03" },
      }),
    )
    expect(x).toContain("<ram:TypeCode>381</ram:TypeCode>")
    expect(x).toContain("<ram:IssuerAssignedID>FA-2026-0042</ram:IssuerAssignedID>")
    expect(x).toContain('<qdt:DateTimeString format="102">20261103</qdt:DateTimeString>')
    expect(code(() => buildCii(fxDocument({ type: "credit_note", original: null })))).toBe(
      "facturx_original_missing",
    )
  })

  test("non-EUR: BT-6 = EUR and a second VAT total in EUR", () => {
    const x = buildCii(fxDocument({ currency: "USD", tax_total_eur_minor: 12345n }))
    expect(x).toContain(
      "<ram:TaxCurrencyCode>EUR</ram:TaxCurrencyCode><ram:InvoiceCurrencyCode>USD</ram:InvoiceCurrencyCode>",
    )
    expect(x).toContain('<ram:TaxTotalAmount currencyID="EUR">123.45</ram:TaxTotalAmount>')
    expect(code(() => buildCii(fxDocument({ currency: "USD", tax_total_eur_minor: null })))).toBe(
      "facturx_fx_missing",
    )
  })

  test("delivery address only when given; structured buyer address always", () => {
    expect(buildCii(fxDocument())).toContain(
      "<ram:ApplicableHeaderTradeDelivery></ram:ApplicableHeaderTradeDelivery>",
    )
    const x = buildCii(
      fxDocument({
        delivery: {
          name: "Dépôt",
          line1: "9 quai",
          postcode: "13002",
          city: "Marseille",
          country_code: "fr",
        },
      }),
    )
    expect(x).toContain(
      "<ram:ShipToTradeParty><ram:Name>Dépôt</ram:Name><ram:PostalTradeAddress><ram:PostcodeCode>13002</ram:PostcodeCode>",
    )
    expect(x).toContain("<ram:CountryID>FR</ram:CountryID>")
  })

  test("incomplete parties and inconsistent totals are refused with a stable code", () => {
    const d = fxDocument()
    expect(code(() => buildCii({ ...d, seller: { ...d.seller, siren: null } }))).toBe(
      "facturx_seller_incomplete",
    )
    expect(
      code(() =>
        buildCii({ ...d, buyer: { ...d.buyer, address: { ...d.buyer.address, city: " " } } }),
      ),
    ).toBe("facturx_buyer_incomplete")
    expect(code(() => buildCii({ ...d, tax_total_minor: d.tax_total_minor + 1n }))).toBe(
      "facturx_totals_inconsistent",
    )
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

describe("advances and finals after deposit", () => {
  const services = (over: Parameters<typeof fxDocument>[0] = {}) =>
    fxDocument({
      operation_category: "services",
      lines: [fxLine(1, "Advance 20% on quote D-2026-0040", "1", 1_280_000n)],
      ...over,
    })

  test("the type code and BT-23 for an advance and a final come from the read specification", () => {
    // BT-23 codes are a category letter and a payment digit, built here from both.
    const bt23 = (letter: string, digit: number) => [letter, digit].join("")
    // Advance: type 386 (prepayment invoice), due at issue, so services with digit 1.
    expect(typeCode({ type: "invoice", invoice_role: "advance" })).toBe("386")
    expect(businessProcessCode("services", "due")).toBe(bt23("S", 1))
    // Final after deposit: an ordinary 380 carrying the deposit in BT-23 (payment digit 4, for services, goods or mixed).
    expect(typeCode({ type: "invoice", invoice_role: "final" })).toBe("380")
    expect(businessProcessCode("services", "final_after_deposit")).toBe(bt23("S", 4))
    expect(businessProcessCode("goods", "final_after_deposit")).toBe("B4")
    expect(typeCode({ type: "credit_note", invoice_role: "advance" })).toBe("381")
    expect(typeCode({ type: "invoice", invoice_role: null })).toBe("380")

    const advance = buildCii(services({ invoice_role: "advance", payment_state: "due" }))
    expect(advance).toContain("<ram:TypeCode>386</ram:TypeCode>")
    expect(advance).toContain(`<ram:ID>${bt23("S", 1)}</ram:ID>`)
    const final = buildCii(
      services({
        invoice_role: "final",
        payment_state: "final_after_deposit",
        preceding: [{ number: "F-2026-0201", issue_date: "2026-04-16" }],
      }),
    )
    expect(final).toContain("<ram:TypeCode>380</ram:TypeCode>")
    expect(final).toContain(`<ram:ID>${bt23("S", 4)}</ram:ID>`)
    expect(final).toContain(
      '<ram:InvoiceReferencedDocument><ram:IssuerAssignedID>F-2026-0201</ram:IssuerAssignedID><ram:FormattedIssueDateTime><qdt:DateTimeString format="102">20260416</qdt:DateTimeString></ram:FormattedIssueDateTime></ram:InvoiceReferencedDocument>',
    )
    // A final after deposit never takes an advance type, and always cites its advances.
    expect(() =>
      buildCii(services({ invoice_role: "advance", payment_state: "final_after_deposit" })),
    ).toThrow(FacturxBuildError)
    expect(() =>
      buildCii(services({ invoice_role: "final", payment_state: "final_after_deposit" })),
    ).toThrow(FacturxBuildError)
  })

  test("an advance renders without the mentions not yet known and with every known one", () => {
    // Not known at an advance: delivery, the buyer's order number, the service period.
    const xml = buildCii(
      services({ invoice_role: "advance", payment_state: "due", delivery: null, po_number: null }),
    )
    expect(xml).toContain("<ram:TypeCode>386</ram:TypeCode>")
    expect(xml).not.toContain("BuyerOrderReferencedDocument")
    expect(xml).not.toContain("<ram:ShipToTradeParty>")
    // Known: number, issue date, both parties, VAT, totals and the payment mentions.
    expect(xml).toContain("<ram:ID>FA-2026-0042</ram:ID>")
    expect(xml).toContain("20261103")
    expect(xml).toContain("Maison Exemple SAS")
    expect(xml).toContain("Client Exemple SARL")
    expect(xml).toContain("<ram:RateApplicablePercent>20.00</ram:RateApplicablePercent>")
    expect(xml).toContain("<ram:TaxBasisTotalAmount>12800.00</ram:TaxBasisTotalAmount>")
    expect(xml).toContain('<ram:TaxTotalAmount currencyID="EUR">2560.00</ram:TaxTotalAmount>')
    expect(xml).toContain("<ram:GrandTotalAmount>15360.00</ram:GrandTotalAmount>")
    for (const code of ["PMT", "PMD", "AAB"])
      expect(xml).toContain(`<ram:SubjectCode>${code}</ram:SubjectCode>`)
  })

  test("a document's role reaches the Factur-X: an advance and a final with the advances it cites", () => {
    const base = {
      type: "invoice" as const,
      lines: [],
      issuer: { legal_name: "Maison Exemple SAS" },
    }
    const advance = facturxInputFrom({
      ...base,
      doc: {
        number: "F-2026-0201",
        issued_at: "2026-04-16",
        operation_category: "services",
        invoice_role: "advance",
        payment_state: "due",
      },
    })
    expect(advance.invoice_role).toBe("advance")
    expect(advance.preceding).toBeNull()
    const final = facturxInputFrom({
      ...base,
      doc: {
        number: "F-2026-0263",
        issued_at: "2026-06-30",
        operation_category: "services",
        invoice_role: "final",
        payment_state: "final_after_deposit",
        external_refs: {
          preceding_invoices: [
            { document_id: "a", number: "F-2026-0201", issue_date: "2026-04-16" },
          ],
        },
      },
    })
    expect(final.payment_state).toBe("final_after_deposit")
    expect(final.preceding).toEqual([{ number: "F-2026-0201", issue_date: "2026-04-16" }])
  })
})

describe("an invoice made from planned vs done", () => {
  test("each line states the month it covers", async () => {
    const { draftFromCard, harness } = await import("../__tests__/from-reconcile-harness")
    const { invoiceIssue } = await import("../mutations")
    const { FICTIONAL_SIRENS, FR_SELLER_IDENTITY, seedConfirmedIdentity } = await import(
      "../einvoicing/test-fixtures"
    )
    const h = harness()
    await h.db.update("issuer_profiles", "iss-1", { ...FR_SELLER_IDENTITY, vat_registered: true })
    const id = await draftFromCard(h)
    const { snapshot } = await seedConfirmedIdentity(h.db, {
      contact_id: "contact-fr-1",
      siren: FICTIONAL_SIRENS[0],
      name: "Maison Alpine SA",
      postcode: "69003",
      city: "Lyon",
    })
    await h.db.update("documents", id, {
      counterparty_contact_id: "contact-fr-1",
      counterparty_country: "FR",
      counterparty_vat_id: "FR55555555555",
      counterparty_address: "1 rue de l'Exemple, 69003 Lyon",
      ...snapshot,
    })
    // The existing e-invoicing gate and classification take the draft as any other invoice.
    expect(await invoiceIssue(h.ctx, { draft_id: id })).toMatchObject({ status: "completed" })
    const issued = h.db.__all("documents").find((d) => d.status === "issued") as Record<
      string,
      unknown
    >
    expect(issued).toMatchObject({ regime: "e_invoice", operation_category: "services" })
    const att = (
      h.renders.find((r) => r.template_kind === "invoicing:invoice_v1")?.attachments as
        | Array<{ name: string; bytesBase64: string }>
        | undefined
    )?.[0]
    expect(att?.name).toBe("factur-x.xml")
    const xml = Buffer.from(String(att?.bytesBase64), "base64").toString("utf8")
    expect(xml).toContain("<ram:ID>S1</ram:ID>")
    const period =
      '<ram:BillingSpecifiedPeriod><ram:StartDateTime><udt:DateTimeString format="102">20261001</udt:DateTimeString></ram:StartDateTime>' +
      '<ram:EndDateTime><udt:DateTimeString format="102">20261031</udt:DateTimeString></ram:EndDateTime></ram:BillingSpecifiedPeriod>'
    const items = xml.split("<ram:IncludedSupplyChainTradeLineItem>").slice(1)
    expect(items).toHaveLength(2)
    for (const item of items) expect(item).toContain(period)
    // The document states the month too (the invoicing period), once in its settlement.
    expect(xml.split(period).length - 1).toBe(3)
    // A document with no service month states none.
    expect(buildCii(fxDocument())).not.toContain("BillingSpecifiedPeriod")
  })

  test("a German issuer's invoice carries no French-only field", async () => {
    const { draftFromCard, harness } = await import("../__tests__/from-reconcile-harness")
    const { invoiceIssue, documentsSendToCustomer } = await import("../mutations")
    const h = harness()
    await h.db.update("issuer_profiles", "iss-1", {
      legal_name: "Maison Werk GmbH",
      country: "DE",
      vat_id: "DE811111111",
      address: "Torstrasse 1, 10119 Berlin",
      default_language: "de",
      siren: null,
      rcs_city: null,
      vat_registered: true,
    })
    const id = await draftFromCard(h)
    expect(await invoiceIssue(h.ctx, { draft_id: id })).toMatchObject({ status: "completed" })
    const issued = h.db.__all("documents").find((d) => d.status === "issued") as Record<
      string,
      unknown
    >
    // Out of the French e-invoicing scope: no Factur-X, no French identity terms.
    expect(issued.regime).not.toBe("e_invoice")
    const invoiceRender = h.renders.find((r) => r.template_kind === "invoicing:invoice_v1")
    expect(invoiceRender?.attachments).toBeUndefined()
    expect(await documentsSendToCustomer(h.ctx, { document_id: String(issued.id) })).toMatchObject({
      status: "completed",
    })
    const report = h.renders.find((r) => r.template_kind === "invoicing:activity_report_v1")
    const printed = JSON.stringify([invoiceRender?.data, report?.data, h.mails[0]])
    for (const french of [
      "SIREN",
      "RCS",
      "Option pour le paiement",
      "Indemnité forfaitaire",
      "Rapport d'activité",
      "Annexe à la facture",
      "Signé",
    ])
      expect(printed).not.toContain(french)
    expect((report?.data as { title?: string } | undefined)?.title).toBe("Activity report")
  })
})
