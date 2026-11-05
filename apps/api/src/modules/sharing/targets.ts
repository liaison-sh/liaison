// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The people and roles a share dialog offers, for any shareable resource.
// kernel.users and kernel.roles already let every org member read their org's
// rows under RLS, so these widen nothing; they project the minimum a picker
// needs. Served by /api/sharing/{members,roles} and by the Knowledge app's own
// /members and /roles.

import type { RlsClient } from "~/db"
import { listRoles } from "~/modules/permissions/roles"
import { listUsers } from "~/modules/users/service"

const SHARE_MEMBERS_LIMIT = 200

export interface ShareMember {
  userId: string
  name: string
  email: string
}
export interface ShareRoleTarget {
  roleId: string
  name: string
  memberCount: number
}

export async function listShareMembers(tx: RlsClient, orgId: string): Promise<ShareMember[]> {
  const { rows } = await listUsers(tx, { orgId, page: 1, limit: SHARE_MEMBERS_LIMIT })
  return rows.map((r) => ({ userId: r.id, name: r.name, email: r.email }))
}

export async function listShareRoles(tx: RlsClient, orgId: string): Promise<ShareRoleTarget[]> {
  const roles = await listRoles(tx, orgId, { limit: 500 })
  return roles.map((r) => ({ roleId: r.id, name: r.name, memberCount: r.memberCount }))
}
