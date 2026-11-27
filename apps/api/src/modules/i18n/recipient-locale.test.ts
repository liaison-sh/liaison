// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { renderBrandedEmail } from "~/infra/email-layout"
import { STEP_UP_PURPOSES, stepUpEmailCopy } from "~/modules/auth/step-up"
import { pickRecipientLocale } from "./recipient-locale"

describe("pickRecipientLocale", () => {
  it("prefers the recipient's choice, then their locale, the org's, the inviter's, then English", () => {
    expect(pickRecipientLocale({ userLanguage: "en", userLocale: "fr-FR", orgDefault: "fr" })).toBe(
      "en",
    )
    expect(pickRecipientLocale({ userLocale: "fr-FR", orgDefault: "en-US" })).toBe("fr")
    expect(pickRecipientLocale({ orgDefault: "fr-FR", inviterLanguage: "en" })).toBe("fr")
    expect(pickRecipientLocale({ orgDefault: "xx", inviterLanguage: "fr" })).toBe("fr")
    expect(pickRecipientLocale({ orgDefault: "xx", inviterLocale: "fr_CA" })).toBe("fr")
    expect(pickRecipientLocale({})).toBe("en")
  })
})

describe("system mail copy in French", () => {
  it("the layout's own words and lang follow the locale", () => {
    const fr = renderBrandedEmail({
      subject: "s",
      heading: "h",
      code: "123456",
      paragraphs: [],
      locale: "fr",
    })
    expect(fr.html).toContain('<html lang="fr">')
    expect(fr.text).toContain("Votre code de vérification est 123456")
    const en = renderBrandedEmail({ subject: "s", heading: "h", code: "123456", paragraphs: [] })
    expect(en.html).toContain('<html lang="en">')
    expect(en.text).toContain("Your verification code is 123456")
  })

  it("every step-up purpose has complete French copy, with no key left showing", () => {
    for (const purpose of [undefined, ...STEP_UP_PURPOSES]) {
      const fr = stepUpEmailCopy("123456", purpose, "fr")
      const en = stepUpEmailCopy("123456", purpose, "en")
      expect(fr.paragraphs.length).toBe(en.paragraphs.length)
      expect(fr.paragraphs.length).toBeGreaterThanOrEqual(2)
      for (const line of [fr.subject, fr.eyebrow, fr.heading, ...fr.paragraphs, ...fr.footer]) {
        expect(line).not.toContain("system-mail.")
      }
      expect(fr.subject).toContain("123456")
      expect(fr.subject).not.toBe(en.subject)
    }
    expect(stepUpEmailCopy("123456", "account_delete", "en").subject).toBe(
      "123456 is your code to delete your Liaison account",
    )
  })
})
