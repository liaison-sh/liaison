// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An @-mention of a colleague NOTIFIES that colleague, end to end: the real
// send route (request RLS, mention parsing), the message:create event it
// really queued read back out of the outbox, the real attention translator
// writing its real row, and the mentioned member's own reads of the thread.
//
// The picker offers every member of the org, not only the thread's
// participants. A mention of a member outside the thread used to write them a
// "mentioned you" row for a thread they could not open (the messages policy and
// the push fan-out both read participation), so the mention seats them now,
// the way an agent mention seats the agent. A 1:1 agent chat is the writer's
// private conversation and never gains a member that way.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { type RlsClient, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { AppEvent } from "~/infra/events/event-bus"
import { processTranslationEvent } from "~/modules/attention/translator"
import { sendMessage } from "~/modules/threads/message"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let authorId: string
let authorToken: string
let memberId: string
let memberToken: string

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
}

async function post(threadId: string, content: string): Promise<string> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    method: "POST",
    headers: headers(authorToken),
    body: JSON.stringify({ content }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data: { id: string } }
  return body.data.id
}

/** The message:create event the send queued, exactly as the outbox holds it. */
async function queuedCreateEvent(messageId: string): Promise<AppEvent> {
  const rows = await sql`
    SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId}
      AND payload->>'entity' = 'message'
      AND payload->>'action' = 'create'
      AND payload->>'entityId' = ${messageId}
  `
  expect(rows.length).toBe(1)
  const payload = rows[0].payload
  return (typeof payload === "string" ? JSON.parse(payload) : payload) as AppEvent
}

async function mentionRowsFor(userId: string, threadId: string): Promise<number> {
  const rows = await sql`
    SELECT id FROM kernel.attention_events
    WHERE org_id = ${orgId} AND user_id = ${userId}
      AND app = 'kernel' AND entity_type = 'thread' AND entity_id = ${threadId}
      AND kind = 'mention'
  `
  return rows.length
}

async function isParticipant(userId: string, threadId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM kernel.thread_participants
    WHERE thread_id = ${threadId} AND user_id = ${userId}
  `
  return rows.length > 0
}

/** What the member's own client reads of the thread's messages. */
async function memberReads(threadId: string, messageId: string): Promise<boolean> {
  const res = await app.request(`/api/threads/${threadId}/messages`, {
    headers: headers(memberToken),
  })
  if (res.status !== 200) return false
  const body = (await res.json()) as { data: Array<{ id: string }> }
  return body.data.some((m) => m.id === messageId)
}

describe("an @-mention of a team member notifies that member", () => {
  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    const author = await minimal.session(orgId)
    const member = await minimal.session(orgId)
    authorId = author.userId
    memberId = member.userId
    authorToken = author.bearer
    memberToken = member.bearer
    // The org bootstrap registers every bundled app: well past bun's 5 s.
  }, 60_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  it("writes the mentioned participant a mention row", async () => {
    const threadId = await minimal.thread(orgId, authorId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${memberId}, ${orgId})`

    const messageId = await post(threadId, `@[Member](user:${memberId}) can you check this?`)
    await processTranslationEvent(await queuedCreateEvent(messageId))

    expect(await mentionRowsFor(memberId, threadId)).toBe(1)
    // The writer is never told about their own mention.
    expect(await mentionRowsFor(authorId, threadId)).toBe(0)
    expect(await memberReads(threadId, messageId)).toBe(true)
  })

  it("seats a mentioned member who was not in the thread, so the mention opens", async () => {
    const threadId = await minimal.thread(orgId, authorId)
    expect(await isParticipant(memberId, threadId)).toBe(false)

    const messageId = await post(threadId, `Looping in @[Member](user:${memberId}) on this.`)
    const event = await queuedCreateEvent(messageId)
    await processTranslationEvent(event)

    expect(await isParticipant(memberId, threadId)).toBe(true)
    expect(await mentionRowsFor(memberId, threadId)).toBe(1)
    // The row points at a thread the member can actually read, the message
    // they were mentioned in included.
    expect(await memberReads(threadId, messageId)).toBe(true)
    // The event carries the new seat, the list the push fan-out and the
    // thread_reply translation read.
    const participantIds = (event.data as { participantIds?: string[] }).participantIds ?? []
    expect(participantIds).toContain(memberId)
    const seats = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${orgId}
        AND payload->>'entity' = 'participant'
        AND payload->>'action' = 'add'
        AND payload->>'entityId' = ${threadId}
        AND payload->'data'->>'userId' = ${memberId}
    `
    // One seat for the mentioned member (the thread's creation seats its author too).
    expect(seats.length).toBe(1)
  })

  it("never seats anyone from a 1:1 agent chat", async () => {
    const [chat] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${orgId}, ${`mm-chat-${crypto.randomUUID().slice(0, 8)}`}, 'Me and my agent', 'agent_chat', ${authorId})
      RETURNING id
    `
    const chatId = chat.id as string
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${chatId}, ${authorId}, ${orgId})`

    // Straight through the service: the route would also start the chat's
    // agent turn, which is not what is under test here.
    await withPrivilegedDb(orgId, "test-mm-agent-chat", (tx) =>
      sendMessage(tx as unknown as RlsClient, {
        orgId,
        userId: authorId,
        threadId: chatId,
        content: `What did @[Member](user:${memberId}) decide yesterday?`,
        requiredScopes: [],
      }),
    )

    expect(await isParticipant(memberId, chatId)).toBe(false)
    const [row] = await sql`SELECT type FROM kernel.threads WHERE id = ${chatId}`
    expect(row.type).toBe("agent_chat")
  })

  it("an entity chip (project, task, thread, ticket) notifies and seats no one", async () => {
    // A pasted Liaison link renders as `@[title](app:entity:id)`, the same token
    // a person mention uses. Only the `user:` scheme names a person.
    const threadId = await minimal.thread(orgId, authorId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${memberId}, ${orgId})`

    const messageId = await post(
      threadId,
      [
        `@[Roadmap](projects:project:${crypto.randomUUID()})`,
        `@[Fix login](projects:task:${crypto.randomUUID()})`,
        `@[Earlier chat](thread:${crypto.randomUUID()})`,
        `@[#T-1042](tickets:ticket:${crypto.randomUUID()})`,
      ].join(" "),
    )
    await processTranslationEvent(await queuedCreateEvent(messageId))

    const rows = await sql`
      SELECT id FROM kernel.attention_events
      WHERE org_id = ${orgId} AND kind = 'mention'
        AND entity_type = 'thread' AND entity_id = ${threadId}
    `
    expect(rows.length).toBe(0)
    expect(await mentionRowsFor(memberId, threadId)).toBe(0)
    expect(await mentionRowsFor(authorId, threadId)).toBe(0)
  })
})
