// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`. Every function here either
// produces or consumes the raw Account Key, which never exists on the server.
//
// Each wrap is an independent row: adding an unlock method adds a row, revoking
// one deletes a row, and neither touches mail (spec section 3.2).
//
// A mailbox's security level is min() over its enrolled wraps. Every
// `wrapped_account_key` blob is AES-KW, which is self-verifying, so the
// operator holds a perfect offline cracking oracle for every wrap. That is fine
// for a passkey PRF secret and for a full-entropy recovery phrase. It is why
// the passphrase path sits behind a slow KDF and behind a strength floor the UI
// enforces (spec section 9.7).
//
// The passphrase KDF is PBKDF2-HMAC-SHA256 through WebCrypto, 600 000
// iterations, recorded in the row's `kdfParams` (`kdf`, `iterations`). A row
// with no `kdf` is LEGACY: its KEK came from Argon2id, which only
// `legacy-passphrase-kdf.ts` can compute, and which the native mobile build
// leaves out on purpose.

import { ACCOUNT_KEY_BYTES } from "./account-key"
import { recoveryPhraseBytes } from "./bip39"
import { type Bytes, bytesEqual, utf8 } from "./bytes"
import {
  derivePasskeyWrapKek,
  derivePassphrasePbkdf2WrapKek,
  derivePassphraseWrapKek,
  deriveRecoveryVerifierKey,
  deriveRecoveryWrapKek,
} from "./kdf"
import {
  type Argon2idFn,
  LEGACY_PASSPHRASE_KDF_AVAILABLE,
  legacyPassphraseKdfOutput,
} from "./legacy-passphrase-kdf"

export type { Argon2idFn }

export type WrapType = "passkey_prf" | "recovery_phrase" | "passphrase"

/** The `kdfParams.kdf` of a passphrase wrap minted today. */
export const PASSPHRASE_KDF = "pbkdf2-sha256"

/** The OWASP figure for PBKDF2-HMAC-SHA256. What every new passphrase wrap uses. */
export const PBKDF2_ITERATIONS = 600_000

/**
 * The most iterations an unlock will run for a stored row. The count is read
 * from the row, which the server serves, so without a ceiling a hostile or
 * corrupted row could hang the unlock. No real row goes near it.
 */
export const PBKDF2_MAX_ITERATIONS = 10_000_000

/** The fixed constant the recovery verifier HMACs, spec section 3.2. */
export const RECOVERY_VERIFIER_CONSTANT = "liaison.mailbox.recovery.check.v1"

export interface WrapKdfParams {
  salt: Bytes
  /** `passkey_prf` only: the WebAuthn credential id, bound into D2. */
  credentialId?: Bytes
  /**
   * `passphrase` only: which KDF produced the KEK. Absent on a legacy row,
   * whose KEK came from Argon2id.
   */
  kdf?: typeof PASSPHRASE_KDF
  /** `passphrase` with `kdf` only: the PBKDF2 iteration count. */
  iterations?: number
}

export interface AccountKeyWrap {
  wrapType: WrapType
  /** AES-KW over the 32 byte Account Key, so 40 bytes. */
  wrappedAccountKey: Bytes
  kdfParams: WrapKdfParams
  /** `recovery_phrase` only: HMAC-SHA256 of the fixed constant under D4. */
  verifier?: Bytes
}

export class WrapError extends Error {
  readonly cause?: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = "WrapError"
    this.cause = cause
  }
}

/**
 * A legacy passphrase row met in a build that cannot open it (the native
 * mobile app). Not a wrong password: the user unlocks once on a computer,
 * which re-wraps the row, or uses a passkey.
 */
export class LegacyPassphraseUnavailableError extends WrapError {
  constructor() {
    super("this mailbox password was set up in an older format this app cannot open")
    this.name = "LegacyPassphraseUnavailableError"
  }
}

async function wrapUnder(kekBits: Bytes, accountKey: Bytes): Promise<Bytes> {
  if (accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new WrapError(`account key must be ${ACCOUNT_KEY_BYTES} bytes`)
  }
  const kek = await crypto.subtle.importKey("raw", kekBits, "AES-KW", false, ["wrapKey"])
  kekBits.fill(0)
  // The single documented extractable handle: WebCrypto exposes AES-KW only
  // through wrapKey, which refuses a non-extractable input, and these are bytes
  // this session already holds.
  const handle = await crypto.subtle.importKey(
    "raw",
    accountKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt"],
  )
  return new Uint8Array(await crypto.subtle.wrapKey("raw", handle, kek, "AES-KW"))
}

