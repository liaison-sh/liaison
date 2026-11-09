// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A synthetic carrier label PDF with the structure Boxtal's FedEx labels have: standard Type1
// fonts, every stream ASCII85 then Flate encoded, an image stream beside the page content, and the
// AWB drawn as its own text run after a "TRK#" run. No real customer data.
import { deflateSync } from "node:zlib"

function ascii85Encode(bytes: Uint8Array): string {
  let out = ""
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = bytes.subarray(i, i + 4)
    const n = chunk.length
    let v = 0
    for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0)
    if (n === 4 && v === 0) {
      out += "z"
      continue
    }
    const digits: string[] = []
    for (let k = 0; k < 5; k++) {
      digits.unshift(String.fromCharCode((v % 85) + 33))
      v = Math.floor(v / 85)
    }
    out += digits.slice(0, n + 1).join("")
  }
  return `${out}~>`
}

function encodeStream(text: string): string {
  return ascii85Encode(new Uint8Array(deflateSync(Buffer.from(text, "latin1"))))
}

export function buildLabelPdf(lines: string[]): string {
  const content = lines
    .map((l, i) => `BT\n/F1 8 Tf\n75 Tz\n 1 0 0 1 7.08 ${400 - i * 12} Tm\n (${l.replace(/[()\\]/g, (c) => `\\${c}`)})Tj\nET`)
    .join("\n")
  const image = encodeStream("\u0000ÿ".repeat(64))
  const body = encodeStream(content)
  return [
    "%PDF-1.4",
    "1 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj",
    "3 0 obj\n<< /Type /Pages /Count 1 /Kids [18 0 R] >>\nendobj",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacRomanEncoding >>\nendobj",
    `12 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /Filter [/ASCII85Decode /FlateDecode] >>\nstream\n${image}\nendstream\nendobj`,
    // The real labels' resource dictionary names each FedEx logo XObject twice ("Multiple
    // definitions in dictionary" to a strict parser); kept so the reader is proven against it.
    "18 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 288 432] /Resources << /XObject << /FedExExpress 12 0 R\n/ExpressE 12 0 R\n/FedExExpress 12 0 R\n/ExpressE 12 0 R >> >> /Contents 19 0 R >>\nendobj",
    `19 0 obj\n<< /Length ${body.length}\n/Filter [/ASCII85Decode /FlateDecode] \n>>\nstream\n${body}\nendstream\nendobj`,
    "trailer\n<< /Root 1 0 R >>\n%%EOF",
  ].join("\n")
}

/** The lines a FedEx Regional Economy label draws, with a placeholder recipient. */
export const FEDEX_LABEL_LINES = [
  "SHIP DATE: 29SEP26",
  "TO",
  "(FR)",
  "TRK#",
  "",
  "ACTWGT: 4.00 KG",
  "DIMS: 59x38x8 CM",
  "ORIGIN ID:BLLD ",
  "4520749531",
  "TEST RECIPIENT",
  "1 TEST STREET",
  "CAD: 260849939/FAPI2208",
  "58KJ3/E7C0/484B",
  "8777 4092 5574",
  "   RGNL ECONOMY CLR",
  "J261026012002uv",
]

/**
 * A FedEx international label as Boxtal returns it for a UK recipient (2026-11): the recipient's
 * phone is printed as a bare 12-digit run, the AWB in groups of four with the 4-digit form code as
 * its own run after it, and the page drawn twice (label + AWB copy). Placeholder data only: the
 * phone is in the UK's reserved drama range.
 */
export const FEDEX_INTL_LABEL_LINES = [
  "SHIP DATE: 09NOV26",
  "TO",
  "(GB)",
  "TRK#",
  "",
  "ACTWGT: 4.00 KG",
  "DIMS: 59x38x8 CM",
  "0430",
  "ORIGIN ID:TEST ",
  "33100000000",
  "TEST SENDER",
  "1 TEST STREET",
  "CAD: 260849939/FAPI2208",
  "TEST RECIPIENT",
  "1 TEST ROAD",
  "LONDON LO SE1 1AA",
  "447700900123",
  "58KJ7/80FA/484B",
  "8777 4092 5574",
  "       RGNL ECONOMY",
  "J262026101502uv",
  "TRK#",
  "Form",
  "447700900123",
  "AWB",
  "8777 4092 5574",
  "0430",
  "FEDEX AWB COPY - PLEASE PLACE IN POUCH",
]
