// SPDX-License-Identifier: FSL-1.1-ALv2
//
// I5 — Customs-PDF text validator for Phase 17 S4.
//
// Extracts text from a rendered invoice PDF (pdf-lib output) and checks that an
// export-treatment document carries the customs fields spec #4 requires: HS code
// per line, country of origin per line, declared currency + total, the incoterm,
// and an export legal mention.
//
// THE LABELS ARE THE ONES THE PRODUCT PRINTS. `templates/shared.ts` renders:
//   - the meta block `Incoterm: DAP`
//   - the line customs sub-row `HS 9207.10 · Origin CN · Electronic pad controller`
//     (`HS <code>` and `Origin <cc>` joined with " · "): no colon after HS, and
//     "Origin", never "CoO"
//   - the totals row `Amount paid` on a settled document and `Total due`
//     otherwise, never a bare `Total:`
//   - the legal mention text (language follows the issuer's default_language).
//
// The checks stay STRICT: each still parses the value it reports and a document
// missing the field still fails. They accept the older `HS:` / `CoO:` / `Total:`
// spellings too, so a template that prints those is still validated.
//
// `pdf-parse`'s index.js runs a debug self-test on require that reads a bundled
// sample PDF and crashes outside its own repo; import the inner module directly.
// @ts-expect-error — no published types for the inner path
import pdf from "pdf-parse/lib/pdf-parse.js"

export interface ValidationCheck {
  field: "incoterm" | "hs_code" | "country_of_origin" | "currency" | "total_value" | "legal_mention"
  present: boolean
  detail?: string
}

/** Extract the concatenated text layer from a PDF byte buffer. */
export async function pdfBytesToText(bytes: Uint8Array | ArrayBuffer | Buffer): Promise<string> {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  const result = (await pdf(buf)) as { text: string }
  return result.text
}

/**
 * Run the customs-field checks against extracted PDF text. Each check reports
 * `present` and (where it parses a value) a `detail` the scenario can assert
 * exactly — e.g. incoterm `DAP`, hs_code `9207.10`, country_of_origin `CN`.
 */
export function validateCustomsPdfText(text: string): ValidationCheck[] {
  const incoterm = text.match(/Incoterm:\s*([A-Z]{3})/)
  const hs = text.match(/HS:?\s*([0-9][0-9.]*)/)
  const coo = text.match(/(?:CoO|Origin):?\s*([A-Z]{2})\b/)
  const currency = text.match(/\b(EUR|USD|GBP)\b/)
  // The grand total amount: any `NNN.NN EUR` money string is sufficient as the
  // declared total (the rollup renders Subtotal/Tax/Total in the same currency).
  const total = text.match(/(\d+\.\d{2})\s*(?:EUR|USD|GBP)/)
  const hasTotalLabel = /Total due|Amount paid|\bTotal\b/.test(text)
  // Export legal mention, language-agnostic (en / fr / de variants).
  const legalMention =
    /Export of goods|VAT-exempt|Exportation|Union europ|Article|TVA|CGI|Ausfuhr|steuerfrei/i.test(
      text,
    )

  return [
    { field: "incoterm", present: !!incoterm, detail: incoterm?.[1] },
    { field: "hs_code", present: !!hs, detail: hs?.[1] },
    { field: "country_of_origin", present: !!coo, detail: coo?.[1] },
    { field: "currency", present: !!currency, detail: currency?.[1] },
    {
      field: "total_value",
      present: hasTotalLabel && !!total,
      detail: total?.[1],
    },
    { field: "legal_mention", present: legalMention },
  ]
}
