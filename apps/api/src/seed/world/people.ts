// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the world injectors share: a stable id per (org, injected thing), the
// demo company's seeded people found by their display name, and a person's
// RLS actor, so an injected teammate's message is written exactly as that
// teammate would write it.
import { createHash } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"

/** A stable UUID for an injected entity: the same org and key always give the same id. */
export function worldId(orgId: string, key: string): string {
  const h = createHash("sha256").update(`liaison.demo.world|${orgId}|${key}`).digest("hex")
  const variant = "89ab"[Number.parseInt(h.slice(16, 17), 16) % 4]
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * The key of what a world beat brings in for one run of its scenario: the
 * first run (0) keeps the base key, each later run (Start again) gets its
 * own, so a new run injects a new entity and never finds an earlier run's.
 */
export function worldRunKey(base: string, run: number): string {
  return run === 0 ? base : `${base}:run-${run}`
}

/** A seeded teammate's user id by display name; throws when the world lacks them. */
export async function worldPersonId(orgId: string, name: string): Promise<string> {
  const [row] = await withPrivilegedDb(orgId, "demo-world-person", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.name, name)))
      .limit(1),
  )
  if (!row) throw new Error(`demo world: no teammate named ${name} in this org`)
  return row.id
}

/** The RLS actor of a person, with their effective scopes. */
export async function worldActor(orgId: string, userId: string): Promise<UserContext> {
  const perms = await withPrivilegedDb(orgId, "demo-world-permissions", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: perms.scopes,
    dimensionGrants: perms.dimensionGrants,
    roles: perms.roles,
  }
}
