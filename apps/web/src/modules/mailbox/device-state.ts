// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What THIS browser remembers about the user's mailbox unlock, and how it is
// forgotten.
//
// The mailbox password works on every machine; a passkey is a per-machine
// shortcut. WebAuthn cannot list the passkeys a device holds, so the only way
// to know "this device has a passkey that works here" is to remember which
// passkey wrap last unlocked on it. That is all the marker is: a wrap id, not a
// secret, kept in localStorage like the wrapped keyring cache.
//
// Everything here is per user and per device, and every read and write is
// wrapped: a browser that blocks site data simply offers the password first.

import { forgetDowngradeRecords } from "~/modules/mailbox/downgrade-detector"
import { clearWrappedKeyring } from "~/modules/mailbox/keyring-storage"
import { createIndexedDbBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import { stopMailboxSearchIndex } from "~/modules/mailbox/search-index/search-index-host"

const PASSKEY_PREFIX = "liaison.mailbox.passkey."
const PASSKEY_DECLINED_PREFIX = "liaison.mailbox.passkey-declined."

/** The passkey wrap that last unlocked on this device, if any. */
export function devicePasskeyWrapId(userId: string): string | null {
  try {
    return localStorage.getItem(`${PASSKEY_PREFIX}${userId}`)
  } catch {
    return null
  }
}

export function rememberDevicePasskey(userId: string, wrapId: string): void {
  try {
    localStorage.setItem(`${PASSKEY_PREFIX}${userId}`, wrapId)
  } catch {
    // Not remembered: the next unlock offers the password first. Nothing breaks.
  }
}

export function forgetDevicePasskey(userId: string): void {
  try {
    localStorage.removeItem(`${PASSKEY_PREFIX}${userId}`)
  } catch {
    // Nothing stored.
  }
}

/** The user said "not now" to adding a passkey on this device. */
export function devicePasskeyDeclined(userId: string): boolean {
  try {
    return localStorage.getItem(`${PASSKEY_DECLINED_PREFIX}${userId}`) === "1"
  } catch {
    return false
  }
}

export function declineDevicePasskey(userId: string): void {
  try {
    localStorage.setItem(`${PASSKEY_DECLINED_PREFIX}${userId}`, "1")
  } catch {
    // Asked again next time. Harmless.
  }
}

/**
 * Drop this device's integrity records and search index for a mailbox whose
 * keys changed under the user's own hand. See `forgetDowngradeRecords` for why
 * this is only ever called after the user proved the new keys are theirs.
 */
export async function forgetMailboxIntegrityState(userId: string): Promise<void> {
  // The messages this tab already loaded are sealed to the OLD keys. Left in
  // memory, the next unlock's integrity check tries them with the NEW key, they
  // do not open, and the user's own reset is reported as tampering, in an alarm
  // that persists. Drop them first; they are re-fetched under the new keys.
  const { resetMailMessageStore } = await import("~/modules/mail/mail-message-store")
  resetMailMessageStore()
  await forgetDowngradeRecords(
    createIndexedDbBlobStore("liaison-mailbox-integrity", "records"),
    userId,
  )
  stopMailboxSearchIndex()
  try {
    // Shards sealed under the old Account Key open under nothing now.
    await createIndexedDbBlobStore().clear()
  } catch {
    // No index stored.
  }
}

/**
 * Everything this device holds about the mailbox, after the user reset it here:
 * the cached wrapped keyring (it wraps keys that no longer exist), the passkey
 * marker (that wrap is deleted), the integrity records and the search index.
 */
export async function forgetMailboxDeviceState(userId: string): Promise<void> {
  clearWrappedKeyring(userId)
  forgetDevicePasskey(userId)
  try {
    localStorage.removeItem(`${PASSKEY_DECLINED_PREFIX}${userId}`)
  } catch {
    // Nothing stored.
  }
  await forgetMailboxIntegrityState(userId)
}
