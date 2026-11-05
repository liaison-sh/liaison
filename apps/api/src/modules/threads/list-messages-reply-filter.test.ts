// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S3: the channel list (GET /threads/:id/messages, no reply root) leaves a
// reply out unless it was sent with "also send to channel", and then carries it
// flagged `alsoInChannel`. Every root carries its reply summary: how many
// replies, when the last one came, and up to three repliers.

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
let root: string
let hiddenReply: string
let flaggedReply: string

describe("the channel list and reply threads (S3)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    root = (await post(f.alice, f.room, { content: "root message" })).body.data.id
    hiddenReply = (await post(f.bob, f.room, { content: "thread only", replyRootId: root })).body
      .data.id
    await post(f.carol, f.room, { content: "carol in thread", replyRootId: root })
    flaggedReply = (
      await post(f.bob, f.room, {
        content: "thread and channel",
        replyRootId: root,
        alsoSendToChannel: true,
      })
    ).body.data.id
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("leaves out a reply posted without the flag, and flags the one posted with it", async () => {
    const res = await call(f.carol, "GET", `/threads/${f.room}/messages`)
    expect(res.status).toBe(200)
    const ids = res.body.data.map((m: { id: string }) => m.id)
    expect(ids).not.toContain(hiddenReply)
    expect(ids).toContain(root)
    expect(ids).toContain(flaggedReply)
    const flagged = res.body.data.find((m: { id: string }) => m.id === flaggedReply)
    expect(flagged.alsoInChannel).toBe(true)
    expect(flagged.replyRootId).toBe(root)
  })

  it("carries the reply summary on the root", async () => {
    const res = await call(f.alice, "GET", `/threads/${f.room}/messages`)
    const rootRow = res.body.data.find((m: { id: string }) => m.id === root)
    expect(rootRow.replyRootId).toBeNull()
    expect(rootRow.replyCount).toBe(3)
    expect(typeof rootRow.lastReplyAt).toBe("string")
    const names = rootRow.replyAuthors.map((a: { name: string }) => a.name).sort()
    expect(names).toEqual(["Bob", "Carol"])
    for (const a of rootRow.replyAuthors) {
      expect(Object.keys(a).sort()).toEqual(["avatarUrl", "id", "name"])
    }
  })

  it("a message with no replies says so", async () => {
    const res = await call(f.alice, "GET", `/threads/${f.room}/messages`)
    const flagged = res.body.data.find((m: { id: string }) => m.id === flaggedReply)
    expect(flagged.replyCount).toBe(0)
    expect(flagged.lastReplyAt).toBeNull()
    expect(flagged.replyAuthors).toEqual([])
  })

  // QA THR-10: the "Taylor added Base" line an agent mention posts in the
  // reply thread is a system line, not a reply: it read "3 replies" for two.
  it("counts only user and agent replies: a system line in the thread is not a reply", async () => {
    const seatRoot = (await post(f.alice, f.room, { content: "seat root" })).body.data.id
    await post(f.bob, f.room, { content: "first reply", replyRootId: seatRoot })
    const second = (await post(f.carol, f.room, { content: "second reply", replyRootId: seatRoot }))
      .body.data
    await sql`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id, created_at)
      VALUES (${f.room}, ${f.orgId}, ${f.alice.userId}, 'system', 'Alice added Base', '{}'::text[],
              ${seatRoot}, now() + interval '1 minute')`
    const res = await call(f.alice, "GET", `/threads/${f.room}/messages`)
    const rootRow = res.body.data.find((m: { id: string }) => m.id === seatRoot)
    expect(rootRow.replyCount).toBe(2)
    expect(new Date(rootRow.lastReplyAt).getTime()).toBe(new Date(second.createdAt).getTime())
    const names = rootRow.replyAuthors.map((a: { name: string }) => a.name).sort()
    expect(names).toEqual(["Bob", "Carol"])
  })
})
