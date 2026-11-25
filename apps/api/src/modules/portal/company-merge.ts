// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a company merge does to the client portal, inside the merge's own
// elevated transaction (contacts/companies.ts `mergeCompanies`), before the
// people move: every row naming the merged company names the survivor, and no
// portal person on either side reads more than before.
//
// - Each portal person of either company keeps exactly what they read: their
//   `sees_only_share_ids` become the shares their company had open (a share the
//   survivor already had open is closed on the merged side and replaced by the
//   survivor's), their `sees_only_contact_ids` the people their company had
//   (company-wide lists such as invoices follow those people). A person already
//   narrowed by an earlier merge keeps their lists. NULL is the whole company,
//   and only a person's click on the client access panel clears the lists.
// - Shares, portal rows, client actions and the company stamps of documents,
//   tickets, agreements and client reports name the survivor. A table that does
//   not exist (its app never installed) is skipped. Sealed bytes are not touched.
// - Every portal person of both companies is signed out: their sessions are
//   deleted and their auth version moves, so a token issued before the merge is
//   refused at once.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

/** Anything that runs a statement: the merge's elevated savepoint. */
export interface MergeTx {
  execute: (query: ReturnType<typeof drizzleSql>) => Promise<unknown>
}

/**
 * App rows stamped with the client company the portal reads them under. Each is
 * re-pointed by a merge only (a stamp is never followed otherwise).
 */
const COMPANY_STAMPS = [
  "app_invoicing.documents",
  "app_tickets.tickets",
  "app_agreements.agreements",
  "app_projects.client_reports",
] as const

export interface PortalMergeOutcome {
  /** Active portal people of either company, who keep what they read before. */
  keptNames: string[]
  /** Every portal person of either company: signed out by the merge. */
  userIds: string[]
  /** Their deleted sessions, to revoke on every process after the commit. */
  sessionIds: string[]
  /** Shares of the merged company closed because the survivor had the same one open. */
  closedShares: number
  /** Client actions now naming the survivor. */
  clientActions: number
}

const ks = () => drizzleSql.raw(quoteIdent(schemaRef("kernel")))

function uuidList(ids: readonly string[]) {
  return `{${ids.join(",")}}`
}

