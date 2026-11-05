// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import type { RlsClient, RlsTx } from "~/db"
import {
  roleDimensionGrants,
  roleScopeGrants,
  roles,
  userDimensionGrants,
  userRoles,
  userScopeGrants,
  users,
} from "~/db/schema/kernel"
import { recomputePersonalAgentCeiling } from "~/modules/agent/directory/personal-agent"
import { dimensionDefRegistry } from "~/modules/apps/app-registries"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { hasScope } from "~/modules/permissions/permissions"
import type { PermissionMutationContext } from "~/modules/permissions/types"

function resolveDimensionKey(
  orgId: string,
  dimensionKey: string,
): { app: string; key: string; fullKey: string; type: string; values?: string[] } | undefined {
  for (const [[defOrgId, app, key], def] of dimensionDefRegistry.entries()) {
    if (defOrgId !== orgId && defOrgId !== "*") continue
    const fullKey = `${app}:${key}`
    if (dimensionKey === fullKey || dimensionKey === key) {
      return { app, key, fullKey, ...def }
    }
  }
  return undefined
}

function canonicalDimensionKey(orgId: string, dimensionKey: string): string {
  const def = resolveDimensionKey(orgId, dimensionKey)
  if (!def) throw new HTTPException(400, { message: `Unknown dimension: ${dimensionKey}` })
  return def.fullKey
}

/** Validate that provided dimension values are valid for the dimension's type. */
function validateDimensionValues(orgId: string, dimensionKey: string, values: string[]): void {
  const def = resolveDimensionKey(orgId, dimensionKey)
  if (def?.type === "enum" && def.values) {
    const invalid = values.filter((v) => v !== "*" && !def.values!.includes(v))
    if (invalid.length > 0) {
      throw new HTTPException(400, {
        message: `Invalid values for enum dimension: ${invalid.join(", ")}`,
      })
    }
  }
}

/** Bump permissionVersion for all users assigned to a given role. */
async function bumpRoleUsersPermissionVersion(
  db: RlsClient,
  roleId: string,
  orgId: string,
): Promise<void> {
  const assignedUserIds = db
    .select({ id: userRoles.userId })
    .from(userRoles)
    .where(and(eq(userRoles.roleId, roleId), eq(userRoles.orgId, orgId)))
  const bumped = await db
    .update(users)
    .set({ permissionVersion: drizzleSql`permission_version + 1` })
    .where(and(eq(users.orgId, orgId), inArray(users.id, assignedUserIds)))
    .returning({ id: users.id })
  for (const { id } of bumped) invalidateAuthCache(id)
}

/** Bump permissionVersion for a single user. */
async function bumpUserPermissionVersion(
  db: RlsClient,
  userId: string,
  orgId: string,
): Promise<void> {
  await db
    .update(users)
    .set({ permissionVersion: drizzleSql`permission_version + 1` })
    .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
  invalidateAuthCache(userId)
}

/**
 * Recompute every user-holding-this-role's personal agent ceiling (P1a-T19).
 * A role-level scope grant/revoke changes what EVERY member currently
 * assigned to that role effectively holds, so — unlike a per-user
 * grantUserScope/revokeUserScope, which recomputes one ceiling — this must
 * walk the whole roster. Mirrors bumpRoleUsersPermissionVersion's own
 * roster query right above it.
 */
async function recomputePersonalAgentCeilingsForRole(
  db: RlsClient,
  roleId: string,
  orgId: string,
): Promise<void> {
  const assignedUsers = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(and(eq(userRoles.roleId, roleId), eq(userRoles.orgId, orgId)))
  for (const { userId } of assignedUsers) {
    await recomputePersonalAgentCeiling(db, { userId, orgId })
  }
}

/**
 * Detailed role data for the admin role-detail page.
 * Returns scopes (with grant timestamp), dimension grants, and assigned members.
 */
