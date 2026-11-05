// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REQUIRED SECOND FACTOR FOR ADMINISTRATORS (org setting
// `settings.requireAdminSecondFactor`, default off).
//
// When an org turns it on, a person who holds any administrative scope and has
// no second factor (two-step verification with an authenticator app) gets a
// session that carries NO scopes, roles or dimension grants, is restricted (it
// mints no further credential: no device approval, MCP consent, desktop
// connection or WebSocket ticket), and is marked `secondFactorRequired`. The
// only thing it can do is enroll: the TOTP setup and confirm routes accept it.
// Once enrolled, the next refresh mints the person's full session.
//
// The check runs where every session is minted (`createSession`, the password
// change), so no sign-in path skips it. Turning the setting on bumps the
// permission version of every member, so tokens minted before stop working at
// once and the next refresh applies the rule.

import { sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { hasScope } from "~/modules/permissions/permissions"
import { getScopeCatalog } from "~/modules/permissions/scope-catalog"

/** Kernel administrative scopes, checked even when the catalog is cold. */
const KERNEL_ADMIN_SCOPES = [
  "kernel:org:admin",
  "kernel:users:admin",
  "kernel:roles:admin",
  "kernel:apps:admin",
  "kernel:agents:admin",
  "kernel:policies:admin",
  "kernel:threads:admin",
  "kernel:approvals:admin",
  "kernel:scope_requests:admin",
  "kernel:contacts:admin",
  "kernel:saved_views:admin",
]

/**
 * Whether these granted scopes include an administrative one: `*`, any scope
 * whose action is `admin`, or a parent that grants a known `…:admin` scope
 * (e.g. `kernel`, `kernel:users`, `tickets:*`).
 */
export function holdsAdminScope(orgId: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return false
  const granted = [...scopes]
  if (granted.some((s) => s === "*" || s.split(":").at(-1) === "admin")) return true
  const catalogAdmin = getScopeCatalog(orgId)
    .map((e) => e.scope)
    .filter((s) => s.endsWith(":admin"))
  return [...KERNEL_ADMIN_SCOPES, ...catalogAdmin].some((a) => hasScope(a, granted))
}

/**
 * True when the org requires a second factor for administrators, this person
 * holds an administrative scope, and has no second factor yet. Runs inside the
 * session-minting transaction.
 */
export async function adminSecondFactorPending(
  tx: PrivilegedDb,
  userId: string,
  orgId: string,
  scopes: readonly string[],
): Promise<boolean> {
  if (!holdsAdminScope(orgId, scopes)) return false
  const K = sql.raw(schemaRef("kernel"))
  const result = await tx.execute(sql`
    SELECT
      COALESCE((o.settings->>'requireAdminSecondFactor')::boolean, false) AS required,
      u.totp_enabled AS enrolled
    FROM ${K}.organizations o
    JOIN ${K}.users u ON u.org_id = o.id AND u.id = ${userId}
    WHERE o.id = ${orgId}
  `)
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  const row = rows[0] as { required: boolean; enrolled: boolean } | undefined
  return !!row && row.required === true && row.enrolled !== true
}

/** The message a request from a session waiting on enrollment is refused with. */
export const SECOND_FACTOR_REQUIRED_MESSAGE =
  "Your organisation requires two-step verification for administrators. Set it up to continue."

/**
 * Called in the transaction that turns the setting on: every member's
 * permission version moves, so access tokens minted before stop authenticating
 * and the next refresh applies the rule. Answers the bumped user ids, whose
 * cached auth state the caller drops after commit.
 */
export async function bumpOrgPermissionVersions(
  tx: PrivilegedDb,
  orgId: string,
): Promise<string[]> {
  const K = sql.raw(schemaRef("kernel"))
  const result = await tx.execute(sql`
    UPDATE ${K}.users SET permission_version = permission_version + 1
    WHERE org_id = ${orgId}
    RETURNING id
  `)
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  return (rows as { id: string }[]).map((r) => r.id)
}

/** Whether this person has a second factor (two-step verification) set up. */
export async function hasSecondFactor(
  tx: PrivilegedDb,
  userId: string,
  orgId: string,
): Promise<boolean> {
  const K = sql.raw(schemaRef("kernel"))
  const result = await tx.execute(
    sql`SELECT totp_enabled FROM ${K}.users WHERE id = ${userId} AND org_id = ${orgId}`,
  )
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  return (rows[0] as { totp_enabled?: boolean } | undefined)?.totp_enabled === true
}
