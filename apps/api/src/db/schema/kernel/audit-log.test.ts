// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"

/**
 * kernel.audit_log carries the agent-turn identity and security context (A11):
 * agent_id (FK to kernel.agents, ON DELETE SET NULL), requester_user_id,
 * room_member_snapshot, effective_scope and disclosure_list. All five are
 * nullable, so every existing audit writer, which names none of them, keeps
 * working and non-agent rows read them as null.
 */
describe("kernel.audit_log agent-turn columns", () => {
  const ORG_ID = crypto.randomUUID()
  const AGENT_ID = crypto.randomUUID()
  const tag = ORG_ID.slice(0, 8)

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'AuditAgentOrg', ${`audit-agent-${tag}`})`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'role', ${`logistics-${tag}`}, 'Logistics')`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("audit_log accepts agentId, requesterUserId, roomMemberSnapshot, effectiveScope and disclosureList on insert", async () => {
    const requester = crypto.randomUUID()
    const snapshot = [crypto.randomUUID(), crypto.randomUUID()]
    const scope = ["pennylane:read", "shopify:orders:read"]
    const disclosed = [crypto.randomUUID()]

    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO kernel.audit_log (
        org_id, actor_type, action,
        agent_id, requester_user_id, room_member_snapshot, effective_scope, disclosure_list
      ) VALUES (
        ${ORG_ID}, 'agent', 'agent_turn',
        ${AGENT_ID}, ${requester}, ${JSON.stringify(snapshot)}::text::jsonb,
        ${scope}::text[], ${disclosed}::uuid[]
      )
      RETURNING id
    `
    const [row] = await sql<
      {
        agent_id: string | null
        requester_user_id: string | null
        room_member_snapshot: string[] | null
        effective_scope: string[] | null
        disclosure_list: string[] | null
      }[]
    >`
      SELECT agent_id, requester_user_id, room_member_snapshot, effective_scope, disclosure_list
      FROM kernel.audit_log WHERE id = ${inserted!.id}
    `
    expect(row?.agent_id).toBe(AGENT_ID)
    expect(row?.requester_user_id).toBe(requester)
    expect(row?.room_member_snapshot).toEqual(snapshot)
    expect(row?.effective_scope).toEqual(scope)
    expect(row?.disclosure_list).toEqual(disclosed)
  })

  it("an audit insert naming none of the new columns still works and reads them as null", async () => {
    const [row] = await sql<
      {
        agent_id: string | null
        requester_user_id: string | null
        room_member_snapshot: unknown
        effective_scope: string[] | null
        disclosure_list: string[] | null
      }[]
    >`
      INSERT INTO kernel.audit_log (org_id, actor_type, action)
      VALUES (${ORG_ID}, 'user', 'legacy_write')
      RETURNING agent_id, requester_user_id, room_member_snapshot, effective_scope, disclosure_list
    `
    expect(row).toEqual({
      agent_id: null,
      requester_user_id: null,
      room_member_snapshot: null,
      effective_scope: null,
      disclosure_list: null,
    })
  })

  it("audit_log.agent_id rejects an id that is not a kernel.agents row", async () => {
    await expect(
      (async () => {
        await sql`INSERT INTO kernel.audit_log (org_id, actor_type, action, agent_id)
          VALUES (${ORG_ID}, 'agent', 'ghost_agent', ${crypto.randomUUID()})`
      })(),
    ).rejects.toThrow(/foreign key/)
  })

  it("audit_log.agent_id rejects an agent that belongs to another org", async () => {
    // The row's own org is the boundary: org A's audit row may not name org B's
    // agent. Existence alone is not enough, or a cross-org id lands on the row
    // and "what did this agent do" answers with another org's history.
    const otherOrg = crypto.randomUUID()
    const otherAgent = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${otherOrg}, 'AuditAgentOtherOrg', ${`audit-agent-other-${tag}`})`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${otherAgent}, ${otherOrg}, 'role', ${`other-logistics-${tag}`}, 'Other Logistics')`
    try {
      await expect(
        (async () => {
          await sql`INSERT INTO kernel.audit_log (org_id, actor_type, action, agent_id)
            VALUES (${ORG_ID}, 'agent', 'cross_org_agent', ${otherAgent})`
        })(),
      ).rejects.toThrow(/foreign key/)

      const [refused] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM kernel.audit_log
         WHERE org_id = ${ORG_ID} AND action = 'cross_org_agent'`
      expect(refused?.n).toBe(0)

      // The same agent on ITS OWN org's row is accepted, so the guard rejects
      // the mismatch rather than the agent.
      const [accepted] = await sql<{ agent_id: string | null }[]>`
        INSERT INTO kernel.audit_log (org_id, actor_type, action, agent_id)
        VALUES (${otherOrg}, 'agent', 'own_org_agent', ${otherAgent})
        RETURNING agent_id`
      expect(accepted?.agent_id).toBe(otherAgent)
    } finally {
      await sql`DELETE FROM kernel.audit_log WHERE org_id = ${otherOrg}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${otherOrg}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${otherOrg}`
    }
  })

  it("hard-deleting an agent keeps its audit rows and nulls their agent_id", async () => {
    const doomed = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${doomed}, ${ORG_ID}, 'role', ${`doomed-${tag}`}, 'Doomed')`
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO kernel.audit_log (org_id, actor_type, action, agent_id)
      VALUES (${ORG_ID}, 'agent', 'doomed_turn', ${doomed})
      RETURNING id
    `

    await sql`DELETE FROM kernel.agents WHERE id = ${doomed}`

    const rows = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.audit_log WHERE id = ${inserted!.id}
    `
    expect(rows.map((r) => r.agent_id)).toEqual([null])
  })
})
