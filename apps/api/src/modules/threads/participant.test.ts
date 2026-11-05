// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"

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

import { withRlsContext } from "~/db/rls"
import {
  addAgentParticipant,
  addParticipant,
  joinDiscoverableChannel,
  removeParticipant,
} from "~/modules/threads/participant"
import { addReference, listBacklinks } from "~/modules/threads/reference"
import { markThreadRead, updateThreadState } from "~/modules/threads/thread-state"

const ORG = "00000000-0000-0000-0000-000000000020"
const USER1 = "00000000-0000-0000-0000-000000000021"
const USER2 = "00000000-0000-0000-0000-000000000022"
const USER3 = "00000000-0000-0000-0000-000000000023"
let threadId: string

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'POrg', 'porg') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER1}, ${ORG}, 'p1@t.com', 'P1') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER2}, ${ORG}, 'p2@t.com', 'P2') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER3}, ${ORG}, 'p3@t.com', 'P3') ON CONFLICT DO NOTHING`
  const [t] =
    await sql`INSERT INTO kernel.threads (org_id, handle, created_by) VALUES (${ORG}, 'thread-p1', ${USER1}) RETURNING id`
  threadId = t.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${threadId}, ${USER1}, ${ORG}, 'admin')`
  await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER1}, ${threadId}, ${ORG})`
})

beforeEach(() => {
  publishedEvents.length = 0
})

afterAll(async () => {
  await sql`DELETE FROM kernel.thread_references WHERE thread_id = ${threadId}`
  await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${threadId}`
  await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${threadId}`
  await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
  await sql`DELETE FROM kernel.threads WHERE id = ${threadId}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("participant service", () => {
  it("adds a participant and initializes thread state", async () => {
    const result = await addParticipant(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      targetUserId: USER2,
    })
    expect(result?.added).toBe(true)
    expect(publishedEvents.some((e) => e.entity === "participant" && e.action === "add")).toBe(true)
  })

  it("auto-promotes agent_chat threads when adding a participant", async () => {
    const agentThreadId = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${agentThreadId}, ${ORG}, 'agent-promote', 'agent_chat', ${USER1})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${agentThreadId}, ${USER1}, ${ORG}, 'admin')`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER1}, ${agentThreadId}, ${ORG})`

    try {
      publishedEvents.length = 0
      const result = await addParticipant(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId: agentThreadId,
        targetUserId: USER2,
      })
      expect(result?.added).toBe(true)

      const [row] = await sql`SELECT type FROM kernel.threads WHERE id = ${agentThreadId}`
      expect(row.type).toBe("thread")
      expect(
        publishedEvents.some(
          (e) =>
            e.entity === "thread" && e.action === "update" && e.data?.changes?.type === "thread",
        ),
      ).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${agentThreadId}`
      await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${agentThreadId}`
      await sql`DELETE FROM kernel.threads WHERE id = ${agentThreadId}`
    }
  })

  it("self-removes from thread", async () => {
    await addParticipant(rlsDb, { orgId: ORG, userId: USER1, threadId, targetUserId: USER3 })
    publishedEvents.length = 0
    const result = await removeParticipant(rlsDb, {
      orgId: ORG,
      userId: USER3,
      threadId,
      targetUserId: USER3,
      isAdmin: false,
    })
    expect(result.removed).toBe(true)
  })

  it("removes a participant under the liaison_rls role (no FOR-UPDATE permission-denied)", async () => {
    // Regression (prod alert: 'permission denied for table thread_participants'): the removal used
    // `SELECT ... FOR UPDATE` to serialize concurrent removes, but kernel.thread_participants has
    // UPDATE REVOKEd from liaison_rls, and Postgres requires UPDATE privilege to take a row lock — so
    // the DELETE /threads/:id/participants/:id path 500'd under the real RLS role. The unprivileged
    // rlsDb tests above run as the BYPASSRLS role and never hit the grant, so assert under a REAL
    // withRlsContext (SET LOCAL ROLE liaison_rls). Own isolated thread so it doesn't perturb the
    // shared-thread assumptions of the other tests.
    const rlsThreadId = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by) VALUES (${rlsThreadId}, ${ORG}, ${`thread-rls-${rlsThreadId.slice(0, 6)}`}, ${USER1})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role) VALUES (${rlsThreadId}, ${USER1}, ${ORG}, 'admin')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${rlsThreadId}, ${USER2}, ${ORG})`
    try {
      const result = await withRlsContext(
        { actorType: "user", userId: USER1, orgId: ORG, scopes: ["*"], dimensionGrants: {} },
        (tx) =>
          removeParticipant(tx, {
            orgId: ORG,
            userId: USER1,
            threadId: rlsThreadId,
            targetUserId: USER2,
            isAdmin: true,
          }),
      )
      expect(result.removed).toBe(true)
    } finally {
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${rlsThreadId}`
      await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${rlsThreadId}`
      await sql`DELETE FROM kernel.threads WHERE id = ${rlsThreadId}`
    }
  })

  it("non-admin cannot remove others", async () => {
    await addParticipant(rlsDb, { orgId: ORG, userId: USER1, threadId, targetUserId: USER3 })
    const result = await removeParticipant(rlsDb, {
      orgId: ORG,
      userId: USER2,
      threadId,
      targetUserId: USER3,
      isAdmin: false,
    })
    expect(result.removed).toBe(false)
    // Clean up USER3 so thread state tests can verify non-participant behavior
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${threadId} AND user_id = ${USER3}`
    await sql`DELETE FROM kernel.user_thread_state WHERE thread_id = ${threadId} AND user_id = ${USER3}`
  })

  it("returns { added: false } when adding a duplicate participant (T-11)", async () => {
    // USER2 was added earlier in the suite; ensure they're present
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${USER2}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id) VALUES (${USER2}, ${threadId}, ${ORG}) ON CONFLICT DO NOTHING`

    // Attempt to add the same participant again
    const result = await addParticipant(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      targetUserId: USER2,
    })
    expect(result).not.toBeNull()
    expect(result?.added).toBe(false)
  })

  it("publishes participant:remove event on successful removal (T-12)", async () => {
    // Ensure USER3 is a participant first
    await addParticipant(rlsDb, { orgId: ORG, userId: USER1, threadId, targetUserId: USER3 })
    publishedEvents.length = 0

    const result = await removeParticipant(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      targetUserId: USER3,
      isAdmin: true,
    })
    expect(result.removed).toBe(true)
    expect(publishedEvents.some((e) => e.entity === "participant" && e.action === "remove")).toBe(
      true,
    )
  })
})

describe("reference service", () => {
  it("adds a reference", async () => {
    const result = await addReference(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      app: "tickets",
      entityType: "ticket",
      entityId: "t1",
    })
    expect(result?.added).toBe(true)
  })

  it("is idempotent — duplicate reference returns added: false", async () => {
    const result = await addReference(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      app: "tickets",
      entityType: "ticket",
      entityId: "t1",
    })
    expect(result?.added).toBe(false)
  })

  it("lists backlinks for an entity", async () => {
    const result = await listBacklinks(rlsDb, {
      orgId: ORG,
      userId: USER1,
      app: "tickets",
      entityType: "ticket",
      entityId: "t1",
    })
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].threadId).toBe(threadId)
  })

  it("threads.references.top-five-display-contract", async () => {
    const baseId = "00000000-0000-0000-0000-00000000bb"
    const ENT_IDS = Array.from({ length: 7 }, (_, i) => `${baseId}${i.toString().padStart(2, "0")}`)
    for (const eid of ENT_IDS) {
      await addReference(rlsDb, {
        orgId: ORG,
        userId: USER1,
        threadId,
        app: "tickets",
        entityType: "ticket",
        entityId: eid,
      })
      await new Promise((r) => setTimeout(r, 5))
    }
    const { listRecentReferences } = await import("~/modules/threads/reference")
    const items = await listRecentReferences(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
    })
    expect(items.length).toBe(5)
    expect(items[0].entityId).toBe(ENT_IDS[6])
    expect(items[0].tabType).toBe("tickets:ticket")
    expect(typeof items[0].label).toBe("string")
    expect(typeof items[0].icon).toBe("string")
  })

  it("threads.references.lastVisitedAt-refreshes-on-repeat", async () => {
    const ENTITY_ID = "00000000-0000-0000-0000-00000000aaaa"
    const r1 = await addReference(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      app: "tickets",
      entityType: "ticket",
      entityId: ENTITY_ID,
    })
    expect(r1?.added).toBe(true)
    const [first] = await sql<{ id: string; last_visited_at: Date }[]>`
      SELECT id, last_visited_at
      FROM kernel.thread_references
      WHERE id = ${r1?.reference.id ?? ""}
    `
    publishedEvents.length = 0
    await new Promise((res) => setTimeout(res, 25))
    const r2 = await addReference(rlsDb, {
      orgId: ORG,
      userId: USER1,
      threadId,
      app: "tickets",
      entityType: "ticket",
      entityId: ENTITY_ID,
    })
    expect(r2?.added).toBe(false)
    const [second] = await sql<{ last_visited_at: Date }[]>`
      SELECT last_visited_at
      FROM kernel.thread_references
      WHERE id = ${first.id}
    `
    expect(new Date(second.last_visited_at).getTime()).toBeGreaterThan(
      new Date(first.last_visited_at).getTime(),
    )
    expect(
      publishedEvents.filter((e) => e.entity === "reference" && e.action === "add"),
    ).toHaveLength(0)
  })
})

describe("thread state service", () => {
  it("archives a thread for a user", async () => {
    await updateThreadState(rlsDb, { orgId: ORG, userId: USER1, threadId, isArchived: true })
    const [row] =
      await sql`SELECT is_archived FROM kernel.user_thread_state WHERE user_id = ${USER1} AND thread_id = ${threadId}`
    expect(row.is_archived).toBe(true)
    await updateThreadState(rlsDb, { orgId: ORG, userId: USER1, threadId, isArchived: false })
  })

  it("mutes a thread for a user", async () => {
    await updateThreadState(rlsDb, { orgId: ORG, userId: USER1, threadId, isMuted: true })
    const [row] =
      await sql`SELECT is_muted FROM kernel.user_thread_state WHERE user_id = ${USER1} AND thread_id = ${threadId}`
    expect(row.is_muted).toBe(true)
    await updateThreadState(rlsDb, { orgId: ORG, userId: USER1, threadId, isMuted: false })
  })

  it("rejects state update for non-participant", async () => {
    const result = await updateThreadState(rlsDb, {
      orgId: ORG,
      userId: USER3,
      threadId,
      isArchived: true,
    })
    expect(result).toBeNull()
  })

  it("marks thread as read", async () => {
    const [msg] =
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes) VALUES (${threadId}, ${ORG}, ${USER1}, 'read me', '{}') RETURNING id`
    await markThreadRead(rlsDb, { orgId: ORG, userId: USER1, threadId, lastReadMessageId: msg.id })
    const [row] =
      await sql`SELECT last_read_message_id FROM kernel.user_thread_state WHERE user_id = ${USER1} AND thread_id = ${threadId}`
    expect(row.last_read_message_id).toBe(msg.id)
  })

  it("rejects mark-read for non-participant", async () => {
    const result = await markThreadRead(rlsDb, { orgId: ORG, userId: USER3, threadId })
    expect(result).toBe(false)
  })
})

