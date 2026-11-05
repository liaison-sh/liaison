// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

let createThread: typeof import("./thread").createThread
let listThreads: typeof import("./thread").listThreads
let updateThread: typeof import("./thread").updateThread

const ORG_ID = "00000000-0000-0000-0000-d00000000001"
const USER_ID = "00000000-0000-0000-0000-d00000000002"

const rlsCtx: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

beforeAll(async () => {
  const mod = await import("./thread")
  createThread = mod.createThread
  listThreads = mod.listThreads
  updateThread = mod.updateThread

  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'Thread Test Org', 'thread-test') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_ID}, ${ORG_ID}, 'thread@test.com', 'Thread User', 'active', 1) ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("createThread with type parameter", () => {
  it("creates a regular thread by default (type = 'thread')", async () => {
    const result = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        title: "Regular Thread",
        forceCreate: true,
      }),
    )
    expect(result.id).toBeDefined()

    const [row] = await sql`SELECT type FROM kernel.threads WHERE id = ${result.id}`
    expect(row.type).toBe("thread")
  })

  it("creates an agent_chat thread when type is specified", async () => {
    const result = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        title: "Agent Chat",
        type: "agent_chat",
      }),
    )
    expect(result.id).toBeDefined()

    const [row] = await sql`SELECT type FROM kernel.threads WHERE id = ${result.id}`
    expect(row.type).toBe("agent_chat")
  })
})

describe("listThreads excludes agent_chat", () => {
  it("returns only type = 'thread' rows", async () => {
    // Create one of each type
    const regular = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        title: "List Test Regular",
        forceCreate: true,
      }),
    )
    const agentChat = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        title: "List Test Agent Chat",
        type: "agent_chat",
      }),
    )

    const result = await withRlsContext(rlsCtx, (tx) =>
      listThreads(tx, { orgId: ORG_ID, userId: USER_ID, limit: 50 }),
    )

    const ids = result.threads.map((t: any) => t.id)
    expect(ids).toContain(regular.id)
    expect(ids).not.toContain(agentChat.id)
  })
})

// A35 amended (2026-10-12): the lists classify a TITLED room as a channel
// unless it is an `agent_chat`, so the list row must say which it is. Without
// `type` the client read every row as "thread", and an auto-titled agent DM
// would have listed as a channel.
describe("listThreads carries each row's type", () => {
  it("an agent DM lists as agent_chat, a titled room as thread", async () => {
    const AGENT_ID = "00000000-0000-0000-0000-d000000000a1"
    await sql`INSERT INTO kernel.agents (id, org_id, handle, display_name, kind)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'type-list-agent', 'Type List Agent', 'role')
      ON CONFLICT DO NOTHING`
    const channel = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        title: "s11-cloud-walk",
        forceCreate: true,
      }),
    )
    const dm = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        title: "Auto titled DM",
        type: "agent_chat",
      }),
    )
    for (const threadId of [channel.id, dm.id]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id)
        VALUES (${threadId}, ${ORG_ID}, 'agent', ${AGENT_ID})`
    }

    const result = await withRlsContext(rlsCtx, (tx) =>
      listThreads(tx, { orgId: ORG_ID, userId: USER_ID, limit: 50 }),
    )
    const byId = new Map(result.threads.map((t: any) => [t.id, t]))
    expect((byId.get(channel.id) as any)?.type).toBe("thread")
    expect((byId.get(dm.id) as any)?.type).toBe("agent_chat")
  })
})

describe("agent_chat dedup bypass", () => {
  it("creates separate agent_chat threads for the same user (no DM dedup)", async () => {
    const chat1 = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        type: "agent_chat",
      }),
    )
    const chat2 = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        type: "agent_chat",
      }),
    )

    expect(chat1.id).not.toBe(chat2.id)
    expect((chat1 as any).deduplicated).not.toBe(true)
    expect((chat2 as any).deduplicated).not.toBe(true)
  })
})

describe("updateThread with type change", () => {
  it("can change type from agent_chat to thread (promote)", async () => {
    const chat = await withRlsContext(rlsCtx, (tx) =>
      createThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        participantIds: [USER_ID],
        title: "Promote Me",
        type: "agent_chat",
      }),
    )

    const updated = await withRlsContext(rlsCtx, (tx) =>
      updateThread(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        threadId: chat.id,
        scopes: ["*"],
        changes: { type: "thread" },
      }),
    )

    expect(updated).not.toBeNull()
    const [row] = await sql`SELECT type FROM kernel.threads WHERE id = ${chat.id}`
    expect(row.type).toBe("thread")
  })
})