export async function getRoleDetail(db: RlsClient, params: { orgId: string; roleId: string }) {
  const { orgId, roleId } = params
  const [role] = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      createdAt: roles.createdAt,
      updatedAt: roles.updatedAt,
    })
    .from(roles)
    .where(and(eq(roles.id, roleId), eq(roles.orgId, orgId)))
    .limit(1)
  if (!role) return null

  const scopes = await db
    .select({
      scope: roleScopeGrants.scope,
    })
    .from(roleScopeGrants)
    .where(eq(roleScopeGrants.roleId, roleId))

  const dimensionGrants = await db
    .select({
      dimensionKey: roleDimensionGrants.dimensionKey,
      values: roleDimensionGrants.dimensionValues,
    })
    .from(roleDimensionGrants)
    .where(eq(roleDimensionGrants.roleId, roleId))

  const members = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      status: users.status,
    })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleId, roleId), eq(userRoles.orgId, orgId)))

  const grantedAt = role.createdAt.toISOString()
  return {
    ...role,
    scopes: scopes.map((s) => ({ scope: s.scope, grantedAt })),
    dimensionGrants: dimensionGrants.map((d) => ({
      dimensionKey: d.dimensionKey,
      values: (d.values as string[]) ?? [],
    })),
    members,
  }
}

interface CreateRoleParams {
  orgId: string
  name: string
  description?: string
}

/** `metadata.requestedBy` on a change's event when someone other than the actor asked for it. */
function requestedByMetadata(params: { actorId?: string | null; requestedBy?: string }): {
  metadata?: { requestedBy: string }
} {
  return params.requestedBy && params.requestedBy !== params.actorId
    ? { metadata: { requestedBy: params.requestedBy } }
    : {}
}

export async function createRole(
  db: RlsClient,
  params: CreateRoleParams & {
    actorId?: string
    /** Who asked for it, when that is not the actor (an approved agent request). */
    requestedBy?: string
  },
) {
  const [role] = await db
    .insert(roles)
    .values({ orgId: params.orgId, name: params.name, description: params.description })
    .returning()

  await db.queueEvent({
    app: "kernel",
    entity: "role",
    action: "create",
    entityId: role.id,
    orgId: params.orgId,
    actorId: params.actorId,
    ...requestedByMetadata(params),
    data: { name: role.name, description: role.description },
    ...requestedByMetadata(params),
  })

  return role
}

interface UpdateRoleParams {
  roleId: string
  orgId: string
  name?: string
  description?: string
}

/**
 * Update a role's name and/or description. Scopes are edited separately via
 * grantScope / revokeScope — this only touches the role's own descriptive
 * fields. Returns null when the role does not exist in the caller's org.
 *
 * Renaming a `system_managed` role is refused: the app runtime re-materializes
 * such roles BY NAME (`INSERT ... ON CONFLICT (org_id, name)` in
 * `extendFullMemberRole` / app-role sync), so a rename would orphan the renamed
 * row and let the next app sync recreate a fresh empty one under the old name.
 * Editing a system role's description or its scope grants is still allowed.
 */
export async function updateRole(
  db: RlsClient,
  params: UpdateRoleParams & Omit<PermissionMutationContext, "orgId">,
) {
  const [role] = await db
    .select({
      id: roles.id,
      name: roles.name,
      description: roles.description,
      systemManaged: roles.systemManaged,
    })
    .from(roles)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .limit(1)
  if (!role) return null

  const renaming = params.name !== undefined && params.name !== role.name
  if (renaming && role.systemManaged) {
    throw new HTTPException(400, { message: "Cannot rename a system-managed role" })
  }
  // Roles are found by name (auto-provisioning gives "member"): renaming one is
  // as good as assigning it, so it needs the same authority.
  const covered = await actorCoversRole(
    db,
    params.roleId,
    params.actorScopes,
    params.actorDimensionGrants,
  )
  if (covered !== "ok") {
    throw new HTTPException(403, {
      message: "Cannot change a role that grants more than you hold",
    })
  }

  const patch: { name?: string; description?: string | null; updatedAt: Date } = {
    updatedAt: new Date(),
  }
  if (params.name !== undefined) patch.name = params.name
  if (params.description !== undefined) patch.description = params.description

  const [updated] = await db
    .update(roles)
    .set(patch)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .returning({ id: roles.id, name: roles.name, description: roles.description })

  if (updated) {
    await db.queueEvent({
      app: "kernel",
      entity: "role",
      action: "update",
      entityId: updated.id,
      orgId: params.orgId,
      actorId: params.actorId,
      ...requestedByMetadata(params),
      data: { name: updated.name, description: updated.description },
    })
  }

  return updated ?? null
}

