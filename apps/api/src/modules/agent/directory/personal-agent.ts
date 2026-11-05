// SPDX-License-Identifier: FSL-1.1-ALv2
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { roleScopeGrants, userRoles, userScopeGrants } from "~/db/schema/kernel"
import { type Agent, agents, type NewAgent } from "~/db/schema/kernel/agents"
import { users } from "~/db/schema/kernel/users"
import { rootLogger } from "~/lib/logger"
import { AGENT_HANDLE_UNIQUE_INDEX, isUniqueViolationOn } from "~/lib/unique-violation"
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"
import {
  computeEffectivePermissions,
  dropAppScopes,
  everyMemberScopeGrants,
  loadEffectivePermissions,
  mcpServerAccessGrants,
  restrictedAppsDeniedTo,
} from "~/modules/permissions/permissions"
import { pickAgentAvatarColor } from "./avatar-color"
import { assertNoAdminScopesInRoleCeiling } from "./ceiling-guard"

const log = rootLogger.child({ module: "personal-agent" })

/**
 * A personal agent's ceiling from its owner's current scopes and the
 * administrator's deliberate narrowing (`agents.ceiling_restriction`, 0218):
 * the scopes of the owner the restriction covers, or the owner's scopes when
 * there is none. Never wider than the owner, never wider than the restriction,
 * so a recompute after a grant change neither drops a narrowing nor widens past
 * it. Coverage is `isScopeCovered`'s (`*`, `:*` globs, bare prefixes), the one
 * the turn's intersection uses.
 */
export function personalCeiling(
  ownerScopes: readonly string[],
  restriction: readonly string[] | null | undefined,
): string[] {
  if (!restriction) return [...ownerScopes]
  const fromOwner = ownerScopes.filter((s) => isScopeCovered([s], [...restriction]))
  const fromRestriction = restriction.filter(
    (s) => isScopeCovered([s], [...ownerScopes]) && !fromOwner.includes(s),
  )
  return [...fromOwner, ...fromRestriction]
}

export interface CreatePersonalAgentInput {
  orgId: string
  userId: string
  /** The user's email, used to derive the handle when firstName is unavailable. */
  email: string
  firstName?: string | null
  /**
   * Base handle (with its `@`) to try first instead of one derived from
   * firstName/email. A collision still falls back to the numeric
   * discriminator below.
   */
  baseHandle?: string
}

// spec-agents.md said "personal agents default to 'Liaison'". Liaison is the
// PRODUCT: there is no entity in it by that name, so the default named the
// application rather than the agent. The rows already created carry the old
// value until migration 0100 renames them.

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * The handle a personal agent is addressed by: its owner's agent, never the
 * owner. `@ada` in a message reads as the person Ada, so the agent of Ada is
 * `@adas-agent`; a name already ending in "s" takes no second one
 * (`@thomas-agent`). Migration 0205 renamed the rows created under the old
 * `@<name>` form with this same rule.
 */
export function personalAgentBaseHandle(slug: string): string {
  if (slug.length === 0) return "@agent"
  return slug.endsWith("s") ? `@${slug}-agent` : `@${slug}s-agent`
}

function emailLocalPart(email: string): string {
  return email.split("@")[0] ?? email
}

/**
 * The handle a person's agent is first offered, from their first name, else
 * their address (`personalAgentBaseHandle` of its slug).
 */
export function personalAgentHandleFor({
  firstName,
  email,
}: {
  firstName?: string | null
  email: string
}): string {
  const slugSource = firstName && firstName.trim().length > 0 ? firstName : emailLocalPart(email)
  return personalAgentBaseHandle(slugify(slugSource))
}

/**
 * Create the personal agent for a newly registered user. Called from inside
 * bootstrapRegister's own `withSystemDb` transaction, immediately after the
 * user row insert and the admin role assignment, so the scope lookup below
 * already sees the fresh user's resolvable grants.
 *
 * `scopeCeiling` is the user's OWN current grants, read via the same
 * grant-resolution path `withRlsContext`/`resolveScopes` already uses:
 * `loadEffectivePermissions` (permissions.ts) feeds the `scopes` that a
 * `UserContext` carries, and `resolveScopes()` (rls.ts:49) for a user actor
 * is just `ctx.scopes` — so reusing `loadEffectivePermissions` here is the
 * same mechanism, not a second one.
 */
