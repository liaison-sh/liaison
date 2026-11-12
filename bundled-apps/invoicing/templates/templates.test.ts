// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Template command-shape tests (in-package, no host import).
//
// Templates now emit a sandboxed `DrawCommand[]` (no bytes). This file stays in
// the invoicing package and imports NOTHING from `apps/api` (the in-tree purity
// check enforces that), so it asserts on the COMMAND LIST shape:
//   - `drawText` commands carry the expected header / line / totals strings;
//   - `addPage` count is 1 for short docs, ≥2 for the long-description fixture;
//   - `setMetadata` carries the right Title.
// Byte-level parity (pdf-parse content + Producer + canary) lives host-side in
// apps/api/src/modules/pdf/invoicing-parity.test.ts, which can import the host
// replayer.

import { describe, expect, test } from "bun:test"
import type { DrawCommand } from "@liaison/app-sdk"
import { renderTemplate as creditNoteTemplate } from "./credit_note"
import { renderTemplate as invoiceTemplate } from "./invoice"
import { renderTemplate as poTemplate } from "./po"
import { renderTemplate as proformaTemplate } from "./proforma"
import { renderTemplate as quoteTemplate } from "./quote"
import type { DocumentRenderInput } from "./shared"
import { textWidth, wrapText } from "./shared"

function shortInput(overrides: Partial<DocumentRenderInput> = {}): DocumentRenderInput {
  return {
    document: {
      type: "invoice",
      number: "INV-2026-0042",
      issued_at: "2026-05-15",
      due_at: "2026-06-14",
      currency: "EUR",
      subtotal_minor: 10000n,
      tax_total_minor: 2000n,
      grand_total_minor: 12000n,
      tax_treatment: "standard",
      incoterm: "DAP",
    },
    issuer: {
      legal_name: "Société Générale Test SARL",
      country: "FR",
      vat_id: "FR12345678901",
      address: "1 rue de Test, 75001 Paris",
      iban: "FR7630006000011234567890189",
      swift_bic: "BNPAFRPP",
      bank_name: "BNP Test",
      default_language: "en",
    },
    counterparty: {
      legal_name: "Müller Handel GmbH",
      country: "DE",
      vat_id: "DE123456789",
      address: "Hauptstrasse 5, 10115 Berlin",
    },
    line_items: [
      {
        position: 1,
        description: "Widget A",
        quantity: "1",
        unit_price_minor: 10000n,
        tax_rate_bp: 2000,
        subtotal_minor: 10000n,
        tax_minor: 2000n,
        total_minor: 12000n,
      },
    ],
    legal_mention: "",
    requires_hs_code: false,
    ...overrides,
  }
}

// A long, WORD-WRAPPED (not single-token) description — long enough that
// real Helvetica-metric wrapping (~44 lines at 248pt width) overflows the
// available content height on page 1 and forces the D6 "overflow to page 2"
// invariant. A single 500-char unbroken token no longer forces this under
// accurate measurement (it wraps to only ~13 lines by character); the
// per-character break path is covered separately by the `wrapText` unit test.
function longInput(): DocumentRenderInput {
  const long =
    "Widget component premium industrial grade stainless steel assembly with corrosion resistant coating and extended warranty "
      .repeat(30)
      .trim()
  return shortInput({
    line_items: [
      {
        position: 1,
        description: long,
        quantity: "1",
        unit_price_minor: 10000n,
        tax_rate_bp: 2000,
        subtotal_minor: 10000n,
        tax_minor: 2000n,
        total_minor: 12000n,
      },
    ],
  })
}

function texts(cmds: DrawCommand[]): string[] {
  return cmds.filter((c) => c.op === "drawText").map((c) => (c as { text: string }).text)
}
function textCmds(
  cmds: DrawCommand[],
): Array<{ text: string; x: number; y: number; size: number; page: number }> {
  return cmds
    .filter((c) => c.op === "drawText")
    .map((c) => c as { text: string; x: number; y: number; size: number; page: number })
}
function lineCmds(
  cmds: DrawCommand[],
): Array<{ start: { x: number; y: number }; end: { x: number; y: number }; page: number }> {
  return cmds
    .filter((c) => c.op === "drawLine")
    .map(
      (c) => c as { start: { x: number; y: number }; end: { x: number; y: number }; page: number },
    )
}
function pageCount(cmds: DrawCommand[]): number {
  return cmds.filter((c) => c.op === "addPage").length
}
function title(cmds: DrawCommand[]): string | undefined {
  const meta = cmds.find((c) => c.op === "setMetadata") as { title?: string } | undefined
  return meta?.title
}

