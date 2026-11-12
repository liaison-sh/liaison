// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The role grant factory: dimension grants on a role (which ticket teams a
// desk holds, say), written as desired state. A grant that already says
// exactly what is wanted is left alone, so a no-op re-seed bumps no permission
// version; anything else, including a grant someone widened or narrowed since,
// is rewritten.
import { and, eq } from "drizzle-orm"
import { withRlsContext } from "~/db/rls"
import { roleDimensionGrants, roles } from "~/db/schema/kernel"
import { grantDimension } from "~/modules/permissions/roles"
import { createScope } from "~/modules/permissions/types"

/**
 * Grant each named role exactly these values of one dimension, as the org's
 * admin through the permission service (`grantDimension`), the path the roles
 * admin screen takes.
 */
export async function grantRoleDimension(
  orgId: string,
  adminUserId: string,
  dimension: string,
  valuesByRoleName: ReadonlyArray<readonly [string, readonly string[]]>,
  who: string,
  log: (msg: string) => void,
): Promise<void> {
  if (valuesByRoleName.length === 0) return
  await withRlsContext(
    {
      actorType: "user",
      userId: adminUserId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    },
    async (tx) => {
      const roleRows = await tx
        .select({ id: roles.id, name: roles.name })
        .from(roles)
        .where(eq(roles.orgId, orgId))
      const roleIdByName = new Map(roleRows.map((r) => [r.name, r.id] as const))

      for (const [roleName, wanted] of valuesByRoleName) {
        const roleId = roleIdByName.get(roleName)
        if (!roleId) throw new Error(`${who}: role '${roleName}' missing after provisioning`)
        const values = [...wanted]

        const [current] = await tx
          .select({ values: roleDimensionGrants.dimensionValues })
          .from(roleDimensionGrants)
          .where(
            and(
              eq(roleDimensionGrants.roleId, roleId),
              eq(roleDimensionGrants.dimensionKey, dimension),
            ),
          )
          .limit(1)
        const held = current ? [...current.values].sort() : null
        if (held && held.join(",") === [...values].sort().join(",")) continue

        await grantDimension(tx, {
          roleId,
          orgId,
          dimension,
          values,
          actorId: adminUserId,
          actorScopes: [createScope("*")],
          actorDimensionGrants: { "*": ["*"] },
        })
        log(`role '${roleName}': ${dimension} set to ${values.join(", ")}`)
      }
    },
  )
}
