// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser half of the `/api/mailbox-keys` and `/api/mailbox` surface
// (spec section 6.3). Nothing here decrypts anything: it moves opaque base64
// between the server and the crypto worker.
//
// The wrap LISTING and the wrap BLOB are separate calls on purpose. The listing
// is metadata; a blob is a wrapped Account Key, which is an offline cracking
// oracle, so it is fetched one named wrap at a time and the server rate limits
// it. Never widen this file into a "fetch all my wrap blobs" helper.

import type {
  KeyringEntryPayload,
  MailboxUnlockMethod,
  WrapBlobPayload,
} from "~/modules/mailbox/crypto-protocol"

export interface MailboxApi {
  get: <T = unknown>(path: string) => Promise<T>
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
  delete: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

export interface IdentityView {
  id: string
  keyId: number
  status: "active" | "retired"
  ecdhPublicKey: string
  signPublicKey: string
  attestation: string
  createdAt: string
  retiredAt: string | null
  /**
   * The wrapped PRIVATE halves, base64. Ciphertext under the Account Key with a
   * bound AAD, so the server holding them concedes nothing: without the Account
   * Key they are noise, and the Account Key never leaves the browser.
   *
   * They are what makes the mailbox survive this browser. A keyring that lives
   * only in localStorage dies with a cleared profile, and no mailbox password
   * can bring it back, because the password recovers the Account Key and the
   * Account Key opens nothing on its own.
   *
   * Optional because a server that predates the columns answers without them;
   * the unlock path then falls back to the device-local copy.
   */
  wrappedEcdhPrivate?: string | null
  wrappedSignPrivate?: string | null
  ecdhWrapIv?: string | null
  signWrapIv?: string | null
}

export interface WrapMetadataView {
  id: string
  type: MailboxUnlockMethod
  label: string | null
  createdAt: string
  lastUsedAt: string | null
}

export interface KeyringView {
  identityId: string | null
  keyId: number | null
  identities: IdentityView[]
  wraps: WrapMetadataView[]
}

export interface MigrationStateView {
  enrolledAt: string | null
  backfillStartedAt: string | null
  backfillCompletedAt: string | null
  messagesTotal: number | null
  messagesSealed: number | null
  clientVerifiedAt: string | null
  plaintextPurgedAt: string | null
  backupsClearAfter: string | null
}

export interface EnrollWrapInput {
  wrapType: MailboxUnlockMethod
  label?: string | null
  credentialId?: string | null
  wrappedAccountKey: string
  kdfParams?: Record<string, unknown> | null
  verifier?: string | null
}

/** The keyring statement the enroll and rotate routes both take. */
export interface IdentityInput {
  ecdhPublicKey: string
  signPublicKey: string
  keyId: number
  attestation: string
  /** Ciphertext under the Account Key. See `IdentityView` for why it is safe. */
  wrappedEcdhPrivate: string
  wrappedSignPrivate: string
  ecdhWrapIv: string
  signWrapIv: string
}

export interface EnrollInput extends IdentityInput {
  wraps: EnrollWrapInput[]
}

export function fetchKeyring(api: MailboxApi): Promise<KeyringView> {
  return api.get<KeyringView>("/mailbox-keys/me")
}

export function fetchWrapBlob(api: MailboxApi, wrap: WrapMetadataView): Promise<WrapBlobPayload> {
  return api
    .get<{ wrappedAccountKey: string; kdfParams: WrapBlobPayload["kdfParams"] }>(
      `/mailbox-keys/wraps/${wrap.id}/blob`,
    )
    .then((blob) => ({
      id: wrap.id,
      wrapType: wrap.type,
      wrappedAccountKey: blob.wrappedAccountKey,
      kdfParams: blob.kdfParams,
    }))
}

export function enrollKeyring(api: MailboxApi, input: EnrollInput): Promise<KeyringView> {
  return api.post<KeyringView>("/mailbox-keys/enroll", input)
}

export function addWrap(api: MailboxApi, input: EnrollWrapInput): Promise<WrapMetadataView> {
  return api.post<WrapMetadataView>("/mailbox-keys/wraps", input)
}

export function deleteWrap(api: MailboxApi, wrapId: string): Promise<unknown> {
  return api.delete(`/mailbox-keys/wraps/${wrapId}`)
}

/** What `POST /mailbox-keys/reset` answers: the mailboxes that will re-sync. */
export interface MailboxResetView {
  accountIds: string[]
}

/**
 * Email a one-time confirmation code to the signed-in user. The reset is
 * destructive, so like a two-factor change it needs a step-up confirmation;
 * the emailed code works for every account, passwordless ones included.
 */
export function requestMailboxResetCode(api: MailboxApi): Promise<unknown> {
  return api.post("/auth/totp/step-up", { purpose: "mailbox_reset" })
}

/**
 * Forgot the mailbox password: delete the keyring and every encrypted copy of
 * this user's personal mail on the server. The Gmail connection stays; the
 * mailbox re-downloads after the next enrollment.
 */
export function resetMailboxKeys(api: MailboxApi, stepUpCode: string): Promise<MailboxResetView> {
  return api.post<MailboxResetView>("/mailbox-keys/reset", { stepUpCode })
}

export interface ClearedFindingInput {
  kind: string
  subject: string
  detectedAt: string
}

/**
 * Tell the server the owner cleared the integrity warning on this device, so
 * the clear shows in the audit trail. It RECORDS only: the warning lives in
 * this browser and the server has no way to remove it.
 */
export function recordIntegrityAlarmCleared(
  api: MailboxApi,
  findings: readonly ClearedFindingInput[],
): Promise<{ recorded: true; clearedAt: string }> {
  return api.post("/mailbox-keys/integrity-alarm-cleared", {
    findings: findings.map(({ kind, subject, detectedAt }) => ({ kind, subject, detectedAt })),
  })
}

export function fetchMigrationState(api: MailboxApi): Promise<MigrationStateView | null> {
  return api.get<MigrationStateView | null>("/mailbox/migration-state")
}

/**
 * The keyring the SERVER holds, in the shape the worker consumes.
 *
 * An identity row missing any of the four wrapped-private fields is skipped
 * rather than half built: a partial entry cannot be unwrapped, and passing one
 * to the worker turns a recoverable "this server has no keyring" into an
 * unexplained unwrap failure.
 */
export function keyringEntriesFromKeyringView(view: KeyringView): KeyringEntryPayload[] {
  const entries: KeyringEntryPayload[] = []
  for (const identity of view.identities) {
    const { wrappedEcdhPrivate, wrappedSignPrivate, ecdhWrapIv, signWrapIv } = identity
    if (!wrappedEcdhPrivate || !wrappedSignPrivate || !ecdhWrapIv || !signWrapIv) continue
    entries.push({
      keyId: identity.keyId,
      status: identity.status,
      ecdhSpki: identity.ecdhPublicKey,
      signSpki: identity.signPublicKey,
      wrappedEcdhPrivate,
      wrappedSignPrivate,
      ecdhWrapIv,
      signWrapIv,
    })
  }
  return entries
}
