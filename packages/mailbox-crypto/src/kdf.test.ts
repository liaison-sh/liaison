// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-CRYPTO-13. Known-answer vectors for the nine derivations D1 to D9 of spec
// section 3.6, plus the assertion that no two of them share an `info` value.
//
// How the expected hex literals were produced, and why they are NOT regenerated
// from `kdf.ts`: a standalone generator (kept out of the package, run once)
// rebuilt every `info` byte string by hand from the spec table and ran
// `node:crypto`'s OpenSSL-backed `hkdfSync("sha256", ikm, salt, info, 32)` over
// it. `kdf.ts` derives through `crypto.subtle` HKDF instead, so the two agree
// only if both implement RFC 5869 over the same inputs. This test additionally
// recomputes each vector with `hkdfSync` at run time, so a literal that drifts
// from the construction it claims to describe fails here as well.

import { describe, expect, it } from "bun:test"
import { hkdfSync } from "node:crypto"
import type { Bytes } from "./bytes"
import {
  deriveFieldSubkey,
  deriveIndexKey,
  deriveLedgerMacKey,
  derivePasskeyWrapKek,
  derivePassphrasePbkdf2WrapKek,
  derivePassphraseWrapKek,
  deriveRecoveryVerifierKey,
  deriveRecoveryWrapKek,
  deriveSealKek,
  mailboxKdfInfo,
} from "./kdf"

const enc = new TextEncoder()
const U = (s: string) => enc.encode(s)
const ZERO = new Uint8Array([0])