export async function createPersonalAgent(
  tx: PrivilegedDb,
  { orgId, userId, email, firstName, baseHandle: requestedBaseHandle }: CreatePersonalAgentInput,
): Promise<Agent> {
  const baseHandle = requestedBaseHandle ?? personalAgentHandleFor({ firstName, email })

  const { scopes } = await loadEffectivePermissions(tx, userId, orgId)

  // A personal agent's ceiling equals its owner's own grants (which may
  // legitimately include admin scopes for an admin user), so this is a
  // documented no-op for kind='personal' — called anyway to go through the
  // same validated write path every other agent-creation route uses.
  assertNoAdminScopesInRoleCeiling("personal", scopes)

  return insertPersonalAgentWithFreeHandle(tx, baseHandle, {
    orgId,
    kind: "personal",
    displayName: PERSONAL_AGENT_DISPLAY_NAME,
    ownerUserId: userId,
    scopeCeiling: scopes,
  })
}

/**
 * Insert a personal agent row under the first free handle of `baseHandle`
 * (`@alex`, then `@alex2`, `@alex3`, ...). Shared by `createPersonalAgent` and
 * the demo pool's claim, which gives a pooled workspace's owner their own
 * agent once their name is known (modules/demo/demo-pool.ts).
 */
export async function insertPersonalAgentWithFreeHandle(
  tx: PrivilegedDb,
  baseHandle: string,
  values: Omit<NewAgent, "handle"> & { orgId: string; ownerUserId: string },
): Promise<Agent> {
  const { orgId, ownerUserId: userId } = values
  // `handle` is immutable after insert (0051_agents_handle_immutable.sql's
  // trigger), so a collision-safe handle at INSERT time is the only chance.
  // Two users in the same org can slugify to the same base handle (same
  // first name, or the same email local part before the @), so try the base
  // handle first, then a deterministic numeric discriminator (@alexs-agent,
  // @alexs-agent2, @alexs-agent3, ...). Retry-on-conflict rather than check-then-insert: a
  // check-then-insert can lose a race between two concurrent signups slugifying
  // to the same base, while a unique-violation retry cannot.
  const MAX_HANDLE_ATTEMPTS = 50
  // The org's least-used colour, unless the caller chose one.
  const avatarColor = values.avatarColor ?? (await pickAgentAvatarColor(tx, orgId))
  let lastCollisionErr: unknown
  for (let attempt = 0; attempt < MAX_HANDLE_ATTEMPTS; attempt++) {
    const handle = attempt === 0 ? baseHandle : `${baseHandle}${attempt + 1}`
    try {
      // Each attempt runs in its own SAVEPOINT (a nested tx.transaction()): a
      // unique-violation aborts only this savepoint, not the whole outer
      // transaction, so the next discriminator can still be tried.
      const row = await tx.transaction(async (savepointTx) => {
        const [inserted] = await savepointTx
          .insert(agents)
          .values({ ...values, avatarColor, handle })
          .returning()
        return inserted
      })

      if (!row) {
        throw new Error(`createPersonalAgent: insert returned no row for user ${userId}`)
      }
      return row
    } catch (err) {
      // The violated index is matched by BOTH its migrated name and the name
      // postgres regenerates when the parallel-test substrate clones the schema
      // with LIKE ... INCLUDING ALL (unique-violation.ts). Matching only the
      // migrated name made every collision on a worker schema (Playwright,
      // e2e-parallel) escape this retry as a raw 500.
      if (isUniqueViolationOn(err, AGENT_HANDLE_UNIQUE_INDEX)) {
        log.warn(
          { orgId, userId, handle, attempt },
          "createPersonalAgent: handle collision, trying next discriminator",
        )
        lastCollisionErr = err
        continue
      }
      throw err
    }
  }

  // Exhausted every discriminator (practically: 50+ users sharing a base handle
  // in one org). Rethrow the REAL underlying postgres error rather than masking
  // it behind a synthetic message, so a caller's own error handling (e.g. a
  // constraint-name-scoped catch) still sees the true 23505/constraint.
  throw lastCollisionErr
}

/**
 * Resolve the owning agent for a skill/routine created (or run-as) by `userId`:
 * their existing personal agent, or one created on demand when the user's
 * bootstrap/invite flow has not produced one yet (e.g. a legacy or
 * test-seeded user). Select-then-insert rather than `onConflictDoNothing`
 * (no unique index on `(orgId, ownerUserId, kind)` exists), so a concurrent
 * double-call from the same user is a narrow, accepted race — exactly the
 * shape `createPersonalAgent` already has at signup.
 */
