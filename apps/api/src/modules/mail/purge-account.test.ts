// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Disconnecting a mailbox deletes what Liaison imported from it: its
// conversations, messages, drafts and their attachment files. Another mailbox
// of the org is untouched, and a mailbox whose address was reconnected
// meanwhile (a re-authorization) keeps its content.

import { beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { writeMailPage } from "~/modules/mail/page-write"
import { purgeMailAccountContent } from "~/modules/mail/purge-account"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

let orgId = ""
let userId = ""

async function seedMailbox(email: string): Promise<{
  accountId: string
  messageId: string
  draftId: string
}> {
  const accountId = crypto.randomUUID()
  const conversationId = crypto.randomUUID()
  return withSystemDb("purge-account-fixture", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${accountId}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'org', null,
              'gmail', ${email}, 'active', 'none')`)
    await tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
         status, labels, is_read, is_starred, message_count, from_email)
      VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, 'org', null,
              ${`t-${conversationId}`}, 'Quote request', null, 'open', '[]', false, false, 1,
              'customer@example.test')`)
    const [message] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.messages
          (org_id, conversation_id, account_id, external_message_id, message_references,
           from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body,
           html_body, snippet, is_read, is_starred, labels, direction, raw_headers, owner_type,
           owner_id, sent_at)
        VALUES (${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
                ${`m-${conversationId}`}, '[]',
                '{"name":"Customer","email":"customer@example.test"}'::jsonb,
                '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'Quote request', 'Hello', null, null,
                false, false, '[]'::jsonb, 'inbound', '{}'::jsonb, 'org', null, now())
        RETURNING id::text AS id`),
    )
    const [draft] = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.drafts (org_id, account_id, conversation_id, subject, created_by)
        VALUES (${orgId}::uuid, ${accountId}::uuid, ${conversationId}::uuid, 'Re: Quote request',
                ${userId}::uuid)
        RETURNING id::text AS id`),
    )
    for (const [entityType, entityId] of [
      ["message", message.id],
      ["draft", draft.id],
    ]) {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.files
          (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
           storage_key, disposition)
        VALUES (gen_random_uuid(), ${orgId}::uuid, 'mail', ${entityType}, ${entityId},
                'quote.pdf', 'application/pdf', 1024,
                ${`orgs/${orgId}/mail/${entityType}/${entityId}/${crypto.randomUUID()}/quote.pdf`},
                'attachment')`)
    }
    return { accountId, messageId: message.id, draftId: draft.id }
  })
}

async function counts(accountId: string, ids: { messageId: string; draftId: string }) {
  return withSystemDb("purge-account-count", async (tx) => {
    const n = async (q: ReturnType<typeof drizzleSql>) =>
      Number(extractRows<{ n: number }>(await tx.execute(q))[0]?.n ?? 0)
    return {
      account: await n(
        drizzleSql`SELECT count(*)::int AS n FROM ${MAIL}.accounts WHERE id = ${accountId}::uuid`,
      ),
      conversations: await n(
        drizzleSql`SELECT count(*)::int AS n FROM ${MAIL}.conversations WHERE account_id = ${accountId}::uuid`,
      ),
      messages: await n(
        drizzleSql`SELECT count(*)::int AS n FROM ${MAIL}.messages WHERE account_id = ${accountId}::uuid`,
      ),
      drafts: await n(
        drizzleSql`SELECT count(*)::int AS n FROM ${MAIL}.drafts WHERE account_id = ${accountId}::uuid`,
      ),
      files: await n(drizzleSql`
        SELECT count(*)::int AS n FROM kernel.files
        WHERE org_id = ${orgId}::uuid AND app = 'mail'
          AND entity_id IN (${ids.messageId}, ${ids.draftId})`),
    }
  })
}

beforeAll(async () => {
  const u = await minimal.person((await createTestOrg()).id)
  orgId = u.orgId
  userId = u.id
})

describe("purgeMailAccountContent", () => {
  it("deletes the mailbox's conversations, messages, drafts and attachments, and keeps the account row", async () => {
    const target = await seedMailbox("disconnected@example.test")
    const other = await seedMailbox("still-connected@example.test")

    const result = await withPrivilegedDb(orgId, "purge-account-test", (tx) =>
      purgeMailAccountContent(tx, orgId, target.accountId),
    )

    expect(result).toMatchObject({
      kept: false,
      conversations: 1,
      messages: 1,
      drafts: 1,
      files: 2,
    })
    expect(result.messageIds).toEqual([target.messageId])
    expect(await counts(target.accountId, target)).toEqual({
      account: 1,
      conversations: 0,
      messages: 0,
      drafts: 0,
      files: 0,
    })
    // Marked disconnected in the same transaction, provider cursor dropped.
    const [state] = await withSystemDb("purge-account-state", async (tx) =>
      extractRows<{ sync_status: string; disconnected_at: unknown; sync_state: unknown }>(
        await tx.execute(drizzleSql`
          SELECT sync_status, disconnected_at, sync_state FROM ${MAIL}.accounts
          WHERE id = ${target.accountId}::uuid`),
      ),
    )
    expect(state!.sync_status).toBe("disconnected")
    expect(state!.disconnected_at).not.toBeNull()
    expect(state!.sync_state).toBeNull()
    expect(await counts(other.accountId, other)).toEqual({
      account: 1,
      conversations: 1,
      messages: 1,
      drafts: 1,
      files: 2,
    })
  })

  it("keeps the content when the address is connected again", async () => {
    const target = await seedMailbox("reauthorized@example.test")
    await withSystemDb("purge-account-reconnect", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, provider_type, identifier, status,
           created_by)
        VALUES (${orgId}::uuid, 'mail', 'gmail', 'org', 'oauth2', 'Reauthorized@example.test',
                'active', ${userId}::uuid)`)
    })

    const result = await withPrivilegedDb(orgId, "purge-account-test", (tx) =>
      purgeMailAccountContent(tx, orgId, target.accountId),
    )

    expect(result.kept).toBe(true)
    expect((await counts(target.accountId, target)).messages).toBe(1)
  })

  it("another owner's connection of the address does not keep the content (a takeover)", async () => {
    // The mailbox is the org's; a member now holds the address personally.
    const target = await seedMailbox("held-by-member@example.test")
    await withSystemDb("purge-account-other-owner", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
           status, created_by)
        VALUES (${orgId}::uuid, 'mail', 'gmail', 'user', ${userId}::uuid, 'oauth2',
                'held-by-member@example.test', 'active', ${userId}::uuid)`)
    })

    const result = await withPrivilegedDb(orgId, "purge-account-test", (tx) =>
      purgeMailAccountContent(tx, orgId, target.accountId),
    )

    expect(result.kept).toBe(false)
    expect((await counts(target.accountId, target)).messages).toBe(0)
  })

  it("a sync page arriving after the disconnect writes nothing", async () => {
    const target = await seedMailbox("late-page@example.test")
    await withPrivilegedDb(orgId, "purge-account-test", (tx) =>
      purgeMailAccountContent(tx, orgId, target.accountId),
    )
    const page = [
      {
        externalMessageId: "<late@example.test>",
        externalThreadId: "late-thread",
        from: { email: "customer@example.test" },
        to: [],
        subject: "Late",
        textBody: "Arrived after the disconnect",
        sentAt: new Date().toISOString(),
      },
    ]
    const write = (accountId: string) =>
      withSystemDb("purge-account-late-page", (tx) =>
        writeMailPage(
          {
            tx: tx as never,
            schemaName: schemaRef("app_mail"),
            orgId,
            actorId: "system:mail:test",
            queueEvents: async () => {},
          },
          { accountId, origin: "incremental", messages: page },
        ),
      )
    expect(await write(target.accountId)).toEqual({ entries: [], refused: "account_disconnected" })
    expect(await write(crypto.randomUUID())).toEqual({
      entries: [],
      refused: "account_disconnected",
    })
    expect((await counts(target.accountId, target)).messages).toBe(0)
    expect((await counts(target.accountId, target)).conversations).toBe(0)
  })
})
