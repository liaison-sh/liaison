// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `support-ticket`: the support scenario's live event. A fictional customer's
// email arrives in the seeded Support inbox as a new ticket (the same
// `createTicket` path the inbound channels take), which fires
// `tickets:ticket:create`: the seeded first-look routine drafts a reply on it.
// Fixed content, one ticket per run of the scenario (its external ref, keyed
// to the run, is the idempotency key): starting the scenario again brings a
// new ticket, so the routine fires again; the earlier run's ticket stays.
import { sql as drizzleSql } from "drizzle-orm"
import { createTicket } from "~/apps/tickets/create"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldRunKey } from "~/seed/world/people"

export const SUPPORT_TICKET_INJECTOR_ID = "support-ticket"

/** The customer: on a reserved domain, so the reply is a fixture delivery. */
export const SUPPORT_WORLD_CUSTOMER = {
  email: "lena.hart@kestrel-fans.example",
  name: "Lena Hart",
} as const

export const SUPPORT_WORLD_SUBJECT = "Kestrel 10 stopped charging after the update"
export const SUPPORT_WORLD_EXTERNAL_REF = "demo:world:support-ticket"

/** The ticket's external ref in run `run` of the scenario. */
export function supportWorldExternalRef(run: number): string {
  return worldRunKey(SUPPORT_WORLD_EXTERNAL_REF, run)
}

const BODY =
  "Hello,\n\nSince last night's firmware update my Kestrel 10 does not charge any more: " +
  "the LED blinks orange twice and goes off, with the original cable and with another one. " +
  "It worked fine before the update. I bought it in March from your online shop.\n\n" +
  "Can you help? I need it for a recording on Saturday.\n\nThanks,\nLena"

export const supportTicketInjector: WorldInjector = {
  id: SUPPORT_TICKET_INJECTOR_ID,
  // The first-look routine drafts a reply: an agent turn on the box key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, run }) {
    const externalRef = supportWorldExternalRef(run)
    await withPrivilegedDb(orgId, "demo-world-support-ticket", async (tx) => {
      const existing = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id FROM app_tickets.tickets
            WHERE org_id = ${orgId} AND external_ref = ${externalRef} LIMIT 1`,
        ),
      )
      if (existing[0]) return
      const inbox = extractRows<{ id: string; reply_from_email: string | null }>(
        await tx.execute(
          drizzleSql`SELECT id, reply_from_email FROM app_tickets.inboxes
            WHERE org_id = ${orgId} AND name = 'Support' AND archived_at IS NULL LIMIT 1`,
        ),
      )[0]
      if (!inbox) throw new Error("demo world: the Support inbox is not seeded")
      const now = new Date().toISOString()
      const created = await createTicket(
        tx,
        orgId,
        {
          subject: SUPPORT_WORLD_SUBJECT,
          channel: "email",
          priority: "normal",
          team: "support",
          audience: "b2c",
          sensitivity: "internal",
          contactEmail: SUPPORT_WORLD_CUSTOMER.email,
          contactName: SUPPORT_WORLD_CUSTOMER.name,
          sourceInboxId: inbox.id,
          externalRef,
          initialMessage: {
            kind: "inbound",
            fromEmail: SUPPORT_WORLD_CUSTOMER.email,
            fromName: SUPPORT_WORLD_CUSTOMER.name,
            toEmails: inbox.reply_from_email ? [inbox.reply_from_email] : [],
            subject: SUPPORT_WORLD_SUBJECT,
            textBody: BODY,
            snippet: BODY.slice(0, 160),
            sentAt: now,
          },
        },
        { actorType: "system", userId: ownerUserId },
        // Its reads run on this transaction, never on a second connection.
        { privilegedTx: tx },
      )
      if ("error" in created)
        throw new Error(`demo world: ticket refused: ${created.error.message}`)
    })
  },
  async entityOf({ orgId, run }) {
    return withPrivilegedDb(orgId, "demo-world-support-ticket-read", async (tx) => {
      const row = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id FROM app_tickets.tickets
            WHERE org_id = ${orgId} AND external_ref = ${supportWorldExternalRef(run)} LIMIT 1`,
        ),
      )[0]
      return row?.id ?? null
    })
  },
}