describe("invoicing pdf templates — command shape", () => {
  test("invoice — header + line + totals strings present; single page; unicode sanitized", () => {
    const cmds = invoiceTemplate(shortInput())
    const t = texts(cmds)
    expect(t).toContain("Société Générale Test SARL")
    expect(t).toContain("INV-2026-0042")
    // Counterparty unicode preserved (Latin-1 ü stays).
    expect(t).toContain("Müller Handel GmbH")
    expect(t).toContain("Widget A")
    expect(t).toContain("Subtotal")
    expect(t).toContain("Total due")
    expect(t.join("\n")).toContain("100.00 EUR")
    expect(t.join("\n")).toContain("120.00 EUR")
    expect(pageCount(cmds)).toBe(1)
    expect(title(cmds)).toMatch(/Invoice/i)
    // Unpaid invoice: the payment/banking box IS present so the customer knows where to pay.
    expect(t).toContain("Payment details")
    expect(t.join("\n")).toContain("FR7630006000011234567890189")
  })

  // red: drop the payment_status branch in shared.ts drawTotals/drawPaymentDetails -> a paid
  // invoice reverts to "Total due" + the banking box, exactly the field-reported bug.
  test("invoice: a settled (payment_status=paid) invoice reads 'Total' with 'Paid on', never 'Amount paid', and hides the banking box", () => {
    const cmds = invoiceTemplate(
      shortInput({
        document: {
          type: "invoice",
          number: "INV-2026-PAID1",
          issued_at: "2026-05-15",
          due_at: "2026-06-14",
          currency: "EUR",
          subtotal_minor: 10000n,
          tax_total_minor: 2000n,
          grand_total_minor: 12000n,
          tax_treatment: "standard",
          incoterm: "DAP",
          payment_status: "paid",
          paid_at: "2026-05-15",
        },
      }),
    )
    const t = texts(cmds)
    const joined = t.join("\n")
    // Already paid: "Total" plus its settlement status, never "Total due" (nothing is owed) and
    // never "Amount paid" (a split order's payment spans several documents, so no one document
    // can state what the customer paid).
    expect(t).toContain("Total")
    expect(t).not.toContain("Amount paid")
    expect(t).not.toContain("Total due")
    // Settlement date is surfaced.
    expect(joined).toContain("Paid on 2026-05-15")
    // The grand total is still shown (as the amount paid).
    expect(joined).toContain("120.00 EUR")
    // No "where to pay" instructions on a settled invoice — the banking box is suppressed even
    // though the issuer carries an IBAN.
    expect(t).not.toContain("Payment details")
    expect(joined).not.toContain("FR7630006000011234567890189")
  })

  // red: revert templates/shared.ts formatMoney to `abs / 100n` (drop the
  // currencyExponent branch) -> JPY renders "239.00 JPY" and the integer
  // "23900 JPY" assertions below fail.
  // red: drop the "Order" metaLine in shared.ts drawHeader -> the order reference
  // disappears from the PDF face and an invoice can no longer be matched back to
  // its store order by reading it.
  test("invoice — the Shopify order number renders as an Order line in the header meta", () => {
    const cmds = invoiceTemplate(
      shortInput({
        document: { ...shortInput().document, shopify_order_number: "#1149" },
      }),
    )
    const t = texts(cmds)
    expect(t).toContain("Order:")
    expect(t).toContain("#1149")
  })

  test("invoice — no Order line when the document carries no order number (manual invoice)", () => {
    const t = texts(invoiceTemplate(shortInput()))
    expect(t).not.toContain("Order:")
  })

  test("invoice — a blank order number renders no Order line (never an empty label)", () => {
    const t = texts(
      invoiceTemplate(
        shortInput({ document: { ...shortInput().document, shopify_order_number: "   " } }),
      ),
    )
    expect(t).not.toContain("Order:")
  })

  // red: drop the "PO number" metaLine in shared.ts drawHeader -> the customer's purchase
  // order reference disappears from the PDF face even though the document row carries it.
  test("invoice — the customer's PO number renders as a PO number line under Order", () => {
    const cmds = invoiceTemplate(
      shortInput({
        document: { ...shortInput().document, shopify_order_number: "#1149", po_number: "PO-4471" },
      }),
    )
    const t = texts(cmds)
    expect(t).toContain("PO number:")
    expect(t).toContain("PO-4471")
  })

  test("quote — the customer's PO number renders on the quote PDF", () => {
    const t = texts(
      quoteTemplate(shortInput({ document: { ...shortInput().document, po_number: "PO-9001" } })),
    )
    expect(t).toContain("PO number:")
    expect(t).toContain("PO-9001")
  })

  test("proforma — the customer's PO number renders on the proforma PDF", () => {
    const t = texts(
      proformaTemplate(
        shortInput({ document: { ...shortInput().document, po_number: "PO-2200" } }),
      ),
    )
    expect(t).toContain("PO number:")
    expect(t).toContain("PO-2200")
  })

  test("credit note — the customer's PO number renders on the credit note PDF", () => {
    const t = texts(
      creditNoteTemplate(
        shortInput({ document: { ...shortInput().document, po_number: "PO-3300" } }),
      ),
    )
    expect(t).toContain("PO number:")
    expect(t).toContain("PO-3300")
  })

  test("quote — the customer reference prints as a Customer ref line; blank prints nothing", () => {
    const t = texts(
      quoteTemplate(
        shortInput({
          document: {
            ...shortInput().document,
            po_number: "PO-9001",
            customer_reference: "crm-48213",
          },
        }),
      ),
    )
    expect(t).toContain("Customer ref:")
    expect(t).toContain("crm-48213")
    const none = texts(
      quoteTemplate(
        shortInput({ document: { ...shortInput().document, customer_reference: "  " } }),
      ),
    )
    expect(none).not.toContain("Customer ref:")
  })

  test("purchase order — po_number is never printed (this document already IS a purchase order)", () => {
    const t = texts(
      poTemplate(shortInput({ document: { ...shortInput().document, po_number: "PO-4471" } })),
    )
    expect(t).not.toContain("PO number:")
  })

  test("invoice — no PO number line when the document carries none", () => {
    const t = texts(invoiceTemplate(shortInput()))
    expect(t).not.toContain("PO number:")
  })

  test("invoice — a blank PO number renders no PO number line (never an empty label)", () => {
    const t = texts(
      invoiceTemplate(shortInput({ document: { ...shortInput().document, po_number: "   " } })),
    )
    expect(t).not.toContain("PO number:")
  })

  // ── free-text notes block ───────────────────────────────────────────────────
  // red: drop the drawNotes call (or the `notes` field on DocumentRenderInput) -> the contract
  // reference / customs mention an operator put on the document never reaches the page the
  // customer actually reads.
  test.each([
    ["invoice", invoiceTemplate],
    ["quote", quoteTemplate],
    ["proforma", proformaTemplate],
    ["purchase_order", poTemplate],
    ["credit_note", creditNoteTemplate],
  ] as const)("%s — the document notes render under the totals", (_type, render) => {
    const t = texts(
      render(
        shortInput({
          document: { ...shortInput().document, notes: "Contract FR-2026-118" },
        }),
      ),
    )
    expect(t).toContain("Notes")
    expect(t).toContain("Contract FR-2026-118")
  })

  test("invoice — author line breaks in the notes are preserved as separate drawn lines", () => {
    const t = texts(
      invoiceTemplate(
        shortInput({
          document: {
            ...shortInput().document,
            notes: "Contract FR-2026-118\nDelivery in 2 batches\nQuote our ref on the packing list",
          },
        }),
      ),
    )
    expect(t).toContain("Contract FR-2026-118")
    expect(t).toContain("Delivery in 2 batches")
    expect(t).toContain("Quote our ref on the packing list")
  })

  test("invoice — the notes block sits BELOW the totals and ABOVE the footer", () => {
    const cmds = invoiceTemplate(
      shortInput({
        document: { ...shortInput().document, notes: "Contract FR-2026-118" },
      }),
    )
    const all = textCmds(cmds)
    const total = all.find((c) => c.text === "Total due")!
    const label = all.find((c) => c.text === "Notes")!
    const body = all.find((c) => c.text === "Contract FR-2026-118")!
    expect(label.page).toBe(total.page)
    expect(label.y).toBeLessThan(total.y)
    expect(body.y).toBeLessThan(label.y)
    // Never in the reserved footer band (the page-number strip is drawn at y = 40).
    expect(body.y).toBeGreaterThan(40)
  })

  test("invoice — no notes, or a blank one, renders no Notes heading (never an empty label)", () => {
    expect(texts(invoiceTemplate(shortInput()))).not.toContain("Notes")
    expect(
      texts(invoiceTemplate(shortInput({ document: { ...shortInput().document, notes: "   " } }))),
    ).not.toContain("Notes")
  })

  test("invoice — a very long single-line note WRAPS and never overflows the page width", () => {
    const long = "Customs remark ".repeat(120).trim()
    const cmds = invoiceTemplate(
      shortInput({ document: { ...shortInput().document, notes: long } }),
    )
    const all = textCmds(cmds)
    const noteLines = all.filter((c) => c.text.startsWith("Customs remark"))
    expect(noteLines.length).toBeGreaterThan(1) // it wrapped rather than running off the edge
    for (const l of noteLines) {
      // Content box is 495pt wide starting at the 50pt left margin.
      expect(textWidth(l.text, l.size)).toBeLessThanOrEqual(495)
      expect(l.y).toBeGreaterThan(40) // stays above the footer band, paginating if it must
    }
  })

  test("invoice — JPY zero-decimal currency renders integer totals, no decimal split", () => {
    const cmds = invoiceTemplate(
      shortInput({
        document: {
          type: "invoice",
          number: "INV-2026-JPY1",
          issued_at: "2026-05-15",
          due_at: "2026-06-14",
          currency: "JPY",
          subtotal_minor: 23900n,
          tax_total_minor: 0n,
          grand_total_minor: 23900n,
          tax_treatment: "standard",
          incoterm: "DAP",
        },
        line_items: [
          {
            position: 1,
            description: "Yen Widget",
            quantity: "1",
            unit_price_minor: 23900n,
            tax_rate_bp: 0,
            subtotal_minor: 23900n,
            tax_minor: 0n,
            total_minor: 23900n,
          },
        ],
      }),
    )
    const joined = texts(cmds).join("\n")
    // Zero-decimal currency: integer major unit, no "." split, not 100x small.
    expect(joined).toContain("23900 JPY")
    expect(joined).not.toContain("239.00 JPY")
    expect(joined).not.toContain("239.00")
    expect(joined).toContain("Total due")
  })

  test("invoice — customs mention + HS code in commands; ≤ sanitized to <=", () => {
    const cmds = invoiceTemplate(
      shortInput({
        document: {
          type: "invoice",
          number: "INV-2026-0099",
          issued_at: "2026-05-15",
          due_at: "2026-06-14",
          currency: "EUR",
          subtotal_minor: 50000n,
          tax_total_minor: 0n,
          grand_total_minor: 50000n,
          tax_treatment: "export",
          incoterm: "DDP",
        },
        line_items: [
          {
            position: 1,
            description: "Export Widget",
            quantity: "1",
            unit_price_minor: 50000n,
            tax_rate_bp: 0,
            subtotal_minor: 50000n,
            tax_minor: 0n,
            total_minor: 50000n,
            hs_code: "8471.30",
            country_of_origin: "FR",
            customs_description: "Portable computer, ≤10kg",
          },
        ],
        legal_mention: "Export VAT-exempt under Art. 262 CGI",
        requires_hs_code: true,
      }),
    )
    const joined = texts(cmds).join("\n")
    expect(joined).toContain("Export VAT-exempt under Art. 262 CGI")
    expect(joined).toContain("8471.30")
    expect(joined).toContain("DDP")
    // ≤ sanitized sandbox-side to <=
    expect(joined).toContain("<=10kg")
    expect(joined).not.toContain("≤")
  })

  test("invoice — 500-char line description wraps to ≥2 pages", () => {
    const cmds = invoiceTemplate(longInput())
    expect(pageCount(cmds)).toBeGreaterThanOrEqual(2)
  })

  test("quote — Title says Quote; line + totals present", () => {
    const cmds = quoteTemplate(
      shortInput({
        document: {
          type: "quote",
          number: "QUO-2026-0001",
          issued_at: "2026-05-15",
          due_at: "2026-06-14",
          currency: "EUR",
          subtotal_minor: 10000n,
          tax_total_minor: 2000n,
          grand_total_minor: 12000n,
          tax_treatment: "standard",
          incoterm: "DAP",
        },
      }),
    )
    const t = texts(cmds)
    expect(t).toContain("QUO-2026-0001")
    expect(t).toContain("Widget A")
    expect(t.join("\n")).toContain("120.00 EUR")
    expect(pageCount(cmds)).toBe(1)
    expect(title(cmds)).toMatch(/Quote/i)
  })

  test("proforma — Title says Proforma; legal mention present", () => {
    const cmds = proformaTemplate(
      shortInput({
        document: {
          type: "proforma",
          number: "PRO-2026-0001",
          issued_at: "2026-05-15",
          due_at: null,
          currency: "EUR",
          subtotal_minor: 10000n,
          tax_total_minor: 0n,
          grand_total_minor: 10000n,
          tax_treatment: "export",
          incoterm: "DDP",
        },
        requires_hs_code: true,
        legal_mention: "Proforma - not a tax document",
      }),
    )
    const t = texts(cmds)
    expect(t).toContain("PRO-2026-0001")
    expect(texts(cmds).join("\n")).toContain("Proforma - not a tax document")
    expect(title(cmds)).toMatch(/Proforma/i)
  })

  test("po — Title says Purchase Order; Vendor label + counterparty present", () => {
    const cmds = poTemplate(
      shortInput({
        document: {
          type: "purchase_order",
          number: "PO-2026-0001",
          issued_at: "2026-05-15",
          due_at: null,
          currency: "EUR",
          subtotal_minor: 10000n,
          tax_total_minor: 2000n,
          grand_total_minor: 12000n,
          tax_treatment: "standard",
          incoterm: "DAP",
        },
      }),
    )
    const t = texts(cmds)
    expect(t).toContain("PO-2026-0001")
    expect(t).toContain("Müller Handel GmbH")
    // PO uses the "VENDOR" label branch, not "BILL TO".
    expect(t).toContain("VENDOR")
    expect(t).not.toContain("BILL TO")
    expect(title(cmds)).toMatch(/Purchase Order/i)
  })

  test("credit note — Title says Credit Note; reference line, reason, and negative totals render; footer present", () => {
    const cmds = creditNoteTemplate(
      shortInput({
        document: {
          type: "credit_note",
          number: "CN-2026-0001",
          issued_at: "2026-05-20",
          due_at: null,
          currency: "EUR",
          subtotal_minor: -10000n,
          tax_total_minor: -2000n,
          grand_total_minor: -12000n,
          tax_treatment: "standard",
          incoterm: "DAP",
          original_invoice_number: "INV-2026-0042",
          reason: "partial return — 2 of 10 units",
        },
        line_items: [
          {
            position: 1,
            description: "Widget A (return)",
            quantity: "1",
            unit_price_minor: -10000n,
            tax_rate_bp: 2000,
            subtotal_minor: -10000n,
            tax_minor: -2000n,
            total_minor: -12000n,
          },
        ],
      }),
    )
    const t = texts(cmds)
    expect(t).toContain("CN-2026-0001")
    expect(texts(cmds).join("\n")).toMatch(/Credit note for invoice INV-2026-0042/)
    expect(texts(cmds).join("\n")).toContain("Reason: partial return")
    expect(t).toContain("-100.00")
    expect(t).toContain("-120.00")
    expect(title(cmds)).toMatch(/Credit Note/i)
    // Page footer (issuer name + "Page N of M") is present like every other type.
    expect(texts(cmds).join("\n")).toMatch(/Page 1 of 1/)
  })

  test("credit note — no reference line when there is no original invoice", () => {
    const cmds = creditNoteTemplate(
      shortInput({
        document: {
          type: "credit_note",
          number: "CN-2026-0002",
          issued_at: "2026-05-20",
          due_at: null,
          currency: "EUR",
          subtotal_minor: -5000n,
          tax_total_minor: -1000n,
          grand_total_minor: -6000n,
          tax_treatment: "standard",
          incoterm: "DAP",
        },
      }),
    )
    expect(texts(cmds).join("\n")).not.toMatch(/Credit note for invoice/)
  })

  test("wrapText — every wrapped line measures within maxWidth", () => {
    const long =
      "This is a very long product description that should wrap across several lines instead of a single word per line, exercising real Helvetica measurement instead of a character budget."
    const maxWidth = 248
    const lines = wrapText(long, maxWidth, 9, false)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(textWidth(line, 9, false)).toBeLessThanOrEqual(maxWidth + 0.01)
    }
  })

  test("wrapText — an over-wide word after text keeps reading order", () => {
    const lines = wrapText("Ref: ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJ", 60, 9, false)
    expect(lines[0]).toBe("Ref:")
    expect(lines.slice(1).join("")).toBe("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJ")
  })

  test("wrapText — an ultra-long single token breaks by character and each chunk fits", () => {
    const long = "A".repeat(500)
    const maxWidth = 248
    const lines = wrapText(long, maxWidth, 9, false)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(textWidth(line, 9, false)).toBeLessThanOrEqual(maxWidth + 0.01)
    }
  })

  test("logo present → embedImage + drawImage commands carry the issuer's fileId", () => {
    const fileId = "5b9f6e1e-9d1c-4a3a-8f0e-9c1a2b3c4d5e"
    const cmds = invoiceTemplate(
      shortInput({
        issuer: {
          legal_name: "Société Générale Test SARL",
          country: "FR",
          vat_id: "FR12345678901",
          address: "1 rue de Test, 75001 Paris",
          iban: "FR7630006000011234567890189",
          swift_bic: "BNPAFRPP",
          bank_name: "BNP Test",
          default_language: "en",
          logo_file_id: fileId,
        },
      }),
    )
    const embed = cmds.find((c) => c.op === "embedImage")
    const draw = cmds.find((c) => c.op === "drawImage")
    expect(embed).toMatchObject({ fileId })
    expect(draw).toBeDefined()
    // No fallback text wordmark when a logo is present.
    expect(texts(cmds)).not.toContain("Société Générale Test SARL — logo fallback")
  })

  test("no logo → no image ops; issuer legal_name renders as the header wordmark", () => {
    const cmds = invoiceTemplate(shortInput())
    expect(cmds.find((c) => c.op === "embedImage")).toBeUndefined()
    expect(cmds.find((c) => c.op === "drawImage")).toBeUndefined()
    expect(texts(cmds)).toContain("Société Générale Test SARL")
  })

  test("multi-page doc: table header repeats on page ≥2, and every page carries Page N of M", () => {
    const cmds = invoiceTemplate(longInput())
    const total = pageCount(cmds)
    expect(total).toBeGreaterThanOrEqual(2)
    const tc = textCmds(cmds)
    // "Description" column label appears on every page the table spans.
    const descriptionPages = new Set(tc.filter((c) => c.text === "Description").map((c) => c.page))
    for (let p = 0; p < total; p++) {
      expect(descriptionPages.has(p)).toBe(true)
    }
    // Every page has a "Page N of M" footer stamp with the correct total.
    for (let p = 0; p < total; p++) {
      expect(tc.some((c) => c.page === p && c.text === `Page ${p + 1} of ${total}`)).toBe(true)
    }
  })

  test("customs sub-row renders when hs_code is present even with requires_hs_code=false", () => {
    const cmds = invoiceTemplate(
      shortInput({
        requires_hs_code: false,
        line_items: [
          {
            position: 1,
            description: "Widget A",
            quantity: "1",
            unit_price_minor: 10000n,
            tax_rate_bp: 2000,
            subtotal_minor: 10000n,
            tax_minor: 2000n,
            total_minor: 12000n,
            hs_code: "9207.90",
            country_of_origin: "FR",
            customs_description: "Electronic musical instrument",
          },
        ],
      }),
    )
    const joined = texts(cmds).join("\n")
    expect(joined).toContain("HS 9207.90")
    expect(joined).toContain("Origin FR")
    expect(joined).toContain("Electronic musical instrument")
  })

  test("regression: no drawLine y-coordinate falls within a same-page drawText row's [y, y+size] band", () => {
    const cmds = invoiceTemplate(shortInput())
    const texts_ = textCmds(cmds)
    const lines_ = lineCmds(cmds)
    for (const line of lines_) {
      // A horizontal rule (start.y === end.y) must never sit inside the
      // vertical band of a drawn text glyph on the same page — that's the
      // strikethrough-through-the-first-row bug this rewrite fixes.
      if (line.start.y !== line.end.y) continue
      for (const t of texts_) {
        if (t.page !== line.page) continue
        const bandLow = t.y
        const bandHigh = t.y + t.size
        expect(line.start.y > bandHigh || line.start.y < bandLow).toBe(true)
      }
    }
  })

  test("regression: pg timestamptz issued/due dates render as bare YYYY-MM-DD in the header", () => {
    // Re-renders rebuild template data from the persisted row, where dates are
    // full pg timestamps — those overflowed and overlapped the header labels.
    const cmds = invoiceTemplate(
      shortInput({
        document: {
          ...shortInput().document,
          issued_at: "2026-07-02 00:00:00+00",
          due_at: "2026-08-01 00:00:00+00",
        },
      }),
    )
    const drawn = texts(cmds)
    expect(drawn).toContain("2026-07-02")
    expect(drawn).toContain("2026-08-01")
    expect(drawn.some((t) => t.includes("00:00:00"))).toBe(false)
  })

  test("regression: a row's customs sub-row is never orphaned onto a later page than its description", () => {
    // Enough medium-height rows with customs sub-rows to force several page
    // breaks; every row (description + customs) must land whole on one page.
    const lines = Array.from({ length: 30 }, (_, i) => ({
      position: i + 1,
      description: `Bulk item ${i + 1} with a somewhat long description that wraps across a couple of lines in the description column of the items table`,
      quantity: "2",
      unit_price_minor: 1500n,
      tax_rate_bp: 0,
      subtotal_minor: 3000n,
      tax_minor: 0n,
      total_minor: 3000n,
      hs_code: "8544.42",
      country_of_origin: "CN",
      customs_description: `unit-${i + 1}-marker`,
    }))
    const cmds = invoiceTemplate(shortInput({ line_items: lines }))
    expect(pageCount(cmds)).toBeGreaterThan(1)
    const drawn = textCmds(cmds)
    for (let i = 1; i <= 30; i++) {
      const desc = drawn.find((c) => c.text.startsWith(`Bulk item ${i} `))
      const customs = drawn.find((c) => c.text.includes(`unit-${i}-marker`))
      if (!desc || !customs) throw new Error(`row ${i}: missing desc or customs command`)
      expect(customs.page).toBe(desc.page)
    }
  })
})

