// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.6. Account Key, the three wrap types, the keyring and rotation.
//
// T-CRYPTO-3 wrap and unwrap under each of the three types, the
// `prf.enabled === false` fallback, and adding a second wrap from an already
// unlocked session. T-CRYPTO-4 mail sealed under a retired key still opens.
// T-CRYPTO-5 the verifier accepts the right phrase, rejects a wrong one, and
// the wrap KEK and the verifier key are provably different byte strings.

import { describe, expect, it } from "bun:test"
import { mailboxAad } from "./aad"
import { ACCOUNT_KEY_BYTES, generateAccountKey } from "./account-key"
import { generateRecoveryPhrase } from "./bip39"
import { type Bytes, bytesEqual, fromUtf8, toHex, utf8 } from "./bytes"
import { openField } from "./field-open"
import { sealField } from "./field-seal"
import { deriveRecoveryVerifierKey, deriveRecoveryWrapKek } from "./kdf"
import { generateIdentityKey, retireKeyId, unwrapIdentityKey } from "./keyring"
import * as legacyKdf from "./legacy-passphrase-kdf"
import * as legacyKdfNative from "./legacy-passphrase-kdf.native"
import { generateContentKey, sealContentKey } from "./seal"
import { unsealContentKey } from "./unseal"
import {
  decidePasskeyWrap,
  isLegacyPassphraseWrap,
  PASSPHRASE_KDF,
  PBKDF2_ITERATIONS,
  unwrapWithPassphrase,
  unwrapWithPrfSecret,
  unwrapWithRecoveryPhrase,
  verifyRecoveryPhrase,
  WrapError,
  wrapWithLegacyPassphrase,
  wrapWithPassphrase,
  wrapWithPrfSecret,
  wrapWithRecoveryPhrase,
} from "./wraps"

const userId = "11111111-1111-4111-8111-111111111111"
const salt = () => crypto.getRandomValues(new Uint8Array(32))
const credentialId = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])

/** A stand-in for Argon2id where the real cost would only slow the suite down. */
const fakeArgon2id = async (input: { password: Bytes; salt: Bytes }) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array([...input.password, 0, ...input.salt]),
  )
  return new Uint8Array(digest)
}

