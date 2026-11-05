// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mailbox keyring persistence: the public keys, the wrapped Account Keys, and
// the per-user cutover ledger row.
//
// Everything here runs through the caller's RLS transaction, so ownership is
// enforced by the database rather than by an `if` in this file. The service
// still refuses several things the policies cannot express, and each refusal is
// about not leaving a user with an unreadable mailbox:
//   * the LAST wrap cannot be deleted, and neither can the last mailbox
//     password (`passphrase`) wrap: it is the unlock method that works on
//     every machine,
//   * enrollment without a mailbox password wrap is refused for the same
//     reason,
//   * enrollment is idempotent per user, because a second Account Key would
//     orphan everything sealed under the first.
//
// There is no recovery phrase any more. Everything in a personal mailbox is a
// copy of the provider's mail, so a user who forgets the mailbox password
// resets the mailbox (`reset.ts`) and it re-syncs; only drafts written in
// Liaison and sends waiting for approval are lost, which the product accepts.
// `recovery_phrase` rows enrolled before that decision stay readable here and
// stay in the database; no new one is accepted.
//
// `wrappedAccountKey` NEVER appears in a listing. It is an offline cracking
// oracle at passphrase KDF speed, so it is fetched one named wrap at a time, by the
// owner, through a rate-limited route.

import {
  type AttestedIdentity,
  verifyKeyringAttestation,
} from "@liaison/mailbox-crypto/src/keyring-attestation"
import { and, asc, sql as drizzleSql, eq } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient } from "~/db"
import { mailboxMigrationState, userKeyWraps, userMailboxIdentities } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { assertIdentitySealable, MailboxSealError } from "~/modules/mailbox-crypto/seal-service"
import {
  advanceOwnerEncryptionState,
  advanceOwnerEncryptionStateChecked,
} from "~/modules/mailbox-keys/encryption-state"

export const WRAP_TYPES = ["passkey_prf", "recovery_phrase", "passphrase"] as const
export type WrapType = (typeof WRAP_TYPES)[number]

/**
 * The wrap types a client may still CREATE. `recovery_phrase` is readable (rows
 * enrolled before the phrase was retired keep working server side) but no new
 * one is accepted: nothing in the product generates or offers it any more.
 */
export const NEW_WRAP_TYPES = ["passkey_prf", "passphrase"] as const

export interface WrapInput {
  wrapType: WrapType
  label?: string | null
  credentialId?: string | null
  wrappedAccountKey: string
  kdfParams?: unknown
  verifier?: string | null
}

export interface KeyringInput {
  ecdhPublicKey: string
  signPublicKey: string
  keyId: number
  attestation: string
  /**
   * The identity's private halves, wrapped under the caller's Account Key. The
   * server stores them and can never open them: see the column comments in
   * migration 0041. Optional only so a client older than that migration can
   * still enrol.
   */
  wrappedEcdhPrivate?: string | null
  wrappedSignPrivate?: string | null
  ecdhWrapIv?: string | null
  signWrapIv?: string | null
}

export interface IdentityView {
  id: string
  keyId: number
  status: string
  ecdhPublicKey: string
  signPublicKey: string
  attestation: string
  createdAt: Date
  retiredAt: Date | null
  /**
   * The wrapped private halves, base64, or null for a row enrolled before
   * migration 0041. Returning them is what lets a browser with no local state
   * rebuild the keyring from the mailbox password alone.
   *
   * This is not the `wrapped_account_key` situation. That blob is an offline
   * cracking oracle against something a person typed, so it has its own
   * rate-limited one-at-a-time route; these are sealed under 256 random bits
   * and are useless without the Account Key that the wrap route hands over
   * separately, under that rate limit.
   */
  wrappedEcdhPrivate: string | null
  wrappedSignPrivate: string | null
  ecdhWrapIv: string | null
  signWrapIv: string | null
}

/** Metadata ONLY. There is deliberately no blob field on this shape. */
export interface WrapMetadataView {
  id: string
  type: string
  label: string | null
  createdAt: Date
  lastUsedAt: Date | null
}

export interface KeyringView {
  identityId: string
  keyId: number
  identities: IdentityView[]
  wraps: WrapMetadataView[]
}

