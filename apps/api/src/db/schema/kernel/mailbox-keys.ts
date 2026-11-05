// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Zero-access mailbox encryption: the control-plane key tables.
//
// These four tables hold the PUBLIC keyring, the wrapped Account Keys, the
// per-user cutover ledger and the headless client job queue. They live in
// `kernel` and not in `app_mail` deliberately: they must not inherit the mail
// app's entity machinery (tool projection, event emission, timeline), which is
// exactly the machinery Invariant K forbids for mail data.
//
// The sharpest edge in this file is `user_key_wraps.wrapped_account_key`. It is
// opaque, but it is also an OFFLINE CRACKING ORACLE at passphrase KDF speed: whoever
// holds it can grind a passphrase forever, off the record, with no rate limit
// this system can apply. It must never be readable by an admin tool, an export,
// a database connector, a log line or the `liaison_readonly` role. T-SEC-2
// pins the grant half of that.

import { sql } from "drizzle-orm"
import {
  bigint,
  check,
  customType,
  index,
  jsonb,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { kernel, organizations } from "./organizations"
import { users } from "./users"

/**
 * Postgres `bytea`. Drizzle has no built-in, and the repo had no prior use, so
 * this is the one definition every kernel table shares.
 *
 * Base64-in-TEXT is not an acceptable substitute: it is a third larger, it
 * invites a handler to concatenate ciphertext into a log line as if it were a
 * string, and it defeats the STORAGE EXTERNAL tuning these columns need.
 */
export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType() {
    return "bytea"
  },
  toDriver(value: Uint8Array): Buffer {
    return Buffer.from(value)
  },
  fromDriver(value: Buffer): Uint8Array {
    return new Uint8Array(value)
  },
})

/**
 * The public keyring. One `active` row per user, plus any number of `retired`
 * rows: mail sealed under a retired key still opens, so retirement is not
 * remediation and never rewrites the mailbox.
 *
 * `key_id` is a smallint with a 0..255 CHECK because the value is a single byte
 * in the ciphertext blob header. A value above 255 is a schema error, not
 * something to truncate silently at seal time.
 */
export const userMailboxIdentities = kernel.table(
  "user_mailbox_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    keyId: smallint("key_id").notNull(),
    /** P-256 SPKI. Public by definition: any org member may read it, because
     *  sealing mail for this user requires exactly this. */
    ecdhPublicKey: bytea("ecdh_public_key").notNull(),
    /** Ed25519 SPKI, for verifying the keyring attestation. */
    signPublicKey: bytea("sign_public_key").notNull(),
    /** Ed25519 signature over the canonical keyring statement. The downgrade
     *  detector is its only consumer. */
    keyringAttestation: bytea("keyring_attestation").notNull(),
    /**
     * The identity's PRIVATE halves, AES-GCM wrapped under the owner's Account
     * Key with an AAD bound to the blob header, the user id, the key id and
     * which half it is. The Account Key exists only in the owner's browser, so
     * the server holds bytes it has no key for.
     *
     * They live here because a keyring that exists only in one browser dies
     * with a cleared profile, and no unlock secret can bring it back: the
     * password recovers the Account Key, and the Account Key opens nothing on its
     * own. This is what makes a fresh profile able to unlock (spec SC10).
     *
     * NULLABLE: rows enrolled before migration 0041 carry none, and the read
     * path skips a partial row rather than building an entry that could never
     * be unwrapped.
     *
     * Not an offline oracle the way `user_key_wraps.wrapped_account_key` is,
     * because the key above them is 256 random bits rather than something a
     * person types. They are still withheld from `liaison_readonly` and from
     * `export-full` for the same reason that table is.
     */
    wrappedEcdhPrivate: bytea("wrapped_ecdh_private"),
    wrappedSignPrivate: bytea("wrapped_sign_private"),
    ecdhWrapIv: bytea("ecdh_wrap_iv"),
    signWrapIv: bytea("sign_wrap_iv"),
    /** `active` | `retired`. */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_user_mailbox_identities_user_key").on(table.userId, table.keyId),
    index("idx_user_mailbox_identities_user_status").on(table.userId, table.status),
    check("user_mailbox_identities_key_id_byte", sql`${table.keyId} BETWEEN 0 AND 255`),
    check("user_mailbox_identities_status", sql`${table.status} IN ('active', 'retired')`),
  ],
)

