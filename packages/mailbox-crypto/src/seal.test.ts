// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.5. ECDH-ES content-key seal and unseal.
//
// `seal.ts` and `unseal.ts` are imported separately here on purpose: they are
// two modules so the server graph can reach the seal half without reaching the
// unseal half (Appendix C A5).
//
// T-CRYPTO-8 rejects a bad ephemeral public key AT IMPORT, before any
// derivation runs. T-CRYPTO-9 asserts `extractable === false` at every step.

import { describe, expect, it } from "bun:test"
import { mailboxAad } from "./aad"
import { toHex, utf8 } from "./bytes"
import { openField } from "./field-open"
import { sealField } from "./field-seal"
import {
  CONTENT_KEY_BYTES,
  generateContentKey,
  importEcdhPublicKeySpki,
  sealContentKey,
} from "./seal"
import { unsealContentKey } from "./unseal"

const userId = "11111111-1111-4111-8111-111111111111"
const keyId = 7

async function identity() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  return { pair, spki }
}

describe("ECDH-ES content key seal and unseal", () => {
  it("seals a content key to a public key and unseals it with the private key", async () => {
    const { pair, spki } = await identity()
    const contentKey = generateContentKey()
    expect(contentKey.length).toBe(CONTENT_KEY_BYTES)

    const sealed = await sealContentKey({
      recipientEcdhSpki: spki,
      userId,
      keyId,
      contentKey,
    })
    expect(sealed.wrapped.length).toBe(CONTENT_KEY_BYTES + 8)
    expect(sealed.epkSpki.length).toBeGreaterThan(0)
    expect(toHex(sealed.epkSpki)).not.toBe(toHex(spki))

    const opened = await unsealContentKey({
      privateKey: pair.privateKey,
      recipientEcdhSpki: spki,
      userId,
      keyId,
      wrapped: sealed.wrapped,
      epkSpki: sealed.epkSpki,
    })

    // The unsealed content key is only usable as HKDF input material, which is
    // exactly what the field open path needs.
    const ctx = mailboxAad.messageTextBody("m1")
    const blob = await sealField({ contentKey, context: ctx, keyId, plaintext: utf8("hello") })
    expect(
      new TextDecoder().decode(await openField({ contentKey: opened, context: ctx, blob })),
    ).toBe("hello")
  })

  it("draws a fresh ephemeral key for every seal", async () => {
    const { spki } = await identity()
    const seen = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const sealed = await sealContentKey({
        recipientEcdhSpki: spki,
        userId,
        keyId,
        contentKey: generateContentKey(),
      })
      seen.add(toHex(sealed.epkSpki))
    }
    expect(seen.size).toBe(4)
  })

  it("refuses to unseal under a different user id, key id or recipient key", async () => {
    const { pair, spki } = await identity()
    const sealed = await sealContentKey({
      recipientEcdhSpki: spki,
      userId,
      keyId,
      contentKey: generateContentKey(),
    })
    const base = {
      privateKey: pair.privateKey,
      recipientEcdhSpki: spki,
      userId,
      keyId,
      wrapped: sealed.wrapped,
      epkSpki: sealed.epkSpki,
    }
    await expect(
      unsealContentKey({ ...base, userId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow()
    await expect(unsealContentKey({ ...base, keyId: 8 })).rejects.toThrow()
    const other = await identity()
    await expect(unsealContentKey({ ...base, recipientEcdhSpki: other.spki })).rejects.toThrow()
  })
})

describe("T-CRYPTO-8 ephemeral public key validation", () => {
  async function goodEpk() {
    const { spki } = await identity()
    return spki
  }

  it("accepts a well formed point, the non vacuity half", async () => {
    const key = await importEcdhPublicKeySpki(await goodEpk())
    expect(key.algorithm.name).toBe("ECDH")
  })

  it("rejects an off curve point at import, without running a derivation", async () => {
    const spki = await goodEpk()
    const offCurve = Uint8Array.from(spki)
    offCurve[offCurve.length - 1] ^= 0x01
    const { pair } = await identity()
    let derivations = 0
    await expect(
      unsealContentKey(
        {
          privateKey: pair.privateKey,
          recipientEcdhSpki: spki,
          userId,
          keyId,
          wrapped: new Uint8Array(40),
          epkSpki: offCurve,
        },
        {
          deriveSharedSecret: async () => {
            derivations++
            return new Uint8Array(32)
          },
        },
      ),
    ).rejects.toThrow()
    expect(derivations, "a derivation ran on an unvalidated point").toBe(0)
  })

  it("rejects the point at infinity at import, without running a derivation", async () => {
    const spki = await goodEpk()
    const infinity = Uint8Array.from(spki)
    infinity.fill(0, 27)
    const { pair } = await identity()
    let derivations = 0
    await expect(
      unsealContentKey(
        {
          privateKey: pair.privateKey,
          recipientEcdhSpki: spki,
          userId,
          keyId,
          wrapped: new Uint8Array(40),
          epkSpki: infinity,
        },
        {
          deriveSharedSecret: async () => {
            derivations++
            return new Uint8Array(32)
          },
        },
      ),
    ).rejects.toThrow()
    expect(derivations, "a derivation ran on the point at infinity").toBe(0)
  })

  it("rejects a garbage recipient key at seal, without running a derivation", async () => {
    let derivations = 0
    await expect(
      sealContentKey(
        {
          recipientEcdhSpki: new Uint8Array([1, 2, 3, 4]),
          userId,
          keyId,
          contentKey: generateContentKey(),
        },
        {
          deriveSharedSecret: async () => {
            derivations++
            return new Uint8Array(32)
          },
        },
      ),
    ).rejects.toThrow()
    expect(derivations).toBe(0)
  })
})

describe("T-CRYPTO-9 every key in the chain is non extractable", () => {
  it("produces a non extractable content key handle on unseal", async () => {
    const { pair, spki } = await identity()
    const sealed = await sealContentKey({
      recipientEcdhSpki: spki,
      userId,
      keyId,
      contentKey: generateContentKey(),
    })
    const opened = await unsealContentKey({
      privateKey: pair.privateKey,
      recipientEcdhSpki: spki,
      userId,
      keyId,
      wrapped: sealed.wrapped,
      epkSpki: sealed.epkSpki,
    })
    expect(opened.extractable).toBe(false)
    expect(opened.algorithm.name).toBe("HKDF")
    await expect(crypto.subtle.exportKey("raw", opened)).rejects.toThrow()
  })

  it("creates no extractable key anywhere in the client open chain", async () => {
    const { pair, spki } = await identity()
    const contentKey = generateContentKey()
    const sealed = await sealContentKey({
      recipientEcdhSpki: spki,
      userId,
      keyId,
      contentKey,
    })
    const ctx = mailboxAad.messageTextBody("m1")
    const blob = await sealField({ contentKey, context: ctx, keyId, plaintext: utf8("hi") })

    const record = installExtractableRecorder()
    try {
      const opened = await unsealContentKey({
        privateKey: pair.privateKey,
        recipientEcdhSpki: spki,
        userId,
        keyId,
        wrapped: sealed.wrapped,
        epkSpki: sealed.epkSpki,
      })
      await openField({ contentKey: opened, context: ctx, blob })
    } finally {
      record.restore()
    }
    expect(record.calls.length, "no key was created, the recorder saw nothing").toBeGreaterThan(2)
    expect(record.calls.filter((c) => c.extractable)).toEqual([])
  })

  it("creates exactly one extractable key on the seal side, the AES-KW wrap input", async () => {
    // WebCrypto exposes AES-KW only through wrapKey, which refuses a
    // non-extractable input, so the content key the server just minted has to
    // be imported extractable for the duration of that one call. It is bytes
    // the sealer already holds; nothing else in the chain may be extractable.
    const { spki } = await identity()
    const record = installExtractableRecorder()
    try {
      await sealContentKey({
        recipientEcdhSpki: spki,
        userId,
        keyId,
        contentKey: generateContentKey(),
      })
    } finally {
      record.restore()
    }
    const extractable = record.calls.filter((c) => c.extractable)
    expect(extractable.length).toBe(1)
    expect(extractable[0].op).toBe("importKey")
    expect(extractable[0].algorithm).toBe("AES-GCM")
  })
})

interface RecordedKey {
  op: string
  algorithm: string
  extractable: boolean
}

function installExtractableRecorder() {
  const calls: RecordedKey[] = []
  const subtle = crypto.subtle as unknown as Record<string, (...args: any[]) => any>
  const originals: Record<string, (...args: any[]) => any> = {}
  const named = (algo: unknown): string =>
    typeof algo === "string" ? algo : ((algo as { name?: string })?.name ?? "unknown")

  const positions: Record<string, { algo: number; extractable: number }> = {
    importKey: { algo: 2, extractable: 3 },
    generateKey: { algo: 0, extractable: 1 },
    deriveKey: { algo: 2, extractable: 3 },
    unwrapKey: { algo: 4, extractable: 5 },
  }
  for (const [op, pos] of Object.entries(positions)) {
    originals[op] = subtle[op].bind(crypto.subtle)
    subtle[op] = (...args: any[]) => {
      calls.push({
        op,
        algorithm: named(args[pos.algo]),
        extractable: Boolean(args[pos.extractable]),
      })
      return originals[op](...args)
    }
  }
  return {
    calls,
    restore() {
      for (const op of Object.keys(positions)) subtle[op] = originals[op]
    },
  }
}
