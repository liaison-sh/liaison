// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Seed only: a client of a company on the org's portal, written without the invitation mail.
// The product invites a client by mail (`invitePortalPerson`), and refuses on a demo, which
// sends no mail (`NO_MAIL_ON_DEMO`): the client could never sign in. A demo world still shows
// the company's client access and its preview, so its seed writes the same rows the invitation
// writes, through the one writer of an external user, and sends nothing and announces nothing.
// The person is Invited (never signed in), and stays so.
//
// Only the seed calls this: `portal-people.guard.test.ts` holds that no route, tool, bridge or
// other product file imports it.
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { createExternalUser } from "~/modules/users/external-user"
import type { SeedContext } from "~/seed/context"
import { rowsOf } from "./actors"

export interface SeedPortalPersonSpec {
  companyId: string
  contactId: string
  email: string
  name: string
  title?: string | null
  /** The member shown as having invited them. */
  invitedByUserId: string
}

/**
 * The portal person of `spec.companyId` for this contact, made once: a re-run adopts the
 * external user and the row already there. Refuses an address a member holds, or one that
 * belongs to another company's client.
 */
export async function seedPortalPerson(
  ctx: SeedContext,
  spec: SeedPortalPersonSpec,
): Promise<{ userId: string }> {
  const K = sql.raw(schemaRef("kernel"))
  const email = spec.email.trim().toLowerCase()
  return withPrivilegedDb(ctx.orgId, "seed-portal-person", async (tx) => {
    const [held] = rowsOf<{ id: string; user_type: string; company_id: string | null }>(
      await tx.execute(sql`
        SELECT id::text AS id, user_type, company_id::text AS company_id FROM ${K}.users
         WHERE org_id = ${ctx.orgId}::uuid AND lower(email) = ${email} LIMIT 1`),
    )
    if (held && (held.user_type !== "external" || held.company_id !== spec.companyId)) {
      throw new Error(`seed portal person: ${email} is not a client of this company`)
    }
    let userId = held?.id
    if (!userId) {
      const made = await createExternalUser(tx, {
        orgId: ctx.orgId,
        companyId: spec.companyId,
        email,
        name: spec.name,
        invitedBy: spec.invitedByUserId,
      })
      if (!made.ok) throw new Error(`seed portal person: ${email} (${made.code})`)
      userId = made.userId
    }
    await tx.execute(sql`
      INSERT INTO ${K}.portal_people
             (user_id, org_id, company_id, contact_id, title, invited_by_user_id, invited_at)
      VALUES (${userId}::uuid, ${ctx.orgId}::uuid, ${spec.companyId}::uuid, ${spec.contactId}::uuid,
              ${spec.title ?? null}, ${spec.invitedByUserId}::uuid, ${ctx.now.toISOString()}::timestamptz)
      ON CONFLICT DO NOTHING`)
    return { userId }
  })
}
