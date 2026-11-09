// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The companies factory: the organisations an org's people work for, written
// through `createCompany` and `linkContactsToCompany`, the services the company
// routes and tools use, inside one RLS transaction as the actor. A company is
// found again by its name (case-insensitive), so a re-run adopts instead of
// adding a twin. No privileged write.
import { sql } from "drizzle-orm"
import type { UserContext } from "~/db/rls"
import { createCompany, linkContactsToCompany } from "~/modules/contacts/companies"
import type { SeedContext } from "~/seed/context"
import { asUser, rowsOf } from "./actors"

export interface CompanySpec {
  key: string
  name: string
  domain?: string
  description?: string
  tags?: string[]
  /** Contact keys (as `resolveContacts` returned them) of the people who work there. */
  contactKeys?: string[]
}

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/** Seed every company and link its people; returns each company's id by key. */
export async function seedCompanies(
  ctx: SeedContext,
  actor: UserContext,
  specs: readonly CompanySpec[],
  contactIds: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await asUser(actor, async (tx) => {
    for (const spec of specs) {
      const found = rowsOf<{ id: string }>(
        await (tx as ExecTx).execute(
          sql`SELECT id FROM kernel.companies
              WHERE org_id = ${ctx.orgId} AND lower(name) = ${spec.name.toLowerCase()} LIMIT 1`,
        ),
      )[0]
      let id = found?.id
      if (!id) {
        const { company } = await createCompany(tx as never, {
          orgId: ctx.orgId,
          userId: actor.userId,
          input: {
            name: spec.name,
            domain: spec.domain ?? null,
            description: spec.description ?? null,
            ...(spec.tags ? { tags: spec.tags } : {}),
          },
        })
        id = company.id
      }
      out[spec.key] = id
      const people = (spec.contactKeys ?? []).flatMap((k) => (contactIds[k] ? [contactIds[k]] : []))
      if (people.length > 0) {
        await linkContactsToCompany(tx as never, {
          orgId: ctx.orgId,
          userId: actor.userId,
          companyId: id,
          contactIds: people,
        })
      }
    }
  })
  ctx.log(`companies: ${Object.keys(out).length} seeded`)
  return out
}
