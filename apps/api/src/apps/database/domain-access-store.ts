// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Reads and writes of the database connector's per-domain read access
 * (`organizations.settings.database.domainAccess`, rules in domain-access.ts).
 * One writer for the settings route, config apply and the demo seed, so every
 * path validates the same way and touches only that one key.
 */

import type { DatabaseDomainAccess } from "@liaison/shared"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations, roles, users } from "~/db/schema/kernel"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { type DomainAccessCaller, isSystemActorId, parseStoredDomainAccess } from "./domain-access"

/** The org's stored rules (parsed, failing closed on a malformed entry). */
export async function readOrgDomainAccess(
  tx: PrivilegedDb,
  orgId: string,
): Promise<DatabaseDomainAccess> {
  const [row] = await tx
    .select({ raw: sql<unknown>`${organizations.settings}->'database'->'domainAccess'` })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  let raw = row?.raw
  if (typeof raw === "string") raw = JSON.parse(raw)
  return parseStoredDomainAccess(raw, orgId)
}

export async function loadOrgDomainAccess(orgId: string): Promise<DatabaseDomainAccess> {
  return withPrivilegedDb(orgId, "database-domain-access-read", (tx) =>
    readOrgDomainAccess(tx, orgId),
  )
}

/**
 * The person a call acts for, with their own roles and grants; a job is the
 * system. `callScopes` (the call's own effective scopes) join the person's for
 * the admin and raw-query passes only: a call that holds database:query:read
 * can read the same tables with db_query, so a tier could not stop it anyway.
 */
export async function loadDomainAccessCaller(
  orgId: string,
  userId: string,
  callScopes: readonly string[] = [],
): Promise<DomainAccessCaller> {
  if (isSystemActorId(userId)) return { kind: "system" }
  const perms = await withPrivilegedDb(orgId, "database-domain-access-caller", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    kind: "person",
    userId,
    roleIds: perms.roles,
    scopes: [...new Set([...perms.scopes, ...callScopes])],
  }
}

export class DomainAccessReferenceError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message)
    this.name = "DomainAccessReferenceError"
  }
}

/**
 * Every role and person a rule names must belong to the org. Throws a
 * `DomainAccessReferenceError` naming the first offending field.
 */
export async function assertDomainAccessReferences(
  tx: PrivilegedDb,
  orgId: string,
  map: DatabaseDomainAccess,
): Promise<void> {
  const roleIds = new Set<string>()
  const userIds = new Set<string>()
  for (const rule of Object.values(map)) {
    for (const id of rule.roles ?? []) roleIds.add(id)
    for (const id of rule.users ?? []) userIds.add(id)
  }
  const knownRoles = roleIds.size
    ? new Set(
        (
          await tx
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.orgId, orgId), inArray(roles.id, [...roleIds])))
        ).map((r) => r.id),
      )
    : new Set<string>()
  const knownUsers = userIds.size
    ? new Set(
        (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.orgId, orgId), inArray(users.id, [...userIds])))
        ).map((u) => u.id),
      )
    : new Set<string>()
  for (const [domain, rule] of Object.entries(map)) {
    for (const id of rule.roles ?? []) {
      if (!knownRoles.has(id)) {
        throw new DomainAccessReferenceError(
          `domainAccess.${domain}.roles: no role ${id} in this organization`,
          `domainAccess.${domain}.roles`,
        )
      }
    }
    for (const id of rule.users ?? []) {
      if (!knownUsers.has(id)) {
        throw new DomainAccessReferenceError(
          `domainAccess.${domain}.users: no person ${id} in this organization`,
          `domainAccess.${domain}.users`,
        )
      }
    }
  }
}

/**
 * Replaces the stored map. Touches only `settings.database.domainAccess`:
 * every sibling key, under `database` and beside it, survives.
 */
export async function writeOrgDomainAccess(
  tx: PrivilegedDb,
  orgId: string,
  map: DatabaseDomainAccess,
): Promise<void> {
  await tx.execute(sql`
    UPDATE ${organizations}
    SET settings = jsonb_set(
          COALESCE(settings, '{}'::jsonb),
          '{database}',
          CASE WHEN jsonb_typeof(settings->'database') = 'object' THEN settings->'database' ELSE '{}'::jsonb END
            || jsonb_build_object('domainAccess', ${JSON.stringify(map)}::jsonb),
          true
        ),
        updated_at = now()
    WHERE id = ${orgId}
  `)
}
