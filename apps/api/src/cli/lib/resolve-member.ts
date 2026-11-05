// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared member resolution for the CLI subcommands that act for one person
 * (`agent ask --as`, `tour start --user`): the active member with that email in
 * the org given by `--org`, or the only org when there is one.
 */
import { and, eq } from "drizzle-orm"
import { resolveOrgId } from "~/cli/lib/resolve-org-id"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"

export interface CliMember {
  orgId: string
  userId: string
}

/** The active member `email` in the org, or the message saying why there is none. */
export async function resolveMember(
  orgSlug: string | undefined,
  email: string,
): Promise<CliMember | string> {
  const org = await resolveOrgId(orgSlug, "more than one org exists: pass --org <slug>")
  if (!org.ok) return org.message
  const orgId = org.orgId
  const [row] = await withSystemDb("cli-resolve-member", (tx) =>
    tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.orgId, orgId),
          eq(users.email, email.toLowerCase()),
          eq(users.status, "active"),
        ),
      )
      .limit(1),
  )
  if (!row) return `no active member '${email}' in this org`
  return { orgId, userId: row.id }
}