/**
 * Check a keyring attestation: an Ed25519 signature over the canonical statement
 * of the identity list, by `signerSpki`. Fails closed: a malformed key or
 * signature is a refusal, never a pass.
 */
async function attestationHolds(input: {
  signerSpki: Uint8Array<ArrayBuffer>
  userId: string
  identities: readonly AttestedIdentity[]
  attestation: string
}): Promise<boolean> {
  try {
    return await verifyKeyringAttestation({
      signPublicKey: input.signerSpki,
      userId: input.userId,
      identities: input.identities,
      attestation: b64ToBytes(input.attestation),
    })
  } catch {
    return false
  }
}

function b64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, "base64"))
}

function bytesToB64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64")
}

function optionalB64ToBytes(value: string | null | undefined): Uint8Array | null {
  return value ? b64ToBytes(value) : null
}

function optionalBytesToB64(value: Uint8Array | null): string | null {
  return value ? bytesToB64(value) : null
}

/**
 * The wrapped private halves are all four or none. A row carrying three of them
 * is a keyring nobody can ever unwrap, and it would look enrolled: the client
 * would fetch it, skip it as partial, and be told its mailbox has no server
 * keyring for reasons no log line explains. Refusing at the door keeps that
 * state unreachable.
 */
function wrappedPrivateValues(input: KeyringInput) {
  const present = [
    input.wrappedEcdhPrivate,
    input.wrappedSignPrivate,
    input.ecdhWrapIv,
    input.signWrapIv,
  ].filter((v) => typeof v === "string" && v.length > 0).length
  if (present !== 0 && present !== 4) {
    throw new HTTPException(400, {
      message:
        "the wrapped identity private halves must be sent all four or not at all: a partial keyring can never be unwrapped",
    })
  }
  return {
    wrappedEcdhPrivate: optionalB64ToBytes(input.wrappedEcdhPrivate),
    wrappedSignPrivate: optionalB64ToBytes(input.wrappedSignPrivate),
    ecdhWrapIv: optionalB64ToBytes(input.ecdhWrapIv),
    signWrapIv: optionalB64ToBytes(input.signWrapIv),
  }
}

function toIdentityView(row: typeof userMailboxIdentities.$inferSelect): IdentityView {
  return {
    id: row.id,
    keyId: row.keyId,
    status: row.status,
    ecdhPublicKey: bytesToB64(row.ecdhPublicKey),
    signPublicKey: bytesToB64(row.signPublicKey),
    attestation: bytesToB64(row.keyringAttestation),
    createdAt: row.createdAt,
    retiredAt: row.retiredAt,
    wrappedEcdhPrivate: optionalBytesToB64(row.wrappedEcdhPrivate),
    wrappedSignPrivate: optionalBytesToB64(row.wrappedSignPrivate),
    ecdhWrapIv: optionalBytesToB64(row.ecdhWrapIv),
    signWrapIv: optionalBytesToB64(row.signWrapIv),
  }
}

async function listIdentities(
  tx: RlsClient,
  userId: string,
  orgId: string,
): Promise<IdentityView[]> {
  const rows = await tx
    .select()
    .from(userMailboxIdentities)
    .where(and(eq(userMailboxIdentities.userId, userId), eq(userMailboxIdentities.orgId, orgId)))
    .orderBy(asc(userMailboxIdentities.keyId))
  return rows.map(toIdentityView)
}

async function listWrapMetadata(
  tx: RlsClient,
  userId: string,
  orgId: string,
): Promise<WrapMetadataView[]> {
  // Explicit column list, not `select()`. A `select *` here would start
  // returning `wrapped_account_key` the moment someone widened the caller, and
  // this listing is exactly the surface that must never carry it.
  const rows = await tx
    .select({
      id: userKeyWraps.id,
      type: userKeyWraps.wrapType,
      label: userKeyWraps.label,
      createdAt: userKeyWraps.createdAt,
      lastUsedAt: userKeyWraps.lastUsedAt,
    })
    .from(userKeyWraps)
    .where(and(eq(userKeyWraps.userId, userId), eq(userKeyWraps.orgId, orgId)))
    .orderBy(asc(userKeyWraps.createdAt))
  return rows
}

