// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`.
//
// The LEGACY passphrase KDF: Argon2id through `hash-wasm`. Passphrase wraps
// are no longer minted with it (they use PBKDF2 through WebCrypto, see
// `wraps.ts`), but rows enrolled before the switch still carry an Argon2id
// derived KEK, and a browser or desktop unlock of such a row opens it here and
// silently re-wraps it under PBKDF2.
//
// This module is the ONLY place that reaches `hash-wasm`. The native mobile
// build swaps it for `legacy-passphrase-kdf.native.ts` (a Vite alias in
// `apps/web/vite.config.ts`, mode `native`), so the iOS bundle carries no
// Argon2id code at all and stays inside the encryption the operating system
// provides. The twin exports every name `wraps.ts` imports from here;
// `wraps.test.ts` pins that.

import type { Bytes } from "./bytes"

/** Argon2id cost of the legacy passphrase wrap (spec section 3.2). */
export const ARGON2ID_PARAMS = {
  memorySizeKiB: 65536,
  iterations: 3,
  parallelism: 4,
} as const

export type Argon2idFn = (input: {
  password: Bytes
  salt: Bytes
  memorySizeKiB: number
  iterations: number
  parallelism: number
  hashLengthBytes: number
}) => Promise<Bytes>

/** False in the native build, where a legacy row cannot be opened on the device. */
export const LEGACY_PASSPHRASE_KDF_AVAILABLE: boolean = true

/**
 * Argon2id through `hash-wasm`, behind a dynamic import so the common unlock
 * paths never pull the WASM module.
 */
const defaultArgon2id: Argon2idFn = async (input) => {
  const { argon2id } = await import("hash-wasm")
  const out = await argon2id({
    password: input.password,
    salt: input.salt,
    memorySize: input.memorySizeKiB,
    iterations: input.iterations,
    parallelism: input.parallelism,
    hashLength: input.hashLengthBytes,
    outputType: "binary",
  })
  return new Uint8Array(out)
}

/** The 32 byte Argon2id output a legacy passphrase wrap's D6 KEK is derived from. */
export async function legacyPassphraseKdfOutput(input: {
  password: Bytes
  salt: Bytes
  kdf?: Argon2idFn
}): Promise<Bytes> {
  return (input.kdf ?? defaultArgon2id)({
    password: input.password,
    salt: input.salt,
    memorySizeKiB: ARGON2ID_PARAMS.memorySizeKiB,
    iterations: ARGON2ID_PARAMS.iterations,
    parallelism: ARGON2ID_PARAMS.parallelism,
    hashLengthBytes: 32,
  })
}
