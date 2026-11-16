// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seal's door: the words a signer typed reach the signed PDF's signature page
// as text and nothing else. A control character, a direction override or markup
// in the typed phrase cannot add an annotation, a link or a form field, and is
// never drawn raw.

import { describe, expect, it } from "bun:test"
import { PDFDocument } from "pdf-lib"
import { renderSignaturePages } from "~/modules/agreement-evidence/signature-pages"
import { extractPdfText } from "~/modules/pdf/pdf-text"

describe("the signature page", () => {
  it("NT-66: a typed phrase is drawn as text only, its control characters and overrides removed", async () => {
    const pages = await renderSignaturePages({
      lang: "fr",
      documentSha256: "d".repeat(64),
      agreement: "AG-2026-009",
      version: 2,
      signers: [
        {
          name: "Claire Morel",
          capacity: "Gérante",
          typedPhrase: "Lu\u0000 et\u001b[2J approuvé‮ <a href=\"https://x.example\">ici</a>",
          signedAt: new Date(Date.UTC(2026, 10, 12, 14, 0, 0)),
          level: "ses",
        },
      ],
    })
    const doc = await PDFDocument.load(pages)
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0)
    expect(doc.getForm().getFields()).toHaveLength(0)
    const text = await extractPdfText(pages)
    expect(text).toContain("Mention saisie")
    expect(text).toContain('<a href="https://x.example">ici</a>')
    for (const raw of ["\u0000", "\u001b", "‮"]) expect(text).not.toContain(raw)
  })
})
