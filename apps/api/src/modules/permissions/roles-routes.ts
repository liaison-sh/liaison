// SPDX-License-Identifier: FSL-1.1-ALv2
import { and, eq } from "drizzle-orm"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { roleDimensionGrants, userDimensionGrants, userRoles } from "~/db/schema/kernel"
import { withRequestRls } from "~/lib/request-rls"
import { success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { requireScope } from "~/middleware/require-scope"
import {
  assignRole,
  createRole,
  deleteRole,
  getRoleDetail,
  grantDimension,
  grantScope,
  grantUserDimension,
  grantUserScope,
  listRoles,
  revokeDimension,
  revokeScope,
  revokeUserDimension,
  revokeUserScope,
  unassignRole,
} from "~/modules/permissions/roles"
import type { PermissionMutationContext } from "~/modules/permissions/types"

/** Extract the standard actor context from a Hono request — used by all permission mutations. */
function actorContext(c: Context<AppEnv>): PermissionMutationContext {
  return {
    actorId: c.get("userId"),
    actorScopes: c.get("scopes"),
    actorDimensionGrants: c.get("dimensionGrants"),
    orgId: c.get("orgId"),
  }
}

export const adminRoles = new Hono<AppEnv>()

adminRoles.use("/*", requireScope("kernel:users:admin"))

adminRoles.get("/", async (c) => {
  const orgId = c.get("orgId")
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500)
  const offset = Number(c.req.query("offset") ?? 0)
  const orgRoles = await withRequestRls(c, (tx) => listRoles(tx, orgId, { limit, offset }))
  return success(c, orgRoles)
})

adminRoles.get(
  "/:roleId",
  zValidator("param", z.object({ roleId: z.string().uuid() })),
  async (c) => {
    const orgId = c.get("orgId")
    const { roleId } = c.req.valid("param")
    const detail = await withRequestRls(c, (tx) => getRoleDetail(tx, { orgId, roleId }))
    if (!detail) throw new HTTPException(404, { message: "Role not found" })
    return success(c, detail)
  },
)

adminRoles.post(
  "/",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(100),
      description: z.string().max(500).optional(),
    }),
  ),
  async (c) => {
    const orgId = c.get("orgId")
    const actorId = c.get("userId")
    const { name, description } = c.req.valid("json")
    const role = await withRequestRls(c, (tx) =>
      createRole(tx, { orgId, name, description, actorId }),
    )
    return success(c, role, undefined, 201)
  },
)

adminRoles.delete("/:roleId", async (c) => {
  const orgId = c.get("orgId")
  const roleId = c.req.param("roleId")
  try {
    const deleted = await withRequestRls(c, (tx) => deleteRole(tx, { roleId, ...actorContext(c) }))
    if (!deleted) throw new HTTPException(404, { message: "Role not found" })
    return success(c, { deleted: true })
  } catch (err) {
    if (err instanceof Error && err.message.includes("active user assignments")) {
      throw new HTTPException(409, { message: "Cannot delete role with active user assignments" })
    }
    throw err
  }
})

adminRoles.post(
  "/:roleId/scopes",
  zValidator(
    "json",
    z.object({
      scope: z
        .string()
        .min(1)
        .max(200)
        .regex(
          /^[a-z0-9_:*-]+$/i,
          "Scope may only contain letters, digits, underscores, colons, hyphens, and wildcards",
        ),
    }),
  ),
  async (c) => {
    const roleId = c.req.param("roleId")
    const { scope } = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      grantScope(tx, { roleId, scope, ...actorContext(c) }),
    )
    if (result === null) throw new HTTPException(404, { message: "Role not found" })
    return success(c, result, undefined, 201)
  },
)

adminRoles.delete(
  "/:roleId/scopes/:scope",
  zValidator(
    "param",
    z.object({
      roleId: z.string().uuid(),
      scope: z
        .string()
        .min(1)
        .max(200)
        .regex(
          /^[a-z0-9_:*-]+$/i,
          "Scope may only contain letters, digits, underscores, colons, hyphens, and wildcards",
        ),
    }),
  ),
  async (c) => {
    const { roleId, scope } = c.req.valid("param")
    const deleted = await withRequestRls(c, (tx) =>
      revokeScope(tx, { roleId, scope, ...actorContext(c) }),
    )
    if (!deleted) throw new HTTPException(404, { message: "Scope grant not found" })
    return success(c, { deleted: true })
  },
)

adminRoles.post(
  "/:roleId/dimensions",
  zValidator(
    "json",
    z.object({
      dimension: z.string().min(1),
      values: z.array(z.string()).min(1).max(1000),
    }),
  ),
  async (c) => {
    const roleId = c.req.param("roleId")
    const { dimension, values } = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      grantDimension(tx, { roleId, dimension, values, ...actorContext(c) }),
    )
    if (result === null) throw new HTTPException(404, { message: "Role not found" })
    return success(c, result, undefined, 201)
  },
)

adminRoles.post(
  "/:roleId/users",
  zValidator(
    "json",
    z.object({
      userId: z.string().uuid(),
    }),
  ),
  async (c) => {
    const roleId = c.req.param("roleId")
    const { userId } = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      assignRole(tx, { userId, roleId, ...actorContext(c) }),
    )
    if (result === null) throw new HTTPException(404, { message: "Role not found in this org" })
    if (result && "error" in result && result.error === "SCOPE_ESCALATION") {
      throw new HTTPException(403, { message: "Cannot assign a role with scopes you do not hold" })
    }
    if (result && "error" in result && result.error === "DIMENSION_ESCALATION") {
      throw new HTTPException(403, {
        message: "Cannot assign a role with dimension values you do not hold",
      })
    }
    return success(c, result, undefined, 201)
  },
)

