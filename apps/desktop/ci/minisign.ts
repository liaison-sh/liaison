// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Verification of the updater's own signature, in process.
//
// The Tauri CLI can SIGN and cannot verify: `tauri signer` ships `generate` and
// `sign` and no third subcommand. The plugin inside the app verifies, in Rust,
// and a release pipeline that cannot do the same check has to take the signing
// step's word for it. That is precisely the desync this gate exists to catch,
// so the check is implemented here instead, against the same bytes the plugin
// reads.
//
// The format is minisign. A public key file is base64 over two lines: an
// untrusted comment, then 2 bytes of algorithm, 8 bytes of key id, 32 bytes of
// ed25519 public key. A signature file is base64 over four: an untrusted
// comment, the signature line (algorithm, key id, 64 byte signature), a trusted
// comment, and a global signature over the signature bytes followed by the
// trusted comment's text.
//
// Tauri signs with algorithm "ED", which is minisign's PREHASHED mode: the
// signed message is blake2b-512 of the file, not the file. Verifying against
// the raw bytes returns false for a perfectly good signature, which would read
// as a tampered artifact, so the mode byte is read rather than assumed.

import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto"

/** SPKI prefix for a bare ed25519 public key, so node can take the 32 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")

export type MinisignAlgorithm = "Ed" | "ED"

export interface MinisignPublicKey {
  algorithm: MinisignAlgorithm
  keyId: string
  key: Buffer
}

export interface MinisignSignature {
  algorithm: MinisignAlgorithm
  keyId: string
  signature: Buffer
  trustedComment: string
  globalSignature: Buffer
}

function decodeOuter(text: string): string[] {
  // Both files are base64 of the plain minisign file, which is what a Tauri
  // `.sig` and a `pubkey` field both carry.
  const inner = Buffer.from(text.trim(), "base64").toString("utf8")
  const lines = inner.split("\n").filter((line) => line.length > 0)
  if (lines.length < 2) throw new Error("not a minisign file: fewer than two lines")
  return lines
}

function readAlgorithm(head: Buffer): MinisignAlgorithm {
  const algorithm = head.subarray(0, 2).toString("latin1")
  if (algorithm !== "Ed" && algorithm !== "ED") {
    throw new Error(`unknown minisign algorithm: ${algorithm}`)
  }
  return algorithm
}

export function parsePublicKey(text: string): MinisignPublicKey {
  const lines = decodeOuter(text)
  const raw = Buffer.from(lines[lines.length - 1] as string, "base64")
  if (raw.length !== 42) throw new Error(`public key is ${raw.length} bytes, expected 42`)
  return {
    algorithm: readAlgorithm(raw),
    keyId: raw.subarray(2, 10).toString("hex"),
    key: raw.subarray(10),
  }
}

export function parseSignature(text: string): MinisignSignature {
  const lines = decodeOuter(text)
  if (lines.length < 4) throw new Error("not a minisign signature: fewer than four lines")
  const raw = Buffer.from(lines[1] as string, "base64")
  if (raw.length !== 74) throw new Error(`signature is ${raw.length} bytes, expected 74`)
  const trusted = lines[2] as string
  const marker = "trusted comment: "
  if (!trusted.startsWith(marker)) throw new Error("signature carries no trusted comment")
  return {
    algorithm: readAlgorithm(raw),
    keyId: raw.subarray(2, 10).toString("hex"),
    signature: raw.subarray(10),
    trustedComment: trusted.slice(marker.length),
    globalSignature: Buffer.from(lines[3] as string, "base64"),
  }
}

export type VerifyOutcome = { ok: true; trustedComment: string } | { ok: false; reason: string }

/** Verifies a detached Tauri updater signature over the given bytes. Every
 *  refusal names WHY: a key id mismatch and a tampered payload are different
 *  operator problems and must not read the same in a log. */
export function verifyMinisign(
  payload: Buffer | Uint8Array,
  signatureText: string,
  publicKeyText: string,
): VerifyOutcome {
  let signature: MinisignSignature
  let publicKey: MinisignPublicKey
  try {
    signature = parseSignature(signatureText)
    publicKey = parsePublicKey(publicKeyText)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
  if (signature.keyId !== publicKey.keyId) {
    return {
      ok: false,
      reason: `signed by key ${signature.keyId}, this build trusts ${publicKey.keyId}`,
    }
  }
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey.key]),
    format: "der",
    type: "spki",
  })
  const message =
    signature.algorithm === "ED"
      ? createHash("blake2b512").update(payload).digest()
      : Buffer.from(payload)
  if (!verifyEd25519(null, message, key, signature.signature)) {
    return { ok: false, reason: "the signature does not match these bytes" }
  }
  // The global signature is what stops the trusted comment being rewritten
  // under a good signature. Tauri puts the source file's name in it.
  const global = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")])
  if (!verifyEd25519(null, global, key, signature.globalSignature)) {
    return { ok: false, reason: "the trusted comment does not match its own signature" }
  }
  return { ok: true, trustedComment: signature.trustedComment }
}
