// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B5 — ingest dedup + emit. The same external item upserted twice (webhook then
// poll, or an edit) collapses to exactly one finding row keyed on
// [platform, external_id]; an edit updates the existing row's content.

import { describe, expect, test } from "bun:test"
import { facebookAdapter } from "./adapters/facebook"
import { instagramParseWebhook } from "./adapters/instagram"
import type { SocialToolCtx } from "./ctx"
import {
  dmSnippet,
  emitFindingCreated,
  ingestDmMessages,
  parseWebhookJob,
  upsertDmMessage,
  upsertFinding,
} from "./ingest"
import { createMockDb } from "./test-db"

const ISO = "2026-06-01T10:00:00.000Z"

function ctxWith(db = createMockDb()): SocialToolCtx & { __emitted: unknown[] } {
  const emitted: unknown[] = []
  return {
    orgId: "org-1",
    db,
    fetch: (async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => "",
    })) as never,
    connections: {},
    config: { get: async () => null },
    async emit(e) {
      emitted.push(e)
    },
    __emitted: emitted,
  } as SocialToolCtx & { __emitted: unknown[] }
}

describe("upsertFinding (B5 dedup)", () => {
  test("the same external item upserted twice yields one finding row", async () => {
    const ctx = ctxWith()
    await upsertFinding(ctx, {
      platform: "instagram",
      externalId: "ig-1",
      relation: "tagged",
      contentText: "hi",
      occurredAt: ISO,
    })
    await upsertFinding(ctx, {
      platform: "instagram",
      externalId: "ig-1",
      relation: "tagged",
      contentText: "hi (edited)",
      occurredAt: ISO,
    })
    const rows = await ctx.db.findMany("finding", {
      where: { platform: "instagram", external_id: "ig-1" },
    })
    expect(rows.length).toBe(1)
    expect((rows[0] as { content_text: string }).content_text).toBe("hi (edited)")
  })

  test("returns created:true the first time, created:false on a dedup hit", async () => {
    const ctx = ctxWith()
    const first = await upsertFinding(ctx, {
      platform: "facebook",
      externalId: "fb-1",
      relation: "comment_on_our_content",
    })
    const second = await upsertFinding(ctx, {
      platform: "facebook",
      externalId: "fb-1",
      relation: "comment_on_our_content",
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
  })
})

describe("upsertFinding keeps what a poorer source does not carry", () => {
  test("a later sync fills a missing permalink; a webhook delivery without one never erases it or the post context", async () => {
    const ctx = ctxWith()
    const base = {
      platform: "facebook" as const,
      externalId: "222_333",
      relation: "comment_on_our_content" as const,
    }
    await upsertFinding(ctx, { ...base, contentText: "hi", metadata: { siblingsAccessible: true } })
    await upsertFinding(ctx, {
      ...base,
      contentText: "hi",
      permalink: "https://www.facebook.com/111/posts/222?comment_id=333",
      metadata: { siblingsAccessible: true, postExcerpt: "New post", postPermalink: null },
    })
    await upsertFinding(ctx, { ...base, contentText: "hi", metadata: { siblingsAccessible: true } })
    const [row] = (await ctx.db.findMany("finding", {
      where: { external_id: "222_333" },
    })) as Array<{
      permalink: string | null
      metadata: Record<string, unknown>
    }>
    expect(row?.permalink).toBe("https://www.facebook.com/111/posts/222?comment_id=333")
    expect(row?.metadata).toMatchObject({ postExcerpt: "New post", siblingsAccessible: true })
  })
})

describe("contact linking (I3 — §5/§6)", () => {
  test("a new finding with an author external id resolves + stores a contact_id", async () => {
    const db = createMockDb()
    const resolveCalls: Array<{ externalId?: string }> = []
    const ctx = {
      ...ctxWith(db),
      async resolveContact(p: { externalId?: string }) {
        resolveCalls.push(p)
        return { id: "contact-42" }
      },
    } as SocialToolCtx
    const res = await upsertFinding(ctx, {
      platform: "instagram",
      externalId: "ig-7",
      relation: "mention_in_post",
      authorExternalId: "ig-user-9",
      authorHandle: "@fan",
    })
    expect(resolveCalls).toContainEqual(expect.objectContaining({ externalId: "ig-user-9" }))
    const row = (await db.findMany("finding", { where: { id: res.id } }))[0] as {
      contact_id: string
    }
    expect(row.contact_id).toBe("contact-42")
  })

  test("a resolveContact failure does not block ingest (finding lands with null contact_id)", async () => {
    const db = createMockDb()
    const ctx = {
      ...ctxWith(db),
      async resolveContact() {
        throw new Error("contacts service down")
      },
    } as SocialToolCtx
    const res = await upsertFinding(ctx, {
      platform: "facebook",
      externalId: "fb-x",
      relation: "comment_on_our_content",
      authorExternalId: "u-1",
    })
    const row = (await db.findMany("finding", { where: { id: res.id } }))[0] as {
      contact_id: string | null
    }
    expect(row.contact_id ?? null).toBeNull()
  })
})

describe("emitFindingCreated (B5)", () => {
  test("publishes a social finding:created event carrying the finding id", async () => {
    const ctx = ctxWith()
    await emitFindingCreated(ctx, "find-7")
    expect(ctx.__emitted).toContainEqual(
      expect.objectContaining({ entity: "finding", action: "created", entityId: "find-7" }),
    )
  })
})

describe("dmSnippet (B: snippet honesty)", () => {
  test("a real message with an empty body (Graph API omits `message` on attachments/stickers) becomes '[attachment]'", () => {
    expect(dmSnippet("")).toBe("[attachment]")
  })

  test("null/undefined body (no message landed) stays null", () => {
    expect(dmSnippet(null)).toBeNull()
    expect(dmSnippet(undefined)).toBeNull()
  })

  test("a real non-empty body is truncated to 120 chars as before", () => {
    expect(dmSnippet("hello")).toBe("hello")
    const long = "x".repeat(200)
    expect(dmSnippet(long)).toBe(long.slice(0, 120))
    expect(dmSnippet(long)!.length).toBe(120)
  })
})

describe("ingestDmMessages snippet honesty (B)", () => {
  test("an inbound message with an empty body lands last_message_snippet:'[attachment]', not null", async () => {
    const ctx = ctxWith()
    await ctx.db.insert("dm_conversation", {
      id: "conv-row-1",
      platform: "facebook",
      external_id: "conv-1",
    })
    const convByExternalId = new Map([["conv-1", { id: "conv-row-1" }]])
    await ingestDmMessages(
      ctx,
      [
        {
          conversationExternalId: "conv-1",
          externalId: "m-1",
          direction: "inbound",
          body: "",
          occurredAt: ISO,
        },
      ],
      convByExternalId,
    )
    const conv = (await ctx.db.findMany("dm_conversation", { where: { id: "conv-row-1" } }))[0] as {
      last_message_snippet?: string | null
    }
    expect(conv.last_message_snippet).toBe("[attachment]")
  })
})

describe("parseWebhookJob (B5)", () => {
  test("parses a verified meta feed-comment body into one finding and emits finding:created", async () => {
    const ctx = ctxWith()
    const body = {
      object: "page",
      entry: [
        {
          changes: [
            {
              field: "feed",
              value: {
                comment_id: "c-9",
                post_id: "p-1",
                message: "great product",
                from: { id: "u-3" },
              },
            },
          ],
        },
      ],
    }
    await parseWebhookJob(ctx, { platform: "facebook", body })
    const rows = await ctx.db.findMany("finding", { where: { external_id: "c-9" } })
    expect(rows.length).toBe(1)
    expect(ctx.__emitted).toContainEqual(
      expect.objectContaining({ entity: "finding", action: "created" }),
    )
  })

  test("re-parsing the same webhook body does not duplicate the finding (dedup on replay)", async () => {
    const ctx = ctxWith()
    const body = {
      entry: [
        {
          changes: [{ field: "feed", value: { comment_id: "c-1", post_id: "p-1", message: "x" } }],
        },
      ],
    }
    await parseWebhookJob(ctx, { platform: "facebook", body })
    await parseWebhookJob(ctx, { platform: "facebook", body })
    expect(await ctx.db.count("finding", { where: { external_id: "c-1" } })).toBe(1)
  })
})

// Instagram webhooks (`object: "instagram"`): comments arrive as
// `changes[field=comments]` and DMs as `messaging[]`. Fixtures follow Meta's
// documented payloads:
// https://developers.facebook.com/documentation/instagram-platform/webhooks/examples
describe("parseWebhookJob: Instagram deliveries", () => {
  const IG_ID = "17841400000000101"
  const commentBody = (fromId: string, id = "17865799348089039") => ({
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: 1520383571,
        changes: [
          {
            field: "comments",
            value: {
              from: { id: fromId, username: "test" },
              media: { id: "123123123", media_product_type: "FEED" },
              id,
              text: "This is an example.",
            },
          },
        ],
      },
    ],
  })
  const messageBody = (echo: boolean) => ({
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: 1569262486134,
        messaging: [
          {
            sender: { id: echo ? IG_ID : "IGSID_1" },
            recipient: { id: echo ? "IGSID_1" : IG_ID },
            timestamp: 1569262485349,
            message: { mid: "MID_1", text: "hello there", ...(echo ? { is_echo: true } : {}) },
          },
        ],
      },
    ],
  })
  async function connected(): Promise<ReturnType<typeof ctxWith>> {
    const ctx = ctxWith()
    for (const source_type of ["discovery", "watch", "dm"]) {
      await ctx.db.insert("sync_state", {
        platform: "instagram",
        account_external_id: IG_ID,
        source_type,
        active: true,
      })
    }
    return ctx
  }

  test("a comments change becomes one instagram finding (the Facebook parser drops it)", async () => {
    const body = commentBody("232323232")
    expect(facebookAdapter.parseWebhook?.(body).findings ?? []).toEqual([])
    const ctx = await connected()
    const res = await parseWebhookJob(ctx, { platform: "instagram", body })
    expect(res.ingested).toBe(1)
    const rows = (await ctx.db.findMany("finding", {})) as Array<Record<string, unknown>>
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({
      platform: "instagram",
      external_id: "17865799348089039",
      relation: "comment_on_our_content",
      parent_external_id: "123123123",
      author_handle: "test",
      author_external_id: "232323232",
      content_text: "This is an example.",
      occurred_at: new Date(1520383571 * 1000).toISOString(),
    })
    expect(ctx.__emitted).toContainEqual(
      expect.objectContaining({ entity: "finding", action: "created" }),
    )
  })

  test("a reply to a comment keeps the comment it answers", async () => {
    const body = commentBody("232323232")
    const value = body.entry[0]!.changes[0]!.value as Record<string, unknown>
    value.parent_id = "1231231234"
    const parsed = instagramParseWebhook(body)
    expect(parsed.findings[0]?.replyToExternalId).toBe("1231231234")
  })

  test("the account's own comment is not a finding", async () => {
    const ctx = await connected()
    await parseWebhookJob(ctx, { platform: "instagram", body: commentBody(IG_ID) })
    expect(await ctx.db.count("finding")).toBe(0)
  })

  test("a message becomes an inbound instagram message", async () => {
    const ctx = await connected()
    const res = await parseWebhookJob(ctx, { platform: "instagram", body: messageBody(false) })
    expect(res.messagesIngested).toBe(1)
    const convs = (await ctx.db.findMany("dm_conversation", {})) as Array<Record<string, unknown>>
    expect(convs.map((c) => c.platform)).toEqual(["instagram"])
    const msgs = (await ctx.db.findMany("dm_message", {})) as Array<Record<string, unknown>>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      external_id: "MID_1",
      direction: "inbound",
      body: "hello there",
      occurred_at: new Date(1569262485349).toISOString(),
    })
  })

  test("an echo of our own message is never an inbound message", async () => {
    const ctx = await connected()
    await parseWebhookJob(ctx, { platform: "instagram", body: messageBody(true) })
    const inbound = await ctx.db.count("dm_message", { where: { direction: "inbound" } })
    expect(inbound).toBe(0)
  })

  test("a delivery for an Instagram account with no active connection is dropped and logged", async () => {
    const ctx = ctxWith()
    const infos: string[] = []
    ctx.logger = { info: (msg: string) => infos.push(msg), warn() {}, error() {}, debug() {} }
    const res = await parseWebhookJob(ctx, {
      platform: "instagram",
      body: commentBody("232323232"),
    })
    expect(res).toEqual({ ingested: 0, messagesIngested: 0 })
    expect(await ctx.db.count("finding")).toBe(0)
    expect(
      infos.some((m) => m.includes("Instagram accounts this workspace has not connected")),
    ).toBe(true)
  })
})

