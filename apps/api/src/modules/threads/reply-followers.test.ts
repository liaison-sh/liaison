// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S5, A2: a reply makes followers of the root's author, the replier and every
// member mentioned in the reply. Somebody mentioned who is not a member of the
// room never becomes a follower of it. The replier's own read mark moves to
// their reply, so their own words are never unread to them.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  followersOf,
  post,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

let f: ReplyFixture

describe("reply-thread followers (S5, A2)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("a reply makes the root's author and the replier followers, nobody else", async () => {
    const root = (await post(f.alice, f.room, { content: "root" })).body.data.id
    expect(await followersOf(root)).toEqual([])
    await post(f.bob, f.room, { content: "reply", replyRootId: root })
    expect(await followersOf(root)).toEqual([f.alice.userId, f.bob.userId].sort())
    const [bobRow] = await sql`
      SELECT last_read_at FROM kernel.reply_thread_followers
       WHERE root_message_id = ${root} AND user_id = ${f.bob.userId}`
    expect(bobRow.last_read_at).not.toBeNull()
    const [aliceRow] = await sql`
      SELECT last_read_at FROM kernel.reply_thread_followers
       WHERE root_message_id = ${root} AND user_id = ${f.alice.userId}`
    expect(aliceRow.last_read_at).toBeNull()
  })

  it("a member mentioned in a reply follows it", async () => {
    const root = (await post(f.alice, f.room, { content: "root 2" })).body.data.id
    await post(f.bob, f.room, {
      content: `@[Carol](user:${f.carol.userId}) have a look`,
      replyRootId: root,
    })
    expect(await followersOf(root)).toEqual([f.alice.userId, f.bob.userId, f.carol.userId].sort())
  })

  it("a mentioned user who does not end up in the room is not a follower", async () => {
    // Somebody who is not a member of this org is never seated by a mention, so
    // the mention stays a name and the person stays outside the room.
    const stranger = crypto.randomUUID()
    const root = (await post(f.alice, f.room, { content: "root 3" })).body.data.id
    const res = await post(f.alice, f.room, {
      content: `@[Stranger](user:${stranger}) fyi`,
      replyRootId: root,
    })
    expect(res.status).toBe(200)
    expect(await followersOf(root)).toEqual([f.alice.userId])
  })
})
