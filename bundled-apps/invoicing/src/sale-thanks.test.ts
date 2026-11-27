// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { planSaleMail, renderSaleThanks, type ThanksInput, thanksLanguage } from "./sale-thanks"

const issuer = {
  legal_name: "Atelier Nord SAS",
  address: "4 quai des Brumes\n59000 Lille",
  vat_id: "FR40303265045",
  siren: "303265045",
  legal_form: "SAS",
  share_capital: "10 000",
  rcs_city: "Lille",
  logo_file_id: "11111111-1111-4111-8111-111111111111",
  default_language: "en",
}

const sale = (over: Partial<ThanksInput> = {}): ThanksInput => ({
  issuer,
  buyer: { name: "Ana", language: "fr" },
  documents: [{ number: "INV-2026-0101", grand_total_minor: 11998n, currency: "EUR" }],
  lines: [
    { description: "Pack de sons <Nord>", quantity: "1", total_minor: 9999n },
    { description: "Extension", quantity: 1, total_minor: 1999n },
  ],
  sold_on: "2026-11-21",
  ...over,
})

describe("sale_thanks", () => {
  test("French buyer: French copy, lines, total, numbers, logo inline and the legal footer", () => {
    const m = renderSaleThanks(sale())
    expect(m.language).toBe("fr")
    expect(m.subject).toBe("Merci pour votre achat : facture INV-2026-0101")
    expect(m.html).toContain("Bonjour Ana,")
    expect(m.html).toContain('src="cid:issuer-logo"')
    expect(m.logoContentId).toBe("issuer-logo")
    expect(m.html).toContain("Pack de sons &lt;Nord&gt;")
    expect(m.html).not.toContain("<Nord>")
    expect(m.html).toContain("119.98 EUR")
    expect(m.html).toContain("Facture INV-2026-0101.")
    expect(m.html).toContain("SAS, capital 10 000 €")
    expect(m.html).toContain("SIREN 303265045 · RCS Lille")
    expect(m.text).toContain("- Pack de sons <Nord> x1: 99.99 EUR")
    expect(m.text).toContain("Total: 119.98 EUR")
    expect(m.text).toContain("4 quai des Brumes, 59000 Lille")
  })

  test("English by the issuer's language when the buyer's is unknown; a late sale names its date", () => {
    const m = renderSaleThanks(sale({ buyer: { name: null, language: "de" }, late: true }))
    expect(m.language).toBe("en")
    expect(m.subject).toBe("Your invoice INV-2026-0101 for your purchase of 2026-11-21")
    expect(m.html).toContain("Hello,")
    expect(m.text).toContain("Here is your invoice for your purchase of 2026-11-21.")
    expect(thanksLanguage(null, "fr")).toBe("fr")
  })

  test("an issuer's own words replace the defaults, with values escaped in the HTML", () => {
    const m = renderSaleThanks(
      sale({
        issuer: {
          ...issuer,
          email_templates: {
            sale_thanks_fr: {
              subject: "Votre commande {{numbers}}",
              html: "<p>Merci {{buyer_name}} !</p>",
              text: "Merci {{buyer_name}} !",
            },
          },
        },
        buyer: { name: "<b>Ana</b>", language: "fr" },
      }),
    )
    expect(m.subject).toBe("Votre commande INV-2026-0101")
    expect(m.html).toContain("<p>Merci &lt;b&gt;Ana&lt;/b&gt; !</p>")
    expect(m.text.startsWith("Merci <b>Ana</b> !")).toBe(true)
  })

  test("two invoices of one sale (goods and software) are one mail", () => {
    const m = renderSaleThanks(
      sale({
        documents: [
          { number: "INV-2026-0101", grand_total_minor: 9999n, currency: "EUR" },
          { number: "INV-2026-0102", grand_total_minor: 1999n, currency: "EUR" },
        ],
      }),
    )
    expect(m.subject).toContain("INV-2026-0101, INV-2026-0102")
    expect(m.html).toContain("Factures INV-2026-0101, INV-2026-0102.")
  })
})

describe("planSaleMail", () => {
  const plan = (over: Record<string, unknown>) =>
    planSaleMail({
      issuer: { ...issuer, mail_account_id: "acc-1", ...over },
      to: "ana@example.com",
      attachments: ["pdf-1", "pdf-2"],
      thanks: {
        buyer: { name: "Ana", language: "fr" },
        documents: sale().documents,
        lines: sale().lines,
        sold_on: "2026-11-21",
      },
    })

  test("an issuer that opted in sends the branded thanks from its mailbox, logo inline", () => {
    const p = plan({ sale_thanks_enabled: true })
    expect(p.kind).toBe("thanks")
    if (p.kind !== "thanks") return
    expect(p.params).toMatchObject({
      accountId: "acc-1",
      to: ["ana@example.com"],
      attachments: ["pdf-1", "pdf-2"],
      inlineImages: [{ fileId: issuer.logo_file_id, contentId: "issuer-logo" }],
    })
    expect(p.params.htmlBody).toContain("<html")
  })

  test("a profile that did not opt in keeps the plain invoice mail, only with auto-email on", () => {
    const p = plan({ sale_thanks_enabled: false, auto_email_enabled: true })
    expect(p.kind).toBe("invoice_paid")
    if (p.kind !== "invoice_paid") return
    expect(p.params.subject).toBe("Invoice INV-2026-0101")
    expect(p.params.textBody).toBe("Please find your invoice attached.")
    expect(p.params.htmlBody).toBeUndefined()
    expect(plan({ sale_thanks_enabled: false, auto_email_enabled: false }).kind).toBe("none")
  })

  test("no mailbox, no mail", () => {
    expect(plan({ sale_thanks_enabled: true, mail_account_id: null }).kind).toBe("no_mailbox")
  })
})
