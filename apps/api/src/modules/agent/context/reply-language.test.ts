// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { guessMessageLanguage, replyLanguageLine } from "./reply-language"

describe("reply language", () => {
  it("reads the production question as English, mention chip and all", () => {
    const q =
      "@[Personal agent](agent:ff29543a-52ed-438e-8519-ade964f26645) What are my current notification settings? Please list every group and channel, my quiet hours, and my email digest cadence."
    expect(guessMessageLanguage(q)).toBe("English")
    expect(replyLanguageLine(q)).toContain("writes in English: write your answer in English")
  })

  it("reads a French message as French", () => {
    expect(
      guessMessageLanguage(
        "Quels sont mes réglages de notification ? Donne-moi la liste de mes heures calmes.",
      ),
    ).toBe("French")
  })

  it("names no language when it cannot tell", () => {
    expect(guessMessageLanguage("ok")).toBeNull()
    expect(guessMessageLanguage("INV-2031 LVN-406")).toBeNull()
    expect(replyLanguageLine("ok")).toBe(
      "Write your answer in the language the person writes in, even where earlier messages in this conversation are in another language. The language of the data (addresses, names, files and tool results) never decides it.",
    )
    expect(replyLanguageLine(null)).toContain("language the person writes in")
  })
})

describe("reply language follows the person, never the data they paste", () => {
  // The walk: an English-speaking admin gave the company's Paris address for
  // the issuer profile, and the agent answered in French for three turns.
  const english = [
    "Please set up a support mailbox for us.",
    "Here are our invoices, please import them.",
    "I'm the administrator, go ahead with it.",
  ]
  const address =
    "Northwind Trading SAS, 12 rue de la Paix, 75002 Paris, France. VAT FR12345678901, SIREN 123456789."

  it("keeps the person's language when a message is mostly a French address", () => {
    expect(replyLanguageLine(address, { earlierMessages: english, locale: "en" })).toContain(
      "write your answer in English",
    )
  })

  it("follows a real switch of language by the person", () => {
    expect(
      replyLanguageLine("Est-ce que tu peux le faire pour moi maintenant ?", {
        earlierMessages: english,
        locale: "en",
      }),
    ).toContain("write your answer in French")
  })

  it("falls back on the person's locale setting when nothing they wrote tells", () => {
    expect(replyLanguageLine("ok", { earlierMessages: [], locale: "fr" })).toContain(
      "write your answer in French",
    )
    expect(replyLanguageLine(address, { earlierMessages: [], locale: "en" })).toContain(
      "write your answer in English",
    )
  })

  it("says the data's language never decides it", () => {
    expect(replyLanguageLine("ok", { earlierMessages: english })).toContain(
      "addresses, names, files and tool results",
    )
  })
})

describe("a short switch of language by the person is followed", () => {
  const french = [
    "Peux-tu configurer la boîte de support pour nous ?",
    "Voici nos factures, importe-les s'il te plaît.",
  ]
  const english = ["Please set up a support mailbox for us.", "Here are our invoices."]

  it("English history, a short French reply: French", () => {
    expect(
      replyLanguageLine("Oui, fais-le.", { earlierMessages: english, locale: "en" }),
    ).toContain("write your answer in French")
  })

  it("French history, a short English reply: English", () => {
    expect(replyLanguageLine("Yes, do it.", { earlierMessages: french, locale: "fr" })).toContain(
      "write your answer in English",
    )
  })

  it("a short message carrying an address or numbers does not switch it", () => {
    expect(
      replyLanguageLine("12 rue de la Paix, 75002 Paris", { earlierMessages: english }),
    ).toContain("write your answer in English")
  })
})
