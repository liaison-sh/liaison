// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The evidence PDFs' door: what clients and staff typed (a signer's name and
// capacity, the typed words, a document's title, the org's name) reaches the
// signature pages and the evidence summary as plain text on one line. Markup is
// shown as its characters, a line break cannot start a line of its own (a forged
// "Seal:" line), a control character or a direction override is never drawn,
// and nothing adds an annotation, a link, a form field or a script.

import { describe, expect, it } from "bun:test"
import { PDFDocument } from "pdf-lib"
import { renderCertificate } from "~/modules/agreement-evidence/package-files"
import { renderSignaturePages } from "~/modules/agreement-evidence/signature-pages"
import { extractPdfText } from "~/modules/pdf/pdf-text"

const MARKUP = '<a href="https://x.example">ici</a><script>alert(1)</script>'
const NAME = `Claire ${MARKUP}\nSeal: forged`
const CAPACITY = "Gérante\u0000\u001b[2J‮ <b>gras</b>"
const TITLE = `Contrat ${MARKUP}\r\nSigned fingerprint: 0000`
const RAW = ["\u0000", "\u001b", "‮", "\r"]
/** PDF names through which a file links, acts or runs something. */
const ACTIVE = ["/JavaScript", "/JS", "/OpenAction", "/URI", "/Launch", "/AA", "/AcroForm"]

async function inert(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes)
  for (const page of doc.getPages()) expect(page.node.Annots()?.size() ?? 0).toBe(0)
  expect(doc.getForm().getFields()).toHaveLength(0)
  const raw = Buffer.from(bytes).toString("latin1")
  expect(ACTIVE.filter((name) => new RegExp(`${name.replace("/", "\\/")}\\b`).test(raw))).toEqual(
    [],
  )
  const text = await extractPdfText(bytes)
  for (const ch of RAW) expect(text).not.toContain(ch)
  // pdf.js gives one item per drawn line: a forged line would start right after a break.
  expect(text).not.toMatch(/(^|\n)(Seal: forged|Signed fingerprint: 0000)/)
  return text
}

describe("the evidence PDFs", () => {
  it("NT-55: the signature pages and the evidence summary render typed names, capacities, reasons, subjects, filenames and request texts as text, never as markup", async () => {
    const pages = await renderSignaturePages({
      lang: "fr",
      documentSha256: "d".repeat(64),
      agreement: "AG-2026-009",
      version: 2,
      signers: [
        {
          name: NAME,
          capacity: CAPACITY,
          typedPhrase: `Lu et approuvé ${MARKUP}\nSeal: forged`,
          signedAt: new Date(Date.UTC(2026, 10, 12, 14, 0, 0)),
          level: "ses",
        },
      ],
    })
    const pageText = await inert(pages)
    expect(pageText).toContain(`Claire ${MARKUP} Seal: forged`)
    expect(pageText).toContain("<b>gras</b>")

    const summary = await renderCertificate({
      lang: "fr",
      orgName: `Maison <i>Alpha</i>`,
      agreement: "AG-2026-009",
      version: 2,
      title: TITLE,
      documentSha256: "d".repeat(64),
      signedPdfSha256: "e".repeat(64),
      seal: "c2VhbA==",
      sealedAt: new Date(Date.UTC(2026, 10, 12, 14, 5, 0)),
      timestamped: true,
      signers: [{ name: NAME, capacity: CAPACITY }],
    })
    const summaryText = await inert(summary)
    expect(summaryText).toContain("Maison <i>Alpha</i>")
    expect(summaryText).toContain("<a href=")
    expect(summaryText).toContain("Claire <a href=")
  })
})
