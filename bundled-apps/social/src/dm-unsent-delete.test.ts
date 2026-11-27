// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unsent messages and conversations deleted from the inbox.
//  - Instagram signals an unsend as `messaging[].message.is_deleted: true` with
//    the message's `mid` (the `messages` webhook field). The stored message keeps
//    its place, its text cleared for good, and the list preview reads
//    "Message unsent". Messenger documents no unsend event; its envelope is
//    read by the same parser, so the flag is honoured there too.
//  - dm_delete_conversation removes a conversation from Liaison's inbox only:
//    its messages go, a re-sync or redelivery never lands them again, and a NEW
//    inbound message brings the conversation back.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  createMockDb as createSharedMockDb,
  type ManifestSchema,
  type MockDb,
} from "@liaison/test-helpers/mock-db"
import { facebookAdapter } from "./adapters/facebook"
import { instagramParseWebhook } from "./adapters/instagram"
import type { NormalizedMessage } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"
import { dmDeleteConversationHandler } from "./handlers"
import { ingestDmMessages, parseWebhookJob, UNSENT_TEXT } from "./ingest"
import { dmGet, dmList } from "./reads"

const MANIFEST_SCHEMA = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8")) as {
    schema: ManifestSchema
  }
).schema

function strictDb(): MockDb {
  return createSharedMockDb(
    {},
    { orderByManifestSchema: MANIFEST_SCHEMA, stampCreatedAt: true, bridgeWhereOperators: true },
  )
}

function ctxFor(db: MockDb): SocialToolCtx & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({ status: 200, headers: {}, body: "{}" })) as SocialToolCtx["fetch"],
    connections: { getAccounts: async () => [] },
    config: { get: async () => null },
    emit: async (e: Record<string, unknown>) => {
      events.push(e)
    },
    logger: {},
    events,
  } as SocialToolCtx & { events: Array<Record<string, unknown>> }
}

const IG_ACCOUNT = "17841400000000001"
const IGSID = "IGSID_FAN_1"

/** An Instagram `messages` delivery (the documented Messenger-shaped envelope). */
function igMessage(mid: string, text: string, timestamp: number) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT,
        time: timestamp,
        messaging: [
          {
            sender: { id: IGSID },
            recipient: { id: IG_ACCOUNT },
            timestamp,
            message: { mid, text },
          },
        ],
      },
    ],
  }
}

/** Instagram's unsend: the same envelope, the message's `mid` with `is_deleted: true`. */
function igUnsend(mid: string, timestamp: number) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT,
        time: timestamp,
        messaging: [
          {
            sender: { id: IGSID },
            recipient: { id: IG_ACCOUNT },
            timestamp,
            message: { mid, is_deleted: true },
          },
        ],
      },
    ],
  }
}

async function seedIgAccount(db: MockDb) {
  await db.insert("sync_state", {
    platform: "instagram",
    account_external_id: IG_ACCOUNT,
    source_type: "dm",
    active: true,
  })
}

type Row = Record<string, unknown> & { id: string }

async function onlyConversation(db: MockDb): Promise<Row> {
  const rows = (await db.findMany("dm_conversation", {})) as Row[]
  expect(rows.length).toBe(1)
  return rows[0] as Row
}

describe("webhook parsing of an unsend", () => {
  test("Instagram: message.is_deleted marks the message unsent, with no text", () => {
    const { messages } = instagramParseWebhook(igUnsend("mid.1", 1_764_000_000_000))
    expect(messages).toEqual([
      expect.objectContaining({
        externalId: "mid.1",
        direction: "inbound",
        participantExternalId: IGSID,
        body: null,
        unsent: true,
      }),
    ])
  })

  test("Messenger: the same flag on a Page delivery is honoured (shared envelope parser)", () => {
    const { messages } = facebookAdapter.parseWebhook?.({
      object: "page",
      entry: [
        {
          id: "PAGE_1",
          time: 1_764_000_000_000,
          messaging: [
            {
              sender: { id: "PSID_1" },
              recipient: { id: "PAGE_1" },
              timestamp: 1_764_000_000_000,
              message: { mid: "m_fb_1", text: "original", is_deleted: true },
            },
          ],
        },
      ],
    }) ?? { messages: [] }
    expect(messages[0]?.unsent).toBe(true)
    expect(messages[0]?.body).toBeNull()
  })

  test("an ordinary message carries no unsent flag", () => {
    const { messages } = instagramParseWebhook(igMessage("mid.2", "hello", 1_764_000_000_000))
    expect(messages[0]?.unsent).toBeUndefined()
    expect(messages[0]?.body).toBe("hello")
  })
})

