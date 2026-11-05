// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLIENT ONLY. Named in `client-only-manifest.ts`.
//
// The native mobile build's stand-in for `legacy-passphrase-kdf.ts`, swapped
// in by the Vite alias of mode `native` (`apps/web/vite.config.ts`). It carries
// no KDF: the iOS app ships only the cryptography the operating system
// provides, which is what makes it exempt from export documentation. A legacy
// passphrase row met on the device is refused with a typed error, and the UI
// tells the user to unlock once on a computer (which re-wraps the row) or to
// use a passkey. It exports every name `wraps.ts` imports from the real module;
// `wraps.test.ts` pins that.

import type { Bytes } from "./bytes"

export type Argon2idFn = (input: {
  password: Bytes
  salt: Bytes
  memorySizeKiB: number
  iterations: number
  parallelism: number
  hashLengthBytes: number
}) => Promise<Bytes>

export const LEGACY_PASSPHRASE_KDF_AVAILABLE: boolean = false

export async function legacyPassphraseKdfOutput(_input: {
  password: Bytes
  salt: Bytes
  kdf?: Argon2idFn
}): Promise<Bytes> {
  throw new Error("the legacy passphrase KDF is not part of this build")
}