export async function getKeyring(
  tx: RlsClient,
  userId: string,
  orgId: string,
): Promise<{ identities: IdentityView[]; wraps: WrapMetadataView[] }> {
  const [identities, wraps] = await Promise.all([
    listIdentities(tx, userId, orgId),
    listWrapMetadata(tx, userId, orgId),
  ])
  return { identities, wraps }
}

async function findActiveIdentity(
  tx: RlsClient,
  userId: string,
  orgId: string,
): Promise<{ id: string; keyId: number } | null> {
  const rows = await tx
    .select({ id: userMailboxIdentities.id, keyId: userMailboxIdentities.keyId })
    .from(userMailboxIdentities)
    .where(
      and(
        eq(userMailboxIdentities.userId, userId),
        eq(userMailboxIdentities.orgId, orgId),
        eq(userMailboxIdentities.status, "active"),
      ),
    )
  return (rows[0] as { id: string; keyId: number } | undefined) ?? null
}

function insertWrapValues(userId: string, orgId: string, wrap: WrapInput) {
  return {
    orgId,
    userId,
    wrapType: wrap.wrapType,
    label: wrap.label ?? null,
    credentialId: wrap.credentialId ? b64ToBytes(wrap.credentialId) : null,
    wrappedAccountKey: b64ToBytes(wrap.wrappedAccountKey),
    kdfParams: (wrap.kdfParams ?? null) as never,
    verifier: wrap.verifier ? b64ToBytes(wrap.verifier) : null,
  }
}

/**
 * Reject a public key the server cannot seal to, BEFORE it becomes the key
 * every future message depends on. See `assertIdentitySealable`: it validates,
 * it does not seal anything that is kept.
 */
async function assertSealable(ecdhPublicKey: string, userId: string, keyId: number): Promise<void> {
  try {
    await assertIdentitySealable({ ecdhPublicKey: b64ToBytes(ecdhPublicKey), userId, keyId })
  } catch (err) {
    if (err instanceof MailboxSealError) {
      throw new HTTPException(400, { message: err.message })
    }
    throw err
  }
}

/**
 * Lift the caller's own personal mailboxes out of suspension, and REFUSE the
 * whole enrollment if any of them cannot be lifted.
 *
 * Enrollment is all or nothing on purpose. The identity row arms the database
 * plaintext trigger, and `encryption_state` decides whether sync runs, so the
 * two must land together. They did not: the UPDATE runs inside the enrolling
 * user's own RLS transaction, and a caller holding `mail:accounts:read` but not
 * `mail:accounts:write` matched no row and got no error, so the identity was
 * created, the ledger written and 200 returned while the mailbox stayed at
 * `pending_enrollment` with its sync suspended forever. Throwing here rolls the
 * whole transaction back, which is the only honest outcome: either the mailbox
 * works, or nothing was enrolled.
 *
 * The residual limit, stated rather than hidden: this can only see accounts the
 * caller's own transaction can SELECT. A caller with no read grant at all sees
 * no rows and therefore nothing to refuse, which is indistinguishable in-tx
 * from owning no personal mailbox.
 */
async function armOwnerMailboxes(tx: RlsClient, userId: string): Promise<void> {
  const { refused } = await advanceOwnerEncryptionStateChecked(
    tx,
    schemaRef("app_mail"),
    userId,
    "enrolled",
  )
  if (refused.length > 0) {
    throw new HTTPException(403, {
      message:
        `enrollment was rolled back: ${refused.length} of your personal mail account(s) could not ` +
        "be taken out of enrollment-pending, so the mailbox would have been encrypted and left " +
        "permanently unable to fetch mail. This needs the mail account write permission.",
    })
  }
}

/**
 * Take every personal mailbox this user owns out of `pending_enrollment` or
 * `paused`, for an owner who ALREADY holds an active identity.
 *
 * This is the repair the enrollment wizard cannot offer: it shows "nothing new
 * to do here" to an owner with keys, and the enroll route needs a full keyring
 * payload the client no longer has in hand. A mailbox can still be suspended
 * for such an owner (its grace window elapsed, or it was connected before the
 * INSERT trigger existed), and without this route the only way out was to run
 * the whole OAuth connect again. Refused when there is no identity to arm to:
 * arming a mailbox nobody can seal to would suspend it a second time on the
 * first message.
 */
