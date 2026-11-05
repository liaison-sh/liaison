// SPDX-License-Identifier: FSL-1.1-ALv2
//
// READ STATE IS THE SERVER'S, AND EVERY DEVICE HEARS IT MOVE. Each HTTP entry
// point that moves a read mark (a thread, a reply thread, attention rows) ends
// with a `kernel:read_state` frame addressed to the reader, so the reader's
// OTHER devices drop the unread state live. Before it, a thread read on the
// phone kept its pill on the laptop until the laptop reloaded its list.
//
// Real routes, real tokens, real request RLS; the frame is captured on the
// event bus's global handlers, the hop the socket fan-out itself listens on.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type AppEvent, onEvent } from "~/infra/events/event-bus"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  call,
  post,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

let f: ReplyFixture
const frames: AppEvent[] = []

onEvent(
  async (event) => {
    if (event.app === "kernel" && event.entity === "read_state") frames.push(event)
  },
  { delivery: "per-replica" },
)

/** The read_state frames addressed to this user since `from`, once the bus has dispatched. */
async function framesFor(userId: string, from: number): Promise<Record<string, unknown>[]> {
  for (let i = 0; i < 50; i++) {
    const found = frames
      .slice(from)
      .map((e) => e.data as Record<string, unknown>)
      .filter((d) => d.forUserId === userId)
    if (found.length > 0) return found
    await new Promise((r) => setTimeout(r, 10))
  }
  return []
}

describe("read marks are broadcast to the reader's devices", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("PATCH /threads/:id/read tells the reader's devices the server's own unread count", async () => {
    const first = (await post(f.alice, f.room, { content: "one" })).body.data.id
    await post(f.alice, f.room, { content: "two" })

    // Read up to the first message only: one is still unread, and the frame says so.
    let from = frames.length
    const partial = await call(f.bob, "PATCH", `/threads/${f.room}/read`, {
      lastReadMessageId: first,
    })
    expect(partial.status).toBe(200)
    expect(partial.body.data).toMatchObject({ ok: true, unreadCount: 1 })
    expect(await framesFor(f.bob.userId, from)).toEqual([
      { forUserId: f.bob.userId, kind: "thread", threadId: f.room, unreadCount: 1 },
    ])

    from = frames.length
    const all = await call(f.bob, "PATCH", `/threads/${f.room}/read`, {})
    expect(all.status).toBe(200)
    expect(await framesFor(f.bob.userId, from)).toEqual([
      { forUserId: f.bob.userId, kind: "thread", threadId: f.room, unreadCount: 0 },
    ])
  })

  it("a refused read mark broadcasts nothing", async () => {
    const from = frames.length
    const refused = await call(f.outsider, "PATCH", `/threads/${f.room}/read`, {})
    expect(refused.status).toBe(403)
    await new Promise((r) => setTimeout(r, 50))
    expect(
      frames.slice(from).filter((e) => (e.data as any).forUserId === f.outsider.userId),
    ).toEqual([])
  })

  it("PATCH /threads/:id/state tells the caller's devices the flags as stored", async () => {
    let from = frames.length
    const muted = await call(f.bob, "PATCH", `/threads/${f.room}/state`, { isMuted: true })
    expect(muted.status).toBe(200)
    expect(await framesFor(f.bob.userId, from)).toEqual([
      {
        forUserId: f.bob.userId,
        kind: "thread_state",
        threadId: f.room,
        isArchived: false,
        isMuted: true,
        isPinned: false,
        notifyAllPosts: false,
      },
    ])

    // A partial write reports the whole stored state: the earlier mute stays.
    from = frames.length
    const pinned = await call(f.bob, "PATCH", `/threads/${f.room}/state`, { isPinned: true })
    expect(pinned.status).toBe(200)
    expect(await framesFor(f.bob.userId, from)).toEqual([
      {
        forUserId: f.bob.userId,
        kind: "thread_state",
        threadId: f.room,
        isArchived: false,
        isMuted: true,
        isPinned: true,
        notifyAllPosts: false,
      },
    ])
    // Nobody else hears that Bob muted the room.
    expect(frames.slice(from).filter((e) => (e.data as any).forUserId !== f.bob.userId)).toEqual([])
    await call(f.bob, "PATCH", `/threads/${f.room}/state`, { isMuted: false, isPinned: false })
  })

  // A channel's "notify me of every message" is the reader's own flag, stored
  // with the others and told to their devices the same way.
  it("PATCH /threads/:id/state stores the every-post opt-in and tells the caller's devices", async () => {
    const from = frames.length
    const on = await call(f.bob, "PATCH", `/threads/${f.room}/state`, { notifyAllPosts: true })
    expect(on.status).toBe(200)
    expect(await framesFor(f.bob.userId, from)).toEqual([
      {
        forUserId: f.bob.userId,
        kind: "thread_state",
        threadId: f.room,
        isArchived: false,
        isMuted: false,
        isPinned: false,
        notifyAllPosts: true,
      },
    ])
    const got = await call<{ notifyAllPosts: boolean }>(f.bob, "GET", `/threads/${f.room}`)
    expect(got.body.data?.notifyAllPosts).toBe(true)
    await call(f.bob, "PATCH", `/threads/${f.room}/state`, { notifyAllPosts: false })
  })

  it("a refused or empty thread state write broadcasts nothing", async () => {
    const from = frames.length
    const refused = await call(f.outsider, "PATCH", `/threads/${f.room}/state`, { isMuted: true })
    expect([403, 404]).toContain(refused.status)
    const empty = await call(f.carol, "PATCH", `/threads/${f.room}/state`, {})
    expect(empty.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    expect(frames.slice(from).filter((e) => (e.data as any).kind === "thread_state")).toEqual([])
  })

  it("POST .../replies/read tells the reader's devices which reply thread was read", async () => {
    const root = (await post(f.alice, f.room, { content: "root" })).body.data.id
    await post(f.bob, f.room, { content: "reply", replyRootId: root })
    const from = frames.length
    const res = await call(f.alice, "POST", `/threads/${f.room}/messages/${root}/replies/read`)
    expect(res.status).toBe(200)
    expect(await framesFor(f.alice.userId, from)).toEqual([
      { forUserId: f.alice.userId, kind: "reply_thread", threadId: f.room, rootId: root },
    ])
  })

  it("POST /attention-items/mark-read tells the reader's devices what was read", async () => {
    const from = frames.length
    const res = await call(f.carol, "POST", "/attention-items/mark-read", {
      app: "kernel",
      entityType: "thread",
      entityId: f.room,
    })
    expect(res.status).toBe(204)
    expect(await framesFor(f.carol.userId, from)).toEqual([
      {
        forUserId: f.carol.userId,
        kind: "attention",
        app: "kernel",
        entityType: "thread",
        entityId: f.room,
      },
    ])
  })
})
