// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The companies factory: the organisations an org's people work for, written
// through `createCompanies` (one batch), `linkContactsToCompany` and `updateCompany` (its main
// contact), the services the company
// routes and tools use, inside one RLS transaction as the actor. A company is
// found again by its name (case-insensitive), so a re-run adopts instead of
// adding a twin. No privileged write.
import { sql } from "drizzle-orm"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { createCompanies, linkContactsToCompany, updateCompany } from "~/modules/contacts/companies"
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
  /** Contact key of its main contact, the one its invoices go to: one of `contactKeys`. */
  mainContactKey?: string
}

type ExecTx = { execute: (q: unknown) => Promise<unknown> }

/**
 * Seed every company and link its people; returns each company's id by key.
 * `onlyExisting`: link people to the companies already there, create none
 * (a later layer adding people to the companies an earlier one wrote).
 */
export async function seedCompanies(
  ctx: SeedContext,
  actor: UserContext,
  specs: readonly CompanySpec[],
  contactIds: Readonly<Record<string, string>>,
  opts: { onlyExisting?: boolean } = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const mains: Array<{ companyId: string; contactId: string }> = []
  await asUser(actor, async (tx) => {
    // The companies already there, in one read; the missing ones, in one write.
    const names = specs.map((s) => s.name.toLowerCase())
    const found = rowsOf<{ id: string; name: string; main_contact_id: string | null }>(
      await (tx as ExecTx).execute(
        sql`SELECT DISTINCT ON (lower(name)) id, lower(name) AS name, main_contact_id::text AS main_contact_id
            FROM ${sql.raw(schemaRef("kernel"))}.companies
            WHERE org_id = ${ctx.orgId} AND lower(name) IN (SELECT jsonb_array_elements_text(${JSON.stringify(names)}::jsonb))
            ORDER BY lower(name), created_at, id`,
      ),
    )
    const existing = new Map(found.map((r) => [r.name, r.id]))
    const mainContactOf = new Map(found.map((r) => [r.id, r.main_contact_id]))
    const missing = opts.onlyExisting
      ? []
      : specs.filter(
          (spec, i) =>
            !existing.has(spec.name.toLowerCase()) &&
            // One company per name, as the one-by-one lookup gave.
            names.indexOf(spec.name.toLowerCase()) === i,
        )
    const created = await createCompanies(tx as never, {
      orgId: ctx.orgId,
      userId: actor.userId,
      inputs: missing.map((spec) => ({
        name: spec.name,
        domain: spec.domain ?? null,
        description: spec.description ?? null,
        ...(spec.tags ? { tags: spec.tags } : {}),
      })),
    })
    for (const [i, spec] of missing.entries()) {
      const company = created[i]
      if (company) existing.set(spec.name.toLowerCase(), company.id)
    }
    for (const spec of specs) {
      const id = existing.get(spec.name.toLowerCase())
      if (!id) continue
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
      // Set once: a re-run, or a main contact somebody chose since, leaves it as it is.
      const main = spec.mainContactKey ? contactIds[spec.mainContactKey] : undefined
      if (main && !mainContactOf.get(id)) mains.push({ companyId: id, contactId: main })
    }
  })
  // After the companies and their links commit: updateCompany may open its own transaction.
  for (const m of mains) {
    await asUser(actor, (tx) =>
      updateCompany(tx as never, {
        orgId: ctx.orgId,
        userId: actor.userId,
        companyId: m.companyId,
        patch: { mainContactId: m.contactId },
      }),
    )
  }
  ctx.log(`companies: ${Object.keys(out).length} seeded`)
  return out
}