/**
 * The wrapped Account Key, N rows per user, one per unlock method.
 *
 * NEVER expose `wrappedAccountKey` outside the owner's own unlock fetch. See
 * the file header: it is an offline oracle, not merely an opaque blob.
 */
export const userKeyWraps = kernel.table(
  "user_key_wraps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `passkey_prf` | `recovery_phrase` | `passphrase`. */
    wrapType: text("wrap_type").notNull(),
    /** WebAuthn credential id, `passkey_prf` only. */
    credentialId: bytea("credential_id"),
    /** User-facing, e.g. "MacBook Touch ID". */
    label: text("label"),
    /**
     * OFFLINE CRACKING ORACLE. Owner only, never in a tool result, never in an
     * export, never in a log line, never granted to `liaison_readonly`.
     */
    wrappedAccountKey: bytea("wrapped_account_key").notNull(),
    /**
     * The salt, plus for a passphrase wrap its KDF (`kdf: "pbkdf2-sha256"`,
     * `iterations`; neither on a legacy Argon2id row), or the PRF salt and
     * credential id. Never key material.
     */
    kdfParams: jsonb("kdf_params"),
    /** Legacy recovery phrase rows only: HMAC verifier, so a wrong phrase is rejected
     *  before an unwrap is attempted. Derived under a key independent of the
     *  wrap KEK. */
    verifier: bytea("verifier"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_user_key_wraps_user").on(table.userId, table.createdAt),
    check(
      "user_key_wraps_type",
      sql`${table.wrapType} IN ('passkey_prf', 'recovery_phrase', 'passphrase')`,
    ),
  ],
)

/**
 * Per-user cutover ledger. Every column a later phase needs is declared here
 * the first time: a numbered migration's hash is in the drizzle ledger of every
 * database the moment it runs, so a later edit to add a column would never
 * execute while the file claimed otherwise.
 */
export const mailboxMigrationState = kernel.table("mailbox_migration_state", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  orgId: uuid("org_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
  backfillStartedAt: timestamp("backfill_started_at", { withTimezone: true }),
  backfillCompletedAt: timestamp("backfill_completed_at", { withTimezone: true }),
  /** Keyset cursor over a nullable ordering key, so the backfill can resume
   *  without re-reading what it already sealed. */
  backfillCursor: jsonb("backfill_cursor"),
  messagesTotal: bigint("messages_total", { mode: "number" }),
  messagesSealed: bigint("messages_sealed", { mode: "number" }),
  verifyNonce: bytea("verify_nonce"),
  verifyNonceIssuedAt: timestamp("verify_nonce_issued_at", { withTimezone: true }),
  clientVerifiedAt: timestamp("client_verified_at", { withTimezone: true }),
  clientAckSignature: bytea("client_ack_signature"),
  clientAckIdDigest: bytea("client_ack_id_digest"),
  clientAckCount: bigint("client_ack_count", { mode: "number" }),
  clientAckKeyId: smallint("client_ack_key_id"),
  /** The remaining three values the Ed25519 statement binds, so the purge can
   *  RE-verify the stored signature rather than trusting `clientVerifiedAt`
   *  (migration 0040). */
  clientAckAccountId: uuid("client_ack_account_id"),
  clientAckNonce: bytea("client_ack_nonce"),
  clientAckCursor: text("client_ack_cursor"),
  /**
   * The cutover is COMPLETE. Stamped only when nothing readable is left,
   * attachment bytes included. It is not a record that the purge ran: on a
   * mailbox with historical unsealed attachments this stays NULL after a purge
   * that destroyed every body. Read `plaintextPurgeRanAt` for that.
   */
  plaintextPurgedAt: timestamp("plaintext_purged_at", { withTimezone: true }),
  /**
   * The destructive purge RAN, unconditionally (migration 0042). The one
   * question an operator must never get a false answer to is "did anything get
   * destroyed here", and `plaintextPurgedAt` answers a different question.
   */
  plaintextPurgeRanAt: timestamp("plaintext_purge_ran_at", { withTimezone: true }),
  derivativesPurgedAt: timestamp("derivatives_purged_at", { withTimezone: true }),
  meiliPurgedAt: timestamp("meili_purged_at", { withTimezone: true }),
  /** Until this instant the backups still hold plaintext. It is the one cost
   *  this feature cannot undo, so it is recorded rather than assumed. */
  backupsClearAfter: timestamp("backups_clear_after", { withTimezone: true }),
})

