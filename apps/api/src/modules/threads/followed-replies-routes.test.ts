// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S7, A20, A2: GET /threads/followed-replies lists the reply threads the
// caller follows, unread first and then by last reply, newest first. POST
// .../replies/read moves the read mark. Rows whose root the caller can no
// longer see, or whose channel the caller left, are dropped.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  call,
  post,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

let f: ReplyFixture
let rootA: string
let rootB: string

interface FollowedRow {
  rootMessage: { id: string; content: string | null }
  channel: { id: string; name: string | null }
  replyCount: number
  lastReplyAt: string
  unreadCount: number
}

async function followed(member = f.alice): Promise<FollowedRow[]> {
  const res = await call(member, "GET", "/threads/followed-replies")
  expect(res.status).toBe(200)
  return res.body.data as FollowedRow[]
}

describe("followed reply threads (S7, A20, A2)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    await sql`UPDATE kernel.threads SET title = 'General' WHERE id = ${f.room}`
    rootA = (await post(f.alice, f.room, { content: "root A" })).body.data.id
    rootB = (await post(f.alice, f.room, { content: "root B" })).body.data.id
    // B gets its reply first, A second: A is the newer thread.
    await post(f.bob, f.room, { content: "on B", replyRootId: rootB })
    await post(f.bob, f.room, { content: "on A", replyRootId: rootA })
    await post(f.carol, f.room, { content: "on A again", replyRootId: rootA })
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("lists what the caller follows, newest thread first, with counts and the channel", async () => {
    const rows = await followed()
    expect(rows.map((r) => r.rootMessage.id)).toEqual([rootA, rootB])
    expect(rows[0]).toMatchObject({
      channel: { id: f.room, name: "General" },
      replyCount: 2,
      unreadCount: 2,
    })
    expect(rows[1].replyCount).toBe(1)
    expect(rows[1].unreadCount).toBe(1)
  })

  it("the read mark clears the unread count, and unread threads come first", async () => {
    const read = await call(f.alice, "POST", `/threads/${f.room}/messages/${rootA}/replies/read`)
    expect(read.status).toBe(200)
    const rows = await followed()
    expect(rows.map((r) => r.rootMessage.id)).toEqual([rootB, rootA])
    expect(rows.find((r) => r.rootMessage.id === rootA)?.unreadCount).toBe(0)
  })

  // QA THR-10: a system line in a reply thread (an agent's seat line) is not
  // a reply: it neither counts, nor dates the thread, nor reads as unread.
  it("counts only user and agent replies, and a system line is never unread", async () => {
    const seatRoot = (await post(f.alice, f.room, { content: "seat root" })).body.data.id
    const reply = (await post(f.bob, f.room, { content: "the one reply", replyRootId: seatRoot }))
      .body.data
    await sql`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id, created_at)
      VALUES (${f.room}, ${f.orgId}, ${f.bob.userId}, 'system', 'Bob added Base', '{}'::text[],
              ${seatRoot}, now() + interval '1 minute')`
    const row = (await followed()).find((r) => r.rootMessage.id === seatRoot)
    expect(row?.replyCount).toBe(1)
    expect(row?.unreadCount).toBe(1)
    expect(new Date(row?.lastReplyAt ?? 0).getTime()).toBe(new Date(reply.createdAt).getTime())
    await call(f.alice, "POST", `/threads/${f.room}/messages/${seatRoot}/replies/read`)
    const onlySystem = (await post(f.alice, f.room, { content: "quiet root" })).body.data.id
    await sql`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id)
      VALUES (${f.room}, ${f.orgId}, ${f.bob.userId}, 'system', 'Bob added Base', '{}'::text[],
              ${onlySystem})`
    const rows = await followed()
    expect(rows.map((r) => r.rootMessage.id)).not.toContain(onlySystem)
    // Read the thread whose only fresh line is a system line: nothing unread.
    await sql`
      UPDATE kernel.reply_thread_followers
      SET last_read_at = ${reply.createdAt}::timestamptz + interval '1 millisecond'
      WHERE root_message_id = ${seatRoot} AND user_id = ${f.alice.userId}`
    const after = (await followed()).find((r) => r.rootMessage.id === seatRoot)
    expect(after?.unreadCount).toBe(0)
    // Leave the list as the later cases expect it.
    await sql`DELETE FROM kernel.reply_thread_followers WHERE root_message_id IN (${seatRoot}, ${onlySystem})`
  })

  it("the read route is 404 on a root the caller cannot see", async () => {
    const res = await call(f.outsider, "POST", `/threads/${f.room}/messages/${rootA}/replies/read`)
    expect(res.status).toBe(404)
  })

  it("drops a thread whose root the caller can no longer see", async () => {
    await sql`UPDATE kernel.messages SET required_scopes = ${["frr:secret:read"]}::text[] WHERE id = ${rootB}`
    const rows = await followed()
    expect(rows.map((r) => r.rootMessage.id)).toEqual([rootA])
    await sql`UPDATE kernel.messages SET required_scopes = '{}'::text[] WHERE id = ${rootB}`
  })

  it("drops every thread of a channel the caller left", async () => {
    expect((await followed(f.bob)).length).toBe(2)
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${f.room} AND user_id = ${f.bob.userId}`
    expect(await followed(f.bob)).toEqual([])
  })
})
