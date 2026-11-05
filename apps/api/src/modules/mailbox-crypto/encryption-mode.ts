// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which encryption mode a personal mailbox gets: `managed` (transparent: sealed
// under a per-mailbox key the server holds, read by the owner and the owner's
// agent with no mailbox password) or `private` (zero-access: sealed to a key
// only the owner's browser holds).
//
// The mode is the USER's choice, inside one org switch:
//   * the org allows private mailboxes (`mail.allowPrivateMailboxes`, default
//     on): each person picks for themselves (`mail.encryptionPreference` in
//     their own settings); with no pick, the deployment default applies;
//   * the org does not: new mailboxes are transparent and nobody can pick
//     private. Existing private mailboxes STAY private: nothing here touches a
//     mailbox that exists.
//
// The deployment default is MAILBOX_ENCRYPTION_DEFAULT. Unset (`auto`), it is
// decided ONCE, on first use, and stored in `kernel.instance_settings` under a
// lock: `private` when anyone on the deployment had set up a private mailbox by
// then (an active keyring or a past enrollment, whatever their recorded
// preference), else `managed`. Never re-decided: a preference picked or a
// mailbox password set later cannot move it, and every process reads the same
// stored answer. A deployment that ran zero-access before this release resolves
// to private on its first boot and stays private.
//
// MAILBOX_ENCRYPTION_ALLOW_MANAGED=false LOCKS private: the default is private
// whatever it says, nobody can pick transparent, and no mailbox is moved to (or
// made) transparent. Existing transparent mailboxes stay as they are.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"

export type MailboxEncryptionMode = "managed" | "private"

export interface DeploymentEncryptionDefault {
  mode: MailboxEncryptionMode
  /**
   * `env`: MAILBOX_ENCRYPTION_DEFAULT. `env:locked_private`:
   * MAILBOX_ENCRYPTION_ALLOW_MANAGED=false. `auto:stored`: decided earlier and
   * stored. `auto:*`: decided by this call, why.
   */
  reason:
    | "env"
    | "env:locked_private"
    | "auto:stored"
    | "auto:legacy_private_enrollments"
    | "auto:no_legacy_enrollment"
}

type Exec = { execute(q: unknown): Promise<unknown> }

const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

/** The `kernel.instance_settings` key the `auto` decision is stored under. */
export const ENCRYPTION_DEFAULT_SETTING = "mail.encryption_default"

let cachedDefault: DeploymentEncryptionDefault | null = null

/** Test seam. */
export const EncryptionModeTestAccess = {
  reset(): void {
    cachedDefault = null
  },
}

export function isMailboxEncryptionMode(value: unknown): value is MailboxEncryptionMode {
  return value === "managed" || value === "private"
}

/** False when MAILBOX_ENCRYPTION_ALLOW_MANAGED locks the deployment to private. */
export function managedEncryptionAllowed(): boolean {
  return env.MAILBOX_ENCRYPTION_ALLOW_MANAGED !== false
}

async function storedDefault(tx: Exec): Promise<MailboxEncryptionMode | null> {
  const row = extractRows<{ mode: string | null }>(
    await tx.execute(drizzleSql`
      SELECT value ->> 'mode' AS mode FROM ${K()}.instance_settings
       WHERE key = ${ENCRYPTION_DEFAULT_SETTING}`),
  )[0]
  return isMailboxEncryptionMode(row?.mode) ? row.mode : null
}

/**
 * The deployment default. Unset, decided once and stored (see the header).
 * Run on a PRIVILEGED transaction: the decision reads every org and takes a
 * transaction-scoped advisory lock so two processes deciding at once store
 * one answer.
 */
