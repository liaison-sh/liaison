// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S11 — a Factur-X looks the same to a human as the plain PDF: the invoicing templates emit the
// SAME draw commands whatever the output mode (the PDF/A finaliser only adds metadata, the
// OutputIntent and the attachment), the PDF/A render keeps every page and every word of the
// plain render, and one golden text per document type pins the layout's content.

import { describe, expect, it } from "bun:test"
import { PDFDocument } from "pdf-lib"
import type { DocumentRenderInput } from "../../../../../../bundled-apps/invoicing/templates/shared"
import { renderDocument } from "../../../../../../bundled-apps/invoicing/templates/shared"
import { extractPdfText } from "../pdf-text"
import { replayDrawCommands } from "../replay"

function input(type: "invoice" | "credit_note"): DocumentRenderInput {
  return {
    document: {
      type,
      number: type === "invoice" ? "FA-2026-0042" : "AV-2026-0007",
      issued_at: "2026-11-03",
      due_at: type === "invoice" ? "2026-12-03" : null,
      currency: "EUR",
      subtotal_minor: 71248n,
      tax_total_minor: 14250n,
      grand_total_minor: 85498n,
      tax_treatment: "eu_domestic",
      incoterm: "DAP",
      operation_label: "Livraison de biens",
      vat_on_debits: false,
      ...(type === "credit_note"
        ? { original_invoice_number: "FA-2026-0042", original_invoice_date: "2026-11-03" }
        : {}),
    },
    issuer: {
      legal_name: "Maison Exemple SAS",
      country: "FR",
      vat_id: "FR40902000009",
      address: "1 rue de Test, 75011 Paris",
      iban: "FR7630006000011234567890189",
      swift_bic: "AGRIFRPP",
      bank_name: "Banque Test",
      default_language: "fr",
      siren: "902000009",
      legal_form: "SAS",
      share_capital: "10 000 €",
      rcs_city: "Paris",
    },
    counterparty: {
      legal_name: "Client Exemple SAS",
      country: "FR",
      vat_id: "FR83900000001",
      address: "10 rue Domestic, 69002 Lyon",
      siren: "900000001",
    },
    line_items: [
      {
        position: 0,
        description: "Contrôleur",
        quantity: "2",
        unit_price_minor: 34999n,
        tax_rate_bp: 2000,
        subtotal_minor: 69998n,
        tax_minor: 14000n,
        total_minor: 83998n,
      },
      {
        position: 1,
        description: "Câble",
        quantity: "1",
        unit_price_minor: 1250n,
        tax_rate_bp: 2000,
        subtotal_minor: 1250n,
        tax_minor: 250n,
        total_minor: 1500n,
      },
    ],
    legal_mention: "",
    requires_hs_code: false,
  } as unknown as DocumentRenderInput
}

const PDFA = {
  level: "3b" as const,
  attachments: [
    {
      name: "factur-x.xml",
      mime: "text/xml",
      bytes: new TextEncoder().encode("<x/>"),
      afRelationship: "Data" as const,
    },
  ],
  now: new Date("2026-11-03T10:00:00Z"),
}

describe("S11: a Factur-X reads the same as the plain PDF", () => {
  for (const type of ["invoice", "credit_note"] as const) {
    it(`${type}: same draw commands, same pages, same text; golden text`, async () => {
      const commands = renderDocument(input(type))
      // The template is a pure function of its data: the output mode never reaches it.
      expect(renderDocument(input(type))).toEqual(commands)
      const plain = await replayDrawCommands(commands)
      const pdfa = await replayDrawCommands(commands, { pdfa: PDFA })
      const [p, a] = await Promise.all([
        PDFDocument.load(plain),
        PDFDocument.load(pdfa, { updateMetadata: false }),
      ])
      expect(a.getPageCount()).toBe(p.getPageCount())
      expect(a.getPages().map((pg) => pg.getSize())).toEqual(p.getPages().map((pg) => pg.getSize()))
      const plainText = await extractPdfText(plain)
      const pdfaText = await extractPdfText(pdfa)
      expect(pdfaText).toBe(plainText)
      expect(pdfaText).toMatchSnapshot()
    })
  }
})
