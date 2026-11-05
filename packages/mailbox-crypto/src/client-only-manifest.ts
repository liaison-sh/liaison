// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The single source of truth for which modules of this package are CLIENT ONLY.
//
// A client-only module can turn ciphertext back into plaintext, or holds key
// material that must never exist on the server. T-SEC-1 walks the import graph
// of `src/index.ts` (the seal-safe entrypoint) and fails if it reaches any file
// named here, and `isomorphic.test.ts` fails if a name here does not exist on
// disk. Adding a decrypting module without listing it here is a test failure,
// not a silent hole.
//
// The rule that decides membership: a decrypt primitive never shares a file
// with a primitive the server needs. That is why `field-seal.ts` /
// `field-open.ts`, `seal.ts` / `unseal.ts` and `stream-seal.ts` /
// `stream-open.ts` are three pairs rather than three modules.
export const CLIENT_ONLY_MODULES = [
  "account-key.ts",
  "bip39.ts",
  "field-open.ts",
  "key-store.ts",
  "keyring.ts",
  "legacy-passphrase-kdf.ts",
  "legacy-passphrase-kdf.native.ts",
  "stream-open.ts",
  "unseal.ts",
  "wraps.ts",
  "client.ts",
] as const

export type ClientOnlyModule = (typeof CLIENT_ONLY_MODULES)[number]
