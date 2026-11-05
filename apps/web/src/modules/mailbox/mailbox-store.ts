// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The page's view of the mailbox lock state. It holds NO key material: the one
// thing it keeps is a handle to the crypto client, which is itself only a
// postMessage channel to the worker.
//
// Everything that reads mail goes through `openSealedMessage`, which answers
// null when the mailbox is locked. A locked mailbox is a state to render, never
// an error to throw: that distinction is what T-WEB-3 pins.

import { createStore } from "solid-js/store"
import { requestResync } from "~/framework/resync"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { inWrappedShell, loginSessionExpiresAt, userFromToken } from "~/modules/auth/auth-store"
import type { MailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import type {
  DeviceLeaseRequest,
  MintedWrap,
  WrapBlobPayload,
} from "~/modules/mailbox/crypto-protocol"
import {
  IDLE_TIMEOUT_DEFAULT_MS,
  type KeyringEntryPayload,
  MAILBOX_RESET_ELSEWHERE,
  MAILBOX_RUNTIME_FAILED,
  MAILBOX_UNLOCK_REFUSED,
  MailboxCryptoError,
  type MailboxErrorCode,
  type OpenedConversation,
  type OpenedMessage,
  type SealedConversationPayload,
  type SealedMessagePayload,
  type UnlockRequest,
} from "~/modules/mailbox/crypto-protocol"
import { loadWrappedKeyring, saveWrappedKeyring } from "~/modules/mailbox/keyring-storage"
import {
  addWrap,
  deleteWrap,
  fetchKeyring,
  fetchWrapBlob,
  type KeyringView,
  keyringEntriesFromKeyringView,
  type MailboxApi,
  type WrapMetadataView,
} from "~/modules/mailbox/mailbox-api"

export type MailboxStatus = "unknown" | "not-enrolled" | "locked" | "unlocked"

interface MailboxStoreState {
  status: MailboxStatus
  keyring: KeyringView | null
  lastErrorCode: MailboxErrorCode | null
  idleTimeoutMs: number
  /** True when this device holds no wrapped keyring for the signed-in user. */
  deviceMissingKeyring: boolean
}

const [mailboxStore, setMailboxStore] = createStore<MailboxStoreState>({
  status: "unknown",
  keyring: null,
  lastErrorCode: null,
  idleTimeoutMs: IDLE_TIMEOUT_DEFAULT_MS,
  deviceMissingKeyring: false,
})

export { mailboxStore }

let client: MailboxCryptoClient | null = null

export function setMailboxCryptoClient(next: MailboxCryptoClient | null): void {
  client = next
}

export function mailboxCryptoClient(): MailboxCryptoClient | null {
  return client
}

export function isMailboxUnlocked(): boolean {
  return mailboxStore.status === "unlocked"
}

/**
 * What the assistant-mail switch sync needs right now: the holder, and the
 * crypto client only while the mailbox is unlocked (agent-mail-access.ts).
 */
export function agentMailAccessSyncDeps(): {
  userId: string | null
  crypto: MailboxCryptoClient | null
} {
  return {
    userId: userFromToken()?.userId ?? null,
    crypto: isMailboxUnlocked() ? client : null,
  }
}

/**
 * The lease this device keeps the unlocked mailbox under: the signed-in user's
 * organisation and the end of the current login. None without a login, and
 * then nothing is persisted or restored.
 */
export function mailboxDeviceLease(): DeviceLeaseRequest | undefined {
  const orgId = userFromToken()?.orgId
  const expiresAt = loginSessionExpiresAt()
  if (!orgId || expiresAt === null) return undefined
  return { orgId, expiresAt, exclusive: !inWrappedShell() }
}

/**
 * A token renewal: the unlock on this device now lasts until the renewed
 * login ends. Best effort, and a no-op while nothing is unlocked.
 */
export async function extendMailboxDeviceLease(): Promise<boolean> {
  const current = client
  const userId = userFromToken()?.userId
  const lease = mailboxDeviceLease()
  if (!current || !userId || !lease) return false
  try {
    return await current.extendLease({ userId, orgId: lease.orgId, expiresAt: lease.expiresAt })
  } catch {
    return false
  }
}

/**
 * The worker stopped answering, or says it is locked: the PAGE shows the
 * mailbox locked, and nothing on the device is deleted. Deleting this device's
 * handles is for a sign-out, an ended session or a reset, never for a reply
 * that came late; a late reply used to cost the user their next unlock.
 */
export function noteMailboxLockedHere(): void {
  setMailboxStore({ status: "locked" })
}

/**
 * Fetch the keyring and settle the lock state. An enrolled mailbox this device
 * already unlocked since the last login re-opens here from the persisted
 * handles, BEFORE the status leaves "unknown": the reader never sees a locked
 * mailbox (or an unlock prompt) that the next few milliseconds would open.
 */
/**
 * The scope that reaches the mailbox at all (the server's MAILBOX_KEYS_SCOPE).
 * Without it there is no keyring to read and nothing to unlock: no mailbox
 * call is made and no unlock surface is offered.
 */
export const MAIL_READ_SCOPE = "mail:conversations:read"

export async function loadMailboxKeyring(
  api: MailboxApi,
  userId: string | null = userFromToken()?.userId ?? null,
): Promise<KeyringView> {
  const keyring = await fetchKeyring(api)
  const enrolled = keyring.identities.some((identity) => identity.status === "active")
  const restored = enrolled && userId ? await restoreFromDevice(userId, keyring) : false
  setMailboxStore({
    keyring,
    status: enrolled ? (client?.isUnlocked() ? "unlocked" : "locked") : "not-enrolled",
  })
  // Whatever rendered while this was in flight rendered locked.
  if (restored) requestResync("mailbox-unlock")
  return keyring
}

let restoring: Promise<boolean> | null = null

/** True only when this call is the one that re-opened the session. */
async function restoreFromDevice(userId: string, keyring: KeyringView): Promise<boolean> {
  const current = client
  if (!current || current.isUnlocked()) return false
  const entries = keyringEntriesFromKeyringView(keyring)
  if (entries.length === 0) return false
  if (restoring) {
    await restoring
    return false
  }
  const lease = mailboxDeviceLease()
  if (!lease) return false
  restoring = current.restore({ userId, keyring: entries, lease }).catch(() => false)
  try {
    return await restoring
  } finally {
    restoring = null
  }
}

export interface UnlockAttempt {
  userId: string
  wrap: WrapMetadataView
  /** The mailbox password text. */
  secret?: string
  /**
   * The passkey path: the PRF secret only exists after a ceremony that needs
   * the wrap's own salt and credential id, so it is resolved from the blob.
   */
  resolveSecret?: (blob: WrapBlobPayload) => Promise<string>
  /** Keep the Account Key in the worker so this session can add an unlock method. */
  mintWraps?: boolean
}

function sameEntry(a: KeyringEntryPayload, b: KeyringEntryPayload): boolean {
  return (
    a.keyId === b.keyId &&
    a.ecdhSpki === b.ecdhSpki &&
    a.signSpki === b.signSpki &&
    a.wrappedEcdhPrivate === b.wrappedEcdhPrivate &&
    a.wrappedSignPrivate === b.wrappedSignPrivate
  )
}

/**
 * Fetch exactly the one wrap blob the user chose, hand it to the worker, and
 * record the outcome. A refusal is stored as a CODE so the surface can pick its
 * own words; this module never writes a sentence about someone's mail.
 *
 * The keyring the worker unwraps is the SERVER's whenever it has one, and this
 * device's cache only when it has none (a server that predates the wrapped
 * private halves, or no network for the listing). The cache used to win, which
 * was fine while the keys never changed; after a mailbox reset on another
 * machine the cache holds keys that no longer exist, and the new mailbox
 * password could never open them. A keyring the user's own secret opens is
 * theirs, so a successful unlock re-caches it, and when the cache it replaces
 * was a DIFFERENT keyring (a reset, not a rotation) this device's integrity
 * records go with it.
 */
export async function unlockMailbox(api: MailboxApi, attempt: UnlockAttempt): Promise<boolean> {
  if (!client) throw new Error("the mailbox crypto worker is not running")
  const method = attempt.wrap.type
  if (method !== "passphrase" && method !== "passkey_prf") {
    // A legacy recovery phrase wrap: nothing offers it any more.
    setMailboxStore({ status: "locked", lastErrorCode: "MAILBOX_UNLOCK_REFUSED" })
    return false
  }
  const blob = await fetchWrapBlob(api, attempt.wrap)
  const cached = loadWrappedKeyring(attempt.userId)
  let fromServer: KeyringEntryPayload[] = []
  try {
    fromServer = keyringEntriesFromKeyringView(await fetchKeyring(api))
  } catch {
    // No listing: the device cache is the only copy this attempt can use.
  }
  const keyring = fromServer.length > 0 ? fromServer : cached
  if (keyring.length === 0) {
    setMailboxStore({ deviceMissingKeyring: true, lastErrorCode: "MAILBOX_KEYRING_UNAVAILABLE" })
    return false
  }
  // Rotation only ADDS key ids and never changes an existing one, so a cached
  // entry the server no longer has, unchanged, means the mailbox was re-keyed.
  const rekeyed =
    fromServer.length > 0 &&
    cached.length > 0 &&
    cached.some((entry) => !fromServer.some((server) => sameEntry(entry, server)))
  const cacheStale =
    fromServer.length > 0 &&
    (cached.length !== fromServer.length ||
      fromServer.some((server) => !cached.some((entry) => sameEntry(entry, server))))
  let secret: string
  try {
    secret = attempt.resolveSecret ? await attempt.resolveSecret(blob) : (attempt.secret ?? "")
  } catch {
    // A ceremony the user cancelled or an authenticator that returned nothing:
    // the passkey was never checked, so this is not a mismatch.
    setMailboxStore({
      status: client.isUnlocked() ? "unlocked" : "locked",
      lastErrorCode: "MAILBOX_PASSKEY_CEREMONY_FAILED",
    })
    return false
  }
  const request: UnlockRequest = {
    userId: attempt.userId,
    method,
    secret,
    wrap: blob,
    keyring,
    mintWraps: attempt.mintWraps,
    lease: mailboxDeviceLease(),
  }
  try {
    const result = await client.unlock(request)
    if (result.upgradedWrap) {
      await replaceLegacyPasswordWrap(api, attempt.wrap, result.upgradedWrap)
    }
    // Cache the server's ciphertext so a later unlock needs one fewer round
    // trip. It is only a cache: clearing it costs nothing now.
    if (cacheStale) saveWrappedKeyring(attempt.userId, keyring)
    if (rekeyed) {
      // The user's own secret opened the new keyring, which nobody without it
      // could have produced: this is their reset, not someone else's keys.
      const { forgetMailboxIntegrityState } = await import("~/modules/mailbox/device-state")
      await forgetMailboxIntegrityState(attempt.userId)
    }
    setMailboxStore({ status: "unlocked", lastErrorCode: null, deviceMissingKeyring: false })
    // Everything already on screen was rendered while the mailbox was locked:
    // every sealed row of every loaded conversation sits at `encState: "locked"`
    // and nothing re-opens it, so without this the reader unlocks and the mail
    // in front of them stays locked until a reload. The resync bus is the
    // existing refetch-in-place path (`~/framework/resync`), which the mail
    // message store already subscribes to.
    requestResync("mailbox-unlock")
    return true
  } catch (error) {
    // Only the worker's own verdict is a refusal. A worker that could not
    // complete the operation (its internal error, a dead channel, a timeout)
    // never checked the secret, and must not read as a wrong password.
    let code: MailboxErrorCode
    if (error instanceof MailboxCryptoError) {
      code = error.code
    } else {
      console.error("[mailbox] the unlock could not run", error)
      code = MAILBOX_RUNTIME_FAILED
    }
    // A refusal on a device that still holds the keyring from before a reset
    // made elsewhere: the password typed is the old one.
    if (code === MAILBOX_UNLOCK_REFUSED && rekeyed) code = MAILBOX_RESET_ELSEWHERE
    // A refused attempt leaves the worker as it was: a wrong secret typed to
    // CONFIRM something (clearing the integrity warning) on an open mailbox
    // does not close it.
    setMailboxStore({ status: client.isUnlocked() ? "unlocked" : "locked", lastErrorCode: code })
    return false
  }
}

/**
 * The silent migration of a legacy (Argon2id) mailbox password row, after the
 * user's own password opened it: save the PBKDF2 re-wrap the worker produced,
 * THEN delete the legacy row. Add first, delete second, so no failure can leave
 * the mailbox without a password row; the API also refuses to delete the last
 * one. Every failure is silent: the unlock already succeeded, a row that was not
 * added is retried on the next unlock, and a legacy row that was not deleted is
 * harmless because the unlock screen prefers the newest password row.
 */
async function replaceLegacyPasswordWrap(
  api: MailboxApi,
  legacy: WrapMetadataView,
  upgraded: MintedWrap,
): Promise<void> {
  try {
    await addWrap(api, { ...upgraded, label: legacy.label ?? "Mailbox password" })
  } catch {
    return
  }
  try {
    await deleteWrap(api, legacy.id)
  } catch {
    // Kept: see above.
  }
  try {
    setMailboxStore({ keyring: await fetchKeyring(api) })
  } catch {
    // The listing refreshes on the next load.
  }
}

/**
 * True when this device caches a keyring the server no longer has: the
 * mailbox was reset on another device since this one last unlocked, so the
 * password that opens it now is the NEW one chosen there.
 */
export function mailboxResetElsewhere(userId: string, keyring: KeyringView | null): boolean {
  if (!keyring) return false
  const fromServer = keyringEntriesFromKeyringView(keyring)
  const cached = loadWrappedKeyring(userId)
  return (
    fromServer.length > 0 &&
    cached.length > 0 &&
    cached.some((entry) => !fromServer.some((server) => sameEntry(entry, server)))
  )
}

let signedInEmail: Promise<string | null> | null = null

/**
 * The signed-in user's email, for naming a passkey, the hidden username a
 * password manager files the mailbox password under, and where the reset code
 * went. The token carries no email, so it is read once per session.
 */
export function mailboxOwnerEmail(api: MailboxApi): Promise<string | null> {
  signedInEmail ??= Promise.resolve()
    .then(() => api.get<{ email?: string | null } | null>("/users/me"))
    .then((profile) => (typeof profile?.email === "string" ? profile.email : null))
    .catch(() => {
      signedInEmail = null
      return null
    })
  return signedInEmail
}

export async function lockMailbox(): Promise<void> {
  await client?.lock()
  setMailboxStore({ status: "locked", lastErrorCode: null })
}

/**
 * Open one sealed row. Returns null when the mailbox is locked, which is the
 * caller's cue to render the lock state.
 */
export async function openSealedMessage(
  sealed: SealedMessagePayload,
): Promise<OpenedMessage | null> {
  if (!client) return null
  try {
    return await client.openMessage(sealed)
  } catch (error) {
    if (error instanceof MailboxCryptoError) {
      setMailboxStore({ status: "locked", lastErrorCode: error.code })
      return null
    }
    // An unexpected worker failure is still not an error page for the reader:
    // the message renders as locked and the user can unlock again.
    setMailboxStore({ lastErrorCode: "MAILBOX_LOCKED" })
    return null
  }
}

/**
 * Open one sealed conversation row (its subject and snippet, for the list).
 * Same contract as `openSealedMessage`: null means locked, never an error.
 */
export async function openSealedConversation(
  sealed: SealedConversationPayload,
): Promise<OpenedConversation | null> {
  if (!client) return null
  try {
    return await client.openConversation(sealed)
  } catch (error) {
    if (error instanceof MailboxCryptoError) {
      setMailboxStore({ status: "locked", lastErrorCode: error.code })
      return null
    }
    setMailboxStore({ lastErrorCode: "MAILBOX_LOCKED" })
    return null
  }
}

// A device that has not unlocked since the last login starts locked. The mail
// home asks once per page load, as soon as it knows the mailbox is locked,
// instead of waiting for the reader to open a message; "Not now" is then
// respected until the next load.
let landingUnlockPrompted = false

/** True the first time it is called in this page session, false after. */
export function claimLandingUnlockPrompt(): boolean {
  if (landingUnlockPrompted) return false
  landingUnlockPrompted = true
  return true
}

export function resetMailboxStore(): void {
  landingUnlockPrompted = false
  signedInEmail = null
  void client?.lock()
  client = null
  setMailboxStore({
    status: "unknown",
    keyring: null,
    lastErrorCode: null,
    idleTimeoutMs: IDLE_TIMEOUT_DEFAULT_MS,
    deviceMissingKeyring: false,
  })
}

// Logout wipes the session: the worker drops its handles and deletes the
// IndexedDB records (spec section 3.3). An ended session that is not a logout
// (a revoked or expired refresh token) is wired in `crypto-worker-boot.ts`.
onSessionTeardown(resetMailboxStore)
