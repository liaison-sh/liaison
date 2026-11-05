// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX4-3: the per agent join point is a POSITION in the message order, not a
// timestamp.
//
// The tail filter compared JS Dates, which carry milliseconds, while the stored
// timestamp carries microseconds: a seat and the messages written in the same
// millisecond could not be ordered at all, so a message posted BEFORE the agent
// sat down still entered its history. The anchor is resolved in the database,
// in the message list's own (created_at, id) order, and the tail is sliced at
// it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { loadBoundedHistory } from "~/modules/agent/context/checkpoint"

const ORG_ID = crypto.randomUUID()
const USER_A = crypto.randomUUID()
const AGENT_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const SEAT_ID = "50000000-0000-4000-8000-000000000000"
// Three rows inside ONE millisecond: a message before the seat, the seat, a
// message after it. A JS Date sees one instant for all three.
const BEFORE_ID = "90000000-0000-4000-8000-000000000000"
const AFTER_ID = "10000000-0000-4000-8000-000000000000"
const BEFORE_AT = "2026-09-13 10:00:00.000100+00"
const SEAT_AT = "2026-09-13 10:00:00.000500+00"
const AFTER_AT = "2026-09-13 10:00:00.000900+00"
const tag = ORG_ID.slice(0, 8)

const actor: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

describe("the agent join point orders on (created_at, id)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'JoinPointOrg', ${`join-point-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, ${`joinpoint-${tag}@test.com`}, 'Join Human', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'role', ${`joinrole${tag}`}, 'Logistics', '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`jointhread${tag}`}, ${USER_A})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_A}, ${ORG_ID})`
    await sql`INSERT INTO kernel.thread_participants (id, thread_id, agent_id, org_id, participant_type, created_at)
      VALUES (${SEAT_ID}, ${THREAD_ID}, ${AGENT_ID}, ${ORG_ID}, 'agent', ${SEAT_AT}::timestamptz)`
    for (const [id, content, at] of [
      [BEFORE_ID, "said before the seat", BEFORE_AT],
      [AFTER_ID, "said after the seat", AFTER_AT],
    ]) {
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, content, required_scopes, author_type, created_at)
        VALUES (${id}, ${THREAD_ID}, ${ORG_ID}, ${USER_A}, ${content}, '{}'::text[], 'user', ${at}::timestamptz)`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("keeps only the message written after the seat inside the same millisecond", async () => {
    const history = await loadBoundedHistory({
      threadId: THREAD_ID,
      orgId: ORG_ID,
      actor,
      agentId: AGENT_ID,
    })
    const ids = history.messages.map((m) => m.id)
    expect(ids).toContain(AFTER_ID)
    expect(ids).not.toContain(BEFORE_ID)
  })
})
