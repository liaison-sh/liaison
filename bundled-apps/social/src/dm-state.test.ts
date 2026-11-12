// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DM conversation state: the reply window input (`last_inbound_at`), the
// snippet and the status lifecycle, through `dmSyncJob` and `send_dm`, plus
// the bounded repair of rows written before the fix. The sync used to write
// the batch-derived `last_inbound_at` on EVERY listed thread, so an unchanged
// thread (no messages fetched) was reset to null and its reply window read
// closed: send_dm refused nearly every prod conversation.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  createMockDb as createSharedMockDb,
  type ManifestSchema,
  type MockDb,
} from "@liaison/test-helpers/mock-db"
import { packCursor } from "./adapters/cursor"
import type { SocialToolCtx } from "./ctx"
import { dmWindowTag } from "./dm-window"
import { dmSyncJob } from "./handlers"
import {
  DM_STATE_REPAIR_BATCH,
  DM_STATE_REPAIR_VERSION,
  ingestDmMessages,
  repairDmConversationState,
} from "./ingest"
import { replyToFinding, sendDm, sendDmPreflight } from "./post-back"

const MANIFEST_SCHEMA = (
  JSON.parse(readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8")) as {
    schema: ManifestSchema
  }
).schema

/** The bridge's rules: orderBy only on declared fields or camelCase base columns. */
function strictDb(): MockDb {
  return createSharedMockDb(
    {},
    { orderByManifestSchema: MANIFEST_SCHEMA, stampCreatedAt: true, bridgeWhereOperators: true },
  )
}

type Route = (
  url: URL,
  init?: { method?: string; body?: unknown },
) => { status?: number; body: unknown } | null

function ctxFor(
  db: MockDb,
  routes: Route[] = [],
): SocialToolCtx & { posts: Array<{ url: string; body: unknown }> } {
  const posts: Array<{ url: string; body: unknown }> = []
  const fetch = (async (url: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === "POST")
      posts.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body })
    for (const r of routes) {
      const res = r(new URL(url), init)
      if (res) return { status: res.status ?? 200, headers: {}, body: JSON.stringify(res.body) }
    }
    return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) }
  }) as SocialToolCtx["fetch"]
  return {
    orgId: "org-1",
    db,
    fetch,
    connections: { getToken: async () => "tok" },
    config: { get: async () => null },
    emit: async () => {},
    logger: {},
    posts,
  }
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const graph = (iso: string) => iso.replace(".000Z", "+0000").replace(/\.\d{3}Z$/, "+0000")

const IG_ME: Route = (u) =>
  u.pathname.endsWith("/me") ? { body: { id: "ig-pro", username: "our_brand" } } : null
function igConversations(convs: Array<{ id: string; updated: string; fan?: string }>): Route {
  return (u) =>
    u.pathname.endsWith("/me/conversations")
      ? {
          body: {
            data: convs.map((c) => ({
              id: c.id,
              updated_time: graph(c.updated),
              participants: {
                data: [
                  { id: "ig1", username: "our_brand" },
                  { id: c.fan ?? `fan-${c.id}`, username: "jamie" },
                ],
              },
            })),
          },
        }
      : null
}
function igMessages(
  convId: string,
  msgs: Array<{ id: string; from: string; at: string; text?: string }>,
): Route {
  return (u) =>
    u.pathname.endsWith(`/${convId}/messages`)
      ? {
          body: {
            data: msgs.map((m) => ({
              id: m.id,
              from: { id: m.from },
              message: m.text ?? m.id,
              created_time: graph(m.at),
            })),
          },
        }
      : null
}

async function seedDmState(
  db: MockDb,
  cursor: string | null = packCursor({ conversations: { hw: null, bf: null } }),
) {
  await db.insert("sync_state", {
    id: "ss-ig",
    platform: "instagram",
    account_external_id: "ig1",
    source_type: "dm",
    cursor,
    active: true,
    // The repair is already done here: these tests exercise the sync itself.
    metadata: { dmStateRepair: { version: DM_STATE_REPAIR_VERSION, offset: 0, done: true } },
  })
}

async function conv(db: MockDb, id: string) {
  return (await db.findOne("dm_conversation", id)) as Record<string, unknown>
}