async function unwrapUnder(kekBits: Bytes, wrapped: Bytes): Promise<Bytes> {
  const kek = await crypto.subtle.importKey("raw", kekBits, "AES-KW", false, ["unwrapKey"])
  kekBits.fill(0)
  try {
    // Unwrapped extractable because the Account Key has to exist as bytes: it
    // is HKDF input material for D7 and D8 and AES-KW input for further wraps,
    // and a CryptoKey can serve neither (spec section 3.3). The caller keeps it
    // in worker memory for the unlock window only and zeroes it after importing
    // the handles it needs.
    const key = await crypto.subtle.unwrapKey(
      "raw",
      wrapped,
      kek,
      "AES-KW",
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt"],
    )
    return new Uint8Array(await crypto.subtle.exportKey("raw", key))
  } catch (error) {
    throw new WrapError("wrapped account key did not unwrap under this key material", error)
  }
}

export type PasskeyWrapDecision = { kind: "eligible" } | { kind: "no-wrap-row"; reason: string }

/**
 * PRF is bound at registration, so `create()` can refuse it. When
 * `prf.enabled` is not exactly true, do NOT persist a `passkey_prf` row: its
 * KEK could never be reproduced, and a broken row is worse than no row (spec
 * section 3.2). The caller falls through to the recovery phrase or the
 * passphrase.
 */
export function decidePasskeyWrap(
  clientExtensionResults: { prf?: { enabled?: boolean } } | null | undefined,
): PasskeyWrapDecision {
  if (clientExtensionResults?.prf?.enabled === true) return { kind: "eligible" }
  return {
    kind: "no-wrap-row",
    reason: "this authenticator did not enable the PRF extension at registration",
  }
}

export async function wrapWithPrfSecret(input: {
  accountKey: Bytes
  prfSecret: Bytes
  salt: Bytes
  userId: string
  credentialId: Bytes
}): Promise<AccountKeyWrap> {
  const kek = await derivePasskeyWrapKek({
    prfSecret: input.prfSecret,
    salt: input.salt,
    userId: input.userId,
    credentialId: input.credentialId,
  })
  return {
    wrapType: "passkey_prf",
    wrappedAccountKey: await wrapUnder(kek, input.accountKey),
    kdfParams: { salt: input.salt, credentialId: input.credentialId },
  }
}

export async function unwrapWithPrfSecret(input: {
  wrap: AccountKeyWrap
  prfSecret: Bytes
  userId: string
}): Promise<Bytes> {
  const credentialId = input.wrap.kdfParams.credentialId
  if (!credentialId) throw new WrapError("passkey wrap is missing its credential id")
  const kek = await derivePasskeyWrapKek({
    prfSecret: input.prfSecret,
    salt: input.wrap.kdfParams.salt,
    userId: input.userId,
    credentialId,
  })
  return unwrapUnder(kek, input.wrap.wrappedAccountKey)
}

async function recoveryVerifier(verifierKeyBits: Bytes): Promise<Bytes> {
  const key = await crypto.subtle.importKey(
    "raw",
    verifierKeyBits,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  verifierKeyBits.fill(0)
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(RECOVERY_VERIFIER_CONSTANT)))
}

export async function wrapWithRecoveryPhrase(input: {
  accountKey: Bytes
  phrase: string
  salt: Bytes
  userId: string
}): Promise<AccountKeyWrap> {
  const phraseBytes = recoveryPhraseBytes(input.phrase)
  const kek = await deriveRecoveryWrapKek({
    phraseBytes,
    salt: input.salt,
    userId: input.userId,
  })
  const verifierKey = await deriveRecoveryVerifierKey({
    phraseBytes,
    salt: input.salt,
    userId: input.userId,
  })
  phraseBytes.fill(0)
  return {
    wrapType: "recovery_phrase",
    wrappedAccountKey: await wrapUnder(kek, input.accountKey),
    kdfParams: { salt: input.salt },
    verifier: await recoveryVerifier(verifierKey),
  }
}

export async function unwrapWithRecoveryPhrase(input: {
  wrap: AccountKeyWrap
  phrase: string
  userId: string
}): Promise<Bytes> {
  const phraseBytes = recoveryPhraseBytes(input.phrase)
  const kek = await deriveRecoveryWrapKek({
    phraseBytes,
    salt: input.wrap.kdfParams.salt,
    userId: input.userId,
  })
  phraseBytes.fill(0)
  return unwrapUnder(kek, input.wrap.wrappedAccountKey)
}

/**
 * Check a phrase without unwrapping anything. The server stores only this
 * verifier, never the phrase, and D4 is a different key from the D3 wrap KEK,
 * so holding the verifier does not shorten an attack on the wrap.
 */