// ── Split-order scope notice ─────────────────────────────────────────────
describe("software-scope digital-delivery notice", () => {
  function textsOf(commands: DrawCommand[]): string[] {
    return commands
      .filter(
        (c): c is Extract<DrawCommand, { op: "drawText" }> =>
          (c as { op?: string }).op === "drawText",
      )
      .map((c) => String((c as { text?: unknown }).text ?? ""))
  }

  test("no scope renders a header notice — the split is data-level only, the invoice face stays clean", () => {
    for (const scope of ["software" as const, "goods" as const, null]) {
      const cmds = invoiceTemplate(shortInput({ document: { ...shortInput().document, scope } }))
      const texts = textsOf(cmds)
      expect(texts.some((t) => t.includes("No physical goods"))).toBe(false)
      expect(texts.some((t) => t.includes("Not a customs document"))).toBe(false)
      expect(texts.some((t) => t.includes("Software and services only"))).toBe(false)
    }
  })

  test("multiline counterparty address renders one drawText per address line", () => {
    const cmds = invoiceTemplate(
      shortInput({
        counterparty: {
          legal_name: "Pascal Client",
          country: "FR",
          vat_id: null,
          address: "11 Bis route Exemple\n78110 Le Vesinet\nFR",
          email: "pascal@example.com",
        },
      }),
    )
    const texts = textsOf(cmds)
    expect(texts).toContain("11 Bis route Exemple")
    expect(texts).toContain("78110 Le Vesinet")
    expect(texts).toContain("pascal@example.com")
  })
})

