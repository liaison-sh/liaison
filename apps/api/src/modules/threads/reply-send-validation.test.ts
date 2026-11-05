// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S2, A15, A2: POST /threads/:threadId/messages takes `replyRootId` and
// `alsoSendToChannel`. A root that is not found, in another thread or hidden
// from the sender reads as 404 (the parent rule); a root that is itself a
// reply, or is deleted, is a 400. A reply inherits its root's scope tag, so a
// member who cannot read the root cannot read the replies either.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  call,
  grantScopeAndRefresh,
  plant,
  post,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

const SECRET = "rsv:deals:read"
let f: ReplyFixture
let root: string

describe("sending a reply (S2, A15, A2)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    const res = await post(f.alice, f.room, { content: "the root" })
    expect(res.status).toBe(200)
    root = res.body.data.id
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("stores a reply under its root and says so in the response", async () => {
    const res = await post(f.bob, f.room, { content: "a reply", replyRootId: root })
    expect(res.status).toBe(200)
    expect(res.body.data.replyRootId).toBe(root)
    expect(res.body.data.alsoInChannel).toBe(false)
    const [row] =
      await sql`SELECT reply_root_id, also_in_channel FROM kernel.messages WHERE id = ${res.body.data.id}`
    expect(row).toEqual({ reply_root_id: root, also_in_channel: false })
  })

  it("stores alsoSendToChannel as also_in_channel", async () => {
    const res = await post(f.bob, f.room, {
      content: "to the channel too",
      replyRootId: root,
      alsoSendToChannel: true,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.alsoInChannel).toBe(true)
  })

  it("refuses alsoSendToChannel without a root", async () => {
    const res = await post(f.bob, f.room, { content: "no root", alsoSendToChannel: true })
    expect(res.status).toBe(400)
  })

  it("answers 404 for a root in another thread, an unknown root, and a root the sender cannot see", async () => {
    const elsewhere = await post(f.alice, f.otherRoom, { content: "elsewhere" })
    expect(
      (await post(f.alice, f.room, { content: "x", replyRootId: elsewhere.body.data.id })).status,
    ).toBe(404)
    expect(
      (await post(f.alice, f.room, { content: "x", replyRootId: crypto.randomUUID() })).status,
    ).toBe(404)
    const hidden = await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.alice.userId,
      content: "scoped root",
      requiredScopes: [SECRET],
    })
    expect((await post(f.bob, f.room, { content: "x", replyRootId: hidden })).status).toBe(404)
  })

  it("answers 400 for a root that is itself a reply, and for a deleted root", async () => {
    const reply = await post(f.bob, f.room, { content: "first level", replyRootId: root })
    const nested = await post(f.carol, f.room, {
      content: "second level",
      replyRootId: reply.body.data.id,
    })
    expect(nested.status).toBe(400)
    expect(nested.body.error?.code).toBe("reply_root_is_reply")

    const gone = await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.alice.userId,
      content: "deleted root",
      deleted: true,
    })
    const onDeleted = await post(f.bob, f.room, { content: "x", replyRootId: gone })
    expect(onDeleted.status).toBe(400)
    expect(onDeleted.body.error?.code).toBe("reply_root_deleted")
  })

  it("a reply inherits its root's scope tag, so a member without the scope reads neither", async () => {
    await grantScopeAndRefresh(f.alice, SECRET)
    await grantScopeAndRefresh(f.bob, SECRET)
    const scopedRoot = await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.alice.userId,
      content: "deal 7 root",
      requiredScopes: [SECRET],
    })
    const reply = await post(f.bob, f.room, { content: "deal 7 reply", replyRootId: scopedRoot })
    expect(reply.status).toBe(200)
    const [row] =
      await sql`SELECT required_scopes FROM kernel.messages WHERE id = ${reply.body.data.id}`
    expect(row.required_scopes).toEqual([SECRET])

    const carolView = await call(f.carol, "GET", `/threads/${f.room}/messages?limit=100`)
    expect(JSON.stringify(carolView.body)).not.toContain("deal 7")
  })
})