describe("an unsent message in the store", () => {
  test("clears the stored text, keeps the row, previews as Message unsent, raises nothing", async () => {
    const db = strictDb()
    await seedIgAccount(db)
    const ctx = ctxFor(db)
    const t0 = Date.now() - 60_000
    await parseWebhookJob(ctx, { platform: "instagram", body: igMessage("mid.1", "secret", t0) })
    const conv = await onlyConversation(db)
    expect(conv.last_message_snippet).toBe("secret")
    const received = ctx.events.length

    await parseWebhookJob(ctx, { platform: "instagram", body: igUnsend("mid.1", Date.now()) })
    const [msg] = (await db.findMany("dm_message", {})) as Row[]
    expect(msg?.body).toBeNull()
    expect((msg?.metadata as { unsent?: boolean } | undefined)?.unsent).toBe(true)
    expect((await onlyConversation(db)).last_message_snippet).toBe(UNSENT_TEXT)
    // Not news: no dm:received for the unsend.
    expect(ctx.events.length).toBe(received)

    // dm_get never returns the original text.
    const got = await dmGet({ conversation_id: conv.id }, ctx)
    expect(JSON.stringify(got)).not.toContain("secret")
  })

  test("a later sync that still lists the message never restores its text", async () => {
    const db = strictDb()
    await seedIgAccount(db)
    const ctx = ctxFor(db)
    const t0 = Date.now() - 60_000
    await parseWebhookJob(ctx, { platform: "instagram", body: igMessage("mid.1", "secret", t0) })
    await parseWebhookJob(ctx, { platform: "instagram", body: igUnsend("mid.1", Date.now()) })
    const conv = await onlyConversation(db)
    const resync: NormalizedMessage = {
      conversationExternalId: "t_1",
      externalId: "mid.1",
      direction: "inbound",
      body: "secret",
      occurredAt: new Date(t0).toISOString(),
    }
    await ingestDmMessages(ctx, [resync], new Map([["t_1", { id: conv.id }]]))
    const [msg] = (await db.findMany("dm_message", {})) as Row[]
    expect(msg?.body).toBeNull()
  })

  test("an unsend for a message never stored leaves a tombstone a later sync cannot fill", async () => {
    const db = strictDb()
    await seedIgAccount(db)
    const ctx = ctxFor(db)
    await parseWebhookJob(ctx, { platform: "instagram", body: igUnsend("mid.9", Date.now()) })
    const conv = await onlyConversation(db)
    expect(ctx.events.filter((e) => e.entity === "dm").length).toBe(0)
    await ingestDmMessages(
      ctx,
      [
        {
          conversationExternalId: "t_9",
          externalId: "mid.9",
          direction: "inbound",
          body: "secret",
          occurredAt: new Date().toISOString(),
        },
      ],
      new Map([["t_9", { id: conv.id }]]),
    )
    const rows = (await db.findMany("dm_message", {})) as Row[]
    expect(rows.length).toBe(1)
    expect(rows[0]?.body).toBeNull()
    expect((rows[0]?.metadata as { unsent?: boolean } | undefined)?.unsent).toBe(true)
  })
})

describe("dm_delete_conversation", () => {
  async function seeded() {
    const db = strictDb()
    await seedIgAccount(db)
    const ctx = ctxFor(db)
    const t0 = Date.now() - 120_000
    await parseWebhookJob(ctx, { platform: "instagram", body: igMessage("mid.1", "first", t0) })
    await parseWebhookJob(ctx, {
      platform: "instagram",
      body: igMessage("mid.2", "second", t0 + 1000),
    })
    return { db, ctx, conv: await onlyConversation(db), t0 }
  }

  test("removes the messages locally, hides the conversation, needs no approval", async () => {
    const { db, ctx, conv } = await seeded()
    const res = await dmDeleteConversationHandler({ conversation_id: conv.id }, ctx)
    expect(res).toEqual({ status: "deleted", messagesRemoved: 2 })
    expect(await db.count("dm_message")).toBe(0)
    const after = await onlyConversation(db)
    expect(after.status).toBe("deleted")
    expect((await dmList({}, ctx)).conversations).toEqual([])
    expect(await db.count("dm_conversation", { where: { status: "open" } })).toBe(0)
  })

  test("an unknown conversation is skipped", async () => {
    const { ctx } = await seeded()
    expect(await dmDeleteConversationHandler({ conversation_id: "nope" }, ctx)).toEqual({
      status: "skipped",
      reason: "not_found",
    })
  })

  test("a re-sync or redelivery of the old messages does not bring it back", async () => {
    const { db, ctx, conv, t0 } = await seeded()
    await dmDeleteConversationHandler({ conversation_id: conv.id }, ctx)
    await parseWebhookJob(ctx, { platform: "instagram", body: igMessage("mid.1", "first", t0) })
    await ingestDmMessages(
      ctx,
      [
        {
          conversationExternalId: "t_1",
          externalId: "mid.2",
          direction: "inbound",
          body: "second",
          occurredAt: new Date(t0 + 1000).toISOString(),
        },
      ],
      new Map([["t_1", { id: conv.id }]]),
    )
    expect(await db.count("dm_message")).toBe(0)
    expect((await onlyConversation(db)).status).toBe("deleted")
    expect((await dmList({}, ctx)).conversations).toEqual([])
  })

  test("a NEW inbound message reopens it, with only the new message", async () => {
    const { db, ctx, conv } = await seeded()
    await dmDeleteConversationHandler({ conversation_id: conv.id }, ctx)
    const before = ctx.events.length
    await parseWebhookJob(ctx, {
      platform: "instagram",
      body: igMessage("mid.3", "back again", Date.now() + 5_000),
    })
    const after = await onlyConversation(db)
    expect(after.id).toBe(conv.id)
    expect(after.status).toBe("open")
    expect(after.last_message_snippet).toBe("back again")
    const msgs = (await db.findMany("dm_message", {})) as Row[]
    expect(msgs.map((m) => m.body)).toEqual(["back again"])
    expect(ctx.events.length).toBe(before + 1)
    const listed = (await dmList({}, ctx)).conversations as Row[]
    expect(listed.map((r) => r.id)).toEqual([conv.id])
  })

  test("our own outbound echo after the delete does not reopen it", async () => {
    const { db, ctx, conv } = await seeded()
    await dmDeleteConversationHandler({ conversation_id: conv.id }, ctx)
    const at = Date.now() + 5_000
    await parseWebhookJob(ctx, {
      platform: "instagram",
      body: {
        object: "instagram",
        entry: [
          {
            id: IG_ACCOUNT,
            time: at,
            messaging: [
              {
                sender: { id: IG_ACCOUNT },
                recipient: { id: IGSID },
                timestamp: at,
                message: { mid: "mid.4", text: "from the app", is_echo: true },
              },
            ],
          },
        ],
      },
    })
    expect((await onlyConversation(db)).status).toBe("deleted")
  })
})
