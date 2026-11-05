// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 12.3: the server checks the client's proof that it read the whole
// mailbox, without ever seeing plaintext.
//
// THE SERVER CANNOT CHECK ITS OWN WORK HERE, BY CONSTRUCTION. There is no
// server-computed HMAC of plaintext anywhere in this file, and there must never
// be one: a keyed hash of plaintext under a server-held key is a
// plaintext-confirmation oracle for exactly the low-entropy fields this design
// protects (a subject line, a short body), and it reintroduces the
// server-held-key construction spec section 2.3 rejects (amendment A6).
//
// What the server CAN do, and what this file does:
//   * issue a fresh single-use nonce with an expiry,
//   * independently recompute the id-set digest over the exact row set it holds,
//   * verify an Ed25519 signature under the `sign_public_key` it stores for the
//     claimed `key_id`.
//
// The client is what walks every message, decrypts the ciphertext, compares it
// byte for byte against the still-present plaintext columns, and signs. The
// payload carries a DIGEST rather than an id list because `messageIdsCovered`
// for a 100k mailbox is a multi-megabyte body.

import { computeIdSetDigest, verifyAck } from "@liaison/mailbox-crypto/src/ack"
import { bytesEqual } from "@liaison/mailbox-crypto/src/bytes"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"

const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)
const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

/** Anything that can run raw SQL: an RLS request tx or a privileged handle. */
export interface AckSqlExecutor {
  execute(query: unknown): Promise<unknown>
}

/** How long an issued verify nonce stays usable. */
export const VERIFY_NONCE_TTL_MS = 15 * 60 * 1000

export type AckRefusalCode =
  | "NO_LEDGER_ROW"
  | "NO_NONCE_ISSUED"
  | "NONCE_MISMATCH"
  | "NONCE_EXPIRED"
  | "UNKNOWN_KEY_ID"
  | "CURSOR_MISMATCH"
  | "COUNT_MISMATCH"
  | "DIGEST_MISMATCH"
  | "BAD_SIGNATURE"
  | "NO_MESSAGES"

/**
 * A refusal to accept an acknowledgement, and therefore a refusal to let the
 * purge proceed. Never swallowed and never downgraded to a warning: the only
 * thing standing between a user and irreversible data loss is that this throws.
 */
export class MailboxAckError extends Error {
  readonly code: AckRefusalCode
  constructor(code: AckRefusalCode, message: string) {
    super(`${code}: ${message}`)
    this.name = "MailboxAckError"
    this.code = code
  }
}

export interface MailboxAckSubmission {
  keyId: number
  nonce: string
  count: number
  /** base64 of the 32 raw digest bytes. */
  idSetDigest: string
  /** base64 Ed25519 signature over the Task 2.8 statement. */
  signature: string
  /** Echoed back from `issueVerifyNonce`, and checked against the live value. */
  backfillCursor: string
}

/**
 * Every message id in every PERSONAL mailbox of this user, ASCII sorted.
 *
 * The union across accounts rather than the single account named in the
 * statement, deliberately. The ledger row is keyed by `user_id` and the purge
 * is per user, so covering only one account would let an acknowledgement for a
 * verified mailbox authorise the destruction of a second, unverified one. For
 * the single personal mailbox this design assumes, the two readings coincide.
 */
