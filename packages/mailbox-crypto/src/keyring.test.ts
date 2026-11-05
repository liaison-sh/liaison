// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.6, the keyring attestation half. Phase 13's downgrade detector is its
// consumer; this file pins the canonical encoding and the verifier so the two
// halves cannot drift.

import { describe, expect, it } from "bun:test"
import { generateAccountKey } from "./account-key"
import { toHex } from "./bytes"
import { activeKeyringEntry, generateIdentityKey, retireKeyId } from "./keyring"
import {
  type AttestedIdentity,
  encodeKeyringStatement,
  signKeyringAttestation,
  verifyKeyringAttestation,
} from "./keyring-attestation"

const userId = "11111111-1111-4111-8111-111111111111"

async function keyring() {
  const accountKey = generateAccountKey()
  const first = await generateIdentityKey({ accountKey, userId, keyId: 1 })
  const second = await generateIdentityKey({ accountKey, userId, keyId: 2 })
  const entries = retireKeyId([first.entry, second.entry], 1)
  const identities: AttestedIdentity[] = entries.map((entry) => ({
    keyId: entry.keyId,
    status: entry.status,
    ecdhSpki: entry.ecdhSpki,
    signSpki: entry.signSpki,
  }))
  return { accountKey, entries, identities, signer: second.privateKeys.signPrivate }
}

describe("keyring attestation", () => {
  it("signs and verifies the identity list", async () => {
    const { identities, entries, signer } = await keyring()
    const attestation = await signKeyringAttestation({
      signPrivateKey: signer,
      userId,
      identities,
    })
    expect(attestation.length).toBe(64)
    expect(
      await verifyKeyringAttestation({
        signPublicKey: activeKeyringEntry(entries).signSpki,
        userId,
        identities,
        attestation,
      }),
    ).toBe(true)
  })

  it("fails when an extra active identity is injected", async () => {
    const { identities, entries, signer } = await keyring()
    const attestation = await signKeyringAttestation({
      signPrivateKey: signer,
      userId,
      identities,
    })
    const injected = [
      ...identities,
      {
        keyId: 3,
        status: "active" as const,
        ecdhSpki: identities[0].ecdhSpki,
        signSpki: identities[0].signSpki,
      },
    ]
    expect(
      await verifyKeyringAttestation({
        signPublicKey: activeKeyringEntry(entries).signSpki,
        userId,
        identities: injected,
        attestation,
      }),
    ).toBe(false)
  })

  it("fails when a status, a key id, a public key or the user id changes", async () => {
    const { identities, entries, signer } = await keyring()
    const publicKey = activeKeyringEntry(entries).signSpki
    const attestation = await signKeyringAttestation({
      signPrivateKey: signer,
      userId,
      identities,
    })
    const variants: Array<{ name: string; identities: AttestedIdentity[]; userId: string }> = [
      {
        name: "status flipped",
        identities: identities.map((i) =>
          i.keyId === 1 ? { ...i, status: "active" as const } : i,
        ),
        userId,
      },
      {
        name: "key id renumbered",
        identities: identities.map((i) => (i.keyId === 2 ? { ...i, keyId: 4 } : i)),
        userId,
      },
      {
        name: "ecdh key substituted",
        identities: identities.map((i) =>
          i.keyId === 2 ? { ...i, ecdhSpki: identities[0].ecdhSpki } : i,
        ),
        userId,
      },
      { name: "user id changed", identities, userId: "22222222-2222-4222-8222-222222222222" },
    ]
    for (const variant of variants) {
      expect(
        await verifyKeyringAttestation({
          signPublicKey: publicKey,
          userId: variant.userId,
          identities: variant.identities,
          attestation,
        }),
        variant.name,
      ).toBe(false)
    }
  })

  it("encodes independently of the order the identities arrive in", async () => {
    const { identities } = await keyring()
    const forward = encodeKeyringStatement({ userId, identities })
    const reversed = encodeKeyringStatement({ userId, identities: [...identities].reverse() })
    expect(toHex(forward)).toBe(toHex(reversed))
  })

  it("refuses to encode a duplicate key id", async () => {
    const { identities } = await keyring()
    expect(() =>
      encodeKeyringStatement({ userId, identities: [identities[0], identities[0]] }),
    ).toThrow()
  })
})

describe("keyring shape", () => {
  it("insists on exactly one active key id", async () => {
    const accountKey = generateAccountKey()
    const first = await generateIdentityKey({ accountKey, userId, keyId: 1 })
    const second = await generateIdentityKey({ accountKey, userId, keyId: 2 })
    expect(() => activeKeyringEntry([first.entry, second.entry])).toThrow()
    expect(() => retireKeyId([first.entry], 1)).toThrow()
    expect(() => retireKeyId([first.entry, second.entry], 9)).toThrow()
    expect(activeKeyringEntry(retireKeyId([first.entry, second.entry], 1)).keyId).toBe(2)
  })
})
