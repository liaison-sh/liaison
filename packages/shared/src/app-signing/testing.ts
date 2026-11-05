// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * TEST-ONLY signing keys for app artifacts. Each call generates a fresh Ed25519
 * key pair in memory; nothing here is ever a production key, and no private key
 * is ever written anywhere. Production verification uses `APP_SIGNING_KEYS`
 * (keys.ts) and never sees these.
 */
import { ab, bytesToBase64 } from "./encoding"
import type { AppSigningKey } from "./keys"

export interface TestSigningKey {
  /** The public half, shaped like an entry of `APP_SIGNING_KEYS`. */
  key: AppSigningKey
  /** Ed25519 signature over `bytes`, base64 (the `.sig` file format). */
  sign(bytes: Uint8Array): Promise<string>
  /** The private key as PKCS#8 PEM, for tests that drive the signing CLI. */
  privatePem(): Promise<string>
}

export async function createTestSigningKey(keyId = "test-key"): Promise<TestSigningKey> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  if (!isKeyPair(pair)) throw new Error("Ed25519 key generation returned a single key")
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    key: { keyId, publicKey: bytesToBase64(raw) },
    async sign(bytes) {
      const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, ab(bytes))
      return bytesToBase64(new Uint8Array(sig))
    },
    async privatePem() {
      const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
      const b64 = bytesToBase64(der).replace(/(.{64})/g, "$1\n")
      return `-----BEGIN PRIVATE KEY-----\n${b64.trimEnd()}\n-----END PRIVATE KEY-----\n`
    },
  }
}

function isKeyPair(key: CryptoKey | CryptoKeyPair): key is CryptoKeyPair {
  return "privateKey" in key && "publicKey" in key
}
