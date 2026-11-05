// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Resolve the identity a plaintext is sealed TO.
//
// The recipient is never a caller argument. It is resolved here, from persisted
// state, under the privileged pool, because a sealing caller that could name the
// recipient could seal a user's mail to a key someone else holds.
//
// The refusal that matters: MORE THAN ONE row with `status = 'active'` is a
// hard error, not a "pick the newest". Two active rows is the exact shape an
// operator key-injection attack takes (plant a second identity, seal to it, the
// user notices nothing because their own key still opens their older mail), and
// the org-read RLS policy on `user_mailbox_identities` means any org member can
// attempt it. Detection is the defence, so this must fail loudly rather than
// choose.

import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { userMailboxIdentities } from "~/db/schema/kernel"

export type MailboxSealErrorCode =
  | "NO_ACTIVE_IDENTITY_KEY"
  | "MULTIPLE_ACTIVE_IDENTITY_KEYS"
  | "USER_NOT_ENROLLED"
  | "RECIPIENT_MISMATCH"
  | "PLAINTEXT_TOO_LARGE"

/** Every failure a sealing caller may see. The enum is shared with the sandbox
 *  bridge so the wire contract and the server agree on one vocabulary. */
export class MailboxSealError extends Error {
  readonly code: MailboxSealErrorCode
  constructor(code: MailboxSealErrorCode, message: string) {
    super(message)
    this.name = "MailboxSealError"
    this.code = code
  }
}

export interface ActiveIdentity {
  id: string
  userId: string
  orgId: string
  /** One byte, 0..255, carried in the ciphertext blob header. */
  keyId: number
  /** P-256 SPKI. Imported through `crypto.subtle.importKey("spki", ...)` at the
   *  seal site, which is what validates the point. */
  ecdhPublicKey: Uint8Array
}

/**
 * The user's single active identity, or a refusal. Never returns a row when
 * more than one is active.
 */
export async function resolveActiveIdentity(
  userId: string,
  orgId: string,
): Promise<ActiveIdentity> {
  const rows = await withPrivilegedDb(orgId, "mailbox-resolve-identity", (tx) =>
    tx
      .select({
        id: userMailboxIdentities.id,
        userId: userMailboxIdentities.userId,
        orgId: userMailboxIdentities.orgId,
        keyId: userMailboxIdentities.keyId,
        ecdhPublicKey: userMailboxIdentities.ecdhPublicKey,
      })
      .from(userMailboxIdentities)
      .where(
        and(
          eq(userMailboxIdentities.userId, userId),
          eq(userMailboxIdentities.orgId, orgId),
          eq(userMailboxIdentities.status, "active"),
        ),
      ),
  )

  if (rows.length === 0) {
    throw new MailboxSealError(
      "NO_ACTIVE_IDENTITY_KEY",
      "the user has no active mailbox identity key",
    )
  }
  if (rows.length > 1) {
    throw new MailboxSealError(
      "MULTIPLE_ACTIVE_IDENTITY_KEYS",
      `the user has ${rows.length} active mailbox identity keys, refusing to choose`,
    )
  }
  const row = rows[0] as ActiveIdentity
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    keyId: row.keyId,
    ecdhPublicKey: new Uint8Array(row.ecdhPublicKey),
  }
}
