// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The WebAuthn PRF ceremonies (spec section 3.2). There are TWO of them and
// either can refuse:
//
//   1. `credentials.create({ extensions: { prf: {} } })` asks the authenticator
//      to bind PRF. Only `getClientExtensionResults().prf.enabled === true`
//      means it did. Anything else and we must NOT persist a `passkey_prf` wrap
//      row: its KEK could never be reproduced, and a broken row is worse than
//      no row.
//   2. `credentials.get({ extensions: { prf: { eval: { first: salt } } } })`
//      returns the actual secret. Eval at create is not returned by most
//      authenticators, so this second prompt is the normal case, and the UI
//      says so before it starts.
//
// A wrap row is persisted only after a PRF secret has actually unwrapped a test
// blob, which is what `buildPasskeyWrap` proves before returning.

import {
  type AccountKeyWrap,
  decidePasskeyWrap,
  unwrapWithPrfSecret,
  wrapWithPrfSecret,
} from "@liaison/mailbox-crypto/src/client"
import type { WrapBlobPayload } from "~/modules/mailbox/crypto-protocol"
import { type Bytes, base64ToBytes, bytesToBase64 } from "~/modules/mailbox/mailbox-bytes"

export type PasskeyRegistration =
  | { kind: "eligible"; credentialId: Bytes }
  | { kind: "no-wrap-row"; reason: string }

interface CredentialLike {
  rawId: ArrayBuffer
  getClientExtensionResults(): { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } }
}

function credentialsApi(): CredentialContainer {
  const container = (globalThis.navigator as Navigator | undefined)?.credentials
  if (!container) throw new Error("this browser has no WebAuthn support")
  return container as unknown as CredentialContainer
}

interface CredentialContainer {
  create(options: unknown): Promise<CredentialLike | null>
  get(options: unknown): Promise<CredentialLike | null>
}

function toBytes(buffer: ArrayBuffer): Bytes {
  return new Uint8Array(buffer.slice(0)) as Bytes
}

export async function registerPasskeyForPrf(input: {
  userId: string
  userName: string
  rpName?: string
}): Promise<PasskeyRegistration> {
  const credential = await credentialsApi().create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: input.rpName ?? "Liaison" },
      user: {
        id: new TextEncoder().encode(input.userId),
        name: input.userName,
        displayName: input.userName,
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: {} },
    },
  })
  if (!credential) return { kind: "no-wrap-row", reason: "the passkey was not created" }
  const decision = decidePasskeyWrap(credential.getClientExtensionResults())
  if (decision.kind === "no-wrap-row") return decision
  return { kind: "eligible", credentialId: toBytes(credential.rawId) }
}

/** The second ceremony. Returns null when the authenticator returns no PRF. */
export async function evaluatePrfSecret(input: {
  credentialId: Bytes
  salt: Bytes
}): Promise<Bytes | null> {
  const assertion = await credentialsApi().get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: "public-key", id: input.credentialId }],
      userVerification: "required",
      extensions: { prf: { eval: { first: input.salt } } },
    },
  })
  const first = assertion?.getClientExtensionResults().prf?.results?.first
  return first ? toBytes(first) : null
}

/**
 * The PRF secret for one passkey wrap blob, base64, as `unlockMailbox` takes it
 * in `resolveSecret`. Throws when the wrap is incomplete, the ceremony is
 * refused, or the authenticator returns no PRF output.
 */
export async function prfSecretForWrapBlob(blob: WrapBlobPayload): Promise<string> {
  const salt = blob.kdfParams?.salt
  const credentialId = blob.kdfParams?.credentialId
  if (!salt || !credentialId) throw new Error("this passkey wrap is incomplete")
  const prf = await evaluatePrfSecret({
    credentialId: base64ToBytes(credentialId),
    salt: base64ToBytes(salt),
  })
  if (!prf) throw new Error("this authenticator returned no PRF output")
  return bytesToBase64(prf)
}

export interface ProvenPasskeyWrap {
  wrap: AccountKeyWrap
  proven: true
}

/**
 * Wrap the Account Key under the PRF secret, then unwrap it again and compare.
 * Only a wrap that survives that round trip may be persisted.
 */
export async function buildPasskeyWrap(input: {
  accountKey: Bytes
  prfSecret: Bytes
  userId: string
  credentialId: Bytes
  salt?: Bytes
  /** Test seam: the secret used for the proof, when it should differ. */
  proofSecret?: Bytes
}): Promise<ProvenPasskeyWrap> {
  const salt = input.salt ?? (crypto.getRandomValues(new Uint8Array(32)) as Bytes)
  const wrap = await wrapWithPrfSecret({
    accountKey: input.accountKey,
    prfSecret: input.prfSecret,
    salt,
    userId: input.userId,
    credentialId: input.credentialId,
  })
  let reproduced: Bytes
  try {
    reproduced = await unwrapWithPrfSecret({
      wrap,
      prfSecret: input.proofSecret ?? input.prfSecret,
      userId: input.userId,
    })
  } catch {
    throw new Error("this passkey wrap could not be reproduced, so it was not saved")
  }
  const same =
    reproduced.length === input.accountKey.length &&
    reproduced.every((byte, index) => byte === input.accountKey[index])
  reproduced.fill(0)
  if (!same) throw new Error("this passkey wrap could not be reproduced, so it was not saved")
  return { wrap, proven: true }
}