interface DeleteRoleParams {
  roleId: string
  orgId: string
}

export async function deleteRole(
  db: RlsClient,
  params: DeleteRoleParams & Omit<PermissionMutationContext, "orgId">,
) {
  return await db.transaction(async (tx) => {
    const [role] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
      .limit(1)
    if (!role) return null
    const covered = await actorCoversRole(
      tx,
      params.roleId,
      params.actorScopes,
      params.actorDimensionGrants,
    )
    if (covered !== "ok") {
      throw new HTTPException(403, {
        message: "Cannot delete a role that grants more than you hold",
      })
    }
    // Check for active assignments before deleting — inside transaction to prevent TOCTOU race
    const assignments = await tx
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.roleId, params.roleId), eq(userRoles.orgId, params.orgId)))
      .limit(1)
    if (assignments.length > 0) {
      throw new Error("Cannot delete role with active user assignments")
    }

    const [deleted] = await tx
      .delete(roles)
      .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
      .returning({ id: roles.id })

    if (deleted) {
      await tx.queueEvent({
        app: "kernel",
        entity: "role",
        action: "delete",
        entityId: deleted.id,
        orgId: params.orgId,
        actorId: params.actorId,
        ...requestedByMetadata(params),
      })
    }

    return deleted ?? null
  })
}

interface GrantScopeParams {
  roleId: string
  orgId: string
  scope: string
}

export async function grantScope(
  db: RlsClient,
  params: GrantScopeParams & PermissionMutationContext,
) {
  if (!hasScope(params.scope, params.actorScopes)) {
    throw new HTTPException(403, { message: "Cannot grant a scope you do not hold" })
  }

  // Verify role belongs to the caller's org
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .limit(1)
  if (!role) return null

  // ON CONFLICT DO NOTHING, never a caught 23505: a failed statement aborts the
  // caller's whole transaction, so every later statement on it fails with 25P02.
  const [grant] = await db
    .insert(roleScopeGrants)
    .values({ roleId: params.roleId, scope: params.scope })
    .onConflictDoNothing()
    .returning()
  if (!grant) return { added: false }

  await db.queueEvent({
    app: "kernel",
    entity: "role_scope",
    action: "grant",
    entityId: params.roleId,
    orgId: params.orgId,
    actorId: params.actorId,
    ...requestedByMetadata(params),
    data: { roleId: params.roleId, scope: params.scope },
  })

  await bumpRoleUsersPermissionVersion(db, params.roleId, params.orgId)
  await recomputePersonalAgentCeilingsForRole(db, params.roleId, params.orgId)

  return grant
}

interface RevokeScopeParams {
  roleId: string
  orgId: string
  scope: string
}

/**
 * Grant several scopes to one role at once: the same checks as `grantScope`
 * for each scope, ONE `role_scope` grant event naming every scope added
 * (`scopesAdded`, the shape app registration already emits), and the role's
 * users' permission version and agent ceilings recomputed once. Provisioning
 * a role scope by scope emitted an event per scope, and every api and worker
 * process answers each one with a member lookup and socket refresh: seeding
 * one demo workspace queued about 270 of them.
 */
export async function grantRoleScopes(
  db: RlsClient,
  params: { roleId: string; orgId: string; scopes: readonly string[] } & PermissionMutationContext,
): Promise<{ added: string[] } | null> {
  for (const scope of params.scopes) {
    if (!hasScope(scope, params.actorScopes)) {
      throw new HTTPException(403, { message: "Cannot grant a scope you do not hold" })
    }
  }
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .limit(1)
  if (!role) return null
  const wanted = [...new Set(params.scopes)]
  if (wanted.length === 0) return { added: [] }

  // ON CONFLICT DO NOTHING (never a caught 23505), as in grantScope.
  const inserted = await db
    .insert(roleScopeGrants)
    .values(wanted.map((scope) => ({ roleId: params.roleId, scope })))
    .onConflictDoNothing()
    .returning({ scope: roleScopeGrants.scope })
  const added = inserted.map((row) => row.scope)
  if (added.length === 0) return { added }

  await db.queueEvent({
    app: "kernel",
    entity: "role_scope",
    action: "grant",
    entityId: params.roleId,
    orgId: params.orgId,
    actorId: params.actorId,
    ...requestedByMetadata(params),
    data: { roleId: params.roleId, scopesAdded: added },
  })

  await bumpRoleUsersPermissionVersion(db, params.roleId, params.orgId)
  await recomputePersonalAgentCeilingsForRole(db, params.roleId, params.orgId)

  return { added }
}