export async function collectPersonalMessageIds(
  tx: AckSqlExecutor,
  userId: string,
  orgId: string,
): Promise<string[]> {
  const rows = extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      SELECT m.id::text AS id
        FROM ${MAIL}.messages m
        JOIN ${MAIL}.accounts a ON a.id = m.account_id
       WHERE a.org_id = ${orgId}::uuid AND a.owner_type = 'user'
         AND a.owner_id = ${userId}::uuid`),
  )
  return rows.map((r) => r.id).sort()
}

export interface LedgerRow {
  verify_nonce: Buffer | Uint8Array | null
  verify_nonce_issued_at: Date | string | null
  backfill_cursor: unknown
  client_verified_at: Date | string | null
  client_ack_signature: Buffer | Uint8Array | null
  client_ack_id_digest: Buffer | Uint8Array | null
  client_ack_count: string | number | null
  client_ack_key_id: number | null
  client_ack_account_id: string | null
  client_ack_nonce: Buffer | Uint8Array | null
  client_ack_cursor: string | null
  plaintext_purged_at: Date | string | null
}

export async function readLedger(
  tx: AckSqlExecutor,
  userId: string,
): Promise<LedgerRow | undefined> {
  return extractRows<LedgerRow>(
    await tx.execute(drizzleSql`
      SELECT verify_nonce, verify_nonce_issued_at, backfill_cursor, client_verified_at,
             client_ack_signature, client_ack_id_digest, client_ack_count, client_ack_key_id,
             client_ack_account_id::text AS client_ack_account_id, client_ack_nonce,
             client_ack_cursor, plaintext_purged_at
        FROM ${K}.mailbox_migration_state WHERE user_id = ${userId}::uuid`),
  )[0]
}

/**
 * A deterministic string for the backfill cursor, signed by the client and
 * re-checked here.
 *
 * The server hands this token to the client with the nonce and demands it back
 * verbatim, rather than both sides trying to canonicalise a jsonb document the
 * same way. Drift between two canonicalisers would make every acknowledgement
 * fail, and the failure would look like a signature problem.
 *
 * It also gives a genuinely useful property for free: if the backfill advanced
 * between the nonce and the acknowledgement, new unsealed rows may exist, the
 * token changed, and the acknowledgement is refused rather than covering a set
 * the client never walked.
 */
export function backfillCursorToken(cursor: unknown): string {
  if (cursor === null || cursor === undefined) return ""
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = stable((value as Record<string, unknown>)[key])
      }
      return out
    }
    return value
  }
  return JSON.stringify(stable(cursor))
}

export interface IssuedNonce {
  nonce: string
  expiresAt: Date
  backfillCursor: string
  /** How many messages the client is expected to cover. */
  messageCount: number
}

export async function issueVerifyNonce(
  tx: AckSqlExecutor,
  userId: string,
  orgId: string,
): Promise<IssuedNonce> {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
  const issuedAt = new Date()
  await tx.execute(drizzleSql`
    INSERT INTO ${K}.mailbox_migration_state (user_id, org_id, verify_nonce, verify_nonce_issued_at)
    VALUES (${userId}::uuid, ${orgId}::uuid, ${Buffer.from(nonce, "utf8")}, ${issuedAt.toISOString()}::timestamptz)
    ON CONFLICT (user_id) DO UPDATE
      SET verify_nonce = EXCLUDED.verify_nonce,
          verify_nonce_issued_at = EXCLUDED.verify_nonce_issued_at`)
  const ledger = await readLedger(tx, userId)
  const ids = await collectPersonalMessageIds(tx, userId, orgId)
  return {
    nonce,
    expiresAt: new Date(issuedAt.getTime() + VERIFY_NONCE_TTL_MS),
    backfillCursor: backfillCursorToken(ledger?.backfill_cursor ?? null),
    messageCount: ids.length,
  }
}

async function signPublicKeyFor(
  tx: AckSqlExecutor,
  userId: string,
  orgId: string,
  keyId: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const rows = extractRows<{ sign_public_key: Buffer }>(
    await tx.execute(drizzleSql`
      SELECT sign_public_key FROM ${K}.user_mailbox_identities
       WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid AND key_id = ${keyId}`),
  )
  const row = rows[0]
  if (!row) {
    throw new MailboxAckError(
      "UNKNOWN_KEY_ID",
      `no identity with key id ${keyId} for this user: the acknowledgement claims a key the server never saw`,
    )
  }
  // Copy into a plain ArrayBuffer-backed view: `verifyAck` imports it as SPKI
  // and the WebCrypto typings refuse a possibly-shared buffer.
  const bytes = new Uint8Array(row.sign_public_key.byteLength) as Uint8Array<ArrayBuffer>
  bytes.set(row.sign_public_key)
  return bytes
}

/**
 * Verify a submitted acknowledgement. Throws `MailboxAckError` on ANY failure,
 * and returns the covered id set on success.
 *
 * `accountId` is CLIENT CHOSEN and is not checked against the user's accounts.
 * It is load bearing only as part of the signed statement: whatever the client
 * names, it must have signed that same value, and the stored ack records it.
 * It authorises nothing on its own, because the digest and the count are
 * computed over the union of the user's own personal accounts and re-derived
 * from that same union at purge time, never from this field.
 */
export async function verifyMailboxAck(
  tx: AckSqlExecutor,
  userId: string,
  orgId: string,
  accountId: string,
  submission: MailboxAckSubmission,
): Promise<{ messageIds: string[]; digest: Uint8Array }> {
  const ledger = await readLedger(tx, userId)
  if (!ledger) {
    throw new MailboxAckError("NO_LEDGER_ROW", "this user has no migration ledger row")
  }
  if (!ledger.verify_nonce) {
    throw new MailboxAckError(
      "NO_NONCE_ISSUED",
      "no verify nonce is outstanding: a nonce is single use and is cleared once spent",
    )
  }
  const storedNonce = Buffer.from(ledger.verify_nonce).toString("utf8")
  if (storedNonce !== submission.nonce) {
    throw new MailboxAckError("NONCE_MISMATCH", "the nonce is not the one this server issued")
  }
  const issuedAt = ledger.verify_nonce_issued_at ? new Date(ledger.verify_nonce_issued_at) : null
  if (!issuedAt) {
    // The nonce VALUE is kept after a successful verify so the purge can
    // re-verify the stored signature later; `verify_nonce_issued_at` is what is
    // cleared, and clearing it is what makes the nonce single use.
    throw new MailboxAckError("NONCE_EXPIRED", "this verify nonce has already been spent")
  }
  if (Date.now() - issuedAt.getTime() > VERIFY_NONCE_TTL_MS) {
    throw new MailboxAckError("NONCE_EXPIRED", "the verify nonce has expired")
  }
  const cursorToken = backfillCursorToken(ledger.backfill_cursor ?? null)
  if (cursorToken !== submission.backfillCursor) {
    throw new MailboxAckError(
      "CURSOR_MISMATCH",
      "the backfill cursor moved since the nonce was issued: the acknowledged set is no longer the set on file",
    )
  }

  const messageIds = await collectPersonalMessageIds(tx, userId, orgId)
  if (messageIds.length === 0) {
    throw new MailboxAckError(
      "NO_MESSAGES",
      "the server holds no messages for this mailbox: an acknowledgement over nothing proves nothing",
    )
  }
  if (messageIds.length !== submission.count) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      `the acknowledgement covers ${submission.count} messages, the server holds ${messageIds.length}`,
    )
  }
  // Recomputed INDEPENDENTLY over the exact row set the server holds. Sampling
  // would be worthless here: the whole claim is full coverage.
  const digest = await computeIdSetDigest(messageIds)
  const claimed = new Uint8Array(Buffer.from(submission.idSetDigest, "base64"))
  if (!bytesEqual(digest, claimed)) {
    throw new MailboxAckError(
      "DIGEST_MISMATCH",
      "the acknowledged id set is not the set the server holds",
    )
  }

  const signPublicKey = await signPublicKeyFor(tx, userId, orgId, submission.keyId)
  const signature = new Uint8Array(Buffer.from(submission.signature, "base64"))
  let ok = false
  try {
    ok = await verifyAck(
      signPublicKey,
      {
        userId,
        accountId,
        keyId: submission.keyId,
        nonce: submission.nonce,
        count: submission.count,
        idSetDigest: digest,
        backfillCursor: submission.backfillCursor,
      },
      signature,
    )
  } catch {
    ok = false
  }
  if (!ok) {
    throw new MailboxAckError(
      "BAD_SIGNATURE",
      "the acknowledgement signature does not verify under the stored signing key",
    )
  }
  return { messageIds, digest }
}

/** Record an accepted acknowledgement and BURN the nonce, so it is single use. */
export async function recordVerifiedAck(
  tx: AckSqlExecutor,
  userId: string,
  accountId: string,
  submission: MailboxAckSubmission,
  digest: Uint8Array,
): Promise<Date> {
  const verifiedAt = new Date()
  // Every value the signed statement binds is persisted, so the purge can
  // re-verify the signature later instead of trusting `client_verified_at`.
  // `verify_nonce_issued_at = NULL` is what burns the nonce: the VALUE stays,
  // as part of the replayable statement.
  await tx.execute(drizzleSql`
    UPDATE ${K}.mailbox_migration_state
       SET client_verified_at = ${verifiedAt.toISOString()}::timestamptz,
           client_ack_signature = ${Buffer.from(submission.signature, "base64")},
           client_ack_id_digest = ${Buffer.from(digest)},
           client_ack_count = ${submission.count},
           client_ack_key_id = ${submission.keyId},
           client_ack_account_id = ${accountId}::uuid,
           client_ack_nonce = ${Buffer.from(submission.nonce, "utf8")},
           client_ack_cursor = ${submission.backfillCursor},
           verify_nonce_issued_at = NULL
     WHERE user_id = ${userId}::uuid`)
  return verifiedAt
}

/**
 * Re-verify the STORED acknowledgement against the CURRENT row set, for the
 * purge.
 *
 * Not a repeat of the route's check for its own sake: the purge is destructive
 * and may run long after the acknowledgement, so it re-derives the digest over
 * the rows it is about to destroy. A mailbox that received new mail since the
 * acknowledgement fails here and must be re-verified, which is the safe
 * direction: new mail is sealed at ingest and loses nothing by waiting.
 */
export async function assertStoredAckCoversCurrentRows(
  tx: AckSqlExecutor,
  userId: string,
  orgId: string,
): Promise<{ messageIds: string[] }> {
  const ledger = await readLedger(tx, userId)
  if (!ledger) {
    throw new MailboxAckError("NO_LEDGER_ROW", "this user has no migration ledger row")
  }
  if (!ledger.client_verified_at || !ledger.client_ack_id_digest) {
    throw new MailboxAckError(
      "NO_NONCE_ISSUED",
      "no client acknowledgement is on file: the purge refuses to be destructive without proof",
    )
  }
  const messageIds = await collectPersonalMessageIds(tx, userId, orgId)
  if (messageIds.length === 0) {
    throw new MailboxAckError("NO_MESSAGES", "the server holds no messages for this mailbox")
  }
  if (Number(ledger.client_ack_count ?? -1) !== messageIds.length) {
    throw new MailboxAckError(
      "COUNT_MISMATCH",
      `the stored acknowledgement covers ${ledger.client_ack_count} messages, the mailbox now holds ${messageIds.length}`,
    )
  }
  const digest = await computeIdSetDigest(messageIds)
  if (!bytesEqual(digest, new Uint8Array(ledger.client_ack_id_digest))) {
    throw new MailboxAckError(
      "DIGEST_MISMATCH",
      "the stored acknowledgement does not cover the rows the purge is about to destroy",
    )
  }
  if (
    ledger.client_ack_key_id === null ||
    !ledger.client_ack_signature ||
    !ledger.client_ack_nonce ||
    !ledger.client_ack_account_id ||
    ledger.client_ack_cursor === null
  ) {
    throw new MailboxAckError(
      "BAD_SIGNATURE",
      "the stored acknowledgement is incomplete: it cannot be re-verified, so it does not authorise anything",
    )
  }

  // The signature is verified AGAIN here, not merely assumed from
  // `client_verified_at`. A row update that set `client_verified_at` by hand,
  // or a restored ledger row, must not be enough to authorise a destruction.
  // Every value the statement binds comes from the ledger (migration 0040)
  // except the digest, which is re-derived above over the CURRENT rows.
  const signPublicKey = await signPublicKeyFor(tx, userId, orgId, ledger.client_ack_key_id)
  const signature = new Uint8Array(ledger.client_ack_signature)
  let ok = false
  try {
    ok = await verifyAck(
      signPublicKey,
      {
        userId,
        accountId: ledger.client_ack_account_id,
        keyId: ledger.client_ack_key_id,
        nonce: Buffer.from(ledger.client_ack_nonce).toString("utf8"),
        count: messageIds.length,
        idSetDigest: digest,
        backfillCursor: ledger.client_ack_cursor,
      },
      signature,
    )
  } catch {
    ok = false
  }
  if (!ok) {
    throw new MailboxAckError(
      "BAD_SIGNATURE",
      "the stored acknowledgement does not verify under the stored signing key",
    )
  }
  return { messageIds }
}
