// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Who may act on an existing import run. Permissions are read live (never a
 * token or enqueue-time snapshot): the person must still be an active member
 * holding every write scope of the run's kinds, and, to cancel or undo, be
 * the person who started the run, the person who asked for it (an approved
 * agent run), or an org admin (`kernel:users:admin`).
 */
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { users } from "~/db/schema/kernel"
import { lookupImportKind } from "~/modules/imports/kinds"
import { ImportError } from "~/modules/imports/types"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

/** The person's live permissions, or null when they are no longer an active member. */
export async function liveActor(orgId: string, userId: string): Promise<UserContext | null> {
  return withPrivilegedDb(orgId, "imports-live-actor", async (tx) => {
    const [u] = await tx
      .select({ status: users.status })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1)
    if (u?.status !== "active") return null
    const perms = await loadEffectivePermissions(tx, userId, orgId)
    return {
      actorType: "user",
      userId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    }
  })
}

/** The write scopes of the run's kinds the person does not hold (unknown kinds: every kind's built-in decl). */
function missingScopes(actor: UserContext, orgId: string, kinds: readonly string[]): string[] {
  const missing: string[] = []
  for (const name of kinds) {
    const k = lookupImportKind(orgId, name, true)
    if (!k) {
      missing.push(`(unknown kind ${name})`)
      continue
    }
    for (const scope of k.decl.writeScopes) {
      if (!hasScope(scope, actor.scopes) && !missing.includes(scope)) missing.push(scope)
    }
  }
  return missing
}

/**
 * Refuse unless `userId` may cancel or undo this run: an active member with
 * the kinds' write scopes who started the run or is an org admin.
 */
export async function assertRunAuthority(
  orgId: string,
  userId: string,
  run: { startedBy: string | null; kindSet: string[]; source?: Record<string, unknown> },
): Promise<UserContext> {
  const actor = await liveActor(orgId, userId)
  if (!actor) throw new ImportError("forbidden", "only an active member can change an import run")
  // The person who asked for an approved run (its `source.requestedBy`) may
  // change it as well as the approver it runs as.
  const requestedBy = run.source?.requestedBy
  if (
    run.startedBy !== userId &&
    requestedBy !== userId &&
    !hasScope("kernel:users:admin", actor.scopes)
  ) {
    throw new ImportError("forbidden", "only the person who started the run or an admin can")
  }
  const missing = missingScopes(actor, orgId, run.kindSet)
  if (missing.length > 0) {
    throw new ImportError("forbidden", `missing scope(s): ${missing.join(", ")}`)
  }
  return actor
}

/** How many of `emails` are active members of the org (case-insensitive). */
export async function countMembersByEmail(orgId: string, emails: string[]): Promise<number> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))]
  if (wanted.length === 0) return 0
  const rows = await withPrivilegedDb(orgId, "imports-count-members", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.status, "active"),
          inArray(drizzleSql<string>`lower(${users.email})`, wanted),
        ),
      ),
  )
  return rows.length
}

/** A person's name (else email) for an approval card, or null when unknown. */
export async function personLabel(orgId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null
  const [u] = await withPrivilegedDb(orgId, "imports-person-label", (tx) =>
    tx
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  return u ? u.name || u.email : null
}
