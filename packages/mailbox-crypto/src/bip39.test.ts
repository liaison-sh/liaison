// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The recovery phrase codec: BIP39 English, 128 bits of entropy plus the 4 bit
// checksum, NFKD normalised, single space joined, case-folded on entry
// (spec section 3.2).

import { describe, expect, it } from "bun:test"
import {
  entropyToPhrase,
  generateRecoveryPhrase,
  normalizeRecoveryPhrase,
  phraseToEntropy,
  RECOVERY_PHRASE_ENTROPY_BYTES,
  RECOVERY_PHRASE_WORDS,
  recoveryPhraseBytes,
} from "./bip39"
import { BIP39_ENGLISH } from "./bip39-wordlist"
import { toHex, utf8 } from "./bytes"

describe("bip39 wordlist", () => {
  it("ships the canonical 2048 word list", async () => {
    expect(BIP39_ENGLISH.length).toBe(2048)
    const joined = `${BIP39_ENGLISH.join("\n")}\n`
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(joined)))
    expect(toHex(digest)).toBe("2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda")
  })

  it("holds no duplicates and stays sorted", () => {
    expect(new Set(BIP39_ENGLISH).size).toBe(2048)
    expect([...BIP39_ENGLISH].sort()).toEqual([...BIP39_ENGLISH])
  })
})

describe("recovery phrase codec", () => {
  it("encodes the BIP39 all zero vector", async () => {
    const phrase = await entropyToPhrase(new Uint8Array(RECOVERY_PHRASE_ENTROPY_BYTES))
    expect(phrase).toBe(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    )
  })

  it("encodes the BIP39 0x7f vector", async () => {
    const phrase = await entropyToPhrase(new Uint8Array(16).fill(0x7f))
    expect(phrase).toBe(
      "legal winner thank year wave sausage worth useful legal winner thank yellow",
    )
  })

  it("encodes the BIP39 0x80 vector", async () => {
    const phrase = await entropyToPhrase(new Uint8Array(16).fill(0x80))
    expect(phrase).toBe(
      "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
    )
  })

  it("round trips entropy through the phrase", async () => {
    for (let i = 0; i < 8; i++) {
      const entropy = crypto.getRandomValues(new Uint8Array(RECOVERY_PHRASE_ENTROPY_BYTES))
      const phrase = await entropyToPhrase(entropy)
      expect(phrase.split(" ").length).toBe(RECOVERY_PHRASE_WORDS)
      expect(toHex(await phraseToEntropy(phrase))).toBe(toHex(entropy))
    }
  })

  it("generates a fresh valid phrase every time", async () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      const phrase = await generateRecoveryPhrase()
      expect(phrase.split(" ").length).toBe(RECOVERY_PHRASE_WORDS)
      await phraseToEntropy(phrase)
      seen.add(phrase)
    }
    expect(seen.size).toBe(5)
  })

  it("rejects a phrase whose checksum does not match", async () => {
    const phrase = await entropyToPhrase(new Uint8Array(RECOVERY_PHRASE_ENTROPY_BYTES))
    const words = phrase.split(" ")
    words[11] = "abandon"
    await expect(phraseToEntropy(words.join(" "))).rejects.toThrow()
  })

  it("rejects a wrong word count and an unknown word", async () => {
    await expect(phraseToEntropy("abandon abandon abandon")).rejects.toThrow()
    await expect(
      phraseToEntropy(
        "notaword abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    ).rejects.toThrow()
  })

  it("case folds, collapses whitespace and NFKD normalises on entry", async () => {
    const canonical = "legal winner thank year wave sausage worth useful legal winner thank yellow"
    const messy =
      "  LEGAL\tWinner   thank\nyear wave sausage worth useful legal winner thank YELLOW "
    expect(normalizeRecoveryPhrase(messy)).toBe(canonical)
    expect(toHex(await phraseToEntropy(messy))).toBe(toHex(await phraseToEntropy(canonical)))
    expect(toHex(recoveryPhraseBytes(messy))).toBe(toHex(utf8(canonical.normalize("NFKD"))))
  })
})