describe("dmSyncJob keeps the reply window of an unchanged thread", () => {
  test("a thread listed without new messages keeps last_inbound_at, its name, and send_dm stays open", async () => {
    const db = strictDb()
    await seedDmState(db)
    const inboundAt = hoursAgo(2)
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "conv-1",
      participant_external_id: "fan-1",
      participant_handle: "jamie",
      participant_display_name: "jamie",
      last_inbound_at: inboundAt,
      last_message_at: inboundAt,
      status: "open",
    })
    // Graph lists the thread with the same updated_time: unchanged, no /messages fetch,
    // and the participant carries no username this time.
    const ctx = ctxFor(db, [
      IG_ME,
      (u) =>
        u.pathname.endsWith("/me/conversations")
          ? {
              body: {
                data: [
                  {
                    id: "conv-1",
                    updated_time: graph(inboundAt),
                    participants: { data: [{ id: "ig1" }, { id: "fan-1" }] },
                  },
                ],
              },
            }
          : null,
    ])
    await dmSyncJob({}, ctx)
    const row = await conv(db, "c1")
    expect(row.last_inbound_at).toBe(inboundAt)
    expect(row.participant_handle).toBe("jamie")
    expect(dmWindowTag(row.last_inbound_at as string)).toBe("none")
    expect(await sendDmPreflight(ctx, { conversation_id: "c1" })).toEqual({ ok: true })
  })

  test("a newest-first message batch leaves the NEWEST inbound time and snippet, not the oldest", async () => {
    const db = strictDb()
    await seedDmState(db)
    const ctx = ctxFor(db, [
      IG_ME,
      igConversations([{ id: "conv-1", updated: hoursAgo(1) }]),
      igMessages("conv-1", [
        { id: "m3", from: "fan-conv-1", at: hoursAgo(1), text: "newest" },
        { id: "m2", from: "fan-conv-1", at: hoursAgo(5), text: "older" },
        { id: "m1", from: "fan-conv-1", at: hoursAgo(30), text: "oldest" },
      ]),
    ])
    await dmSyncJob({}, ctx)
    const [row] = (await db.findMany("dm_conversation", {
      where: { external_id: "conv-1" },
    })) as Array<Record<string, unknown>>
    expect(Date.parse(row!.last_inbound_at as string)).toBe(
      Date.parse(hoursAgo(1).slice(0, 19) + "Z"),
    )
    expect(row!.last_message_snippet).toBe("newest")
  })
})

describe("conversation status lifecycle", () => {
  async function syncWith(
    db: MockDb,
    msgs: Array<{ id: string; from: string; at: string }>,
    updated: string,
  ) {
    const ctx = ctxFor(db, [
      IG_ME,
      igConversations([{ id: "conv-1", updated }]),
      igMessages("conv-1", msgs),
    ])
    await dmSyncJob({}, ctx)
    const [row] = (await db.findMany("dm_conversation", {
      where: { external_id: "conv-1" },
    })) as Array<Record<string, unknown>>
    return row!
  }

  test("our reply closes a thread (handled); the customer's next message reopens it", async () => {
    const db = strictDb()
    await seedDmState(db)
    const first = await syncWith(
      db,
      [{ id: "m1", from: "fan-conv-1", at: hoursAgo(3) }],
      hoursAgo(3),
    )
    expect(first.status).toBe("open")
    const replied = await syncWith(
      db,
      [
        { id: "m2", from: "ig1", at: hoursAgo(2) },
        { id: "m1", from: "fan-conv-1", at: hoursAgo(3) },
      ],
      hoursAgo(2),
    )
    expect(replied.status).toBe("handled")
    // Our reply does not open the window: it stays keyed on the last INBOUND message.
    expect(Date.parse(replied.last_inbound_at as string)).toBe(
      Date.parse(first.last_inbound_at as string),
    )
    const reopened = await syncWith(
      db,
      [
        { id: "m3", from: "fan-conv-1", at: hoursAgo(1) },
        { id: "m2", from: "ig1", at: hoursAgo(2) },
      ],
      hoursAgo(1),
    )
    expect(reopened.status).toBe("open")
  })

  test("an archived thread reopens on a new inbound message; a snoozed one stays snoozed", async () => {
    for (const [stored, expected] of [
      ["archived", "open"],
      ["snoozed", "snoozed"],
    ] as const) {
      const db = strictDb()
      await seedDmState(db)
      await db.insert("dm_conversation", {
        id: "c1",
        platform: "instagram",
        external_id: "conv-1",
        status: stored,
      })
      const row = await syncWith(
        db,
        [{ id: "m1", from: "fan-conv-1", at: hoursAgo(1) }],
        hoursAgo(1),
      )
      expect(row.status).toBe(expected)
    }
  })
})