export async function armMailboxes(
  tx: RlsClient,
  userId: string,
  orgId: string,
): Promise<{ moved: string[] }> {
  const existing = await findActiveIdentity(tx, userId, orgId)
  if (!existing) {
    throw new HTTPException(409, {
      message: "no active mailbox identity: finish the encryption setup before arming a mailbox",
    })
  }
  const { moved, refused } = await advanceOwnerEncryptionStateChecked(
    tx,
    schemaRef("app_mail"),
    userId,
    "enrolled",
  )
  if (refused.length > 0) {
    throw new HTTPException(403, {
      message:
        `${refused.length} of your personal mail account(s) could not be taken out of ` +
        "enrollment-pending. This needs the mail account write permission.",
    })
  }
  return { moved }
}

/**
 * Enroll a user's first keyring. Idempotent per user: an existing `active`
 * identity short-circuits and the caller gets the keyring already on file.
 *
 * The whole insert is one transaction (the caller's), so abandoning the wizard
 * leaves nothing behind: no half keyring, no orphan wrap.
 */
export async function enrollKeyring(
  tx: RlsClient,
  userId: string,
  orgId: string,
  input: KeyringInput & { wraps: WrapInput[] },
): Promise<{ created: boolean; keyring: KeyringView }> {
  const existing = await findActiveIdentity(tx, userId, orgId)
  if (existing) {
    // Advance BEFORE the short-circuit returns. Re-enrolling is the obvious
    // repair for "my mail stopped arriving", and a mailbox connected after the
    // first enrolment, or one the first enrolment did not reach, sits at
    // `pending_enrollment` with its sync suspended. Returning the existing
    // keyring without this line made that repair a no-op, and there is no other
    // runtime caller that lifts the state. The helper skips any row with no
    // legal edge for `enrolled`, so a `ready` mailbox is untouched.
    await armOwnerMailboxes(tx, userId)
    const { identities, wraps } = await getKeyring(tx, userId, orgId)
    return {
      created: false,
      keyring: { identityId: existing.id, keyId: existing.keyId, identities, wraps },
    }
  }

  if (!input.wraps.some((w) => w.wrapType === "passphrase")) {
    throw new HTTPException(400, {
      message:
        "enrollment requires a mailbox password wrap: it is the unlock method that works on every machine",
    })
  }

  await assertSealable(input.ecdhPublicKey, userId, input.keyId)

  // The first identity attests itself: its own signing key signs the one-entry
  // list. This does not authenticate the user (the session did), it refuses a
  // payload that is not a well-formed keyring, and it is what a later rotation
  // chains from.
  const selfAttested = await attestationHolds({
    signerSpki: b64ToBytes(input.signPublicKey),
    userId,
    identities: [
      {
        keyId: input.keyId,
        status: "active",
        ecdhSpki: b64ToBytes(input.ecdhPublicKey),
        signSpki: b64ToBytes(input.signPublicKey),
      },
    ],
    attestation: input.attestation,
  })
  if (!selfAttested) {
    throw new HTTPException(400, {
      message: "the keyring attestation does not verify against the identity being enrolled",
    })
  }

  const [identity] = await tx
    .insert(userMailboxIdentities)
    .values({
      orgId,
      userId,
      keyId: input.keyId,
      ecdhPublicKey: b64ToBytes(input.ecdhPublicKey),
      signPublicKey: b64ToBytes(input.signPublicKey),
      keyringAttestation: b64ToBytes(input.attestation),
      status: "active",
      ...wrappedPrivateValues(input),
    })
    .returning({ id: userMailboxIdentities.id, keyId: userMailboxIdentities.keyId })
  if (!identity) throw new HTTPException(500, { message: "identity insert returned no row" })

  await tx
    .insert(userKeyWraps)
    .values(input.wraps.map((wrap) => insertWrapValues(userId, orgId, wrap)))

  await tx
    .insert(mailboxMigrationState)
    .values({ userId, orgId, enrolledAt: new Date() })
    .onConflictDoUpdate({
      target: mailboxMigrationState.userId,
      set: { enrolledAt: drizzleSql`coalesce(${mailboxMigrationState.enrolledAt}, now())` },
    })

  // The mailbox can fetch mail again. The deploy step suspended every personal
  // account at `pending_enrollment`, and the identity just inserted is what arms
  // the plaintext trigger, so without this line the mailbox is armed AND
  // permanently silent.
  await armOwnerMailboxes(tx, userId)

  const { identities, wraps } = await getKeyring(tx, userId, orgId)
  return {
    created: true,
    keyring: { identityId: identity.id, keyId: identity.keyId, identities, wraps },
  }
}

