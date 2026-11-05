// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S13, A1: a message may quote an excerpt of another message of the same
// channel. The server resolves the quote under the sender's RLS, names its
// author itself, and refuses a quote of another channel's message or an excerpt
// the quoted message does not contain (whitespace-normalised). The quoting
// message inherits the quoted one's scope tag and disclosure, so quoting a
// scoped message never republishes it to the room.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
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

const SECRET = "qr:deals:read"
let f: ReplyFixture
let source: string

describe("quote-reply (S13, A1)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    source = (
      await post(f.alice, f.room, {
        content: "The shipment  leaves on\nMonday morning, not Friday.",
      })
    ).body.data.id
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("stores the quote with the server's author name and the root it lives under", async () => {
    const res = await post(f.bob, f.room, {
      content: "Are we sure?",
      quote: { messageId: source, excerpt: "leaves on Monday morning" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.metadata.quote).toEqual({
      messageId: source,
      excerpt: "leaves on Monday morning",
      authorName: "Alice",
      replyRootId: null,
    })
  })

  it("records the quoted message's reply root when it is a reply", async () => {
    const reply = (
      await post(f.bob, f.room, { content: "in the thread, yes", replyRootId: source })
    ).body.data.id
    const res = await post(f.carol, f.room, {
      content: "quoting the thread",
      quote: { messageId: reply, excerpt: "in the thread" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.metadata.quote.replyRootId).toBe(source)
  })

  it("accepts an excerpt the client cut with an ellipsis", async () => {
    const res = await post(f.bob, f.room, {
      content: "cut",
      quote: { messageId: source, excerpt: "The shipment leaves…" },
    })
    expect(res.status).toBe(200)
  })

  it("refuses a message of another channel, an excerpt it does not contain, and an excerpt over 500", async () => {
    const elsewhere = (await post(f.alice, f.otherRoom, { content: "other channel text" })).body
      .data.id
    const cross = await post(f.alice, f.room, {
      content: "x",
      quote: { messageId: elsewhere, excerpt: "other channel" },
    })
    expect(cross.status).toBe(400)
    const invented = await post(f.bob, f.room, {
      content: "x",
      quote: { messageId: source, excerpt: "leaves on Sunday" },
    })
    expect(invented.status).toBe(400)
    const long = await post(f.bob, f.room, {
      content: "x",
      quote: { messageId: source, excerpt: "a".repeat(501) },
    })
    expect(long.status).toBe(400)
  })

  it("a quote of a scoped message carries its scope, so a member without it cannot read the quote", async () => {
    await grantScopeAndRefresh(f.alice, SECRET)
    await grantScopeAndRefresh(f.bob, SECRET)
    const scoped = await plant({
      orgId: f.orgId,
      threadId: f.room,
      authorId: f.alice.userId,
      content: "deal 9 margin is 4 percent",
      requiredScopes: [SECRET],
    })
    const res = await post(f.bob, f.room, {
      content: "noted",
      quote: { messageId: scoped, excerpt: "margin is 4 percent" },
    })
    expect(res.status).toBe(200)
    const [row] =
      await sql`SELECT required_scopes FROM kernel.messages WHERE id = ${res.body.data.id}`
    expect(row.required_scopes).toEqual([SECRET])
    const carolView = await call(f.carol, "GET", `/threads/${f.room}/messages?limit=100`)
    expect(carolView.status).toBe(200)
    expect(JSON.stringify(carolView.body)).not.toContain("4 percent")
    // A member who cannot read the source cannot quote it either.
    const blind = await post(f.carol, f.room, {
      content: "x",
      quote: { messageId: scoped, excerpt: "margin" },
    })
    expect(blind.status).toBe(400)
  })
})
