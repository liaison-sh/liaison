// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the stored rows say about an org before anything demo destroys it: its
// class, and whether it is an org no demo code may ever delete. Read straight
// out of Postgres, never from a cache or a caller.
import { sql as drizzleSql, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { type OrgClass, organizations } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { CLOUD_CREATE_ORG_ENDPOINT } from "~/modules/cloud/outcomes"

/** The kernel schema, through the prefix a test lane runs under (db/schema-ref.ts). */
const K = () => drizzleSql.raw(schemaRef("kernel"))

/**
 * Why no demo code may delete an org, or null: it is the operator's
 * (`LIAISON_OPERATOR_ORG_ID`; a demo org is the operator's only when named, see
 * apps/operator-org.ts), or a customer's (it has a billing row, or the control
 * plane created it).
 */
export type ProtectedOrgReason = "operator-org" | "customer-org"

/**
 * `o` (an alias of `kernel.organizations`) is no customer's: no billing row, no
 * stored reply of a control plane create of its slug.
 */
export const notACustomerOrg = () => drizzleSql`
  NOT EXISTS (SELECT 1 FROM ${K()}.org_billing_state b WHERE b.org_id = o.id)
  AND NOT EXISTS (SELECT 1 FROM ${K()}.cloud_request_outcomes r
                   WHERE r.endpoint = ${CLOUD_CREATE_ORG_ENDPOINT} AND r.idem_key = o.slug)`

export const isNamedOperatorOrg = (orgId: string): boolean =>
  env.LIAISON_OPERATOR_ORG_ID?.toLowerCase() === orgId.toLowerCase()

/** Is this an org no demo code may delete? Null when it is not one of those. */
export async function protectedOrgReason(orgId: string): Promise<ProtectedOrgReason | null> {
  if (isNamedOperatorOrg(orgId)) return "operator-org"
  const customer = await withSystemDb("demo-protected-org", async (tx) => {
    const result = await tx.execute(drizzleSql`
      SELECT 1 AS one FROM ${K()}.organizations o
       WHERE o.id = ${orgId}::uuid AND NOT (${notACustomerOrg()})`)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return rows.length > 0
  })
  return customer ? "customer-org" : null
}

/** The org's class, or null when there is no such org. */
export async function orgClassOf(orgId: string): Promise<OrgClass | null> {
  const [row] = await withSystemDb("demo-org-class", (tx) =>
    tx
      .select({ class: organizations.class })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return row?.class ?? null
}
