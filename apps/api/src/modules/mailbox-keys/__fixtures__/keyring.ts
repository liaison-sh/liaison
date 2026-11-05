// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test fixture: a real keyring a test can enroll and rotate, with attestations
// that verify the way a browser's do (the enrolled identity attests itself; a
// rotation is attested by the identity it replaces). Test-only.

import {
  type AttestedIdentity,
  signKeyringAttestation,
} from "@liaison/mailbox-crypto/src/keyring-attestation"

type Identity = {
  keyId: number
  ecdhSpki: Uint8Array<ArrayBuffer>
  signSpki: Uint8Array<ArrayBuffer>
  signPrivate: CryptoKey
  ecdhPrivate: CryptoKey
}

async function newIdentity(keyId: number): Promise<Identity> {
  // Bun's WebCrypto typings return a union here; both calls make a key pair.
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  return {
    keyId,
    ecdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", ecdh.publicKey)),
    signSpki: new Uint8Array(await crypto.subtle.exportKey("spki", sign.publicKey)),
    signPrivate: sign.privateKey,
    ecdhPrivate: ecdh.privateKey,
  }
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64")

export class TestKeyring {
  private identities: Identity[] = []

  constructor(private readonly userId: string) {}

  private payload(identity: Identity, attestation: Uint8Array) {
    return {
      ecdhPublicKey: b64(identity.ecdhSpki),
      signPublicKey: b64(identity.signSpki),
      keyId: identity.keyId,
      attestation: b64(attestation),
    }
  }

  /**
   * The ECDH identity key pair of `keyId` (the active one by default), so a test
   * can open what the server sealed to it the way the owner's browser does.
   */
  ecdhIdentity(keyId?: number): { privateKey: CryptoKey; spki: Uint8Array<ArrayBuffer> } {
    const identity =
      keyId === undefined ? this.identities.at(-1) : this.identities.find((i) => i.keyId === keyId)
    if (!identity) throw new Error("enroll first")
    return { privateKey: identity.ecdhPrivate, spki: identity.ecdhSpki }
  }

  /** The enroll payload: a fresh identity that attests itself. */
  async enrollPayload(keyId = 1) {
    const identity = await newIdentity(keyId)
    this.identities = [identity]
    const attestation = await signKeyringAttestation({
      signPrivateKey: identity.signPrivate,
      userId: this.userId,
      identities: [{ ...attested(identity), status: "active" }],
    })
    return this.payload(identity, attestation)
  }

  /** A self-attested identity this keyring does NOT adopt (a stranger's key). */
  async strangerPayload(keyId: number) {
    const identity = await newIdentity(keyId)
    const attestation = await signKeyringAttestation({
      signPrivateKey: identity.signPrivate,
      userId: this.userId,
      identities: [{ ...attested(identity), status: "active" }],
    })
    return this.payload(identity, attestation)
  }

  /**
   * A rotate payload: a fresh identity, attested over the keyring as it will
   * stand by `signer` (the current identity by default).
   */
  async rotatePayload(keyId: number, opts: { signer?: "current" | "new" } = {}) {
    const identity = await newIdentity(keyId)
    const current = this.identities.at(-1)
    if (!current) throw new Error("enroll first")
    const after: AttestedIdentity[] = [
      ...this.identities.map((i) => ({ ...attested(i), status: "retired" as const })),
      { ...attested(identity), status: "active" },
    ]
    const signer = opts.signer === "new" ? identity : current
    const attestation = await signKeyringAttestation({
      signPrivateKey: signer.signPrivate,
      userId: this.userId,
      identities: after,
    })
    this.identities.push(identity)
    return this.payload(identity, attestation)
  }
}

function attested(i: Identity): Omit<AttestedIdentity, "status"> {
  return { keyId: i.keyId, ecdhSpki: i.ecdhSpki, signSpki: i.signSpki }
}