export async function resolveDeploymentEncryptionDefault(
  tx: Exec,
  /** Default: MAILBOX_ENCRYPTION_DEFAULT. `null` = resolve as if unset (`auto`). */
  configured?: MailboxEncryptionMode | null,
): Promise<DeploymentEncryptionDefault> {
  if (!managedEncryptionAllowed()) return { mode: "private", reason: "env:locked_private" }
  const value = configured === undefined ? env.MAILBOX_ENCRYPTION_DEFAULT : configured
  if (value) return { mode: value, reason: "env" }
  if (cachedDefault) return cachedDefault
  const stored = await storedDefault(tx)
  if (stored) {
    // Only a committed answer is cached: one this call stores below could
    // still roll back with the caller's transaction.
    cachedDefault = { mode: stored, reason: "auto:stored" }
    return cachedDefault
  }
  await tx.execute(
    drizzleSql`SELECT pg_advisory_xact_lock(hashtext(${`liaison:${ENCRYPTION_DEFAULT_SETTING}`}))`,
  )
  const raced = await storedDefault(tx)
  if (raced) return { mode: raced, reason: "auto:stored" }
  const rows = extractRows<{ legacy: boolean }>(
    await tx.execute(drizzleSql`
      SELECT (
        EXISTS (SELECT 1 FROM ${K()}.user_mailbox_identities i WHERE i.status = 'active')
        OR EXISTS (SELECT 1 FROM ${K()}.mailbox_migration_state s WHERE s.enrolled_at IS NOT NULL)
      ) AS legacy`),
  )
  const resolved: DeploymentEncryptionDefault =
    rows[0]?.legacy === true
      ? { mode: "private", reason: "auto:legacy_private_enrollments" }
      : { mode: "managed", reason: "auto:no_legacy_enrollment" }
  await tx.execute(drizzleSql`
    INSERT INTO ${K()}.instance_settings (key, value)
    VALUES (${ENCRYPTION_DEFAULT_SETTING}, ${JSON.stringify({ mode: resolved.mode, reason: resolved.reason })}::jsonb)
    ON CONFLICT (key) DO NOTHING`)
  log.info(
    { mode: resolved.mode, reason: resolved.reason },
    "Mailbox encryption default decided and stored (MAILBOX_ENCRYPTION_DEFAULT unset)",
  )
  return resolved
}

/** The org switch. Default: private mailboxes are allowed. */
export async function orgAllowsPrivateMailboxes(tx: Exec, orgId: string): Promise<boolean> {
  const row = extractRows<{ v: unknown }>(
    await tx.execute(drizzleSql`
      SELECT settings -> 'mail' -> 'allowPrivateMailboxes' AS v
        FROM ${K()}.organizations WHERE id = ${orgId}::uuid`),
  )[0]
  return row?.v !== false && row?.v !== "false"
}

/** The person's own pick, or null when they never chose. */
export async function userEncryptionPreference(
  tx: Exec,
  userId: string,
): Promise<MailboxEncryptionMode | null> {
  const row = extractRows<{ v: string | null }>(
    await tx.execute(drizzleSql`
      SELECT settings -> 'mail' ->> 'encryptionPreference' AS v
        FROM ${K()}.users WHERE id = ${userId}::uuid`),
  )[0]
  return isMailboxEncryptionMode(row?.v) ? row.v : null
}

export interface MailboxEncryptionSettings {
  deploymentDefault: MailboxEncryptionMode
  /** False when the deployment locks mailboxes to private (MAILBOX_ENCRYPTION_ALLOW_MANAGED). */
  allowManaged: boolean
  allowPrivate: boolean
  preference: MailboxEncryptionMode | null
  /** What a mailbox this person connects now gets. */
  effective: MailboxEncryptionMode
  /** Whether "Make transparent" is offered (never on a private-default deployment). */
  canMakeTransparent: boolean
}

export async function mailboxEncryptionSettings(
  tx: Exec,
  orgId: string,
  userId: string,
): Promise<MailboxEncryptionSettings> {
  const deployment = await resolveDeploymentEncryptionDefault(tx)
  const allowPrivate = await orgAllowsPrivateMailboxes(tx, orgId)
  const preference = await userEncryptionPreference(tx, userId)
  const allowManaged = managedEncryptionAllowed()
  // The deployment lock wins over everything; then the org switch; then the
  // person's pick; then the deployment default.
  const effective: MailboxEncryptionMode = !allowManaged
    ? "private"
    : !allowPrivate
      ? "managed"
      : (preference ?? deployment.mode)
  return {
    deploymentDefault: deployment.mode,
    allowManaged,
    allowPrivate,
    preference,
    effective,
    canMakeTransparent: allowManaged && (deployment.mode === "managed" || !allowPrivate),
  }
}

/** The mode a new personal mailbox of `userId` is born in. */
export async function effectiveMailboxEncryptionMode(
  tx: Exec,
  orgId: string,
  userId: string,
): Promise<MailboxEncryptionMode> {
  return (await mailboxEncryptionSettings(tx, orgId, userId)).effective
}

/**
 * `effectiveMailboxEncryptionMode` on its own short privileged read: the
 * deployment default looks at every org, and the org switch and the person's
 * pick are read for exactly this org and this person.
 */
export async function effectiveMailboxEncryptionModeFor(
  orgId: string,
  userId: string,
): Promise<MailboxEncryptionMode> {
  return withPrivilegedDb(orgId, "mail:encryption-mode", (tx) =>
    effectiveMailboxEncryptionMode(tx, orgId, userId),
  )
}
