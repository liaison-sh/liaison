// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

export const adminUserDetailSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  status: z.enum(["active", "suspended", "deactivated"]),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  roles: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  effectiveScopes: z.array(
    z.object({
      scope: z.string(),
      fromRoles: z.array(z.string()),
    }),
  ),
  dimensions: z.record(
    z.string(),
    z.object({
      inherited: z.array(z.object({ values: z.array(z.string()), fromRole: z.string() })),
      direct: z.array(z.string()),
    }),
  ),
})
export type AdminUserDetail = z.infer<typeof adminUserDetailSchema>

export const adminRoleDetailSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  scopes: z.array(z.object({ scope: z.string(), grantedAt: z.string() })),
  dimensionGrants: z.array(z.object({ dimension: z.string(), values: z.array(z.string()) })),
  members: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
})
export type AdminRoleDetail = z.infer<typeof adminRoleDetailSchema>
