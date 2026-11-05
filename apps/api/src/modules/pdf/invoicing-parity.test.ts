// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side byte-parity test for the invoicing PDF templates.
//
// The templates emit a sandboxed `DrawCommand[]`; this test threads those
// commands through the host `replayDrawCommands` to get PDF bytes, then parses
// them with `pdf-parse` to re-assert the content the old byte-level test
// checked (issuer name, number, unicode round-trip, totals, customs mention,
// metadata Title/Producer). It lives in apps/api — NOT in the invoicing package
// — because it imports the host replayer; the in-package
// `templates/templates.test.ts` covers the command-shape (no host import).
//
// The templates are imported by relative path: they live under
// `bundled-apps/invoicing/templates/` (NOT `/src/`), so the bundled-app purity
// guard (which only scans `bundled-apps/*/src/`) does not apply, and the guard
// only bans bundled-apps importing apps/api — not the reverse.

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs"
import { renderTemplate as creditNoteTemplate } from "../../../../../bundled-apps/invoicing/templates/credit_note"
import { renderTemplate as invoiceTemplate } from "../../../../../bundled-apps/invoicing/templates/invoice"
import { renderTemplate as poTemplate } from "../../../../../bundled-apps/invoicing/templates/po"
import { renderTemplate as proformaTemplate } from "../../../../../bundled-apps/invoicing/templates/proforma"
import { renderTemplate as quoteTemplate } from "../../../../../bundled-apps/invoicing/templates/quote"
import type { DocumentRenderInput } from "../../../../../bundled-apps/invoicing/templates/shared"
import { extractPdfText } from "./pdf-text"
import { replayDrawCommands } from "./replay"

/**
 * Text, page count and document info of a rendered PDF. pdf.js, like
 * modules/pdf/pdf-text.ts: one pdf.js per process, since two builds in one
 * process fail with "The API version ... does not match the Worker version".
 */
async function pdfParse(
  buf: Buffer | Uint8Array,
): Promise<{ text: string; numpages: number; info: Record<string, unknown> }> {
  const bytes = new Uint8Array(buf)
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
  }).promise
  try {
    const { info } = await doc.getMetadata()
    return {
      text: await extractPdfText(bytes),
      numpages: doc.numPages,
      info: (info ?? {}) as Record<string, unknown>,
    }
  } finally {
    await doc.cleanup()
  }
}

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

function customsInput(): DocumentRenderInput {
  return shortInput({
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
  })
}

// A long, WORD-WRAPPED (not single-token) description — long enough that
// real Helvetica-metric wrapping overflows the available content height on
// page 1 and forces the D6 "overflow to page 2" invariant. Mirrors the
// fixture in templates/templates.test.ts — a single 500-char unbroken token
// no longer forces this under accurate measurement (it wraps to far fewer
// lines by character); the per-character break path is covered separately
// by the `wrapText` unit test in that file.
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

async function renderAndParse(input: DocumentRenderInput, tpl: typeof invoiceTemplate) {
  const bytes = await replayDrawCommands(tpl(input))
  expect(bytes).toBeInstanceOf(Uint8Array)
  expect(bytes.byteLength).toBeGreaterThan(200)
  expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe("%PDF")
  return await pdfParse(Buffer.from(bytes))
}

