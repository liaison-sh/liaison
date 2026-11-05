// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SEAL ONLY. This module is the server's entire relationship with mail
// ciphertext: it can create it, and it has no way to read it back.
//
// It imports the NAMED seal modules of `@liaison/mailbox-crypto`, never the
// package root. A root export surface can drift, and a future re-export there
// would silently pull the open primitives into the `apps/api` import graph
// without a line of this file changing. T-SEC-1 bans the root import for that
// reason and walks the graph to prove the ban held.
//
// Nothing here accepts a private key, and nothing here returns one. The public
// entry is `sealForUser`.

import { type MailboxAadContext, mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { sealField } from "@liaison/mailbox-crypto/src/field-seal"
import { generateContentKey, sealContentKey } from "@liaison/mailbox-crypto/src/seal"
import { MailboxSealError, resolveActiveIdentity } from "~/modules/mailbox-crypto/identity-resolver"

export { MailboxSealError, resolveActiveIdentity }

/** The ciphertext blob version this server writes. */
export const MAILBOX_ENC_VERSION = 1

/**
 * Per-item plaintext cap, on the DECODED bytes. One megabyte is well past any
 * real mail field and short of anything that would make a seal call a memory
 * event.
 */
export const MAX_PLAINTEXT_BYTES = 1024 * 1024

/** The section 3.4 binding contexts, named rather than spelled. A caller never
 *  writes a context string, so a typo cannot produce a blob that opens under
 *  the wrong binding. */
export type SealContextKind = keyof typeof mailboxAad

export interface SealContextRef {
  kind: SealContextKind
  /** The entity the plaintext belongs to: a message id, conversation id, draft
   *  id or file id. It goes into both the AAD and the D5 subkey derivation. */
  entityId: string
  /** `index` alone is two-part: the shard id joins the user id. */
  shardId?: string
}

export interface SealItem {
  context: SealContextRef
  plaintext: string | Uint8Array
}

export interface SealedItem {
  context: SealContextRef
  ciphertext: Uint8Array
}

export interface SealedBatch {
  /** The identity key id the content key was sealed to. */
  keyId: number
  encVersion: number
  /** The AES-KW wrapped per-batch content key. */
  contentKeyWrapped: Uint8Array
  /** The ephemeral public key the wrap was derived against, SPKI. */
  contentKeyEpk: Uint8Array
  items: SealedItem[]
}

function buildContext(ref: SealContextRef, userId: string): MailboxAadContext {
  if (ref.kind === "index") {
    if (!ref.shardId) {
      throw new MailboxSealError("RECIPIENT_MISMATCH", "the index context requires a shardId")
    }
    return mailboxAad.index(userId, ref.shardId)
  }
  const builder = mailboxAad[ref.kind] as (entityId: string) => MailboxAadContext
  return builder(ref.entityId)
}

function toBytes(plaintext: string | Uint8Array): Uint8Array {
  const bytes = typeof plaintext === "string" ? new TextEncoder().encode(plaintext) : plaintext
  if (bytes.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new MailboxSealError(
      "PLAINTEXT_TOO_LARGE",
      `plaintext is ${bytes.byteLength} bytes, the cap is ${MAX_PLAINTEXT_BYTES}`,
    )
  }
  return bytes
}

/**
 * Prove a submitted identity public key is one this server can actually seal
 * to, and throw a `MailboxSealError` if it is not.
 *
 * This is validation, not a sealing path: it takes a caller-supplied recipient
 * (which `sealForUser` deliberately refuses to do), performs one throwaway seal
 * and returns NOTHING, so it cannot be used to seal a user's mail to a key
 * someone else chose. The check itself is `crypto.subtle.importKey("spki", ...)`
 * inside `sealContentKey`, which performs the on-curve and range validation.
 *
 * Running it at enrollment turns "every message this user ever receives fails
 * to seal" into "this enrollment request is rejected".
 */
export async function assertIdentitySealable(input: {
  ecdhPublicKey: Uint8Array
  userId: string
  keyId: number
}): Promise<void> {
  const contentKey = generateContentKey()
  try {
    await sealContentKey({
      recipientEcdhSpki: input.ecdhPublicKey as Uint8Array<ArrayBuffer>,
      userId: input.userId,
      keyId: input.keyId,
      contentKey,
    })
    await sealField({
      contentKey,
      context: mailboxAad.messageSubject("mailbox-key-self-test"),
      keyId: input.keyId,
      plaintext: new TextEncoder().encode("self test") as Uint8Array<ArrayBuffer>,
    })
  } catch (err) {
    throw new MailboxSealError(
      "RECIPIENT_MISMATCH",
      `the submitted identity public key cannot be sealed to: ${(err as Error).message}`,
    )
  } finally {
    contentKey.fill(0)
  }
}

/**
 * Seal a batch of plaintexts to `userId`'s active identity key.
 *
 * ONE content key per batch, sealed once with ECDH-ES, with every field getting
 * its own D5 subkey and its own fresh IV underneath it. That is what makes a
 * message a single unwrap for the client and still leaves no key encrypting two
 * plaintexts.
 *
 * `orgId` is the RLS anchor for the resolve, not a second recipient: the
 * identity row must belong to `userId` AND `orgId` or nothing is sealed.
 */
export async function sealForUser(
  userId: string,
  orgId: string,
  items: SealItem[],
): Promise<SealedBatch> {
  const identity = await resolveActiveIdentity(userId, orgId)
  // Cap every item BEFORE minting a key, so an oversize item cannot leave a
  // half-sealed batch behind.
  const plaintexts = items.map((item) => toBytes(item.plaintext))

  const contentKey = generateContentKey()
  try {
    const { wrapped, epkSpki } = await sealContentKey({
      recipientEcdhSpki: identity.ecdhPublicKey as Uint8Array<ArrayBuffer>,
      userId,
      keyId: identity.keyId,
      contentKey,
    })

    const sealed: SealedItem[] = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as SealItem
      sealed.push({
        context: item.context,
        ciphertext: await sealField({
          contentKey,
          context: buildContext(item.context, userId),
          keyId: identity.keyId,
          plaintext: plaintexts[i] as Uint8Array<ArrayBuffer>,
        }),
      })
    }

    return {
      keyId: identity.keyId,
      encVersion: MAILBOX_ENC_VERSION,
      contentKeyWrapped: wrapped,
      contentKeyEpk: epkSpki,
      items: sealed,
    }
  } finally {
    // The server holds the content key for the length of one call and no
    // longer. It cannot open what it sealed once this returns.
    contentKey.fill(0)
  }
}
