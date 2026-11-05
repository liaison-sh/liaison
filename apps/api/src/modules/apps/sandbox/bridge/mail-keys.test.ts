// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mail bridge on the keys migration 0116 made unique, on a real database:
//   - `db_findMany`'s `{ col: { in: [...] } }` set lookup, which the sync uses to
//     read a whole page's rows in one query (design audit 2026-09-30, #3);
//   - `mail_createFromTicket`, which must treat a conversion it already made
//     (same idempotency key) or a message the mailbox already stores as done,
//     never as a unique violation.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const suffix = crypto.randomUUID().slice(0, 8)
let orgId: string
let userId: string
let accountId: string
let conversationId: string

/** Run `fn` against a real mail bridge acting as `actor`, in one transaction. */
function withMailBridge<T>(
  actor: string,
  fn: (bridge: Record<string, any>) => Promise<T>,
): Promise<T> {
  return withPrivilegedDb(orgId, "mail-keys-test", async (tx) =>
    fn(createRpcBridge("mail", actor, orgId, tx as unknown as RlsClient, mailAppManifest as never)),
  )
}

beforeAll(async () => {
  ;[{ id: orgId }] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Mail keys', ${`mail-keys-${suffix}`}) RETURNING id`),
  )
  ;[{ id: userId }] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (gen_random_uuid(), ${orgId}, ${`u-${suffix}@x.example`}, 'U', 'active', 'h')
      RETURNING id`),
  )
  const { ensureAppsForOrg } = await import("~/modules/apps/init")
  await ensureAppsForOrg(orgId)
  ;[{ id: accountId }] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_mail.accounts
        (org_id, connected_account_id, owner_type, provider, email_address, sync_status)
      VALUES (${orgId}, gen_random_uuid(), 'org', 'gmail', ${`team-${suffix}@x.example`}, 'active')
      RETURNING id`),
  )
  ;[{ id: conversationId }] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO app_mail.conversations (org_id, account_id, owner_type, external_thread_id, status)
      VALUES (${orgId}, ${accountId}, 'org', ${`t-${suffix}`}, 'open') RETURNING id`),
  )
  for (const key of ["a", "b"]) {
    await db.execute(drizzleSql`
      INSERT INTO app_mail.messages (org_id, conversation_id, account_id, external_message_id, direction)
      VALUES (${orgId}, ${conversationId}, ${accountId}, ${`<${key}-${suffix}@x>`}, 'inbound')`)
  }
}, 120_000)

afterAll(async () => {
  await db.execute(drizzleSql`DELETE FROM app_mail.messages WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM app_mail.conversations WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM app_mail.accounts WHERE org_id = ${orgId}::uuid`)
})

describe("db_findMany `in` lookups", () => {
  it("reads a set of keys in one query; an empty set matches nothing", async () => {
    await withMailBridge("system:mail:sync", async (bridge) => {
      const found = JSON.parse(
        await bridge.db_findMany(
          "messages",
          JSON.stringify({
            where: {
              accountId,
              externalMessageId: { in: [`<a-${suffix}@x>`, `<b-${suffix}@x>`, "<none@x>"] },
            },
            select: ["externalMessageId"],
          }),
        ),
      )
      expect(found.map((r: any) => r.external_message_id).sort()).toEqual(
        [`<a-${suffix}@x>`, `<b-${suffix}@x>`].sort(),
      )
      const none = JSON.parse(
        await bridge.db_findMany(
          "messages",
          JSON.stringify({ where: { accountId, externalMessageId: { in: [] } } }),
        ),
      )
      expect(none).toEqual([])
    })
  })

  it("rejects malformed and oversized lists", async () => {
    await withMailBridge("system:mail:sync", async (bridge) => {
      await expect(
        bridge.db_findMany(
          "messages",
          JSON.stringify({ where: { externalMessageId: { in: [{ nested: 1 }] } } }),
        ),
      ).rejects.toThrow(/must be strings, numbers or booleans/)
      await expect(
        bridge.db_findMany(
          "messages",
          JSON.stringify({
            where: { externalMessageId: { in: Array.from({ length: 1001 }, (_, i) => `${i}`) } },
          }),
        ),
      ).rejects.toThrow(/at most 1000/)
    })
  })
})

describe("mail_createFromTicket on the unique mail keys", () => {
  it("a retried conversion returns its conversation; a stored message is not copied twice", async () => {
    const params = {
      accountId,
      subject: "From a ticket",
      idempotencyKey: `conv-${suffix}`,
      messages: [
        {
          direction: "inbound",
          externalMessageId: `<a-${suffix}@x>`, // already in this mailbox
          textBody: "already here",
          fromEmail: "c@x.example",
        },
        {
          direction: "inbound",
          externalMessageId: `<t-${suffix}@x>`,
          textBody: "new",
          fromEmail: "c@x.example",
        },
      ],
    }
    const first = await withMailBridge(userId, async (bridge) =>
      JSON.parse(await bridge.mail_createFromTicket(JSON.stringify(params))),
    )
    expect(first.mailConversationId).toBeTruthy()
    const [conv] = extractRows<{ message_count: number }>(
      await db.execute(drizzleSql`SELECT message_count FROM app_mail.conversations
        WHERE id = ${first.mailConversationId}::uuid`),
    )
    expect(conv.message_count).toBe(1)
    const again = await withMailBridge(userId, async (bridge) =>
      JSON.parse(await bridge.mail_createFromTicket(JSON.stringify(params))),
    )
    expect(again.mailConversationId).toBe(first.mailConversationId)
  })
})
