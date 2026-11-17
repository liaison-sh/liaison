// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's client portal: the fixed-price client's two people on its portal, and
// what the studio opened for them, as the company's client access shows it at the board date.
//
// - The two people are written by the seed's portal-person factory: the rows an invitation
//   writes, without its mail (a demo sends none, so they could never sign in). Both stay
//   Invited.
// - What is shared goes through the product's share writer, as the project's lead: the
//   project's progress and its approved reports, the issued invoices, the company's own
//   requests, the signed statement of work, the addendum waiting for a signature, and the
//   mutual NDA named to its signer only. Billed hours stay closed (the project bills by
//   milestone), as does any file.

import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { type PortalShareKind, setPortalShare } from "~/modules/portal/access"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser, rowsOf } from "~/seed/factories/people/actors"
import { seedPortalPerson } from "~/seed/factories/people/portal-people"
import type { SeedDemoOrgResult } from "~/seed/tiers/demo/seed-org"
import { STUDIO_CONTACTS } from "./fiction"

/** The client whose people are on the portal, and its project. */
export const STUDIO_PORTAL_CLIENT = "marlin"
export const STUDIO_PORTAL_PROJECT = "MARLIN"

/** The portal's people, contact keys of `STUDIO_CONTACTS`, with the title the studio gave them. */
export const STUDIO_PORTAL_PEOPLE: ReadonlyArray<{ contact: string; title: string }> = [
  { contact: "pauline-gros", title: "Head of digital" },
  { contact: "remi-castel", title: "Project manager" },
]

/** What is open for the client: agreement shares name the agreement's plan key. */
export const STUDIO_PORTAL_SHARES: ReadonlyArray<{
  kind: PortalShareKind
  agreement?: string
  /** Contact keys of the only people who see it. */
  only?: string[]
  needs?: "invoicing"
}> = [
  { kind: "project_progress" },
  { kind: "project_reports" },
  { kind: "invoices", needs: "invoicing" },
  { kind: "requests" },
  { kind: "agreement", agreement: "portal-sow" },
  { kind: "agreement", agreement: "marlin-dpa" },
  { kind: "agreement", agreement: "marlin-nda", only: ["pauline-gros"] },
]

export interface StudioPortalInput {
  ctx: SeedContext
  org: SeedDemoOrgResult
  companyIds: Readonly<Record<string, string>>
  projectIds: Readonly<Record<string, string>>
  invoicing: boolean
}

export async function seedStudioPortal(input: StudioPortalInput): Promise<void> {
  const { ctx, org } = input
  const companyId = input.companyIds[STUDIO_PORTAL_CLIENT]
  const projectId = input.projectIds[STUDIO_PORTAL_PROJECT]
  const lead = org.peopleByKey.bastien?.userId
  if (!companyId || !projectId || !lead)
    throw new Error("studio portal: no client, project or lead")

  const emails = STUDIO_PORTAL_PEOPLE.map((p) => {
    const c = STUDIO_CONTACTS.find((x) => x.key === p.contact)
    if (!c) throw new Error(`studio portal: no contact ${p.contact}`)
    return c.email.toLowerCase()
  })
  const contactRows = await withPrivilegedDb(ctx.orgId, "seed-studio:portal-contacts", (tx) =>
    tx.execute(sql`
      SELECT id::text AS id, lower(email) AS email, name FROM ${sql.raw(schemaRef("kernel"))}.contacts
       WHERE org_id = ${ctx.orgId}::uuid AND lower(email) = ANY(${`{${emails.join(",")}}`}::text[])`),
  )
  const byEmail = new Map(
    rowsOf<{ id: string; email: string; name: string }>(contactRows).map((r) => [r.email, r]),
  )
  const userOf = new Map<string, string>()
  for (const [i, p] of STUDIO_PORTAL_PEOPLE.entries()) {
    const contact = byEmail.get(emails[i] as string)
    if (!contact) throw new Error(`studio portal: contact ${p.contact} not seeded`)
    const { userId } = await seedPortalPerson(ctx, {
      companyId,
      contactId: contact.id,
      email: contact.email,
      name: contact.name,
      title: p.title,
      invitedByUserId: lead,
    })
    userOf.set(p.contact, userId)
  }

  // A share opens only what its maker reads: the agreements are opened by the person who
  // keeps them, the rest by the project's lead.
  const owner = org.peopleByKey.lea?.userId
  if (!owner) throw new Error("studio portal: no agreements owner")
  const leadActor = await actorFor(ctx, lead)
  const ownerActor = await actorFor(ctx, owner)
  for (const s of STUDIO_PORTAL_SHARES) {
    const actor = s.agreement ? ownerActor : leadActor
    if (s.needs === "invoicing" && !input.invoicing) continue
    const objectId = s.agreement
      ? ctx.id("agreement", `studio:${s.agreement}`)
      : s.kind.startsWith("project_")
        ? projectId
        : null
    await asUser(actor, (tx) =>
      setPortalShare({
        orgId: ctx.orgId,
        actorId: actor.userId,
        db: tx,
        scopes: actor.scopes,
        companyId,
        kind: s.kind,
        objectId,
        open: true,
        onlyUserIds: s.only?.map((k) => userOf.get(k) as string) ?? null,
      }),
    )
  }
  ctx.log(`portal: ${userOf.size} people, ${STUDIO_PORTAL_SHARES.length} shares`)
}
