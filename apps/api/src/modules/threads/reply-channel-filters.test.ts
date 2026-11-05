// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A4: a reply that was not sent to the channel is not a CHANNEL event, so every
// channel-level reading leaves it out: the thread list's preview and unread
// count, its unread filter, the push badge, the read mark's latest-message
// fallback (and the channel read refuses such an id), and the add-member
// hidden-history check. A reply sent with "also send to channel" counts like
// any channel message.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { computeUnreadMessageCount } from "~/modules/push/badge-count"
import { listThreads } from "~/modules/threads/thread"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  call,
  plant,
  post,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

const SECRET = "rcf:deals:read"
let f: ReplyFixture
let root: string
let hiddenReply: string

async function roomRow(member: { userId: string; bearer: string }) {
  const res = await call(member, "GET", "/threads")
  expect(res.status).toBe(200)
  return res.body.data.find((t: { id: string }) => t.id === f.room)
}

async function lastRead(userId: string): Promise<string | null> {
  const [row] = await sql`
    SELECT last_read_message_id FROM kernel.user_thread_state
     WHERE thread_id = ${f.room} AND user_id = ${userId}`
  return row?.last_read_message_id ?? null
}

describe("channel-level readings leave channel-hidden replies out (A4)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    root = (await post(f.alice, f.room, { content: "the root" })).body.data.id
    await post(f.bob, f.room, { content: "hidden reply one", replyRootId: root })
    hiddenReply = (await post(f.bob, f.room, { content: "hidden reply two", replyRootId: root }))
      .body.data.id
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("the thread list previews and counts channel messages only", async () => {
    const row = await roomRow(f.carol)
    expect(row.lastMessage.content).toBe("the root")
    expect(row.unreadCount).toBe(1)
  })

  it("the Messages count counts channel messages only", async () => {
    expect(await computeUnreadMessageCount(f.carol.userId, f.orgId)).toBe(1)
  })

  it("the read mark falls back to the latest channel message, and refuses a hidden reply id", async () => {
    const refused = await call(f.carol, "PATCH", `/threads/${f.room}/read`, {
      lastReadMessageId: hiddenReply,
    })
    // THR-09: the reader IS a participant; the id is the problem, and the
    // answer says so rather than "Not a participant of this thread".
    expect(refused.status).toBe(400)
    expect(refused.body.error?.code).toBe("hidden_reply_not_channel_message")
    const ok = await call(f.carol, "PATCH", `/threads/${f.room}/read`, {})
    expect(ok.status).toBe(200)
    expect(await lastRead(f.carol.userId)).toBe(root)
  })

  it("a hidden reply after the read mark leaves the thread out of the unread filter", async () => {
    await post(f.bob, f.room, { content: "hidden reply three", replyRootId: root })
    const unread = await withRlsContext(
      {
        actorType: "user",
        userId: f.carol.userId,
        orgId: f.orgId,
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      (tx) =>
        listThreads(tx, { orgId: f.orgId, userId: f.carol.userId, limit: 50, unreadOnly: true }),
    )
    expect(unread.threads.map((t: { id: string }) => t.id)).not.toContain(f.room)
    // The flag brings it back: that reply IS a channel message.
    await post(f.bob, f.room, { content: "loud", replyRootId: root, alsoSendToChannel: true })
    expect((await roomRow(f.carol)).unreadCount).toBe(1)
  })

  it("the hidden-history check does not count a scoped reply the channel does not show", async () => {
    await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.alice.userId,
      content: "scoped thread reply",
      replyRootId: root,
      requiredScopes: [SECRET],
    })
    const res = await call(
      f.alice,
      "GET",
      `/threads/${f.room}/hidden-history-check?userId=${f.outsider.userId}`,
    )
    expect(res.status).toBe(200)
    expect(res.body.data.wouldHideHistory).toBe(false)
  })
})