export async function revokeScope(
  db: RlsClient,
  params: RevokeScopeParams & PermissionMutationContext,
) {
  // Symmetric authorization: actor must hold the scope they are revoking
  if (!hasScope(params.scope, params.actorScopes)) {
    throw new HTTPException(403, { message: "Cannot revoke a scope you do not hold" })
  }

  // Verify role belongs to the caller's org
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .limit(1)
  if (!role) return null

  const [deleted] = await db
    .delete(roleScopeGrants)
    .where(and(eq(roleScopeGrants.roleId, params.roleId), eq(roleScopeGrants.scope, params.scope)))
    .returning({ id: roleScopeGrants.id })

  if (deleted) {
    await db.queueEvent({
      app: "kernel",
      entity: "role_scope",
      action: "revoke",
      entityId: params.roleId,
      orgId: params.orgId,
      actorId: params.actorId,
      ...requestedByMetadata(params),
      data: { roleId: params.roleId, scope: params.scope },
    })
    await bumpRoleUsersPermissionVersion(db, params.roleId, params.orgId)
    await recomputePersonalAgentCeilingsForRole(db, params.roleId, params.orgId)
  }

  return deleted ?? null
}

/**
 * The dimension values the ACTOR holds, as the runtime reads them
 * (`matchesDimensions`): no entry for the dimension is no access, not
 * "unrestricted". "all" means a wildcard value on that dimension or the global
 * `{ "*": ["*"] }` grant a `*`-scoped actor carries.
 */
function actorDimensionValues(
  grants: Readonly<Record<string, readonly string[]>>,
  dimension: string,
  rawDimension?: string,
): readonly string[] | "all" {
  if ((grants["*"] ?? []).includes("*")) return "all"
  const values = grants[dimension] ?? (rawDimension ? grants[rawDimension] : undefined) ?? []
  return values.includes("*") ? "all" : values
}

interface GrantDimensionParams {
  roleId: string
  orgId: string
  dimension: string
  values: string[]
}

export async function grantDimension(
  db: RlsClient,
  params: GrantDimensionParams & PermissionMutationContext,
) {
  // Wildcard dimension can only be set at bootstrap — prevent API-level grant escalation
  if (params.dimension === "*") {
    throw new HTTPException(400, { message: "Wildcard dimension cannot be granted via API" })
  }
  const dimension = canonicalDimensionKey(params.orgId, params.dimension)

  // Validate values against dimension type
  validateDimensionValues(params.orgId, dimension, params.values)

  // Dimension escalation check: actor cannot grant values they don't hold
  const actorValues = actorDimensionValues(params.actorDimensionGrants, dimension, params.dimension)
  if (actorValues !== "all") {
    const unauthorized = params.values.filter((v) => !actorValues.includes(v))
    if (unauthorized.length > 0) {
      throw new HTTPException(403, {
        message: `Cannot grant dimension values you do not hold: ${unauthorized.join(", ")}`,
      })
    }
  }

  // Verify role belongs to the caller's org
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .limit(1)
  if (!role) return null

  const [grant] = await db
    .insert(roleDimensionGrants)
    .values({
      roleId: params.roleId,
      dimensionKey: dimension,
      dimensionValues: params.values,
    })
    .onConflictDoUpdate({
      target: [roleDimensionGrants.roleId, roleDimensionGrants.dimensionKey],
      set: { dimensionValues: params.values },
    })
    .returning()

  await db.queueEvent({
    app: "kernel",
    entity: "role_dimension",
    action: "grant",
    entityId: params.roleId,
    orgId: params.orgId,
    actorId: params.actorId,
    ...requestedByMetadata(params),
    data: { roleId: params.roleId, dimension, values: params.values },
  })

  await bumpRoleUsersPermissionVersion(db, params.roleId, params.orgId)

  return grant
}

