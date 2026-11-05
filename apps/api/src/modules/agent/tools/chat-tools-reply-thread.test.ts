// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A18: the agent's thread tools know reply threads. `threads_read` without a
// root reads the CHANNEL view (a reply appears only when it was also sent to
// the channel); with `replyRootId` it reads that reply thread. `threads_reply`
// with `replyRootId` posts into the reply thread.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { handleThreadsRead, handleThreadsReply } from "~/modules/agent/tools/chat-tools"
import {
  post,
  type ReplyFixture,
  setupReplyFixture,
} from "~/modules/threads/__fixtures__/reply-thread-fixture"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let f: ReplyFixture
let root: string

function actor(): UserContext {
  return {
    actorType: "user",
    userId: f.alice.userId,
    orgId: f.orgId,
    scopes: ["kernel:threads:read", "kernel:threads:write"],
    dimensionGrants: {},
  }
}

async function read(params: { threadId: string; replyRootId?: string }) {
  return withRlsContext(actor(), (tx) =>
    handleThreadsRead(params, { userId: f.alice.userId, orgId: f.orgId, db: tx } as never),
  )
}

describe("threads_read and threads_reply with reply threads (A18)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    f = await setupReplyFixture()
    root = (await post(f.alice, f.room, { content: "the root" })).body.data.id
    await post(f.bob, f.room, { content: "thread-only reply", replyRootId: root })
    await post(f.bob, f.room, {
      content: "reply also in channel",
      replyRootId: root,
      alsoSendToChannel: true,
    })
    await post(f.carol, f.room, { content: "channel line" })
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("threads_read without a root reads the channel view", async () => {
    const result = (await read({ threadId: f.room })) as { messages: Array<{ content: string }> }
    const contents = result.messages.map((m) => m.content)
    expect(contents).toContain("the root")
    expect(contents).toContain("channel line")
    expect(contents).toContain("reply also in channel")
    expect(contents).not.toContain("thread-only reply")
  })

  it("threads_read with a root reads that reply thread, root first", async () => {
    const result = (await read({ threadId: f.room, replyRootId: root })) as {
      messages: Array<{ content: string }>
    }
    expect(result.messages.map((m) => m.content)).toEqual([
      "the root",
      "thread-only reply",
      "reply also in channel",
    ])
  })

  it("threads_reply with a root posts into the reply thread", async () => {
    const result = await withRlsContext(actor(), (tx) =>
      handleThreadsReply({ threadId: f.room, content: "posted by the tool", replyRootId: root }, {
        userId: f.alice.userId,
        orgId: f.orgId,
        db: tx,
        scopes: ["kernel:threads:write"],
        actorType: "agent",
      } as never),
    )
    expect("error" in result).toBe(false)
    const [row] =
      await sql`SELECT reply_root_id FROM kernel.messages WHERE content = 'posted by the tool' AND thread_id = ${f.room}`
    expect(row.reply_root_id).toBe(root)
  })

  // QA THR-10: the seat line an agent mention posts in a reply thread is a
  // system line, not a reply; the agent is told the count people see.
  it("threads_read counts a root's user and agent replies, never a system line", async () => {
    const seatRoot = (await post(f.alice, f.room, { content: "seat root" })).body.data.id
    await post(f.bob, f.room, { content: "the one reply", replyRootId: seatRoot })
    await sql`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id)
      VALUES (${f.room}, ${f.orgId}, ${f.bob.userId}, 'system', 'Bob added Base', '{}'::text[],
              ${seatRoot})`
    const result = (await read({ threadId: f.room })) as {
      messages: Array<{ id: string; replyCount?: number }>
    }
    expect(result.messages.find((m) => m.id === seatRoot)?.replyCount).toBe(1)
  })
})
