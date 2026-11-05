// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `org.second` for /api/_test/seed: another org with a loginable admin,
// through the provisioning CLI's org and admin provisioners (the org factory),
// the way the minimal tier's `secondOrg` makes one. Adopted by the admin's
// email, so a repeated call (a re-seed without a truncate) returns the same
// org and the thread and contact it was given.
import { asc, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { threads, users } from "~/db/schema/kernel"
import { contacts } from "~/db/schema/kernel/contacts"
import { provisionAdminAndRoles, provisionOrgShell } from "~/seed/factories/org/org"
import { orgAdmin } from "~/seed/tiers/minimal"

export interface SecondOrg {
  orgId: string
  adminUserId: string
  created: boolean
  threadId: string | null
  contactId: string | null
}

export async function ensureSecondOrg(input: {
  orgName: string
  adminEmail: string
  adminPassword: string
  adminName: string
  /** Makes the slug unique: `second-org-<first 8 characters>`. */
  slugKey: string
}): Promise<SecondOrg> {
  const email = input.adminEmail.toLowerCase()
  const [existing] = await withSystemDb("seed-route:second-org-lookup", (tx) =>
    tx
      .select({ id: users.id, orgId: users.orgId })
      .from(users)
      .where(eq(users.email, email))
      .limit(1),
  )
  if (existing) {
    const own = await withSystemDb("seed-route:second-org-own-data", async (tx) => {
      const [t] = await tx
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.orgId, existing.orgId))
        .orderBy(asc(threads.createdAt))
        .limit(1)
      const [ct] = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(eq(contacts.orgId, existing.orgId))
        .orderBy(asc(contacts.createdAt))
        .limit(1)
      return { threadId: t?.id ?? null, contactId: ct?.id ?? null }
    })
    return { orgId: existing.orgId, adminUserId: existing.id, created: false, ...own }
  }
  const slug = `second-org-${input.slugKey.slice(0, 8)}`
  const config = {
    org: { slug, name: input.orgName, credits: { currency: "EUR", initial: "20" } },
    admin: { email, name: input.adminName, password: input.adminPassword },
  }
  const { orgId } = await provisionOrgShell(config as never, "seed-route org.second", () => {})
  await provisionAdminAndRoles(config as never, "seed-route org.second", () => {})
  const admin = await orgAdmin(orgId)
  return { orgId, adminUserId: admin.id, created: true, threadId: null, contactId: null }
}
