// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { extractPdfText } from "~/modules/pdf/pdf-text"
import {
  appendSignaturePages,
  canDrawText,
  plainText,
  renderSignaturePages,
  SIGNERS_PER_PAGE,
  SignaturePageError,
} from "./signature-pages"

const FP = "c".repeat(64)

async function frozenPdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= pages; i++) {
    doc.addPage([595, 842]).drawText(`Page ${i} sur ${pages}`, { x: 50, y: 50, size: 10, font })
  }
  return doc.save()
}

const signer = (i: number) => ({
  name: `Signataire ${i}`,
  capacity: `Président, pour Maison ${i}`,
  typedPhrase: i === 1 ? "Lu et approuvé" : null,
  signedAt: new Date(Date.UTC(2026, 10, 10, 9, 30, 0)),
  level: "ses",
})

describe("signature pages", () => {
  it("signature pages read back with their names, capacities, dates and fingerprint, and the frozen pages keep Page X sur Y", async () => {
    const frozen = await frozenPdf(2)
    const pages = await renderSignaturePages({
      lang: "fr",
      documentSha256: FP,
      agreement: "AG-2026-001",
      version: 2,
      signers: [signer(1), signer(2)],
    })
    const out = await appendSignaturePages(frozen, pages)
    expect(out.pageCount).toBe(3)
    expect(out.signaturePageCount).toBe(1)
    const text = await extractPdfText(out.bytes)
    expect(text).toContain("Page 1 sur 2")
    expect(text).toContain("Page 2 sur 2")
    expect(text).toContain("Page de signature 1 sur 1")
    expect(text).toContain("Signataire 1")
    expect(text).toContain("Président, pour Maison 2")
    expect(text).toContain("Lu et approuvé")
    expect(text).toContain("2026-11-10")
    expect(text).toContain("Signature électronique simple")
    expect(text).toContain(FP)
  })

  it("an English document gets English signature pages", async () => {
    const pages = await renderSignaturePages({
      lang: "en",
      documentSha256: FP,
      agreement: "AG-2026-002",
      version: 1,
      signers: [signer(1)],
    })
    const text = await extractPdfText(pages)
    expect(text).toContain("Signature page 1 of 1")
    expect(text).toContain("Simple electronic signature")
  })

  it("forty signers run over several numbered pages", async () => {
    const signers = Array.from({ length: 40 }, (_, i) => signer(i + 1))
    const pages = await renderSignaturePages({
      lang: "fr",
      documentSha256: FP,
      agreement: "AG-2026-003",
      version: 1,
      signers,
    })
    const doc = await PDFDocument.load(pages)
    const n = Math.ceil(40 / SIGNERS_PER_PAGE)
    expect(doc.getPageCount()).toBe(n)
    const text = await extractPdfText(pages)
    expect(text).toContain(`Page de signature ${n} sur ${n}`)
    expect(text).toContain("Signataire 40")
  })

  it("a signer's typed text is drawn as plain text: control characters and markup do nothing", async () => {
    const pages = await renderSignaturePages({
      lang: "en",
      documentSha256: FP,
      agreement: "AG-2026-004",
      version: 1,
      signers: [
        {
          ...signer(1),
          name: "Anne\u0000\u001b[31m<script>alert(1)</script>‮Morel",
          capacity: "<img src=x onerror=alert(1)>",
        },
      ],
    })
    const doc = await PDFDocument.load(pages)
    // No annotation, link or form field on the page: text only.
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0)
    expect(doc.getForm().getFields()).toHaveLength(0)
    const text = await extractPdfText(pages)
    expect(text).toContain("<script>alert(1)</script>")
    expect(text).not.toContain("\u0000")
    expect(text).not.toContain("‮")
    expect(plainText("a\u0007b")).toBe("a b")
  })

  it("a name no embedded face can draw is refused", async () => {
    expect(canDrawText("Pauline Gérard")).toBe(true)
    expect(canDrawText("株式会社アイシン")).toBe(true)
    expect(canDrawText("\u{1F600}\u{1F600}")).toBe(false)
    await expect(
      renderSignaturePages({
        lang: "en",
        documentSha256: FP,
        agreement: "AG-2026-005",
        version: 1,
        signers: [{ ...signer(1), name: "\u{1F600}" }],
      }),
    ).rejects.toBeInstanceOf(SignaturePageError)
  })
})
