// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S6, A6: a reply notifies its FOLLOWERS (never the one who wrote it) with the
// `thread_followup` kind, and the channel's `thread_reply` does not fire for a
// reply the channel does not show. "Also send to channel" keeps the channel
// notification. A mention inside a reply notifies as a mention, as it always
// has. The kind is registered everywhere kinds are declared.
//
// End to end on the server: the real send route, the event it really queued,
// the real translator writing its real rows.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { ATTENTION_KINDS, groupForKind, NOTIFICATION_GROUPS } from "@liaison/shared"
import { sql } from "~/db"
import { appManifestJsonSchema } from "~/modules/apps/manifest-schema"
import { buildDeepLinkPath } from "~/modules/attention/digest"
import { processTranslationEvent } from "~/modules/attention/translator"
import {
  call,
  post,
  queuedEvent,
  type ReplyFixture,
  setupReplyFixture,
} from "~/modules/threads/__fixtures__/reply-thread-fixture"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let f: ReplyFixture

async function rowsFor(userId: string, kind: string) {
  return sql<{ metadata: Record<string, unknown> | null }[]>`
    SELECT metadata FROM kernel.attention_events
    WHERE org_id = ${f.orgId} AND user_id = ${userId}
      AND app = 'kernel' AND entity_type = 'thread' AND entity_id = ${f.room}
      AND kind = ${kind}`
}

/** Every followup row a user holds in this org, whatever it is keyed on. */
async function followups(userId: string) {
  return sql<
    {
      entity_type: string
      entity_id: string
      read_at: Date | null
      metadata: Record<string, unknown> | null
    }[]
  >`
    SELECT entity_type, entity_id, read_at, metadata FROM kernel.attention_events
    WHERE org_id = ${f.orgId} AND user_id = ${userId} AND app = 'kernel'
      AND kind = 'thread_followup'
    ORDER BY occurred_at`
}

async function send(member: ReplyFixture["alice"], body: Record<string, unknown>) {
  const res = await post(member, f.room, body)
  expect(res.status).toBe(200)
  await processTranslationEvent(await queuedEvent(f.orgId, "message", "create", res.body.data.id))
  return res.body.data.id as string
}

async function clearRows() {
  await sql`DELETE FROM kernel.attention_events WHERE org_id = ${f.orgId}`
}

describe("thread_followup notifications (S6, A6)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("a reply notifies the followers with thread_followup, and not the channel", async () => {
    const root = await send(f.alice, { content: "root" })
    await clearRows()
    await send(f.bob, { content: "a reply", replyRootId: root })

    const alice = await followups(f.alice.userId)
    expect(alice.length).toBe(1)
    expect(alice[0].metadata?.replyRootId).toBe(root)
    // Bob wrote it; Carol does not follow and the channel is not told.
    expect((await followups(f.bob.userId)).length).toBe(0)
    expect((await followups(f.carol.userId)).length).toBe(0)
    expect((await rowsFor(f.carol.userId, "thread_reply")).length).toBe(0)
    expect((await rowsFor(f.alice.userId, "thread_reply")).length).toBe(0)
  })

  it("also sent to the channel, the channel is told as it always was", async () => {
    const root = await send(f.alice, { content: "root 2" })
    await clearRows()
    await send(f.bob, { content: "loud reply", replyRootId: root, alsoSendToChannel: true })
    expect((await rowsFor(f.carol.userId, "thread_reply")).length).toBe(1)
    expect((await followups(f.alice.userId)).length).toBe(1)
    // THR-08: Alice follows the root, so the followup is her one notification
    // for this reply: no channel `thread_reply` on top of it.
    expect((await rowsFor(f.alice.userId, "thread_reply")).length).toBe(0)
  })

  it("each followed root has its own followup row, read on its own", async () => {
    const roots = [
      await send(f.alice, { content: "root A" }),
      await send(f.alice, { content: "root B" }),
      await send(f.alice, { content: "root C" }),
    ]
    await clearRows()
    for (const root of roots) await send(f.bob, { content: `reply on ${root}`, replyRootId: root })

    const rows = await followups(f.alice.userId)
    expect(rows.length).toBe(3)
    expect(rows.map((r) => r.metadata?.replyRootId)).toEqual(roots)
    expect(rows.every((r) => r.read_at === null)).toBe(true)
    // The row names its channel, so the feed and the digest link open it there.
    expect(rows[0].metadata?.threadId).toBe(f.room)
    expect(buildDeepLinkPath("kernel", rows[0].entity_type, rows[0].entity_id, f.room)).toBe(
      `/threads/${f.room}`,
    )

    // Opening the channel (its read mark, and the feed's mark on the channel
    // entity) is not reading a reply thread.
    expect((await call(f.alice, "PATCH", `/threads/${f.room}/read`, {})).status).toBe(200)
    const feedMark = await call(f.alice, "POST", "/attention-items/mark-read", {
      app: "kernel",
      entityType: "thread",
      entityId: f.room,
    })
    expect(feedMark.status).toBe(204)
    expect((await followups(f.alice.userId)).every((r) => r.read_at === null)).toBe(true)

    // Reading root B's reply thread clears root B's row, and only that one.
    const read = await call(f.alice, "POST", `/threads/${f.room}/messages/${roots[1]}/replies/read`)
    expect(read.status).toBe(200)
    const after = await followups(f.alice.userId)
    const unread = after.filter((r) => r.read_at === null).map((r) => r.metadata?.replyRootId)
    expect(unread).toEqual([roots[0], roots[2]])
  })

  it("a mention in a reply is a mention, and the mention row knows the reply thread", async () => {
    const root = await send(f.alice, { content: "root 3" })
    await clearRows()
    await send(f.bob, {
      content: `@[Carol](user:${f.carol.userId}) can you look`,
      replyRootId: root,
    })
    const mention = await rowsFor(f.carol.userId, "mention")
    expect(mention.length).toBe(1)
    expect(mention[0].metadata?.replyRootId).toBe(root)
    // Carol follows now, but the mention already told her: no second row.
    expect((await followups(f.carol.userId)).length).toBe(0)
  })

  it("the kind is declared everywhere kinds are declared", () => {
    expect(ATTENTION_KINDS).toContain("thread_followup")
    expect(groupForKind("thread_followup")).toBe("direct")
    expect(NOTIFICATION_GROUPS.find((g) => g.id === "direct")?.kinds).toContain("thread_followup")
    expect(JSON.stringify(appManifestJsonSchema)).toContain('"thread_followup"')
  })
})
