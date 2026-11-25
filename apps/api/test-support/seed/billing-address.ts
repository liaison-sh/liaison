// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Give a company's main contact a billing address and, for a French business, its registry
// identity (the SIREN a registry check records), so an invoice made for the company can issue:
// Create on a planned vs done card refuses up front a customer it cannot invoice.

import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import { addAddress } from "~/modules/contacts/addresses"
import { insertAppRow } from "~/seed/factories/app-tables"
import { asUser } from "~/seed/factories/people/actors"

export interface BillingAddress {
  street1: string
  postalCode: string
  city: string
  countryIso2: string
}

export async function addCompanyBillingAddress(
  actor: UserContext,
  companyId: string,
  address: BillingAddress,
  identity?: { siren: string; registryName: string },
): Promise<string> {
  const rows = extractRows<{ id: string | null }>(
    await db.execute(
      sql`SELECT main_contact_id::text AS id FROM kernel.companies WHERE id = ${companyId}::uuid`,
    ),
  )
  const contactId = rows[0]?.id
  if (!contactId) throw new Error(`company ${companyId} has no main contact`)
  await asUser(actor, (tx) =>
    addAddress(tx as never, {
      orgId: actor.orgId,
      userId: actor.userId,
      contactId,
      fields: { role: "billing", ...address },
    }),
  )
  if (identity) {
    await insertAppRow(db as never, "invoicing", "counterparty_identities", {
      id: crypto.randomUUID(),
      org_id: actor.orgId,
      contact_id: contactId,
      customer_kind: "business",
      siren: identity.siren,
      registry_name: identity.registryName,
      registry_country_code: "FR",
      registry_status: "A",
      registry_checked_at: "2026-10-01",
      source: "registry",
      confirmed_via: "auto",
      changed_at: "2026-10-01",
    })
  }
  return contactId
}