describe("DM state repair (rows written before the fix)", () => {
  async function seedBroken(db: MockDb, n: number) {
    for (let i = 0; i < n; i++) {
      await db.insert("dm_conversation", {
        id: `c${i}`,
        platform: "instagram",
        external_id: `conv-${i}`,
        last_inbound_at: null,
        status: "open",
      })
      await db.insert("dm_message", {
        conversation_id: `c${i}`,
        external_id: `in-${i}`,
        direction: "inbound",
        body: "q",
        occurred_at: hoursAgo(3),
      })
      // Every other thread: we answered last (natively), so it should read handled.
      if (i % 2 === 0) {
        await db.insert("dm_message", {
          conversation_id: `c${i}`,
          external_id: `out-${i}`,
          direction: "outbound",
          body: "a",
          occurred_at: hoursAgo(2),
        })
      }
    }
  }

  test("the DM sync repairs stored threads in bounded steps, then stops; a rerun rewrites nothing", async () => {
    const db = strictDb()
    const total = DM_STATE_REPAIR_BATCH + 5
    await seedBroken(db, total)
    await db.insert("sync_state", {
      id: "ss-ig",
      platform: "instagram",
      account_external_id: "ig1",
      source_type: "dm",
      cursor: null,
      active: true,
    })
    const ctx = ctxFor(db, [IG_ME])

    await dmSyncJob({}, ctx)
    const afterOne = (await db.findMany("dm_conversation", { where: { last_inbound_at: null } }))
      .length
    expect(afterOne).toBe(5)
    await dmSyncJob({}, ctx)
    const rows = (await db.findMany("dm_conversation", { limit: 1000 })) as Array<
      Record<string, unknown>
    >
    expect(
      rows.every((r) => r.last_inbound_at && dmWindowTag(r.last_inbound_at as string) === "none"),
    ).toBe(true)
    expect(rows.filter((r) => r.status === "handled").length).toBe(Math.ceil(total / 2))
    expect(rows.filter((r) => r.status === "open").length).toBe(Math.floor(total / 2))
    const ss = (await db.findOne("sync_state", "ss-ig")) as {
      metadata: { dmStateRepair: Record<string, unknown> }
    }
    expect(ss.metadata.dmStateRepair).toEqual({
      version: DM_STATE_REPAIR_VERSION,
      offset: total,
      done: true,
    })

    // Idempotent and finished: the next tick neither scans nor writes.
    const again = await repairDmConversationState(ctx, {
      id: "ss-ig",
      platform: "instagram",
      metadata: ss.metadata,
    })
    expect(again).toEqual({ repaired: 0, scanned: 0, done: true })
    const fresh = await repairDmConversationState(ctx, {
      id: "ss-ig",
      platform: "instagram",
      metadata: {},
    })
    expect(fresh.repaired).toBe(0)
  })
})

describe("send_dm on the repaired lifecycle", () => {
  async function seed(db: MockDb, status: string) {
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "aWdfconversation-thread-id",
      participant_external_id: "IGSID-42",
      last_inbound_at: hoursAgo(2),
      status,
    })
  }

  test("sends to the participant (not the thread id), closes the thread, and a replayed approval sends nothing", async () => {
    const db = strictDb()
    await seed(db, "open")
    const ctx = ctxFor(db, [
      (_, init) => (init?.method === "POST" ? { body: { message_id: "mid" } } : null),
    ])
    const approved = { ...ctx, approval: { approvalRequestId: "appr-1" } }
    expect(await sendDm(approved, { conversation_id: "c1", body: "hello" })).toMatchObject({
      status: "completed",
    })
    expect(ctx.posts.length).toBe(1)
    expect((ctx.posts[0]!.body as { recipient: { id: string } }).recipient.id).toBe("IGSID-42")
    expect((await conv(db, "c1")).status).toBe("handled")

    expect(await sendDm(approved, { conversation_id: "c1", body: "hello" })).toMatchObject({
      status: "noop",
      reason: "already_sent",
    })
    expect(ctx.posts.length).toBe(1)
  })

  test("a follow-up on a handled thread still sends (handled only means we spoke last)", async () => {
    const db = strictDb()
    await seed(db, "handled")
    const ctx = ctxFor(db, [
      (_, init) => (init?.method === "POST" ? { body: { message_id: "mid" } } : null),
    ])
    const res = await sendDm(
      { ...ctx, approval: { approvalRequestId: "appr-2" } },
      { conversation_id: "c1", body: "one more thing" },
    )
    expect(res).toMatchObject({ status: "completed" })
    expect(ctx.posts.length).toBe(1)
  })
})

