// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.8, T-CRYPTO-14. The migration acknowledgement of spec section 7 step 6.
//
// The server cannot check its own backfill by construction, so the client
// signs a statement over what it actually verified and the server recomputes
// the digest over the row set it holds. Every field of that statement has to be
// covered by the signature, which is what these cases assert one at a time.

import { describe, expect, it } from "bun:test"
import {
  computeIdSetDigest,
  encodeAckStatement,
  MAILBOX_ACK_LABEL,
  type MailboxAckStatement,
  signAck,
  verifyAck,
} from "./ack"
import { toHex } from "./bytes"

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false)
  return out
}

const userId = "11111111-1111-4111-8111-111111111111"
const accountId = "acc0acc0-0000-4000-8000-000000000001"

async function signer() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" } as never, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  return { pair, spki }
}

async function statement(): Promise<MailboxAckStatement> {
  return {
    userId,
    accountId,
    keyId: 7,
    nonce: "9f2c4a1e-0000-4000-8000-00000000abcd",
    count: 3,
    idSetDigest: await computeIdSetDigest(["m-3", "m-1", "m-2"]),
    backfillCursor: "2026-08-01T00:00:00.000Z|m-3",
  }
}

describe("T-CRYPTO-14 acknowledgement signing", () => {
  it("signs and verifies", async () => {
    const { pair, spki } = await signer()
    const s = await statement()
    const signature = await signAck(pair.privateKey, s)
    expect(signature.length).toBe(64)
    expect(await verifyAck(pair.publicKey, s, signature)).toBe(true)
    expect(await verifyAck(spki, s, signature)).toBe(true)
  })

  it("fails on a tampered digest", async () => {
    const { pair } = await signer()
    const s = await statement()
    const signature = await signAck(pair.privateKey, s)
    const idSetDigest = Uint8Array.from(s.idSetDigest)
    idSetDigest[0] ^= 0x01
    expect(await verifyAck(pair.publicKey, { ...s, idSetDigest }, signature)).toBe(false)
  })

  it("fails on a tampered count", async () => {
    const { pair } = await signer()
    const s = await statement()
    const signature = await signAck(pair.privateKey, s)
    expect(await verifyAck(pair.publicKey, { ...s, count: s.count + 1 }, signature)).toBe(false)
  })

  it("fails on a tampered nonce", async () => {
    const { pair } = await signer()
    const s = await statement()
    const signature = await signAck(pair.privateKey, s)
    expect(await verifyAck(pair.publicKey, { ...s, nonce: `${s.nonce}x` }, signature)).toBe(false)
  })

  it("fails on a tampered key id under the SAME signing key", async () => {
    // The key id is inside the signed statement, so this fails on the
    // signature alone. Before the key id was bound, a swapped key id failed
    // only indirectly, because the server happened to look up a different
    // sign_public_key, which is not the same property at all: two key ids that
    // shared a signing key would have let the swap through unnoticed.
    const { pair } = await signer()
    const s = await statement()
    const signature = await signAck(pair.privateKey, s)
    expect(await verifyAck(pair.publicKey, s, signature)).toBe(true)
    expect(await verifyAck(pair.publicKey, { ...s, keyId: s.keyId + 1 }, signature)).toBe(false)
    expect(await verifyAck(pair.publicKey, { ...s, keyId: 0 }, signature)).toBe(false)
  })

  it("also fails under another key id's signing key", async () => {
    const first = await signer()
    const second = await signer()
    const s = await statement()
    const signature = await signAck(first.pair.privateKey, s)
    expect(await verifyAck(second.pair.publicKey, s, signature)).toBe(false)
    expect(await verifyAck(second.spki, s, signature)).toBe(false)
  })

  it("refuses to encode a key id that is not a single byte", async () => {
    const s = await statement()
    expect(() => encodeAckStatement({ ...s, keyId: 256 })).toThrow()
    expect(() => encodeAckStatement({ ...s, keyId: -1 })).toThrow()
  })

  it("fails on a tampered user id, account id or backfill cursor", async () => {
    const { pair } = await signer()
    const s = await statement()
    const signature = await signAck(pair.privateKey, s)
    for (const variant of [
      { ...s, userId: "22222222-2222-4222-8222-222222222222" },
      { ...s, accountId: "acc0acc0-0000-4000-8000-000000000002" },
      { ...s, backfillCursor: "2026-08-02T00:00:00.000Z|m-9" },
    ]) {
      expect(await verifyAck(pair.publicKey, variant, signature)).toBe(false)
    }
  })

  it("encodes the exact field order Phase 12's verifier must match", async () => {
    const s = await statement()
    const encoded = encodeAckStatement(s)
    const enc = new TextEncoder()
    const parts: Uint8Array[] = [
      enc.encode(MAILBOX_ACK_LABEL),
      new Uint8Array([0]),
      enc.encode(s.userId),
      new Uint8Array([0]),
      enc.encode(s.accountId),
      new Uint8Array([0]),
      new Uint8Array([s.keyId]),
      new Uint8Array([0]),
      enc.encode(s.nonce),
      new Uint8Array([0]),
      u64(s.count),
      new Uint8Array([0]),
      s.idSetDigest,
      new Uint8Array([0]),
      enc.encode(s.backfillCursor),
    ]
    const total = parts.reduce((acc, p) => acc + p.length, 0)
    const expected = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      expected.set(part, offset)
      offset += part.length
    }
    expect(toHex(encoded)).toBe(toHex(expected))
  })

  it("starts the signed bytes with the versioned label", async () => {
    const encoded = encodeAckStatement(await statement())
    expect(new TextDecoder().decode(encoded.subarray(0, MAILBOX_ACK_LABEL.length))).toBe(
      MAILBOX_ACK_LABEL,
    )
    expect(encoded[MAILBOX_ACK_LABEL.length]).toBe(0)
  })
})

describe("id set digest", () => {
  it("is order independent through an ASCII sort", async () => {
    const forward = await computeIdSetDigest(["m-1", "m-2", "m-10"])
    const shuffled = await computeIdSetDigest(["m-10", "m-2", "m-1"])
    expect(toHex(forward)).toBe(toHex(shuffled))
  })

  it("changes when the covered set changes", async () => {
    const base = await computeIdSetDigest(["m-1", "m-2"])
    expect(toHex(await computeIdSetDigest(["m-1", "m-3"]))).not.toBe(toHex(base))
    expect(toHex(await computeIdSetDigest(["m-1"]))).not.toBe(toHex(base))
    expect(toHex(await computeIdSetDigest(["m-1", "m-2", "m-3"]))).not.toBe(toHex(base))
  })

  it("is the SHA-256 of the ASCII sorted newline joined ids", async () => {
    const ids = ["m-3", "m-1", "m-2"]
    const expected = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("m-1\nm-2\nm-3")),
    )
    expect(toHex(await computeIdSetDigest(ids))).toBe(toHex(expected))
  })

  it("joins with no trailing newline, which the server recompute must match", async () => {
    const withTrailing = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode("m-1\nm-2\n")),
    )
    expect(toHex(await computeIdSetDigest(["m-1", "m-2"]))).not.toBe(toHex(withTrailing))
  })

  it("refuses a duplicate id, which would misstate coverage", async () => {
    await expect(computeIdSetDigest(["m-1", "m-1"])).rejects.toThrow()
  })
})
