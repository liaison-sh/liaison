// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Reported twice by Quinn: the PDF generator renders non-Latin characters as
// "?". Confirmed on a real issued document -- INV-2026-3456 printed its Polish
// customer "Igor \u0141ukawski" as "Igor ?ukawski", because the base-14
// Helvetica the replayer embedded is WinAnsi and cannot encode anything above
// U+00FF, so the template stripped it first.
//
// The host now embeds Liberation Sans (metrically identical to Helvetica, so
// nothing that already rendered moves). These pin the sandbox half: what
// survives to the font, and what the last-resort fallback does with the little
// the font genuinely lacks.
import { describe, expect, test } from "bun:test"
import type { DrawCommand } from "@liaison/app-sdk"
import { renderTemplate as renderInvoice } from "./invoice"
import type { DocumentRenderInput } from "./shared"
import { sanitizeForPdfText, textWidth } from "./shared"

const POLISH_NAME = "Igor \u0141ukawski"

describe("sanitizeForPdfText", () => {
  test("keeps a Polish name intact -- the reported bug", () => {
    expect(sanitizeForPdfText(POLISH_NAME)).toBe(POLISH_NAME)
  })

  test("keeps the European names that were previously destroyed", () => {
    for (const name of [
      "\u0141ukasz \u017b\u00f3\u0142\u0107",
      "\u0160imon Dvo\u0159\u00e1k",
      "G\u00fcl\u015fen \u00c7elik",
      "\u00c6gir \u00de\u00f3rsson",
      "\u0218tefan M\u0103celaru",
    ]) {
      expect(sanitizeForPdfText(name)).toBe(name)
    }
  })

  test("keeps Greek and Cyrillic", () => {
    const greek = "\u0393\u03b9\u03ce\u03c1\u03b3\u03bf\u03c2"
    const cyrillic = "\u0414\u043c\u0438\u0442\u0440\u0438\u0439"
    expect(sanitizeForPdfText(greek)).toBe(greek)
    expect(sanitizeForPdfText(cyrillic)).toBe(cyrillic)
  })

  test("leaves plain ASCII byte-for-byte alone", () => {
    const ascii = "FABRIKAM SAS -- Invoice INV-2026-3456 / 1,794.57 EUR (VAT 23%)"
    expect(sanitizeForPdfText(ascii)).toBe(ascii)
  })

  test("still normalises typography to its plain forms", () => {
    // Not a coverage problem any more; invoices get pasted into accounting
    // systems and read by customs officers, and plain forms travel better.
    const fancy = "\u201cquoted\u201d \u2014 dash\u2026 5 \u00d7 3 \u2264 20"
    expect(sanitizeForPdfText(fancy)).toBe('"quoted" - dash... 5 x 3 <= 20')
    expect(sanitizeForPdfText("it\u2019s")).toBe("it's")
  })

  test("transliterates a glyph no bundled face covers, rather than printing a box", () => {
    // A .notdef renders as a blank or hollow box, which on an invoice reads as
    // a rendering fault; "?" is at least honest. CJK used to be in this
    // category and no longer is -- it now has a fallback face -- so this uses
    // Hebrew, which neither bundled face covers.
    const hebrew = "\u05e2\u05d1\u05e8\u05d9\u05ea"
    expect(sanitizeForPdfText(hebrew)).toBe("?????")
    expect(sanitizeForPdfText(`Tel Aviv ${hebrew} Ltd`)).toBe("Tel Aviv ????? Ltd")
  })

  test("never emits an empty string for non-empty input", () => {
    // A silently blanked counterparty name is far worse than "?": the invoice
    // still issues, addressed to nobody.
    for (const s of ["\u65e5\u672c", "\u05e2\u05d1\u05e8\u05d9\u05ea", " "]) {
      expect(sanitizeForPdfText(s).length).toBeGreaterThan(0)
    }
  })

  test("does not mangle the euro sign or other currency symbols", () => {
    expect(sanitizeForPdfText("1 794,57 \u20ac")).toBe("1 794,57 \u20ac")
  })

  test("is idempotent -- running it twice changes nothing further", () => {
    for (const s of [POLISH_NAME, "\u201cq\u201d \u2014 \u65e5\u672c", "plain"]) {
      expect(sanitizeForPdfText(sanitizeForPdfText(s))).toBe(sanitizeForPdfText(s))
    }
  })
})

describe("width metrics still describe the embedded face", () => {
  // Liberation Sans was chosen because its advances match the Adobe Helvetica
  // AFM values exactly. If that ever stopped being true, every wrap point and
  // every right-aligned figure would shift while these numbers stayed put.
  test("ASCII widths are unchanged by the font swap", () => {
    expect(textWidth("A", 10)).toBeCloseTo(6.67, 5)
    expect(textWidth("W", 10)).toBeCloseTo(9.44, 5)
    expect(textWidth("i", 10)).toBeCloseTo(2.22, 5)
    expect(textWidth(" ", 10)).toBeCloseTo(2.78, 5)
  })

  test("a non-ASCII letter measures as something, not zero", () => {
    // It falls back to the default advance. Approximate, but a zero width would
    // let a Polish name overrun its column silently.
    expect(textWidth("\u0141", 10)).toBeGreaterThan(0)
  })
})

