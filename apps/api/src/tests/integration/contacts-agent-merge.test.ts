// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { extractRows, sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { handleContactsMerge } from "~/modules/agent/tools/contact-tools"
import { armAfterContactMergeFailpoint } from "~/modules/contacts/merge-failpoint"
import { getContact, mergeContactsWithMailReferences } from "~/modules/contacts/service"

const orgId = "00000000-0000-0000-0000-0000005d3201"
const userId = "00000000-0000-0000-0000-0000005d3202"
const connectedAccountId = "00000000-0000-0000-0000-0000005d3203"
const accountId = "00000000-0000-0000-0000-0000005d3204"
const contactAId = "00000000-0000-0000-0000-0000005d3205"
const contactBId = "00000000-0000-0000-0000-0000005d3206"

const actor: UserContext = {
  actorType: "user",
  userId,
  orgId,
  scopes: ["*"],
  dimensionGrants: { "mail:inbox": ["*"] },
}

async function withAgentContext<T>(
  fn: (ctx: { db: any; userId: string; orgId: string }) => Promise<T>,
) {
  return withRlsContext(actor, (db) => fn({ db, userId, orgId }))
}

async function seedConversation(contactId: string, suffix: string): Promise<void> {
  await sql`INSERT INTO app_mail.conversations (
      id, org_id, account_id, owner_type, owner_id, external_thread_id,
      subject, snippet, contact_id, status, labels, is_read, is_starred,
      last_message_at, message_count
    ) VALUES (
      gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, ${`contact-merge-${suffix}`},
      ${`Contact merge ${suffix}`}, ${`Snippet ${suffix}`}, ${contactId}, 'open', '["INBOX"]'::jsonb,
      false, false, now(), 1
    )`
}

async function contactConversationCount(contactId: string): Promise<number> {
  const [row] = extractRows<{ count: number }>(
    await sql`
    SELECT COUNT(*)::int AS count
    FROM app_mail.conversations
    WHERE org_id = ${orgId} AND contact_id = ${contactId}
  `,
  )
  return row.count
}

async function resetFixtures(): Promise<void> {
  await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
  await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}`

  await sql`INSERT INTO kernel.connected_accounts (
      id, org_id, app_name, connection_name, owner_type, owner_id,
      provider_type, identifier, status, created_by, access_token_encrypted
    ) VALUES (
      ${connectedAccountId}, ${orgId}, 'mail', 'gmail', 'user', ${userId},
      'oauth2', 'contacts-agent-merge@test.com', 'active', ${userId}, 'encrypted-token'
    )`
  await sql`INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
    VALUES (${accountId}, ${orgId}, ${connectedAccountId}, 'user', ${userId}, 'gmail', 'contacts-agent-merge@test.com', 'active')`
  await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, company, external_ids, created_by)
    VALUES
      (${contactAId}, ${orgId}, '@merge-target', 'Merge Target', 'target@example.com', 'Acme', '{"crm":"target"}'::jsonb, ${userId}),
      (${contactBId}, ${orgId}, '@merge-source', 'Merge Source', 'source@example.com', 'Globex', '{"crm":"source","mailchimp":"source-list"}'::jsonb, ${userId})`
  await seedConversation(contactAId, "target-1")
  await seedConversation(contactAId, "target-2")
  await seedConversation(contactAId, "target-3")
  await seedConversation(contactBId, "source-1")
  await seedConversation(contactBId, "source-2")
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${orgId}, 'Contacts Agent Merge Org', 'contacts-agent-merge-org')
    ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
    VALUES (${userId}, ${orgId}, 'contacts-agent-merge@test.com', 'Contact Merge Agent', 'x', 'active')
    ON CONFLICT DO NOTHING`
})

beforeEach(resetFixtures)

afterAll(async () => {
  await sql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}`
  await sql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.contacts WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.users WHERE id = ${userId}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
})

describe("contact merge atomicity and agent path", () => {
  it("merges two contacts with mail backlinks atomically through the agent handler", async () => {
    const result = (await withAgentContext((ctx) =>
      handleContactsMerge({ sourceId: contactBId, targetId: contactAId }, ctx),
    )) as any

    expect(result.contact.id).toBe(contactAId)
    expect(result.contact.externalIds.crm).toBe("target")
    expect(result.contact.externalIds.mailchimp).toBe("source-list")
    expect(result.mergedConversationCount).toBe(2)
    expect(await contactConversationCount(contactBId)).toBe(0)
    expect(await contactConversationCount(contactAId)).toBe(5)
  })

  it("rollback preserves source contact and references when mail reassignment fails", async () => {
    const disarm = armAfterContactMergeFailpoint(() => {
      throw new Error("failpoint")
    })
    try {
      await expect(
        withAgentContext((ctx) =>
          mergeContactsWithMailReferences(ctx.db, {
            orgId,
            userId,
            sourceId: contactBId,
            targetId: contactAId,
          }),
        ),
      ).rejects.toThrow("failpoint")
    } finally {
      disarm()
    }

    const source = await withAgentContext((ctx) =>
      getContact(ctx.db, { orgId, contactId: contactBId }),
    )
    expect(source).toBeDefined()
    expect(await contactConversationCount(contactBId)).toBe(2)
    expect(await contactConversationCount(contactAId)).toBe(3)
  })
})
