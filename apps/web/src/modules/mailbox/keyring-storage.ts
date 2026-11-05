// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CACHE of the WRAPPED identity private halves on this device.
//
// It is a cache and not the record. The durable copy is server side: enrollment
// POSTs `wrappedEcdhPrivate` / `wrappedSignPrivate` and their IVs alongside the
// public halves, and `unlockMailbox` rebuilds the keyring from
// `GET /mailbox-keys/me` whenever this device holds none. That is what makes a
// fresh browser profile with only the mailbox password able to open the mailbox
// (spec SC10), and what stops "clear site data" from destroying it.
//
// So losing this entry costs one extra request and nothing else. Never make it
// the only copy again.
//
// What is stored here is CIPHERTEXT: private halves wrapped under the Account
// Key with a bound AAD. It is not a secret on its own, which is why localStorage
// is acceptable for it while nothing unwrapped ever goes near browser storage.

import type { KeyringEntryPayload } from "~/modules/mailbox/crypto-protocol"

const STORAGE_PREFIX = "liaison.mailbox.keyring."

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`
}

export function saveWrappedKeyring(userId: string, entries: KeyringEntryPayload[]): boolean {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(entries))
    return true
  } catch {
    // Site data can be blocked. The caller re-prompts or re-enrols; it never
    // shows an error page for this.
    return false
  }
}

export function loadWrappedKeyring(userId: string): KeyringEntryPayload[] {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as KeyringEntryPayload[]) : []
  } catch {
    return []
  }
}

export function clearWrappedKeyring(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId))
  } catch {
    // Nothing more this layer can do.
  }
}