describe("a duplicate delivery still settles the conversation state", () => {
  test("a message another run already stored (state not yet written) refreshes last_inbound_at", async () => {
    const db = strictDb()
    const ctx = ctxFor(db)
    const conv = await db.insert("dm_conversation", {
      platform: "facebook",
      external_id: "psid-1",
      participant_external_id: "psid-1",
      status: "open",
    })
    const at = hoursAgo(2)
    // The concurrent run inserted the message and has not refreshed the conversation yet.
    await db.insert("dm_message", {
      conversation_id: conv.id,
      external_id: "m_1",
      direction: "inbound",
      body: "In stock?",
      occurred_at: at,
    })
    await ingestDmMessages(
      ctx,
      [
        {
          conversationExternalId: "psid-1",
          externalId: "m_1",
          direction: "inbound",
          body: "In stock?",
          occurredAt: at,
          participantExternalId: "psid-1",
        },
      ],
      new Map([["psid-1", { id: conv.id }]]),
    )
    const row = (await db.findOne("dm_conversation", conv.id)) as {
      last_inbound_at: string | null
      last_message_snippet: string | null
    }
    expect(row.last_inbound_at).not.toBeNull()
    expect(Date.parse(row.last_inbound_at!)).toBe(Date.parse(at))
    expect(row.last_message_snippet).toBe("In stock?")
  })
})

describe("status changes only on a genuinely new inbound message", () => {
  const OLD_AT = hoursAgo(5)
  async function seedArchived(db: MockDb, status: string) {
    const conv = await db.insert("dm_conversation", {
      platform: "facebook",
      external_id: "psid-1",
      participant_external_id: "psid-1",
      last_inbound_at: OLD_AT,
      status,
    })
    // The customer had the last word; an operator then archived (or handled) the thread.
    await db.insert("dm_message", {
      conversation_id: conv.id,
      external_id: "m_old",
      direction: "inbound",
      body: "thanks!",
      occurred_at: OLD_AT,
    })
    return conv.id as string
  }

  test("the repair leaves an archived or handled thread whose last message is inbound as set", async () => {
    for (const status of ["archived", "handled"]) {
      const db = strictDb()
      const id = await seedArchived(db, status)
      // A row the old sync broke: last_inbound_at reset to null.
      await db.update("dm_conversation", id, { last_inbound_at: null })
      await db.insert("sync_state", {
        id: "ss-fb",
        platform: "facebook",
        account_external_id: "page-1",
        source_type: "dm",
        cursor: null,
        active: true,
      })
      const ctx = ctxFor(db)
      await repairDmConversationState(ctx, { id: "ss-fb", platform: "facebook", metadata: {} })
      const row = await conv(db, id)
      expect(row.status).toBe(status)
      // The repair still restores the derived timestamps.
      expect(Date.parse(row.last_inbound_at as string)).toBe(Date.parse(OLD_AT))
    }
  })

  test("a redelivered old message does not reopen an archived thread", async () => {
    const db = strictDb()
    const id = await seedArchived(db, "archived")
    const ctx = ctxFor(db)
    await ingestDmMessages(
      ctx,
      [
        {
          conversationExternalId: "psid-1",
          externalId: "m_old",
          direction: "inbound",
          body: "thanks!",
          occurredAt: OLD_AT,
          participantExternalId: "psid-1",
        },
      ],
      new Map([["psid-1", { id }]]),
    )
    expect((await conv(db, id)).status).toBe("archived")
  })

  test("a genuinely new inbound message reopens an archived thread", async () => {
    const db = strictDb()
    const id = await seedArchived(db, "archived")
    const ctx = ctxFor(db)
    await ingestDmMessages(
      ctx,
      [
        {
          conversationExternalId: "psid-1",
          externalId: "m_new",
          direction: "inbound",
          body: "one more question",
          occurredAt: hoursAgo(1),
          participantExternalId: "psid-1",
        },
      ],
      new Map([["psid-1", { id }]]),
    )
    expect((await conv(db, id)).status).toBe("open")
  })
})

