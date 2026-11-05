// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The org's member directory for people PICKERS (a ticket's assignee menu, a
 * project task's assignee chip):
 * active human members, read from the users table, never from the search
 * index. The assignee menu used to ask `/api/mentions?type=user` with an empty
 * query. That answer depends on the search index being ready and the query
 * succeeding, is clamped to ten rows, and any failure left the menu holding
 * only its hard-coded "Assign to me": a teammate could not be picked at all.
 */
import { IMPORT_PLACEHOLDER_EMAIL_LIKE } from "@liaison/shared"
import { and, eq, ilike, not, or, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { users } from "~/db/schema/kernel"
import { hasScope } from "~/modules/permissions/permissions"

/**
 * Any one of these lets a caller read the member directory: the directory
 * scope itself, or a write capability whose job is to route work to a
 * colleague (address a conversation, assign a ticket, assign a project task).
 */
export const MEMBER_DIRECTORY_SCOPES = [
  "kernel:users:read",
  "kernel:threads:write",
  "tickets:tickets:write",
  "projects:tasks:write",
] as const

export function canReadMemberDirectory(scopes: string[]): boolean {
  return MEMBER_DIRECTORY_SCOPES.some((s) => hasScope(s, scopes))
}

export const MEMBER_DIRECTORY_MAX_LIMIT = 200

export interface MemberDirectoryEntry {
  id: string
  name: string
  email: string
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export async function listActiveMembers(
  db: RlsClient,
  params: { orgId: string; q?: string; limit: number },
): Promise<{ items: MemberDirectoryEntry[]; total: number }> {
  const limit = Math.min(Math.max(params.limit, 1), MEMBER_DIRECTORY_MAX_LIMIT)
  const filters = [
    eq(users.orgId, params.orgId),
    eq(users.status, "active"),
    // Import placeholders author history but are not people anyone can work with.
    not(sql`lower(${users.email}) LIKE ${IMPORT_PLACEHOLDER_EMAIL_LIKE}`),
  ]
  const q = params.q?.trim()
  if (q) {
    const like = `%${escapeLike(q)}%`
    filters.push(or(ilike(users.name, like), ilike(users.email, like))!)
  }
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      _total: sql<number>`COUNT(*) OVER()::int`,
    })
    .from(users)
    .where(and(...filters))
    .orderBy(sql`lower(${users.name})`, users.id)
    .limit(limit)
  return {
    items: rows.map(({ _total, ...rest }) => rest),
    total: rows[0]?._total ?? 0,
  }
}
