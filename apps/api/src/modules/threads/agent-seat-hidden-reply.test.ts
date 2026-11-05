// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A seat summoned from a HIDDEN reply (a reply not also sent to the channel,
// A8/S8) must not strand the agent's channel history.
//
// The seat used to be anchored on the hidden reply itself, and `agentJoinPoint`
// returned that reply as the join point. The channel's raw tail leaves hidden
// replies out, so the join point was never found in it and the tail became
// EMPTY: every later channel turn of that agent ran with no channel history at
// all, and its checkpoint never advanced.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { loadBoundedHistory } from "~/modules/agent/context/checkpoint"
import { addAgentParticipant } from "~/modules/threads/participant"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "5b000000-0000-4000-8000-000000000001"
const USER_ID = "5b000000-0000-4000-8000-000000000002"
const AGENT_ID = "5b000000-0000-4000-8000-000000000003"
const ROOM = "5b000000-0000-4000-8000-000000000004"
const LEGACY_ROOM = "5b000000-0000-4000-8000-000000000005"

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function seedRoom(threadId: string, handle: string): Promise<void> {
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${ORG_ID}, ${handle}, 'thread', ${USER_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${threadId}, ${USER_ID}, ${ORG_ID})`
}

async function post(threadId: string, content: string, replyRootId?: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes, reply_root_id)
    VALUES (${id}, ${threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${content}, '{}', ${replyRootId ?? null})`
  return id
}

async function channelHistoryIds(threadId: string): Promise<string[]> {
  const loaded = await loadBoundedHistory({
    threadId,
    orgId: ORG_ID,
    actor,
    agentId: AGENT_ID,
    contextWindow: 200_000,
  })
  return loaded.messages.map((m) => m.id)
}

describe("a seat summoned from a hidden reply", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'HiddenSeatOrg', 'hidden-seat-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'hidden-seat@test.com', 'Hidden Seat')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'role', '@hiddenseat', 'Hidden Seat', '["*"]'::jsonb, 'You help.')`
    await seedRoom(ROOM, "hidden-seat-room")
    await seedRoom(LEGACY_ROOM, "hidden-seat-legacy-room")
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID} AND reply_root_id IS NOT NULL`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("keeps the root and the later channel message in the agent's channel history", async () => {
    const rootId = await post(ROOM, "Where is the March export?")
    const hiddenReplyId = await post(ROOM, "@[Hidden Seat] can you check?", rootId)
    await withPrivilegedDb(ORG_ID, "hidden-seat-test", (db) =>
      addAgentParticipant(db as unknown as RlsClient, {
        orgId: ORG_ID,
        threadId: ROOM,
        agentId: AGENT_ID,
        actorUserId: USER_ID,
        joinedAtMessageId: hiddenReplyId,
      }),
    )
    const laterId = await post(ROOM, "Separate question for the channel.")

    const ids = await channelHistoryIds(ROOM)
    expect(ids).toContain(rootId)
    expect(ids).toContain(laterId)
    expect(ids).not.toContain(hiddenReplyId)
  })

  it("a seat already stored on a hidden reply still finds its channel join point", async () => {
    const rootId = await post(LEGACY_ROOM, "Earlier root")
    const hiddenReplyId = await post(LEGACY_ROOM, "hidden reply", rootId)
    // A seat written before the fix: stamped at the hidden reply's own instant.
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type, created_at)
      SELECT ${LEGACY_ROOM}, ${AGENT_ID}, ${ORG_ID}, 'agent', m.created_at
      FROM kernel.messages m WHERE m.id = ${hiddenReplyId}`
    const laterId = await post(LEGACY_ROOM, "Later channel message")

    const ids = await channelHistoryIds(LEGACY_ROOM)
    expect(ids).toContain(laterId)
    expect(ids).not.toContain(rootId)
  })
})