describe("line discount rendering", () => {
  test("a discounted line renders an explicit Discount sub-row", () => {
    const base = shortInput()
    const cmds = invoiceTemplate({
      ...base,
      line_items: [
        {
          ...base.line_items[0]!,
          unit_price_minor: 57417n,
          discount_minor: 28709n,
          subtotal_minor: 28708n,
          tax_minor: 5742n,
          total_minor: 34450n,
        },
      ],
    })
    const texts = cmds
      .filter((c) => (c as { op?: string }).op === "drawText")
      .map((c) => String((c as { text?: unknown }).text ?? ""))
    expect(texts).toContain("Discount")
    expect(texts.some((t) => t.includes("-287.09"))).toBe(true)
  })

  test("no discount, no Discount sub-row", () => {
    const cmds = invoiceTemplate(shortInput())
    const texts = cmds
      .filter((c) => (c as { op?: string }).op === "drawText")
      .map((c) => String((c as { text?: unknown }).text ?? ""))
    expect(texts).not.toContain("Discount")
  })
})

// The split exists so a customs officer sees the physical goods and NOTHING
// else. A note on the goods invoice pointing at a companion document would
// defeat the purpose and invite a request for it. One was added on 2026-08-27
// and removed the same day. Whatever links the two halves belongs in our own
// UI, never on the artifact that leaves the building.
describe("split-order scope stays OFF the PDF", () => {
  const render = (scope: "goods" | "software" | null): string =>
    texts(
      invoiceTemplate(
        shortInput({
          document: { ...shortInput().document, scope, shopify_order_number: "#3427" },
        } as Partial<DocumentRenderInput>),
      ),
    ).join(" ")

  test("a goods invoice never hints that another document exists", () => {
    const text = render("goods")
    expect(text).not.toMatch(/invoiced separately/i)
    expect(text).not.toMatch(/digital items/i)
    expect(text).not.toMatch(/companion|other invoice|second invoice/i)
  })

  test("a software invoice does not cross-reference the goods invoice either", () => {
    // Both halves can end up in the same hands; symmetry matters here too.
    const text = render("software")
    expect(text).not.toMatch(/invoiced separately/i)
    expect(text).not.toMatch(/physical goods are invoiced/i)
  })

  test("scope changes nothing in the rendered output at all", () => {
    expect(render("goods")).toBe(render(null))
    expect(render("software")).toBe(render(null))
  })
})

