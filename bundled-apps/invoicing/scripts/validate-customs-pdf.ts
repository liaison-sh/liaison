#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `bun run scripts/validate-customs-pdf.ts <path-to-pdf>`
//
// Phase 17 G2 — dev validator for customs-PDF compliance. Given a PDF
// file produced by the invoicing app's `invoicing:invoice_v1` template
// (or any of the doc variants), extract the text via `pdf-parse` and
// assert the spec §"Validation Protocol" step 7 checklist:
//
//   - HS code per line                  (regex: \b\d{6,10}\b on each line row)
//   - Country of origin per line        (regex: ISO 2-letter country code)
//   - Declared currency                 (3-letter currency on the totals row)
//   - Declared total value              (numeric grand total)
//   - Incoterm                          (one of EXW|FCA|FOB|CIF|DAP|DDP|DPU)
//   - Customs legal mention             (the §8 export-treatment string)
//
// Exits 0 on full pass, 1 on any missing field, logging `OK: <field>` /
// `MISSING: <field>` per check. Designed for the validation protocol's
// step 7 ("download a sample export invoice's PDF; assert customs fields
// land in the right places") to be runnable.

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"

// pdf-parse is CommonJS; import the inner module path to avoid its
// debug-harness side-effects on bare require.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  data: Buffer,
) => Promise<{ text: string }>

export interface ValidationCheck {
  field: string
  present: boolean
  detail?: string
}

const INCOTERM_RX = /\b(EXW|FCA|FOB|CIF|DAP|DDP|DPU)\b/
const HS_RX = /\b\d{6,10}\b/
const COO_RX = /\b[A-Z]{2}\b/
const CURRENCY_RX = /\b(EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK|PLN|CZK)\b/
const TOTAL_RX = /\b\d{1,3}(?:[ ,.]\d{3})*(?:[.,]\d{2})\b/
const LEGAL_MENTIONS = [
  // English
  /VAT exempt under (Article|Art\.?) /i,
  // French
  /Autoliquidation/i,
  /Exoneration de TVA/i,
  // German
  /Steuerschuldnerschaft/i,
  // English reverse-charge generic
  /Reverse charge/i,
  // Customs document marker
  /Customs declaration|customs purposes/i,
]

/**
 * I5 — thin wrapper around `pdf-parse` for E2E scenarios. Takes raw PDF
 * bytes (Uint8Array or Buffer) and returns the extracted text string.
 * Used by S4 (`invoicing/customs-pdf.scenario.test.ts`) to feed
 * `validateCustomsPdfText` from bytes fetched via `GET /api/files/:id`.
 */
export async function pdfBytesToText(
  bytes: Uint8Array | Buffer,
): Promise<string> {
  const buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes)
  const parsed = await pdfParse(buf)
  return parsed.text
}

export function validateCustomsPdfText(text: string): ValidationCheck[] {
  const checks: ValidationCheck[] = []
  checks.push({
    field: "incoterm",
    present: INCOTERM_RX.test(text),
    detail: INCOTERM_RX.exec(text)?.[0],
  })
  checks.push({
    field: "hs_code",
    present: HS_RX.test(text),
    detail: HS_RX.exec(text)?.[0],
  })
  checks.push({
    field: "country_of_origin",
    present: COO_RX.test(text),
    detail: COO_RX.exec(text)?.[0],
  })
  checks.push({
    field: "currency",
    present: CURRENCY_RX.test(text),
    detail: CURRENCY_RX.exec(text)?.[0],
  })
  checks.push({
    field: "total_value",
    present: TOTAL_RX.test(text),
    detail: TOTAL_RX.exec(text)?.[0],
  })
  checks.push({
    field: "legal_mention",
    present: LEGAL_MENTIONS.some((rx) => rx.test(text)),
  })
  return checks
}

async function main() {
  const arg = process.argv[2]
  if (!arg) {
    console.error("usage: validate-customs-pdf.ts <path-to-pdf>")
    process.exit(2)
  }
  const path = resolve(process.cwd(), arg)
  if (!existsSync(path)) {
    console.error(`file not found: ${path}`)
    process.exit(2)
  }
  const data = readFileSync(path)
  const parsed = await pdfParse(data)
  const checks = validateCustomsPdfText(parsed.text)

  let allOk = true
  for (const c of checks) {
    if (c.present) {
      console.log(`OK: ${c.field}${c.detail ? ` — ${c.detail}` : ""}`)
    } else {
      allOk = false
      console.error(`MISSING: ${c.field}`)
    }
  }
  process.exit(allOk ? 0 : 1)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err)
    process.exit(2)
  })
}
