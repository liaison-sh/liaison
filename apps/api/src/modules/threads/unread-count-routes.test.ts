// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S8, A14: GET /threads/unread-count is the total the desktop and web
// Messages entry shows. The client used to add up the thread list it holds,
// which is the 50 most recently active threads, so unread messages in older
// threads never reached the badge. The route answers with `computeUnreadMessageCount`,
// the count the app icon already shows, run under the caller's RLS.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  call,
  type Member,
  plant,
  type ReplyFixture,
  setupReplyFixture,
} from "./__fixtures__/reply-thread-fixture"

const THREADS = 60

let f: ReplyFixture
const threadIds: string[] = []

async function unreadCount(member: Member): Promise<number> {
  const res = await call<{ count: number }>(member, "GET", "/threads/unread-count")
  expect(res.status).toBe(200)
  return res.body.data!.count
}

describe("GET /threads/unread-count (S8, A14)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    // 60 threads Bob writes in twice each, Alice never opened any of them.
    for (let i = 0; i < THREADS; i++) {
      const threadId = await minimal.thread(f.orgId, f.bob.userId)
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${f.alice.userId}, ${f.orgId})`
      for (const content of ["one", "two"]) {
        await plant({ orgId: f.orgId, threadId, authorId: f.bob.userId, content })
      }
      threadIds.push(threadId)
    }
  }, 120_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("counts every unread message, past the 50 threads the client list holds", async () => {
    // The discriminator: the list the client sums is capped at 50 threads.
    const list = await call(f.alice, "GET", "/threads?limit=50")
    expect((list.body.data as unknown[]).length).toBe(50)
    expect(await unreadCount(f.alice)).toBe(THREADS * 2)
  })

  it("drops a thread's messages once it is read", async () => {
    const read = await call(f.alice, "PATCH", `/threads/${threadIds[0]}/read`, {})
    expect(read.status).toBe(200)
    expect(await unreadCount(f.alice)).toBe(THREADS * 2 - 2)
  })

  it("is the caller's own count: the author has nothing unread", async () => {
    expect(await unreadCount(f.bob)).toBe(0)
  })

  it("needs a session", async () => {
    const res = await call(
      { userId: f.alice.userId, bearer: "nope" },
      "GET",
      "/threads/unread-count",
    )
    expect(res.status).toBe(401)
  })
})
