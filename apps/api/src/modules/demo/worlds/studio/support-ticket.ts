// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `studio-support-ticket`: the services world's support scenario event. A
// fictional client's email arrives in the seeded Support inbox as a new
// ticket (the same `createTicket` path the inbound channels take), which fires
// `tickets:ticket:create`: the scenario's routine reads it, leaves an internal
// note and drafts the reply. Fixed content, one ticket per run (its external
// ref, keyed to the run, is the idempotency key).
import { STUDIO_SUPPORT_TICKET_INJECTOR } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { createTicket } from "~/apps/tickets/create"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldRunKey } from "~/seed/world/people"

/**
 * The client: on a reserved domain, so the reply is a fixture delivery. Not at
 * the company the client scenario's change request mails: a colleague's mail
 * after that draft stops it (the send check counts the whole company), so a
 * visitor who played this scenario first found the change request stale.
 */
export const STUDIO_SUPPORT_CLIENT = {
  email: "ines.royer@cooperative-alpine.example",
  name: "Inès Royer",
} as const

export const STUDIO_SUPPORT_SUBJECT = "Last month's invoice again, and an empty test supplier list"
export const STUDIO_SUPPORT_EXTERNAL_REF = "demo:world:studio-support-ticket"

/** The ticket's external ref in run `run` of the scenario. */
export function studioSupportExternalRef(run: number): string {
  return worldRunKey(STUDIO_SUPPORT_EXTERNAL_REF, run)
}

const BODY =
  "Hello,\n\nTwo small things for the stock data project. Our accounts department lost " +
  "last month's invoice: could you send us a copy? And could you empty the supplier list of " +
  "the test export? Our suppliers start their tests on Monday and the old test accounts " +
  "confuse them.\n\nThanks,\nInès Royer\nCoopérative Alpine"

export const studioSupportTicketInjector: WorldInjector = {
  id: STUDIO_SUPPORT_TICKET_INJECTOR,
  world: "studio",
  // The support routine drafts a reply: an agent turn on the box key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, run }) {
    const externalRef = studioSupportExternalRef(run)
    await withPrivilegedDb(orgId, "demo-world-studio-support-ticket", async (tx) => {
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
          subject: STUDIO_SUPPORT_SUBJECT,
          channel: "email",
          priority: "normal",
          team: "support",
          audience: "b2b",
          sensitivity: "internal",
          contactEmail: STUDIO_SUPPORT_CLIENT.email,
          contactName: STUDIO_SUPPORT_CLIENT.name,
          sourceInboxId: inbox.id,
          externalRef,
          initialMessage: {
            kind: "inbound",
            fromEmail: STUDIO_SUPPORT_CLIENT.email,
            fromName: STUDIO_SUPPORT_CLIENT.name,
            toEmails: inbox.reply_from_email ? [inbox.reply_from_email] : [],
            subject: STUDIO_SUPPORT_SUBJECT,
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
    return withPrivilegedDb(orgId, "demo-world-studio-support-ticket-read", async (tx) => {
      const row = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id FROM app_tickets.tickets
            WHERE org_id = ${orgId} AND external_ref = ${studioSupportExternalRef(run)} LIMIT 1`,
        ),
      )[0]
      return row?.id ?? null
    })
  },
}
