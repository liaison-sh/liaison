// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mention auto-add seat and the join point it anchors (spec-agents.md S9,
// spec-memory.md I5).
//
// A mention is persisted BEFORE the mentioned agent is seated. The seat's
// `created_at` is the anchor `agentJoinPoint` slices the rendered tail at, so a
// seat stamped `now()` anchors PAST the very message that summoned the agent:
// the turn is assembled with no user message in it at all, and the model
// answers from whatever else the prompt still carries (the runtime context's
// pending approvals block, the recalled memory block, its own charter), which
// is what reads in the room as an answer replayed from another conversation.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { RlsClient } from "~/db"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { loadBoundedHistory } from "~/modules/agent/context/checkpoint"
import { addAgentParticipant } from "~/modules/threads/participant"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "5a000000-0000-4000-8000-000000000001"
const USER_ID = "5a000000-0000-4000-8000-000000000002"
const AGENT_ID = "5a000000-0000-4000-8000-000000000003"
const ROOM = "5a000000-0000-4000-8000-000000000004"
const INVITE_ROOM = "5a000000-0000-4000-8000-000000000005"

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function seedRoom(threadId: string, handle: string): Promise<void> {
  await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
    VALUES (${threadId}, ${ORG_ID}, ${handle}, 'agent_chat', ${USER_ID})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${threadId}, ${USER_ID}, ${ORG_ID})`
}

async function postUserMessage(threadId: string, content: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
    VALUES (${id}, ${threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${content}, '{}')`
  return id
}

describe("the mention auto-add seat anchors at the summoning message", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'SeatOrg', 'seat-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'seat@test.com', 'Seat')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, system_prompt)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'role', '@seatsupport', 'Seat Support', '["*"]'::jsonb, 'You help.')`
    await seedRoom(ROOM, "seat-room")
    await seedRoom(INVITE_ROOM, "seat-invite-room")
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("a freshly mentioned agent renders the message that summoned it", async () => {
    const triggerId = await postUserMessage(
      ROOM,
      "@[Seat Support] call request_scope for ads insights and nothing else.",
    )
    await withPrivilegedDb(ORG_ID, "seat-test", (db) =>
      addAgentParticipant(db as unknown as RlsClient, {
        orgId: ORG_ID,
        threadId: ROOM,
        agentId: AGENT_ID,
        actorUserId: USER_ID,
        joinedAtMessageId: triggerId,
      }),
    )
    // The auto-add line the room sees, posted after the seat exists.
    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${ROOM}, ${ORG_ID}, ${USER_ID}, 'system', 'Seat added Seat Support', '{}')`

    const loaded = await loadBoundedHistory({
      threadId: ROOM,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
      contextWindow: 200_000,
    })
    // Without the anchor the tail is the system line alone and the turn has no
    // user message at all, which is the whole defect.
    expect(loaded.messages.map((m) => m.id)).toContain(triggerId)
    expect(loaded.messages[0].id).toBe(triggerId)
    expect(loaded.messages.some((m) => m.authorType === "user")).toBe(true)
  })

  it("a seat with no summoning message still starts at the seat, so an invite carries no backlog", async () => {
    await postUserMessage(INVITE_ROOM, "Backlog nobody invited the agent to read.")
    await withPrivilegedDb(ORG_ID, "seat-test", (db) =>
      addAgentParticipant(db as unknown as RlsClient, {
        orgId: ORG_ID,
        threadId: INVITE_ROOM,
        agentId: AGENT_ID,
        actorUserId: USER_ID,
      }),
    )
    const after = await postUserMessage(INVITE_ROOM, "The first thing it may read.")

    const loaded = await loadBoundedHistory({
      threadId: INVITE_ROOM,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
      contextWindow: 200_000,
    })
    expect(loaded.messages.map((m) => m.id)).toEqual([after])
  })
})
