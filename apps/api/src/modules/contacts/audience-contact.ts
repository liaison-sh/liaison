// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A contact for the people who can see one piece of team work, and no one
// else. Used when a person names a customer by address on a ticket that has
// no inbound message to carry it and the organisation has no contact for it:
// dropping the address loses it, adding it to the organisation's contacts is
// a choice nobody made. The contact belongs to the ticket's audience, like a
// shared mailbox's contact: nobody owns it (created_by records who named it),
// it is shared as editor with the team (a dimension grant such as
// "tickets:team=support-eu", modules/sharing), and contact admins manage it.
// With no team, it is the creator's own private contact.
//
// Created by `kernel.ensure_audience_contact` (migration 0178), a SECURITY
// DEFINER function on the caller's transaction: an RLS actor may not create an
// ownerless contact, a request transaction cannot elevate, and the row must
// roll back with the ticket it was made for. One contact per (audience, address): a team's
// contact is never another team's (audiences stay apart); with no audience,
// the creator's own private contact for the address.

import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { dimensionGrantee } from "~/modules/sharing/service"

export interface AudienceContactInput {
  orgId: string
  email: string
  name?: string | null
  /** The person who named the customer (the owner only when there is no
   *  audience); null for a system or agent actor. */
  ownerUserId: string | null
  /** Who else sees it: the work's audience, e.g. { key: "tickets:team", value }. */
  audience: { key: string; value: string } | null
  actorId: string | null
}

/** The contact's id, or null when nobody at all could see it. */
export async function ensureAudienceContact(
  tx: RlsClient,
  input: AudienceContactInput,
): Promise<string | null> {
  if (!input.ownerUserId && !input.audience) return null
  const email = input.email.trim().toLowerCase()
  const audienceKey = input.audience
    ? dimensionGrantee(input.audience.key, input.audience.value)
    : null
  const k = drizzleSql.raw(quoteIdent(schemaRef("kernel")))
  const [row] = extractRows<{ contact_id: string; contact_handle: string; created: boolean }>(
    await tx.execute(drizzleSql`
      SELECT contact_id::text AS contact_id, contact_handle, created
        FROM ${k}.ensure_audience_contact(${input.orgId}::uuid, ${email}, ${input.name ?? null},
                                          ${input.ownerUserId}::uuid, ${audienceKey})`),
  )
  if (!row) throw new Error("ensure_audience_contact returned no row")
  if (row.created) {
    // Queued once the grant and ACL are in place: the index sees its final ACL.
    await tx.queueEvent({
      app: "kernel",
      entity: "contact",
      action: "create",
      orgId: input.orgId,
      actorId: input.actorId,
      entityId: row.contact_id,
      data: { email, name: input.name ?? null, handle: row.contact_handle },
    })
  }
  return row.contact_id
}