/**
 * The headless client job queue: work that needs plaintext, so it can only run
 * in a browser that holds the keys. Read-mostly kinds only in v1.
 *
 * `payload` is envelope level only. Never a body, never a body excerpt, never a
 * subject: this table is control plane, and Invariant K applies to it in full.
 */
export const mailboxClientJobs = kernel.table(
  "mailbox_client_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: uuid("account_id"),
    /** `summarise` | `triage_label` | `index_backfill` | `migration_verify`. */
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** `pending` | `claimed` | `done` | `failed` | `expired`. */
    status: text("status").notNull().default("pending"),
    /** Opaque client session id holding the lease. */
    claimedBySession: text("claimed_by_session"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    attempts: smallint("attempts").notNull().default(0),
    /** Sealed to the user's own key, so the result is no more readable to the
     *  server than the input was. */
    resultCiphertext: bytea("result_ciphertext"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_mailbox_client_jobs_user_status").on(table.userId, table.status, table.createdAt),
    check(
      "mailbox_client_jobs_status",
      sql`${table.status} IN ('pending', 'claimed', 'done', 'failed', 'expired')`,
    ),
  ],
)

export type UserMailboxIdentity = typeof userMailboxIdentities.$inferSelect
export type NewUserMailboxIdentity = typeof userMailboxIdentities.$inferInsert
export type UserKeyWrap = typeof userKeyWraps.$inferSelect
export type NewUserKeyWrap = typeof userKeyWraps.$inferInsert
export type MailboxMigrationState = typeof mailboxMigrationState.$inferSelect
export type MailboxClientJob = typeof mailboxClientJobs.$inferSelect

/**
 * Server-managed mailbox encryption: one data key (DEK) per `managed` personal
 * mailbox, wrapped under ENCRYPTION_KEY with AES-256-GCM (`lib/crypto.ts`,
 * `CryptoContext.mailboxServerKey`, AAD bound to org, account and version).
 *
 * A `ready` (zero-access) mailbox has no row here. The request role sees
 * nothing (RLS forced, no policy): only the privileged pool reads or writes it,
 * through `modules/mailbox-crypto/managed-keys.ts`. Never granted to
 * `liaison_readonly`. Kept in a full export on purpose: a restore needs it to
 * read managed mail, and a wrapped key is useless without ENCRYPTION_KEY.
 */
export const mailboxServerKeys = kernel.table(
  "mailbox_server_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** `app_mail.accounts.id`. No FK: app schemas are created after kernel. */
    accountId: uuid("account_id").notNull(),
    /** The DEK version, stamped as `enc_key_id` on every row it seals. */
    keyVersion: smallint("key_version").notNull().default(1),
    /** `encryptSecret(hex(DEK), ENCRYPTION_KEY, context)`. */
    wrappedKey: text("wrapped_key").notNull(),
    /** Which key-encryption key wraps it: `env` = ENCRYPTION_KEY. */
    kekRef: text("kek_ref").notNull().default("env"),
    /** `active` | `retired`. */
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("uq_mailbox_server_keys_active")
      .on(table.accountId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("uq_mailbox_server_keys_version").on(table.accountId, table.keyVersion),
    index("idx_mailbox_server_keys_org").on(table.orgId),
    check("mailbox_server_keys_version_byte", sql`${table.keyVersion} BETWEEN 0 AND 255`),
    check("mailbox_server_keys_status", sql`${table.status} IN ('active', 'retired')`),
  ],
)

/**
 * Deployment-wide decisions taken once and then held by every process (0231).
 * `mail.encryption_default`: the personal-mailbox encryption default when
 * MAILBOX_ENCRYPTION_DEFAULT is unset (`modules/mailbox-crypto/encryption-mode.ts`).
 * Privileged pool only (RLS forced, no policy).
 */
export const instanceSettings = kernel.table("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
})
