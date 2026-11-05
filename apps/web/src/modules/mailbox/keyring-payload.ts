// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One conversion, kept out of the fixtures so shipped code does not import a
// test file: a generated keyring entry to the base64 payload shape the worker
// and the device-local keyring store both speak.

import type { KeyringEntry } from "@liaison/mailbox-crypto/src/client"
import type { KeyringEntryPayload } from "~/modules/mailbox/crypto-protocol"
import { bytesToBase64 } from "~/modules/mailbox/mailbox-bytes"

export function keyringPayloadFromEntry(entry: KeyringEntry): KeyringEntryPayload {
  return {
    keyId: entry.keyId,
    status: entry.status,
    ecdhSpki: bytesToBase64(entry.ecdhSpki),
    signSpki: bytesToBase64(entry.signSpki),
    wrappedEcdhPrivate: bytesToBase64(entry.wrappedEcdhPrivate),
    wrappedSignPrivate: bytesToBase64(entry.wrappedSignPrivate),
    ecdhWrapIv: bytesToBase64(entry.ecdhWrapIv),
    signWrapIv: bytesToBase64(entry.signWrapIv),
  }
}
