// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

/**
 * kernel.approval_requests.agent_id names the agent whose turn PROPOSED the
 * gated call, and that agent must belong to the approval row's OWN ORG
 * (migration 0071), the same rule audit_log.agent_id has carried since 0070.
 *
 * 0063's single-column foreign key checked existence only, so org A's approval
 * row accepted org B's agent while the same id was rejected in audit_log. The
 * persisted value seeds the re-entry frame when the approval is decided, so a
 * cross-org id then FK-failed every audit insert the re-entry produced.
 *
 * The delete rule from 0063 survives: hard-deleting an agent nulls the column
 * and KEEPS the approval row, so a personal agent's erasure never takes the
 * approval history with it.
 */
describe("kernel.approval_requests agent org guard", () => {
  const ORG_ID = crypto.randomUUID()
  const OTHER_ORG_ID = crypto.randomUUID()
  const AGENT_ID = crypto.randomUUID()
  const OTHER_AGENT_ID = crypto.randomUUID()
  const USER_ID = crypto.randomUUID()
  const OTHER_USER_ID = crypto.randomUUID()
  const THREAD_ID = crypto.randomUUID()
  const OTHER_THREAD_ID = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)

  /** Insert one approval row, returning its id. Everything the NOT NULL columns
   *  need and nothing else: what is under test is agent_id alone. */
  async function insertApproval(
    orgId: string,
    threadId: string,
    userId: string,
    handle: string,
    agentId: string | null,
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.approval_requests
        (org_id, handle, thread_id, originating_thread_id, tool_name,
         tool_params, current_payload, expires_at, requested_by, status, agent_id)
      VALUES
        (${orgId}, ${handle}, ${threadId}, ${threadId}, 'fx22:ship',
         '{}'::jsonb, '{}'::jsonb, now() + interval '1 day', ${userId}, 'pending', ${agentId})
      RETURNING id`
    return row!.id
  }

  async function seedOrg(
    orgId: string,
    userId: string,
    threadId: string,
    slug: string,
    email: string,
  ): Promise<void> {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${orgId}, 'FX22 Approval Org', ${slug})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${userId}, ${orgId}, ${email}, 'Requester', 'active', 'hash')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${threadId}, ${orgId}, ${`fx22-thread-${threadId.slice(0, 8)}`}, 'agent_chat', ${userId})`
  }

  beforeAll(async () => {
    await seedOrg(ORG_ID, USER_ID, THREAD_ID, `fx22-approval-${tag}`, `fx22-${tag}@test.com`)
    await seedOrg(
      OTHER_ORG_ID,
      OTHER_USER_ID,
      OTHER_THREAD_ID,
      `fx22-approval-other-${tag}`,
      `fx22-other-${tag}@test.com`,
    )
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'role', ${`logistics-${tag}`}, 'Logistics')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${OTHER_AGENT_ID}, ${OTHER_ORG_ID}, 'role', ${`other-logistics-${tag}`}, 'Other Logistics')`
  })

  afterAll(async () => {
    for (const org of [ORG_ID, OTHER_ORG_ID]) {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${org}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    }
  })

  it("accepts an agent of the approval row's own org", async () => {
    const id = await insertApproval(ORG_ID, THREAD_ID, USER_ID, `own-org-${tag}`, AGENT_ID)
    const [row] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${id}`
    expect(row?.agent_id).toBe(AGENT_ID)
  })

  it("rejects an agent id that is not a kernel.agents row", async () => {
    await expect(
      (async () => {
        await insertApproval(
          ORG_ID,
          THREAD_ID,
          USER_ID,
          `ghost-${tag}`,
          "00000000-0000-4000-8000-00000000a8ff",
        )
      })(),
    ).rejects.toThrow(/foreign key/)
  })

  it("rejects an agent that belongs to another org and keeps no row behind", async () => {
    // The row's own org is the boundary. Existence alone is not enough, or a
    // cross-org id lands on the approval, seeds the re-entry frame from it, and
    // every audit insert that re-entry makes is refused by audit_log's own guard.
    await expect(
      (async () => {
        await insertApproval(ORG_ID, THREAD_ID, USER_ID, `cross-org-${tag}`, OTHER_AGENT_ID)
      })(),
    ).rejects.toThrow(/foreign key/)

    const [refused] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM kernel.approval_requests
       WHERE org_id = ${ORG_ID} AND handle = ${`cross-org-${tag}`}`
    expect(refused?.n).toBe(0)

    // The SAME agent on its OWN org's approval is accepted, so the guard rejects
    // the mismatch rather than the agent.
    const ok = await insertApproval(
      OTHER_ORG_ID,
      OTHER_THREAD_ID,
      OTHER_USER_ID,
      `own-org-other-${tag}`,
      OTHER_AGENT_ID,
    )
    const [accepted] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${ok}`
    expect(accepted?.agent_id).toBe(OTHER_AGENT_ID)
  })

  it("accepts an ARCHIVED agent of the same org", async () => {
    // Agents are archived, not deleted. An archived agent's approval history
    // must keep naming it, and a re-approval of a row it proposed must still
    // record the identity.
    const archived = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, archived_at)
      VALUES (${archived}, ${ORG_ID}, 'role', ${`archived-${tag}`}, 'Archived', now())`
    const id = await insertApproval(ORG_ID, THREAD_ID, USER_ID, `archived-${tag}`, archived)
    const [row] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.approval_requests WHERE id = ${id}`
    expect(row?.agent_id).toBe(archived)
  })

  it("hard-deleting an agent nulls agent_id and keeps the approval row", async () => {
    const doomed = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${doomed}, ${ORG_ID}, 'role', ${`doomed-${tag}`}, 'Doomed')`
    const id = await insertApproval(ORG_ID, THREAD_ID, USER_ID, `doomed-${tag}`, doomed)

    await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`

    const rows = await sql<{ id: string; agent_id: string | null; org_id: string }[]>`
      SELECT id, agent_id, org_id FROM kernel.approval_requests WHERE id = ${id}`
    expect(rows).toHaveLength(1)
    expect(rows[0]?.agent_id).toBeNull()
    expect(rows[0]?.org_id).toBe(ORG_ID)
  })
})