/**
 * Returns true when the actor's own dimension grants cover every value the role
 * grants. A wildcard (`*`) actor grant — or the actor having no restriction for
 * a dimension — covers everything. Mirrors grantDimension's value-subset guard
 * so role assignment cannot be used to back-door dimension values the actor does
 * not hold.
 */
export async function actorCoversRoleDimensions(
  db: Pick<RlsTx, "select">,
  roleId: string,
  actorDimensionGrants: Readonly<Record<string, readonly string[]>>,
): Promise<boolean> {
  const grants = await db
    .select({
      dimensionKey: roleDimensionGrants.dimensionKey,
      values: roleDimensionGrants.dimensionValues,
    })
    .from(roleDimensionGrants)
    .where(eq(roleDimensionGrants.roleId, roleId))

  for (const grant of grants) {
    // No grant for this dimension means NO access at runtime (matchesDimensions
    // denies), so it is an empty grant here, never "unrestricted".
    const actorValues = actorDimensionValues(actorDimensionGrants, grant.dimensionKey)
    if (actorValues === "all") continue
    const roleValues = (grant.values as string[]) ?? []
    const uncovered = roleValues.filter((v) => v !== "*" && !actorValues.includes(v))
    // A role granting "*" on a dimension the actor holds only specific values
    // for is also an escalation.
    if (uncovered.length > 0 || roleValues.includes("*")) return false
  }
  return true
}

/**
 * Does the actor hold everything this role confers: every scope it grants and
 * every dimension value? The one authority rule for acting on a role as a
 * whole (assigning it, renaming it, deleting it): a role is referred to by its
 * NAME elsewhere (auto-provisioned sign-ins take "member", an invitation may
 * name its role), so whoever may rename or remove a role must already be able
 * to hand out what it grants.
 */
export async function actorCoversRole(
  db: Pick<RlsTx, "select">,
  roleId: string,
  actorScopes: readonly string[],
  actorDimensionGrants: Readonly<Record<string, readonly string[]>>,
): Promise<"ok" | "SCOPE_ESCALATION" | "DIMENSION_ESCALATION"> {
  if (!hasScope("*", [...actorScopes])) {
    const targetScopes = await db
      .select({ scope: roleScopeGrants.scope })
      .from(roleScopeGrants)
      .where(eq(roleScopeGrants.roleId, roleId))
    for (const { scope } of targetScopes) {
      if (!hasScope(scope, [...actorScopes])) return "SCOPE_ESCALATION"
    }
  }
  if (!(await actorCoversRoleDimensions(db, roleId, actorDimensionGrants))) {
    return "DIMENSION_ESCALATION"
  }
  return "ok"
}

interface AssignRoleParams {
  userId: string
  roleId: string
  orgId: string
}

export async function assignRole(
  db: RlsClient,
  params: AssignRoleParams & PermissionMutationContext,
) {
  // Verify role belongs to the org
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .limit(1)
  if (!role) return null

  // Scope-escalation check: actor must hold every scope granted by the target role.
  // Prevents privilege escalation (e.g., admin assigning a role with scopes they don't hold).
  // Same guard as createInvitation in invites.ts.
  if (!hasScope("*", params.actorScopes)) {
    const targetScopes = await db
      .select({ scope: roleScopeGrants.scope })
      .from(roleScopeGrants)
      .where(eq(roleScopeGrants.roleId, params.roleId))
    for (const { scope } of targetScopes) {
      if (!hasScope(scope, params.actorScopes)) {
        return { error: "SCOPE_ESCALATION" as const }
      }
    }
  }

  // Dimension-escalation check: the role's dimension grants must be covered by
  // the actor's own dimension grants (mirrors grantDimension). Holding wildcard
  // scopes does not imply holding all dimension values, so this is independent
  // of the scope check above.
  if (!(await actorCoversRoleDimensions(db, params.roleId, params.actorDimensionGrants))) {
    return { error: "DIMENSION_ESCALATION" as const }
  }

  // Verify target user belongs to the same org
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)))
    .limit(1)
  if (!user) return null

  // ON CONFLICT DO NOTHING, never a caught 23505: a failed statement aborts the
  // caller's whole transaction, so every later statement on it fails with 25P02.
  const inserted = await db
    .insert(userRoles)
    .values({ userId: params.userId, roleId: params.roleId, orgId: params.orgId })
    .onConflictDoNothing()
    .returning({ userId: userRoles.userId })
  if (inserted.length === 0) return { assigned: false }

  await db.queueEvent({
    app: "kernel",
    entity: "role_assignment",
    action: "assign",
    entityId: params.roleId,
    orgId: params.orgId,
    actorId: params.actorId,
    ...requestedByMetadata(params),
    data: { targetUserId: params.userId, roleId: params.roleId },
  })

  await bumpUserPermissionVersion(db, params.userId, params.orgId)
  await recomputePersonalAgentCeiling(db, { userId: params.userId, orgId: params.orgId })

  return { assigned: true }
}

