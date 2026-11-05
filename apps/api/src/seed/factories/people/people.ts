// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The people factory: what a seed writes on the accounts the org factory
// provisioned. Reading them back by email, setting (or taking away) their
// password, and the profile a person carries in their settings.
//
// Privileged: these are the account-level writes the provisioning CLI and the
// admin's own account routes make on `kernel.users`, which the RLS role cannot
// write for another person.
import { and, eq, inArray } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { hashPassword } from "~/lib/crypto"

/** Every account of the org, by lower-cased email. */
export async function orgUserIdsByEmail(orgId: string): Promise<Map<string, string>> {
  const rows = await withSystemDb("seed-users-resolve", (tx) =>
    tx.select({ id: users.id, email: users.email }).from(users).where(eq(users.orgId, orgId)),
  )
  return new Map(rows.map((r) => [r.email.toLowerCase(), r.id] as const))
}

/**
 * Give these accounts one password, or none at all (`null`): a null
 * `password_hash` is the shape sign-in already refuses, so there is nothing to
 * guess, publish or change.
 */
export async function setPeoplePassword(
  orgId: string,
  userIds: readonly string[],
  password: string | null,
): Promise<void> {
  if (userIds.length === 0) return
  const passwordHash = password === null ? null : await hashPassword(password)
  await withSystemDb("seed-people-passwords", (tx) =>
    tx
      .update(users)
      .set({ passwordHash })
      .where(and(eq(users.orgId, orgId), inArray(users.id, [...userIds]))),
  )
}

export interface PersonProfile {
  jobTitle: string
  bio: string
  personKey: string
}

/**
 * Carry a person's job title and bio, and leave their picture EMPTY.
 *
 * `kernel.users` has no job-title or bio column (the product's profile is name,
 * email and picture), so those two live in the user's `settings` under a
 * `demo` namespace, beside the per-app settings the app-settings route writes.
 * The picture is cleared: the product's own initials disc is the look a seeded
 * person wears, and a re-seed removes any picture an earlier seed stored.
 */
export async function writePersonProfile(
  orgId: string,
  userId: string,
  profile: PersonProfile,
): Promise<{ avatarKey: null; avatarUrl: null }> {
  const [current] = await withSystemDb("seed-profile-read", (tx) =>
    tx
      .select({ settings: users.settings })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  const settings = { ...(current?.settings ?? {}) }
  settings.demo = { jobTitle: profile.jobTitle, bio: profile.bio, personKey: profile.personKey }

  await withSystemDb("seed-profile-write", (tx) =>
    tx
      .update(users)
      .set({ settings, avatarKey: null, avatarUrl: null })
      .where(and(eq(users.id, userId), eq(users.orgId, orgId))),
  )
  return { avatarKey: null, avatarUrl: null }
}
