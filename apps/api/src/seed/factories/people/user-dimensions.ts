// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A person's own dimension grants (which mail accounts, which teams they may
// see beyond their roles), set and taken away as the org's admin through the
// role editor's per-person services (`grantUserDimension`,
// `revokeUserDimension`), which validate the values, refuse what the admin
// could not grant and bump the person's permission version.
import { and, eq } from "drizzle-orm"
import { userDimensionGrants } from "~/db/schema/kernel/roles"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import { grantUserDimension, revokeUserDimension } from "~/modules/permissions/roles"
import { asAdmin } from "~/seed/factories/people/scoped-role"

export async function setUserDimension(
  orgId: string,
  input: { adminUserId: string; userId: string; dimension: string; values: readonly string[] },
): Promise<void> {
  await asAdmin(orgId, input.adminUserId, async (tx, actor) => {
    const grant = await grantUserDimension(tx, {
      userId: input.userId,
      dimension: input.dimension,
      values: [...input.values],
      ...actor,
    })
    if (!grant) throw new Error(`user dimension seed: ${input.userId} is not in org ${orgId}`)
  })
  invalidateAuthCache(input.userId)
}

export async function clearUserDimension(
  orgId: string,
  input: { adminUserId: string; userId: string; dimension: string },
): Promise<void> {
  await asAdmin(orgId, input.adminUserId, (tx, actor) =>
    revokeUserDimension(tx, { userId: input.userId, dimension: input.dimension, ...actor }),
  )
  invalidateAuthCache(input.userId)
}

/** The person's own grant of one dimension, widened by `values` (the editor's set, with what they had). */
export async function addUserDimensionValues(
  orgId: string,
  input: { adminUserId: string; userId: string; dimension: string; values: readonly string[] },
): Promise<void> {
  // Read as the org's admin, the way the role editor shows the person's grants.
  const [row] = await asAdmin(orgId, input.adminUserId, (tx) =>
    tx
      .select({ values: userDimensionGrants.dimensionValues })
      .from(userDimensionGrants)
      .where(
        and(
          eq(userDimensionGrants.orgId, orgId),
          eq(userDimensionGrants.userId, input.userId),
          eq(userDimensionGrants.dimensionKey, input.dimension),
        ),
      )
      .limit(1),
  )
  const values = [...new Set([...(row?.values ?? []), ...input.values])]
  await setUserDimension(orgId, { ...input, values })
}