function cat(...parts: Bytes[]): Bytes {
  const total = parts.reduce((acc, p) => acc + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function hex(bytes: Bytes): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

function pattern(length: number, f: (i: number) => number): Bytes {
  return Uint8Array.from({ length }, (_, i) => f(i) & 0xff)
}

const userId = "11111111-1111-4111-8111-111111111111"
const keyId = 7
const salt32 = pattern(32, (i) => i)
const recipientSpki = pattern(91, (i) => i * 7 + 3)
const epkSpki = pattern(91, (i) => i * 11 + 5)
const sharedSecret = pattern(32, (i) => i + 1)
const prfSecret = pattern(32, (i) => 0xa0 + i)
const credentialId = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
const phraseBytes = U(
  "legal winner thank year wave sausage worth useful legal winner thank yellow".normalize("NFKD"),
)
const contentKey = pattern(32, (i) => 0x10 + i)
const fieldName = "message.text_body"
const entityId = "msg-1"
const argon2Output = pattern(32, (i) => 0x40 + i)
const pbkdf2Output = pattern(32, (i) => 0x60 + i)
const accountKey = pattern(32, (i) => 0x80 + i)
const shardId = "0"
const EMPTY = new Uint8Array(0)

// The `info` byte strings, restated here independently of kdf.ts.
const expectedInfo: Record<string, Bytes> = {
  D1: cat(
    U("liaison.mailbox.seal.v1"),
    ZERO,
    U("A256KW"),
    ZERO,
    U(userId),
    ZERO,
    Uint8Array.from([keyId]),
    ZERO,
    recipientSpki,
    ZERO,
    epkSpki,
  ),
  D2: cat(U("liaison.mailbox.wrap.passkey.v1"), ZERO, U(userId), ZERO, credentialId),
  D3: cat(U("liaison.mailbox.wrap.recovery.v1"), ZERO, U(userId)),
  D4: cat(U("liaison.mailbox.recovery.verifier.v1"), ZERO, U(userId)),
  D5: cat(U("liaison.mailbox.field.v1"), ZERO, U(fieldName), ZERO, U(entityId)),
  D6: cat(U("liaison.mailbox.wrap.passphrase.v1"), ZERO, U(userId)),
  D7: cat(U("liaison.mailbox.index.v1"), ZERO, U(userId), ZERO, U(shardId)),
  D8: cat(U("liaison.mailbox.ledger.v1"), ZERO, U(userId)),
  D9: cat(U("liaison.mailbox.wrap.passphrase.v2"), ZERO, U(userId)),
}

const ikm: Record<string, Bytes> = {
  D1: sharedSecret,
  D2: prfSecret,
  D3: phraseBytes,
  D4: phraseBytes,
  D5: contentKey,
  D6: argon2Output,
  D7: accountKey,
  D8: accountKey,
  D9: pbkdf2Output,
}

const salt: Record<string, Bytes> = {
  D1: EMPTY,
  D2: salt32,
  D3: salt32,
  D4: salt32,
  D5: EMPTY,
  D6: salt32,
  D7: EMPTY,
  D8: EMPTY,
  D9: salt32,
}

// Hand-produced vectors. Do not regenerate these from kdf.ts.
const VECTORS: Record<string, string> = {
  D1: "b6011f737d47bb853932ee5d8e724a9b77f93657b02cc21f4fb002d11fe805df",
  D2: "0d8a4abc165b45c4be37705a84a9febd7bb16cfaca3404b28240f2c27f2af0ae",
  D3: "52f84940c5814aa1a21e279d915380d07027d48aa22bce3ff523b3ea922ce26d",
  D4: "e77e4b18b9457f376de1084e91f44e2a7094c429c35c7debf5a4321759dd574a",
  D5: "ce5b6029c73065b21120cba2b87045869a4127034bce3e4b97bb9ca0023d6db6",
  D6: "8d119b8c929b81df7dc5d05fb7078fcfcb287edca50557132688b49f8ca80fe8",
  D7: "aba67308841c25716eeebcc9cb5d94c01cdea7114df4b2af2938852f37a3e184",
  D8: "0844096083421d906fc12afa113810d9734d0570cf9d0dcaae7280da63e48787",
  D9: "3a96362241eaeaa6249151d095ab7afda7afe9f1215668ae59208c33e341f3c3",
}

const actualInfo: Record<string, Bytes> = {
  D1: mailboxKdfInfo.sealKek({ userId, keyId, recipientSpki, epkSpki }),
  D2: mailboxKdfInfo.passkeyWrapKek({ userId, credentialId }),
  D3: mailboxKdfInfo.recoveryWrapKek({ userId }),
  D4: mailboxKdfInfo.recoveryVerifierKey({ userId }),
  D5: mailboxKdfInfo.fieldSubkey({ fieldName, entityId }),
  D6: mailboxKdfInfo.passphraseWrapKek({ userId }),
  D7: mailboxKdfInfo.indexKey({ userId, shardId }),
  D8: mailboxKdfInfo.ledgerMacKey({ userId }),
  D9: mailboxKdfInfo.passphrasePbkdf2WrapKek({ userId }),
}

const derived: Record<string, () => Promise<Bytes>> = {
  D1: () => deriveSealKek({ sharedSecret, userId, keyId, recipientSpki, epkSpki }),
  D2: () => derivePasskeyWrapKek({ prfSecret, salt: salt32, userId, credentialId }),
  D3: () => deriveRecoveryWrapKek({ phraseBytes, salt: salt32, userId }),
  D4: () => deriveRecoveryVerifierKey({ phraseBytes, salt: salt32, userId }),
  D5: () => deriveFieldSubkey({ contentKey, fieldName, entityId }),
  D6: () => derivePassphraseWrapKek({ legacyKdfOutput: argon2Output, salt: salt32, userId }),
  D7: () => deriveIndexKey({ accountKey, userId, shardId }),
  D8: () => deriveLedgerMacKey({ accountKey, userId }),
  D9: () => derivePassphrasePbkdf2WrapKek({ pbkdf2Output, salt: salt32, userId }),
}

const IDS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"] as const

describe("T-CRYPTO-13 known answer vectors for D1 to D9", () => {
  it("covers all nine derivations, none missing", () => {
    expect(IDS.length).toBe(9)
    for (const id of IDS) {
      expect(VECTORS[id], `missing vector for ${id}`).toBeDefined()
      expect(actualInfo[id].length, `empty info for ${id}`).toBeGreaterThan(0)
    }
  })

  for (const id of IDS) {
    it(`${id} assembles the exact info byte string from spec section 3.6`, () => {
      expect(hex(actualInfo[id])).toBe(hex(expectedInfo[id]))
    })

    it(`${id} matches its hand produced vector`, async () => {
      expect(hex(await derived[id]())).toBe(VECTORS[id])
    })

    it(`${id} matches an independent HKDF implementation`, () => {
      const independent = new Uint8Array(
        hkdfSync("sha256", ikm[id], salt[id], expectedInfo[id], 32),
      )
      expect(hex(independent)).toBe(VECTORS[id])
    })
  }

  it("derives exactly 32 bytes everywhere", async () => {
    for (const id of IDS) {
      expect((await derived[id]()).length, `wrong length for ${id}`).toBe(32)
    }
  })

  it("gives every derivation a pairwise distinct info value", () => {
    const seen = new Map<string, string>()
    for (const id of IDS) {
      const key = hex(actualInfo[id])
      const clash = seen.get(key)
      expect(clash, `${id} shares its info with ${clash}`).toBeUndefined()
      seen.set(key, id)
    }
    expect(seen.size).toBe(9)
  })

  it("keeps D3 and D4 independent over identical ikm and salt", async () => {
    const wrapKek = await deriveRecoveryWrapKek({ phraseBytes, salt: salt32, userId })
    const verifier = await deriveRecoveryVerifierKey({ phraseBytes, salt: salt32, userId })
    expect(hex(wrapKek)).not.toBe(hex(verifier))
  })
})
