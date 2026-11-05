// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Roles made for a test: a new role carrying exactly these scopes and
// dimension grants, and its assignment to a person. Written as the org's admin
// through the role editor's own services (`createRole`, `grantRoleScopes`,
// `grantDimension`, `assignRole`), which refuse what the admin could not grant
// and bump the person's permission version.
import { withRlsContext } from "~/db/rls"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import {
  assignRole,
  createRole,
  grantDimension,
  grantRoleScopes,
} from "~/modules/permissions/roles"
import { createScope } from "~/modules/permissions/types"

type RoleTx = Parameters<typeof createRole>[0]

/** Run `fn` as the org's admin with the role editor's mutation context. */
export function asAdmin<T>(
  orgId: string,
  adminUserId: string,
  fn: (
    tx: RoleTx,
    actor: {
      actorId: string
      actorScopes: ReturnType<typeof createScope>[]
      actorDimensionGrants: Record<string, string[]>
      orgId: string
    },
  ) => Promise<T>,
): Promise<T> {
  const actor = {
    actorId: adminUserId,
    actorScopes: [createScope("*")],
    actorDimensionGrants: { "*": ["*"] },
    orgId,
  }
  return withRlsContext(
    {
      actorType: "user",
      userId: adminUserId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    },
    (tx) => fn(tx as never, actor),
  )
}

/** A new role with exactly these scopes and dimension grants. */
export async function createRoleWithGrants(
  orgId: string,
  input: {
    adminUserId: string
    /** The role's name; unique within the org. */
    name: string
    description?: string
    scopes: readonly string[]
    dimensions: Readonly<Record<string, readonly string[]>>
  },
): Promise<{ roleId: string }> {
  const roleId = await asAdmin(orgId, input.adminUserId, async (tx, actor) => {
    const role = await createRole(tx, {
      orgId,
      name: input.name,
      description: input.description ?? "Seeded role",
      actorId: input.adminUserId,
    })
    if (input.scopes.length > 0) {
      await grantRoleScopes(tx, { roleId: role.id, scopes: input.scopes, ...actor })
    }
    for (const [dimension, values] of Object.entries(input.dimensions)) {
      await grantDimension(tx, { roleId: role.id, dimension, values: [...values], ...actor })
    }
    return role.id
  })
  return { roleId }
}

/** Give the person the role, as the org's admin. */
export async function assignRoleTo(
  orgId: string,
  input: { adminUserId: string; userId: string; roleId: string },
): Promise<void> {
  await asAdmin(orgId, input.adminUserId, async (tx, actor) => {
    const assigned = await assignRole(tx, { userId: input.userId, roleId: input.roleId, ...actor })
    if (!assigned || "error" in assigned) {
      throw new Error(
        `scoped role seed: assigning role ${input.roleId} refused: ${JSON.stringify(assigned)}`,
      )
    }
  })
  invalidateAuthCache(input.userId)
}

/** A role carrying these scopes and dimension grants, assigned to the person. */
export async function grantScopesThroughRole(
  orgId: string,
  input: {
    adminUserId: string
    userId: string
    name: string
    scopes: readonly string[]
    dimensions: Readonly<Record<string, readonly string[]>>
  },
): Promise<{ roleId: string }> {
  const { roleId } = await createRoleWithGrants(orgId, input)
  await assignRoleTo(orgId, { adminUserId: input.adminUserId, userId: input.userId, roleId })
  return { roleId }
}