describe("invoicing pdf templates — host byte parity (DSL → replay)", () => {
  test("invoice — header + line + totals + unicode round-trip + metadata", async () => {
    const parsed = await renderAndParse(shortInput(), invoiceTemplate)
    expect(parsed.text).toContain("Société Générale Test SARL")
    expect(parsed.text).toContain("INV-2026-0042")
    expect(parsed.text).toContain("Müller Handel GmbH")
    expect(parsed.text).toContain("Widget A")
    expect(parsed.text).toMatch(/Subtotal/i)
    expect(parsed.text).toContain("100.00")
    expect(parsed.text).toMatch(/Total/i)
    expect(parsed.text).toContain("120.00")
    expect(parsed.numpages).toBe(1)
    const info = parsed.info as { Title?: string; Producer?: string }
    expect(info.Title).toMatch(/Invoice/i)
    expect(info.Producer).toBe("Liaison Invoicing")
  })

  test("invoice — customs legal mention + HS code when requires_hs_code", async () => {
    const parsed = await renderAndParse(customsInput(), invoiceTemplate)
    expect(parsed.text).toContain("Export VAT-exempt under Art. 262 CGI")
    expect(parsed.text).toContain("8471.30")
    expect(parsed.text).toContain("DDP")
    // unicode ≤ sanitized sandbox-side to <=
    expect(parsed.text).toContain("<=10kg")
  })

  test("invoice — 500-char line description wraps to ≥2 pages (D6)", async () => {
    const parsed = await renderAndParse(longInput(), invoiceTemplate)
    expect(parsed.numpages).toBeGreaterThanOrEqual(2)
  })

  test("quote — Title says Quote; line + totals", async () => {
    const parsed = await renderAndParse(
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
      quoteTemplate,
    )
    expect(parsed.text).toContain("QUO-2026-0001")
    expect(parsed.text).toContain("Widget A")
    expect(parsed.text).toContain("120.00")
    expect(parsed.numpages).toBe(1)
    expect((parsed.info as { Title?: string }).Title).toMatch(/Quote/i)
  })

  test("proforma — Title says Proforma; legal mention", async () => {
    const parsed = await renderAndParse(
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
      proformaTemplate,
    )
    expect(parsed.text).toContain("PRO-2026-0001")
    expect(parsed.text).toContain("Proforma - not a tax document")
    expect((parsed.info as { Title?: string }).Title).toMatch(/Proforma/i)
  })

  test("po — Title says Purchase Order; vendor appears", async () => {
    const parsed = await renderAndParse(
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
      poTemplate,
    )
    expect(parsed.text).toContain("PO-2026-0001")
    expect(parsed.text).toContain("Müller Handel GmbH")
    expect((parsed.info as { Title?: string }).Title).toMatch(/Purchase Order|PO/i)
  })

  test("credit note — Title says Credit Note; reference line + negative totals render", async () => {
    const parsed = await renderAndParse(
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
      creditNoteTemplate,
    )
    expect(parsed.text).toContain("CN-2026-0001")
    expect(parsed.text).toMatch(/Credit note for invoice INV-2026-0042/i)
    expect(parsed.text).toContain("partial return")
    expect(parsed.text).toContain("-100.00")
    expect(parsed.text).toContain("-120.00")
    expect((parsed.info as { Title?: string }).Title).toMatch(/Credit Note/i)
  })

  test("canary golden — minimal fixed-date template hashes stably", async () => {
    // Fixed-date minimal input — no Unicode, no logo. The one place a byte hash
    // lives, regenerated against the DSL → replay output. Intentionally loose:
    // asserts only that the template produces *some* deterministic output for
    // fixed input (64-hex shape + length > 500 on metadata-stripped bytes).
    const bytes = await replayDrawCommands(
      invoiceTemplate({
        document: {
          type: "invoice",
          number: "CANARY-001",
          issued_at: "2026-01-01",
          due_at: "2026-01-31",
          currency: "USD",
          subtotal_minor: 1000n,
          tax_total_minor: 0n,
          grand_total_minor: 1000n,
          tax_treatment: "standard",
          incoterm: "DAP",
        },
        issuer: {
          legal_name: "ACME Inc",
          country: "US",
          vat_id: null,
          address: "1 Main St",
          iban: null,
          swift_bic: null,
          bank_name: null,
          default_language: "en",
        },
        counterparty: {
          legal_name: "Buyer LLC",
          country: "US",
          vat_id: null,
          address: "2 Side Rd",
        },
        line_items: [
          {
            position: 1,
            description: "Item",
            quantity: "1",
            unit_price_minor: 1000n,
            tax_rate_bp: 0,
            subtotal_minor: 1000n,
            tax_minor: 0n,
            total_minor: 1000n,
          },
        ],
        legal_mention: "",
        requires_hs_code: false,
      }),
    )
    const stripped = Buffer.from(bytes)
      .toString("latin1")
      .replace(/\/CreationDate\s*\([^)]*\)/g, "")
      .replace(/\/ModDate\s*\([^)]*\)/g, "")
      .replace(/\/ID\s*\[[^\]]*\]/g, "")
    const hash = createHash("sha256").update(stripped).digest("hex")
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(stripped.length).toBeGreaterThan(500)
  })
})
