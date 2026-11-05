// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `ensureUser` — idempotent user create + role grant for the provisioning CLI
 * (Task 5). Shared by the admin provisioner and (later) `users[] mode:create`.
 *
 * Handle: `withSystemDb` (a direct, pre-actor user insert mirroring the test
 * factory's `insertUser` / `createSecondOrgWithAdmin`).
 *
 * Idempotency key: `(orgId, lower(email))`. Emails are stored lowercased to
 * match the auth convention (`auth.ts`, `invites.ts`), so two casings of the
 * same address resolve to ONE row.
 *
 * PASSWORD IMMUTABILITY (the critical security invariant): on a re-run for an
 * existing user this NEVER touches `passwordHash`. A new password supplied for
 * an existing user is silently ignored — the original password keeps working.
 * Only the role grant is ensured (onConflictDoNothing), never duplicated.
 *
 * PERSONAL AGENT: like a browser Register (bootstrap or invite), a created user
 * gets their personal agent in the same transaction, after the role grant its
 * scope ceiling reads. An existing user without one (created by an older CLI)
 * gets it on the next run; one who has it keeps it.
 *
 * PASSWORDLESS: `password` may be omitted when CREATING with
 * `allowPasswordless`, as the browser's first Register does: the user signs in
 * with an emailed code (logged to the app's stdout when SMTP is not set).
 *
 * There is no exception. There used to be one, `restore`, for the demo seeder,
 * whose seven persona accounts were doors on a published password that a
 * visitor could change: the seeder had to put them back. Those accounts now
 * hold no password at all, nobody can drift them, and the exception went with
 * the concept.
 */

import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { roles, userRoles, users } from "~/db/schema/kernel"
import { hashPassword } from "~/lib/crypto"
import {
  createPersonalAgent,
  getOrCreatePersonalAgentId,
  refreshPersonalAgentCeiling,
} from "~/modules/agent/directory/personal-agent"
import { assertSeatRoom } from "~/modules/org/caps"

export interface EnsureUserInput {
  orgId: string
  email: string
  name: string
  /** Required to CREATE a user; ignored entirely when the user already exists. */
  password?: string
  /** Role NAME (resolved against `kernel.roles` for this org). */
  role: string
  /** Create the user with no password (sign-in by emailed code) when none is given. */
  allowPasswordless?: boolean
}

export interface EnsureUserResult {
  userId: string
  created: boolean
  /**
   * True when this call granted `role` to the user: always for a created user,
   * and for an existing one only when they did not hold it yet. A re-run that
   * changes nothing reports false, so the CLI report can tell the two apart.
   */
  roleGranted: boolean
}

async function resolveRoleId(
  tx: Parameters<Parameters<typeof withSystemDb>[1]>[0],
  orgId: string,
  roleName: string,
): Promise<string> {
  const [role] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.orgId, orgId), eq(roles.name, roleName)))
    .limit(1)
  if (!role) throw new Error(`ensureUser: role '${roleName}' not seeded for org ${orgId}`)
  return role.id
}

export async function ensureUser(input: EnsureUserInput): Promise<EnsureUserResult> {
  const { orgId, name, password, role } = input
  const email = input.email.toLowerCase()

  return withSystemDb("cli-ensure-user", async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, orgId), eq(users.email, email)))
      .limit(1)

    if (existing) {
      const roleId = await resolveRoleId(tx, orgId, role)
      const granted = await tx
        .insert(userRoles)
        .values({ userId: existing.id, roleId, orgId })
        .onConflictDoNothing()
        .returning({ roleId: userRoles.roleId })
      await getOrCreatePersonalAgentId(tx, { orgId, userId: existing.id })
      // A role given to an existing person reaches their own agent too: its
      // ceiling is their current grants, not the ones they had when created.
      await refreshPersonalAgentCeiling(tx, { orgId, userId: existing.id })

      // NEVER touch passwordHash, status or the other grants on an existing user.
      return { userId: existing.id, created: false, roleGranted: granted.length > 0 }
    }

    const hasPassword = password !== undefined && password.length > 0
    if (!hasPassword && input.allowPasswordless !== true) {
      throw new Error(`ensureUser: password required to create user '${email}' in org ${orgId}`)
    }
    const passwordHash = hasPassword ? await hashPassword(password) : null
    // The org's seat cap (modules/org/caps.ts), under its seats lock.
    await assertSeatRoom(tx, orgId)
    const [row] = await tx
      .insert(users)
      .values({ orgId, email, passwordHash, name, status: "active" })
      .returning({ id: users.id })

    const roleId = await resolveRoleId(tx, orgId, role)
    await tx.insert(userRoles).values({ userId: row.id, roleId, orgId }).onConflictDoNothing()
    await createPersonalAgent(tx, {
      orgId,
      userId: row.id,
      email,
      firstName: name.split(" ")[0],
    })
    return { userId: row.id, created: true, roleGranted: true }
  })
}
