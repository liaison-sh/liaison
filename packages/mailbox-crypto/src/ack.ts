// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEAL SAFE. The migration acknowledgement of spec section 7 step 6. The client
// signs, the server verifies; both use the canonical encoder below so the two
// cannot drift. Signing needs an Ed25519 private key the server does not hold,
// so the presence of `signAck` here is not a server capability.
//
// The server cannot check its own backfill: no plaintext and no
// plaintext-derived value may cross to it. So the client walks every message,
// compares both representations itself, and proves coverage with a signature
// over a digest of the id set, which the server independently recomputes over
// the exact row set it holds.

import { type Bytes, concatBytes, u8, u64be, utf8, ZERO_BYTE } from "./bytes"

export const MAILBOX_ACK_LABEL = "liaison.mailbox.ack.v1"

const ED25519 = { name: "Ed25519" } as const

export interface MailboxAckStatement {
  userId: string
  accountId: string
  /**
   * The identity key id whose Ed25519 half signed this statement. Bound into
   * the signed bytes, so a swapped key id fails on the signature alone rather
   * than only failing because the server looked up a different public key
   * (spec section 15, amendment A16).
   */
  keyId: number
  /** Server-issued, single use, checked for freshness on arrival. */
  nonce: string
  /** How many messages the client actually verified. */
  count: number
  idSetDigest: Bytes
  backfillCursor: string
}

/**
 * `SHA-256` over the ASCII-sorted, newline-joined ids.
 *
 * WIRE CONTRACT, and Phase 12's server recompute must match it byte for byte:
 * the separator is a single `\n` BETWEEN ids and there is NO trailing newline,
 * so two ids hash `"m-1\nm-2"` and one id hashes `"m-1"` with no separator at
 * all. Spec section 7 step 6 says "newline-joined" without settling the
 * trailing byte; this is the settled reading, pinned by a test that asserts the
 * trailing-newline variant produces a different digest.
 *
 * A duplicate id is refused: it would let a client claim coverage it does not
 * have while still matching a count.
 */
export async function computeIdSetDigest(messageIds: readonly string[]): Promise<Bytes> {
  const sorted = [...messageIds].sort()
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) {
      throw new RangeError(`duplicate message id ${sorted[i]} in acknowledgement id set`)
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", utf8(sorted.join("\n")))
  return new Uint8Array(digest)
}

/**
 * The exact signed bytes. THIS FIELD ORDER IS THE WIRE CONTRACT: Phase 12's
 * server-side verifier must assemble these bytes in exactly this sequence, or
 * every acknowledgement fails and the purge in section 7 step 7 never runs.
 *
 *   1  label            "liaison.mailbox.ack.v1"
 *   2  0x00
 *   3  userId           utf8
 *   4  0x00
 *   5  accountId        utf8
 *   6  0x00
 *   7  keyId            u8, one byte, same byte the blob header carries
 *   8  0x00
 *   9  nonce            utf8
 *   10 0x00
 *   11 count            u64 big endian
 *   12 0x00
 *   13 idSetDigest      32 raw bytes, see computeIdSetDigest
 *   14 0x00
 *   15 backfillCursor   utf8
 *
 * `keyId` sits between `accountId` and `nonce` and was NOT in the section 7
 * step 6 statement as first written (spec section 15, amendment A16). Without
 * it a swapped key id failed only because the server then verified under a
 * different `sign_public_key`, which is a different and weaker property: two
 * key ids sharing a signing key would have let the swap through. It is encoded
 * as one byte because `key_id` is one byte everywhere else in this design, so a
 * value above 255 is an error rather than a silent truncation.
 */
export function encodeAckStatement(statement: MailboxAckStatement): Bytes {
  return concatBytes(
    utf8(MAILBOX_ACK_LABEL),
    ZERO_BYTE,
    utf8(statement.userId),
    ZERO_BYTE,
    utf8(statement.accountId),
    ZERO_BYTE,
    u8(statement.keyId),
    ZERO_BYTE,
    utf8(statement.nonce),
    ZERO_BYTE,
    u64be(statement.count),
    ZERO_BYTE,
    statement.idSetDigest,
    ZERO_BYTE,
    utf8(statement.backfillCursor),
  )
}

export async function signAck(
  signPrivateKey: CryptoKey,
  statement: MailboxAckStatement,
): Promise<Bytes> {
  return new Uint8Array(
    await crypto.subtle.sign(ED25519, signPrivateKey, encodeAckStatement(statement)),
  )
}

export async function verifyAck(
  signPublicKey: CryptoKey | Bytes,
  statement: MailboxAckStatement,
  signature: Bytes,
): Promise<boolean> {
  const key =
    signPublicKey instanceof Uint8Array
      ? await crypto.subtle.importKey("spki", signPublicKey, ED25519, false, ["verify"])
      : signPublicKey
  return crypto.subtle.verify(ED25519, key, signature, encodeAckStatement(statement))
}