export async function getOrCreatePersonalAgentId(
  tx: PrivilegedDb,
  { orgId, userId }: { orgId: string; userId: string },
): Promise<string> {
  const [existing] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.ownerUserId, userId), eq(agents.kind, "personal")),
    )
    .limit(1)
  if (existing) return existing.id

  const [user] = await tx
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
    .limit(1)
  if (!user) {
    throw new Error(`getOrCreatePersonalAgentId: user ${userId} not found in org ${orgId}`)
  }

  const created = await createPersonalAgent(tx, {
    orgId,
    userId,
    email: user.email,
    firstName: user.name ?? null,
  })
  return created.id
}

/**
 * Recompute a user's personal agent `scopeCeiling` from their current resolved
 * grants. Call this, in the same transaction, after any grant/revoke that
 * changes what a user can do, so the ceiling never goes stale (mirrors
 * routine-worker.ts's "re-derive every tick" principle, applied to a ceiling
 * recompute instead of a routine pause).
 *
 * Accepts `RlsClient` (the type every grant-mutation service already
 * receives) rather than `PrivilegedDb`, so it re-runs `loadEffectivePermissions`'s
 * query shape directly instead of calling that function (which is typed to a
 * `PrivilegedDb` tx and is not structurally assignable from an `RlsClient`).
 *
 * The reads run on the caller's RLS connection (same org-scoped grant tables
 * the mutation the caller just made already touched), but the `UPDATE` runs
 * on a PRIVILEGED connection: migration 0052's `agents_update` policy only
 * lets an `agents_update` actor touch a `kind='personal'` row when they are
 * its `owner_user_id` or hold `kernel:agents:admin`/`*` — an admin granting
 * or revoking a scope for a TEAMMATE (the normal case) holds neither, so on
 * the RLS connection this `UPDATE` matched 0 rows every time and the
 * teammate's ceiling silently went stale. The privileged connection is the
 * documented nested-short-write pattern already used inside an interactive
 * RLS transaction elsewhere (see `db/privileged.ts`'s BL-131 note).
 *
 * A user with no personal agent yet (rare; non-bootstrap/invite creation
 * paths) still yields a harmless 0-row `UPDATE`, logged so it is visible
 * rather than silently equivalent to the authorization-blocked case above.
 */
export async function recomputePersonalAgentCeiling(
  db: RlsClient,
  { userId, orgId }: { userId: string; orgId: string },
): Promise<void> {
  const roleAssignments = await db
    .select()
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.orgId, orgId)))
  const roleIds = roleAssignments.map((r) => r.roleId)

  const roleScopes = roleIds.length
    ? await db.select().from(roleScopeGrants).where(inArray(roleScopeGrants.roleId, roleIds))
    : []

  const directScopes = await db
    .select()
    .from(userScopeGrants)
    .where(and(eq(userScopeGrants.userId, userId), eq(userScopeGrants.orgId, orgId)))

  const { scopes: granted } = computeEffectivePermissions({
    roleIds,
    roleScopeGrants: roleScopes,
    userScopeGrants: directScopes,
    roleDimensionGrants: [],
    userDimensionGrants: [],
  })

  const updated = await withPrivilegedDb(orgId, "recompute-personal-agent-ceiling", async (tx) => {
    // A restricted app the owner may not use is not in their agent's ceiling
    // either (S20): the same rule as loadEffectivePermissions.
    // The scopes every member holds (manifest `everyMemberScopes`) and the
    // restriction rule: the same resolution as loadEffectivePermissions.
    const withEveryMember = computeEffectivePermissions({
      roleIds,
      roleScopeGrants: [
        ...(await everyMemberScopeGrants(tx, userId, orgId)),
        ...(await mcpServerAccessGrants(tx, { userId, orgId, roleIds })),
      ],
      userScopeGrants: granted.map((scope) => ({ scope })),
      roleDimensionGrants: [],
      userDimensionGrants: [],
    }).scopes
    const denied = await restrictedAppsDeniedTo(tx, {
      orgId,
      userId,
      roleIds,
      scopes: withEveryMember,
    })
    const scopes = dropAppScopes(withEveryMember, denied)
    return writePersonalCeilings(tx, { orgId, userId, ownerScopes: scopes })
  })

  if (updated.length === 0) {
    log.warn({ userId, orgId }, "recomputePersonalAgentCeiling: no personal agent row to update")
  }
}

