// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mailbox encryption words live in the kernel catalog, so the rules that
// used to hold for the string constants in mailbox-copy.ts are held here, over
// every shipped language: the approved claim is the spec's text verbatim, no
// forbidden promise appears, and no dash punctuation appears (the copy dash
// sweep walks the web sources, not the catalog).

import { describe, expect, it } from "vitest"
import { englishT, translatorFor } from "~/modules/i18n/i18n-context"
import {
  approvedZeroAccessClaim,
  FORBIDDEN_MAILBOX_PHRASES,
  mailboxPasswordExplainer,
  wrapLabel,
} from "~/modules/mailbox/mailbox-copy"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

/** Spec section 1, verbatim. A copy edit to the claim has to change the spec too. */
const SPEC_ZERO_ACCESS_CLAIM =
  "Your personal mailbox is stored with zero-access encryption. Liaison's servers and your organisation's admins cannot decrypt it. Mail arriving from the public internet is encrypted the moment it reaches us. It is not end to end encrypted between you and the sender, because standard email is not. Encryption protects the contents from being read. It does not prove who put a message in your mailbox, and it does not hide who you correspond with or when."

function leaves(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === "string") out.push([path, node])
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) leaves(value, `${path}.${key}`, out)
  }
}

const catalogs = { en, fr } as Record<string, { mailboxEncryption: unknown }>

describe("mailbox encryption copy", () => {
  it("states the approved claim verbatim in English", () => {
    expect(approvedZeroAccessClaim(englishT)).toBe(SPEC_ZERO_ACCESS_CLAIM)
  })

  for (const [locale, catalog] of Object.entries(catalogs)) {
    it(`carries no dash punctuation and no forbidden promise (${locale})`, () => {
      const strings: Array<[string, string]> = []
      leaves(catalog.mailboxEncryption, "mailboxEncryption", strings)
      // Non-vacuity: the whole section is read, not an empty object.
      expect(strings.length).toBeGreaterThan(150)
      for (const [path, text] of strings) {
        expect(text, path).not.toMatch(/[–—]|\s--\s/)
        for (const phrase of FORBIDDEN_MAILBOX_PHRASES) {
          expect(text.toLowerCase(), path).not.toContain(phrase)
        }
      }
    })
  }

  it("speaks French to a French reader, with the mailbox's own words", () => {
    const t = translatorFor("fr")
    expect(approvedZeroAccessClaim(t)).toContain("chiffrement à accès zéro")
    expect(wrapLabel("passphrase", t)).toBe("Mot de passe de la boîte")
    expect(wrapLabel("passkey_prf", t)).toBe("Clé d'accès")
    expect(mailboxPasswordExplainer(t)).toContain("mot de passe de la boîte")
    expect(wrapLabel("recovery_phrase", t)).toBeNull()
  })
})