describe("CJK, served by the fallback face", () => {
  // Prod carries 17 documents across 11 Japanese parties. The first pass of this
  // fix embedded Liberation Sans, which has no CJK, so those invoices still
  // printed "????????" -- the European half fixed and the reported bug still
  // live for a real customer.
  const COMPANY = "\u682a\u5f0f\u4f1a\u793e\u30a2\u30a4\u30b7\u30f3"
  const MIXED = `${COMPANY} YYSystem\u4e8b\u696d\u63a8\u9032\u90e8`

  test("passes a Japanese company name through untouched", () => {
    expect(sanitizeForPdfText(COMPANY)).toBe(COMPANY)
  })

  test("passes a real prod address through untouched", () => {
    const addr = "\u8efd\u4e95\u6ca2\u753a\u8ffd\u52061660-4"
    expect(sanitizeForPdfText(addr)).toBe(addr)
  })

  test("passes a name that MIXES scripts in one string", () => {
    // The awkward real case, and why the host splits into runs: one string, two
    // faces.
    expect(sanitizeForPdfText(MIXED)).toBe(MIXED)
  })

  test("measures a CJK glyph as full width, not as a Latin default", () => {
    // Under the old default advance a Japanese address measured barely half its
    // real width and ran past its column.
    const cjk = textWidth(COMPANY, 10)
    const latinSameCount = textWidth("A".repeat([...COMPANY].length), 10)
    expect(cjk).toBeGreaterThan(latinSameCount)
    expect(cjk).toBeCloseTo([...COMPANY].length * 10, 5)
  })

  test("still refuses a script no bundled face covers", () => {
    // Hebrew: neither Liberation nor Noto Sans JP has it, so it must keep
    // falling back rather than silently rendering as empty boxes.
    expect(sanitizeForPdfText("\u05e2\u05d1\u05e8\u05d9\u05ea")).toBe("?????")
  })
})

// ── Non-Latin SHIP TO ─────────────────────────────────────────────────────
//
// The ship to block goes through the SAME wrap/measure path as every other
// party block, so a Japanese consignee must survive it: the glyphs reach the
// font intact, and each line is measured at full CJK width so it is not laid
// out as if it were half as wide (the failure mode behind the original report).
describe("ship to block with a non-Latin address", () => {
  const JP_NAME = "株式会社テッセラ"
  const JP_ADDR = "東京都渋谷区神南１－２\n軽井沢町追分1660-4"

  function jpInput(): DocumentRenderInput {
    return {
      document: {
        type: "invoice",
        number: "INV-2026-9001",
        issued_at: "2026-05-15",
        due_at: "2026-06-14",
        currency: "EUR",
        subtotal_minor: 10000n,
        tax_total_minor: 0n,
        grand_total_minor: 10000n,
        tax_treatment: "export",
        incoterm: "DAP",
      },
      issuer: {
        legal_name: "Fabrikam SAS",
        country: "FR",
        vat_id: "FR12345678901",
        address: "1 rue de Test, 75001 Paris",
        iban: "FR7630006000011234567890189",
        swift_bic: "BNPAFRPP",
        bank_name: "BNP Test",
        default_language: "en",
      },
      counterparty: {
        legal_name: "Tessera Japan KK",
        country: "JP",
        vat_id: null,
        address: "1 Billing Street\nTokyo",
        shipping_address: JP_ADDR,
        shipping_name: JP_NAME,
      },
      line_items: [
        {
          position: 1,
          description: "Widget A",
          quantity: "1",
          unit_price_minor: 10000n,
          tax_rate_bp: 0,
          subtotal_minor: 10000n,
          tax_minor: 0n,
          total_minor: 10000n,
        },
      ],
      legal_mention: "",
      requires_hs_code: false,
    }
  }

  test("renders the Japanese consignee and address untouched, not as question marks", () => {
    const t = renderInvoice(jpInput())
      .filter((c) => c.op === "drawText")
      .map((c) => (c as { text: string }).text)
    expect(t).toContain("SHIP TO")
    expect(t).toContain(JP_NAME)
    for (const seg of JP_ADDR.split("\n")) expect(t).toContain(seg)
    expect(t.some((s) => s.includes("?"))).toBe(false)
  })

  test("measures each CJK ship to line at full width, so it is not under-wrapped", () => {
    const seg = JP_ADDR.split("\n")[0] as string
    expect(textWidth(seg, 9)).toBeCloseTo([...seg].length * 9, 5)
  })
})
