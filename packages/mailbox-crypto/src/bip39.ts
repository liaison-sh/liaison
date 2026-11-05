// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. The recovery phrase is the mandatory unlock method: it is full
// entropy key material and must never reach the server in any form. Named in
// `client-only-manifest.ts`.
//
// BIP39 English, 128 bits of entropy plus the 4 bit checksum, so twelve words
// (spec section 3.2). NFKD normalisation, single space join, case-folded on
// entry. The wordlist ships in `bip39-wordlist.ts`, so there is no runtime
// dependency.

import { BIP39_ENGLISH } from "./bip39-wordlist"
import { type Bytes, utf8 } from "./bytes"

export const RECOVERY_PHRASE_ENTROPY_BYTES = 16
export const RECOVERY_PHRASE_WORDS = 12

const INDEX_OF = new Map(BIP39_ENGLISH.map((word, index) => [word, index]))

export class RecoveryPhraseError extends Error {
  readonly code: "WORD_COUNT" | "UNKNOWN_WORD" | "CHECKSUM" | "ENTROPY_LENGTH"
  constructor(code: RecoveryPhraseError["code"], message: string) {
    super(message)
    this.name = "RecoveryPhraseError"
    this.code = code
  }
}

/**
 * Case-fold, collapse every run of whitespace and NFKD normalise. Applied to
 * everything the user types, so a phrase pasted with a line break or in capitals
 * still derives the same D3 and D4 keys.
 */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase
    .normalize("NFKD")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .join(" ")
}

/** The exact ikm bytes D3 and D4 take. */
export function recoveryPhraseBytes(phrase: string): Bytes {
  return utf8(normalizeRecoveryPhrase(phrase).normalize("NFKD"))
}

async function checksumBits(entropy: Bytes): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", entropy))
  // One checksum bit per 32 bits of entropy: 4 bits for 128 bits.
  const bits = (entropy.length * 8) / 32
  return digest[0].toString(2).padStart(8, "0").slice(0, bits)
}

export async function entropyToPhrase(entropy: Bytes): Promise<string> {
  if (entropy.length !== RECOVERY_PHRASE_ENTROPY_BYTES) {
    throw new RecoveryPhraseError(
      "ENTROPY_LENGTH",
      `recovery phrase entropy must be ${RECOVERY_PHRASE_ENTROPY_BYTES} bytes, got ${entropy.length}`,
    )
  }
  let bits = ""
  for (const byte of entropy) bits += byte.toString(2).padStart(8, "0")
  bits += await checksumBits(entropy)
  const words: string[] = []
  for (let i = 0; i < bits.length; i += 11) {
    words.push(BIP39_ENGLISH[Number.parseInt(bits.slice(i, i + 11), 2)])
  }
  return words.join(" ")
}

export async function phraseToEntropy(phrase: string): Promise<Bytes> {
  const words = normalizeRecoveryPhrase(phrase)
    .split(" ")
    .filter((w) => w.length > 0)
  if (words.length !== RECOVERY_PHRASE_WORDS) {
    throw new RecoveryPhraseError(
      "WORD_COUNT",
      `recovery phrase must be ${RECOVERY_PHRASE_WORDS} words, got ${words.length}`,
    )
  }
  let bits = ""
  for (const word of words) {
    const index = INDEX_OF.get(word)
    if (index === undefined) {
      throw new RecoveryPhraseError("UNKNOWN_WORD", "recovery phrase contains an unknown word")
    }
    bits += index.toString(2).padStart(11, "0")
  }
  const entropyBits = RECOVERY_PHRASE_ENTROPY_BYTES * 8
  const entropy = new Uint8Array(RECOVERY_PHRASE_ENTROPY_BYTES)
  for (let i = 0; i < RECOVERY_PHRASE_ENTROPY_BYTES; i++) {
    entropy[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2)
  }
  if (bits.slice(entropyBits) !== (await checksumBits(entropy))) {
    throw new RecoveryPhraseError("CHECKSUM", "recovery phrase checksum does not match")
  }
  return entropy
}

/** 128 fresh CSPRNG bits, encoded as twelve words. */
export async function generateRecoveryPhrase(): Promise<string> {
  const entropy = crypto.getRandomValues(new Uint8Array(RECOVERY_PHRASE_ENTROPY_BYTES))
  const phrase = await entropyToPhrase(entropy)
  entropy.fill(0)
  return phrase
}