interface UnassignRoleParams {
  userId: string
  roleId: string
  orgId: string
}

export async function unassignRole(
  db: RlsClient,
  params: UnassignRoleParams & PermissionMutationContext,
) {
  // Symmetric authorization: actor must hold all scopes granted by the role they are unassigning
  if (!hasScope("*", params.actorScopes)) {
    const targetScopes = await db
      .select({ scope: roleScopeGrants.scope })
      .from(roleScopeGrants)
      .where(eq(roleScopeGrants.roleId, params.roleId))
    for (const { scope } of targetScopes) {
      if (!hasScope(scope, params.actorScopes)) {
        return { error: "SCOPE_ESCALATION" as const }
      }
    }
  }

  // Symmetric dimension authorization: actor must cover the role's dimension
  // grants to unassign it (mirrors assignRole and revokeDimension).
  if (!(await actorCoversRoleDimensions(db, params.roleId, params.actorDimensionGrants))) {
    return { error: "DIMENSION_ESCALATION" as const }
  }

  const [deleted] = await db
    .delete(userRoles)
    .where(
      and(
        eq(userRoles.userId, params.userId),
        eq(userRoles.roleId, params.roleId),
        eq(userRoles.orgId, params.orgId),
      ),
    )
    .returning({ userId: userRoles.userId })

  if (deleted) {
    await db.queueEvent({
      app: "kernel",
      entity: "role_assignment",
      action: "unassign",
      entityId: params.roleId,
      orgId: params.orgId,
      actorId: params.actorId,
      ...requestedByMetadata(params),
      data: { targetUserId: params.userId, roleId: params.roleId },
    })
    await bumpUserPermissionVersion(db, params.userId, params.orgId)
    await recomputePersonalAgentCeiling(db, { userId: params.userId, orgId: params.orgId })
  }

  return deleted ?? null
}

interface RevokeDimensionParams {
  roleId: string
  orgId: string
  dimension: string
}

export async function revokeDimension(
  db: RlsClient,
  params: RevokeDimensionParams & PermissionMutationContext,
) {
  const dimension = canonicalDimensionKey(params.orgId, params.dimension)
  // Symmetric authorization: actor must hold all values currently granted for this dimension.
  // Revoking removes the entire dimension grant, so the actor needs authority over ALL values.
  const actorValues = actorDimensionValues(params.actorDimensionGrants, dimension, params.dimension)
  if (actorValues !== "all") {
    const [currentGrant] = await db
      .select({ values: roleDimensionGrants.dimensionValues })
      .from(roleDimensionGrants)
      .where(
        and(
          eq(roleDimensionGrants.roleId, params.roleId),
          eq(roleDimensionGrants.dimensionKey, dimension),
        ),
      )
      .limit(1)
    if (currentGrant) {
      const unauthorized = (currentGrant.values as string[]).filter(
        (v: string) => !actorValues.includes(v),
      )
      if (unauthorized.length > 0) {
        throw new HTTPException(403, {
          message: `Cannot revoke dimension values you do not hold: ${unauthorized.join(", ")}`,
        })
      }
    }
  }

  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.id, params.roleId), eq(roles.orgId, params.orgId)))
    .limit(1)
  if (!role) return null

  const [deleted] = await db
    .delete(roleDimensionGrants)
    .where(
      and(
        eq(roleDimensionGrants.roleId, params.roleId),
        eq(roleDimensionGrants.dimensionKey, dimension),
      ),
    )
    .returning({ id: roleDimensionGrants.id })

  if (deleted) {
    await db.queueEvent({
      app: "kernel",
      entity: "role_dimension",
      action: "revoke",
      entityId: params.roleId,
      orgId: params.orgId,
      actorId: params.actorId,
      ...requestedByMetadata(params),
      data: { roleId: params.roleId, dimension },
    })
    await bumpRoleUsersPermissionVersion(db, params.roleId, params.orgId)
  }

  return deleted ?? null
}

