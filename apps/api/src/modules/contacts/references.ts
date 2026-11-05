// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a contact is used by, beyond its owner.
//
// Taking a contact back from the organisation (org_access -> 'none') must not
// leave team work pointing at a record the team can no longer read: a ticket,
// a CSAT answer, an invoicing document, relationship or primary thread, or a
// conversation in a mailbox that is not the owner's. `countTeamReferences`
// counts those; the sharing API refuses the take-back while any exist, and the
// privatize CLI skips such contacts. Counted as liaison_admin, pinned to the
// org: the actor usually cannot read every one of these tables, and the answer
// is a count, not rows.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { privilegedFrom } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"

export interface ContactReference {
  /** Stable label, used in error messages and reports. */
  kind: string
  schema: string
  table: string
  /** SQL over alias `r` (the referencing row) and `c` (the contact). A
   *  `{{schema.table}}` placeholder resolves through schemaRef at use. */
  predicate: string
}

/** Team objects that reference a contact. Compared as text: the id column is
 *  uuid in some tables and text in others. Absent tables are skipped. */
export const TEAM_CONTACT_REFERENCES: ReadonlyArray<ContactReference> = [
  {
    kind: "tickets",
    schema: "app_tickets",
    table: "tickets",
    predicate: "r.contact_id::text = c.id::text",
  },
  {
    kind: "csat",
    schema: "app_tickets",
    table: "ticket_csat",
    predicate: "r.contact_id::text = c.id::text",
  },
  {
    kind: "invoicing documents",
    schema: "app_invoicing",
    table: "documents",
    predicate: "r.counterparty_contact_id::text = c.id::text",
  },
  {
    kind: "invoicing relationships",
    schema: "app_invoicing",
    table: "contact_relationships",
    predicate: "r.contact_id::text = c.id::text",
  },
  {
    kind: "invoicing identities",
    schema: "app_invoicing",
    table: "counterparty_identities",
    predicate: "r.contact_id::text = c.id::text",
  },
  {
    kind: "invoicing threads",
    schema: "app_invoicing",
    table: "contact_primary_thread",
    predicate: "r.contact_id::text = c.id::text",
  },
  {
    // A conversation in a shared mailbox, or in someone else's personal one.
    kind: "conversations in other mailboxes",
    schema: "app_mail",
    table: "conversations",
    predicate: `r.contact_id = c.id AND EXISTS (
        SELECT 1 FROM {{app_mail.accounts}} a
         WHERE a.id = r.account_id
           AND (a.owner_type <> 'user' OR c.owner_user_id IS NULL
                OR a.owner_id::text <> c.owner_user_id::text))`,
  },
]

export function rel(schema: string, table: string): string {
  return `${quoteIdent(schemaRef(schema))}.${quoteIdent(table)}`
}

/** The reference's predicate with its table placeholders resolved. */
export function predicateSql(ref: ContactReference): string {
  return ref.predicate.replace(/\{\{([a-z_]+)\.([a-z_]+)\}\}/g, (_m, schema, table) =>
    rel(schema, table),
  )
}

/** The referencing tables that exist in this database. */
export async function presentReferences(
  tx: Pick<RlsClient, "execute">,
  references: ReadonlyArray<ContactReference> = TEAM_CONTACT_REFERENCES,
): Promise<ContactReference[]> {
  const present: ContactReference[] = []
  for (const ref of references) {
    const [row] = extractRows<{ t: string | null }>(
      await tx.execute(drizzleSql`SELECT to_regclass(${rel(ref.schema, ref.table)})::text AS t`),
    )
    if (row?.t) present.push(ref)
  }
  return present
}

/** Per kind, how many team objects reference the contact (kinds with 0 omitted). */
export async function countTeamReferences(
  tx: Pick<RlsClient, "execute">,
  orgId: string,
  contactId: string,
): Promise<Record<string, number>> {
  const references = await presentReferences(tx)
  if (references.length === 0) return {}
  const counts = drizzleSql.join(
    references.map(
      (ref, i) =>
        drizzleSql`(SELECT count(*)::int FROM ${drizzleSql.raw(rel(ref.schema, ref.table))} r
                     WHERE ${drizzleSql.raw(predicateSql(ref))}) AS ${drizzleSql.raw(`n${i}`)}`,
    ),
    drizzleSql`, `,
  )
  // Read privileged: the actor may not read every referencing row. Committed
  // rows only when the caller's login cannot elevate (privilegedFrom).
  const [row] = await privilegedFrom(tx, orgId, "contact-team-references", async (ptx) =>
    extractRows<Record<string, number>>(
      await ptx.execute(drizzleSql`
        SELECT ${counts} FROM ${drizzleSql.raw(rel("kernel", "contacts"))} c
         WHERE c.id = ${contactId}::uuid AND c.org_id = ${orgId}::uuid`),
    ),
  )
  const out: Record<string, number> = {}
  references.forEach((ref, i) => {
    const n = Number(row?.[`n${i}`] ?? 0)
    if (n > 0) out[ref.kind] = n
  })
  return out
}

/**
 * What makes a contact the team's. The team references, minus mailbox
 * conversations (the classification reads mailboxes itself: a personal
 * mailbox's own links are the provenance, not a use), plus the org's other
 * pointers at a contact.
 */
export const ORG_USE_REFERENCES: ReadonlyArray<ContactReference> = [
  ...TEAM_CONTACT_REFERENCES.filter((ref) => ref.table !== "conversations"),
  {
    kind: "files",
    schema: "kernel",
    table: "files",
    predicate: "r.entity_type = 'contact' AND r.entity_id::text = c.id::text",
  },
  {
    kind: "thread references",
    schema: "kernel",
    table: "thread_references",
    predicate: "r.entity_type = 'contact' AND r.entity_id::text = c.id::text",
  },
  {
    kind: "knowledge collections",
    schema: "app_knowledge",
    table: "collection_memberships",
    predicate: "r.target_type = 'contact' AND r.target_id::text = c.id::text",
  },
  {
    kind: "knowledge tags",
    schema: "app_knowledge",
    table: "taggings",
    predicate: "r.target_type = 'contact' AND r.target_id::text = c.id::text",
  },
]