export async function addWrap(
  tx: RlsClient,
  userId: string,
  orgId: string,
  wrap: WrapInput,
): Promise<WrapMetadataView> {
  const [row] = await tx
    .insert(userKeyWraps)
    .values(insertWrapValues(userId, orgId, wrap))
    .returning({
      id: userKeyWraps.id,
      type: userKeyWraps.wrapType,
      label: userKeyWraps.label,
      createdAt: userKeyWraps.createdAt,
      lastUsedAt: userKeyWraps.lastUsedAt,
    })
  if (!row) throw new HTTPException(500, { message: "wrap insert returned no row" })
  return row
}

export async function deleteWrap(
  tx: RlsClient,
  userId: string,
  orgId: string,
  wrapId: string,
): Promise<void> {
  const rows = await tx
    .select({ id: userKeyWraps.id, wrapType: userKeyWraps.wrapType })
    .from(userKeyWraps)
    .where(and(eq(userKeyWraps.userId, userId), eq(userKeyWraps.orgId, orgId)))
  const target = rows.find((r) => r.id === wrapId)
  // RLS already hides another user's wrap, so "not in my own list" is a 404 and
  // never an existence oracle.
  if (!target) throw new HTTPException(404, { message: "wrap not found" })
  if (rows.length <= 1) {
    throw new HTTPException(409, {
      message: "cannot delete the only unlock method: the mailbox would become unreadable",
    })
  }
  if (
    target.wrapType === "passphrase" &&
    rows.filter((r) => r.wrapType === "passphrase").length <= 1
  ) {
    throw new HTTPException(409, {
      message:
        "cannot delete the last mailbox password: it is the only unlock method that works on every machine",
    })
  }
  await tx.delete(userKeyWraps).where(eq(userKeyWraps.id, wrapId))
}

/**
 * The one route that returns a wrapped Account Key, for one named wrap, to its
 * owner. Returns null rather than throwing so the route can answer 404 for both
 * "no such wrap" and "not yours".
 */
export async function getWrapBlob(
  tx: RlsClient,
  userId: string,
  orgId: string,
  wrapId: string,
): Promise<{ wrappedAccountKey: string; kdfParams: unknown } | null> {
  const rows = await tx
    .select({
      wrappedAccountKey: userKeyWraps.wrappedAccountKey,
      kdfParams: userKeyWraps.kdfParams,
    })
    .from(userKeyWraps)
    .where(
      and(
        eq(userKeyWraps.id, wrapId),
        eq(userKeyWraps.userId, userId),
        eq(userKeyWraps.orgId, orgId),
      ),
    )
  const row = rows[0]
  if (!row) return null
  await tx.update(userKeyWraps).set({ lastUsedAt: new Date() }).where(eq(userKeyWraps.id, wrapId))
  return {
    wrappedAccountKey: bytesToB64(row.wrappedAccountKey),
    kdfParams: row.kdfParams ?? null,
  }
}

/**
 * Append a new identity key and retire the previous active one.
 *
 * Rotation never rewrites the mailbox and is NOT remediation: mail sealed under
 * the retired key still opens, because the retired private key stays under the
 * same Account Key. A compromised Account Key is a different problem with a
 * different answer.
 */