// ── SHIP TO block ─────────────────────────────────────────────────────────
//
// Requested by Priya for real customer invoices: an order billed to one address
// and shipped to another printed only ONE address, so the parcel's destination
// never reached the paper the customs officer reads. The document now stores a
// ship to of its own and the template prints a third party block for it, but
// ONLY when there is something extra to say.
describe("ship to party block", () => {
  const BILL = "Hauptstrasse 5\n10115 Berlin"
  const SHIP = "Logistikzentrum Ost\nAm Hafen 12\n21079 Hamburg\nDE"

  function shipInput(overrides: Record<string, unknown> = {}): DocumentRenderInput {
    return shortInput({
      counterparty: {
        legal_name: "Müller Handel GmbH",
        country: "DE",
        vat_id: "DE123456789",
        address: BILL,
        ...overrides,
      },
    })
  }

  test("renders BOTH blocks when the shipping address differs from the billing address", () => {
    const t = texts(invoiceTemplate(shipInput({ shipping_address: SHIP })))
    expect(t).toContain("BILL TO")
    expect(t).toContain("SHIP TO")
    expect(t).toContain("Hauptstrasse 5")
    expect(t).toContain("Logistikzentrum Ost")
    expect(t).toContain("Am Hafen 12")
    expect(t).toContain("21079 Hamburg")
  })

  test("renders the consignee name on the SHIP TO block, falling back to the billed name", () => {
    const named = texts(
      invoiceTemplate(shipInput({ shipping_address: SHIP, shipping_name: "Spedition Nord KG" })),
    )
    expect(named).toContain("Spedition Nord KG")
    const unnamed = texts(invoiceTemplate(shipInput({ shipping_address: SHIP })))
    expect(unnamed).toContain("SHIP TO")
    // No consignee given: the billed name is reused, so the block is never headless.
    expect(unnamed.filter((s) => s === "Müller Handel GmbH").length).toBe(2)
  })

  test("prints only BILL TO when the shipping address is the SAME address", () => {
    const t = texts(invoiceTemplate(shipInput({ shipping_address: BILL })))
    expect(t).toContain("BILL TO")
    expect(t).not.toContain("SHIP TO")
  })

  test("prints only BILL TO when the two differ ONLY in whitespace or case", () => {
    const respelled = "  hauptstrasse 5 \n\n 10115   BERLIN  "
    const t = texts(invoiceTemplate(shipInput({ shipping_address: respelled })))
    expect(t).not.toContain("SHIP TO")
  })

  // The already-issued case: every document created before this feature existed carries no ship
  // to at all. Its PDF must re-render byte-identically, not merely "without crashing".
  test("an already issued document with NO stored ship to renders exactly as before", () => {
    const withoutField = invoiceTemplate(shipInput())
    const withNulls = invoiceTemplate(shipInput({ shipping_address: null, shipping_name: null }))
    const withEmpty = invoiceTemplate(shipInput({ shipping_address: "   " }))
    expect(texts(withoutField)).not.toContain("SHIP TO")
    expect(JSON.stringify(withNulls)).toBe(JSON.stringify(withoutField))
    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(withoutField))
  })

  test("a long ship to pushes the items table DOWN instead of colliding with it", () => {
    const long = Array.from({ length: 8 }, (_, i) => `Ship to address line ${i + 1}`).join("\n")
    const lowestShipLine = (cmds: DrawCommand[]): number =>
      Math.min(
        ...textCmds(cmds)
          .filter((c) => c.text.startsWith("Ship to address line"))
          .map((c) => c.y),
      )
    const cmds = invoiceTemplate(shipInput({ shipping_address: long }))
    const shipLines = textCmds(cmds).filter((c) => c.text.startsWith("Ship to address line"))
    expect(shipLines).toHaveLength(8)
    const header = textCmds(cmds).find((c) => c.text === "Description")
    expect(header).toBeDefined()
    // The items table header sits strictly BELOW the last ship to line (PDF y grows upward).
    expect(header?.y ?? 0).toBeLessThan(lowestShipLine(cmds))
  })

  test("the ship to block is styled exactly like the other party blocks", () => {
    const cmds = invoiceTemplate(
      shipInput({ shipping_address: SHIP, shipping_name: "Spedition Nord KG" }),
    )
    const byText = (t: string) => textCmds(cmds).find((c) => c.text === t)
    expect(byText("SHIP TO")?.size).toBe(byText("BILL TO")?.size)
    expect(byText("Spedition Nord KG")?.size).toBe(byText("Müller Handel GmbH")?.size)
    expect(byText("Am Hafen 12")?.size).toBe(byText("Hauptstrasse 5")?.size)
    // Same column as BILL TO, directly underneath it.
    expect(byText("SHIP TO")?.x).toBe(byText("BILL TO")?.x)
    expect(byText("SHIP TO")?.y ?? 0).toBeLessThan(byText("BILL TO")?.y ?? 0)
  })

  test("a ship to country never reaches the rendered tax treatment", () => {
    // The document's tax_treatment is computed upstream from counterparty_country; a ship to in
    // another country must not change a single byte of what the template prints beyond the block.
    const domestic = invoiceTemplate(shipInput())
    const exported = invoiceTemplate(shipInput({ shipping_address: "1 Export Road\nNew York\nUS" }))
    const shipOnly = new Set(["SHIP TO", "1 Export Road", "New York", "US", "Müller Handel GmbH"])
    expect(texts(exported).filter((t) => !shipOnly.has(t))).toEqual(
      texts(domestic).filter((t) => !shipOnly.has(t)),
    )
  })
})

