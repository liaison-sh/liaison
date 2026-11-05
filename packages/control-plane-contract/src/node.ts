// SPDX-License-Identifier: FSL-1.1-ALv2
// Node-only helpers of the control plane contract (`node:crypto`). The
// instance signs with these; the control plane side reproduces the same bytes
// with its sandbox bridge or a pure-JS HMAC, proven on `contractVectors.signing`.
import { createHash, createHmac } from "node:crypto"
import { canonicalJson, INSTANCE_KEY_LABEL } from "./index"

/** `hex(HMAC-SHA256(masterSecret, "liaison-instance-key:v1:" + instanceId))`, 64 hex chars. */
export function deriveInstanceKey(masterSecret: string, instanceId: string): string {
  return createHmac("sha256", masterSecret)
    .update(INSTANCE_KEY_LABEL + instanceId)
    .digest("hex")
}

/**
 * The `x-liaison-signature` value: base64 HMAC-SHA256 keyed by the instance key
 * (its hex string as UTF-8) over the raw request body bytes.
 */
export function signBody(instanceKey: string, rawBody: string | Uint8Array): string {
  return createHmac("sha256", instanceKey).update(rawBody).digest("base64")
}

/** sha256 hex of `canonicalJson(value)`: key order never changes it. */
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}
