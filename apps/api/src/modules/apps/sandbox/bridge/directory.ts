// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Directory reads an app needs to decide access rules of its own (who may see
// which of its reports, records or pages) without a privileged path of its own:
//
//   ctx.kernel.caller(scopes?)     who the run acts for: the system (a job, a
//                                  boot step), or a person with the ids of their
//                                  roles, and whether they hold each scope asked
//                                  about (their own grants or the call's).
//   ctx.kernel.roles()             the org's roles, id and name.
//   ctx.kernel.findUsersByEmail()  the org's people by email (directory fields).
//
// All three are reads of the app's own org. `caller` answers a scope question
// only for the scopes named (at most 20), never the caller's whole grant list.

import { sql as drizzleSql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { KERNEL_USER_COLUMNS } from "~/modules/apps/sandbox/bridge/context"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

export type KernelCaller =
  | { kind: "system"; holds: Record<string, boolean> }
  | { kind: "person"; userId: string; roleIds: string[]; holds: Record<string, boolean> }

const kernelTable = (name: string) =>
  drizzleSql.raw(`${quoteIdent(schemaRef("kernel"))}.${quoteIdent(name)}`)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SCOPES = 20

/** The system identity: the platform's own runs (`system`) and jobs (`system:<app>:<job>`). */
export function isSystemActorId(userId: string): boolean {
  return userId === "system" || userId.startsWith("system:")
}
const MAX_EMAILS = 200

function scopeList(raw: unknown): string[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw
  if (parsed === undefined || parsed === null) return []
  if (!Array.isArray(parsed) || !parsed.every((s): s is string => typeof s === "string")) {
    throw new Error("kernel_caller: scopes is an array of strings")
  }
  if (parsed.length > MAX_SCOPES) throw new Error(`kernel_caller: at most ${MAX_SCOPES} scopes`)
  return [...new Set(parsed)]
}

/**
 * The person the run acts for (the human behind an agent turn, also when
 * another agent asked it inline), judged on their own roles and grants joined
 * with the call's; the system identity (`system`, or a job's `system:...`)
 * holds every scope asked. Any other id that is not a person fails closed: the
 * call is refused, never answered as the system.
 */
export async function kernelCaller(
  input: { orgId: string; userId: string; callerScopes: readonly string[] },
  rawScopes: unknown,
): Promise<KernelCaller> {
  const asked = scopeList(rawScopes)
  if (isSystemActorId(input.userId)) {
    return { kind: "system", holds: Object.fromEntries(asked.map((s) => [s, true])) }
  }
  if (!UUID_RE.test(input.userId)) {
    throw new Error("kernel_caller: the run acts for no person and is not a system run")
  }
  const perms = await withPrivilegedDb(input.orgId, "app-bridge-kernel-caller", (tx) =>
    loadEffectivePermissions(tx, input.userId, input.orgId),
  )
  const scopes = [...new Set([...perms.scopes, ...input.callerScopes])]
  return {
    kind: "person",
    userId: input.userId,
    roleIds: [...perms.roles],
    holds: Object.fromEntries(asked.map((s) => [s, hasScope(s, scopes)])),
  }
}

/** The org's roles, id and name, by name. */
export async function kernelRoles(
  txDb: RlsClient,
  orgId: string,
): Promise<Array<{ id: string; name: string }>> {
  return extractRows<{ id: string; name: string }>(
    await txDb.execute(
      drizzleSql`SELECT id, name FROM ${kernelTable("roles")} WHERE org_id = ${orgId} ORDER BY name`,
    ),
  )
}

/** The org's people with one of these emails (case-insensitive), directory fields. */
export async function kernelUsersByEmail(
  txDb: RlsClient,
  orgId: string,
  rawEmails: unknown,
): Promise<Record<string, unknown>[]> {
  const parsed = typeof rawEmails === "string" ? (JSON.parse(rawEmails) as unknown) : rawEmails
  if (!Array.isArray(parsed)) throw new Error("kernel_findUsersByEmail: emails is an array")
  if (parsed.length > MAX_EMAILS) {
    throw new Error(`kernel_findUsersByEmail: at most ${MAX_EMAILS} emails`)
  }
  const wanted = [
    ...new Set(
      parsed
        .filter((e): e is string => typeof e === "string" && e.length > 0)
        .map((e) => e.toLowerCase()),
    ),
  ]
  if (wanted.length === 0) return []
  return extractRows(
    await txDb.execute(
      drizzleSql`SELECT ${drizzleSql.raw(KERNEL_USER_COLUMNS)} FROM ${kernelTable("users")}
        WHERE org_id = ${orgId} AND lower(email) IN (${drizzleSql.join(
          wanted.map((e) => drizzleSql`${e}`),
          drizzleSql`, `,
        )})`,
    ),
  )
}
