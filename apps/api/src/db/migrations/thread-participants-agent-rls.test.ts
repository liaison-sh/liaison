// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4a-T10: tp_insert and tp_delete (0000_initial.sql) compare user_id to the
// acting human directly, and an AGENT participant row's user_id is NULL, so
// that comparison is NULL (falsy) for the row being written. Both policies
// already fall back to "the acting human is some other participant row on this
// thread", which is what keeps agent membership writable with no policy edit.
// This test is the proof, not the assumption: it is the only thing standing
// between 0075 and a silently unwritable agent seat.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

function ctx(userId: string): UserContext {
  return { actorType: "user", userId, orgId: ORG, scopes: [], dimensionGrants: {} }
}

async function newAgent(label: string): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
    VALUES (${id}, ${ORG}, 'role', ${`${label}-${tag}`}, 'P4a Agent')`
  return id
}

function addAgentAs(userId: string, agentId: string): Promise<unknown> {
  return withRlsContext(ctx(userId), (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO kernel.thread_participants (thread_id, user_id, agent_id, org_id, participant_type)
      VALUES (${THREAD}, NULL, ${agentId}, ${ORG}, 'agent')`),
  )
}

async function deleteAgentAs(userId: string, agentId: string): Promise<number> {
  const rows = await withRlsContext(ctx(userId), (tx) =>
    tx.execute(drizzleSql`
      DELETE FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND agent_id = ${agentId} RETURNING id`),
  )
  return (rows as unknown as { length: number }).length
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'P4a T10', ${`p4a-t10-${tag}`})`
  for (const [id, email] of [
    [MEMBER, `p4a-t10-member-${tag}@test.com`],
    [OUTSIDER, `p4a-t10-outsider-${tag}@test.com`],
  ]) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${id}, ${ORG}, ${email}, 'P4a', 'active', 'hash')`
  }
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`p4a-t10-thr-${tag}`}, 'thread', ${MEMBER}) RETURNING id`
  THREAD = thread!.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
    VALUES (${THREAD}, ${MEMBER}, ${ORG})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("agent participant rows under the existing participant policies", () => {
  it("a human member can add an agent participant row to a thread they belong to", async () => {
    const agentId = await newAgent("p4a-t10-added")
    await addAgentAs(MEMBER, agentId)
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND agent_id = ${agentId}`
    expect(row?.n).toBe(1)
  })

  it("a human who is not a member of the thread cannot add an agent participant row to it", async () => {
    const agentId = await newAgent("p4a-t10-refused")
    // Drizzle wraps the driver error, so the policy denial is on the cause.
    let denial = ""
    try {
      await addAgentAs(OUTSIDER, agentId)
    } catch (err) {
      denial = `${(err as Error).message} ${(err as { cause?: Error }).cause?.message ?? ""}`
    }
    expect(denial).toMatch(/row-level security/)
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND agent_id = ${agentId}`
    expect(row?.n).toBe(0)
  })

  it("a human member can remove an agent participant row from their thread", async () => {
    const agentId = await newAgent("p4a-t10-removed")
    await addAgentAs(MEMBER, agentId)
    expect(await deleteAgentAs(MEMBER, agentId)).toBe(1)
  })

  it("a human who is not a member cannot remove an agent participant row", async () => {
    const agentId = await newAgent("p4a-t10-kept")
    await addAgentAs(MEMBER, agentId)
    expect(await deleteAgentAs(OUTSIDER, agentId)).toBe(0)
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.thread_participants
       WHERE thread_id = ${THREAD} AND agent_id = ${agentId}`
    expect(row?.n).toBe(1)
  })
})
