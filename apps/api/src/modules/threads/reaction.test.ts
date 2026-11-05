// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const publishedEvents: any[] = []
const rlsDb = db as unknown as RlsClient
;(rlsDb as any).queueEvent = async (event: any) => {
  publishedEvents.push(event)
}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async (event: any) => {
      publishedEvents.push(event)
    }
    return fn(tx)
  })
}

import { addReaction, removeReaction } from "~/modules/threads/reaction"

const ORG = "00000000-0000-0000-0000-100000000001"
const USER1 = "00000000-0000-0000-0000-100000000002"
const USER2 = "00000000-0000-0000-0000-100000000003"
let threadId: string
let messageId: string

describe("reaction service", () => {
  beforeAll(async () => {
    // Serialise file-level setup against other tests that write to
    // kernel.organizations / kernel.users / kernel.threads — concurrent
    // FK-touching inserts deadlock under bun's parallel file scheduler.
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'ReactOrg', 'react-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'react1@test.com', 'Reactor1') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER2}, ${ORG}, 'react2@test.com', 'Reactor2') ON CONFLICT (id) DO NOTHING`

    // Create a thread with participants and a message (use unique handle to avoid collisions)
    const uniqueHandle = `thread-react-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const [thread] = await sql`
      INSERT INTO kernel.threads (org_id, handle, created_by) VALUES (${ORG}, ${uniqueHandle}, ${USER1})
      RETURNING id
    `
    threadId = thread.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${USER1}, ${ORG})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${USER2}, ${ORG})`

    const [msg] = await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${threadId}, ${ORG}, ${USER1}, 'React to this', '{}')
      RETURNING id
    `
    messageId = msg.id
  })

  beforeEach(() => {
    publishedEvents.length = 0
  })

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.message_reactions WHERE message_id = ${messageId}`
      await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${threadId}`
      await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    } finally {
      await releaseTestLock()
    }
  })

  it("adds a reaction as a participant", async () => {
    const result = await addReaction(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      messageId,
      emoji: "👍",
    })
    expect(result).not.toBeNull()
    expect(result?.added).toBe(true)
    expect(publishedEvents.some((e) => e.entity === "reaction" && e.action === "add")).toBe(true)
  })

  it("returns added:false when the same reaction already exists (idempotent)", async () => {
    const emoji = "🎊"
    await sql`DELETE FROM kernel.message_reactions WHERE message_id = ${messageId} AND user_id = ${USER2} AND emoji = ${emoji}`

    // First add should succeed
    const first = await addReaction(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      messageId,
      emoji,
    })
    expect(first).not.toBeNull()
    expect(first?.added).toBe(true)

    // Second add with same user + emoji should be idempotent
    const second = await addReaction(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      messageId,
      emoji,
    })
    expect(second).not.toBeNull()
    expect(second?.added).toBe(false)

    // Cleanup
    await sql`DELETE FROM kernel.message_reactions WHERE message_id = ${messageId} AND user_id = ${USER2} AND emoji = ${emoji}`
  })

  it("removes a reaction", async () => {
    await addReaction(rlsDb, { orgId: ORG, userId: USER1, threadId, messageId, emoji: "❤️" })
    publishedEvents.length = 0

    const result = await removeReaction(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      messageId,
      emoji: "❤️",
    })
    expect(result).not.toBeNull()
    expect(result?.removed).toBe(true)
    expect(publishedEvents.some((e) => e.entity === "reaction" && e.action === "remove")).toBe(true)
  })

  it("returns removed: false for non-existent reaction", async () => {
    const result = await removeReaction(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      messageId,
      emoji: "🦄",
    })
    expect(result?.removed).toBe(false)
  })

  it("returns null for non-participant on add", async () => {
    const NON_PARTICIPANT = "00000000-0000-0000-0000-100000000099"
    const result = await addReaction(rlsDb, {
      orgId: ORG,
      userId: NON_PARTICIPANT,
      threadId,
      messageId,
      emoji: "👍",
    })
    expect(result).toBeNull()
  })

  it("returns null for non-participant on remove", async () => {
    const NON_PARTICIPANT = "00000000-0000-0000-0000-100000000099"
    const result = await removeReaction(rlsDb, {
      orgId: ORG,
      userId: NON_PARTICIPANT,
      threadId,
      messageId,
      emoji: "👍",
    })
    expect(result).toBeNull()
  })

  it("returns null when adding reaction to a soft-deleted message (T-4)", async () => {
    // Insert a fresh message and soft-delete it
    const uniqueHandle = `thread-react-del-${Date.now()}`
    const [delThread] = await sql`
      INSERT INTO kernel.threads (org_id, handle, created_by) VALUES (${ORG}, ${uniqueHandle}, ${USER1})
      RETURNING id
    `
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${delThread.id}, ${USER1}, ${ORG})`
    const [delMsg] = await sql`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, deleted_at, required_scopes)
      VALUES (${delThread.id}, ${ORG}, ${USER1}, 'Deleted', now(), '{}')
      RETURNING id
    `
    const result = await addReaction(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId: delThread.id,
      messageId: delMsg.id,
      emoji: "🔥",
    })
    expect(result).toBeNull()

    // Clean up
    await sql`DELETE FROM kernel.messages WHERE id = ${delMsg.id}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${delThread.id}`
    await sql`DELETE FROM kernel.threads WHERE id = ${delThread.id}`
  })
})
