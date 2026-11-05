// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX1 item 6: 0082's policies gated a role agent's checkpoint on the SCOPES the
// summarised conversation happened to touch, and on nothing else. Covering
// those scopes is not being in the room: a member who was never a participant
// could SELECT the summary of a thread they have never seen. 0084 ANDs the
// thread-membership predicate kernel.messages has carried since 0000_initial
// onto all four policies.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"

const ORG = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const OUTSIDER = crypto.randomUUID()
const AGENT = crypto.randomUUID()
const tag = ORG.slice(0, 8)
let THREAD = ""

function ctx(userId: string): UserContext {
  // Both humans hold every scope: the ONLY difference between them is the
  // participant row, which is exactly what this migration is about.
  return { actorType: "user", userId, orgId: ORG, scopes: ["*"], dimensionGrants: {} }
}

async function selectSummariesAs(userId: string): Promise<string[]> {
  const rows = await withRlsContext(ctx(userId), (tx) =>
    tx.execute(drizzleSql`
      SELECT summary FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG}`),
  )
  return (rows as unknown as Array<{ summary: string }>).map((r) => r.summary)
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'FX1 T06', ${`fx1-t06-${tag}`})`
  for (const [id, email] of [
    [MEMBER, `fx1-t06-member-${tag}@test.com`],
    [OUTSIDER, `fx1-t06-outsider-${tag}@test.com`],
  ]) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${id}, ${ORG}, ${email}, 'FX1', 'active', 'hash')`
  }
  await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
    VALUES (${AGENT}, ${ORG}, 'role', ${`@fx1-t06-${tag}`}, 'FX1 Role', '["*"]'::jsonb)`
  const [thread] = await sql<{ id: string }[]>`
    INSERT INTO kernel.threads (org_id, handle, type, created_by)
    VALUES (${ORG}, ${`fx1-t06-thr-${tag}`}, 'thread', ${MEMBER}) RETURNING id`
  THREAD = thread.id
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, participant_type)
    VALUES (${THREAD}, ${MEMBER}, ${ORG}, 'user')`
  await sql`INSERT INTO kernel.agent_thread_checkpoints
    (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes, token_estimate, version)
    VALUES (${ORG}, ${AGENT}, ${THREAD}, NULL, 'CHECKPOINT_SUMMARY_MARKER', '{}', 100, 1)`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("0084 agent_thread_checkpoints thread membership", () => {
  it("a participant covering the scopes reads the checkpoint", async () => {
    expect(await selectSummariesAs(MEMBER)).toContain("CHECKPOINT_SUMMARY_MARKER")
  })

  it("a non participant covering the scopes reads nothing", async () => {
    expect(await selectSummariesAs(OUTSIDER)).toEqual([])
  })

  it("a non participant cannot insert a checkpoint into the thread", async () => {
    await expect(
      withRlsContext(ctx(OUTSIDER), (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO kernel.agent_thread_checkpoints
            (org_id, agent_id, thread_id, upto_message_id, summary, required_scopes,
             token_estimate, version)
          VALUES (${ORG}, ${AGENT}, ${THREAD}, NULL, 'OUTSIDER_WRITE', '{}', 1, 2)`),
      ),
    ).rejects.toThrow()
  })

  it("a non participant cannot delete the checkpoint", async () => {
    const rows = await withRlsContext(ctx(OUTSIDER), (tx) =>
      tx.execute(drizzleSql`
        DELETE FROM kernel.agent_thread_checkpoints
         WHERE org_id = ${ORG} AND thread_id = ${THREAD} RETURNING id`),
    )
    expect((rows as unknown as { length: number }).length).toBe(0)
    expect(await selectSummariesAs(MEMBER)).toContain("CHECKPOINT_SUMMARY_MARKER")
  })
})
