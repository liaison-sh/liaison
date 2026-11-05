// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Server-managed mailbox encryption: the per-mailbox data keys (DEKs).
//
// A personal mailbox in the `managed` encryption state is sealed under its own
// random 32-byte data key. The key is stored in `kernel.mailbox_server_keys`,
// wrapped with AES-256-GCM under ENCRYPTION_KEY (`lib/crypto.ts`
// `encryptSecret`, `CryptoContext.mailboxServerKey`), the AAD binding the org,
// the account and the key version so a wrapped key cannot be moved to another
// mailbox. No KDF: the wrap is a plain AEAD under the instance key.
//
// This module has nothing to do with the zero-access (`ready`) mode. A `ready`
// mailbox has no row here and nothing in this file can read it: the server
// still holds no key for it (T-SEC-1).
//
// Every read and write goes through the privileged pool: the request role
// cannot see the table at all (RLS forced, no policy).

import { randomBytes } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { decryptSecret, encryptSecret, mailboxServerKeyContext } from "~/lib/crypto"
import { env } from "~/lib/env"

/** The key-encryption key reference this release writes: ENCRYPTION_KEY. */
export const MAILBOX_SERVER_KEK_REF = "env"

/** Anything that can run raw SQL under the privileged role. */
export interface ManagedKeyExecutor {
  execute(query: unknown): Promise<unknown>
}

export class MailboxServerKeyError extends Error {
  readonly code:
    | "MAILBOX_SERVER_KEY_MISSING"
    | "MAILBOX_SERVER_KEY_UNSUPPORTED_KEK"
    | "MAILBOX_SERVER_KEY_REFUSED"
  constructor(code: MailboxServerKeyError["code"], message: string) {
    super(`${code}: ${message}`)
    this.name = "MailboxServerKeyError"
    this.code = code
  }
}

export interface MailboxServerKey {
  keyVersion: number
  /** The raw data key. Callers zero it once done (`key.fill(0)`). */
  key: Buffer
}

const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

function unwrap(
  row: { wrapped_key: string; kek_ref: string; key_version: number },
  orgId: string,
  accountId: string,
  kek: string,
): Buffer {
  if (row.kek_ref !== MAILBOX_SERVER_KEK_REF) {
    throw new MailboxServerKeyError(
      "MAILBOX_SERVER_KEY_UNSUPPORTED_KEK",
      `mailbox ${accountId} key version ${row.key_version} is wrapped by "${row.kek_ref}", which this release cannot use`,
    )
  }
  const hex = decryptSecret(
    row.wrapped_key,
    kek,
    mailboxServerKeyContext(orgId, accountId, Number(row.key_version)),
  )
  return Buffer.from(hex, "hex")
}

/**
 * Mint the mailbox's data key, or return the active one if it already has one.
 * Idempotent, so a retried connect never mints a second key. Runs on the
 * caller's PRIVILEGED executor, so the key commits with whatever created the
 * mailbox, or not at all.
 */
