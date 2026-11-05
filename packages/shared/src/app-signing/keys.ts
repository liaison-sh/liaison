// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Public keys that vouch for first-party app artifacts (signed statements and
 * the revocation list). A list, so a key can be rotated: the release pipeline
 * signs with the newest key and clients accept any key listed here.
 *
 * Only PUBLIC keys live here. The private key never leaves the signing machine.
 *
 * The production list pins the release pipeline's key(s). A statement whose key
 * is not listed does not verify, and with an empty list nothing verifies: the app
 * then runs in the sandbox frame, as an unsigned app would (fail closed). Tests
 * generate their own throwaway keys (testing.ts) and pass them explicitly.
 *
 * THE ONE SOURCE OF TRUTH is `keys.json` beside this file: this module reads it,
 * and the desktop shell compiles the same file into its binary
 * (apps/desktop/src-tauri/src/app_signing.rs, `include_str!`), so a key or a
 * floor entry added there reaches the web build, the server, the signing tool
 * and the shell's own verifier at once.
 */
import pinned from "./keys.json"

export interface AppSigningKey {
  /** Stable id named by a statement's `keyId`. */
  keyId: string
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: string
}

export const APP_SIGNING_KEYS: readonly AppSigningKey[] = pinned.keys as AppSigningKey[]

/** One revocation: every version of `name` below `below`, and/or the listed `versions`. */
export interface AppRevocationEntry {
  name: string
  below?: string
  versions?: string[]
}

/**
 * Revocations compiled into every client release, on top of the signed
 * `apps/revocations.json`: a version listed or below the floor here never runs
 * in-page, whatever the downloaded list says.
 */
export const REVOCATION_FLOOR: readonly AppRevocationEntry[] =
  pinned.revocationFloor as AppRevocationEntry[]
