// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S4, A2: GET /threads/:threadId/messages/:messageId/replies returns the root
// and its replies, oldest first, paged like the channel list. It reads under
// the caller's RLS: a root the caller cannot see is 404, never an empty page.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  call,
  plant,
  post,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

let f: ReplyFixture
let root: string
const replyIds: string[] = []

describe("GET .../messages/:messageId/replies (S4, A2)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    root = (await post(f.alice, f.room, { content: "root" })).body.data.id
    for (let i = 1; i <= 5; i++) {
      replyIds.push(
        await plant({
          orgId: f.orgId,
          threadId: f.room,
          authorId: f.bob.userId,
          content: `reply ${i}`,
          replyRootId: root,
          createdAt: `2030-01-01T00:00:0${i}Z`,
        }),
      )
    }
    // A channel message after them, which must not appear.
    await post(f.carol, f.room, { content: "channel chatter" })
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("returns the root and every reply, oldest first", async () => {
    const res = await call(f.carol, "GET", `/threads/${f.room}/messages/${root}/replies`)
    expect(res.status).toBe(200)
    expect(res.body.data.root.id).toBe(root)
    expect(res.body.data.root.content).toBe("root")
    expect(res.body.data.replies.map((m: { id: string }) => m.id)).toEqual(replyIds)
    expect(
      res.body.data.replies.every((m: { replyRootId: string }) => m.replyRootId === root),
    ).toBe(true)
    expect(res.body.meta.hasMore).toBe(false)
  })

  it("pages: the newest page first, then older with the cursor", async () => {
    const first = await call(f.carol, "GET", `/threads/${f.room}/messages/${root}/replies?limit=2`)
    expect(first.body.data.replies.map((m: { id: string }) => m.id)).toEqual(replyIds.slice(3))
    expect(first.body.meta.hasMore).toBe(true)
    const older = await call(
      f.carol,
      "GET",
      `/threads/${f.room}/messages/${root}/replies?limit=2&before=${first.body.meta.cursor}`,
    )
    expect(older.body.data.replies.map((m: { id: string }) => m.id)).toEqual(replyIds.slice(1, 3))
  })

  it("is 404 for a caller who is not in the room", async () => {
    const res = await call(f.outsider, "GET", `/threads/${f.room}/messages/${root}/replies`)
    expect(res.status).toBe(404)
  })

  it("is 404 for a root the caller's scopes hide", async () => {
    const hidden = await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.alice.userId,
      content: "scoped root",
      requiredScopes: ["rtr:secret:read"],
    })
    const res = await call(f.carol, "GET", `/threads/${f.room}/messages/${hidden}/replies`)
    expect(res.status).toBe(404)
  })

  it("serves a deleted root as deleted, with its replies still readable", async () => {
    const gone = await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.alice.userId,
      content: "soon gone",
    })
    await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.bob.userId,
      content: "orphan reply",
      replyRootId: gone,
    })
    await call(f.alice, "DELETE", `/threads/${f.room}/messages/${gone}`)
    const res = await call(f.carol, "GET", `/threads/${f.room}/messages/${gone}/replies`)
    expect(res.status).toBe(200)
    expect(res.body.data.root.deletedAt).not.toBeNull()
    expect(res.body.data.root.content).toBeNull()
    expect(res.body.data.replies.map((m: { content: string }) => m.content)).toEqual([
      "orphan reply",
    ])
  })
})