export async function verifyRecoveryPhrase(input: {
  wrap: AccountKeyWrap
  phrase: string
  userId: string
}): Promise<boolean> {
  if (!input.wrap.verifier) return false
  const phraseBytes = recoveryPhraseBytes(input.phrase)
  const verifierKey = await deriveRecoveryVerifierKey({
    phraseBytes,
    salt: input.wrap.kdfParams.salt,
    userId: input.userId,
  })
  phraseBytes.fill(0)
  return bytesEqual(await recoveryVerifier(verifierKey), input.wrap.verifier)
}

function passphraseBytes(passphrase: string): Bytes {
  return utf8(passphrase.normalize("NFKC"))
}

async function pbkdf2(password: Bytes, salt: Bytes, iterations: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

/** True for a row whose KEK came from the legacy Argon2id derivation. */
export function isLegacyPassphraseWrap(wrap: AccountKeyWrap): boolean {
  return wrap.wrapType === "passphrase" && wrap.kdfParams.kdf === undefined
}

async function pbkdf2PassphraseKek(
  passphrase: string,
  salt: Bytes,
  userId: string,
  iterations: number,
): Promise<Bytes> {
  const password = passphraseBytes(passphrase)
  const pbkdf2Output = await pbkdf2(password, salt, iterations)
  password.fill(0)
  const kek = await derivePassphrasePbkdf2WrapKek({ pbkdf2Output, salt, userId })
  pbkdf2Output.fill(0)
  return kek
}

async function legacyPassphraseKek(
  passphrase: string,
  salt: Bytes,
  userId: string,
  legacyKdf: Argon2idFn | undefined,
): Promise<Bytes> {
  const password = passphraseBytes(passphrase)
  const legacyOutput = await legacyPassphraseKdfOutput({ password, salt, kdf: legacyKdf })
  password.fill(0)
  const kek = await derivePassphraseWrapKek({ legacyKdfOutput: legacyOutput, salt, userId })
  legacyOutput.fill(0)
  return kek
}

/** A new passphrase wrap: PBKDF2-HMAC-SHA256, then HKDF under D9. */
export async function wrapWithPassphrase(input: {
  accountKey: Bytes
  passphrase: string
  salt: Bytes
  userId: string
}): Promise<AccountKeyWrap> {
  const kek = await pbkdf2PassphraseKek(
    input.passphrase,
    input.salt,
    input.userId,
    PBKDF2_ITERATIONS,
  )
  return {
    wrapType: "passphrase",
    wrappedAccountKey: await wrapUnder(kek, input.accountKey),
    kdfParams: { salt: input.salt, kdf: PASSPHRASE_KDF, iterations: PBKDF2_ITERATIONS },
  }
}

/**
 * A LEGACY passphrase wrap, Argon2id then HKDF under D6: the shape of the rows
 * enrolled before the PBKDF2 switch. Nothing in the product mints one any
 * more; it exists so the unlock and the silent migration of those rows can be
 * tested against the real construction.
 */
export async function wrapWithLegacyPassphrase(input: {
  accountKey: Bytes
  passphrase: string
  salt: Bytes
  userId: string
  legacyKdf?: Argon2idFn
}): Promise<AccountKeyWrap> {
  const kek = await legacyPassphraseKek(input.passphrase, input.salt, input.userId, input.legacyKdf)
  return {
    wrapType: "passphrase",
    wrappedAccountKey: await wrapUnder(kek, input.accountKey),
    kdfParams: { salt: input.salt },
  }
}

/**
 * Open a passphrase wrap of either generation: PBKDF2 when the row says so, the
 * legacy Argon2id derivation when it names no KDF. A build without the legacy
 * KDF throws `LegacyPassphraseUnavailableError` for a legacy row, before any
 * derivation runs.
 */
export async function unwrapWithPassphrase(input: {
  wrap: AccountKeyWrap
  passphrase: string
  userId: string
  /** Test seam for the legacy Argon2id. Production uses `hash-wasm`. */
  legacyKdf?: Argon2idFn
}): Promise<Bytes> {
  const params = input.wrap.kdfParams
  if (params.kdf === undefined) {
    if (!LEGACY_PASSPHRASE_KDF_AVAILABLE) throw new LegacyPassphraseUnavailableError()
    const kek = await legacyPassphraseKek(
      input.passphrase,
      params.salt,
      input.userId,
      input.legacyKdf,
    )
    return unwrapUnder(kek, input.wrap.wrappedAccountKey)
  }
  if (params.kdf !== PASSPHRASE_KDF) {
    throw new WrapError("this passphrase wrap names a KDF this client does not know")
  }
  const iterations = params.iterations
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > PBKDF2_MAX_ITERATIONS
  ) {
    throw new WrapError("this passphrase wrap carries an invalid iteration count")
  }
  const kek = await pbkdf2PassphraseKek(input.passphrase, params.salt, input.userId, iterations)
  return unwrapUnder(kek, input.wrap.wrappedAccountKey)
}
