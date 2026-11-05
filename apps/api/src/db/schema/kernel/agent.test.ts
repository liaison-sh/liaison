// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("kernel.approval_requests schema", () => {
  it("has a nullable summary jsonb column", async () => {
    const rows = extractRows<{ column_name: string; data_type: string; is_nullable: string }>(
      await db.execute(drizzleSql`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'kernel' AND table_name = 'approval_requests' AND column_name = 'summary'
      `),
    )

    expect(rows.length).toBe(1)
    expect(rows[0].data_type).toBe("jsonb")
    expect(rows[0].is_nullable).toBe("YES")
  })

  // P2b-T04: approval_requests carries the same agentId identity column
  // audit_log gained in P2b-T03 (A11), so an agent-originated approval is
  // independently queryable by agent id.
  describe("agentId column", () => {
    const ORG = "00000000-0000-4000-8000-0000000a4001"
    const USER = "00000000-0000-4000-8000-0000000a4002"
    const THREAD = "00000000-0000-4000-8000-0000000a4003"
    const AGENT = "00000000-0000-4000-8000-0000000a4004"

    beforeAll(async () => {
      await acquireTestLock()
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${ORG}, 'Approval Agent Org', 'approval-agent-org') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${USER}, ${ORG}, 'approval-agent@test.com', 'Approver', 'active', 'hash')
        ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${THREAD}, ${ORG}, 'approval-agent-thread', 'agent_chat', ${USER})
        ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
        VALUES (${AGENT}, ${ORG}, 'role', 'approval-agent', 'Approval Agent')
        ON CONFLICT DO NOTHING`
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
      await releaseTestLock()
    })

    it("approval_requests accepts an agentId on insert", async () => {
      const [row] = await sql<{ agent_id: string | null }[]>`
        INSERT INTO kernel.approval_requests
          (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
           current_payload, expires_at, requested_by, status, agent_id)
        VALUES (${ORG}, 'agent-approval-1', ${THREAD}, ${THREAD}, 'seq_test:agent_step', '{}'::jsonb,
           '{}'::jsonb, now() + interval '1 day', ${USER}, 'pending', ${AGENT})
        RETURNING agent_id`
      expect(row?.agent_id).toBe(AGENT)
    })
  })
})