describe("removeParticipant — admin org check", () => {
  const ORG_B = "00000000-0000-0000-0000-000000000030"
  const ADMIN_B = "00000000-0000-0000-0000-000000000031"

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_B}, 'OrgB', 'orgb-participant-test') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN_B}, ${ORG_B}, 'admin-b@t.com', 'AdminB') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.users WHERE id = ${ADMIN_B}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_B}`
  })

  it("admin from different org cannot remove participants", async () => {
    // ADMIN_B is admin in ORG_B, tries to remove USER2 from thread in ORG (different org)
    const result = await removeParticipant(rlsDb, {
      threadId,
      targetUserId: USER2,
      userId: ADMIN_B,
      orgId: ORG,
      isAdmin: true,
    })
    expect(result.removed).toBe(false)
  })
})

describe("joining a discoverable channel", () => {
  // P4b-T09: a channel is joinable by any member of the org, without an
  // existing participant to let them in. That is the whole point of the
  // discoverable flag.
  const CORG = "00000000-0000-0000-0000-000000000030"
  const CUSER = "00000000-0000-0000-0000-000000000031"
  const COWNER = "00000000-0000-0000-0000-000000000032"
  let channelId: string
  let privateId: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${CORG}, 'COrg', 'corg-join') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${CUSER}, ${CORG}, 'cj1@t.com', 'CJ1') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${COWNER}, ${CORG}, 'cj2@t.com', 'CJ2') ON CONFLICT DO NOTHING`
    const [c] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${CORG}, 'join-channel', 'Support', ${COWNER}, true) RETURNING id`
    channelId = c!.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${channelId}, ${COWNER}, ${CORG})`
    const [p] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${CORG}, 'join-private', 'Private', ${COWNER}) RETURNING id`
    privateId = p!.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${privateId}, ${COWNER}, ${CORG})`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${CORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${CORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${CORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${CORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${CORG}`
  })

  it("joinDiscoverableChannel adds the calling user as a member of a discoverable channel", async () => {
    const result = await joinDiscoverableChannel(rlsDb, {
      orgId: CORG,
      userId: CUSER,
      threadId: channelId,
    })
    expect(result?.added).toBe(true)
    const rows = await sql`
      SELECT role, participant_type FROM kernel.thread_participants
      WHERE thread_id = ${channelId} AND user_id = ${CUSER}`
    expect(rows.length).toBe(1)
    expect(rows[0].role).toBe("member")
    expect(rows[0].participant_type).toBe("user")
  })

  it("joinDiscoverableChannel is idempotent for a member who already joined", async () => {
    const result = await joinDiscoverableChannel(rlsDb, {
      orgId: CORG,
      userId: CUSER,
      threadId: channelId,
    })
    expect(result?.added).toBe(false)
    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${channelId} AND user_id = ${CUSER}`
    expect(rows.length).toBe(1)
  })

  it("joinDiscoverableChannel refuses to join a non-discoverable thread", async () => {
    const result = await joinDiscoverableChannel(rlsDb, {
      orgId: CORG,
      userId: CUSER,
      threadId: privateId,
    })
    expect(result).toBeNull()
    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${privateId} AND user_id = ${CUSER}`
    expect(rows.length).toBe(0)
  })
})

describe("agent seats", () => {
  // P4b-T14 + H5: an agent is a member like any other, and the live frame says
  // so, so an auto-added agent appears without a reload.
  const AORG = "00000000-0000-0000-0000-000000000040"
  const AUSER = "00000000-0000-0000-0000-000000000041"
  const AAGENT = "00000000-0000-0000-0000-000000000042"
  const AUSER2 = "00000000-0000-0000-0000-000000000043"
  const AARCHIVED = "00000000-0000-0000-0000-000000000044"
  const AFOREIGN_ORG = "00000000-0000-0000-0000-000000000045"
  const AFOREIGN_AGENT = "00000000-0000-0000-0000-000000000046"
  let seatThreadId: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${AORG}, 'AOrg', 'aorg-seat') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${AUSER}, ${AORG}, 'as1@t.com', 'AS1') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
              VALUES (${AAGENT}, ${AORG}, 'role', '@support', 'Support') ON CONFLICT DO NOTHING`
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by, discoverable)
      VALUES (${AORG}, 'seat-thread', 'Support', ${AUSER}, true) RETURNING id`
    seatThreadId = t!.id
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${seatThreadId}, ${AUSER}, ${AORG})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${AUSER2}, ${AORG}, 'as2@t.com', 'AS2') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, archived_at)
              VALUES (${AARCHIVED}, ${AORG}, 'role', '@retired', 'Retired', now()) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${AFOREIGN_ORG}, 'FOrg', 'aorg-seat-foreign') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
              VALUES (${AFOREIGN_AGENT}, ${AFOREIGN_ORG}, 'role', '@foreign', 'Foreign') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agents WHERE org_id = ${AFOREIGN_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${AFOREIGN_ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${AORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${AORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${AORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${AORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${AORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${AORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${AORG}`
  })

  it("addAgentParticipant inserts a participantType agent row for a new agent", async () => {
    const result = await addAgentParticipant(rlsDb, {
      orgId: AORG,
      threadId: seatThreadId,
      agentId: AAGENT,
      actorUserId: AUSER,
    })
    expect(result?.added).toBe(true)
    const rows = await sql`
      SELECT participant_type, user_id, role FROM kernel.thread_participants
      WHERE thread_id = ${seatThreadId} AND agent_id = ${AAGENT}`
    expect(rows.length).toBe(1)
    expect(rows[0].participant_type).toBe("agent")
    expect(rows[0].user_id).toBeNull()
    expect(rows[0].role).toBe("member")

    // H5: the live frame names the seat, so the web store renders the new
    // member without a reload.
    const added = publishedEvents.find(
      (e) => e.entity === "participant" && e.action === "add" && e.data?.agentId === AAGENT,
    )
    expect(added).toBeDefined()
    expect(added.data.participantType).toBe("agent")
    expect(added.data.agentName).toBe("Support")
    expect(added.data.threadId).toBe(seatThreadId)
  })

  it("addAgentParticipant is a no-op when the agent is already a member", async () => {
    const result = await addAgentParticipant(rlsDb, {
      orgId: AORG,
      threadId: seatThreadId,
      agentId: AAGENT,
      actorUserId: AUSER,
    })
    expect(result).toBeNull()
    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${seatThreadId} AND agent_id = ${AAGENT}`
    expect(rows.length).toBe(1)
  })
  it("addAgentParticipant refuses an archived agent and seats nothing", async () => {
    const result = await addAgentParticipant(rlsDb, {
      orgId: AORG,
      threadId: seatThreadId,
      agentId: AARCHIVED,
      actorUserId: AUSER,
    })
    expect(result).toBeNull()
    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${seatThreadId} AND agent_id = ${AARCHIVED}`
    expect(rows.length).toBe(0)
  })

  it("addAgentParticipant refuses an agent of another org and seats nothing", async () => {
    const result = await addAgentParticipant(rlsDb, {
      orgId: AORG,
      threadId: seatThreadId,
      agentId: AFOREIGN_AGENT,
      actorUserId: AUSER,
    })
    expect(result).toBeNull()
    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${seatThreadId} AND agent_id = ${AFOREIGN_AGENT}`
    expect(rows.length).toBe(0)
  })

  // An agent seat is not a person. "The last participant" means the last
  // HUMAN, exactly as the three read-side counts do: a room holding one human
  // and one agent must not let the human leave just because the agent's seat
  // pads the count.
  async function seatRoom(handle: string, humans: string[]): Promise<string> {
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${AORG}, ${handle}, ${handle}, ${AUSER}) RETURNING id`
    for (const u of humans) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
                VALUES (${t!.id}, ${u}, ${AORG}, ${u === AUSER ? "admin" : "member"})`
    }
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, participant_type, agent_id)
              VALUES (${t!.id}, ${AORG}, 'agent', ${AAGENT})`
    return t!.id
  }

  it("the last human cannot leave a room whose other seat is an agent", async () => {
    const roomId = await seatRoom("seat-last-human", [AUSER])
    await expect(
      removeParticipant(rlsDb, {
        orgId: AORG,
        userId: AUSER,
        threadId: roomId,
        targetUserId: AUSER,
        isAdmin: false,
      }),
    ).rejects.toThrow(/Cannot remove the last participant/)
    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${roomId} AND participant_type = 'user'`
    expect(rows.length).toBe(1)
  })

  // Walk 2026-10-12: the conversation menu's "remove" on an agent seat sent the
  // agent's id to DELETE /participants/:id, which only knew human seats: in a
  // one-human room it answered "Cannot remove the last participant" (the human
  // count), in a larger room 404. An agent could never be taken out of a room.
  it("the room's creator removes an agent seat, the human stays", async () => {
    const roomId = await seatRoom("seat-remove-agent", [AUSER])
    publishedEvents.length = 0
    const result = await removeParticipant(rlsDb, {
      orgId: AORG,
      userId: AUSER,
      threadId: roomId,
      targetUserId: AAGENT,
      isAdmin: false,
    })
    expect(result.removed).toBe(true)
    const seats = await sql`
      SELECT participant_type FROM kernel.thread_participants WHERE thread_id = ${roomId}`
    expect(seats.map((r) => r.participant_type)).toEqual(["user"])
    const removed = publishedEvents.find(
      (e) => e.entity === "participant" && e.action === "remove" && e.data?.agentId === AAGENT,
    )
    expect(removed?.data.threadId).toBe(roomId)
  })

  it("a member who neither created the room nor administers it cannot remove its agent", async () => {
    const roomId = await seatRoom("seat-remove-agent-member", [AUSER, AUSER2])
    const result = await removeParticipant(rlsDb, {
      orgId: AORG,
      userId: AUSER2,
      threadId: roomId,
      targetUserId: AAGENT,
      isAdmin: false,
    })
    expect(result.removed).toBe(false)
    const agentSeats = await sql`
      SELECT id FROM kernel.thread_participants WHERE thread_id = ${roomId} AND agent_id = ${AAGENT}`
    expect(agentSeats.length).toBe(1)
  })

  it("one of two humans can still leave a room that also seats an agent", async () => {
    const roomId = await seatRoom("seat-two-humans", [AUSER, AUSER2])
    const result = await removeParticipant(rlsDb, {
      orgId: AORG,
      userId: AUSER2,
      threadId: roomId,
      targetUserId: AUSER2,
      isAdmin: false,
    })
    expect(result.removed).toBe(true)
    const rows = await sql`
      SELECT id FROM kernel.thread_participants
      WHERE thread_id = ${roomId} AND participant_type = 'user'`
    expect(rows.length).toBe(1)
  })
})