describe("upsertDmMessage — repair-on-resync", () => {
  test("an existing message whose direction changed is UPDATED, not frozen by dedup", async () => {
    const db = createMockDb()
    const ctx = ctxWith(db)
    const conv = await db.insert("dm_conversation", {
      platform: "instagram",
      external_id: "t_1",
      status: "open",
    })
    await db.insert("dm_message", {
      conversation_id: conv.id,
      external_id: "m1",
      direction: "inbound",
      body: "our own reply, mislabelled by the self-identity bug",
    })
    const res = await upsertDmMessage(ctx, conv.id, {
      conversationExternalId: "t_1",
      externalId: "m1",
      direction: "outbound",
      body: "our own reply, mislabelled by the self-identity bug",
      occurredAt: "2026-07-02T10:00:00Z",
    })
    expect(res.created).toBe(false)
    const rows = (await db.findMany("dm_message", {
      where: { conversation_id: conv.id, external_id: "m1" },
      limit: 1,
    })) as Array<{ direction: string }>
    expect(rows[0]?.direction).toBe("outbound")
  })
})

describe("two parses of one delivery racing on a new person", () => {
  const uniqueViolation = (table: string) =>
    new Error(
      `Failed query on ${table} — pg: duplicate key value violates unique constraint "${table}_key" (23505)`,
    )

  test("the parse that loses the conversation insert lands its message in the winner's conversation", async () => {
    const db = createMockDb()
    const winner = await db.insert("dm_conversation", {
      platform: "facebook",
      external_id: "psid-race",
      participant_external_id: "psid-race",
      status: "open",
    })
    // This parse read before the other one committed: it sees no conversation, then its insert
    // hits the unique key the other parse just took.
    let stale = true
    const racing = {
      ...db,
      findMany: async (entity: string, opts: unknown) =>
        entity === "dm_conversation" && stale ? [] : db.findMany(entity, opts as never),
      insert: async (entity: string, data: Record<string, unknown>) => {
        if (entity === "dm_conversation" && stale) {
          stale = false
          throw uniqueViolation("dm_conversation")
        }
        return db.insert(entity, data)
      },
    }
    const ctx = ctxWith(racing as never)
    const body = {
      object: "page",
      entry: [
        {
          id: "page-1",
          messaging: [
            {
              sender: { id: "psid-race" },
              recipient: { id: "page-1" },
              timestamp: Date.UTC(2026, 0, 15, 9, 30, 0),
              message: { mid: "m_race", text: "Is it in stock?" },
            },
          ],
        },
      ],
    }
    await parseWebhookJob(ctx, { platform: "facebook", body })
    expect(
      await db.count("dm_conversation", { where: { participant_external_id: "psid-race" } }),
    ).toBe(1)
    const msgs = (await db.findMany("dm_message", { where: { external_id: "m_race" } })) as Array<{
      conversation_id: string
    }>
    expect(msgs.map((m) => m.conversation_id)).toEqual([winner.id])
  })

  test("the parse that loses the message insert reports it as already there", async () => {
    const db = createMockDb()
    const conv = await db.insert("dm_conversation", {
      platform: "facebook",
      external_id: "psid-2",
      status: "open",
    })
    let stale = true
    const racing = {
      ...db,
      findMany: async (entity: string, opts: unknown) =>
        entity === "dm_message" && stale ? [] : db.findMany(entity, opts as never),
      insert: async (entity: string, data: Record<string, unknown>) => {
        if (entity === "dm_message" && stale) {
          stale = false
          await db.insert(entity, data)
          throw uniqueViolation("dm_message")
        }
        return db.insert(entity, data)
      },
    }
    const res = await upsertDmMessage(ctxWith(racing as never), conv.id, {
      conversationExternalId: "psid-2",
      externalId: "m2",
      direction: "inbound",
      body: "hello",
      occurredAt: "2026-07-02T10:00:00Z",
    })
    expect(res).toEqual({ created: false, inbound: true })
    expect(await db.count("dm_message", { where: { external_id: "m2" } })).toBe(1)
  })

  test("any other insert error still fails the parse", async () => {
    const db = createMockDb()
    const failing = {
      ...db,
      insert: async (entity: string, data: Record<string, unknown>) => {
        if (entity === "dm_message")
          throw new Error("pg: permission denied for table dm_message (42501)")
        return db.insert(entity, data)
      },
    }
    const conv = await db.insert("dm_conversation", {
      platform: "facebook",
      external_id: "psid-3",
      status: "open",
    })
    await expect(
      upsertDmMessage(ctxWith(failing as never), conv.id, {
        conversationExternalId: "psid-3",
        externalId: "m3",
        direction: "inbound",
        body: "hello",
      }),
    ).rejects.toThrow("42501")
  })
})