export async function rotateIdentity(
  tx: RlsClient,
  userId: string,
  orgId: string,
  input: KeyringInput,
): Promise<IdentityView> {
  const existing = await listIdentities(tx, userId, orgId)
  if (existing.length === 0) {
    throw new HTTPException(409, { message: "no keyring to rotate: enroll first" })
  }
  if (existing.some((i) => i.keyId === input.keyId)) {
    throw new HTTPException(409, {
      message: `key id ${input.keyId} is already in use: a reused key id would make two blobs claim the same header`,
    })
  }

  await assertSealable(input.ecdhPublicKey, userId, input.keyId)

  // The rotation must be authorised by the key being replaced. The attestation
  // covers the identity list AS IT WILL STAND (every existing identity retired,
  // the new one active) and must verify under the CURRENT active identity's
  // signing key, which only the holder of the keyring has. Without this, anyone
  // holding a session could store a key of their own as the active one and have
  // every future message sealed to it.
  const current = existing.find((i) => i.status === "active")
  if (!current) {
    throw new HTTPException(409, { message: "no active identity to rotate from: enroll first" })
  }
  const after: AttestedIdentity[] = [
    ...existing.map((i) => ({
      keyId: i.keyId,
      status: "retired" as const,
      ecdhSpki: b64ToBytes(i.ecdhPublicKey),
      signSpki: b64ToBytes(i.signPublicKey),
    })),
    {
      keyId: input.keyId,
      status: "active" as const,
      ecdhSpki: b64ToBytes(input.ecdhPublicKey),
      signSpki: b64ToBytes(input.signPublicKey),
    },
  ]
  const authorised = await attestationHolds({
    signerSpki: b64ToBytes(current.signPublicKey),
    userId,
    identities: after,
    attestation: input.attestation,
  })
  if (!authorised) {
    throw new HTTPException(403, {
      message:
        "the rotation attestation does not verify under the current signing key: the new identity was not authorised by the keyring holder",
    })
  }

  await tx
    .update(userMailboxIdentities)
    .set({ status: "retired", retiredAt: new Date() })
    .where(
      and(
        eq(userMailboxIdentities.userId, userId),
        eq(userMailboxIdentities.orgId, orgId),
        eq(userMailboxIdentities.status, "active"),
      ),
    )

  const [row] = await tx
    .insert(userMailboxIdentities)
    .values({
      orgId,
      userId,
      keyId: input.keyId,
      ecdhPublicKey: b64ToBytes(input.ecdhPublicKey),
      signPublicKey: b64ToBytes(input.signPublicKey),
      keyringAttestation: b64ToBytes(input.attestation),
      status: "active",
      ...wrappedPrivateValues(input),
    })
    .returning()
  if (!row) throw new HTTPException(500, { message: "identity insert returned no row" })

  // A mailbox parked at `blocked` (a seal failed, or its key was unusable) is
  // usable again now that a fresh key exists. `ready` and the rest have no
  // `rotated` edge, so they are left where they are.
  await advanceOwnerEncryptionState(tx, schemaRef("app_mail"), userId, "rotated")

  return toIdentityView(row)
}

export async function getMigrationState(tx: RlsClient, userId: string, orgId: string) {
  const rows = await tx
    .select()
    .from(mailboxMigrationState)
    .where(and(eq(mailboxMigrationState.userId, userId), eq(mailboxMigrationState.orgId, orgId)))
  const row = rows[0]
  if (!row) return null
  // The ledger's byte columns are never returned: `verify_nonce`,
  // `client_ack_signature` and `client_ack_id_digest` are protocol state, not
  // something a client reads back.
  return {
    userId: row.userId,
    orgId: row.orgId,
    enrolledAt: row.enrolledAt,
    backfillStartedAt: row.backfillStartedAt,
    backfillCompletedAt: row.backfillCompletedAt,
    messagesTotal: row.messagesTotal,
    messagesSealed: row.messagesSealed,
    clientVerifiedAt: row.clientVerifiedAt,
    clientAckCount: row.clientAckCount,
    clientAckKeyId: row.clientAckKeyId,
    plaintextPurgedAt: row.plaintextPurgedAt,
    derivativesPurgedAt: row.derivativesPurgedAt,
    meiliPurgedAt: row.meiliPurgedAt,
    backupsClearAfter: row.backupsClearAfter,
  }
}