describe("a retry after an unrecorded post never sends twice", () => {
  /** Fails the first write to `entity` made AFTER the external POST went out:
   *  the post succeeded, recording it did not, and the kernel retries the call. */
  function failWriteAfterPost(db: MockDb, entity: string): { db: MockDb; posted: () => void } {
    let posted = false
    let failed = false
    const trip = (e: string) => {
      if (e === entity && posted && !failed) {
        failed = true
        throw new Error("connection reset")
      }
    }
    const wrapped = Object.create(db) as MockDb
    wrapped.insert = (async (e: string, row: Record<string, unknown>) => {
      trip(e)
      return db.insert(e, row)
    }) as MockDb["insert"]
    wrapped.update = (async (e: string, id: string, patch: Record<string, unknown>) => {
      trip(e)
      return db.update(e, id, patch)
    }) as MockDb["update"]
    return { db: wrapped, posted: () => (posted = true) }
  }

  const okPost: Route = (_, init) =>
    init?.method === "POST" ? { body: { message_id: "mid", id: "posted-1" } } : null

  async function seedConv(db: MockDb) {
    await db.insert("dm_conversation", {
      id: "c1",
      platform: "instagram",
      external_id: "thread-1",
      participant_external_id: "IGSID-42",
      last_inbound_at: hoursAgo(2),
      status: "open",
    })
  }

  test("send_dm: the DM went out but recording it failed -> the retry does not POST again", async () => {
    const base = strictDb()
    await seedConv(base)
    const { db, posted } = failWriteAfterPost(base, "dm_message")
    const ctx = ctxFor(db, [
      (u, init) => (init?.method === "POST" ? (posted(), okPost(u, init)) : null),
    ])
    const approved = { ...ctx, approval: { approvalRequestId: "appr-9" } }
    await expect(sendDm(approved, { conversation_id: "c1", body: "hello" })).rejects.toThrow()
    expect(ctx.posts.length).toBe(1)
    const retry = await sendDm(approved, { conversation_id: "c1", body: "hello" })
    expect(ctx.posts.length).toBe(1)
    expect(retry).toMatchObject({ status: "failed", reason: "send_outcome_unknown" })
    const [row] = (await base.findMany("dm_message", {
      where: { approval_request_id: "appr-9" },
    })) as Array<Record<string, unknown>>
    expect((row!.metadata as Record<string, unknown>).needs_check).toBe(true)
  })

  test("send_dm: a platform refusal leaves no row, so a retry of the approval sends once", async () => {
    const db = strictDb()
    await seedConv(db)
    let refuse = true
    const ctx = ctxFor(db, [
      (_, init) =>
        init?.method === "POST"
          ? refuse
            ? { status: 500, body: { error: { message: "x" } } }
            : { body: { message_id: "mid" } }
          : null,
    ])
    const approved = { ...ctx, approval: { approvalRequestId: "appr-10" } }
    expect(await sendDm(approved, { conversation_id: "c1", body: "hello" })).toMatchObject({
      status: "failed",
      reason: "blocked",
    })
    expect(await db.count("dm_message", { where: { conversation_id: "c1" } })).toBe(0)
    refuse = false
    expect(await sendDm(approved, { conversation_id: "c1", body: "hello" })).toMatchObject({
      status: "completed",
    })
    expect(ctx.posts.length).toBe(2)
    const [row] = (await db.findMany("dm_message", {
      where: { approval_request_id: "appr-10" },
    })) as Array<Record<string, unknown>>
    expect(row!.delivery_status).toBe("sent")
    expect(await sendDm(approved, { conversation_id: "c1", body: "hello" })).toMatchObject({
      status: "noop",
      reason: "already_sent",
    })
    expect(ctx.posts.length).toBe(2)
  })

  test("reply_to_finding: the reply went out but marking the finding failed -> the retry does not POST again", async () => {
    const base = strictDb()
    await base.insert("finding", {
      id: "f1",
      platform: "instagram",
      external_id: "c-1",
      relation: "comment_on_our_content",
      status: "new",
    })
    const { db, posted } = failWriteAfterPost(base, "finding")
    const ctx = ctxFor(db, [
      (u, init) => (init?.method === "POST" ? (posted(), okPost(u, init)) : null),
    ])
    const approved = { ...ctx, approval: { approvalRequestId: "appr-11" } }
    await expect(
      replyToFinding(approved, { finding_id: "f1", reply_text: "thanks!" }),
    ).rejects.toThrow()
    expect(ctx.posts.length).toBe(1)
    // The outcome stays unknown: the retry throws, so the approval waits for its reconciler.
    await expect(
      replyToFinding(approved, { finding_id: "f1", reply_text: "thanks!" }),
    ).rejects.toThrow(/send_outcome_unknown/)
    expect(ctx.posts.length).toBe(1)
  })
})