export async function ensureMailboxServerKey(
  tx: ManagedKeyExecutor,
  orgId: string,
  accountId: string,
  kek: string = env.ENCRYPTION_KEY,
): Promise<number> {
  const existing = extractRows<{ key_version: number }>(
    await tx.execute(drizzleSql`
      SELECT key_version FROM ${K()}.mailbox_server_keys
       WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid AND status = 'active'
       LIMIT 1`),
  )[0]
  if (existing) return Number(existing.key_version)
  // A key is minted only for a mailbox that is transparent, or being made
  // transparent. A private mailbox (or one whose move to private destroyed its
  // keys) must never get one back from a late writer that still thought it
  // was transparent: that writer's seal fails instead.
  const account = extractRows<{
    encryption_state: string | null
    encryption_conversion: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT encryption_state, encryption_conversion
        FROM ${drizzleSql.raw(`"${schemaRef("app_mail")}"`)}.accounts
       WHERE id = ${accountId}::uuid AND org_id = ${orgId}::uuid`),
  )[0]
  const transparent =
    (account?.encryption_state === "managed" && account.encryption_conversion !== "to_private") ||
    (account?.encryption_state === "ready" && account.encryption_conversion === "to_managed")
  if (!transparent) {
    throw new MailboxServerKeyError(
      "MAILBOX_SERVER_KEY_REFUSED",
      `mailbox ${accountId} is not transparent, so no server key is created for it`,
    )
  }
  const next = extractRows<{ v: number }>(
    await tx.execute(drizzleSql`
      SELECT COALESCE(MAX(key_version), 0) + 1 AS v FROM ${K()}.mailbox_server_keys
       WHERE account_id = ${accountId}::uuid`),
  )[0]
  const keyVersion = Number(next?.v ?? 1)
  const dek = randomBytes(32)
  try {
    const wrapped = encryptSecret(
      dek.toString("hex"),
      kek,
      mailboxServerKeyContext(orgId, accountId, keyVersion),
    )
    await tx.execute(drizzleSql`
      INSERT INTO ${K()}.mailbox_server_keys (org_id, account_id, key_version, wrapped_key, kek_ref)
      VALUES (${orgId}::uuid, ${accountId}::uuid, ${keyVersion}, ${wrapped}, ${MAILBOX_SERVER_KEK_REF})`)
  } finally {
    dek.fill(0)
  }
  return keyVersion
}

/**
 * Load a mailbox data key: the active one, or a given version (a row sealed
 * under a retired version still opens). Throws `MAILBOX_SERVER_KEY_MISSING`
 * when there is none: a managed mailbox without its key is a fault to surface,
 * never a reason to write or show plaintext.
 */
export async function loadMailboxServerKey(
  tx: ManagedKeyExecutor,
  orgId: string,
  accountId: string,
  keyVersion?: number,
  kek: string = env.ENCRYPTION_KEY,
): Promise<MailboxServerKey> {
  const versionFilter =
    keyVersion === undefined
      ? drizzleSql`status = 'active'`
      : drizzleSql`key_version = ${keyVersion}`
  const row = extractRows<{ wrapped_key: string; kek_ref: string; key_version: number }>(
    await tx.execute(drizzleSql`
      SELECT wrapped_key, kek_ref, key_version FROM ${K()}.mailbox_server_keys
       WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid AND ${versionFilter}
       LIMIT 1`),
  )[0]
  if (!row) {
    throw new MailboxServerKeyError(
      "MAILBOX_SERVER_KEY_MISSING",
      `mailbox ${accountId} has no ${keyVersion === undefined ? "active" : `version ${keyVersion}`} server key`,
    )
  }
  return { keyVersion: Number(row.key_version), key: unwrap(row, orgId, accountId, kek) }
}

/** `loadMailboxServerKey` on its own short privileged transaction. */
export async function loadMailboxServerKeyPrivileged(
  orgId: string,
  accountId: string,
  keyVersion?: number,
): Promise<MailboxServerKey> {
  return withPrivilegedDb(orgId, "mailbox-server-key:load", (tx) =>
    loadMailboxServerKey(tx, orgId, accountId, keyVersion),
  )
}

/**
 * Destroy every data key of a mailbox (crypto-shredding). Used when the mailbox
 * is purged, and when it moves to private once every row is re-sealed: from
 * then on nothing can open what the keys sealed.
 */
export async function destroyMailboxServerKeys(
  tx: ManagedKeyExecutor,
  orgId: string,
  accountId: string,
): Promise<number> {
  return extractRows<{ id: string }>(
    await tx.execute(drizzleSql`
      DELETE FROM ${K()}.mailbox_server_keys
       WHERE account_id = ${accountId}::uuid AND org_id = ${orgId}::uuid
      RETURNING id::text AS id`),
  ).length
}

/**
 * The data key a WRITER seals under: the active one, minted on first use.
 * A mailbox put in the `managed` state (at connect, or by the boot step) gets
 * its key the first time anything is sealed to it, so no path can leave a
 * managed mailbox unable to receive mail. Two first seals racing on the
 * unique active key resolve to the one that won.
 */
export async function loadOrCreateMailboxServerKeyPrivileged(
  orgId: string,
  accountId: string,
): Promise<MailboxServerKey> {
  try {
    return await loadMailboxServerKeyPrivileged(orgId, accountId)
  } catch (err) {
    if (!(err instanceof MailboxServerKeyError) || err.code !== "MAILBOX_SERVER_KEY_MISSING") {
      throw err
    }
  }
  try {
    await withPrivilegedDb(orgId, "mailbox-server-key:mint", (tx) =>
      ensureMailboxServerKey(tx, orgId, accountId),
    )
  } catch (err) {
    if (err instanceof MailboxServerKeyError) throw err
    // A concurrent first seal won the unique active key: use it.
  }
  return loadMailboxServerKeyPrivileged(orgId, accountId)
}