/**
 * Re-derive one person's personal agent ceiling from their current grants,
 * inside the caller's privileged transaction (so it sees grants that
 * transaction just wrote). The same resolution as `createPersonalAgent`:
 * `loadEffectivePermissions`, which already applies the every-member scopes,
 * MCP server access and the restricted-app rule. Never wider than the person:
 * the ceiling IS their effective scope set. Returns the rows it updated (0 when
 * the person has no personal agent).
 */
export async function refreshPersonalAgentCeiling(
  tx: PrivilegedDb,
  { orgId, userId }: { orgId: string; userId: string },
): Promise<number> {
  const { scopes } = await loadEffectivePermissions(tx, userId, orgId)
  return (await writePersonalCeilings(tx, { orgId, userId, ownerScopes: scopes })).length
}

/**
 * Write each of `userId`'s personal agents' ceiling from the owner's scopes
 * and that agent's own restriction (`personalCeiling`). Per row, because the
 * restriction is per agent; a row whose ceiling already matches is left alone.
 */
async function writePersonalCeilings(
  tx: PrivilegedDb,
  { orgId, userId, ownerScopes }: { orgId: string; userId: string; ownerScopes: string[] },
): Promise<Array<{ id: string }>> {
  const rows = await tx
    .select({
      id: agents.id,
      scopeCeiling: agents.scopeCeiling,
      ceilingRestriction: agents.ceilingRestriction,
    })
    .from(agents)
    .where(
      and(eq(agents.orgId, orgId), eq(agents.ownerUserId, userId), eq(agents.kind, "personal")),
    )
  const updated: Array<{ id: string }> = []
  for (const row of rows) {
    const ceiling = personalCeiling(ownerScopes, row.ceilingRestriction)
    const same =
      ceiling.length === row.scopeCeiling.length &&
      ceiling.every((s) => row.scopeCeiling.includes(s))
    if (same) {
      updated.push({ id: row.id })
      continue
    }
    await tx
      .update(agents)
      .set({ scopeCeiling: ceiling, updatedAt: drizzleSql`now()` })
      .where(eq(agents.id, row.id))
    updated.push({ id: row.id })
  }
  return updated
}

/** The kernel permission events (`event-bus.ts`) that change someone's grants. */
const CEILING_PERMISSION_ENTITIES = new Set([
  "role_assignment",
  "user_scope",
  "role_scope",
  "role_dimension",
  "user_dimension",
])

/**
 * Keep every personal agent ceiling in step with its owner's grants, from the
 * permission event every grant change already queues in its own transaction
 * (the carrier live sessions are invalidated by). A ceiling written once at
 * signup and recomputed only by some mutation paths went stale on the others:
 * a role an app registration extended ("Full Member"), a role a config apply
 * assigned to an existing person, an app's per-user grants. The person then
 * held the scopes and their own agent did not, so it had no tools at all.
 *
 * Targets come from the event exactly as the session invalidation reads them:
 * `data.targetUserId`, `data.targetUserIds`, or the current members of
 * `data.roleId`. Idempotent (a recompute from current grants), so a
 * re-delivered event or a path that already recomputed changes nothing.
 */
export async function syncPersonalAgentCeilingsForEvent(event: {
  app?: string
  entity?: string
  orgId?: string
  data?: unknown
}): Promise<number> {
  if (event.app !== "kernel" || !event.entity || !CEILING_PERMISSION_ENTITIES.has(event.entity)) {
    return 0
  }
  const orgId = event.orgId
  if (!orgId) return 0
  const data = (event.data ?? {}) as {
    targetUserId?: unknown
    targetUserIds?: unknown
    roleId?: unknown
  }
  return withPrivilegedDb(orgId, "sync-personal-agent-ceilings", async (tx) => {
    let userIds: string[] = []
    if (typeof data.targetUserId === "string" && data.targetUserId.length > 0) {
      userIds = [data.targetUserId]
    } else if (Array.isArray(data.targetUserIds)) {
      userIds = data.targetUserIds.filter((id): id is string => typeof id === "string")
    } else if (typeof data.roleId === "string" && data.roleId.length > 0) {
      const rows = await tx
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(and(eq(userRoles.roleId, data.roleId), eq(userRoles.orgId, orgId)))
      userIds = rows.map((r) => r.userId)
    }
    let updated = 0
    for (const userId of new Set(userIds)) {
      updated += await refreshPersonalAgentCeiling(tx, { orgId, userId })
    }
    return updated
  })
}
