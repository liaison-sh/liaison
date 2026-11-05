// SPDX-License-Identifier: FSL-1.1-ALv2
//
// End-to-end proof for the two defects found by LOOKING at a real issued PDF
// (INV-2026-3456, prod, 2026-08-27) rather than at a test:
//
//   1. the customer "Igor \u0141ukawski" printed as "Igor ?ukawski"
//   2. the Shopify order reference was absent from the meta block
//
// Unit tests covered both halves and both passed while the artifact was wrong,
// because each half was right in isolation: the template emitted the correct
// draw commands, and the replayer faithfully drew what it was handed. Only the
// composition -- template output replayed to real PDF bytes, then read back as
// text -- catches it. So this renders through the actual pipeline and extracts
// the text stream.
import { describe, expect, it } from "bun:test"
import { extractPdfText } from "~/modules/pdf/pdf-text"
import { replayDrawCommands } from "~/modules/pdf/replay"
import type { DocumentRenderInput } from "../../../../../bundled-apps/invoicing/templates/shared"
import { renderDocument } from "../../../../../bundled-apps/invoicing/templates/shared"

const POLISH = "Igor \u0141ukawski"

function input(overrides: Partial<DocumentRenderInput> = {}): DocumentRenderInput {
  return {
    document: {
      type: "invoice",
      number: "INV-2026-3456",
      issued_at: "2026-08-27",
      due_at: null,
      currency: "EUR",
      subtotal_minor: 145900n,
      tax_total_minor: 33557n,
      grand_total_minor: 179457n,
      tax_treatment: "standard",
      incoterm: "DAP",
      shopify_order_number: "#3408",
    },
    issuer: {
      legal_name: "FABRIKAM",
      country: "FR",
      vat_id: "FR81843725714",
      address: "81 rue des Exemples, 75018 Paris",
      iban: "FR7630006000011234567890189",
      swift_bic: "BNPAFRPP",
      bank_name: "BNP Test",
      default_language: "en",
    },
    counterparty: {
      legal_name: POLISH,
      country: "PL",
      vat_id: null,
      address: "Nowogrodzka 6A, 00-513 Warszawa",
    },
    line_items: [
      {
        position: 1,
        description: "Retail - Tessera",
        quantity: "2",
        unit_price_minor: 59900n,
        tax_rate_bp: 2300,
        subtotal_minor: 119800n,
        tax_minor: 27554n,
        total_minor: 147354n,
      },
    ],
    legal_mention: "",
    requires_hs_code: false,
    ...overrides,
  } as DocumentRenderInput
}

async function renderText(overrides: Partial<DocumentRenderInput> = {}): Promise<string> {
  const bytes = await replayDrawCommands(renderDocument(input(overrides)))
  return await extractPdfText(bytes)
}

describe("issued invoice, rendered end to end", () => {
  it("prints the Polish customer name, not a question mark", async () => {
    const text = await renderText()
    expect(text).toContain(POLISH)
    expect(text).not.toContain("?ukawski")
  })

  it("prints the Shopify order reference in the meta block", async () => {
    const text = await renderText()
    expect(text).toContain("Order:")
    expect(text).toContain("#3408")
  })

  it("omits the order line entirely for a manual invoice", async () => {
    // An empty "Order:" label is worse than no label at all.
    const text = await renderText({
      document: { ...input().document, shopify_order_number: null },
    })
    expect(text).not.toContain("Order:")
  })

  it("still prints the document number and the issuer", async () => {
    // Guard against a fix that renders the new things and breaks the old ones.
    const text = await renderText()
    expect(text).toContain("INV-2026-3456")
    expect(text).toContain("FABRIKAM")
  })
})

describe("a Japanese customer, rendered end to end", () => {
  // The exact prod value that still printed "????????" after the first pass of
  // the font fix (document 2687).
  const COMPANY =
    "\u682a\u5f0f\u4f1a\u793e\u30a2\u30a4\u30b7\u30f3 YYSystem\u4e8b\u696d\u63a8\u9032\u90e8"

  it("prints the Japanese company name, not question marks", async () => {
    const text = await renderText({
      counterparty: { ...input().counterparty, legal_name: COMPANY, country: "JP" },
    })
    expect(text).toContain("\u682a\u5f0f\u4f1a\u793e")
    expect(text).not.toContain("????")
  })

  it("keeps the Latin half of the same string in the document's own face", async () => {
    // The string mixes scripts; the Latin run must not silently switch typeface.
    const text = await renderText({
      counterparty: { ...input().counterparty, legal_name: COMPANY, country: "JP" },
    })
    expect(text).toContain("YYSystem")
  })

  it("still renders everything else on that document", async () => {
    const text = await renderText({
      counterparty: { ...input().counterparty, legal_name: COMPANY, country: "JP" },
    })
    expect(text).toContain("INV-2026-3456")
    expect(text).toContain("Order:")
  })
})