interface UserGrantParams {
  userId: string
  orgId: string
}

export async function grantUserScope(
  db: RlsClient,
  params: UserGrantParams & { scope: string } & PermissionMutationContext,
) {
  if (!hasScope(params.scope, params.actorScopes)) {
    throw new HTTPException(403, { message: "Cannot grant a scope you do not hold" })
  }

  // Verify target user belongs to the org
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)))
    .limit(1)
  if (!user) return null

  // ON CONFLICT DO NOTHING, never a caught 23505: callers run this inside their
  // own transaction (a scope request approval updates its row right after), and
  // a failed INSERT would abort that transaction for every later statement.
  const [grant] = await db
    .insert(userScopeGrants)
    .values({ userId: params.userId, orgId: params.orgId, scope: params.scope })
    .onConflictDoNothing()
    .returning()
  if (!grant) return { added: false }

  await db.queueEvent({
    app: "kernel",
    entity: "user_scope",
    action: "grant",
    entityId: params.userId,
    orgId: params.orgId,
    actorId: params.actorId,
    ...requestedByMetadata(params),
    data: { targetUserId: params.userId, scope: params.scope },
  })

  await bumpUserPermissionVersion(db, params.userId, params.orgId)
  await recomputePersonalAgentCeiling(db, { userId: params.userId, orgId: params.orgId })

  return grant
}

export async function revokeUserScope(
  db: RlsClient,
  params: UserGrantParams & { scope: string } & PermissionMutationContext,
) {
  // Symmetric authorization: actor must hold the scope they are revoking
  if (!hasScope(params.scope, params.actorScopes)) {
    throw new HTTPException(403, { message: "Cannot revoke a scope you do not hold" })
  }
  const [deleted] = await db
    .delete(userScopeGrants)
    .where(
      and(
        eq(userScopeGrants.userId, params.userId),
        eq(userScopeGrants.orgId, params.orgId),
        eq(userScopeGrants.scope, params.scope),
      ),
    )
    .returning({ id: userScopeGrants.id })

  if (deleted) {
    await db.queueEvent({
      app: "kernel",
      entity: "user_scope",
      action: "revoke",
      entityId: params.userId,
      orgId: params.orgId,
      actorId: params.actorId,
      ...requestedByMetadata(params),
      data: { targetUserId: params.userId, scope: params.scope },
    })
    await bumpUserPermissionVersion(db, params.userId, params.orgId)
    await recomputePersonalAgentCeiling(db, { userId: params.userId, orgId: params.orgId })
  }

  return deleted ?? null
}

export async function grantUserDimension(
  db: RlsClient,
  params: UserGrantParams & { dimension: string; values: string[] } & PermissionMutationContext,
) {
  // Wildcard dimension can only be set at bootstrap — prevent API-level grant escalation
  if (params.dimension === "*") {
    throw new HTTPException(400, { message: "Wildcard dimension cannot be granted via API" })
  }
  const dimension = canonicalDimensionKey(params.orgId, params.dimension)

  // Validate values against dimension type
  validateDimensionValues(params.orgId, dimension, params.values)

  // Dimension escalation check: actor cannot grant values they don't hold
  const actorValues = actorDimensionValues(params.actorDimensionGrants, dimension, params.dimension)
  if (actorValues !== "all") {
    const unauthorized = params.values.filter((v) => !actorValues.includes(v))
    if (unauthorized.length > 0) {
      throw new HTTPException(403, {
        message: `Cannot grant dimension values you do not hold: ${unauthorized.join(", ")}`,
      })
    }
  }

  // Verify target user belongs to the org
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, params.userId), eq(users.orgId, params.orgId)))
    .limit(1)
  if (!user) return null

  const [grant] = await db
    .insert(userDimensionGrants)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      dimensionKey: dimension,
      dimensionValues: params.values,
    })
    .onConflictDoUpdate({
      target: [
        userDimensionGrants.userId,
        userDimensionGrants.orgId,
        userDimensionGrants.dimensionKey,
      ],
      set: { dimensionValues: params.values },
    })
    .returning()

  await db.queueEvent({
    app: "kernel",
    entity: "user_dimension",
    action: "grant",
    entityId: params.userId,
    orgId: params.orgId,
    actorId: params.actorId,
    ...requestedByMetadata(params),
    data: { targetUserId: params.userId, dimension, values: params.values },
  })

  await bumpUserPermissionVersion(db, params.userId, params.orgId)

  return grant
}