// red: drop the showTax gate in shared.ts (drawTableHeader / the row cell / drawTotals) -> an export
// invoice prints a "Tax %" column and a "Tax (0.00%)" row right above "VAT-exempt under Article 146".
describe("exempt documents print no tax column", () => {
  const exportInput = (taxBp: number, taxMinor: bigint): DocumentRenderInput =>
    shortInput({
      document: {
        ...shortInput().document,
        tax_treatment: "eu_export_non_eu",
        subtotal_minor: 10000n,
        tax_total_minor: taxMinor,
        grand_total_minor: 10000n + taxMinor,
      },
      line_items: [
        {
          position: 1,
          description: "Widget A",
          quantity: "1",
          unit_price_minor: 10000n,
          tax_rate_bp: taxBp,
          subtotal_minor: 10000n,
          tax_minor: taxMinor,
          total_minor: 10000n + taxMinor,
        },
      ],
      legal_mention:
        "Export of goods outside the European Union: VAT-exempt under Article 146 of Directive 2006/112/EC.",
    })

  test("an untaxed export invoice has no Tax % column and no Tax totals row", () => {
    const t = texts(invoiceTemplate(exportInput(0, 0n)))
    expect(t).not.toContain("Tax %")
    expect(t.some((x) => x.startsWith("Tax"))).toBe(false)
    expect(t).not.toContain("0.00%")
    expect(t).toContain("Subtotal")
    expect(t.join("\n")).toContain("VAT-exempt under Article 146")
  })

  test("a domestic invoice keeps its Tax % column and Tax row", () => {
    const t = texts(invoiceTemplate(shortInput()))
    expect(t).toContain("Tax %")
    expect(t).toContain("20.00%")
    expect(t).toContain("Tax (20.00%)")
  })

  test("an exempt invoice that carries tax keeps the figures its total includes", () => {
    const t = texts(invoiceTemplate(exportInput(725, 725n)))
    expect(t).toContain("Tax %")
    expect(t).toContain("Tax (7.25%)")
  })
})