/** Re-points the portal side of a merge of `sourceId` into `targetId`. */
export async function repointPortalForCompanyMerge(
  tx: MergeTx,
  params: { orgId: string; sourceId: string; targetId: string; actorId: string | null },
): Promise<PortalMergeOutcome> {
  const { orgId, sourceId, targetId, actorId } = params
  const people = extractRows<{
    user_id: string
    company_id: string
    sees_only_share_ids: string[] | null
    sees_only_contact_ids: string[] | null
    name: string | null
    active: boolean
  }>(
    await tx.execute(drizzleSql`
      SELECT p.user_id::text AS user_id, p.company_id::text AS company_id,
             p.sees_only_share_ids::text[] AS sees_only_share_ids,
             p.sees_only_contact_ids::text[] AS sees_only_contact_ids,
             u.name, (p.removed_at IS NULL AND u.status = 'active') AS active
        FROM ${ks()}.portal_people p
        JOIN ${ks()}.users u ON u.id = p.user_id
       WHERE p.org_id = ${orgId}::uuid AND p.company_id IN (${sourceId}::uuid, ${targetId}::uuid)
       ORDER BY u.name`),
  )
  const openShares = extractRows<{
    id: string
    company_id: string
    kind: string
    object_id: string | null
  }>(
    await tx.execute(drizzleSql`
      SELECT id::text AS id, company_id::text AS company_id, kind, object_id::text AS object_id
        FROM ${ks()}.portal_shares
       WHERE org_id = ${orgId}::uuid AND company_id IN (${sourceId}::uuid, ${targetId}::uuid)
         AND closed_at IS NULL`),
  )
  const keyOf = (s: { kind: string; object_id: string | null }) => `${s.kind}:${s.object_id ?? ""}`
  const targetOpen = new Map(
    openShares.filter((s) => s.company_id === targetId).map((s) => [keyOf(s), s.id]),
  )
  // A merged-side share the survivor already has open: closed, and read through the survivor's.
  const replacedBy = new Map<string, string>()
  for (const s of openShares) {
    if (s.company_id !== sourceId) continue
    const kept = targetOpen.get(keyOf(s))
    if (kept) replacedBy.set(s.id, kept)
  }
  if (replacedBy.size > 0) {
    await tx.execute(drizzleSql`
      UPDATE ${ks()}.portal_shares
         SET closed_at = now(), closed_by_user_id = ${actorId}::uuid
       WHERE org_id = ${orgId}::uuid AND id = ANY(${uuidList([...replacedBy.keys()])}::uuid[])`)
  }

  if (people.length > 0) {
    const contacts = extractRows<{ id: string; company_id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id, company_id::text AS company_id FROM ${ks()}.contacts
         WHERE org_id = ${orgId}::uuid AND company_id IN (${sourceId}::uuid, ${targetId}::uuid)`),
    )
    const sharesOf = (companyId: string) =>
      openShares.filter((s) => s.company_id === companyId).map((s) => s.id)
    const contactsOf = (companyId: string) =>
      contacts.filter((c) => c.company_id === companyId).map((c) => c.id)
    for (const p of people) {
      const shares = [
        ...new Set(
          (p.sees_only_share_ids ?? sharesOf(p.company_id)).map((id) => replacedBy.get(id) ?? id),
        ),
      ]
      const seen = p.sees_only_contact_ids ?? contactsOf(p.company_id)
      await tx.execute(drizzleSql`
        UPDATE ${ks()}.portal_people
           SET company_id = ${targetId}::uuid,
               sees_only_share_ids = ${uuidList(shares)}::uuid[],
               sees_only_contact_ids = ${uuidList(seen)}::uuid[]
         WHERE org_id = ${orgId}::uuid AND user_id = ${p.user_id}::uuid`)
    }
  }

  await tx.execute(drizzleSql`
    UPDATE ${ks()}.portal_shares SET company_id = ${targetId}::uuid
     WHERE org_id = ${orgId}::uuid AND company_id = ${sourceId}::uuid`)
  const actions = extractRows(
    await tx.execute(drizzleSql`
      UPDATE ${ks()}.client_actions SET company_id = ${targetId}::uuid
       WHERE org_id = ${orgId}::uuid AND company_id = ${sourceId}::uuid
      RETURNING id`),
  ).length
  for (const stamp of COMPANY_STAMPS) {
    const [schema = "", table = ""] = stamp.split(".")
    const qualified = `${quoteIdent(schemaRef(schema))}.${quoteIdent(table)}`
    const [reg] = extractRows<{ t: string | null }>(
      await tx.execute(drizzleSql`SELECT to_regclass(${qualified})::text AS t`),
    )
    if (!reg?.t) continue
    await tx.execute(drizzleSql`
      UPDATE ${drizzleSql.raw(qualified)} SET company_id = ${targetId}::uuid
       WHERE org_id = ${orgId}::uuid AND company_id = ${sourceId}::uuid`)
  }

  const userIds = people.map((p) => p.user_id)
  let sessionIds: string[] = []
  if (userIds.length > 0) {
    await tx.execute(drizzleSql`
      UPDATE ${ks()}.users SET auth_version = auth_version + 1
       WHERE org_id = ${orgId}::uuid AND user_type = 'external'
         AND id = ANY(${uuidList(userIds)}::uuid[])`)
    sessionIds = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        DELETE FROM ${ks()}.sessions WHERE user_id = ANY(${uuidList(userIds)}::uuid[])
        RETURNING id::text AS id`),
    ).map((s) => s.id)
  }
  return {
    keptNames: people.filter((p) => p.active && p.name).map((p) => p.name as string),
    userIds,
    sessionIds,
    closedShares: replacedBy.size,
    clientActions: actions,
  }
}

/** The merge card's portal sentence: who keeps what they read before. */
export function portalMergeSentence(names: readonly string[]): string {
  return names.length === 0
    ? "Nobody on the portal sees more."
    : `Nobody on the portal sees more: ${names.join(", ")} keep what they saw before.`
}
