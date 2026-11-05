// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D8: "Continue in a DM" needs a DM to continue in. The card offers to
// move a question out of a room, and nothing in the product could open that
// chat: only an already existing one could be reached.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const OTHER_USER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const SECOND_AGENT = crypto.randomUUID()
const RACE_AGENT = crypto.randomUUID()
const ARCHIVED_AGENT = crypto.randomUUID()
const FOREIGN_AGENT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let token: string

const openDm = (agentId: string) =>
  app.request("/api/threads/dm", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  })

describe("POST /api/threads/dm", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'DM Org', ${`dm-${tag}`})`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DM Other', ${`dm2-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, ${`dm-${tag}@t.com`}, 'User')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_USER}, ${OTHER_ORG}, ${`dm2-${tag}@t.com`}, 'Other')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', ${`@dm-support-${tag}`}, 'Support', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${SECOND_AGENT}, ${ORG}, 'role', ${`@dm-ops-${tag}`}, 'Ops', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${RACE_AGENT}, ${ORG}, 'role', ${`@dm-race-${tag}`}, 'Race', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling, archived_at)
      VALUES (${ARCHIVED_AGENT}, ${ORG}, 'role', ${`@dm-gone-${tag}`}, 'Gone', NULL, '[]'::jsonb, now())`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${FOREIGN_AGENT}, ${OTHER_ORG}, 'role', ${`@dm-foreign-${tag}`}, 'Foreign', NULL, '[]'::jsonb)`
    token = await signAccessToken(
      {
        userId: USER,
        orgId: ORG,
        name: "User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
    await releaseTestLock()
  })

  it("opens the chat and seats both the human and the agent", async () => {
    const res = await openDm(AGENT)
    expect(res.status).toBe(201)
    const dm = ((await res.json()) as any).data
    expect(dm.created).toBe(true)
    const [thread] = await sql<{ type: string }[]>`
      SELECT type FROM kernel.threads WHERE id = ${dm.id}`
    expect(thread.type).toBe("agent_chat")
    const seats = await sql<
      { user_id: string | null; agent_id: string | null; participant_type: string }[]
    >`
      SELECT user_id, agent_id, participant_type FROM kernel.thread_participants
      WHERE thread_id = ${dm.id} ORDER BY participant_type`
    expect(seats.map((s) => s.participant_type).sort()).toEqual(["agent", "user"])
    expect(seats.find((s) => s.participant_type === "agent")?.agent_id).toBe(AGENT)
    expect(seats.find((s) => s.participant_type === "user")?.user_id).toBe(USER)
  })

  it("pressing it again lands in the same chat, never a second one", async () => {
    const first = ((await (await openDm(AGENT)).json()) as any).data
    const res = await openDm(AGENT)
    expect(res.status).toBe(200)
    const again = ((await res.json()) as any).data
    expect(again.id).toBe(first.id)
    expect(again.created).toBe(false)
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.threads
      WHERE org_id = ${ORG} AND type = 'agent_chat'`
    expect(n).toBe(1)
  })

  it("the new DM is returned by GET /api/threads, so Direct Messages shows it", async () => {
    // The DM was created (201, both seats in the database) and then vanished:
    // the thread list filtered on `type = 'thread'`, so an agent DM was in no
    // list the product reads and Direct Messages stayed empty (FX4).
    const dm = ((await (await openDm(AGENT)).json()) as any).data
    const res = await app.request("/api/threads?limit=50", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const rows = ((await res.json()) as any).data as Array<{
      id: string
      discoverable: boolean
      participants: Array<{ participantType: string; agentId: string | null; name: string }>
    }>
    const row = rows.find((r) => r.id === dm.id)
    expect(row).toBeDefined()
    // It belongs under Direct Messages, not Channels, and it names its agent.
    expect(row?.discoverable).toBe(false)
    expect(
      row?.participants.some((p) => p.participantType === "agent" && p.agentId === AGENT),
    ).toBe(true)
  })

  it("a chat with a different agent is a different chat", async () => {
    const other = ((await (await openDm(SECOND_AGENT)).json()) as any).data
    const first = ((await (await openDm(AGENT)).json()) as any).data
    expect(other.id).not.toBe(first.id)
  })

  it("two presses at once still land in one chat", async () => {
    // The read-then-create had no lock, so a double click opened two DMs and
    // scattered the conversation across them.
    const [a, b] = await Promise.all([openDm(RACE_AGENT), openDm(RACE_AGENT)])
    const first = ((await a.json()) as any).data
    const second = ((await b.json()) as any).data
    expect(second.id).toBe(first.id)
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
      WHERE org_id = ${ORG} AND agent_id = ${RACE_AGENT}`
    expect(n).toBe(1)
    // Exactly one of the two presses created it.
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1)
  })

  it("an archived or foreign agent has no chat to open", async () => {
    expect((await openDm(ARCHIVED_AGENT)).status).toBe(404)
    expect((await openDm(FOREIGN_AGENT)).status).toBe(404)
  })
})