export async function revokeUserDimension(
  db: RlsClient,
  params: UserGrantParams & { dimension: string } & PermissionMutationContext,
) {
  const dimension = canonicalDimensionKey(params.orgId, params.dimension)
  // Symmetric authorization: actor must hold all values currently granted for this dimension
  const actorValues = actorDimensionValues(params.actorDimensionGrants, dimension, params.dimension)
  if (actorValues !== "all") {
    const [currentGrant] = await db
      .select({ values: userDimensionGrants.dimensionValues })
      .from(userDimensionGrants)
      .where(
        and(
          eq(userDimensionGrants.userId, params.userId),
          eq(userDimensionGrants.orgId, params.orgId),
          eq(userDimensionGrants.dimensionKey, dimension),
        ),
      )
      .limit(1)
    if (currentGrant) {
      const unauthorized = (currentGrant.values as string[]).filter(
        (v: string) => !actorValues.includes(v),
      )
      if (unauthorized.length > 0) {
        throw new HTTPException(403, {
          message: `Cannot revoke dimension values you do not hold: ${unauthorized.join(", ")}`,
        })
      }
    }
  }

  const [deleted] = await db
    .delete(userDimensionGrants)
    .where(
      and(
        eq(userDimensionGrants.userId, params.userId),
        eq(userDimensionGrants.orgId, params.orgId),
        eq(userDimensionGrants.dimensionKey, dimension),
      ),
    )
    .returning({ id: userDimensionGrants.id })

  if (deleted) {
    await db.queueEvent({
      app: "kernel",
      entity: "user_dimension",
      action: "revoke",
      entityId: params.userId,
      orgId: params.orgId,
      actorId: params.actorId,
      ...requestedByMetadata(params),
      data: { targetUserId: params.userId, dimension },
    })
    await bumpUserPermissionVersion(db, params.userId, params.orgId)
  }

  return deleted ?? null
}

export interface RoleListItem {
  id: string
  name: string
  description: string | null
  memberCount: number
  scopeCount: number
}

/**
 * List org roles with their member + scope-grant counts. Extracted verbatim
 * from the inline `adminRoles.get("/")` member-count join (roles-routes.ts) so
 * both the admin REST route and the `roles_list` kernel agent tool share one
 * implementation. RLS-bound — `db` must be the caller's RLS client.
 */
export async function listRoles(
  db: RlsClient,
  orgId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<RoleListItem[]> {
  const limit = Math.min(opts.limit ?? 100, 500)
  const offset = opts.offset ?? 0
  const base = await db
    .select({ id: roles.id, name: roles.name, description: roles.description })
    .from(roles)
    .where(eq(roles.orgId, orgId))
    .orderBy(roles.name)
    .limit(limit)
    .offset(offset)
  if (base.length === 0) return []
  const ids = base.map((r) => r.id)
  const memberCounts = await db
    .select({ roleId: userRoles.roleId, count: drizzleSql<number>`COUNT(*)::int` })
    .from(userRoles)
    .where(and(eq(userRoles.orgId, orgId), inArray(userRoles.roleId, ids)))
    .groupBy(userRoles.roleId)
  const scopeCounts = await db
    .select({ roleId: roleScopeGrants.roleId, count: drizzleSql<number>`COUNT(*)::int` })
    .from(roleScopeGrants)
    .where(inArray(roleScopeGrants.roleId, ids))
    .groupBy(roleScopeGrants.roleId)
  const memberMap = new Map(memberCounts.map((r) => [r.roleId, r.count]))
  const scopeMap = new Map(scopeCounts.map((r) => [r.roleId, r.count]))
  return base.map((r) => ({
    ...r,
    memberCount: memberMap.get(r.id) ?? 0,
    scopeCount: scopeMap.get(r.id) ?? 0,
  }))
}