describe("S25 identity blocks and mentions", () => {
  const frIssuer = {
    legal_name: "Atelier Exemple",
    country: "FR",
    vat_id: "FR40123456789",
    address: "1 rue de Test, 75001 Paris",
    iban: null,
    swift_bic: null,
    bank_name: null,
    default_language: "fr" as const,
    siren: "123456789",
    legal_form: "SAS",
    share_capital: "10 000",
    rcs_city: "Paris",
  }
  const all = (cmds: DrawCommand[]) => texts(cmds).join("\n")

  test("seller SIREN, legal form, capital, RCS print in the block and the footer on every page", () => {
    const cmds = invoiceTemplate(shortInput({ issuer: frIssuer }))
    const j = all(cmds)
    expect(j).toContain("SIREN 123456789")
    expect(j).toContain("SAS au capital de 10 000 €")
    expect(texts(cmds)).toContain(
      "Atelier Exemple · SAS au capital de 10 000 € · RCS Paris 123456789 · VAT FR40123456789",
    )
  })

  test("a long legal form and capital wrap inside the seller column, and the footer never reaches the page number", () => {
    const longIssuer = {
      ...frIssuer,
      legal_name: "Atelier Exemple de Fabrication Industrielle",
      legal_form: "Société par actions simplifiée à associé unique",
      share_capital: "12 345 678,90",
      rcs_city: "Boulogne-sur-Mer",
    }
    const identity = "Société par actions simplifiée à associé unique au capital de 12 345 678,90 €"
    // Preconditions: one line would overflow the 250pt seller column, and the footer would run
    // past the page number on the right.
    expect(textWidth(identity, 9)).toBeGreaterThan(250)
    const footerFull = `${longIssuer.legal_name} · ${identity} · RCS Boulogne-sur-Mer 123456789 · VAT FR40123456789`
    expect(textWidth(footerFull, 7.5)).toBeGreaterThan(495 - textWidth("Page 1 of 2", 7.5))

    const cmds = invoiceTemplate({ ...longInput(), issuer: longIssuer })
    expect(pageCount(cmds)).toBeGreaterThan(1)
    const all9 = textCmds(cmds).filter((c) => c.size === 9 && c.x === 50 && c.page === 0)
    // The identity line prints whole, across wrapped lines, each inside the column.
    const idLines = all9.filter((c) => c.text.length > 3 && identity.includes(c.text))
    expect(idLines.length).toBeGreaterThan(1)
    expect(idLines.map((c) => c.text).join(" ")).toBe(identity)
    for (const l of idLines) expect(textWidth(l.text, 9)).toBeLessThanOrEqual(250)

    for (let p = 0; p < pageCount(cmds); p++) {
      const footer = textCmds(cmds).filter((c) => c.page === p && c.size === 7.5 && c.y < 70)
      const pageNo = footer.find((c) => /^Page \d+ of \d+$/.test(c.text))
      expect(pageNo).toBeDefined()
      const left = footer.filter((c) => c !== pageNo)
      expect(left.length).toBeGreaterThan(0)
      // Every footer line ends clear of the page number and stays inside the footer zone.
      for (const l of left) {
        expect(l.x + textWidth(l.text, l.size)).toBeLessThan((pageNo as { x: number }).x - 6)
        expect(l.y + l.size).toBeLessThan(70)
        expect(l.y).toBeGreaterThanOrEqual(20)
      }
      // Nothing is lost: the wrapped footer reads as the full line.
      expect(
        left
          .sort((a, b) => b.y - a.y)
          .map((c) => c.text)
          .join(" "),
      ).toBe(footerFull)
    }
  })

  test("a seller with no identity keeps the old footer", () => {
    const cmds = invoiceTemplate(shortInput())
    expect(texts(cmds)).toContain("Société Générale Test SARL · VAT FR12345678901")
    expect(all(cmds)).not.toContain("SIREN")
  })

  test("buyer SIREN prints when set, and only then", () => {
    const withSiren = invoiceTemplate(
      shortInput({
        counterparty: {
          legal_name: "Acheteur SA",
          country: "FR",
          vat_id: null,
          address: "2 rue B, 69001 Lyon",
          siren: "987654321",
        },
      }),
    )
    expect(all(withSiren)).toContain("SIREN 987654321")
    expect(all(invoiceTemplate(shortInput()))).not.toContain("SIREN")
  })

  test("operation label sits in the meta block", () => {
    const cmds = invoiceTemplate(
      shortInput({ document: { ...shortInput().document, operation_label: "Livraison de biens" } }),
    )
    expect(all(cmds)).toContain("Operation:")
    expect(texts(cmds)).toContain("Livraison de biens")
    expect(all(invoiceTemplate(shortInput()))).not.toContain("Operation:")
  })

  test("VAT-on-debits literal prints under the mention only when set", () => {
    const on = invoiceTemplate(
      shortInput({
        legal_mention: "Exonération de TVA, article 262 ter I du CGI",
        document: { ...shortInput().document, vat_on_debits: true },
      }),
    )
    const j = all(on)
    expect(j).toContain("Exonération de TVA, article 262 ter I du CGI")
    expect(j).toContain("Option pour le paiement de la taxe d'après les débits")
    expect(j.indexOf("Exonération")).toBeLessThan(j.indexOf("Option pour"))
    // also with no mention at all
    expect(
      all(
        invoiceTemplate(
          shortInput({ document: { ...shortInput().document, vat_on_debits: true } }),
        ),
      ),
    ).toContain("Option pour le paiement")
    expect(
      all(
        invoiceTemplate(
          shortInput({ document: { ...shortInput().document, vat_on_debits: false } }),
        ),
      ),
    ).not.toContain("Option pour")
    expect(all(invoiceTemplate(shortInput()))).not.toContain("Option pour")
  })

  test("accented mentions survive sanitisation", () => {
    const mention = "Exportation hors Union européenne : exonération de TVA (article 262 I du CGI)"
    expect(all(invoiceTemplate(shortInput({ legal_mention: mention })))).toContain(mention)
  })

  test("credit note against an imported original prints the original number and date", () => {
    const cmds = creditNoteTemplate(
      shortInput({
        document: {
          ...shortInput().document,
          type: "credit_note",
          number: "CN-2026-0002",
          original_invoice_number: "FA-2025-0042",
          original_invoice_date: "2025-11-03",
        },
      }),
    )
    expect(all(cmds)).toContain("Credit note for invoice FA-2025-0042 of 2025-11-03")
  })
})