describe("T-CRYPTO-3 account key wraps", () => {
  it("mints a 32 byte account key that differs every time", () => {
    const a = generateAccountKey()
    const b = generateAccountKey()
    expect(a.length).toBe(ACCOUNT_KEY_BYTES)
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it("wraps and unwraps under a passkey PRF secret", async () => {
    const accountKey = generateAccountKey()
    const prfSecret = crypto.getRandomValues(new Uint8Array(32))
    const wrap = await wrapWithPrfSecret({
      accountKey,
      prfSecret,
      salt: salt(),
      userId,
      credentialId,
    })
    expect(wrap.wrapType).toBe("passkey_prf")
    expect(wrap.wrappedAccountKey.length).toBe(ACCOUNT_KEY_BYTES + 8)
    expect(toHex(wrap.wrappedAccountKey)).not.toContain(toHex(accountKey))
    const back = await unwrapWithPrfSecret({ wrap, prfSecret, userId })
    expect(toHex(back)).toBe(toHex(accountKey))
  })

  it("refuses a PRF secret that does not match the wrap", async () => {
    const accountKey = generateAccountKey()
    const wrap = await wrapWithPrfSecret({
      accountKey,
      prfSecret: crypto.getRandomValues(new Uint8Array(32)),
      salt: salt(),
      userId,
      credentialId,
    })
    await expect(
      unwrapWithPrfSecret({
        wrap,
        prfSecret: crypto.getRandomValues(new Uint8Array(32)),
        userId,
      }),
    ).rejects.toThrow()
  })

  it("declines to build a wrap row when prf.enabled is false or absent", () => {
    expect(decidePasskeyWrap({ prf: { enabled: true } })).toEqual({ kind: "eligible" })
    expect(decidePasskeyWrap({ prf: { enabled: false } }).kind).toBe("no-wrap-row")
    expect(decidePasskeyWrap({}).kind).toBe("no-wrap-row")
    expect(decidePasskeyWrap(undefined).kind).toBe("no-wrap-row")
  })

  it("wraps and unwraps under a recovery phrase", async () => {
    const accountKey = generateAccountKey()
    const phrase = await generateRecoveryPhrase()
    const wrap = await wrapWithRecoveryPhrase({ accountKey, phrase, salt: salt(), userId })
    expect(wrap.wrapType).toBe("recovery_phrase")
    expect(wrap.verifier?.length).toBe(32)
    const back = await unwrapWithRecoveryPhrase({ wrap, phrase, userId })
    expect(toHex(back)).toBe(toHex(accountKey))
  })

  it("wraps and unwraps under a passphrase with PBKDF2-HMAC-SHA256, recorded in the row", async () => {
    expect(PASSPHRASE_KDF).toBe("pbkdf2-sha256")
    expect(PBKDF2_ITERATIONS).toBe(600_000)
    const accountKey = generateAccountKey()
    const passphrase = "correct horse battery staple heliotrope 8712"
    const wrap = await wrapWithPassphrase({ accountKey, passphrase, salt: salt(), userId })
    expect(wrap.wrapType).toBe("passphrase")
    expect(wrap.kdfParams.kdf).toBe("pbkdf2-sha256")
    expect(wrap.kdfParams.iterations).toBe(600_000)
    expect(isLegacyPassphraseWrap(wrap)).toBe(false)
    const back = await unwrapWithPassphrase({ wrap, passphrase, userId })
    expect(toHex(back)).toBe(toHex(accountKey))
    await expect(
      unwrapWithPassphrase({ wrap, passphrase: `${passphrase}!`, userId }),
    ).rejects.toThrow()
  })

  it("derives the PBKDF2 KEK exactly as documented: PBKDF2 then HKDF under D9", async () => {
    // Recomputed here with node's own PBKDF2 and HKDF, so the stored rows stay
    // openable by any implementation that follows the spec, not only this one.
    const { pbkdf2Sync, hkdfSync } = await import("node:crypto")
    const accountKey = generateAccountKey()
    const passphrase = "Cafe\u0301 au lait, deux sucres, 1987"
    const s = salt()
    const wrap = await wrapWithPassphrase({ accountKey, passphrase, salt: s, userId })
    const ikm = pbkdf2Sync(Buffer.from(passphrase.normalize("NFKC")), s, 600_000, 32, "sha256")
    const info = Buffer.concat([
      Buffer.from("liaison.mailbox.wrap.passphrase.v2"),
      Buffer.from([0]),
      Buffer.from(userId),
    ])
    const kek = new Uint8Array(hkdfSync("sha256", ikm, s, info, 32))
    const key = await crypto.subtle.importKey("raw", kek, "AES-KW", false, ["unwrapKey"])
    const opened = await crypto.subtle.unwrapKey(
      "raw",
      wrap.wrappedAccountKey,
      key,
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt"],
    )
    expect(toHex(new Uint8Array(await crypto.subtle.exportKey("raw", opened)))).toBe(
      toHex(accountKey),
    )
  })

  it("still opens a legacy Argon2id row, at the real Argon2id cost", async () => {
    expect(legacyKdf.ARGON2ID_PARAMS).toEqual({
      memorySizeKiB: 65536,
      iterations: 3,
      parallelism: 4,
    })
    const accountKey = generateAccountKey()
    const passphrase = "correct horse battery staple heliotrope 8712"
    const wrap = await wrapWithLegacyPassphrase({ accountKey, passphrase, salt: salt(), userId })
    expect(wrap.kdfParams.kdf).toBeUndefined()
    expect(isLegacyPassphraseWrap(wrap)).toBe(true)
    const back = await unwrapWithPassphrase({ wrap, passphrase, userId })
    expect(toHex(back)).toBe(toHex(accountKey))
    await expect(
      unwrapWithPassphrase({ wrap, passphrase: `${passphrase}!`, userId }),
    ).rejects.toThrow()
  }, 60_000)

  it("keeps the two generations apart: a legacy row never opens as PBKDF2, nor the reverse", async () => {
    const accountKey = generateAccountKey()
    const passphrase = "a passphrase used for both generations"
    const s = salt()
    const legacy = await wrapWithLegacyPassphrase({
      accountKey,
      passphrase,
      salt: s,
      userId,
      legacyKdf: fakeArgon2id,
    })
    const current = await wrapWithPassphrase({ accountKey, passphrase, salt: s, userId })
    await expect(
      unwrapWithPassphrase({
        wrap: {
          ...legacy,
          kdfParams: { ...legacy.kdfParams, kdf: "pbkdf2-sha256", iterations: 600_000 },
        },
        passphrase,
        userId,
      }),
    ).rejects.toThrow(WrapError)
    await expect(
      unwrapWithPassphrase({
        wrap: { ...current, kdfParams: { salt: s } },
        passphrase,
        userId,
        legacyKdf: fakeArgon2id,
      }),
    ).rejects.toThrow(WrapError)
  })

  it("refuses an unknown KDF name and an out of range iteration count before deriving", async () => {
    const accountKey = generateAccountKey()
    const passphrase = "a passphrase for the refusal cases"
    const wrap = await wrapWithPassphrase({ accountKey, passphrase, salt: salt(), userId })
    for (const kdfParams of [
      { ...wrap.kdfParams, kdf: "scrypt" },
      { ...wrap.kdfParams, iterations: 0 },
      { ...wrap.kdfParams, iterations: 1.5 },
      { ...wrap.kdfParams, iterations: 1e12 },
      { ...wrap.kdfParams, iterations: undefined },
    ]) {
      await expect(
        unwrapWithPassphrase({
          wrap: { ...wrap, kdfParams: kdfParams as typeof wrap.kdfParams },
          passphrase,
          userId,
        }),
      ).rejects.toThrow(WrapError)
    }
  })

  it("binds each wrap to its own user id", async () => {
    const accountKey = generateAccountKey()
    const phrase = await generateRecoveryPhrase()
    const wrap = await wrapWithRecoveryPhrase({ accountKey, phrase, salt: salt(), userId })
    await expect(
      unwrapWithRecoveryPhrase({ wrap, phrase, userId: "22222222-2222-4222-8222-222222222222" }),
    ).rejects.toThrow()
  })

  it("adds a second wrap from an already unlocked session", async () => {
    // Section 3.3: the unlock produced the Account Key bytes, so minting another
    // wrap is a pure client operation that never touches the mailbox.
    const accountKey = generateAccountKey()
    const phrase = await generateRecoveryPhrase()
    const first = await wrapWithRecoveryPhrase({ accountKey, phrase, salt: salt(), userId })
    const unlocked = await unwrapWithRecoveryPhrase({ wrap: first, phrase, userId })

    const prfSecret = crypto.getRandomValues(new Uint8Array(32))
    const second = await wrapWithPrfSecret({
      accountKey: unlocked,
      prfSecret,
      salt: salt(),
      userId,
      credentialId,
    })
    const third = await wrapWithPassphrase({
      accountKey: unlocked,
      passphrase: "a second unlock method that is long enough",
      salt: salt(),
      userId,
    })
    for (const back of [
      await unwrapWithPrfSecret({ wrap: second, prfSecret, userId }),
      await unwrapWithPassphrase({
        wrap: third,
        passphrase: "a second unlock method that is long enough",
        userId,
      }),
    ]) {
      expect(toHex(back)).toBe(toHex(accountKey))
    }
    expect(toHex(second.wrappedAccountKey)).not.toBe(toHex(first.wrappedAccountKey))
  })
})

describe("T-CRYPTO-5 recovery phrase verifier", () => {
  it("accepts the right phrase and rejects a wrong one", async () => {
    const accountKey = generateAccountKey()
    const phrase = await generateRecoveryPhrase()
    let wrong = await generateRecoveryPhrase()
    while (wrong === phrase) wrong = await generateRecoveryPhrase()
    const wrap = await wrapWithRecoveryPhrase({ accountKey, phrase, salt: salt(), userId })
    expect(await verifyRecoveryPhrase({ wrap, phrase, userId })).toBe(true)
    expect(await verifyRecoveryPhrase({ wrap, phrase: wrong, userId })).toBe(false)
  })

  it("stores a verifier that is not the phrase and not the wrap kek", async () => {
    const accountKey = generateAccountKey()
    const phrase = await generateRecoveryPhrase()
    const s = salt()
    const wrap = await wrapWithRecoveryPhrase({ accountKey, phrase, salt: s, userId })
    const phraseBytes = utf8(phrase.normalize("NFKD"))
    const wrapKek = await deriveRecoveryWrapKek({ phraseBytes, salt: s, userId })
    const verifierKey = await deriveRecoveryVerifierKey({ phraseBytes, salt: s, userId })
    expect(bytesEqual(wrapKek, verifierKey)).toBe(false)
    expect(toHex(wrap.verifier as Bytes)).not.toBe(toHex(wrapKek))
    expect(toHex(wrap.verifier as Bytes)).not.toBe(toHex(verifierKey))
    expect(fromUtf8(wrap.verifier as Bytes)).not.toContain(phrase.split(" ")[0])
  })

  it("verifies without unwrapping, so a wrong phrase discloses nothing", async () => {
    const accountKey = generateAccountKey()
    const phrase = await generateRecoveryPhrase()
    const wrap = await wrapWithRecoveryPhrase({ accountKey, phrase, salt: salt(), userId })
    const wrong =
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
    expect(await verifyRecoveryPhrase({ wrap, phrase: wrong, userId })).toBe(false)
    await expect(unwrapWithRecoveryPhrase({ wrap, phrase: wrong, userId })).rejects.toThrow()
  })
})

describe("T-CRYPTO-4 rotation keeps historical mail readable", () => {
  it("opens mail sealed under a retired key id after rotating", async () => {
    const accountKey = generateAccountKey()
    const first = await generateIdentityKey({ accountKey, userId, keyId: 1 })
    const contentKey = generateContentKey()
    const ctx = mailboxAad.messageTextBody("m-old")
    const blob = await sealField({
      contentKey,
      context: ctx,
      keyId: 1,
      plaintext: utf8("old mail"),
    })
    const sealed = await sealContentKey({
      recipientEcdhSpki: first.entry.ecdhSpki,
      userId,
      keyId: 1,
      contentKey,
    })

    // Rotate: append a new key id, mark the previous one retired. No rewrite.
    const second = await generateIdentityKey({ accountKey, userId, keyId: 2 })
    const keyring = retireKeyId([first.entry, second.entry], 1)
    expect(keyring.find((e) => e.keyId === 1)?.status).toBe("retired")
    expect(keyring.find((e) => e.keyId === 2)?.status).toBe("active")
    expect(keyring.filter((e) => e.status === "active").length).toBe(1)

    const retired = keyring.find((e) => e.keyId === 1)
    if (!retired) throw new Error("retired entry missing")
    const privateKeys = await unwrapIdentityKey({ accountKey, userId, entry: retired })
    const opened = await unsealContentKey({
      privateKey: privateKeys.ecdhPrivate,
      recipientEcdhSpki: retired.ecdhSpki,
      userId,
      keyId: 1,
      wrapped: sealed.wrapped,
      epkSpki: sealed.epkSpki,
    })
    expect(fromUtf8(await openField({ contentKey: opened, context: ctx, blob }))).toBe("old mail")
  })

  it("cannot open a retired key's mail with the new key", async () => {
    const accountKey = generateAccountKey()
    const first = await generateIdentityKey({ accountKey, userId, keyId: 1 })
    const second = await generateIdentityKey({ accountKey, userId, keyId: 2 })
    const sealed = await sealContentKey({
      recipientEcdhSpki: first.entry.ecdhSpki,
      userId,
      keyId: 1,
      contentKey: generateContentKey(),
    })
    const wrongKeys = await unwrapIdentityKey({ accountKey, userId, entry: second.entry })
    await expect(
      unsealContentKey({
        privateKey: wrongKeys.ecdhPrivate,
        recipientEcdhSpki: first.entry.ecdhSpki,
        userId,
        keyId: 1,
        wrapped: sealed.wrapped,
        epkSpki: sealed.epkSpki,
      }),
    ).rejects.toThrow()
  })

  it("keeps the identity private keys non extractable and wrapped under the account key", async () => {
    const accountKey = generateAccountKey()
    const { entry } = await generateIdentityKey({ accountKey, userId, keyId: 1 })
    const keys = await unwrapIdentityKey({ accountKey, userId, entry })
    expect(keys.ecdhPrivate.extractable).toBe(false)
    expect(keys.signPrivate.extractable).toBe(false)
    await expect(
      unwrapIdentityKey({ accountKey: generateAccountKey(), userId, entry }),
    ).rejects.toThrow()
    await expect(
      unwrapIdentityKey({ accountKey, userId: "22222222-2222-4222-8222-222222222222", entry }),
    ).rejects.toThrow()
  })
})

describe("the native build's legacy KDF stand-in", () => {
  it("exports every name wraps.ts imports from the real module", async () => {
    const source = await Bun.file(new URL("./wraps.ts", import.meta.url)).text()
    // Located by index rather than an import-shaped regex, which the package's
    // own import scanner (isomorphic.test.ts) would read as an import.
    const end = source.indexOf(`./legacy-passphrase-kdf${'"'}`)
    const start = source.lastIndexOf("import {", end)
    expect(end > 0 && start >= 0).toBe(true)
    const names = source
      .slice(start + "import {".length, source.lastIndexOf("}", end))
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n.length > 0 && !n.startsWith("type "))
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name in legacyKdf, `${name} missing from the real module`).toBe(true)
      expect(name in legacyKdfNative, `${name} missing from the native stand-in`).toBe(true)
    }
  })

  it("carries no KDF: it says so, and refuses to derive", async () => {
    expect(legacyKdfNative.LEGACY_PASSPHRASE_KDF_AVAILABLE).toBe(false)
    expect(legacyKdf.LEGACY_PASSPHRASE_KDF_AVAILABLE).toBe(true)
    await expect(
      legacyKdfNative.legacyPassphraseKdfOutput({ password: utf8("x"), salt: salt() }),
    ).rejects.toThrow()
    const source = await Bun.file(
      new URL("./legacy-passphrase-kdf.native.ts", import.meta.url),
    ).text()
    expect(source).not.toMatch(/hash-wasm|import\s*\(/)
  })
})
