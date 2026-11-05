// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `sales-email`: the sales scenario's live event. An interested prospect's
// email lands in the company's shared mailbox and `mail:message:create` fires
// the way a sync would emit it, so the "Research interested prospects"
// routine (an event routine filtered on the Prospects group) runs on it. The
// sender's site is answered by the in-process fixture
// (`web-fetch-fixture.ts`), never the network.
//
// The message is written into the mailbox's tables directly (as the demo
// seeder writes its mail), because a demo mailbox is not bound to a real
// provider account the sync's page writer could resolve. Fixed content, one
// message per run of the scenario (stable ids keyed to the run): starting the
// scenario again delivers a new email, so the routine runs again.
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { WorldInjector } from "~/modules/demo/world/registry"
import { worldId, worldRunKey } from "~/seed/world/people"

export const SALES_EMAIL_INJECTOR_ID = "sales-email"

/** The prospect: on a reserved domain, so a reply is a fixture delivery. */
export const SALES_WORLD_PROSPECT = {
  email: "ines.duarte@northwind-acoustics.example",
  name: "Inês Duarte",
} as const

export const SALES_WORLD_SUBJECT = "Interested — can we get a quote for 40 units?"

/** The model the prospect asks about (the demo catalog's Kestrel 6, RAL-FLAG-01). */
export const SALES_WORLD_PRODUCT = "Kestrel 6 Field Recorder"

const BODY =
  "Hello,\n\nWe run the rental desk at Northwind Acoustics and are equipping two new " +
  `studios this spring. We would like to standardise on your ${SALES_WORLD_PRODUCT}: could ` +
  "you send us a quote for 40 units, with your lead time and dealer terms?\n\nBest regards,\n" +
  "Inês Duarte\nNorthwind Acoustics, Rua do Exemplo 12, 1100-001 Lisboa, Portugal\n" +
  "northwind-acoustics.example"

export const salesEmailInjector: WorldInjector = {
  id: SALES_EMAIL_INJECTOR_ID,
  // The prospect routine researches the sender: a routine run on the box key.
  spends: true,
  async injectWorldEvent({ orgId, ownerUserId, run }) {
    const conversationId = worldId(orgId, worldRunKey("sales-email:conversation", run))
    const messageId = worldId(orgId, worldRunKey("sales-email:message", run))
    await withPrivilegedDb(orgId, "demo-world-sales-email", async (tx) => {
      const account = extractRows<{ id: string; email_address: string }>(
        await tx.execute(
          drizzleSql`SELECT id::text AS id, email_address FROM app_mail.accounts
            WHERE org_id = ${orgId}::uuid AND owner_type = 'org'
            ORDER BY created_at LIMIT 1`,
        ),
      )[0]
      if (!account) throw new Error("demo world: the shared mailbox is not seeded")
      const now = new Date().toISOString()
      const inserted = extractRows<{ id: string }>(
        await tx.execute(
          drizzleSql`INSERT INTO app_mail.conversations (
              id, org_id, account_id, owner_type, owner_id, external_thread_id,
              subject, snippet, from_email, status, labels, is_read, is_starred,
              last_message_at, message_count, created_at, updated_at
            ) VALUES (
              ${conversationId}::uuid, ${orgId}::uuid, ${account.id}::uuid, 'org', NULL,
              ${`demo-world-${conversationId}`}, ${SALES_WORLD_SUBJECT}, ${BODY.slice(0, 160)},
              ${SALES_WORLD_PROSPECT.email}, 'open', '["INBOX"]'::jsonb, false, false,
              ${now}, 1, ${now}, ${now}
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id::text AS id`,
        ),
      )
      if (!inserted[0]) return // already delivered on an earlier pass
      await tx.execute(
        drizzleSql`INSERT INTO app_mail.messages (
            id, org_id, conversation_id, account_id, external_message_id,
            message_references, from_address, to_addresses, cc_addresses, bcc_addresses,
            subject, text_body, html_body, snippet,
            is_read, is_starred, labels, direction, owner_type, owner_id,
            sent_at, synced_at, raw_headers, created_at, updated_at
          ) VALUES (
            ${messageId}::uuid, ${orgId}::uuid, ${conversationId}::uuid, ${account.id}::uuid,
            ${`demo-world-${messageId}`}, '[]'::jsonb,
            ${JSON.stringify({ name: SALES_WORLD_PROSPECT.name, email: SALES_WORLD_PROSPECT.email })}::jsonb,
            ${JSON.stringify([{ name: null, email: account.email_address }])}::jsonb,
            '[]'::jsonb, '[]'::jsonb,
            ${SALES_WORLD_SUBJECT}, ${BODY}, NULL, ${BODY.slice(0, 160)},
            false, false, '["INBOX"]'::jsonb, 'inbound', 'org', NULL,
            ${now}, ${now},
            ${JSON.stringify({ "message-id": `<${messageId}@northwind-acoustics.example>` })}::jsonb,
            ${now}, ${now}
          )`,
      )
      // What a sync emits for a new inbound message (page-write.ts messageEvent).
      await tx.queueEvent({
        app: "mail",
        entity: "message",
        action: "create",
        entityId: messageId,
        data: {
          id: messageId,
          conversationId,
          accountId: account.id,
          direction: "inbound",
          from: { name: SALES_WORLD_PROSPECT.name, email: SALES_WORLD_PROSPECT.email },
          origin: "incremental",
          senderAuth: "pass",
          labels: ["INBOX"],
          isRead: false,
          internalDate: Date.parse(now),
        },
        actorId: ownerUserId,
        actorType: "system",
        orgId,
      })
    })
  },
  // The prospect's conversation (a fixed id per org and run): the reply to approve is on it.
  async entityOf({ orgId, run }) {
    return worldId(orgId, worldRunKey("sales-email:conversation", run))
  },
}