adminRoles.delete("/:roleId/users/:userId", async (c) => {
  const roleId = c.req.param("roleId")
  const userId = c.req.param("userId")
  const result = await withRequestRls(c, (tx) =>
    unassignRole(tx, { userId, roleId, ...actorContext(c) }),
  )
  if (!result) throw new HTTPException(404, { message: "Role assignment not found" })
  if (result && "error" in result && result.error === "SCOPE_ESCALATION") {
    throw new HTTPException(403, { message: "Cannot unassign a role with scopes you do not hold" })
  }
  if (result && "error" in result && result.error === "DIMENSION_ESCALATION") {
    throw new HTTPException(403, {
      message: "Cannot unassign a role with dimension values you do not hold",
    })
  }
  return success(c, { deleted: true })
})

adminRoles.delete(
  "/:roleId/dimensions/:dimension",
  zValidator("param", z.object({ roleId: z.string().uuid(), dimension: z.string() })),
  async (c) => {
    const roleId = c.req.param("roleId")
    const dimension = c.req.param("dimension")
    const result = await withRequestRls(c, (tx) =>
      revokeDimension(tx, { roleId, dimension, ...actorContext(c) }),
    )
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

adminRoles.get(
  "/users/:userId/dimensions",
  zValidator("param", z.object({ userId: z.string().uuid() })),
  async (c) => {
    const orgId = c.get("orgId")
    const { userId } = c.req.valid("param")

    const result = await withRequestRls(c, async (tx) => {
      const direct = await tx
        .select({
          key: userDimensionGrants.dimensionKey,
          values: userDimensionGrants.dimensionValues,
        })
        .from(userDimensionGrants)
        .where(and(eq(userDimensionGrants.orgId, orgId), eq(userDimensionGrants.userId, userId)))

      const derived = await tx
        .select({
          key: roleDimensionGrants.dimensionKey,
          values: roleDimensionGrants.dimensionValues,
          roleId: roleDimensionGrants.roleId,
        })
        .from(roleDimensionGrants)
        .innerJoin(userRoles, eq(userRoles.roleId, roleDimensionGrants.roleId))
        .where(and(eq(userRoles.orgId, orgId), eq(userRoles.userId, userId)))

      return { direct, derived }
    })

    const direct: Record<string, string[]> = {}
    for (const row of result.direct) {
      direct[row.key] = (row.values as string[]) ?? []
    }
    const derived: Record<string, Array<{ roleId: string; values: string[] }>> = {}
    for (const row of result.derived) {
      derived[row.key] ??= []
      derived[row.key].push({ roleId: row.roleId, values: (row.values as string[]) ?? [] })
    }

    return success(c, { direct, derived })
  },
)

// User-level scope grants
adminRoles.post(
  "/users/:userId/scopes",
  zValidator("param", z.object({ userId: z.string().uuid() })),
  zValidator(
    "json",
    z.object({
      scope: z
        .string()
        .min(1)
        .max(200)
        .regex(
          /^[a-z0-9_:*-]+$/i,
          "Scope may only contain letters, digits, underscores, colons, hyphens, and wildcards",
        ),
    }),
  ),
  async (c) => {
    const userId = c.req.param("userId")
    const { scope } = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      grantUserScope(tx, { userId, scope, ...actorContext(c) }),
    )
    if (result === null) throw new HTTPException(404, { message: "User not found in this org" })
    return success(c, result, undefined, 201)
  },
)

adminRoles.delete(
  "/users/:userId/scopes/:scope",
  zValidator(
    "param",
    z.object({
      userId: z.string().uuid(),
      scope: z
        .string()
        .min(1)
        .max(200)
        .regex(
          /^[a-z0-9_:*-]+$/i,
          "Scope may only contain letters, digits, underscores, colons, hyphens, and wildcards",
        ),
    }),
  ),
  async (c) => {
    const userId = c.req.param("userId")
    const scope = c.req.param("scope")
    const result = await withRequestRls(c, (tx) =>
      revokeUserScope(tx, { userId, scope, ...actorContext(c) }),
    )
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)

// User-level dimension grants
adminRoles.post(
  "/users/:userId/dimensions",
  zValidator("param", z.object({ userId: z.string().uuid() })),
  zValidator(
    "json",
    z.object({ dimension: z.string(), values: z.array(z.string()).min(1).max(1000) }),
  ),
  async (c) => {
    const userId = c.req.param("userId")
    const { dimension, values } = c.req.valid("json")
    const result = await withRequestRls(c, (tx) =>
      grantUserDimension(tx, { userId, dimension, values, ...actorContext(c) }),
    )
    if (result === null) throw new HTTPException(404, { message: "User not found in this org" })
    return success(c, result, undefined, 201)
  },
)

adminRoles.delete(
  "/users/:userId/dimensions/:dimension",
  zValidator("param", z.object({ userId: z.string().uuid(), dimension: z.string() })),
  async (c) => {
    const userId = c.req.param("userId")
    const dimension = c.req.param("dimension")
    const result = await withRequestRls(c, (tx) =>
      revokeUserDimension(tx, { userId, dimension, ...actorContext(c) }),
    )
    if (!result) throw new HTTPException(404, { message: "Not found" })
    return success(c, result)
  },
)
